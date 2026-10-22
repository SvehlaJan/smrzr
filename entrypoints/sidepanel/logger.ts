// The panel's single Logger instance (design §8).
//
// Created lazily on first use rather than at import time, so importing a component in a
// test (or before telemetry is initialised) has no side effects. If the telemetry module
// fails to create a logger we fall back to the console instead of crashing the whole UI:
// logging must never be the reason the panel doesn't render.

import { createLogger, type Logger } from '@/src/telemetry';

let instance: Logger | null = null;

const consoleLogger: Logger = {
  event: (name, data, opts) => console.debug('[smrzr]', name, data ?? {}, opts ?? {}),
  error: (err, context) => console.error('[smrzr]', err, context ?? {}),
  setTags: () => {},
  recordExchange: () => {},
};

export function getLogger(): Logger {
  if (!instance) {
    try {
      instance = createLogger('panel');
    } catch (err) {
      console.warn('[smrzr] createLogger failed, using console logger', err);
      instance = consoleLogger;
    }
  }
  return instance;
}

/** Shorthand for the `ui.action` event (metadata only: ids, counts, never content). */
export function logUiAction(action: string, data: Record<string, unknown> = {}, videoId?: string | null): void {
  getLogger().event('ui.action', { action, ...data }, videoId ? { videoId } : undefined);
}
