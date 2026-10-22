// Settings from chrome.storage.local, kept live (watchSettings fires when another
// extension page — or this one — saves), plus Sentry (re)initialisation.

import { useEffect, useState } from 'react';
import { getSettings, watchSettings } from '@/src/storage/settings';
import { initTelemetry } from '@/src/telemetry';
import type { Settings } from '@/src/types';
import { getLogger } from '../logger';

export function useSettings(): { settings: Settings | null; error: unknown; setSettings: (s: Settings) => void } {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: () => void = () => {};

    (async () => {
      try {
        const s = await getSettings();
        if (!cancelled) setSettings(s);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        getLogger().error(err, { task: 'settings_load' });
      }
    })();

    try {
      unsubscribe = watchSettings((s) => {
        if (!cancelled) setSettings(s);
      });
    } catch (err) {
      getLogger().error(err, { task: 'settings_watch' });
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { settings, error, setSettings };
}

/**
 * Initialises telemetry once settings are known and again whenever the Sentry toggle
 * changes (initTelemetry is expected to be idempotent / re-configurable).
 */
export function useTelemetry(sentryEnabled: boolean | undefined): void {
  useEffect(() => {
    if (sentryEnabled === undefined) return;
    try {
      initTelemetry({ component: 'panel', enabled: sentryEnabled });
    } catch (err) {
      console.warn('[smrzr] initTelemetry failed', err);
    }
  }, [sentryEnabled]);
}
