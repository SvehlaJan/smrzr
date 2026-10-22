// Caption track parsing and selection (design §4 "Track choice"). Pure functions.

import type { CaptionTrackInfo } from '../types';
import { asArray, asString, dig, ytText } from './json';

/**
 * Converts `captions.playerCaptionsTracklistRenderer.captionTracks` from the player response.
 * Assumed shape of one entry (stable for years, but not verified against today's YouTube):
 *   { baseUrl: "https://www.youtube.com/api/timedtext?v=…&lang=en&…", name: { simpleText: "English" } | { runs: [...] },
 *     vssId: ".en" | "a.en", languageCode: "en", kind?: "asr", isTranslatable: true }
 */
export function parseCaptionTracks(playerResponse: unknown, origin = 'https://www.youtube.com'): CaptionTrackInfo[] {
  const raw = asArray(dig(playerResponse, 'captions', 'playerCaptionsTracklistRenderer', 'captionTracks'));
  const tracks: CaptionTrackInfo[] = [];
  for (const t of raw) {
    const baseUrl = asString(dig(t, 'baseUrl'));
    const languageCode = asString(dig(t, 'languageCode'));
    if (!baseUrl || !languageCode) continue;
    let absoluteUrl: string;
    try {
      // Older responses used relative URLs ("/api/timedtext?…"); make them absolute.
      absoluteUrl = new URL(baseUrl, origin).toString();
    } catch {
      continue;
    }
    tracks.push({
      baseUrl: absoluteUrl,
      languageCode,
      kind: asString(dig(t, 'kind')) === 'asr' ? 'asr' : 'manual',
      name: ytText(dig(t, 'name')) ?? languageCode,
    });
  }
  return tracks;
}

/** "en", "en-US", "en-GB", "EN" … count as English. "eng"/"enm" do not. */
export function isEnglishCode(code: string): boolean {
  const lc = code.toLowerCase();
  return lc === 'en' || lc.startsWith('en-') || lc.startsWith('en_');
}

/** Auto-translated tracks carry a `tlang=` parameter. We never use them (design §4). */
export function isTranslatedTrack(track: CaptionTrackInfo): boolean {
  try {
    return new URL(track.baseUrl).searchParams.has('tlang');
  } catch {
    return /[?&]tlang=/.test(track.baseUrl);
  }
}

/**
 * Picks the transcript track: manual English first, then auto-generated (ASR) English.
 * Within a group, plain "en" beats regional variants ("en-US", "en-GB"), otherwise list order.
 * Returns null when there is no usable English track.
 */
export function selectEnglishTrack(tracks: CaptionTrackInfo[]): CaptionTrackInfo | null {
  const english = tracks.filter((t) => isEnglishCode(t.languageCode) && !isTranslatedTrack(t));
  const rank = (t: CaptionTrackInfo): number =>
    (t.kind === 'manual' ? 0 : 2) + (t.languageCode.toLowerCase() === 'en' ? 0 : 1);
  let best: CaptionTrackInfo | null = null;
  for (const t of english) {
    if (best === null || rank(t) < rank(best)) best = t;
  }
  return best;
}

/** Compact description for logs, e.g. "cs, de(asr)". Language codes only, no URLs. */
export function describeTracks(tracks: CaptionTrackInfo[]): string {
  if (tracks.length === 0) return 'none';
  return tracks
    .slice(0, 10)
    .map((t) => (t.kind === 'asr' ? `${t.languageCode}(asr)` : t.languageCode))
    .join(', ');
}
