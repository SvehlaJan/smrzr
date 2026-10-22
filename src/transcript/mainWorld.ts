// Everything the MAIN-world script does, wired together. Kept out of the entrypoint file so the
// entrypoint stays a two-liner and this can be read top to bottom.
//
// Runs at document_start in YouTube's page context:
//   1. installs the fetch/XHR capture (must happen before YouTube's player scripts load),
//   2. records fresh page data on every in-app navigation,
//   3. answers the isolated content script's bridge requests (video context, transcript).

import type { TranscriptResponse, VideoContextResponse } from '../messaging';
import type { VideoMeta } from '../types';
import { createBridgeServer, type BridgeServer } from './bridge';
import { installTimedtextCapture } from './capture';
import { runTranscriptChain } from './chain';
import { NavigationDataCache, readPlayerResponse, readWatchData } from './pageData';
import { toVideoMeta, watchVideoIdFromUrl } from './playerResponse';
import { createDomStrategy } from './strategies/dom';
import { createPanelStrategy } from './strategies/panel';
import { createPlayerStrategy } from './strategies/player';

export function startMainWorld(win: Window & typeof globalThis): { stop(): void } {
  let server: BridgeServer | null = null;

  // 1. Capture the player's own caption requests. Logged at debug level: "did the player ever
  //    request captions, and did the request carry a token?" is the key question when strategy 1 fails.
  const capture = installTimedtextCapture(win, (c) => {
    server?.log('transcript.captured', { hasPot: c.hasPot }, { level: 'debug', videoId: c.videoId });
  });

  // 2. YouTube fires `yt-navigate-finish` on the document after each in-app navigation.
  const nav = new NavigationDataCache();
  const onNavigateFinish = (e: Event): void => {
    try {
      nav.record((e as CustomEvent).detail);
    } catch {
      // never break the page
    }
  };
  win.document.addEventListener('yt-navigate-finish', onNavigateFinish);

  const readMeta = (videoId: string): VideoMeta | null => {
    const playerResponse = readPlayerResponse(win, videoId, nav);
    if (!playerResponse) return null;
    const watchData = readWatchData(win, videoId, nav);
    return toVideoMeta(playerResponse, watchData ?? undefined, win.location.origin);
  };

  // Our own requests go through the *unpatched* fetch so they aren't mistaken for the player's.
  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => capture.originalFetch(input, init);
  const strategies = [
    createPlayerStrategy({ win, capture, fetchFn }),
    createPanelStrategy({ win, nav, fetchFn }),
    createDomStrategy({ doc: win.document }),
  ];

  // 3. Answer bridge requests.
  server = createBridgeServer(win, {
    async getVideoContext(): Promise<VideoContextResponse> {
      const videoId = watchVideoIdFromUrl(win.location.href);
      if (!videoId) return { ok: false, error: 'not_a_video_page' };
      const meta = readMeta(videoId);
      if (!meta) return { ok: false, error: 'player_not_ready', detail: 'no player response for this video yet' };
      return { ok: true, meta };
    },
    async getTranscript(videoId: string): Promise<TranscriptResponse> {
      const meta = readMeta(videoId);
      if (!meta) {
        return {
          ok: false,
          error: 'all_strategies_failed',
          attempts: [{ strategy: 'player', outcome: 'error', ms: 0, detail: 'no player response for this video' }],
        };
      }
      return runTranscriptChain({ meta, strategies });
    },
  });

  return {
    stop() {
      server?.dispose();
      win.document.removeEventListener('yt-navigate-finish', onNavigateFinish);
      capture.uninstall();
    },
  };
}
