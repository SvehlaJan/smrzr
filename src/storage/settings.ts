// Settings in chrome.storage.local (never storage.sync: the API key must not leave the device). Design §7.
import type { Settings } from '../types';
import { notImplemented } from '../notImplemented';

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  models: { summary: '', details: '', visuals: '', chat: '' },
  sentryEnabled: true,
};

/** In development builds, an empty apiKey falls back to import.meta.env.WXT_GEMINI_API_KEY. */
export function getSettings(): Promise<Settings> {
  return notImplemented('getSettings');
}
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return notImplemented('saveSettings');
}
/** Returns an unsubscribe function. */
export function watchSettings(cb: (s: Settings) => void): () => void {
  return notImplemented('watchSettings');
}
