// MAIN-world script: runs inside YouTube's own page context (see docs/DESIGN.md §3, §4).
//
// "MAIN world" means this script shares JS globals with YouTube's code, so it can read the
// player's data and its requests look like the player's own. The flip side: no chrome.* APIs
// here, and nothing secret may ever live here (any page script could read it). It talks to the
// isolated content script (youtube.content.ts) only via window.postMessage (src/transcript/bridge.ts).
//
// runAt 'document_start' is essential: the fetch/XHR capture must be installed before YouTube's
// player scripts start, or we'd miss the player's caption requests.

import { defineContentScript } from 'wxt/utils/define-content-script';
import { startMainWorld } from '../src/transcript/mainWorld';

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    try {
      startMainWorld(window);
    } catch {
      // Never let our script break YouTube. (Failures show up later as bridge timeouts in the log.)
    }
  },
});
