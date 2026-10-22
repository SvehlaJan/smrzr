// Reads YouTube's own JS objects from the page. MAIN world only (the isolated content script
// can't see page variables). All shapes here are ASSUMED from past observation of youtube.com
// and need checking on real videos; every reader validates the videoId so stale data
// (YouTube is a single-page app and keeps old objects around after navigation) is never used.

import { watchDataVideoId } from './chapters';
import { asString, dig } from './json';
import { playerResponseVideoId } from './playerResponse';

/** The bits of YouTube's player element API we use. All optional: never assume they exist. */
export interface YtPlayerElement extends HTMLElement {
  getPlayerResponse?: () => unknown;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
  loadModule?: (module: string) => void;
  unloadModule?: (module: string) => void;
}

/** Page globals we read. */
interface YtWindow {
  ytInitialPlayerResponse?: unknown;
  ytInitialData?: unknown;
  ytcfg?: { get?: (key: string) => unknown; data_?: Record<string, unknown> };
}

/**
 * Fresh page data delivered with each in-app navigation.
 * YouTube fires a `yt-navigate-finish` DOM event whose `detail.response` holds
 *   { response: <"next" watch-page data, like ytInitialData>, playerResponse: <player response>, … }
 * (assumed shape). Only the MAIN world can read `detail` (objects don't cross worlds), so
 * the MAIN script records it here.
 */
export class NavigationDataCache {
  private watchData = new Map<string, unknown>();
  private playerResponses = new Map<string, unknown>();

  /** Call with the `yt-navigate-finish` event's detail. Ignores anything unexpected. */
  record(detail: unknown): void {
    const resp = dig(detail, 'response');
    const watch = dig(resp, 'response');
    const player = dig(resp, 'playerResponse');
    const wid = watch !== undefined ? watchDataVideoId(watch) : null;
    if (wid) this.put(this.watchData, wid, watch);
    const pid = player !== undefined ? playerResponseVideoId(player) : null;
    if (pid) this.put(this.playerResponses, pid, player);
  }

  getWatchData(videoId: string): unknown {
    return this.watchData.get(videoId);
  }

  getPlayerResponse(videoId: string): unknown {
    return this.playerResponses.get(videoId);
  }

  private put(map: Map<string, unknown>, key: string, value: unknown): void {
    map.delete(key);
    map.set(key, value);
    // Keep only a few entries: these objects are large.
    while (map.size > 3) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

export function getPlayerElement(doc: Document): YtPlayerElement | null {
  return doc.getElementById('movie_player') as YtPlayerElement | null;
}

/**
 * The current player response for `videoId`, or null.
 * Order: the live player API (always current after SPA navigation) → navigation cache →
 * window.ytInitialPlayerResponse (only correct on the first page load, so its videoId must match).
 */
export function readPlayerResponse(win: Window, videoId: string, nav?: NavigationDataCache): unknown {
  const candidates: (() => unknown)[] = [
    () => getPlayerElement(win.document)?.getPlayerResponse?.(),
    () => nav?.getPlayerResponse(videoId),
    () => (win as unknown as YtWindow).ytInitialPlayerResponse,
  ];
  for (const get of candidates) {
    try {
      const pr = get();
      if (pr && playerResponseVideoId(pr) === videoId) return pr;
    } catch {
      // A YouTube API that throws just means "try the next source".
    }
  }
  return null;
}

/**
 * The watch-page ("next") data for `videoId`: chapters, engagement panels (transcript params).
 * Order: navigation cache → Polymer app elements (assumed internals) → window.ytInitialData.
 */
export function readWatchData(win: Window, videoId: string, nav?: NavigationDataCache): unknown {
  const doc = win.document;
  const candidates: (() => unknown)[] = [
    () => nav?.getWatchData(videoId),
    // ytd-page-manager.getCurrentData() → { response, playerResponse, … } (assumed; Polymer internals)
    () => dig((doc.querySelector('ytd-page-manager') as unknown as { getCurrentData?: () => unknown })?.getCurrentData?.(), 'response'),
    // ytd-app.data.response (assumed; Polymer internals)
    () => dig(doc.querySelector('ytd-app'), 'data', 'response'),
    () => (win as unknown as YtWindow).ytInitialData,
  ];
  for (const get of candidates) {
    try {
      const data = get();
      if (data && watchDataVideoId(data) === videoId) return data;
    } catch {
      // try the next source
    }
  }
  return null;
}

/** Values from YouTube's `ytcfg` config store needed for innertube (youtubei/v1) API calls. */
export interface InnertubeConfig {
  context: unknown;
  clientName?: string;
  clientVersion?: string;
}

export function readInnertubeConfig(win: Window): InnertubeConfig | null {
  const ytcfg = (win as unknown as YtWindow).ytcfg;
  const get = (key: string): unknown => {
    try {
      if (typeof ytcfg?.get === 'function') return ytcfg.get(key);
    } catch {
      // fall through to data_
    }
    return ytcfg?.data_?.[key];
  };
  const context = get('INNERTUBE_CONTEXT');
  if (!context || typeof context !== 'object') return null;
  // INNERTUBE_CONTEXT_CLIENT_NAME is a number (1 = WEB); the header wants it as a string.
  const name = get('INNERTUBE_CONTEXT_CLIENT_NAME');
  return {
    context,
    clientName: typeof name === 'number' || typeof name === 'string' ? String(name) : undefined,
    clientVersion: asString(get('INNERTUBE_CONTEXT_CLIENT_VERSION')) ?? asString(dig(context, 'client', 'clientVersion')),
  };
}
