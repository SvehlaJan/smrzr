// The background worker's wiring: side panel behavior, telemetry init, forwarded logs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../../entrypoints/background';
import { saveSettings } from '../../src/storage/settings';
import { flushPendingWrites, getLogDb, getRecentEvents, isSentryEnabled, resetTelemetryForTests } from '../../src/telemetry';
import { setSentryTransportForTests } from '../../src/telemetry/sentry';

beforeEach(async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 'smrzr', version: '0.1.0' });
  vi.stubEnv('WXT_SENTRY_DSN', 'https://k@o1.ingest.de.sentry.io/2');
  setSentryTransportForTests(() => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }));
  await resetTelemetryForTests();
  await getLogDb().events.clear();
});

afterEach(async () => {
  await resetTelemetryForTests();
  setSentryTransportForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function startBackground() {
  const setPanelBehavior = vi.spyOn(fakeBrowser.sidePanel, 'setPanelBehavior').mockResolvedValue(undefined);
  await background.main();
  return { setPanelBehavior };
}

describe('background', () => {
  it('opens the side panel on toolbar click', async () => {
    const { setPanelBehavior } = await startBackground();
    await vi.waitFor(() => expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true }));
  });

  it('survives a missing sidePanel API', async () => {
    // fakeBrowser's sidePanel is unimplemented and throws, like a browser without the API.
    await expect(Promise.resolve(background.main())).resolves.not.toThrow();
    await vi.waitFor(async () => expect((await getRecentEvents()).some((e) => e.data?.where === 'sidePanel.setPanelBehavior')).toBe(true));
  });

  it('follows the sentryEnabled setting', async () => {
    await startBackground();
    await vi.waitFor(() => expect(isSentryEnabled()).toBe(true));
    await saveSettings({ sentryEnabled: false });
    expect(isSentryEnabled()).toBe(false);
  });

  it('stores forwarded log events and ignores other messages', async () => {
    await startBackground();
    await fakeBrowser.runtime.sendMessage({
      type: 'log',
      event: { ts: 1, component: 'content', level: 'info', name: 'transcript.attempt', videoId: 'v1', data: { outcome: 'ok' } },
    });
    const response = await fakeBrowser.runtime.sendMessage({ type: 'videoChanged', videoId: 'v2' });
    expect(response).toBeUndefined();
    await flushPendingWrites();

    const events = await getRecentEvents();
    const forwarded = events.find((e) => e.name === 'transcript.attempt');
    expect(forwarded).toMatchObject({ component: 'content', videoId: 'v1', data: { outcome: 'ok' } });
    expect(events.some((e) => e.name === 'videoChanged')).toBe(false);
  });
});
