// Shape checks for responses that come from the YouTube tab (see messaging.ts).
//
// Part of what the tab answers comes from the page's MAIN world over window.postMessage, and any
// script on the page can forge those messages. So both the isolated content script (before
// passing a bridge answer on) and the side panel (before using it) check the shape: a malformed
// or missing response must become a handled error, never a TypeError deep inside the UI.
//
// Kept in its own file without browser APIs, so it can be used (and tested) anywhere.

import type { TranscriptError, TranscriptResponse, VideoContextResponse } from './messaging';
import type { TranscriptOutcome, TranscriptStrategy, VideoMeta } from './types';

// `Record<Union, true>` makes TypeScript complain here if a union member is added or removed.
const CONTEXT_ERRORS: Record<Extract<VideoContextResponse, { ok: false }>['error'], true> = {
  not_a_video_page: true,
  player_not_ready: true,
  error: true,
};
const TRANSCRIPT_ERRORS: Record<TranscriptError, true> = {
  no_captions: true,
  no_english_track: true,
  live: true,
  all_strategies_failed: true,
};
const STRATEGIES: Record<TranscriptStrategy, true> = { player: true, panel: true, dom: true, gemini: true };
const OUTCOMES: Record<TranscriptOutcome, true> = {
  ok: true,
  empty_200: true,
  http_error: true,
  no_tracks: true,
  no_english_track: true,
  timeout: true,
  parse_error: true,
  error: true,
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOptionalString = (v: unknown) => v === undefined || isString(v);
const isOneOf = (set: Record<string, true>, v: unknown) => isString(v) && Object.hasOwn(set, v);
const isArrayOf = (v: unknown, check: (item: unknown) => boolean) => Array.isArray(v) && v.every(check);

export function isVideoMeta(v: unknown): v is VideoMeta {
  return (
    isObject(v) &&
    isString(v.videoId) &&
    isString(v.title) &&
    isString(v.channel) &&
    isNumber(v.durationSec) &&
    isArrayOf(v.chapters, (c) => isObject(c) && isString(c.title) && isNumber(c.startSec)) &&
    typeof v.isLive === 'boolean' &&
    isArrayOf(
      v.captionTracks,
      (t) => isObject(t) && isString(t.baseUrl) && isString(t.languageCode) && (t.kind === 'manual' || t.kind === 'asr') && isString(t.name),
    )
  );
}

export function isVideoContextResponse(v: unknown): v is VideoContextResponse {
  if (!isObject(v)) return false;
  if (v.ok === true) return isVideoMeta(v.meta);
  return v.ok === false && isOneOf(CONTEXT_ERRORS, v.error) && isOptionalString(v.detail);
}

function isAttempt(v: unknown): boolean {
  return (
    isObject(v) &&
    isOneOf(STRATEGIES, v.strategy) &&
    isOneOf(OUTCOMES, v.outcome) &&
    isNumber(v.ms) &&
    isOptionalString(v.detail) &&
    (v.segmentCount === undefined || isNumber(v.segmentCount))
  );
}

function isTranscript(v: unknown): boolean {
  return (
    isObject(v) &&
    isString(v.videoId) &&
    isString(v.language) &&
    (v.kind === 'manual' || v.kind === 'asr') &&
    isOneOf(STRATEGIES, v.source) &&
    isArrayOf(v.segments, (s) => isObject(s) && isNumber(s.start) && isNumber(s.dur) && isString(s.text))
  );
}

export function isTranscriptResponse(v: unknown): v is TranscriptResponse {
  if (!isObject(v) || !isArrayOf(v.attempts, isAttempt)) return false;
  if (v.ok === true) return isTranscript(v.transcript);
  return v.ok === false && isOneOf(TRANSCRIPT_ERRORS, v.error);
}
