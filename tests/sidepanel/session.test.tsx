import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptAttempt } from '@/src/types';
import {
  fetchVideoContext,
  resolveInitialStatus,
  runChat,
  runExpand,
  runSummarize,
  transcriptFailureMessage,
} from '@/entrypoints/sidepanel/session';
import { makeRecord, META, SETTINGS, SUMMARY, TAB_ID, TRANSCRIPT, usage, VIDEO_ID, VideoHarness } from './fixtures';
import { dbMock, fakeClient, loggerMock, memoryDb, messagingMock, pipelineMock, resetMocks, TEST_PROMPT_VERSION } from './mocks';

vi.mock('@/src/messaging', async () => (await import('./mocks')).messagingMock);
vi.mock('@/src/telemetry', async () => (await import('./mocks')).telemetryMock);
vi.mock('@/src/pipeline', async () => (await import('./mocks')).pipelineMock);
vi.mock('@/src/storage/db', async () => (await import('./mocks')).dbMock);
vi.mock('@/src/llm/gemini', async () => (await import('./mocks')).geminiMock);

beforeEach(resetMocks);
afterEach(cleanup);

const ATTEMPTS: TranscriptAttempt[] = [
  { strategy: 'player', outcome: 'empty_200', ms: 120, detail: 'HTTP 200, empty body' },
  { strategy: 'panel', outcome: 'http_error', ms: 340, detail: 'HTTP 403' },
  { strategy: 'dom', outcome: 'timeout', ms: 5000, detail: 'no segments after 5s' },
];

const base = { settings: SETTINGS, logger: loggerMock };

describe('runSummarize', () => {
  it('stores a full VideoRecord with promptVersion and cost', async () => {
    messagingMock.requestTranscript.mockResolvedValue({ ok: true, transcript: TRANSCRIPT, attempts: [] });
    pipelineMock.summarize.mockResolvedValue({ summary: SUMMARY, usage: usage(0.034), validation: { snapped: 0, hidden: 1 } });
    const signal = new AbortController().signal;
    const steps: string[] = [];

    const out = await runSummarize({ ...base, signal, tabId: TAB_ID, meta: META, existing: null, onStep: (s) => steps.push(s) });

    expect(steps).toEqual(['transcript', 'summary']);
    expect(messagingMock.requestTranscript).toHaveBeenCalledWith(TAB_ID, VIDEO_ID);
    const [ctx, model] = pipelineMock.summarize.mock.calls[0]!;
    expect(model).toBe('flash-1');
    expect(ctx).toMatchObject({ client: fakeClient, meta: META, transcript: TRANSCRIPT, signal, logger: loggerMock });

    expect(out.ok).toBe(true);
    const stored = memoryDb.get(VIDEO_ID)!;
    expect(dbMock.putVideo).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      videoId: VIDEO_ID,
      title: META.title,
      channel: META.channel,
      durationSec: META.durationSec,
      summary: SUMMARY,
      transcript: TRANSCRIPT,
      details: {},
      chat: [],
      promptVersion: TEST_PROMPT_VERSION,
    });
    expect(stored.totalCostUsd).toBeCloseTo(0.034);
    expect(stored.createdAt).toBe(stored.lastOpenedAt);
  });

  it('keeps createdAt and previous cost when replacing an outdated summary', async () => {
    messagingMock.requestTranscript.mockResolvedValue({ ok: true, transcript: TRANSCRIPT, attempts: [] });
    pipelineMock.summarize.mockResolvedValue({ summary: SUMMARY, usage: usage(null), validation: { snapped: 0, hidden: 0 } });
    const existing = makeRecord({ promptVersion: 1, totalCostUsd: 0.05, createdAt: 42 });
    const out = await runSummarize({ ...base, tabId: TAB_ID, meta: META, existing });
    expect(out.ok && out.record).toMatchObject({ createdAt: 42, totalCostUsd: 0.05, promptVersion: TEST_PROMPT_VERSION });
  });

  it('surfaces transcript failures with their attempts and spends nothing', async () => {
    messagingMock.requestTranscript.mockResolvedValue({ ok: false, error: 'all_strategies_failed', attempts: ATTEMPTS });
    const out = await runSummarize({ ...base, tabId: TAB_ID, meta: META, existing: null });
    expect(out).toEqual({ ok: false, failure: { ok: false, error: 'all_strategies_failed', attempts: ATTEMPTS } });
    expect(pipelineMock.summarize).not.toHaveBeenCalled();
    expect(dbMock.putVideo).not.toHaveBeenCalled();
  });

  it('maps transcript errors to messages', () => {
    expect(transcriptFailureMessage({ ok: false, error: 'no_english_track', attempts: [] })).toBe('Only English videos are supported for now.');
    expect(transcriptFailureMessage({ ok: false, error: 'live', attempts: [] })).toMatch(/Live streams/);
    expect(transcriptFailureMessage({ ok: false, error: 'all_strategies_failed', attempts: [] })).toBe("Couldn't get the transcript.");
  });
});

describe('runExpand / runChat persistence', () => {
  it('returns cached details without calling the model', async () => {
    const record = makeRecord({ details: { p1: { subpoints: [], context: 'x' } } });
    const out = await runExpand({ ...base, record, meta: META, pointId: 'p1' });
    expect(out.fromCache).toBe(true);
    expect(pipelineMock.expandPoint).not.toHaveBeenCalled();
  });

  it('appends both chat messages and their cost to the freshest stored record', async () => {
    const record = makeRecord();
    // Something else (e.g. an expand) saved meanwhile: the patch must build on that copy.
    memoryDb.set(VIDEO_ID, makeRecord({ details: { p2: { subpoints: [], context: 'y' } }, totalCostUsd: 0.04 }));
    pipelineMock.sendChat.mockResolvedValue({
      userMessage: { id: 'u', role: 'user', text: 'q', focusPointId: null, citations: [], createdAt: 1 },
      reply: { id: 'r', role: 'model', text: 'a', focusPointId: null, citations: [], createdAt: 2, usage: usage(0.06) },
    });
    const updated = await runChat({ ...base, record, meta: META, userText: 'q', focusPointId: null });
    expect(updated.chat.map((m) => m.id)).toEqual(['u', 'r']);
    expect(updated.details.p2).toBeDefined();
    expect(updated.totalCostUsd).toBeCloseTo(0.1);
  });
});

describe('fetchVideoContext', () => {
  it('retries while the player is not ready', async () => {
    messagingMock.requestVideoContext
      .mockResolvedValueOnce({ ok: false, error: 'player_not_ready' })
      .mockResolvedValueOnce({ ok: true, meta: { ...META, videoId: 'previousVid' } })
      .mockResolvedValueOnce({ ok: true, meta: META });
    const res = await fetchVideoContext(TAB_ID, VIDEO_ID, { delayMs: 0 });
    expect(res).toEqual({ ok: true, meta: META });
    expect(messagingMock.requestVideoContext).toHaveBeenCalledTimes(3);
  });

  it('reports a missing content script', async () => {
    messagingMock.requestVideoContext.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
    expect(await fetchVideoContext(TAB_ID, VIDEO_ID, { delayMs: 0, attempts: 2 })).toEqual({ ok: false, error: 'no_content_script' });
  });
});

describe('resolveInitialStatus', () => {
  const ok = { ok: true as const, meta: META };
  it('shows a fresh stored summary, even without the content script', () => {
    expect(resolveInitialStatus(makeRecord(), ok).status).toEqual({ kind: 'summary' });
    const offline = resolveInitialStatus(makeRecord(), { ok: false, error: 'no_content_script' });
    expect(offline.status).toEqual({ kind: 'summary' });
    expect(offline.meta?.title).toBe(META.title);
  });
  it('treats an old promptVersion as stale', () => {
    expect(resolveInitialStatus(makeRecord({ promptVersion: TEST_PROMPT_VERSION - 1 }), ok).status).toEqual({ kind: 'ready', stale: true });
  });
  it('handles live videos and missing content scripts', () => {
    expect(resolveInitialStatus(null, { ok: true, meta: { ...META, isLive: true } }).status).toEqual({ kind: 'live' });
    expect(resolveInitialStatus(null, { ok: false, error: 'no_content_script' }).status).toEqual({ kind: 'needs_reload' });
  });
});

describe('video view flow', () => {
  beforeEach(() => {
    messagingMock.requestVideoContext.mockResolvedValue({ ok: true, meta: META });
  });

  it('offers Summarize for a stale stored summary instead of showing it', async () => {
    memoryDb.set(VIDEO_ID, makeRecord({ promptVersion: TEST_PROMPT_VERSION - 1 }));
    render(<VideoHarness />);
    expect(await screen.findByRole('button', { name: 'Summarize' })).toBeTruthy();
    expect(screen.queryByText(SUMMARY.points[0]!.title)).toBeNull();
    expect(screen.getByText(/older prompts/)).toBeTruthy();
  });

  it('shows a fresh stored summary immediately and touches lastOpenedAt', async () => {
    memoryDb.set(VIDEO_ID, makeRecord());
    render(<VideoHarness />);
    expect(await screen.findByText(SUMMARY.tldr)).toBeTruthy();
    expect(dbMock.updateVideo).toHaveBeenCalledWith(VIDEO_ID, { lastOpenedAt: expect.any(Number) });
  });

  it('summarizes and renders the key points', async () => {
    messagingMock.requestTranscript.mockResolvedValue({ ok: true, transcript: TRANSCRIPT, attempts: [] });
    pipelineMock.summarize.mockResolvedValue({ summary: SUMMARY, usage: usage(0.03), validation: { snapped: 0, hidden: 0 } });
    render(<VideoHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText(SUMMARY.points[1]!.title)).toBeTruthy();
    expect(screen.getByText(SUMMARY.tldr)).toBeTruthy();
  });

  it('shows the failed transcript attempts and a report button', async () => {
    messagingMock.requestTranscript.mockResolvedValue({ ok: false, error: 'all_strategies_failed', attempts: ATTEMPTS });
    render(<VideoHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText("Couldn't get the transcript.")).toBeTruthy();
    expect(screen.getByText('What was tried (3)')).toBeTruthy();
    expect(screen.getByText('HTTP 403')).toBeTruthy();
    expect(screen.getByText('empty_200')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Report issue/ })).toBeTruthy();
  });

  it('asks for an API key instead of offering Summarize', async () => {
    render(<VideoHarness settings={{ ...SETTINGS, apiKey: '' }} />);
    expect(await screen.findByText(/Add your Gemini API key/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Summarize' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy();
  });
});
