// Typed messages between the side panel, the background worker and the YouTube tab.
//
//   side panel ──tabs.sendMessage──▶ youtube.content.ts (isolated world) ──postMessage──▶ youtube-main.content.ts (MAIN world)
//   youtube tab ──runtime.sendMessage──▶ background (logs) / side panel (videoChanged)
//
// The isolated ⇄ MAIN bridge is internal to src/transcript (see bridge.ts there).
//
// Receiving side: `wxt/browser` is plain `chrome` (not webextension-polyfill), so an onMessage
// listener must answer with `sendResponse(...)` and `return true` to respond asynchronously.
// Returning a Promise from the listener is NOT reliable in Chrome.

import { browser } from 'wxt/browser';
import type { LogEvent, Transcript, TranscriptAttempt, VideoMeta } from './types';

// ---------- side panel → YouTube tab ----------

export type PanelToTab =
  | { type: 'getVideoContext' }
  | { type: 'getTranscript'; videoId: string }
  | { type: 'seek'; sec: number };

export type VideoContextResponse =
  | { ok: true; meta: VideoMeta }
  | { ok: false; error: 'not_a_video_page' | 'player_not_ready' | 'error'; detail?: string };

export type TranscriptResponse =
  | { ok: true; transcript: Transcript; attempts: TranscriptAttempt[] }
  | { ok: false; error: TranscriptError; attempts: TranscriptAttempt[] };

/** `no_captions` = the video has no caption tracks at all; `no_english_track` = tracks exist, none in English. */
export type TranscriptError = 'no_captions' | 'no_english_track' | 'live' | 'all_strategies_failed';

export type SeekResponse = { ok: boolean };

// ---------- YouTube tab / any context → extension ----------

export type TabToExtension =
  | { type: 'videoChanged'; videoId: string | null }
  | { type: 'log'; event: LogEvent };

// ---------- helpers ----------

async function sendToTab<T>(tabId: number, msg: PanelToTab): Promise<T> {
  return (await browser.tabs.sendMessage(tabId, msg)) as T;
}

export function requestVideoContext(tabId: number): Promise<VideoContextResponse> {
  return sendToTab(tabId, { type: 'getVideoContext' });
}

export function requestTranscript(tabId: number, videoId: string): Promise<TranscriptResponse> {
  return sendToTab(tabId, { type: 'getTranscript', videoId });
}

export function requestSeek(tabId: number, sec: number): Promise<SeekResponse> {
  return sendToTab(tabId, { type: 'seek', sec });
}

/** Fire-and-forget; a missing receiver (panel closed) is not an error. */
export function sendToExtension(msg: TabToExtension): void {
  browser.runtime.sendMessage(msg).catch(() => {});
}

export function isTabToExtension(msg: unknown): msg is TabToExtension {
  return typeof msg === 'object' && msg !== null && 'type' in msg &&
    ((msg as { type: unknown }).type === 'videoChanged' || (msg as { type: unknown }).type === 'log');
}
