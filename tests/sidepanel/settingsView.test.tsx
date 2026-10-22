import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError, type ModelInfo } from '@/src/llm/client';
import type { ApiKeySource } from '@/src/storage/settings';
import type { Settings } from '@/src/types';
import { SettingsView } from '@/entrypoints/sidepanel/views/SettingsView';
import { fakeClient, geminiMock, modelsMock, resetMocks, settingsMock } from './mocks';

vi.mock('@/src/telemetry', async () => (await import('./mocks')).telemetryMock);
vi.mock('@/src/llm/gemini', async () => (await import('./mocks')).geminiMock);
vi.mock('@/src/llm/models', async () => (await import('./mocks')).modelsMock);
vi.mock('@/src/storage/settings', async () => (await import('./mocks')).settingsMock);

const MODELS: ModelInfo[] = [
  { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', inputTokenLimit: 1e6, outputTokenLimit: 65536 },
  { id: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', inputTokenLimit: 1e6, outputTokenLimit: 65536 },
];
const DEFAULTS = { summary: 'gemini-3-flash', details: 'gemini-3-flash', visuals: 'gemini-3-flash', chat: 'gemini-3.1-pro' };
const EMPTY: Settings = { apiKey: '', models: { summary: '', details: '', visuals: '', chat: '' }, sentryEnabled: true };

beforeEach(() => {
  resetMocks();
  fakeClient.listModels.mockResolvedValue(MODELS);
  modelsMock.selectableModels.mockImplementation((m: ModelInfo[]) => m);
  modelsMock.pickDefaultModels.mockReturnValue(DEFAULTS);
  settingsMock.saveSettings.mockImplementation(async (patch: Partial<Settings>) => ({ ...EMPTY, ...patch }));
});
afterEach(cleanup);

const select = (label: string) => screen.getByLabelText(`${label} model`) as HTMLSelectElement;

/**
 * Renders the view. `settings` are the settings in use; the form reads the stored ones
 * (= the same, except in dev builds without a stored key, where `inUse` has the .env key).
 */
async function renderView(stored: Settings, opts: { apiKeySource?: ApiKeySource; inUse?: Settings; onSaved?: (s: Settings) => void } = {}) {
  const apiKeySource = opts.apiKeySource ?? (stored.apiKey ? 'stored' : 'none');
  settingsMock.getStoredSettings.mockResolvedValue({ settings: stored, apiKeySource });
  render(<SettingsView settings={opts.inUse ?? stored} onSaved={opts.onSaved ?? (() => {})} />);
  return (await screen.findByLabelText('Gemini API key')) as HTMLInputElement;
}

describe('SettingsView', () => {
  it('loads models, prefills defaults and saves the chosen values', async () => {
    const onSaved = vi.fn();
    const key = await renderView(EMPTY, { onSaved });
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: '  AIzaFakeKey  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(key.type).toBe('text');

    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText('2 models available.');
    expect(geminiMock.createGeminiClient).toHaveBeenCalledWith('AIzaFakeKey');
    expect(select('Summary').value).toBe('gemini-3-flash');
    expect(select('Chat').value).toBe('gemini-3.1-pro');

    fireEvent.change(select('Details'), { target: { value: 'gemini-3.1-pro' } });
    fireEvent.click(screen.getByLabelText('Send error reports to Sentry'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved.');
    expect(settingsMock.saveSettings).toHaveBeenCalledWith({
      apiKey: 'AIzaFakeKey',
      models: { ...DEFAULTS, details: 'gemini-3.1-pro' },
      sentryEnabled: false,
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('does not override models that were already chosen', async () => {
    const chosen: Settings = { ...EMPTY, apiKey: 'k', models: { ...EMPTY.models, chat: 'gemini-3-flash' } };
    await renderView(chosen);
    expect(select('Chat').value).toBe('gemini-3-flash'); // visible before loading
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText('2 models available.');
    expect(select('Chat').value).toBe('gemini-3-flash');
    expect(select('Summary').value).toBe('gemini-3-flash');
  });

  it('explains a rejected API key', async () => {
    fakeClient.listModels.mockRejectedValue(new LlmError('API key not valid', 'auth', 400));
    await renderView({ ...EMPTY, apiKey: 'bad' });
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Gemini rejected this API key/);
  });

  it('never shows or saves the development .env key, but can still use it to load models', async () => {
    const devKey = 'AIzaDevKeyFromEnvFile';
    const key = await renderView(EMPTY, { apiKeySource: 'dev_env', inUse: { ...EMPTY, apiKey: devKey } });
    expect(key.value).toBe('');
    expect(screen.getByText('Using the development key from .env.development.local.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText('2 models available.');
    expect(geminiMock.createGeminiClient).toHaveBeenCalledWith(devKey);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(settingsMock.saveSettings.mock.calls[0]?.[0]).toMatchObject({ apiKey: '' });
  });

  it('shows the stored key and no development hint when a key was saved', async () => {
    const key = await renderView({ ...EMPTY, apiKey: 'AIzaStoredKey' });
    expect(key.value).toBe('AIzaStoredKey');
    expect(screen.queryByText(/development key/)).toBeNull();
  });
});
