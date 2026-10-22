import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError, type ModelInfo } from '@/src/llm/client';
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

describe('SettingsView', () => {
  it('loads models, prefills defaults and saves the chosen values', async () => {
    const onSaved = vi.fn();
    render(<SettingsView settings={EMPTY} onSaved={onSaved} />);

    const key = screen.getByLabelText('Gemini API key') as HTMLInputElement;
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
    render(<SettingsView settings={chosen} onSaved={() => {}} />);
    expect(select('Chat').value).toBe('gemini-3-flash'); // visible before loading
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText('2 models available.');
    expect(select('Chat').value).toBe('gemini-3-flash');
    expect(select('Summary').value).toBe('gemini-3-flash');
  });

  it('explains a rejected API key', async () => {
    fakeClient.listModels.mockRejectedValue(new LlmError('API key not valid', 'auth', 400));
    render(<SettingsView settings={{ ...EMPTY, apiKey: 'bad' }} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Gemini rejected this API key/);
  });
});
