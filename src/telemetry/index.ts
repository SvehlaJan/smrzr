// Observability: local event log, Sentry, debug bundles. Design §8.
import type { Component, LogEvent, LogLevel, Settings, VideoRecord } from '../types';
import { notImplemented } from '../notImplemented';

/** Full prompt/response pair, kept locally (last ~50) and only sent inside a manual issue report. */
export interface LlmExchange {
  ts: number;
  videoId: string;
  task: string;
  model: string;
  system?: string;
  /** Request messages as sent (text parts; video parts as their URL). */
  requestMessages: unknown;
  responseText: string;
  finishReason: string;
  latencyMs: number;
}

export interface Logger {
  event(name: string, data?: Record<string, unknown>, opts?: { level?: LogLevel; videoId?: string }): void;
  /** Logs an `error` event and (in panel/background, when enabled) captures it in Sentry. */
  error(err: unknown, context?: Record<string, unknown> & { videoId?: string }): void;
  /** Tags attached to subsequent Sentry events: videoId, task, model, transcriptSource, promptVersion. */
  setTags(tags: Record<string, string | number | undefined>): void;
  /** Stores a full exchange locally for debug bundles. No-op outside panel/background. */
  recordExchange(x: LlmExchange): void;
}

/**
 * panel/background: writes to IndexedDB event log directly and reports errors to Sentry.
 * content/main: forwards events to the background via messaging (no Sentry in the YouTube page).
 */
export function createLogger(component: Component): Logger {
  return notImplemented('createLogger');
}

/** Sets up the Sentry BrowserClient + Scope (no Sentry.init). No-op without WXT_SENTRY_DSN or when disabled. */
export function initTelemetry(opts: { component: 'panel' | 'background'; enabled: boolean }): void {
  notImplemented('initTelemetry');
}

/** Background handler for forwarded `log` messages from the YouTube tab. */
export function handleForwardedLog(event: LogEvent): Promise<void> {
  return notImplemented('handleForwardedLog');
}

export function getRecentEvents(opts?: { videoId?: string; limit?: number }): Promise<LogEvent[]> {
  return notImplemented('getRecentEvents');
}

export interface DebugBundle {
  createdAt: string;
  extensionVersion: string;
  userAgent: string;
  settings: Omit<Settings, 'apiKey'> & { apiKey: '<redacted>' | '<empty>' };
  videoId: string | null;
  video: VideoRecord | null;
  events: LogEvent[];
  exchanges: LlmExchange[];
}

export function buildDebugBundle(videoId: string | null): Promise<DebugBundle> {
  return notImplemented('buildDebugBundle');
}

/** Sentry User Feedback + debug-bundle.json attachment. */
export function sendIssueReport(args: { message: string; videoId: string | null }): Promise<{ ok: true; eventId: string } | { ok: false; reason: 'sentry_disabled' | 'send_failed' }> {
  return notImplemented('sendIssueReport');
}

/** Deep-copies and replaces anything that looks like a Google API key (AIza…) with "<redacted>". */
export function scrubSecrets<T>(value: T): T {
  return notImplemented('scrubSecrets');
}
