// Logging helpers for the isolated content script (design §8.2).
// Metadata only: strategy names, outcomes, counts, timings. Never transcript text.

import type { TranscriptResponse } from '../messaging';
import { createLogger } from '../telemetry';
import type { Component, LogLevel } from '../types';
import { countWords } from './text';

/** Same calls as telemetry's Logger, but guaranteed never to throw. */
export interface SafeLogger {
  event(name: string, data?: Record<string, unknown>, opts?: { level?: LogLevel; videoId?: string }): void;
  error(err: unknown, context?: Record<string, unknown> & { videoId?: string }): void;
}

/**
 * Wraps telemetry's logger so that a telemetry bug (or telemetry not being ready) can never
 * break the content script. The real logger is created lazily on first use, and creation is
 * retried later if it failed.
 */
export function createSafeLogger(component: Component): SafeLogger {
  let logger: ReturnType<typeof createLogger> | null = null;
  const get = (): ReturnType<typeof createLogger> | null => {
    if (logger) return logger;
    try {
      logger = createLogger(component);
    } catch {
      logger = null;
    }
    return logger;
  };
  return {
    event(name, data, opts) {
      try {
        get()?.event(name, data, opts);
      } catch {
        // swallow: logging must never break the caller
      }
    },
    error(err, context) {
      try {
        get()?.error(err, context);
      } catch {
        // swallow
      }
    },
  };
}

/** Logs one `transcript.attempt` per attempt, then `transcript.selected` or `transcript.failed`. */
export function logTranscriptResult(log: SafeLogger, videoId: string, res: TranscriptResponse): void {
  for (const a of res.attempts) {
    log.event(
      'transcript.attempt',
      {
        strategy: a.strategy,
        outcome: a.outcome,
        ms: a.ms,
        ...(a.detail !== undefined ? { detail: a.detail } : {}),
        ...(a.segmentCount !== undefined ? { segmentCount: a.segmentCount } : {}),
      },
      { level: a.outcome === 'ok' ? 'info' : 'warn', videoId },
    );
  }
  if (res.ok) {
    const t = res.transcript;
    log.event(
      'transcript.selected',
      {
        source: t.source,
        kind: t.kind,
        language: t.language,
        segments: t.segments.length,
        words: countWords(t.segments.map((s) => s.text)),
        lastSegmentSec: Math.round(t.segments[t.segments.length - 1]?.start ?? 0),
      },
      { videoId },
    );
  } else {
    log.event('transcript.failed', { error: res.error, attempts: res.attempts.length }, { level: 'warn', videoId });
  }
}
