// Module-shaped mocks for the panel's collaborators. Each test file wires them with e.g.
//   vi.mock('@/src/pipeline', async () => (await import('./mocks')).pipelineMock);
// and resets them in beforeEach via resetMocks().

import { vi } from 'vitest';
import type { QuickAction } from '@/src/pipeline';
import type { Logger } from '@/src/telemetry';
import type { VideoRecord } from '@/src/types';

export const TEST_PROMPT_VERSION = 3;

export const QUICK_ACTIONS_FIXTURE: QuickAction[] = [
  { id: 'fact_check', label: 'Fact-check', prompt: 'Fact-check this.' },
  { id: 'explain_simpler', label: 'Explain simpler', prompt: 'Explain it simpler.' },
];

export const loggerMock = {
  event: vi.fn(),
  error: vi.fn(),
  setTags: vi.fn(),
  recordExchange: vi.fn(),
} satisfies Logger;

export const telemetryMock = {
  createLogger: vi.fn(() => loggerMock),
  initTelemetry: vi.fn(),
  sendIssueReport: vi.fn(),
  buildDebugBundle: vi.fn(),
};

export const pipelineMock = {
  PROMPT_VERSION: TEST_PROMPT_VERSION,
  QUICK_ACTIONS: QUICK_ACTIONS_FIXTURE,
  summarize: vi.fn(),
  expandPoint: vi.fn(),
  analyzeVisuals: vi.fn(),
  sendChat: vi.fn(),
};

export const messagingMock = {
  requestVideoContext: vi.fn(),
  requestTranscript: vi.fn(),
  requestSeek: vi.fn(),
  isTabToExtension: vi.fn(() => false),
  sendToExtension: vi.fn(),
};

export const fakeClient = { generate: vi.fn(), stream: vi.fn(), listModels: vi.fn() };
export const geminiMock = { createGeminiClient: vi.fn(() => fakeClient) };

export const modelsMock = { pickDefaultModels: vi.fn(), selectableModels: vi.fn() };

export const settingsMock = {
  getSettings: vi.fn(),
  getStoredSettings: vi.fn(),
  saveSettings: vi.fn(),
  watchSettings: vi.fn(() => () => {}),
};

/** In-memory stand-in for the Dexie history (src/storage/db.ts). */
export const memoryDb = new Map<string, VideoRecord>();
export const dbMock = {
  getVideo: vi.fn(async (id: string) => structuredClone(memoryDb.get(id))),
  putVideo: vi.fn(async (r: VideoRecord) => void memoryDb.set(r.videoId, structuredClone(r))),
  updateVideo: vi.fn(async (id: string, patch: Partial<VideoRecord>) => {
    const current = memoryDb.get(id);
    if (!current) throw new Error(`no record ${id}`);
    const next = { ...current, ...structuredClone(patch) };
    memoryDb.set(id, next);
    return structuredClone(next);
  }),
  updateVideoWith: vi.fn(async (id: string, makePatch: (latest: VideoRecord) => Partial<VideoRecord>) => {
    const current = memoryDb.get(id);
    if (!current) throw new Error(`no record ${id}`);
    const next = { ...current, ...structuredClone(makePatch(structuredClone(current))) };
    memoryDb.set(id, next);
    return structuredClone(next);
  }),
  listHistory: vi.fn(),
  deleteVideo: vi.fn(),
};

/** Clears call history and restores the default implementations above. */
export function resetMocks(): void {
  vi.clearAllMocks();
  memoryDb.clear();
  telemetryMock.createLogger.mockImplementation(() => loggerMock);
  messagingMock.isTabToExtension.mockImplementation(() => false);
  messagingMock.requestSeek.mockResolvedValue({ ok: true });
  geminiMock.createGeminiClient.mockImplementation(() => fakeClient);
  settingsMock.watchSettings.mockImplementation(() => () => {});
}
