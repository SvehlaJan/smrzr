import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, getSettings, getStoredSettings, saveSettings, watchSettings } from '../../src/storage/settings';

beforeEach(() => {
  fakeBrowser.reset();
  // Make the tests independent of a developer's .env.local.
  vi.stubEnv('WXT_GEMINI_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSettings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges stored values over the defaults, including partial model maps', async () => {
    await fakeBrowser.storage.local.set({ settings: { apiKey: 'k1', models: { chat: 'gemini-pro' } } });
    expect(await getSettings()).toEqual({
      apiKey: 'k1',
      models: { summary: '', details: '', visuals: '', chat: 'gemini-pro' },
      sentryEnabled: true,
    });
  });

  it('does not mutate DEFAULT_SETTINGS', async () => {
    await saveSettings({ models: { ...DEFAULT_SETTINGS.models, summary: 'flash' } });
    expect(DEFAULT_SETTINGS.models.summary).toBe('');
  });
});

describe('saveSettings', () => {
  it('merges the patch, persists to storage.local and returns the result', async () => {
    await saveSettings({ apiKey: 'k1' });
    const result = await saveSettings({ sentryEnabled: false });
    expect(result).toEqual({ ...DEFAULT_SETTINGS, apiKey: 'k1', sentryEnabled: false });
    expect(await getSettings()).toEqual(result);

    const raw = await fakeBrowser.storage.local.get('settings');
    expect(raw.settings).toEqual(result);
  });

  it('deep-merges models', async () => {
    await saveSettings({ models: { summary: 'flash', details: '', visuals: '', chat: '' } });
    // A caller may pass only some tasks (e.g. from a partially loaded form) — no cast needed.
    const result = await saveSettings({ models: { chat: 'pro' } });
    expect(result.models).toEqual({ summary: 'flash', details: '', visuals: '', chat: 'pro' });
  });

  it('never touches storage.sync (the API key must stay on the device)', async () => {
    const syncSet = vi.spyOn(fakeBrowser.storage.sync, 'set');
    await saveSettings({ apiKey: 'secret' });
    expect(syncSet).not.toHaveBeenCalled();
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });
});

describe('dev API key fallback', () => {
  it('uses WXT_GEMINI_API_KEY in dev builds when no key is stored', async () => {
    vi.stubEnv('WXT_GEMINI_API_KEY', 'dev-key');
    expect((await getSettings()).apiKey).toBe('dev-key');
  });

  it('prefers the stored key', async () => {
    vi.stubEnv('WXT_GEMINI_API_KEY', 'dev-key');
    await saveSettings({ apiKey: 'user-key' });
    expect((await getSettings()).apiKey).toBe('user-key');
  });

  it('is ignored in production builds', async () => {
    vi.stubEnv('WXT_GEMINI_API_KEY', 'dev-key');
    vi.stubEnv('DEV', false);
    expect((await getSettings()).apiKey).toBe('');
  });

  it('getStoredSettings shows only the stored key and says where the key in use comes from', async () => {
    vi.stubEnv('WXT_GEMINI_API_KEY', 'dev-key');
    expect(await getStoredSettings()).toEqual({ settings: DEFAULT_SETTINGS, apiKeySource: 'dev_env' });

    await saveSettings({ apiKey: 'user-key' });
    expect(await getStoredSettings()).toMatchObject({ settings: { apiKey: 'user-key' }, apiKeySource: 'stored' });

    vi.stubEnv('WXT_GEMINI_API_KEY', '');
    await saveSettings({ apiKey: '' });
    expect(await getStoredSettings()).toMatchObject({ settings: { apiKey: '' }, apiKeySource: 'none' });
  });

  it('is never written to storage', async () => {
    vi.stubEnv('WXT_GEMINI_API_KEY', 'dev-key');
    const result = await saveSettings({ sentryEnabled: false });
    expect(result.apiKey).toBe('dev-key');
    const raw = await fakeBrowser.storage.local.get('settings');
    expect((raw.settings as { apiKey: string }).apiKey).toBe('');
  });
});

describe('watchSettings', () => {
  it('calls back with merged settings on change and stops after unsubscribe', async () => {
    const cb = vi.fn();
    const unsubscribe = watchSettings(cb);

    await saveSettings({ sentryEnabled: false });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, sentryEnabled: false });

    await fakeBrowser.storage.local.set({ unrelated: 1 });
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    await saveSettings({ sentryEnabled: true });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ignores changes in other storage areas', async () => {
    const cb = vi.fn();
    watchSettings(cb);
    await fakeBrowser.storage.session.set({ settings: { apiKey: 'x' } });
    expect(cb).not.toHaveBeenCalled();
  });
});
