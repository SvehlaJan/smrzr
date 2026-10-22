// Strategy 1 "player": fetch the caption track from /api/timedtext as json3.
// MAIN world only. See capture.ts for why we capture the player's own requests.
//
// Steps, stopping at the first that yields segments:
//   1. "captured":  the player's own timedtext URL for this video (carries the pot= token).
//   2. "baseUrl":   the track's baseUrl from the player response, without a token
//                   (YouTube still answers this for some videos).
//   3. "triggered": best effort: ask the player to turn captions on for our track, wait ~3 s
//                   for the request it makes (our fetch/XHR patch captures it), restore the
//                   viewer's caption setting, then use the freshly captured URL.

import type { CaptionTrackInfo, TranscriptOutcome } from '../../types';
import { asString, dig } from '../json';
import type { StrategyResult, TranscriptStrategyImpl } from '../chain';
import type { CapturedUrl, TimedtextCapture } from '../capture';
import { fetchText, type FetchFn } from '../http';
import { getPlayerElement, type YtPlayerElement } from '../pageData';
import { buildJson3Url, parseTimedtextBody, timedtextTrackParams } from '../timedtext';

export interface PlayerStrategyDeps {
  win: Window;
  capture: TimedtextCapture;
  /** Defaults to capture.originalFetch (so our own requests aren't captured). */
  fetchFn?: FetchFn;
  fetchTimeoutMs?: number;
  triggerWaitMs?: number;
}

/** Does a captured URL request the same track we want (and not an auto-translation)? */
function capturedMatchesTrack(url: string, track: CaptionTrackInfo): boolean {
  const p = timedtextTrackParams(url);
  if (p.tlang) return false;
  if ((p.lang ?? '').toLowerCase() !== track.languageCode.toLowerCase()) return false;
  return (p.kind === 'asr') === (track.kind === 'asr');
}

/**
 * URL for a captured request, switched to our track if the player had loaded a different one.
 * Assumption (unverified): the pot token is bound to the video/session, not to the language,
 * so changing lang/kind and dropping tlang keeps it valid.
 */
function urlForCaptured(captured: CapturedUrl, track: CaptionTrackInfo): string {
  return capturedMatchesTrack(captured.url, track)
    ? buildJson3Url(captured.url)
    : buildJson3Url(captured.url, { track: { languageCode: track.languageCode, kind: track.kind } });
}

/**
 * Asks the player to load captions for `track` so it issues its own (token-carrying) request,
 * then puts the viewer's caption setting back.
 *
 * BEST EFFORT: `loadModule` / `getOption` / `setOption` on #movie_player are YouTube's internal
 * player API (used by many extensions, but undocumented). If they're missing or behave
 * differently, nothing is captured and the step simply fails; it can never break playback beyond
 * captions briefly flashing on.
 */
async function triggerPlayerCaptions(
  player: YtPlayerElement,
  track: CaptionTrackInfo,
  capture: TimedtextCapture,
  videoId: string,
  waitMs: number,
): Promise<CapturedUrl | undefined> {
  let previous: unknown;
  try {
    previous = player.getOption?.('captions', 'track');
  } catch {
    previous = undefined;
  }
  const next = capture.waitForNext(videoId, waitMs);
  try {
    player.loadModule?.('captions');
    player.setOption?.('captions', 'track', {
      languageCode: track.languageCode,
      ...(track.kind === 'asr' ? { kind: 'asr' } : {}),
    });
  } catch {
    // ignore: we'll just not capture anything
  }
  const captured = await next;
  try {
    if (asString(dig(previous, 'languageCode'))) {
      // Captions were on (some track): switch back to it.
      player.setOption?.('captions', 'track', previous);
    } else {
      // Captions were off: turn them off again.
      player.setOption?.('captions', 'track', {});
      player.unloadModule?.('captions');
    }
  } catch {
    // ignore
  }
  return captured;
}

export function createPlayerStrategy(deps: PlayerStrategyDeps): TranscriptStrategyImpl {
  const fetchFn: FetchFn = deps.fetchFn ?? ((input, init) => deps.capture.originalFetch(input, init));
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? 4_000;
  const triggerWaitMs = deps.triggerWaitMs ?? 3_000;

  return {
    name: 'player',
    timeoutMs: 15_000,
    async run({ videoId, track }): Promise<StrategyResult> {
      const steps: string[] = [];
      // Outcome of the last failed step; reported as the strategy's outcome (all steps go into `detail`).
      let lastOutcome: Exclude<TranscriptOutcome, 'ok'> = 'error';

      const tryUrl = async (label: string, url: string): Promise<StrategyResult | null> => {
        const res = await fetchText(fetchFn, url, {}, fetchTimeoutMs);
        if (!res.ok) {
          steps.push(`${label}: ${res.outcome}${res.outcome === 'http_error' ? ` (${res.detail})` : ''}`);
          lastOutcome = res.outcome;
          return null;
        }
        try {
          const segments = parseTimedtextBody(res.body);
          if (segments.length > 0) return { ok: true, segments, detail: label };
          steps.push(`${label}: 0 segments`);
          lastOutcome = 'parse_error';
        } catch {
          steps.push(`${label}: parse_error`);
          lastOutcome = 'parse_error';
        }
        return null;
      };

      // 1. The player's own captured request.
      const captured = deps.capture.latest(videoId);
      if (captured) {
        const ok = await tryUrl(captured.hasPot ? 'captured' : 'captured(no pot)', urlForCaptured(captured, track));
        if (ok) return ok;
      } else {
        steps.push('captured: none');
      }

      // 2. The track's baseUrl, no token.
      const fromBase = await tryUrl('baseUrl', buildJson3Url(track.baseUrl));
      if (fromBase) return fromBase;

      // 3. Make the player request captions, then use what it requested.
      const player = getPlayerElement(deps.win.document);
      if (player?.setOption) {
        const fresh = await triggerPlayerCaptions(player, track, deps.capture, videoId, triggerWaitMs);
        if (fresh) {
          const ok = await tryUrl('triggered', urlForCaptured(fresh, track));
          if (ok) return ok;
        } else {
          steps.push(`triggered: nothing captured in ${triggerWaitMs}ms`);
        }
      } else {
        steps.push('triggered: no player API');
      }

      return { ok: false, outcome: lastOutcome, detail: steps.join('; ') };
    },
  };
}
