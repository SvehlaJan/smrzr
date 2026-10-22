// The transcript fallback chain (design §4). Pure orchestration: the strategies are passed in,
// so this file has no browser dependencies and is fully unit-tested.
//
//   precheck (live? English track?) → player → panel → dom → (gemini: later, outside this module)
//
// Every strategy run produces one TranscriptAttempt (strategy, outcome, ms, short detail) that the
// content script logs as `transcript.attempt`. The chain stops at the first strategy that returns
// at least one segment.

import type { TranscriptResponse } from '../messaging';
import type {
  CaptionTrackInfo,
  TranscriptAttempt,
  TranscriptOutcome,
  TranscriptSegment,
  TranscriptStrategy,
  VideoMeta,
} from '../types';
import { describeTracks, selectEnglishTrack } from './tracks';

export interface StrategyContext {
  videoId: string;
  /** The English track chosen by selectEnglishTrack. */
  track: CaptionTrackInfo;
}

export type StrategyResult =
  | { ok: true; segments: TranscriptSegment[]; detail?: string }
  | { ok: false; outcome: Exclude<TranscriptOutcome, 'ok'>; detail?: string };

export interface TranscriptStrategyImpl {
  name: TranscriptStrategy;
  run(ctx: StrategyContext): Promise<StrategyResult>;
  /** Hard cap for this strategy; the chain moves on after it. Defaults to `defaultTimeoutMs`. */
  timeoutMs?: number;
}

export interface ChainOptions {
  meta: VideoMeta;
  strategies: TranscriptStrategyImpl[];
  defaultTimeoutMs?: number;
  /** Injected clock, for tests. */
  now?: () => number;
}

/** Diagnostic detail strings must stay short and must never carry page content. */
export function shortDetail(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Turns a thrown value into a short, content-free detail like "TypeError: Failed to fetch". */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) return shortDetail(`${err.name}: ${err.message}`);
  return shortDetail(String(err));
}

class StrategyTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StrategyTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function runTranscriptChain(opts: ChainOptions): Promise<TranscriptResponse> {
  const { meta } = opts;
  const now = opts.now ?? (() => Date.now());
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
  const attempts: TranscriptAttempt[] = [];

  // Live streams / Premieres have no final transcript (design §11.7).
  if (meta.isLive) return { ok: false, error: 'live', attempts };

  // Track precheck. Recorded as an attempt so the event log shows *why* nothing was tried.
  // (TranscriptAttempt requires a strategy name; we use 'player', the first strategy, for this step.)
  const track = selectEnglishTrack(meta.captionTracks);
  if (!track) {
    attempts.push({
      strategy: 'player',
      outcome: meta.captionTracks.length === 0 ? 'no_tracks' : 'no_english_track',
      ms: 0,
      detail: `tracks: ${describeTracks(meta.captionTracks)}`,
    });
    return { ok: false, error: 'no_english_track', attempts };
  }

  const ctx: StrategyContext = { videoId: meta.videoId, track };
  for (const strategy of opts.strategies) {
    const started = now();
    let result: StrategyResult;
    try {
      result = await withTimeout(strategy.run(ctx), strategy.timeoutMs ?? defaultTimeoutMs);
    } catch (err) {
      result =
        err instanceof StrategyTimeout
          ? { ok: false, outcome: 'timeout', detail: `no result after ${strategy.timeoutMs ?? defaultTimeoutMs}ms` }
          : { ok: false, outcome: 'error', detail: errorDetail(err) };
    }
    const ms = Math.max(0, Math.round(now() - started));

    // Zero segments is a failure, never "an empty transcript" (design §4).
    if (result.ok && result.segments.length === 0) {
      result = { ok: false, outcome: 'parse_error', detail: '0 segments' };
    }

    if (result.ok) {
      attempts.push({
        strategy: strategy.name,
        outcome: 'ok',
        ms,
        segmentCount: result.segments.length,
        ...(result.detail ? { detail: shortDetail(result.detail) } : {}),
      });
      return {
        ok: true,
        attempts,
        transcript: {
          videoId: meta.videoId,
          language: track.languageCode,
          kind: track.kind,
          source: strategy.name,
          segments: result.segments,
        },
      };
    }
    attempts.push({
      strategy: strategy.name,
      outcome: result.outcome,
      ms,
      ...(result.detail ? { detail: shortDetail(result.detail) } : {}),
    });
  }
  return { ok: false, error: 'all_strategies_failed', attempts };
}
