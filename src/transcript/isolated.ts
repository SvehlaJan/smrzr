// Logic of the isolated-world content script (entrypoints/youtube.content.ts), separated from
// the WXT/chrome wiring so it can be unit-tested.

import { isTranscriptResponse, isVideoContextResponse } from '../messageGuards';
import type { PanelToTab, SeekResponse, TranscriptResponse, VideoContextResponse } from '../messaging';
import { BRIDGE_TIMEOUTS, type BridgeClient } from './bridge';
import { errorDetail } from './chain';
import { logTranscriptResult, type SafeLogger } from './logging';
import { watchVideoIdFromUrl } from './playerResponse';

export function isPanelToTab(msg: unknown): msg is PanelToTab {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; videoId?: unknown; sec?: unknown };
  return (
    m.type === 'getVideoContext' ||
    (m.type === 'getTranscript' && typeof m.videoId === 'string') ||
    (m.type === 'seek' && typeof m.sec === 'number' && Number.isFinite(m.sec))
  );
}

export interface TabHandlerDeps {
  bridge: BridgeClient;
  doc: Document;
  /** Current page URL (a function because YouTube changes it without reloading). */
  href: () => string;
  log: SafeLogger;
}

export type TabResponse = VideoContextResponse | TranscriptResponse | SeekResponse;

/** What the bridge sent when it doesn't have the expected shape (MAIN-world messages can be forged). */
const MALFORMED = 'malformed response from the page script';

/**
 * A well-formed failure answer for `msg`, used whenever handling it went wrong. The panel must
 * always get a response of the right shape, never `undefined`.
 */
export function failureResponse(msg: PanelToTab, err: unknown): TabResponse {
  const detail = errorDetail(err);
  switch (msg.type) {
    case 'getVideoContext':
      return { ok: false, error: 'error', detail };
    case 'getTranscript':
      return { ok: false, error: 'all_strategies_failed', attempts: [{ strategy: 'player', outcome: 'error', ms: 0, detail }] };
    case 'seek':
      return { ok: false };
  }
}

export function createTabMessageHandler(deps: TabHandlerDeps): (msg: PanelToTab) => Promise<TabResponse> {
  const { bridge, doc, href, log } = deps;

  async function getVideoContext(): Promise<VideoContextResponse> {
    if (!watchVideoIdFromUrl(href())) return { ok: false, error: 'not_a_video_page' };
    try {
      const res: unknown = await bridge.request({ type: 'getVideoContext' });
      if (isVideoContextResponse(res)) return res;
      log.event('bridge.failed', { request: 'getVideoContext', detail: MALFORMED }, { level: 'warn' });
      return { ok: false, error: 'error', detail: MALFORMED };
    } catch (err) {
      log.event('bridge.failed', { request: 'getVideoContext', detail: errorDetail(err) }, { level: 'warn' });
      // Usually: MAIN script not answering yet (page still loading). The panel can retry.
      return { ok: false, error: 'player_not_ready', detail: errorDetail(err) };
    }
  }

  async function getTranscript(videoId: string): Promise<TranscriptResponse> {
    const started = Date.now();
    let res: TranscriptResponse;
    const failed = (detail: string): TranscriptResponse => ({
      ok: false,
      error: 'all_strategies_failed',
      attempts: [{ strategy: 'player', outcome: 'error', ms: Date.now() - started, detail }],
    });
    try {
      const answer: unknown = await bridge.request({ type: 'getTranscript', videoId }, BRIDGE_TIMEOUTS.getTranscript);
      res = isTranscriptResponse(answer) ? answer : failed(MALFORMED);
    } catch (err) {
      res = failed(errorDetail(err));
    }
    logTranscriptResult(log, videoId, res);
    return res;
  }

  function seek(sec: number): SeekResponse {
    const video = doc.querySelector('video');
    if (!video) return { ok: false };
    video.currentTime = Math.max(0, sec);
    return { ok: true };
  }

  // Never rejects: any unexpected failure still produces a well-formed answer.
  return async (msg) => {
    try {
      switch (msg.type) {
        case 'getVideoContext':
          return await getVideoContext();
        case 'getTranscript':
          return await getTranscript(msg.videoId);
        case 'seek':
          return seek(msg.sec);
      }
    } catch (err) {
      log.error(err, { where: 'content.handleMessage', type: msg.type });
      return failureResponse(msg, err);
    }
  };
}

/**
 * Reports the current video id whenever it changes (null when not on a watch page).
 * YouTube fires several navigation events per page change, so repeats are dropped.
 */
export function createVideoChangeNotifier(
  href: () => string,
  send: (videoId: string | null) => void,
): () => void {
  let last: string | null | undefined = undefined; // undefined = nothing sent yet
  return () => {
    const current = watchVideoIdFromUrl(href());
    if (current === last) return;
    last = current;
    send(current);
  };
}
