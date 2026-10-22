// Strategy 2 "panel": call the internal API behind YouTube's "Show transcript" panel, from the
// page itself (MAIN world), so the request carries youtube.com's cookies and client config.
// Endpoint, request body and response parsing live in ../panelApi.ts.

import type { StrategyResult, TranscriptStrategyImpl } from '../chain';
import { fetchText, type FetchFn } from '../http';
import { GET_TRANSCRIPT_PATH, buildGetTranscriptBody, findTranscriptParams, parseGetTranscriptResponse } from '../panelApi';
import { readInnertubeConfig, readWatchData, type NavigationDataCache } from '../pageData';

export interface PanelStrategyDeps {
  win: Window;
  nav?: NavigationDataCache;
  fetchFn: FetchFn;
  fetchTimeoutMs?: number;
}

export function createPanelStrategy(deps: PanelStrategyDeps): TranscriptStrategyImpl {
  return {
    name: 'panel',
    timeoutMs: 8_000,
    async run({ videoId }): Promise<StrategyResult> {
      const watchData = readWatchData(deps.win, videoId, deps.nav);
      if (!watchData) return { ok: false, outcome: 'error', detail: 'no watch-page data for this video' };

      const params = findTranscriptParams(watchData);
      if (!params) return { ok: false, outcome: 'error', detail: 'no getTranscriptEndpoint params in page data' };

      const cfg = readInnertubeConfig(deps.win);
      if (!cfg) return { ok: false, outcome: 'error', detail: 'ytcfg INNERTUBE_CONTEXT missing' };

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // The page's own innertube requests send these; harmless if YouTube ignores them.
      if (cfg.clientName) headers['X-Youtube-Client-Name'] = cfg.clientName;
      if (cfg.clientVersion) headers['X-Youtube-Client-Version'] = cfg.clientVersion;

      const url = new URL(GET_TRANSCRIPT_PATH, deps.win.location.origin).toString();
      const res = await fetchText(
        deps.fetchFn,
        url,
        { method: 'POST', headers, body: buildGetTranscriptBody(cfg.context, params) },
        deps.fetchTimeoutMs ?? 6_000,
      );
      if (!res.ok) return { ok: false, outcome: res.outcome, detail: res.detail };

      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        return { ok: false, outcome: 'parse_error', detail: 'get_transcript: response is not JSON' };
      }
      const segments = parseGetTranscriptResponse(json);
      if (segments.length === 0) {
        return { ok: false, outcome: 'parse_error', detail: 'get_transcript: no transcriptSegmentRenderer in response' };
      }
      return { ok: true, segments };
    },
  };
}
