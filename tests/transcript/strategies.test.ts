// Browser-dependent strategies, exercised with happy-dom's document and fake fetch/capture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptionTrackInfo } from '../../src/types';
import type { CapturedUrl, TimedtextCapture } from '../../src/transcript/capture';
import { NavigationDataCache, readInnertubeConfig, readPlayerResponse, readWatchData } from '../../src/transcript/pageData';
import { createDomStrategy } from '../../src/transcript/strategies/dom';
import { createPanelStrategy } from '../../src/transcript/strategies/panel';
import { createPlayerStrategy } from '../../src/transcript/strategies/player';
import { getTranscriptResponse, json3Manual, makePlayerResponse, makeWatchData } from './fixtures';

const TRACK: CaptionTrackInfo = {
  baseUrl: 'https://www.youtube.com/api/timedtext?v=vid&lang=en&signature=S',
  languageCode: 'en',
  kind: 'manual',
  name: 'English',
};
const CTX = { videoId: 'vid', track: TRACK };

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function fakeCapture(latest?: CapturedUrl, next?: CapturedUrl): TimedtextCapture {
  return {
    latest: () => latest,
    waitForNext: async () => next,
    originalFetch: (() => {
      throw new Error('should use injected fetchFn');
    }) as unknown as typeof fetch,
    uninstall: () => {},
  };
}

function captured(url: string): CapturedUrl {
  return { url, videoId: 'vid', hasPot: url.includes('pot='), ts: 0 };
}

/** fetch fake: routes by a predicate on the URL. */
function fakeFetch(route: (url: URL, init?: RequestInit) => Response) {
  return vi.fn(async (input: string, init?: RequestInit) => route(new URL(input), init));
}

const json3Body = () => new Response(JSON.stringify(json3Manual), { status: 200 });
const empty200 = () => new Response('', { status: 200 });

describe('player strategy', () => {
  it('uses the captured URL (json3, pot kept) first', async () => {
    const fetchFn = fakeFetch((u) => (u.searchParams.get('pot') === 'TOK' && u.searchParams.get('fmt') === 'json3' ? json3Body() : empty200()));
    const s = createPlayerStrategy({ win: window, capture: fakeCapture(captured('https://www.youtube.com/api/timedtext?v=vid&lang=en&pot=TOK&fmt=srv3')), fetchFn });
    const res = await s.run(CTX);
    expect(res).toMatchObject({ ok: true, detail: 'captured' });
    expect(res.ok && res.segments).toHaveLength(4);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('adapts a captured URL for another track (drops tlang, sets lang)', async () => {
    const fetchFn = fakeFetch(() => json3Body());
    const s = createPlayerStrategy({ win: window, capture: fakeCapture(captured('https://www.youtube.com/api/timedtext?v=vid&lang=cs&tlang=de&pot=TOK')), fetchFn });
    await s.run(CTX);
    const u = new URL(fetchFn.mock.calls[0]![0]);
    expect(u.searchParams.get('lang')).toBe('en');
    expect(u.searchParams.has('tlang')).toBe(false);
    expect(u.searchParams.get('pot')).toBe('TOK');
  });

  it('falls back to baseUrl when nothing was captured', async () => {
    const fetchFn = fakeFetch((u) => (u.searchParams.get('signature') === 'S' ? json3Body() : empty200()));
    const s = createPlayerStrategy({ win: window, capture: fakeCapture(), fetchFn });
    await expect(s.run(CTX)).resolves.toMatchObject({ ok: true, detail: 'baseUrl' });
  });

  it('empty 200 everywhere → empty_200 failure with each step in detail', async () => {
    const fetchFn = fakeFetch(() => empty200());
    const s = createPlayerStrategy({ win: window, capture: fakeCapture(captured('https://www.youtube.com/api/timedtext?v=vid&lang=en&pot=TOK')), fetchFn });
    const res = await s.run(CTX);
    expect(res).toMatchObject({ ok: false, outcome: 'empty_200' });
    expect(!res.ok && res.detail).toBe('captured: empty_200; baseUrl: empty_200; triggered: no player API');
  });

  it('reports HTTP errors and unparseable bodies', async () => {
    const fetchFn = fakeFetch((u) => (u.searchParams.has('pot') ? new Response('nope', { status: 403 }) : new Response('<html>', { status: 200 })));
    const s = createPlayerStrategy({ win: window, capture: fakeCapture(captured('https://www.youtube.com/api/timedtext?v=vid&lang=en&pot=TOK')), fetchFn });
    const res = await s.run(CTX);
    expect(!res.ok && res.detail).toBe('captured: http_error (HTTP 403); baseUrl: 0 segments; triggered: no player API');
  });

  it('triggers the player captions, uses the fresh capture, and restores captions off', async () => {
    const player = document.createElement('div') as HTMLDivElement & Record<string, unknown>;
    player.id = 'movie_player';
    const setOption = vi.fn();
    const unloadModule = vi.fn();
    Object.assign(player, { getOption: () => ({}), setOption, loadModule: vi.fn(), unloadModule });
    document.body.append(player);

    const fetchFn = fakeFetch((u) => (u.searchParams.get('pot') === 'FRESH' ? json3Body() : empty200()));
    const s = createPlayerStrategy({
      win: window,
      capture: fakeCapture(undefined, captured('https://www.youtube.com/api/timedtext?v=vid&lang=en&pot=FRESH')),
      fetchFn,
    });
    await expect(s.run(CTX)).resolves.toMatchObject({ ok: true, detail: 'triggered' });
    expect(setOption).toHaveBeenNthCalledWith(1, 'captions', 'track', { languageCode: 'en' });
    expect(setOption).toHaveBeenNthCalledWith(2, 'captions', 'track', {});
    expect(unloadModule).toHaveBeenCalledWith('captions');
  });

  it('restores the previously selected caption track', async () => {
    const player = document.createElement('div') as HTMLDivElement & Record<string, unknown>;
    player.id = 'movie_player';
    const prev = { languageCode: 'de', displayName: 'German' };
    const setOption = vi.fn();
    Object.assign(player, { getOption: () => prev, setOption, loadModule: vi.fn() });
    document.body.append(player);
    const s = createPlayerStrategy({ win: window, capture: fakeCapture(), fetchFn: fakeFetch(() => empty200()), triggerWaitMs: 10 });
    const res = await s.run(CTX);
    expect(!res.ok && res.detail).toContain('triggered: nothing captured in 10ms');
    expect(setOption).toHaveBeenLastCalledWith('captions', 'track', prev);
  });
});

describe('page data readers', () => {
  it('prefers the live player API and rejects stale ytInitialPlayerResponse', () => {
    const win = { document, ytInitialPlayerResponse: makePlayerResponse({ videoId: 'old' }) } as unknown as Window;
    expect(readPlayerResponse(win, 'new')).toBeNull();
    const player = Object.assign(document.createElement('div'), { id: 'movie_player', getPlayerResponse: () => makePlayerResponse({ videoId: 'new' }) });
    document.body.append(player);
    expect(readPlayerResponse(win, 'new')).toMatchObject({ videoDetails: { videoId: 'new' } });
    expect(readPlayerResponse(win, 'old')).toMatchObject({ videoDetails: { videoId: 'old' } });
  });

  it('uses data recorded from yt-navigate-finish', () => {
    const nav = new NavigationDataCache();
    nav.record({ pageType: 'watch', response: { response: makeWatchData({ videoId: 'navvid' }), playerResponse: makePlayerResponse({ videoId: 'navvid' }) } });
    nav.record({ garbage: true });
    const win = { document, ytInitialData: makeWatchData({ videoId: 'old' }) } as unknown as Window;
    expect(readWatchData(win, 'navvid', nav)).toMatchObject({ currentVideoEndpoint: { watchEndpoint: { videoId: 'navvid' } } });
    expect(readPlayerResponse(win, 'navvid', nav)).not.toBeNull();
    expect(readWatchData(win, 'other', nav)).toBeNull();
  });

  it('reads innertube config from ytcfg.get or ytcfg.data_', () => {
    const context = { client: { clientName: 'WEB', clientVersion: '2.2026' } };
    const viaGet = { ytcfg: { get: (k: string) => ({ INNERTUBE_CONTEXT: context, INNERTUBE_CONTEXT_CLIENT_NAME: 1 })[k] } } as unknown as Window;
    expect(readInnertubeConfig(viaGet)).toEqual({ context, clientName: '1', clientVersion: '2.2026' });
    const viaData = { ytcfg: { data_: { INNERTUBE_CONTEXT: context, INNERTUBE_CONTEXT_CLIENT_VERSION: '9' } } } as unknown as Window;
    expect(readInnertubeConfig(viaData)).toMatchObject({ clientVersion: '9' });
    expect(readInnertubeConfig({} as Window)).toBeNull();
  });
});

describe('panel strategy', () => {
  const context = { client: { clientName: 'WEB', clientVersion: '2.2026' } };
  function panelWin(watchData: unknown) {
    return {
      document,
      location: { origin: 'https://www.youtube.com' },
      ytInitialData: watchData,
      ytcfg: { get: (k: string) => ({ INNERTUBE_CONTEXT: context, INNERTUBE_CONTEXT_CLIENT_NAME: 1, INNERTUBE_CONTEXT_CLIENT_VERSION: '2.2026' })[k] },
    } as unknown as Window;
  }

  it('POSTs get_transcript with context + params and parses segments', async () => {
    const fetchFn = fakeFetch(() => new Response(JSON.stringify(getTranscriptResponse), { status: 200 }));
    const s = createPanelStrategy({ win: panelWin(makeWatchData({ videoId: 'vid' })), fetchFn });
    const res = await s.run(CTX);
    expect(res.ok && res.segments).toHaveLength(3);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': '2.2026' });
    expect(JSON.parse(init!.body as string)).toEqual({ context, params: 'CgtkUXc0dzlXZ1hjURISQ2dOaGMzSVNBbVZ1R2dBJTNE' });
  });

  it('fails cleanly on stale page data, missing params, HTTP errors, empty 200, and bad JSON', async () => {
    const ok = () => new Response(JSON.stringify(getTranscriptResponse));
    const run = (watch: unknown, res: () => Response) => createPanelStrategy({ win: panelWin(watch), fetchFn: fakeFetch(res) }).run(CTX);
    await expect(run(makeWatchData({ videoId: 'other' }), ok)).resolves.toMatchObject({ ok: false, outcome: 'error', detail: 'no watch-page data for this video' });
    await expect(run(makeWatchData({ videoId: 'vid', withTranscriptPanel: false }), ok)).resolves.toMatchObject({ ok: false, outcome: 'error' });
    await expect(run(makeWatchData({ videoId: 'vid' }), () => new Response('', { status: 400 }))).resolves.toMatchObject({ ok: false, outcome: 'http_error', detail: 'HTTP 400' });
    await expect(run(makeWatchData({ videoId: 'vid' }), () => new Response(''))).resolves.toMatchObject({ ok: false, outcome: 'empty_200' });
    await expect(run(makeWatchData({ videoId: 'vid' }), () => new Response('{oops'))).resolves.toMatchObject({ ok: false, outcome: 'parse_error' });
    await expect(run(makeWatchData({ videoId: 'vid' }), () => new Response('{"actions":[]}'))).resolves.toMatchObject({ ok: false, outcome: 'parse_error' });
  });

  it('classifies network errors', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const res = await createPanelStrategy({ win: panelWin(makeWatchData({ videoId: 'vid' })), fetchFn }).run(CTX);
    expect(res).toMatchObject({ ok: false, outcome: 'error', detail: 'TypeError: Failed to fetch' });
  });
});

describe('dom strategy', () => {
  const PANEL = 'ytd-engagement-panel-section-list-renderer';

  function addPanel(visibility: string): HTMLElement {
    const panel = document.createElement(PANEL);
    panel.setAttribute('target-id', 'engagement-panel-searchable-transcript');
    panel.setAttribute('visibility', visibility);
    document.body.append(panel);
    return panel;
  }

  function addSegments(panel: HTMLElement, rows: [string, string][], tag = 'ytd-transcript-segment-renderer') {
    for (const [time, text] of rows) {
      const el = document.createElement(tag);
      if (tag === 'ytd-transcript-segment-renderer') {
        el.innerHTML = `<div class="segment"><div class="segment-start-offset"><div class="segment-timestamp">\n ${time} \n</div></div><yt-formatted-string class="segment-text">${text}</yt-formatted-string></div>`;
      } else {
        // Unknown newer structure: only leaf text is used.
        el.innerHTML = `<div><span>${time}</span></div><div><span>${text}</span></div>`;
      }
      panel.append(el);
    }
  }

  it('clicks "Show transcript", reads rows, and restores the hidden panel', async () => {
    const panel = addPanel('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    const section = document.createElement('ytd-video-description-transcript-section-renderer');
    const button = document.createElement('button');
    button.addEventListener('click', () => {
      panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
      setTimeout(() => addSegments(panel, [['0:00', 'Intro'], ['0:04', 'hello'], ['1:02:03', 'late']]), 20);
    });
    section.append(button);
    document.body.append(section);

    const res = await createDomStrategy({ doc: document, waitMs: 1000, pollMs: 10 }).run(CTX);
    expect(res).toEqual({
      ok: true,
      segments: [
        { start: 0, dur: 4, text: 'Intro' },
        { start: 4, dur: 3719, text: 'hello' },
        { start: 3723, dur: 3, text: 'late' },
      ],
    });
    expect(panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  });

  it('opens the panel via its visibility attribute when there is no button, and reads newer row elements', async () => {
    const panel = addPanel('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    const observer = new MutationObserver(() => {
      if (panel.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' && panel.children.length === 0) {
        addSegments(panel, [['0:00', 'a'], ['0:10', 'b']], 'transcript-segment-view-model');
      }
    });
    observer.observe(panel, { attributes: true });
    const res = await createDomStrategy({ doc: document, waitMs: 1000, pollMs: 10 }).run(CTX);
    observer.disconnect();
    expect(res.ok && res.segments.map((s) => s.text)).toEqual(['a', 'b']);
    expect(panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  });

  it('reads an already open panel without touching it', async () => {
    const panel = addPanel('ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    addSegments(panel, [['0:00', 'x'], ['0:01', 'y']]);
    const res = await createDomStrategy({ doc: document, waitMs: 100, pollMs: 10 }).run(CTX);
    expect(res.ok).toBe(true);
    expect(panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  });

  it('times out when no segments appear, and still restores the panel', async () => {
    const panel = addPanel('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    const res = await createDomStrategy({ doc: document, waitMs: 50, pollMs: 10 }).run(CTX);
    expect(res).toMatchObject({ ok: false, outcome: 'timeout' });
    expect(panel.getAttribute('visibility')).toBe('ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  });

  it('fails fast when the page has no transcript UI at all', async () => {
    const res = await createDomStrategy({ doc: document, waitMs: 50, pollMs: 10 }).run(CTX);
    expect(res).toMatchObject({ ok: false, outcome: 'error' });
  });
});
