// Converts YouTube's "player response" JSON into our VideoMeta. Pure functions.
//
// The player response is the big object YouTube's video player is configured with. On a fresh
// page load it's in `window.ytInitialPlayerResponse`; after in-app (SPA) navigation the player
// keeps the current one, available via `document.getElementById('movie_player').getPlayerResponse()`.
//
// Fields we read (names stable for years; not re-verified for this build):
//   videoDetails: { videoId, title, author, lengthSeconds: "754", isLive?, isUpcoming?, isLiveContent, shortDescription }
//   captions.playerCaptionsTracklistRenderer.captionTracks[]   (see tracks.ts)
//   microformat.playerMicroformatRenderer.liveBroadcastDetails: { isLiveNow, startTimestamp, endTimestamp? }
//   playabilityStatus: { status: "OK" | "LIVE_STREAM_OFFLINE" | "UNPLAYABLE" | "LOGIN_REQUIRED" | … }

import type { VideoMeta } from '../types';
import { chaptersFromDescription, chaptersFromWatchData, watchDataVideoId } from './chapters';
import { asNumber, asString, dig } from './json';
import { parseCaptionTracks } from './tracks';

export function playerResponseVideoId(playerResponse: unknown): string | null {
  return asString(dig(playerResponse, 'videoDetails', 'videoId')) ?? null;
}

/**
 * True only for streams that are live *right now* or haven't started yet (upcoming / Premiere
 * waiting room). A finished past livestream has `isLiveContent: true` too, but it has a duration
 * and final captions, so it's a normal video for us.
 */
export function isLiveNow(playerResponse: unknown): boolean {
  const details = dig(playerResponse, 'videoDetails');
  if (dig(details, 'isLive') === true) return true;
  if (dig(details, 'isUpcoming') === true) return true;
  if (dig(playerResponse, 'microformat', 'playerMicroformatRenderer', 'liveBroadcastDetails', 'isLiveNow') === true) {
    return true;
  }
  if (asString(dig(playerResponse, 'playabilityStatus', 'status')) === 'LIVE_STREAM_OFFLINE') return true;
  // Live content without any duration: still running (or never processed). Past streams have lengthSeconds > 0.
  if (dig(details, 'isLiveContent') === true) {
    const len = asNumber(dig(details, 'lengthSeconds')) ?? 0;
    if (len <= 0) return true;
  }
  return false;
}

/**
 * Builds VideoMeta from a player response, plus (optionally) the watch-page data for chapters.
 * `watchData` is only used when it belongs to the same video (it goes stale after SPA navigation);
 * otherwise chapters come from the description.
 * Returns null when the player response has no videoDetails (player not ready / wrong page).
 */
export function toVideoMeta(
  playerResponse: unknown,
  watchData?: unknown,
  origin = 'https://www.youtube.com',
): VideoMeta | null {
  const videoId = playerResponseVideoId(playerResponse);
  if (!videoId) return null;
  const details = dig(playerResponse, 'videoDetails');
  const durationSec = asNumber(dig(details, 'lengthSeconds')) ?? 0;

  let chapters = watchData !== undefined && watchDataVideoId(watchData) === videoId ? chaptersFromWatchData(watchData) : [];
  if (chapters.length === 0) {
    const description = asString(dig(details, 'shortDescription')) ?? '';
    chapters = chaptersFromDescription(description, durationSec || undefined);
  }

  return {
    videoId,
    title: asString(dig(details, 'title')) ?? '',
    channel: asString(dig(details, 'author')) ?? '',
    durationSec,
    chapters,
    isLive: isLiveNow(playerResponse),
    captionTracks: parseCaptionTracks(playerResponse, origin),
  };
}

/** `v` of a /watch URL, or null when the URL is not a regular video page. */
export function watchVideoIdFromUrl(href: string): string | null {
  try {
    const u = new URL(href);
    if (u.pathname !== '/watch') return null;
    const v = u.searchParams.get('v');
    // YouTube video ids are 11 chars of [A-Za-z0-9_-]; be a bit lenient but reject junk.
    return v && /^[\w-]{6,20}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
