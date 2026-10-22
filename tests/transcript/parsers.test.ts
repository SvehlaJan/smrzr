import { describe, expect, it } from 'vitest';
import { rowFromTextLines, segmentsFromDomRows } from '../../src/transcript/domParse';
import { GET_TRANSCRIPT_PATH, buildGetTranscriptBody, findTranscriptParams, parseGetTranscriptResponse } from '../../src/transcript/panelApi';
import { decodeEntities, normalizeText, parseClock } from '../../src/transcript/text';
import {
  TranscriptParseError,
  buildJson3Url,
  isTimedtextUrl,
  parseJson3,
  parseTimedtextBody,
  parseTimedtextXml,
  timedtextTrackParams,
  timedtextVideoId,
} from '../../src/transcript/timedtext';
import { getTranscriptResponse, json3Asr, json3Manual, legacyXml, makeWatchData, srv3Xml } from './fixtures';

describe('parseJson3', () => {
  it('parses manual captions, skipping window events and empty text, normalizing whitespace', () => {
    expect(parseJson3(json3Manual)).toEqual([
      { start: 1.2, dur: 3.4, text: 'So the study took healthy young adults' },
      { start: 4.6, dur: 2.8, text: '[Music]' },
      { start: 7.4, dur: 3.1, text: 'and restricted them to five hours.' },
      { start: 11.5, dur: 0, text: 'Tom & Jerry' },
    ]);
  });

  it('joins ASR word segments and drops "\\n" append events', () => {
    expect(parseJson3(json3Asr)).toEqual([
      { start: 0.16, dur: 4.32, text: 'so the study' },
      { start: 2.56, dur: 4, text: 'took healthy young' },
    ]);
  });

  it('returns no segments for an events array without text (caller treats as failure)', () => {
    expect(parseJson3({ events: [{ tStartMs: 0, dDurationMs: 1, id: 1 }] })).toEqual([]);
  });

  it('throws on JSON without events', () => {
    expect(() => parseJson3({ foo: 1 })).toThrow(TranscriptParseError);
  });
});

describe('parseTimedtextXml', () => {
  it('parses legacy XML and decodes (double-escaped) entities', () => {
    expect(parseTimedtextXml(legacyXml)).toEqual([
      { start: 0.5, dur: 2.1, text: "Hello 'world'" },
      { start: 2.6, dur: 3, text: 'Fish & chips <3' },
      { start: 7.1, dur: 2.4, text: 'line one line two—done' },
    ]);
  });

  it('parses srv3 (<p t d> in milliseconds) and strips inner tags', () => {
    expect(parseTimedtextXml(srv3Xml)).toEqual([
      { start: 1.2, dur: 3.4, text: 'Hello big world' },
      { start: 5.6, dur: 2, text: "it's fine" },
    ]);
  });
});

describe('parseTimedtextBody', () => {
  it('detects XML by a leading "<"', () => {
    expect(parseTimedtextBody(`\n  ${legacyXml}`)).toHaveLength(3);
  });
  it('parses JSON bodies as json3', () => {
    expect(parseTimedtextBody(JSON.stringify(json3Manual))).toHaveLength(4);
  });
  it('throws on garbage', () => {
    expect(() => parseTimedtextBody(')]}\'\nnot json')).toThrow(TranscriptParseError);
  });
});

describe('timedtext URL helpers', () => {
  const captured =
    'https://www.youtube.com/api/timedtext?v=abcdefghijk&ei=x&caps=asr&opi=1&xoaf=5&hl=en&expire=1&sparams=ip&signature=S&kind=asr&lang=en&potc=1&pot=TOKEN123&fmt=srv3&xorb=2&xobt=3&xovt=3&cbr=Chrome';

  it('recognizes timedtext URLs, absolute and relative', () => {
    expect(isTimedtextUrl(captured)).toBe(true);
    expect(isTimedtextUrl('/api/timedtext?v=abc')).toBe(true);
    expect(isTimedtextUrl('https://www.youtube.com/api/stats/watchtime?v=abc')).toBe(false);
    expect(isTimedtextUrl('not a url ::::', 'invalid base')).toBe(false);
  });

  it('reads the video id and track params', () => {
    expect(timedtextVideoId(captured)).toBe('abcdefghijk');
    expect(timedtextTrackParams(captured)).toEqual({ lang: 'en', kind: 'asr', tlang: null, pot: 'TOKEN123' });
  });

  it('switches to json3, keeps pot, adds c=WEB when missing', () => {
    const u = new URL(buildJson3Url(captured));
    expect(u.searchParams.get('fmt')).toBe('json3');
    expect(u.searchParams.get('pot')).toBe('TOKEN123');
    expect(u.searchParams.get('signature')).toBe('S');
    expect(u.searchParams.get('c')).toBe('WEB');
    expect(u.searchParams.getAll('fmt')).toHaveLength(1);
  });

  it('keeps an existing c param', () => {
    const u = new URL(buildJson3Url(`${captured}&c=WEB_REMIX`));
    expect(u.searchParams.get('c')).toBe('WEB_REMIX');
  });

  it('can switch track: sets lang/kind and removes tlang', () => {
    const u = new URL(buildJson3Url(`${captured}&tlang=de`, { track: { languageCode: 'en-GB', kind: 'manual' } }));
    expect(u.searchParams.get('lang')).toBe('en-GB');
    expect(u.searchParams.has('kind')).toBe(false);
    expect(u.searchParams.has('tlang')).toBe(false);
    expect(u.searchParams.get('pot')).toBe('TOKEN123');
  });
});

describe('get_transcript (panel API)', () => {
  it('finds the params in the transcript engagement panel', () => {
    expect(findTranscriptParams(makeWatchData())).toBe('CgtkUXc0dzlXZ1hjURISQ2dOaGMzSVNBbVZ1R2dBJTNE');
  });

  it('returns null when the video has no transcript panel', () => {
    expect(findTranscriptParams(makeWatchData({ withTranscriptPanel: false }))).toBeNull();
  });

  it('falls back to a recursive search when the nesting changed', () => {
    const moved = {
      engagementPanels: [
        {
          engagementPanelSectionListRenderer: {
            targetId: 'engagement-panel-searchable-transcript',
            content: { sectionListRenderer: { contents: [{ getTranscriptEndpoint: { params: 'MOVED' } }] } },
          },
        },
      ],
    };
    expect(findTranscriptParams(moved)).toBe('MOVED');
  });

  it('builds the request body with the innertube context', () => {
    const ctx = { client: { clientName: 'WEB', clientVersion: '2.20261020.00.00' } };
    expect(JSON.parse(buildGetTranscriptBody(ctx, 'P'))).toEqual({ context: ctx, params: 'P' });
    expect(GET_TRANSCRIPT_PATH).toMatch(/^\/youtubei\/v1\//);
  });

  it('parses transcriptSegmentRenderer items wherever they are nested', () => {
    expect(parseGetTranscriptResponse(getTranscriptResponse)).toEqual([
      { start: 0, dur: 3.2, text: 'Welcome back to the show.' },
      { start: 7, dur: 5.5, text: 'Today: sleep and caffeine.' },
      { start: 12.5, dur: 2.5, text: 'Multi run text' },
    ]);
  });

  it('returns [] for an unrelated response', () => {
    expect(parseGetTranscriptResponse({ responseContext: {}, actions: [] })).toEqual([]);
  });
});

describe('DOM row parsing', () => {
  it('parses clock timestamps', () => {
    expect(parseClock('0:05')).toBe(5);
    expect(parseClock('12:04')).toBe(724);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('\n   1:02:03  \n')).toBe(3723);
    expect(parseClock('10:00:00')).toBe(36000);
    expect(parseClock('12:61')).toBeNull();
    expect(parseClock('1:75:00')).toBeNull();
    expect(parseClock('12')).toBeNull();
    expect(parseClock('abc')).toBeNull();
  });

  it('turns rows into segments with durations from the next row', () => {
    expect(
      segmentsFromDomRows([
        { timeText: '0:00', text: ' Intro\n music ' },
        { timeText: 'bad', text: 'skipped' },
        { timeText: '0:04', text: 'hello' },
        { timeText: '1:02:03', text: 'late' },
        { timeText: '1:02:10', text: '   ' },
      ]),
    ).toEqual([
      { start: 0, dur: 4, text: 'Intro music' },
      { start: 4, dur: 3719, text: 'hello' },
      { start: 3723, dur: 3, text: 'late' },
    ]);
  });

  it('reads unknown row structures from text lines', () => {
    expect(rowFromTextLines(['', ' 12:04 ', 'so the study', 'took adults'])).toEqual({
      timeText: '12:04',
      text: 'so the study took adults',
    });
    expect(rowFromTextLines(['no timestamp here'])).toBeNull();
    expect(rowFromTextLines(['0:01'])).toBeNull();
  });
});

describe('text helpers', () => {
  it('decodes named, decimal and hex entities and leaves unknown ones', () => {
    expect(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39; &#x2764; &bogus;')).toBe(
      '<a> & "b" \'c\' ❤ &bogus;',
    );
  });
  it('normalizes whitespace including nbsp', () => {
    expect(normalizeText('  a\n\tb  c  ')).toBe('a b c');
  });
});
