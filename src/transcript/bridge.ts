// Request/response bridge between the two scripts that run in the YouTube tab:
//
//   isolated content script (youtube.content.ts)  ⇄  MAIN-world script (youtube-main.content.ts)
//
// Both share the page's `window` but not their JS variables, and the MAIN world has no chrome.*
// APIs. The only channel between them is `window.postMessage`, which works like a broadcast:
// every listener on the page (including YouTube's own scripts) sees every message. So:
//   - every message is tagged `{ __smrzr: true, dir }` and each side ignores the other direction;
//   - we only accept messages whose `event.source` is this same window (not iframes);
//   - responses are matched to requests by a random `requestId`;
//   - nothing secret ever goes through here (the page could read it). Transcripts and video
//     metadata are YouTube's own data, so that's fine.
// A page script could forge messages; the worst it could do is feed us a fake transcript of a
// page it controls anyway, or spam the log (which is size-capped below).

import type { TranscriptResponse, VideoContextResponse } from '../messaging';
import type { LogEvent, LogLevel } from '../types';

export type BridgeRequest = { type: 'getVideoContext' } | { type: 'getTranscript'; videoId: string };

export interface BridgeResponseMap {
  getVideoContext: VideoContextResponse;
  getTranscript: TranscriptResponse;
}

export type BridgeResponseFor<R extends BridgeRequest> = BridgeResponseMap[R['type']];

type ToMain = { __smrzr: true; dir: 'to-main'; requestId: string; request: BridgeRequest };
type ToIsolated =
  | { __smrzr: true; dir: 'to-isolated'; kind: 'response'; requestId: string; response: unknown }
  | { __smrzr: true; dir: 'to-isolated'; kind: 'error'; requestId: string; error: string }
  | { __smrzr: true; dir: 'to-isolated'; kind: 'log'; event: LogEvent };

export const BRIDGE_TIMEOUTS = {
  getVideoContext: 3_000,
  // The chain's worst case is player 15 s + panel 8 s + dom 10 s; normally it's well under 5 s.
  getTranscript: 35_000,
} as const;

export class BridgeTimeoutError extends Error {
  constructor(type: string, ms: number) {
    super(`bridge: no answer to ${type} from MAIN world after ${ms}ms`);
    this.name = 'BridgeTimeoutError';
  }
}

export class BridgeRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeRemoteError';
  }
}

function isTagged(data: unknown): data is { __smrzr: true; dir: string } {
  return typeof data === 'object' && data !== null && (data as { __smrzr?: unknown }).__smrzr === true;
}

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

// postMessage to our own window: the target origin doesn't add protection here (all scripts on the
// page see the message anyway), and '*' avoids issues if location.origin is "null" (about:blank).
const TARGET_ORIGIN = '*';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const MAX_LOG_DATA_CHARS = 2_000;

/** Validates and normalizes a log event coming from the page. Returns null if it doesn't look right. */
function sanitizeLogEvent(raw: unknown): LogEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Partial<LogEvent>;
  if (typeof e.name !== 'string' || e.name.length === 0 || e.name.length > 100) return null;
  const level = LOG_LEVELS.includes(e.level as LogLevel) ? (e.level as LogLevel) : 'info';
  const event: LogEvent = {
    ts: typeof e.ts === 'number' ? e.ts : Date.now(),
    component: 'main',
    level,
    name: e.name,
  };
  if (typeof e.videoId === 'string') event.videoId = e.videoId.slice(0, 20);
  if (e.data && typeof e.data === 'object') {
    try {
      const json = JSON.stringify(e.data);
      event.data = json.length <= MAX_LOG_DATA_CHARS ? e.data : { truncated: true, chars: json.length };
    } catch {
      // not serializable: drop data
    }
  }
  return event;
}

// ---------------------------------------------------------------------------
// Isolated-world side
// ---------------------------------------------------------------------------

export interface BridgeClient {
  request<R extends BridgeRequest>(req: R, timeoutMs?: number): Promise<BridgeResponseFor<R>>;
  /** Called for every log event the MAIN world sends. Returns an unsubscribe function. */
  onLog(cb: (event: LogEvent) => void): () => void;
  dispose(): void;
}

export function createBridgeClient(win: Window): BridgeClient {
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const logListeners = new Set<(event: LogEvent) => void>();

  const onMessage = (e: MessageEvent): void => {
    if (e.source !== win) return;
    const data: unknown = e.data;
    if (!isTagged(data) || data.dir !== 'to-isolated') return;
    const msg = data as ToIsolated;
    if (msg.kind === 'log') {
      const event = sanitizeLogEvent(msg.event);
      if (!event) return;
      for (const cb of logListeners) {
        try {
          cb(event);
        } catch {
          // a broken listener must not break the bridge
        }
      }
      return;
    }
    const p = pending.get(msg.requestId);
    if (!p) return; // not ours, or already timed out
    pending.delete(msg.requestId);
    clearTimeout(p.timer);
    if (msg.kind === 'response') p.resolve(msg.response);
    else p.reject(new BridgeRemoteError(String(msg.error)));
  };
  win.addEventListener('message', onMessage);

  return {
    request<R extends BridgeRequest>(req: R, timeoutMs?: number): Promise<BridgeResponseFor<R>> {
      const ms = timeoutMs ?? BRIDGE_TIMEOUTS[req.type];
      const requestId = newRequestId();
      return new Promise<BridgeResponseFor<R>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new BridgeTimeoutError(req.type, ms));
        }, ms);
        pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject, timer });
        const msg: ToMain = { __smrzr: true, dir: 'to-main', requestId, request: req };
        win.postMessage(msg, TARGET_ORIGIN);
      });
    },
    onLog(cb) {
      logListeners.add(cb);
      return () => logListeners.delete(cb);
    },
    dispose() {
      win.removeEventListener('message', onMessage);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('bridge disposed'));
      }
      pending.clear();
      logListeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// MAIN-world side
// ---------------------------------------------------------------------------

export interface BridgeHandlers {
  getVideoContext(): Promise<VideoContextResponse>;
  getTranscript(videoId: string): Promise<TranscriptResponse>;
}

export interface BridgeServer {
  /** Sends a log event to the isolated world, which forwards it to the extension's event log. */
  log(name: string, data?: Record<string, unknown>, opts?: { level?: LogLevel; videoId?: string }): void;
  dispose(): void;
}

export function createBridgeServer(win: Window, handlers: BridgeHandlers): BridgeServer {
  const post = (msg: ToIsolated): void => {
    try {
      win.postMessage(msg, TARGET_ORIGIN);
    } catch {
      // e.g. a non-cloneable value slipped into a response; nothing sensible to do
    }
  };

  const handle = async (requestId: string, req: BridgeRequest): Promise<void> => {
    try {
      let response: unknown;
      if (req.type === 'getVideoContext') response = await handlers.getVideoContext();
      else if (req.type === 'getTranscript') response = await handlers.getTranscript(req.videoId);
      else throw new Error(`unknown request type`);
      post({ __smrzr: true, dir: 'to-isolated', kind: 'response', requestId, response });
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      post({ __smrzr: true, dir: 'to-isolated', kind: 'error', requestId, error: error.slice(0, 200) });
    }
  };

  const onMessage = (e: MessageEvent): void => {
    if (e.source !== win) return;
    const data: unknown = e.data;
    if (!isTagged(data) || data.dir !== 'to-main') return;
    const msg = data as ToMain;
    if (typeof msg.requestId !== 'string' || typeof msg.request !== 'object' || msg.request === null) return;
    void handle(msg.requestId, msg.request);
  };
  win.addEventListener('message', onMessage);

  return {
    log(name, data, opts) {
      const event: LogEvent = { ts: Date.now(), component: 'main', level: opts?.level ?? 'info', name };
      if (opts?.videoId) event.videoId = opts.videoId;
      if (data) event.data = data;
      post({ __smrzr: true, dir: 'to-isolated', kind: 'log', event });
    },
    dispose() {
      win.removeEventListener('message', onMessage);
    },
  };
}
