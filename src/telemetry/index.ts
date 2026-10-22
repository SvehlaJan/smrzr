// Observability: local event log, Sentry, debug bundles. Design §8.
//
// Who uses what:
//   side panel, background  → createLogger('panel' | 'background'): IndexedDB log + Sentry
//   content, MAIN world     → createLogger('content' | 'main'): forwards to the background
//
// The module is split into small files:
//   eventLog.ts          IndexedDB ring buffers (events, LLM exchanges)
//   sentry.ts            BrowserClient + Scope (no Sentry.init), feedback, spans
//   debugBundle.ts       the "Copy debug bundle" / "Report issue" JSON
//   scrub.ts             API-key scrubbing
//   forwardingLogger.ts  logger for scripts inside the YouTube tab (no Dexie, no Sentry)
import type { Component, LogEvent, LogLevel, Settings, VideoRecord } from '../types';
import { buildDebugBundle as buildBundle, copyDebugBundle, getExtensionVersion } from './debugBundle';
import { readRecentEvents, resetEventLogCounters, writeEvent, writeExchange } from './eventLog';
import { createForwardingLogger, describeError } from './forwardingLogger';
import { scrubSecrets as scrub } from './scrub';
import {
  addSentryBreadcrumb,
  captureSentryError,
  getSentryDsn,
  isSentryEnabled,
  sendSentryFeedback,
  startSentry,
  stopSentry,
} from './sentry';

export { copyDebugBundle } from './debugBundle';
export { withSpan, isSentryEnabled } from './sentry';
export { flushPendingWrites, getLogDb } from './eventLog';
export { createForwardingLogger } from './forwardingLogger';

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

// ---------- per-context state ----------
// Every extension page / worker is its own JS context, so this state is per side panel or per
// background worker. The background worker is killed when idle (MV3) and starts from scratch:
// nothing here may be needed across restarts.

/** Shared by all loggers in this context: they all describe the same current video/task. */
const sharedTags: Record<string, string | number> = {};
let activeComponent: 'panel' | 'background' = 'panel';
let globalHandlersInstalled = false;

/** Max serialized size of a forwarded event's data (it crossed from the YouTube page). */
const MAX_FORWARDED_DATA_CHARS = 4096;
const COMPONENTS: readonly Component[] = ['panel', 'content', 'main', 'background'];
const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function currentVideoId(): string | undefined {
  const v = sharedTags.videoId;
  return v === undefined ? undefined : String(v);
}

function devConsole(e: LogEvent): void {
  if (import.meta.env.DEV) console.debug(`[smrzr ${e.component}] ${e.name}`, e.data ?? '', e.videoId ?? '');
}

/**
 * panel/background: writes to IndexedDB event log directly and reports errors to Sentry.
 * content/main: forwards events to the background via messaging (no Sentry in the YouTube page).
 */
export function createLogger(component: Component): Logger {
  if (component === 'content' || component === 'main') return createForwardingLogger(component);

  // Every method is wrapped in try/catch: logging must never break the caller.
  return {
    event(name, data, opts) {
      try {
        const level = opts?.level ?? 'info';
        const videoId = opts?.videoId ?? currentVideoId();
        const event: LogEvent = {
          ts: Date.now(),
          component,
          level,
          name,
          ...(videoId ? { videoId } : {}),
          // scrubSecrets also makes the data storable (no functions, no cycles).
          ...(data ? { data: scrub(data) } : {}),
        };
        devConsole(event);
        void writeEvent(event);
        addSentryBreadcrumb(name, level, event.data, event.ts);
      } catch (err) {
        console.warn('[smrzr telemetry] event() failed', err);
      }
    },

    error(err, context) {
      try {
        const { videoId: ctxVideoId, ...rest } = context ?? {};
        const videoId = ctxVideoId ?? currentVideoId();
        const event: LogEvent = {
          ts: Date.now(),
          component,
          level: 'error',
          name: 'error',
          ...(videoId ? { videoId } : {}),
          data: scrub({ ...describeError(err), ...rest }),
        };
        if (import.meta.env.DEV) console.error(`[smrzr ${component}] error`, err, rest);
        void writeEvent(event);
        captureSentryError(err, { ...sharedTags, component, ...(videoId ? { videoId } : {}) }, rest);
      } catch (e) {
        console.warn('[smrzr telemetry] error() failed', e);
      }
    },

    setTags(tags) {
      for (const [key, value] of Object.entries(tags)) {
        if (value === undefined) delete sharedTags[key];
        else sharedTags[key] = value;
      }
    },

    recordExchange(x) {
      try {
        void writeExchange(scrub(x));
      } catch (err) {
        console.warn('[smrzr telemetry] recordExchange() failed', err);
      }
    },
  };
}

/**
 * Sets up the Sentry BrowserClient + Scope (no Sentry.init). No-op without WXT_SENTRY_DSN or when disabled.
 *
 * Safe to call repeatedly: calling it again with `enabled: false` closes the client (e.g. when
 * the user unticks "Send errors to Sentry"), and with `enabled: true` starts it once.
 * The local event log and the debug bundle work either way.
 */
export function initTelemetry(opts: { component: 'panel' | 'background'; enabled: boolean }): void {
  try {
    activeComponent = opts.component;
    installGlobalErrorHandlers();
    const dsn = getSentryDsn();
    if (opts.enabled && dsn) {
      startSentry({ dsn, release: `smrzr@${getExtensionVersion()}` });
    } else {
      stopSentry().catch((err: unknown) => console.warn('[smrzr telemetry] closing Sentry failed', err));
    }
  } catch (err) {
    console.warn('[smrzr telemetry] initTelemetry failed', err);
  }
}

/**
 * Uncaught errors in OUR pages (side panel window / background service worker) are logged and
 * reported. That's the job Sentry's GlobalHandlers integration would do; we do it ourselves so
 * the SDK doesn't hook any globals. `globalThis` is `window` in the panel and `self` in the worker.
 */
function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled || typeof globalThis.addEventListener !== 'function') return;
  globalHandlersInstalled = true;
  globalThis.addEventListener('error', (e: ErrorEvent) => {
    createLogger(activeComponent).error(e.error ?? e.message, { source: 'onerror' });
  });
  globalThis.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    createLogger(activeComponent).error(e.reason, { source: 'unhandledrejection' });
  });
}

/** Background handler for forwarded `log` messages from the YouTube tab. */
export function handleForwardedLog(event: LogEvent): Promise<void> {
  try {
    const clean = sanitizeForwardedEvent(event);
    if (!clean) return Promise.resolve();
    devConsole(clean);
    const written = writeEvent(clean);
    addSentryBreadcrumb(clean.name, clean.level, clean.data, clean.ts);
    if (clean.level === 'error') {
      // Errors from the YouTube tab are reported from here, because Sentry never runs in the page.
      const { message, stack, errorName, ...rest } = clean.data ?? {};
      const err = new Error(typeof message === 'string' ? message : clean.name);
      err.name = typeof errorName === 'string' ? errorName : 'ForwardedError';
      if (typeof stack === 'string') err.stack = stack;
      captureSentryError(err, { component: clean.component, ...(clean.videoId ? { videoId: clean.videoId } : {}) }, rest);
    }
    return written;
  } catch (err) {
    console.warn('[smrzr telemetry] handleForwardedLog failed', err);
    return Promise.resolve();
  }
}

/** Messages from a web page context are untrusted input: check the shape and cap the size. */
function sanitizeForwardedEvent(raw: unknown): LogEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Partial<Record<keyof LogEvent, unknown>>;
  if (typeof e.name !== 'string' || !e.name) return null;

  const component = COMPONENTS.includes(e.component as Component) ? (e.component as Component) : 'content';
  const level = LEVELS.includes(e.level as LogLevel) ? (e.level as LogLevel) : 'info';
  const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now();
  const videoId = typeof e.videoId === 'string' && e.videoId ? e.videoId.slice(0, 64) : undefined;

  let data: Record<string, unknown> | undefined;
  if (typeof e.data === 'object' && e.data !== null && !Array.isArray(e.data)) {
    data = scrub(e.data as Record<string, unknown>);
    const json = JSON.stringify(data);
    if (json.length > MAX_FORWARDED_DATA_CHARS) {
      data = { truncated: true, originalChars: json.length, preview: json.slice(0, MAX_FORWARDED_DATA_CHARS - 200) };
    }
  }

  return {
    ts,
    component,
    level,
    name: e.name.slice(0, 100),
    ...(videoId ? { videoId } : {}),
    ...(data ? { data } : {}),
  };
}

/** The most recent `limit` (default 100) events, optionally for one video, oldest first. */
export function getRecentEvents(opts?: { videoId?: string; limit?: number }): Promise<LogEvent[]> {
  return readRecentEvents(opts);
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

/**
 * Settings (key stripped), the full stored video record, this video's events plus the last 100
 * global ones, and this video's LLM exchanges. Run through scrubSecrets as a final safety net.
 */
export function buildDebugBundle(videoId: string | null): Promise<DebugBundle> {
  return buildBundle(videoId);
}

/** Sentry User Feedback + debug-bundle.json attachment. */
export async function sendIssueReport(args: { message: string; videoId: string | null }): Promise<{ ok: true; eventId: string } | { ok: false; reason: 'sentry_disabled' | 'send_failed' }> {
  const logger = createLogger(activeComponent);
  const logResult = (data: Record<string, unknown>) =>
    logger.event('ui.report', data, { level: data.ok ? 'info' : 'warn', ...(args.videoId ? { videoId: args.videoId } : {}) });

  if (!isSentryEnabled()) {
    logResult({ ok: false, reason: 'sentry_disabled' });
    return { ok: false, reason: 'sentry_disabled' };
  }

  try {
    const bundleJson = await copyDebugBundle(args.videoId);
    const result = await sendSentryFeedback({
      message: scrub(args.message),
      tags: args.videoId ? { videoId: args.videoId } : {},
      attachments: [{ filename: 'debug-bundle.json', data: bundleJson, contentType: 'application/json' }],
    });
    if (result.ok) {
      logResult({ ok: true, eventId: result.eventId, bundleChars: bundleJson.length });
      return { ok: true, eventId: result.eventId };
    }
  } catch (err) {
    console.warn('[smrzr telemetry] sendIssueReport failed', err);
  }
  logResult({ ok: false, reason: 'send_failed' });
  return { ok: false, reason: 'send_failed' };
}

/** Deep-copies and replaces anything that looks like a Google API key (AIza…) with "<redacted>". */
export function scrubSecrets<T>(value: T): T {
  return scrub(value);
}

/** Tests only: forget per-context state (tags, Sentry client). Does not clear IndexedDB. */
export async function resetTelemetryForTests(): Promise<void> {
  for (const key of Object.keys(sharedTags)) delete sharedTags[key];
  activeComponent = 'panel';
  await stopSentry();
  resetEventLogCounters();
}
