import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { LlmError } from '@/src/llm/client';
import type { TranscriptAttempt } from '@/src/types';
import { useActiveVideo } from '@/entrypoints/sidepanel/hooks/useActiveVideo';
import { useVideoSession } from '@/entrypoints/sidepanel/hooks/useVideoSession';
import {
  fetchVideoContext,
  resolveInitialStatus,
  runChat,
  runExpand,
  runSummarize,
  runVisuals,
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
      meta: META, // the exact meta the summary prompt was built from
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

  it('turns a malformed transcript answer into a handled failure', async () => {
    for (const forged of [undefined, { ok: true, attempts: [] }, { ok: true, attempts: [], transcript: { segments: [{ start: 'x' }] } }]) {
      messagingMock.requestTranscript.mockResolvedValue(forged);
      const out = await runSummarize({ ...base, tabId: TAB_ID, meta: META, existing: null });
      expect(out).toMatchObject({ ok: false, failure: { ok: false, error: 'all_strategies_failed', attempts: [{ outcome: 'error' }] } });
    }
    expect(pipelineMock.summarize).not.toHaveBeenCalled();
  });

  it('stops before the paid summary call when cancelled while the transcript was loading', async () => {
    const controller = new AbortController();
    messagingMock.requestTranscript.mockImplementation(async () => {
      controller.abort();
      return { ok: true, transcript: TRANSCRIPT, attempts: [] };
    });
    await expect(runSummarize({ ...base, signal: controller.signal, tabId: TAB_ID, meta: META, existing: null })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(pipelineMock.summarize).not.toHaveBeenCalled();
    expect(dbMock.putVideo).not.toHaveBeenCalled();
  });

  it('surfaces transcript failures with their attempts and spends nothing', async () => {
    messagingMock.requestTranscript.mockResolvedValue({ ok: false, error: 'all_strategies_failed', attempts: ATTEMPTS });
    const out = await runSummarize({ ...base, tabId: TAB_ID, meta: META, existing: null });
    expect(out).toEqual({ ok: false, failure: { ok: false, error: 'all_strategies_failed', attempts: ATTEMPTS } });
    expect(pipelineMock.summarize).not.toHaveBeenCalled();
    expect(dbMock.putVideo).not.toHaveBeenCalled();
    // The content script already logged transcript.failed with the attempts; no duplicate here.
    expect(loggerMock.event.mock.calls.some(([name]) => name === 'transcript.failed')).toBe(false);
  });

  it('maps transcript errors to messages', () => {
    expect(transcriptFailureMessage({ ok: false, error: 'no_english_track', attempts: [] })).toBe('Only English videos are supported for now.');
    expect(transcriptFailureMessage({ ok: false, error: 'no_captions', attempts: [] })).toBe(
      "This video has no captions, so smrzr can't summarize it yet.",
    );
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
    // The patch is computed inside the storage transaction (no separate read before it).
    expect(dbMock.updateVideoWith).toHaveBeenCalledWith(VIDEO_ID, expect.any(Function));
    expect(dbMock.getVideo).not.toHaveBeenCalled();
  });
});

describe('prompt meta for later calls (cache prefix)', () => {
  // The tab now reports chapters that weren't there at summarize time; the stored meta must win.
  const STORED_META = { ...META, chapters: [] };
  const LIVE_META = { ...META, chapters: [{ title: 'Intro', startSec: 0 }] };

  it('details, visuals and chat use the meta stored at summarize time', async () => {
    const record = makeRecord({ meta: STORED_META });
    memoryDb.set(VIDEO_ID, record);
    pipelineMock.expandPoint.mockResolvedValue({ details: { subpoints: [], context: '' }, usage: usage(0) });
    pipelineMock.analyzeVisuals.mockResolvedValue({ text: 'v', usage: usage(0) });
    pipelineMock.sendChat.mockResolvedValue({
      userMessage: { id: 'u', role: 'user', text: 'q', focusPointId: null, citations: [], createdAt: 1 },
      reply: { id: 'r', role: 'model', text: 'a', focusPointId: null, citations: [], createdAt: 2 },
    });

    await runExpand({ ...base, record, meta: LIVE_META, pointId: 'p1' });
    await runVisuals({ ...base, record, meta: LIVE_META, pointId: 'p1' });
    await runChat({ ...base, record, meta: LIVE_META, userText: 'q', focusPointId: null });

    expect(pipelineMock.expandPoint.mock.calls[0]?.[0].meta).toBe(STORED_META);
    expect(pipelineMock.analyzeVisuals.mock.calls[0]?.[0].meta).toBe(STORED_META);
    expect(pipelineMock.sendChat.mock.calls[0]?.[0].meta).toBe(STORED_META);
  });

  it('falls back to the given meta for old records without a stored one', async () => {
    const record = makeRecord();
    memoryDb.set(VIDEO_ID, record);
    pipelineMock.expandPoint.mockResolvedValue({ details: { subpoints: [], context: '' }, usage: usage(0) });
    await runExpand({ ...base, record, meta: LIVE_META, pointId: 'p1' });
    expect(pipelineMock.expandPoint.mock.calls[0]?.[0].meta).toBe(LIVE_META);
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
    const isTabLoading = vi.fn(async () => false);
    expect(await fetchVideoContext(TAB_ID, VIDEO_ID, { delayMs: 0, attempts: 2, isTabLoading })).toEqual({ ok: false, error: 'no_content_script' });
    expect(messagingMock.requestVideoContext).toHaveBeenCalledTimes(2);
    expect(isTabLoading).toHaveBeenCalledWith(TAB_ID);
  });

  it('keeps waiting for the content script while the tab is still loading', async () => {
    const noReceiver = new Error('Could not establish connection. Receiving end does not exist.');
    messagingMock.requestVideoContext
      .mockRejectedValueOnce(noReceiver)
      .mockRejectedValueOnce(noReceiver)
      .mockRejectedValueOnce(noReceiver)
      .mockRejectedValueOnce(noReceiver)
      .mockResolvedValue({ ok: true, meta: META }); // injected at document_idle
    const res = await fetchVideoContext(TAB_ID, VIDEO_ID, { delayMs: 0, attempts: 2, loadingPollMs: 0, isTabLoading: async () => true });
    expect(res).toEqual({ ok: true, meta: META });
    expect(messagingMock.requestVideoContext).toHaveBeenCalledTimes(5);
  });

  it('stops waiting once the tab finished loading, or after loadingWaitMs', async () => {
    messagingMock.requestVideoContext.mockRejectedValue(new Error('Receiving end does not exist.'));
    const loading = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const opts = { delayMs: 0, attempts: 2, loadingPollMs: 0 };
    expect(await fetchVideoContext(TAB_ID, VIDEO_ID, { ...opts, isTabLoading: loading })).toEqual({ ok: false, error: 'no_content_script' });
    expect(messagingMock.requestVideoContext).toHaveBeenCalledTimes(4); // 2 normal + 2 while loading

    messagingMock.requestVideoContext.mockClear();
    const forever = vi.fn(async () => true);
    expect(await fetchVideoContext(TAB_ID, VIDEO_ID, { ...opts, loadingWaitMs: 0, isTabLoading: forever })).toEqual({ ok: false, error: 'no_content_script' });
    expect(messagingMock.requestVideoContext).toHaveBeenCalledTimes(2);
  });

  it('turns a malformed or missing answer into a handled error instead of throwing', async () => {
    for (const forged of [undefined, null, { ok: true }, { ok: true, meta: { videoId: VIDEO_ID } }, { ok: 'yes' }]) {
      messagingMock.requestVideoContext.mockReset().mockResolvedValue(forged);
      const res = await fetchVideoContext(TAB_ID, VIDEO_ID, { delayMs: 0, attempts: 2 });
      expect(res).toMatchObject({ ok: false, error: 'error' });
      expect(resolveInitialStatus(null, res).status.kind).toBe('context_error');
    }
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

  it('Cancel while fetching the transcript goes back to Summarize and never summarizes', async () => {
    let answerTranscript: (v: unknown) => void = () => {};
    messagingMock.requestTranscript.mockImplementation(() => new Promise((resolve) => (answerTranscript = resolve)));
    render(<VideoHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('Fetching transcript…')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Summarize' })).toBeTruthy();

    // The late transcript is ignored: nothing is paid for or saved, the screen stays as it is.
    await act(async () => answerTranscript({ ok: true, transcript: TRANSCRIPT, attempts: [] }));
    expect(pipelineMock.summarize).not.toHaveBeenCalled();
    expect(dbMock.putVideo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeTruthy();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('Cancel while summarizing aborts the Gemini call, silently', async () => {
    messagingMock.requestTranscript.mockResolvedValue({ ok: true, transcript: TRANSCRIPT, attempts: [] });
    pipelineMock.summarize.mockImplementation(
      (ctx: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new LlmError('Request aborted', 'aborted')))),
    );
    render(<VideoHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('Summarizing…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Summarize' })).toBeTruthy();
    expect(pipelineMock.summarize.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('logs a failed summary exactly once, with task and videoId', async () => {
    messagingMock.requestTranscript.mockResolvedValue({ ok: true, transcript: TRANSCRIPT, attempts: [] });
    const err = new LlmError('Quota exceeded', 'quota', 429);
    pipelineMock.summarize.mockRejectedValue(err);
    render(<VideoHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('Gemini quota or billing limit reached.')).toBeTruthy();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(err, { task: 'summary', videoId: VIDEO_ID });
  });

  it('asks for an API key instead of offering Summarize', async () => {
    render(<VideoHarness settings={{ ...SETTINGS, apiKey: '' }} />);
    expect(await screen.findByText(/Add your Gemini API key/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Summarize' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy();
  });
});

describe('content script that loads after the panel asked (full page load)', () => {
  it('useActiveVideo bumps tabSignals on every videoChanged from the active tab, even for the same id', async () => {
    const tab = { id: TAB_ID, url: `https://www.youtube.com/watch?v=${VIDEO_ID}` };
    const query = vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => [tab]) as unknown as typeof fakeBrowser.tabs.query);
    onTestFinished(() => query.mockRestore());
    messagingMock.isTabToExtension.mockImplementation(() => true);
    const { result } = renderHook(() => useActiveVideo());
    await vi.waitFor(() => expect(result.current.videoId).toBe(VIDEO_ID));
    const before = result.current.tabSignals;
    const videoChanged = (tabId: number) =>
      act(async () => {
        await fakeBrowser.runtime.onMessage.trigger({ type: 'videoChanged', videoId: VIDEO_ID }, { tab: { id: tabId } } as never, () => {});
      });

    await videoChanged(tab.id);
    expect(result.current.tabSignals).toBe(before + 1);
    await videoChanged(tab.id);
    expect(result.current.tabSignals).toBe(before + 2);
    expect(result.current.videoId).toBe(VIDEO_ID);

    // Messages from other tabs don't count.
    await videoChanged(tab.id + 1);
    expect(result.current.tabSignals).toBe(before + 2);
  });

  it('useVideoSession asks the tab again when tabSignals bumps while it shows needs_reload', async () => {
    vi.useFakeTimers();
    try {
      fakeBrowser.reset(); // no such tab in the fake browser: "not loading", so no extra waiting
      messagingMock.requestVideoContext.mockRejectedValue(new Error('Receiving end does not exist.'));
      const { result, rerender } = renderHook(({ signals }) => useVideoSession(TAB_ID, VIDEO_ID, SETTINGS, signals), {
        initialProps: { signals: 0 },
      });
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(result.current.status.kind).toBe('needs_reload');

      // The content script finally started and said hello with the same video id.
      messagingMock.requestVideoContext.mockResolvedValue({ ok: true, meta: META });
      rerender({ signals: 1 });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(result.current.status).toEqual({ kind: 'ready', stale: false });
      expect(result.current.meta).toEqual(META);

      // While things are fine, further signals don't reload anything.
      const calls = messagingMock.requestVideoContext.mock.calls.length;
      rerender({ signals: 2 });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(messagingMock.requestVideoContext.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
