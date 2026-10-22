// Everything about YouTube's internal "transcript panel" API (strategy 2) in one small file,
// so when YouTube changes it, only this file needs updating. Pure functions.
//
// How YouTube's own "Show transcript" button works (as last known, NOT verified for this build):
//   1. The watch-page data (ytInitialData / "next" response) contains an engagement panel with
//        engagementPanelSectionListRenderer.targetId (or .panelIdentifier) == "engagement-panel-searchable-transcript"
//      whose content is
//        { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: "<base64 protobuf>" } } } }
//   2. Opening the panel POSTs { context: <INNERTUBE_CONTEXT>, params } to /youtubei/v1/get_transcript.
//   3. The response contains, deeply nested, items like
//        { transcriptSegmentRenderer: { startMs: "1200", endMs: "4600", snippet: { runs: [{ text: "hello" }] } } }
//
// YouTube may move this to a newer endpoint (e.g. a generic "get_panel"); if so, update the
// constants and the finder here. The finders search recursively so moderate nesting changes don't matter.

import type { TranscriptSegment } from '../types';
import { asArray, asNumber, asString, dig, findAllByKey, isObject, ytText } from './json';
import { normalizeText } from './text';

export const GET_TRANSCRIPT_PATH = '/youtubei/v1/get_transcript?prettyPrint=false';
export const TRANSCRIPT_PANEL_ID = 'engagement-panel-searchable-transcript';

/** Finds the opaque `params` string for get_transcript in the watch-page data. */
export function findTranscriptParams(watchData: unknown): string | null {
  // Preferred: the documented-by-observation path.
  for (const panel of asArray(dig(watchData, 'engagementPanels'))) {
    const r = dig(panel, 'engagementPanelSectionListRenderer');
    const id = asString(dig(r, 'targetId')) ?? asString(dig(r, 'panelIdentifier'));
    if (id !== TRANSCRIPT_PANEL_ID) continue;
    const params = asString(
      dig(r, 'content', 'continuationItemRenderer', 'continuationEndpoint', 'getTranscriptEndpoint', 'params'),
    );
    if (params) return params;
    // Nesting changed? Search inside this panel only.
    const anywhere = findAllByKey(r, 'getTranscriptEndpoint').map((e) => asString(dig(e, 'params')));
    const first = anywhere.find((p): p is string => !!p);
    if (first) return first;
  }
  // Last resort: any getTranscriptEndpoint anywhere in the page data.
  const any = findAllByKey(watchData, 'getTranscriptEndpoint').map((e) => asString(dig(e, 'params')));
  return any.find((p): p is string => !!p) ?? null;
}

export function buildGetTranscriptBody(innertubeContext: unknown, params: string): string {
  return JSON.stringify({ context: innertubeContext, params });
}

/**
 * Extracts segments from a get_transcript response, wherever they're nested.
 * Accepts `snippet.runs` and `snippet.simpleText`. Segments are sorted by start time.
 */
export function parseGetTranscriptResponse(json: unknown): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const r of findAllByKey(json, 'transcriptSegmentRenderer')) {
    if (!isObject(r)) continue;
    const startMs = asNumber(r['startMs']);
    if (startMs === undefined) continue;
    const endMs = asNumber(r['endMs']);
    const text = normalizeText(ytText(r['snippet']) ?? '');
    if (!text) continue;
    segments.push({
      start: startMs / 1000,
      dur: endMs !== undefined && endMs > startMs ? (endMs - startMs) / 1000 : 0,
      text,
    });
  }
  segments.sort((a, b) => a.start - b.start);
  return segments;
}
