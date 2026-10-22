// Logger for scripts that run inside the YouTube tab (content script and MAIN-world script).
//
// Design §8.3: no Sentry and no IndexedDB in YouTube's page. YouTube has its own error tracking,
// and the page's IndexedDB belongs to youtube.com, not to us. Events are forwarded to the
// background worker, which writes them to the extension's log (see handleForwardedLog).
//
// This file deliberately imports nothing heavy (no Dexie, no Sentry). Content scripts can import
// `createForwardingLogger` from here directly to keep their bundle small.
import { sendToExtension } from '../messaging';
import type { Component, LogEvent } from '../types';
import type { Logger } from './index';

const MAX_STACK_CHARS = 2000;
let warnedForwardFailure = false;

/** A JSON-safe description of anything that was thrown. */
export function describeError(err: unknown): { message: string; stack?: string; errorName?: string } {
  if (err instanceof Error) {
    return {
      message: err.message,
      errorName: err.name,
      ...(err.stack ? { stack: err.stack.slice(0, MAX_STACK_CHARS) } : {}),
    };
  }
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { message: String(err) };
  }
}

export function createForwardingLogger(component: Extract<Component, 'content' | 'main'>): Logger {
  let currentVideoId: string | undefined;

  const forward = (event: LogEvent) => {
    try {
      if (import.meta.env.DEV) console.debug(`[smrzr ${component}] ${event.name}`, event.data ?? '');
      // NOTE for the MAIN-world script: page context has no `browser.runtime`, so this call
      // throws there. Its events must be relayed through the isolated content script
      // (postMessage bridge). The try/catch below keeps that mistake from breaking anything.
      sendToExtension({ type: 'log', event });
    } catch (err) {
      // Warn once only: if forwarding is impossible in this context, every event would fail.
      if (!warnedForwardFailure) console.warn('[smrzr telemetry] forwarding log events failed', err);
      warnedForwardFailure = true;
    }
  };

  return {
    event(name, data, opts) {
      forward({
        ts: Date.now(),
        component,
        level: opts?.level ?? 'info',
        name,
        videoId: opts?.videoId ?? currentVideoId,
        ...(data ? { data } : {}),
      });
    },
    error(err, context) {
      const { videoId, ...rest } = context ?? {};
      forward({
        ts: Date.now(),
        component,
        level: 'error',
        name: 'error',
        videoId: videoId ?? currentVideoId,
        data: { ...describeError(err), ...rest },
      });
    },
    setTags(tags) {
      // Tags only matter for Sentry, which runs in the background. Keep videoId as the default
      // for subsequent events so the background can file them under the right video.
      if ('videoId' in tags) currentVideoId = tags.videoId === undefined ? undefined : String(tags.videoId);
    },
    recordExchange() {
      // Full prompts/responses are recorded by the side panel, which makes the LLM calls.
    },
  };
}
