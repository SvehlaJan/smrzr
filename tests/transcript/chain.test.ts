import { describe, expect, it, vi } from 'vitest';
import type { CaptionTrackInfo, TranscriptSegment, VideoMeta } from '../../src/types';
import { runTranscriptChain, type StrategyResult, type TranscriptStrategyImpl } from '../../src/transcript/chain';

const EN: CaptionTrackInfo = { baseUrl: 'https://www.youtube.com/api/timedtext?v=vid&lang=en', languageCode: 'en', kind: 'manual', name: 'English' };
const EN_ASR: CaptionTrackInfo = { ...EN, baseUrl: `${EN.baseUrl}&kind=asr`, kind: 'asr' };
const CS: CaptionTrackInfo = { ...EN, baseUrl: 'https://www.youtube.com/api/timedtext?v=vid&lang=cs', languageCode: 'cs' };

function meta(over: Partial<VideoMeta> = {}): VideoMeta {
  return { videoId: 'vid', title: 't', channel: 'c', durationSec: 100, chapters: [], isLive: false, captionTracks: [EN], ...over };
}

const SEGS: TranscriptSegment[] = [
  { start: 0, dur: 2, text: 'hello' },
  { start: 2, dur: 2, text: 'world' },
];

function strategy(name: TranscriptStrategyImpl['name'], result: StrategyResult | (() => Promise<StrategyResult>), timeoutMs?: number) {
  const run = vi.fn(typeof result === 'function' ? result : async () => result);
  return { name, run, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } satisfies TranscriptStrategyImpl;
}

/** Fake clock that advances 5 ms per call, so attempt timings are deterministic. */
function fakeClock() {
  let t = 1000;
  return () => (t += 5);
}

describe('runTranscriptChain', () => {
  it('stops at the first success and records attempts', async () => {
    const player = strategy('player', { ok: false, outcome: 'empty_200', detail: 'captured: empty_200' });
    const panel = strategy('panel', { ok: true, segments: SEGS });
    const dom = strategy('dom', { ok: true, segments: SEGS });
    const res = await runTranscriptChain({ meta: meta(), strategies: [player, panel, dom], now: fakeClock() });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.transcript).toEqual({ videoId: 'vid', language: 'en', kind: 'manual', source: 'panel', segments: SEGS });
    expect(res.attempts).toEqual([
      { strategy: 'player', outcome: 'empty_200', ms: 5, detail: 'captured: empty_200' },
      { strategy: 'panel', outcome: 'ok', ms: 5, segmentCount: 2 },
    ]);
    expect(dom.run).not.toHaveBeenCalled();
    expect(player.run).toHaveBeenCalledWith({ videoId: 'vid', track: EN });
  });

  it('treats a "success" with zero segments as a failure and moves on', async () => {
    const player = strategy('player', { ok: true, segments: [] });
    const panel = strategy('panel', { ok: true, segments: SEGS });
    const res = await runTranscriptChain({ meta: meta(), strategies: [player, panel] });
    expect(res.attempts[0]).toMatchObject({ strategy: 'player', outcome: 'parse_error', detail: '0 segments' });
    expect(res.ok && res.transcript.source).toBe('panel');
  });

  it('reports all_strategies_failed with every attempt', async () => {
    const res = await runTranscriptChain({
      meta: meta(),
      strategies: [
        strategy('player', { ok: false, outcome: 'empty_200' }),
        strategy('panel', { ok: false, outcome: 'http_error', detail: 'HTTP 403' }),
        strategy('dom', { ok: false, outcome: 'timeout' }),
      ],
    });
    expect(res).toMatchObject({ ok: false, error: 'all_strategies_failed' });
    expect(res.attempts.map((a) => a.outcome)).toEqual(['empty_200', 'http_error', 'timeout']);
  });

  it('turns a thrown error into an "error" attempt and continues', async () => {
    const res = await runTranscriptChain({
      meta: meta(),
      strategies: [
        strategy('player', async () => {
          throw new TypeError('Failed to fetch');
        }),
        strategy('panel', { ok: true, segments: SEGS }),
      ],
    });
    expect(res.attempts[0]).toMatchObject({ strategy: 'player', outcome: 'error', detail: 'TypeError: Failed to fetch' });
    expect(res.ok).toBe(true);
  });

  it('times out a hanging strategy', async () => {
    const res = await runTranscriptChain({
      meta: meta(),
      strategies: [strategy('dom', () => new Promise<StrategyResult>(() => {}), 20), strategy('panel', { ok: true, segments: SEGS })],
    });
    expect(res.attempts[0]).toMatchObject({ strategy: 'dom', outcome: 'timeout' });
    expect(res.ok).toBe(true);
  });

  it('truncates long details', async () => {
    const res = await runTranscriptChain({
      meta: meta(),
      strategies: [strategy('player', { ok: false, outcome: 'error', detail: 'x'.repeat(1000) })],
    });
    expect(res.attempts[0]!.detail!.length).toBeLessThanOrEqual(160);
  });

  it('uses the ASR track (and reports kind asr) when no manual English exists', async () => {
    const player = strategy('player', { ok: true, segments: SEGS });
    const res = await runTranscriptChain({ meta: meta({ captionTracks: [CS, EN_ASR] }), strategies: [player] });
    expect(player.run).toHaveBeenCalledWith({ videoId: 'vid', track: EN_ASR });
    expect(res.ok && res.transcript.kind).toBe('asr');
  });

  it('stops with no_english_track before trying strategies', async () => {
    const player = strategy('player', { ok: true, segments: SEGS });
    const res = await runTranscriptChain({ meta: meta({ captionTracks: [CS] }), strategies: [player] });
    expect(res).toEqual({
      ok: false,
      error: 'no_english_track',
      attempts: [{ strategy: 'player', outcome: 'no_english_track', ms: 0, detail: 'tracks: cs' }],
    });
    expect(player.run).not.toHaveBeenCalled();
  });

  it('distinguishes "no tracks at all" in the attempt outcome', async () => {
    const res = await runTranscriptChain({ meta: meta({ captionTracks: [] }), strategies: [] });
    expect(res).toMatchObject({ ok: false, error: 'no_english_track', attempts: [{ outcome: 'no_tracks' }] });
  });

  it('refuses live streams without trying anything', async () => {
    const player = strategy('player', { ok: true, segments: SEGS });
    const res = await runTranscriptChain({ meta: meta({ isLive: true }), strategies: [player] });
    expect(res).toEqual({ ok: false, error: 'live', attempts: [] });
    expect(player.run).not.toHaveBeenCalled();
  });
});
