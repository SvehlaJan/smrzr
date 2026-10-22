import { describe, expect, it } from 'vitest';
import type { CaptionTrackInfo } from '../../src/types';
import { chaptersFromDescription, chaptersFromWatchData } from '../../src/transcript/chapters';
import { isLiveNow, toVideoMeta, watchVideoIdFromUrl } from '../../src/transcript/playerResponse';
import { describeTracks, isEnglishCode, parseCaptionTracks, selectEnglishTrack } from '../../src/transcript/tracks';
import { captionTrack, makePlayerResponse, makeWatchData } from './fixtures';

function track(languageCode: string, kind: 'manual' | 'asr' = 'manual', translated = false): CaptionTrackInfo {
  return {
    languageCode,
    kind,
    name: languageCode,
    baseUrl: `https://www.youtube.com/api/timedtext?v=x&lang=${languageCode}${kind === 'asr' ? '&kind=asr' : ''}${translated ? '&tlang=en' : ''}`,
  };
}

describe('track selection', () => {
  it('treats en, en-US, en-GB as English but not other codes', () => {
    expect(['en', 'en-US', 'en-GB', 'EN'].every(isEnglishCode)).toBe(true);
    expect(['eng', 'es', 'enm', 'de-en'].some(isEnglishCode)).toBe(false);
  });

  it('prefers manual English over ASR English', () => {
    expect(selectEnglishTrack([track('en', 'asr'), track('en-GB')])).toMatchObject({ languageCode: 'en-GB', kind: 'manual' });
  });

  it('prefers plain "en" within the same kind', () => {
    expect(selectEnglishTrack([track('en-US'), track('en')])?.languageCode).toBe('en');
  });

  it('falls back to ASR English', () => {
    expect(selectEnglishTrack([track('cs'), track('en', 'asr')])).toMatchObject({ languageCode: 'en', kind: 'asr' });
  });

  it('never picks an auto-translated track', () => {
    expect(selectEnglishTrack([track('cs'), track('en', 'manual', true)])).toBeNull();
  });

  it('returns null without English', () => {
    expect(selectEnglishTrack([track('cs'), track('de', 'asr')])).toBeNull();
    expect(selectEnglishTrack([])).toBeNull();
  });

  it('describes tracks for logs without URLs', () => {
    expect(describeTracks([track('cs'), track('de', 'asr')])).toBe('cs, de(asr)');
    expect(describeTracks([])).toBe('none');
  });
});

describe('parseCaptionTracks', () => {
  it('reads kind, names in simpleText and runs form, and makes relative URLs absolute', () => {
    const pr = makePlayerResponse({
      captionTracks: [
        captionTrack('en'),
        captionTrack('en', { asr: true, name: { runs: [{ text: 'English' }, { text: ' (auto-generated)' }] } }),
        { ...captionTrack('cs'), baseUrl: '/api/timedtext?v=x&lang=cs' },
        { name: { simpleText: 'broken, no url' }, languageCode: 'fr' },
      ],
    });
    const tracks = parseCaptionTracks(pr);
    expect(tracks.map((t) => [t.languageCode, t.kind, t.name])).toEqual([
      ['en', 'manual', 'en'],
      ['en', 'asr', 'English (auto-generated)'],
      ['cs', 'manual', 'cs'],
    ]);
    expect(tracks[2]!.baseUrl).toBe('https://www.youtube.com/api/timedtext?v=x&lang=cs');
  });

  it('returns [] when the video has no captions object', () => {
    expect(parseCaptionTracks(makePlayerResponse({ captionTracks: null }))).toEqual([]);
  });
});

describe('chapters from watch data', () => {
  it('prefers creator (DESCRIPTION_CHAPTERS) over AUTO_CHAPTERS', () => {
    expect(chaptersFromWatchData(makeWatchData())).toEqual([
      { title: 'Intro', startSec: 0 },
      { title: 'Weekend catch-up sleep', startSec: 724 },
      { title: 'Caffeine', startSec: 1540 },
    ]);
  });

  it('uses AUTO_CHAPTERS when there are no creator chapters', () => {
    expect(chaptersFromWatchData(makeWatchData({ autoOnly: true })).map((c) => c.title)).toEqual([
      'Auto one',
      'Auto two',
      'Auto three',
    ]);
  });

  it('finds a markersMap that moved elsewhere', () => {
    const moved = { somewhere: { deeper: { markersMap: [{ key: 'DESCRIPTION_CHAPTERS', value: { chapters: [
      { chapterRenderer: { title: { runs: [{ text: 'A' }] }, timeRangeStartMillis: 0 } },
      { chapterRenderer: { title: { simpleText: 'B' }, timeRangeStartMillis: 61_000 } },
    ] } }] } } };
    expect(chaptersFromWatchData(moved)).toEqual([
      { title: 'A', startSec: 0 },
      { title: 'B', startSec: 61 },
    ]);
  });

  it('returns [] without markers', () => {
    expect(chaptersFromWatchData(makeWatchData({ withChapters: false }))).toEqual([]);
    expect(chaptersFromWatchData(undefined)).toEqual([]);
  });
});

describe('chapters from description', () => {
  it('parses common line formats', () => {
    const desc = [
      'In this episode we talk about sleep.',
      '',
      'Chapters:',
      '00:00 Intro',
      '1:05 - Weekend catch-up sleep',
      '(12:04) Caffeine timing',
      '▶ 25:40 — Light',
      'Q&A | 1:02:03',
      '',
      'Follow us at example.com, see 5:30 for the joke',
    ].join('\n');
    expect(chaptersFromDescription(desc, 9667)).toEqual([
      { title: 'Intro', startSec: 0 },
      { title: 'Weekend catch-up sleep', startSec: 65 },
      { title: 'Caffeine timing', startSec: 724 },
      { title: 'Light', startSec: 1540 },
      { title: 'Q&A', startSec: 3723 },
    ]);
  });

  it('rejects lists that do not start at 0:00', () => {
    expect(chaptersFromDescription('1:00 A\n2:00 B\n3:00 C')).toEqual([]);
  });

  it('rejects fewer than 3 timestamps', () => {
    expect(chaptersFromDescription('0:00 Intro\n5:00 Main part')).toEqual([]);
  });

  it('ignores timestamps inside prose', () => {
    expect(chaptersFromDescription('At 0:00 we start, at 5:30 he says it, and 9:00 is funny.')).toEqual([]);
  });

  it('stops at the first non-ascending timestamp', () => {
    expect(chaptersFromDescription('0:00 A\n1:00 B\n2:00 C\n1:30 D\n3:00 E')).toEqual([
      { title: 'A', startSec: 0 },
      { title: 'B', startSec: 60 },
      { title: 'C', startSec: 120 },
    ]);
  });

  it('stops at timestamps beyond the duration', () => {
    expect(chaptersFromDescription('0:00 A\n1:00 B\n2:00 C\n59:00 D', 600)).toHaveLength(3);
  });

  it('stops at the first line of other text', () => {
    expect(chaptersFromDescription('0:00 A\n1:00 B\nSponsored by X\n2:00 C\n3:00 D')).toEqual([]);
  });
});

describe('toVideoMeta', () => {
  it('converts a normal video, with chapters from matching watch data', () => {
    const meta = toVideoMeta(makePlayerResponse({ lengthSeconds: '754' }), makeWatchData());
    expect(meta).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      title: 'Sleep, caffeine & light — Episode 142',
      channel: 'The Sleep Podcast',
      durationSec: 754,
      isLive: false,
    });
    expect(meta!.chapters).toHaveLength(3);
    expect(meta!.captionTracks).toHaveLength(1);
  });

  it('ignores stale watch data from another video and falls back to the description', () => {
    const pr = makePlayerResponse({ shortDescription: '0:00 One\n1:00 Two\n2:00 Three' });
    const meta = toVideoMeta(pr, makeWatchData({ videoId: 'otherVideo1' }));
    expect(meta!.chapters.map((c) => c.title)).toEqual(['One', 'Two', 'Three']);
  });

  it('returns null without videoDetails', () => {
    expect(toVideoMeta({ playabilityStatus: { status: 'ERROR' } })).toBeNull();
    expect(toVideoMeta(null)).toBeNull();
  });

  it('flags live and upcoming streams, but not finished past livestreams', () => {
    expect(isLiveNow(makePlayerResponse({ isLive: true, isLiveContent: true, lengthSeconds: '0' }))).toBe(true);
    expect(isLiveNow(makePlayerResponse({ isUpcoming: true, isLiveContent: true, lengthSeconds: '0' }))).toBe(true);
    expect(isLiveNow(makePlayerResponse({ isLiveContent: true, lengthSeconds: '0' }))).toBe(true);
    expect(isLiveNow(makePlayerResponse({ isLiveContent: true, lengthSeconds: '3600', isLiveNow: true }))).toBe(true);
    expect(isLiveNow(makePlayerResponse({ playability: 'LIVE_STREAM_OFFLINE', lengthSeconds: '0' }))).toBe(true);
    // Past stream: was live, now a normal VOD with a duration.
    expect(isLiveNow(makePlayerResponse({ isLiveContent: true, lengthSeconds: '7200', isLiveNow: false }))).toBe(false);
    expect(isLiveNow(makePlayerResponse())).toBe(false);
  });
});

describe('watchVideoIdFromUrl', () => {
  it('accepts only /watch?v=', () => {
    expect(watchVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ');
    expect(watchVideoIdFromUrl('https://www.youtube.com/')).toBeNull();
    expect(watchVideoIdFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBeNull();
    expect(watchVideoIdFromUrl('https://www.youtube.com/watch?v=<script>')).toBeNull();
    expect(watchVideoIdFromUrl('nonsense')).toBeNull();
  });
});
