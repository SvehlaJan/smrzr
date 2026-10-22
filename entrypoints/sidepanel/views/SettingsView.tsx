// API key, per-task models and the Sentry toggle. Edits are local until "Save".

import { useEffect, useId, useState } from 'react';
import type { ModelInfo } from '@/src/llm/client';
import { createGeminiClient } from '@/src/llm/gemini';
import { pickDefaultModels, selectableModels } from '@/src/llm/models';
import { getStoredSettings, saveSettings, type ApiKeySource } from '@/src/storage/settings';
import type { LlmTask, Settings } from '@/src/types';
import { handleError } from '../errors';
import { logUiAction } from '../logger';

const TASKS: { task: LlmTask; label: string; hint: string }[] = [
  { task: 'summary', label: 'Summary', hint: 'Key points (Flash recommended)' },
  { task: 'details', label: 'Details', hint: 'Expanding a point' },
  { task: 'visuals', label: 'Visuals', hint: 'Looking at the video' },
  { task: 'chat', label: 'Chat', hint: 'Discussion & fact-checks (Pro recommended)' },
];

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string };

/**
 * `settings` are the settings in use. The form itself starts from what is *stored*: in development
 * builds the settings in use may contain the fallback key from .env, which must never be shown
 * in the key field (Save would then write it to storage).
 */
export function SettingsView({ settings, onSaved }: { settings: Settings; onSaved(s: Settings): void }) {
  const [stored, setStored] = useState<Awaited<ReturnType<typeof getStoredSettings>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStoredSettings().then(
      (s) => {
        if (!cancelled) setStored(s);
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(handleError(err, { task: 'settings_load' })?.message ?? "Couldn't load settings.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) return <p className="error-text pad" role="alert">{loadError}</p>;
  if (!stored) return <p className="muted progress pad">Loading…</p>;
  return <SettingsForm initial={stored.settings} initialKeySource={stored.apiKeySource} inUse={settings} onSaved={onSaved} />;
}

function SettingsForm(props: { initial: Settings; initialKeySource: ApiKeySource; inUse: Settings; onSaved(s: Settings): void }) {
  const { initial, inUse, onSaved } = props;
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [keySource, setKeySource] = useState(props.initialKeySource);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState(initial.models);
  const [sentryEnabled, setSentryEnabled] = useState(initial.sentryEnabled);
  const [available, setAvailable] = useState<ModelInfo[] | null>(null);
  const [loadStatus, setLoadStatus] = useState<Status>({ kind: 'idle' });
  const [saveStatus, setSaveStatus] = useState<Status>({ kind: 'idle' });
  const keyId = useId();

  // With an empty field, a development build may still have its .env key to load models with.
  const keyForRequests = apiKey.trim() || (keySource === 'dev_env' ? inUse.apiKey : '');

  const loadModels = async () => {
    setLoadStatus({ kind: 'busy' });
    try {
      const list = selectableModels(await createGeminiClient(keyForRequests).listModels());
      setAvailable(list);
      const defaults = pickDefaultModels(list);
      // Only fill dropdowns that are still empty; never override an explicit choice.
      setModels((prev) => {
        const next = { ...prev };
        for (const { task } of TASKS) if (!next[task]) next[task] = defaults[task];
        return next;
      });
      setLoadStatus({ kind: 'ok', text: `${list.length} models available.` });
    } catch (err) {
      const ui = handleError(err, { task: 'list_models' });
      setLoadStatus(ui ? { kind: 'error', text: ui.message } : { kind: 'idle' });
    }
  };

  const save = async () => {
    setSaveStatus({ kind: 'busy' });
    try {
      const saved = await saveSettings({ apiKey: apiKey.trim(), models, sentryEnabled });
      logUiAction('settings_save', { hasKey: !!saved.apiKey, models: saved.models, sentryEnabled: saved.sentryEnabled });
      // `saved` includes the dev fallback, so a key there with an empty field means the .env key.
      setKeySource(apiKey.trim() ? 'stored' : saved.apiKey ? 'dev_env' : 'none');
      onSaved(saved);
      setSaveStatus({ kind: 'ok', text: 'Saved.' });
    } catch (err) {
      const ui = handleError(err, { task: 'settings_save' });
      setSaveStatus({ kind: 'error', text: ui?.message ?? 'Saving failed.' });
    }
  };

  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault(); // stay on the page; forms would otherwise navigate
        void save();
      }}
    >
      <div className="field">
        <label htmlFor={keyId}>Gemini API key</label>
        <div className="row gap">
          <input
            id={keyId}
            className="input grow"
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            placeholder="AIza…"
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button type="button" className="btn" aria-pressed={showKey} onClick={() => setShowKey((v) => !v)}>
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <span className="muted small">Stored only in this browser. Get one at aistudio.google.com.</span>
        {keySource === 'dev_env' && (
          <span className="muted small">Using the development key from .env.development.local.</span>
        )}
      </div>

      <div className="field">
        <div className="row gap">
          <button type="button" className="btn" disabled={!keyForRequests || loadStatus.kind === 'busy'} onClick={() => void loadModels()}>
            {loadStatus.kind === 'busy' ? 'Loading…' : 'Load models'}
          </button>
          {loadStatus.kind === 'ok' && <span className="muted small">{loadStatus.text}</span>}
        </div>
        {loadStatus.kind === 'error' && <p className="error-text" role="alert">{loadStatus.text}</p>}
      </div>

      {TASKS.map(({ task, label, hint }) => (
        <ModelSelect
          key={task}
          label={label}
          hint={hint}
          value={models[task]}
          available={available}
          onChange={(id) => setModels((prev) => ({ ...prev, [task]: id }))}
        />
      ))}

      <label className="check">
        <input type="checkbox" checked={sentryEnabled} onChange={(e) => setSentryEnabled(e.target.checked)} />
        <span>Send error reports to Sentry</span>
      </label>

      <div className="row gap">
        <button type="submit" className="btn btn-primary" disabled={saveStatus.kind === 'busy'}>
          {saveStatus.kind === 'busy' ? 'Saving…' : 'Save'}
        </button>
        {saveStatus.kind === 'ok' && <span className="ok-text" role="status">{saveStatus.text}</span>}
      </div>
      {saveStatus.kind === 'error' && <p className="error-text" role="alert">{saveStatus.text}</p>}
    </form>
  );
}

function ModelSelect(props: {
  label: string;
  hint: string;
  value: string;
  available: ModelInfo[] | null;
  onChange(id: string): void;
}) {
  const id = useId();
  const options = props.available ?? [];
  // Keep the saved choice visible even before "Load models" (or if it disappeared from the list).
  const showCurrent = props.value && !options.some((m) => m.id === props.value);
  return (
    <div className="field">
      <label htmlFor={id}>{props.label} model</label>
      <select id={id} className="input" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">{props.available ? '— choose —' : '— load models first —'}</option>
        {showCurrent && <option value={props.value}>{props.value}</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName && m.displayName !== m.id ? `${m.displayName} (${m.id})` : m.id}
          </option>
        ))}
      </select>
      <span className="muted small">{props.hint}</span>
    </div>
  );
}
