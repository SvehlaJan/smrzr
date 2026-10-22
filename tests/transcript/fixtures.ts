// Hand-built fixtures that mimic YouTube's JSON shapes as last known.
// NOT recorded from live YouTube (the dev sandbox can't reach it). When real payloads are
// captured (design §9 "recorded fixtures"), add them next to these and keep both.

// ---------- /api/timedtext?fmt=json3 ----------

/** Manual (human) captions: one event per caption line. First event is a window-setup event without segs. */
export const json3Manual = {
  wireMagic: 'pb3',
  pens: [{}],
  wsWinStyles: [{}],
  wpWinPositions: [{}],
  events: [
    { tStartMs: 0, dDurationMs: 245000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
    { tStartMs: 1200, dDurationMs: 3400, wWinId: 1, segs: [{ utf8: 'So the study took\nhealthy young adults' }] },
    { tStartMs: 4600, dDurationMs: 2800, wWinId: 1, segs: [{ utf8: '[Music]' }] },
    { tStartMs: 7400, dDurationMs: 3100, wWinId: 1, segs: [{ utf8: '  and restricted them to   five hours. ' }] },
    { tStartMs: 10500, dDurationMs: 1000, wWinId: 1, segs: [{ utf8: '   ' }] },
    { tStartMs: 11500, wWinId: 1, segs: [{ utf8: 'Tom & Jerry' }] },
  ],
};

/** Auto-generated (ASR) captions: word-level segs with tOffsetMs, plus "\n" append events. */
export const json3Asr = {
  wireMagic: 'pb3',
  events: [
    { tStartMs: 0, dDurationMs: 600000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
    { tStartMs: 0, dDurationMs: 600000, id: 2, wpWinPosId: 2, wsWinStyleId: 1 },
    {
      tStartMs: 160,
      dDurationMs: 4320,
      wWinId: 1,
      segs: [{ utf8: 'so' }, { utf8: ' the', tOffsetMs: 240 }, { utf8: ' study', tOffsetMs: 480, acAsrConf: 0 }],
    },
    { tStartMs: 2550, dDurationMs: 1930, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    {
      tStartMs: 2560,
      dDurationMs: 4000,
      wWinId: 1,
      segs: [{ utf8: 'took' }, { utf8: ' healthy', tOffsetMs: 320 }, { utf8: ' young', tOffsetMs: 640 }],
    },
  ],
};

// ---------- /api/timedtext legacy XML (no fmt) and srv3 ----------

export const legacyXml = `<?xml version="1.0" encoding="utf-8" ?><transcript>
<text start="0.5" dur="2.1">Hello &amp;#39;world&amp;#39;</text>
<text start="2.6" dur="3">Fish &amp;amp; chips &lt;3</text>
<text start="5.6" dur="1.5"></text>
<text start="7.1" dur="2.4">line one
line two&#x2014;done</text>
</transcript>`;

export const srv3Xml = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body>
<p t="1200" d="3400">Hello <s t="200">big</s> world</p>
<p t="4600" d="1000"></p>
<p t="5600" d="2000">it&#39;s fine</p>
</body></timedtext>`;

// ---------- /youtubei/v1/get_transcript ----------

function seg(startMs: number, endMs: number, text: string, useRuns = true) {
  return {
    transcriptSegmentRenderer: {
      startMs: String(startMs),
      endMs: String(endMs),
      snippet: useRuns ? { runs: [{ text }] } : { simpleText: text },
      startTimeText: { simpleText: '0:00' },
      trackingParams: 'CAEQ',
      accessibility: { accessibilityData: { label: '0 seconds ...' } },
      targetId: 'abc',
    },
  };
}

/** Assumed nesting as last seen: actions → updateEngagementPanelAction → … → initialSegments. */
export const getTranscriptResponse = {
  responseContext: { serviceTrackingParams: [] },
  actions: [
    {
      clickTrackingParams: 'CAAQ',
      updateEngagementPanelAction: {
        targetId: 'engagement-panel-searchable-transcript',
        content: {
          transcriptRenderer: {
            trackingParams: 'CAAQ',
            content: {
              transcriptSearchPanelRenderer: {
                header: { transcriptSearchBoxRenderer: {} },
                body: {
                  transcriptSegmentListRenderer: {
                    initialSegments: [
                      { transcriptSectionHeaderRenderer: { startMs: '0', endMs: '60000', sectionHeader: {} } },
                      seg(0, 3200, 'Welcome back to the show.'),
                      seg(3200, 7000, ''),
                      seg(7000, 12500, 'Today: sleep and caffeine.', false),
                      {
                        transcriptSegmentRenderer: {
                          startMs: '12500',
                          endMs: '15000',
                          snippet: { runs: [{ text: 'Multi ' }, { text: 'run\n' }, { text: 'text' }] },
                        },
                      },
                    ],
                    noResultLabel: { runs: [{ text: 'No results found' }] },
                  },
                },
                footer: { transcriptFooterRenderer: { languageMenu: {} } },
              },
            },
          },
        },
      },
    },
  ],
};

// ---------- player response ----------

export interface PlayerResponseOpts {
  videoId?: string;
  title?: string;
  author?: string;
  lengthSeconds?: string;
  isLive?: boolean;
  isUpcoming?: boolean;
  isLiveContent?: boolean;
  isLiveNow?: boolean;
  playability?: string;
  shortDescription?: string;
  captionTracks?: unknown[] | null;
}

export function captionTrack(languageCode: string, opts: { asr?: boolean; name?: unknown; translated?: boolean; vid?: string } = {}) {
  const vid = opts.vid ?? 'dQw4w9WgXcQ';
  const kind = opts.asr ? '&kind=asr' : '';
  const tlang = opts.translated ? '&tlang=en' : '';
  return {
    baseUrl: `https://www.youtube.com/api/timedtext?v=${vid}&ei=abc&caps=asr&opi=112496729&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=1761200000&sparams=ip,ipbits,expire,v,ei,caps,opi,xoaf&signature=ABC.DEF&key=yt8${kind}&lang=${languageCode}${tlang}`,
    name: opts.name ?? { simpleText: opts.asr ? `${languageCode} (auto-generated)` : languageCode },
    vssId: `${opts.asr ? 'a' : ''}.${languageCode}`,
    languageCode,
    ...(opts.asr ? { kind: 'asr' } : {}),
    isTranslatable: true,
    trackName: '',
  };
}

export function makePlayerResponse(o: PlayerResponseOpts = {}) {
  const videoId = o.videoId ?? 'dQw4w9WgXcQ';
  const tracks = o.captionTracks === undefined ? [captionTrack('en', { vid: videoId })] : o.captionTracks;
  return {
    responseContext: {},
    playabilityStatus: { status: o.playability ?? 'OK', playableInEmbed: true },
    streamingData: {},
    ...(tracks === null
      ? {}
      : {
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: tracks,
              audioTracks: [{ captionTrackIndices: [0], defaultCaptionTrackIndex: 0 }],
              translationLanguages: [{ languageCode: 'de', languageName: { simpleText: 'German' } }],
              defaultAudioTrackIndex: 0,
            },
          },
        }),
    videoDetails: {
      videoId,
      title: o.title ?? 'Sleep, caffeine & light — Episode 142',
      lengthSeconds: o.lengthSeconds ?? '9667',
      keywords: ['sleep'],
      channelId: 'UC123',
      isOwnerViewing: false,
      shortDescription: o.shortDescription ?? 'A podcast about sleep.',
      isCrawlable: true,
      thumbnail: { thumbnails: [] },
      allowRatings: true,
      viewCount: '12345',
      author: o.author ?? 'The Sleep Podcast',
      isPrivate: false,
      isUnpluggedCorpus: false,
      isLiveContent: o.isLiveContent ?? false,
      ...(o.isLive !== undefined ? { isLive: o.isLive } : {}),
      ...(o.isUpcoming !== undefined ? { isUpcoming: o.isUpcoming } : {}),
    },
    microformat: {
      playerMicroformatRenderer: {
        lengthSeconds: o.lengthSeconds ?? '9667',
        ...(o.isLiveNow !== undefined
          ? { liveBroadcastDetails: { isLiveNow: o.isLiveNow, startTimestamp: '2026-10-01T10:00:00+00:00' } }
          : {}),
      },
    },
  };
}

// ---------- watch page data (ytInitialData) ----------

function chapter(title: string, ms: number) {
  return {
    chapterRenderer: {
      title: { simpleText: title },
      timeRangeStartMillis: ms,
      onActiveCommand: {},
      thumbnail: { thumbnails: [] },
    },
  };
}

export function makeWatchData(opts: { videoId?: string; withChapters?: boolean; autoOnly?: boolean; withTranscriptPanel?: boolean } = {}) {
  const videoId = opts.videoId ?? 'dQw4w9WgXcQ';
  const markersMap: unknown[] = [];
  if (opts.withChapters !== false) {
    markersMap.push({
      key: 'AUTO_CHAPTERS',
      value: { chapters: [chapter('Auto one', 0), chapter('Auto two', 50_000), chapter('Auto three', 90_000)] },
    });
    if (!opts.autoOnly) {
      markersMap.push({
        key: 'DESCRIPTION_CHAPTERS',
        value: {
          chapters: [chapter('Intro', 0), chapter('Weekend catch-up sleep', 724_000), chapter('Caffeine', 1_540_400)],
        },
      });
    }
  }
  return {
    responseContext: {},
    contents: { twoColumnWatchNextResults: {} },
    currentVideoEndpoint: { clickTrackingParams: 'x', watchEndpoint: { videoId } },
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: { multiMarkersPlayerBarRenderer: { visibleOnLoad: { key: 'DESCRIPTION_CHAPTERS' }, markersMap } },
          },
        },
      },
    },
    engagementPanels:
      opts.withTranscriptPanel === false
        ? [{ engagementPanelSectionListRenderer: { panelIdentifier: 'engagement-panel-structured-description' } }]
        : [
            { engagementPanelSectionListRenderer: { panelIdentifier: 'engagement-panel-structured-description' } },
            {
              engagementPanelSectionListRenderer: {
                panelIdentifier: 'engagement-panel-searchable-transcript',
                targetId: 'engagement-panel-searchable-transcript',
                visibility: 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN',
                content: {
                  continuationItemRenderer: {
                    trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
                    continuationEndpoint: {
                      clickTrackingParams: 'y',
                      commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/get_transcript' } },
                      getTranscriptEndpoint: { params: 'CgtkUXc0dzlXZ1hjURISQ2dOaGMzSVNBbVZ1R2dBJTNE' },
                    },
                  },
                },
              },
            },
          ],
  };
}
