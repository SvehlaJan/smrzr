// Background service worker. Design §3: minimal — open the side panel on toolbar click and
// receive log events forwarded from the YouTube tab.
//
// MV3 gotcha: Chrome kills this worker after ~30 s of inactivity and restarts it on the next
// event. Keep it stateless — anything that must survive goes to chrome.storage or IndexedDB —
// and register every listener synchronously at the top level of `main`, otherwise events that
// woke the worker up can be missed.
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { isTabToExtension } from '../src/messaging';
import { getSettings, watchSettings } from '../src/storage/settings';
import { createLogger, handleForwardedLog, initTelemetry } from '../src/telemetry';

export default defineBackground(() => {
  const log = createLogger('background');

  // Clicking the toolbar icon opens the side panel. `sidePanel` exists only in Chrome (and
  // Chromium browsers); the call is persisted by Chrome, but repeating it on every start is harmless.
  // `Promise.resolve().then(...)` turns a synchronous throw (API missing) into a rejection too.
  Promise.resolve()
    .then(() => browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }))
    .catch((err: unknown) => log.error(err, { where: 'sidePanel.setPanelBehavior' }));

  // Telemetry starts disabled until settings are read (the read is async), then follows the
  // "Send errors to Sentry" setting live.
  getSettings()
    .then((s) => initTelemetry({ component: 'background', enabled: s.sentryEnabled }))
    .catch((err: unknown) => {
      initTelemetry({ component: 'background', enabled: false });
      log.error(err, { where: 'getSettings' });
    });
  watchSettings((s) => initTelemetry({ component: 'background', enabled: s.sentryEnabled }));

  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (isTabToExtension(msg) && msg.type === 'log') {
      void handleForwardedLog(msg.event);
    }
    // Returning undefined (not `true`, not a Promise) tells Chrome we won't respond, so other
    // listeners — e.g. the side panel listening for `videoChanged` — can.
    return undefined;
  });
});
