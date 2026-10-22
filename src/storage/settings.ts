// Settings in chrome.storage.local (never storage.sync: the API key must not leave the device). Design §7.
//
// Why storage.local and not localStorage: chrome.storage is shared by every extension context
// (side panel, background worker), works inside MV3 service workers (which have no
// localStorage), and fires `onChanged` in all of them when a value changes.
import { browser } from 'wxt/browser';
import type { LlmTask, Settings } from '../types';

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  models: { summary: '', details: '', visuals: '', chat: '' },
  sentryEnabled: true,
};

/** The single storage.local key that holds the whole Settings object. */
export const SETTINGS_KEY = 'settings';

/** What may actually be in storage: older versions may have stored fewer fields. */
type StoredSettings = Partial<Omit<Settings, 'models'>> & { models?: Partial<Record<LlmTask, string>> };

/** In development builds, an empty apiKey falls back to import.meta.env.WXT_GEMINI_API_KEY. */
export async function getSettings(): Promise<Settings> {
  return withDevFallback(mergeSettings(DEFAULT_SETTINGS, await readStored()));
}

/**
 * Merges `patch` over the stored settings (models are merged per task), saves and returns the result.
 * The dev-only fallback key is never written to storage.
 */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = mergeSettings(mergeSettings(DEFAULT_SETTINGS, await readStored()), patch);
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return withDevFallback(next);
}

/**
 * Calls `cb` with the full, merged settings whenever they change in any extension context
 * (e.g. the side panel saves, the background worker reacts). Returns an unsubscribe function.
 */
export function watchSettings(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
    if (areaName !== 'local' || !(SETTINGS_KEY in changes)) return;
    const stored = (changes[SETTINGS_KEY]?.newValue ?? {}) as StoredSettings;
    cb(withDevFallback(mergeSettings(DEFAULT_SETTINGS, stored)));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------- helpers ----------

async function readStored(): Promise<StoredSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const value = result[SETTINGS_KEY];
  return value && typeof value === 'object' ? (value as StoredSettings) : {};
}

/** Shallow merge, except `models`, which is merged per task so a partial patch keeps the other tasks. */
function mergeSettings(base: Settings, patch: StoredSettings): Settings {
  const merged: Settings = { ...base, models: { ...base.models } };
  if (patch.apiKey !== undefined) merged.apiKey = patch.apiKey;
  if (patch.sentryEnabled !== undefined) merged.sentryEnabled = patch.sentryEnabled;
  if (patch.models) {
    for (const [task, model] of Object.entries(patch.models)) {
      if (model !== undefined) merged.models[task as LlmTask] = model;
    }
  }
  return merged;
}

/**
 * Development convenience: `WXT_GEMINI_API_KEY` from the git-ignored `.env.local` is used when no
 * key was entered in settings (it is never written to storage).
 *
 * Vite inlines `import.meta.env.*` as literals at build time. In a production build
 * `import.meta.env.DEV` becomes `false`, so the ternary below collapses to `undefined` and the
 * key literal is dropped by Rollup's dead-branch elimination — the key is baked into DEV bundles
 * only. (Belt and braces: `grep -r AIza .output/` after `npm run build` should find nothing.)
 */
function devApiKey(): string | undefined {
  const key: unknown = import.meta.env.DEV ? import.meta.env.WXT_GEMINI_API_KEY : undefined;
  return typeof key === 'string' && key ? key : undefined;
}

function withDevFallback(s: Settings): Settings {
  if (s.apiKey) return s;
  const devKey = devApiKey();
  return devKey ? { ...s, apiKey: devKey } : s;
}
