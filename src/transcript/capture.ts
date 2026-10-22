// Captures the YouTube player's own caption requests (strategy 1, design §4). MAIN world only.
//
// Why: since 2025 YouTube only answers caption requests that carry a proof-of-origin token
// (`pot=` in the URL), which its BotGuard JS computes inside the page. We can't compute it, but
// whenever the player loads captions it requests `/api/timedtext?…&pot=…` itself. By wrapping
// `window.fetch` and `XMLHttpRequest.prototype.open` *before* YouTube's scripts run
// (runAt: document_start) we see those URLs and can reuse them.
//
// The wrappers only READ the URL. They always call the original function with the original
// arguments and `this`, and never throw (any error in our code is swallowed), so the page
// behaves exactly as without the extension.

import { isTimedtextUrl, timedtextTrackParams, timedtextVideoId } from './timedtext';

export interface CapturedUrl {
  url: string;
  videoId: string;
  hasPot: boolean;
  /** Date.now() when captured. */
  ts: number;
}

export interface TimedtextCapture {
  /** Latest captured URL for this video (one carrying `pot=` is preferred). */
  latest(videoId: string): CapturedUrl | undefined;
  /** Resolves with the next URL captured for `videoId` after this call, or undefined after `timeoutMs`. */
  waitForNext(videoId: string, timeoutMs: number): Promise<CapturedUrl | undefined>;
  /**
   * The unpatched fetch. Our own requests use this so they don't get "captured" and
   * overwrite the player's token-carrying URL with our token-less one.
   */
  originalFetch: typeof fetch;
  /** Restores the original functions (used in tests). */
  uninstall(): void;
}

/** The subset of `window` we touch; lets tests pass a fake. */
export interface CaptureWindow {
  fetch: typeof fetch;
  XMLHttpRequest: { prototype: { open: (...args: never[]) => unknown } };
  location: { href: string };
}

const MAX_VIDEOS = 20;

export function installTimedtextCapture(
  win: CaptureWindow,
  onCapture?: (c: CapturedUrl) => void,
): TimedtextCapture {
  const byVideo = new Map<string, CapturedUrl>();
  const waiters = new Set<{ videoId: string; resolve: (c: CapturedUrl) => void }>();

  function note(rawUrl: string): void {
    const base = win.location.href;
    if (!isTimedtextUrl(rawUrl, base)) return;
    const videoId = timedtextVideoId(rawUrl, base);
    if (!videoId) return;
    const url = new URL(rawUrl, base).toString();
    const captured: CapturedUrl = { url, videoId, hasPot: !!timedtextTrackParams(url).pot, ts: Date.now() };

    // Don't replace a token-carrying URL with a token-less one (the token is the valuable part).
    const prev = byVideo.get(videoId);
    if (!(prev?.hasPot && !captured.hasPot)) {
      byVideo.delete(videoId); // re-insert so Map order = recency
      byVideo.set(videoId, captured);
      while (byVideo.size > MAX_VIDEOS) {
        const oldest = byVideo.keys().next().value;
        if (oldest === undefined) break;
        byVideo.delete(oldest);
      }
    }
    for (const w of [...waiters]) {
      if (w.videoId === videoId) {
        waiters.delete(w);
        w.resolve(captured);
      }
    }
    onCapture?.(captured);
  }

  function urlOf(input: unknown): string | null {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    // A Request object (or anything with a string `url`).
    if (input && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') {
      return (input as { url: string }).url;
    }
    return null;
  }

  // ---- fetch ----
  const originalFetch = win.fetch;
  const patchedFetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    try {
      const url = urlOf(args[0]);
      if (url) note(url);
    } catch {
      // never let our code break the page
    }
    return originalFetch.apply(this, args);
  };
  win.fetch = patchedFetch as typeof fetch;

  // ---- XMLHttpRequest ----
  // XHR requests are configured with xhr.open(method, url, …) before send(); the URL is visible there.
  const xhrProto = win.XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  xhrProto.open = function (this: unknown, ...args: unknown[]) {
    try {
      const url = urlOf(args[1]);
      if (url) note(url);
    } catch {
      // never let our code break the page
    }
    return (originalOpen as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof xhrProto.open;

  return {
    latest: (videoId) => byVideo.get(videoId),
    waitForNext: (videoId, timeoutMs) =>
      new Promise((resolve) => {
        const waiter = { videoId, resolve: (c: CapturedUrl) => resolve(c) };
        waiters.add(waiter);
        setTimeout(() => {
          if (waiters.delete(waiter)) resolve(undefined);
        }, timeoutMs);
      }),
    originalFetch: originalFetch.bind(win as unknown as typeof globalThis),
    uninstall: () => {
      if (win.fetch === (patchedFetch as typeof fetch)) win.fetch = originalFetch;
      xhrProto.open = originalOpen;
    },
  };
}
