// Isolated-world content script for youtube.com (see docs/DESIGN.md §3).
//
// "Isolated world" = runs in the YouTube tab with access to the page's DOM and to chrome.* messaging,
// but NOT to YouTube's JS variables. Jobs:
//   - answer the side panel's requests (video context, transcript, seek); data comes from the
//     MAIN-world script (youtube-main.content.ts) over the postMessage bridge;
//   - tell the extension when the video changes (YouTube navigates without reloading the page);
//   - forward MAIN-world log events to the extension's event log.
// No Sentry here (design §8.3): events only go out via messaging.

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { sendToExtension } from '../src/messaging';
import { createBridgeClient } from '../src/transcript/bridge';
import { createTabMessageHandler, createVideoChangeNotifier, failureResponse, isPanelToTab } from '../src/transcript/isolated';
import { createSafeLogger } from '../src/transcript/logging';

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const log = createSafeLogger('content');
    const bridge = createBridgeClient(window);
    ctx.onInvalidated(() => bridge.dispose());

    // MAIN world can't use chrome.* messaging, so its log events come through us.
    bridge.onLog((event) => sendToExtension({ type: 'log', event }));

    // ---- requests from the side panel ----
    const handle = createTabMessageHandler({ bridge, doc: document, href: () => location.href, log });

    // Note on the listener's shape: `wxt/browser` (WXT 0.21) is plain `chrome`, not the
    // webextension-polyfill, so returning a Promise from this listener is NOT reliably supported
    // in Chrome. Instead we use the classic pattern: call `sendResponse` later and `return true`
    // to keep the channel open. Messages that aren't ours return undefined so other listeners can answer.
    const onMessage = (msg: unknown, _sender: unknown, sendResponse: (response?: unknown) => void): true | undefined => {
      if (!isPanelToTab(msg)) return undefined;
      // `handle` never rejects; the second callback is a backstop so the panel always gets a
      // well-formed answer (never `undefined`).
      handle(msg).then(sendResponse, (err: unknown) => {
        log.error(err, { where: 'content.onMessage', type: msg.type });
        sendResponse(failureResponse(msg, err));
      });
      return true;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));

    // ---- video changes ----
    // YouTube is a single-page app: clicking another video swaps content without a page load.
    // 'yt-navigate-finish' is YouTube's own "navigation done" event; 'popstate' covers back/forward;
    // WXT's 'wxt:locationchange' (URL polling) is a backstop. Duplicates are filtered by the notifier.
    const notifyVideoChange = createVideoChangeNotifier(
      () => location.href,
      (videoId) => {
        log.event('nav.video_changed', {}, { level: 'debug', ...(videoId ? { videoId } : {}) });
        sendToExtension({ type: 'videoChanged', videoId });
      },
    );
    ctx.addEventListener(document, 'yt-navigate-finish', () => notifyVideoChange());
    ctx.addEventListener(window, 'popstate', () => notifyVideoChange());
    ctx.addEventListener(window, 'wxt:locationchange', () => notifyVideoChange());
    notifyVideoChange(); // initial page load
  },
});
