// Shared data fixtures + a harness that renders the real VideoView driven by the real
// useVideoSession hook (collaborators are mocked by the importing test file).

import type { LlmUsage, Settings, Summary, Transcript, VideoMeta, VideoRecord } from '@/src/types';
import { PanelProvider } from '@/entrypoints/sidepanel/components/PanelContext';
import { useVideoSession } from '@/entrypoints/sidepanel/hooks/useVideoSession';
import { VideoView } from '@/entrypoints/sidepanel/views/VideoView';
import { TEST_PROMPT_VERSION } from './mocks';

export const VIDEO_ID = 'abcdefghijk';
export const TAB_ID = 7;

export const SETTINGS: Settings = {
  apiKey: 'test-key',
  models: { summary: 'flash-1', details: 'flash-1', visuals: 'flash-1', chat: 'pro-1' },
  sentryEnabled: false,
};

export const META: VideoMeta = {
  videoId: VIDEO_ID,
  title: 'Sleep, caffeine & light',
  channel: 'Sleep Pod',
  durationSec: 9667,
  chapters: [],
  isLive: false,
  captionTracks: [],
};

export const TRANSCRIPT: Transcript = {
  videoId: VIDEO_ID,
  language: 'en',
  kind: 'manual',
  source: 'player',
  segments: [{ start: 0, dur: 5, text: 'hello' }],
};

export const SUMMARY: Summary = {
  tldr: 'Sleep debt is only partly repaid on weekends.',
  points: [
    { id: 'p1', title: 'Weekend catch-up sleep fixes alertness', gist: 'Reaction time recovered.', startSec: 724, endSec: 900 },
    { id: 'p2', title: 'Delay caffeine', gist: 'Wait ~90 min.', startSec: null, endSec: null },
  ],
};

export function usage(estCostUsd: number | null): LlmUsage {
  return { model: 'flash-1', inputTokens: 1000, outputTokens: 100, cachedTokens: 0, estCostUsd };
}

export function makeRecord(overrides: Partial<VideoRecord> = {}): VideoRecord {
  return {
    videoId: VIDEO_ID,
    title: META.title,
    channel: META.channel,
    durationSec: META.durationSec,
    transcript: TRANSCRIPT,
    summary: SUMMARY,
    details: {},
    chat: [],
    promptVersion: TEST_PROMPT_VERSION,
    totalCostUsd: 0.03,
    createdAt: 1,
    lastOpenedAt: 1,
    ...overrides,
  };
}

export function VideoHarness({ settings = SETTINGS }: { settings?: Settings }) {
  const session = useVideoSession(TAB_ID, VIDEO_ID, settings);
  return (
    <PanelProvider tabId={TAB_ID} videoId={VIDEO_ID} onOpenReport={() => {}}>
      <VideoView session={session} settings={settings} onOpenSettings={() => {}} onOpenHistory={() => {}} />
    </PanelProvider>
  );
}
