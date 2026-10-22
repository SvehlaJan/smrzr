// Sentry wiring for the extension's own pages (side panel, background worker). Design §8.3.
//
// Why no `Sentry.init()`: init() installs *global* integrations (patching fetch, console,
// setTimeout, window.onerror …) and registers a global client. In a browser extension that is
// discouraged by Sentry ("shared environments" guidance), and the SDK even refuses to init in
// some extension contexts. Instead we create our own BrowserClient + Scope and always capture
// through that scope. Nothing global is touched.
import {
  BrowserClient,
  Scope,
  captureFeedback,
  defaultStackParser,
  getDefaultIntegrations,
  makeFetchTransport,
  startSpan,
  type Breadcrumb,
  type BrowserOptions,
  type SeverityLevel,
} from '@sentry/browser';
import type { LogLevel } from '../types';
import { scrubEvent, scrubSecrets } from './scrub';

/**
 * Default integrations that hook into global state (patch built-ins or install global handlers).
 * They would also capture errors and breadcrumbs from code that isn't ours. We install our own
 * error listeners in index.ts instead.
 */
const GLOBAL_STATE_INTEGRATIONS = new Set([
  'BrowserApiErrors', // wraps setTimeout/requestAnimationFrame/addEventListener
  'Breadcrumbs', // patches console, fetch, XHR, history, DOM events
  'GlobalHandlers', // window.onerror / onunhandledrejection
  'FunctionToString', // patches Function.prototype.toString
  'Console', // patches console
  'BrowserSession', // global session tracking on the global scope
]);

const MAX_BREADCRUMBS = 100;

type Transport = NonNullable<BrowserOptions['transport']>;

interface SentryState {
  client: BrowserClient;
  scope: Scope;
}

let state: SentryState | null = null;
let transportOverride: Transport | null = null;

/** Tests only: replace the network transport (e.g. to capture envelopes). */
export function setSentryTransportForTests(t: Transport | null): void {
  transportOverride = t;
}

export function isSentryEnabled(): boolean {
  return state !== null;
}

/** The DSN baked in at build time from WXT_SENTRY_DSN (.env.local). Empty → Sentry stays off. */
export function getSentryDsn(): string | undefined {
  const dsn: unknown = import.meta.env.WXT_SENTRY_DSN;
  return typeof dsn === 'string' && dsn.trim() ? dsn.trim() : undefined;
}

export function startSentry(opts: { dsn: string; release: string }): void {
  if (state) return;

  const client = new BrowserClient({
    dsn: opts.dsn,
    transport: transportOverride ?? makeFetchTransport,
    stackParser: defaultStackParser,
    integrations: getDefaultIntegrations({}).filter((i) => !GLOBAL_STATE_INTEGRATIONS.has(i.name)),
    release: opts.release,
    environment: import.meta.env.MODE,
    maxBreadcrumbs: MAX_BREADCRUMBS,
    // v11 replaced `sendDefaultPii` with `dataCollection`. Collect nothing personal.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
    },
    // Tracing at 100%: personal volume is tiny (design §8.3). 'static' = one transaction per root
    // span, sent through the span's own scope, which works with our manual (non-global) scope.
    tracesSampleRate: 1.0,
    traceLifecycle: 'static',
    // Scrubbing, layer 1. Note: beforeSend only runs for *error* events, so the scope's
    // event processor below covers feedback and transactions as well.
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSecrets(breadcrumb),
  });

  const scope = new Scope();
  scope.setClient(client);
  // Scrubbing, layer 2: runs for every event type captured through this scope (or its clones).
  scope.addEventProcessor((event) => scrubEvent(event));
  // The order matters: the scope must know the client before integrations are set up.
  client.init();

  state = { client, scope };
}

export async function stopSentry(): Promise<void> {
  const current = state;
  state = null;
  if (current) await current.client.close(2000);
}

// ---------- capturing ----------

function toSeverity(level: LogLevel): SeverityLevel {
  return level === 'warn' ? 'warning' : level;
}

/** Adds a breadcrumb so the next error report carries recent history. Metadata only. */
export function addSentryBreadcrumb(name: string, level: LogLevel, data: Record<string, unknown> | undefined, ts: number): void {
  if (!state) return;
  const crumb: Breadcrumb = {
    type: 'default',
    category: name,
    level: toSeverity(level),
    timestamp: ts / 1000,
    ...(data ? { data: scrubSecrets(data) } : {}),
  };
  // scope.addBreadcrumb bypasses the client's beforeBreadcrumb hook, so scrub here (above).
  state.scope.addBreadcrumb(crumb, MAX_BREADCRUMBS);
}

/** Captures an exception with per-event tags and a `details` context. Returns the event id, if sent. */
export function captureSentryError(
  err: unknown,
  tags: Record<string, string | number>,
  context: Record<string, unknown> | undefined,
): string | undefined {
  if (!state) return undefined;
  // A clone keeps these tags/context on this one event (breadcrumbs and client are copied over).
  const scope = state.scope.clone();
  scope.setTags(tags);
  if (context && Object.keys(context).length) scope.setContext('details', scrubSecrets(context));
  return scope.captureException(err);
}

/**
 * Sends Sentry User Feedback with attachments and waits until the transport has answered.
 * Feedback events accept `hint.attachments`: Client.sendEvent puts them into the same envelope.
 */
export async function sendSentryFeedback(args: {
  message: string;
  tags: Record<string, string>;
  attachments: { filename: string; data: string; contentType: string }[];
  timeoutMs?: number;
}): Promise<{ ok: true; eventId: string } | { ok: false }> {
  if (!state) return { ok: false };
  const { client } = state;
  const timeoutMs = args.timeoutMs ?? 5000;

  // We pick the event id ourselves so we can listen for *this* event's send result.
  const eventId = crypto.randomUUID().replace(/-/g, '');
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sent = new Promise<number | undefined>((resolve) => {
    unsubscribe = client.on('afterSendEvent', (event, response) => {
      if (event.event_id === eventId) resolve(response.statusCode);
    });
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });

  const scope = state.scope.clone();
  scope.setTags(args.tags);
  captureFeedback(
    { message: args.message, source: 'smrzr-report-issue', tags: args.tags },
    { event_id: eventId, attachments: args.attachments },
    scope,
  );

  const statusCode = await sent;
  clearTimeout(timer);
  unsubscribe();
  await client.flush(timeoutMs);
  // statusCode is undefined when the request failed or timed out (the SDK resolves with `{}`).
  const ok = statusCode !== undefined && statusCode >= 200 && statusCode < 300;
  return ok ? { ok: true, eventId } : { ok: false };
}

/**
 * Runs `fn` inside a Sentry span (sent as its own transaction). Without Sentry it just runs `fn`.
 * Spans are not nested across `await`s: each call is an independent root span, which is enough
 * to see latency per transcript strategy / model.
 */
export function withSpan<T>(name: string, fn: () => T, attributes?: Record<string, string | number | boolean>): T {
  if (!state) return fn();
  return startSpan({ name, op: name.split('.')[0], scope: state.scope, attributes }, () => fn());
}
