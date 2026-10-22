// React-free logic behind the video view: talking to the YouTube tab, running the pipeline
// and persisting results. `hooks/useVideoSession.ts` wires these into React state; keeping
// them here makes them unit-testable with plain mocks (no rendering needed).

import { requestTranscript, requestVideoContext, type TranscriptResponse, type VideoContextResponse } from '@/src/messaging';
import { createGeminiClient } from '@/src/llm/gemini';
import { analyzeVisuals, expandPoint, PROMPT_VERSION, sendChat, summarize, type PipelineContext } from '@/src/pipeline';
import type { Logger } from '@/src/telemetry';
import { getVideo, putVideo, updateVideo } from '@/src/storage/db';
import type { LlmTask, LlmUsage, Settings, Transcript, VideoMeta, VideoRecord } from '@/src/types';
import { isNoReceiverError, type UiError } from './errors';

// ---------------------------------------------------------------------------
// View state (what the video screen shows). A discriminated union: `kind` decides which
// other fields exist, similar to a sealed class / enum with associated values.
// ---------------------------------------------------------------------------

export type TranscriptFailure = Extract<TranscriptResponse, { ok: false }>;

export type SessionStatus =
  | { kind: 'idle' } // no YouTube video in the active tab
  | { kind: 'loading' }
  | { kind: 'needs_reload' } // content script not reachable: tab predates the install
  | { kind: 'context_error'; error: UiError }
  | { kind: 'live' }
  | { kind: 'ready'; stale: boolean } // show "Summarize"; stale = an old-prompt summary exists
  | { kind: 'working'; step: 'transcript' | 'summary' }
  | { kind: 'transcript_failed'; failure: TranscriptFailure }
  | { kind: 'error'; error: UiError }
  | { kind: 'summary' }; // record.summary is current and shown

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Cost of one LLM call; unknown prices count as 0. */
export function costOf(usage: LlmUsage | undefined): number {
  return usage?.estCostUsd ?? 0;
}

/** A stored summary is only reused when it was made with the current prompts. */
export function isFreshSummary(record: VideoRecord | null | undefined): boolean {
  return !!record?.summary && record.promptVersion === PROMPT_VERSION;
}

const TASK_LABEL: Record<LlmTask, string> = { summary: 'Summary', details: 'Details', visuals: 'Visuals', chat: 'Chat' };

/** Why a task can't run with these settings, or null when it can. */
export function setupProblem(settings: Settings | null, task: LlmTask): string | null {
  if (!settings?.apiKey) return 'Add your Gemini API key in Settings to get started.';
  if (!settings.models[task]) return `Choose a ${TASK_LABEL[task]} model in Settings (click “Load models”).`;
  return null;
}

/** When a stored summary is shown but the tab can't be asked for metadata, the record has enough. */
export function metaFromRecord(record: VideoRecord): VideoMeta {
  return {
    videoId: record.videoId,
    title: record.title,
    channel: record.channel,
    durationSec: record.durationSec,
    chapters: [],
    isLive: false,
    captionTracks: [],
  };
}

export function transcriptFailureMessage(failure: TranscriptFailure): string {
  switch (failure.error) {
    case 'no_english_track':
      return 'Only English videos are supported for now.';
    case 'live':
      return "Live streams aren't supported yet.";
    case 'all_strategies_failed':
      return "Couldn't get the transcript.";
  }
}

export function buildVideoRecord(args: {
  meta: VideoMeta;
  transcript: Transcript;
  summary: VideoRecord['summary'];
  usage: LlmUsage;
  existing: VideoRecord | null;
  now: number;
}): VideoRecord {
  const { meta, transcript, summary, usage, existing, now } = args;
  return {
    videoId: meta.videoId,
    title: meta.title,
    channel: meta.channel,
    durationSec: meta.durationSec,
    transcript,
    summary,
    // A new summary has new point ids, so old details/chat would point at the wrong things.
    details: {},
    chat: [],
    promptVersion: PROMPT_VERSION,
    // Money already spent on this video (e.g. an outdated summary) still counts.
    totalCostUsd: (existing?.totalCostUsd ?? 0) + costOf(usage),
    createdAt: existing?.createdAt ?? now,
    lastOpenedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Talking to the YouTube tab
// ---------------------------------------------------------------------------

export type ContextResult =
  | { ok: true; meta: VideoMeta }
  | { ok: false; error: 'no_content_script' | 'not_a_video_page' | 'player_not_ready' | 'error'; detail?: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Asks the content script for the video's metadata. YouTube is a single-page app: right after
 * a navigation the player may still describe the previous video or not be ready, so we retry
 * a few times with a growing delay. Never throws.
 */
export async function fetchVideoContext(
  tabId: number,
  videoId: string,
  opts: { signal?: AbortSignal; attempts?: number; delayMs?: number } = {},
): Promise<ContextResult> {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 500;
  let last: ContextResult = { ok: false, error: 'player_not_ready' };

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs * i, opts.signal);
    if (opts.signal?.aborted) return { ok: false, error: 'error', detail: 'aborted' };
    let res: VideoContextResponse;
    try {
      res = await requestVideoContext(tabId);
    } catch (err) {
      // No content script listening. Retry: it may be injecting right now after a page load.
      last = isNoReceiverError(err)
        ? { ok: false, error: 'no_content_script' }
        : { ok: false, error: 'error', detail: err instanceof Error ? err.message : String(err) };
      continue;
    }
    if (res.ok && res.meta.videoId === videoId) return res;
    if (res.ok) {
      last = { ok: false, error: 'player_not_ready', detail: 'player still shows the previous video' };
      continue;
    }
    last = res;
    if (res.error === 'error') return res; // a real failure; retrying won't help
  }
  return last;
}

/** Decides the first screen for a video once we know the stored record and the tab's answer. */
export function resolveInitialStatus(
  record: VideoRecord | null,
  context: ContextResult,
): { status: SessionStatus; meta: VideoMeta | null } {
  if (context.ok) {
    if (isFreshSummary(record)) return { status: { kind: 'summary' }, meta: context.meta };
    if (context.meta.isLive) return { status: { kind: 'live' }, meta: context.meta };
    return { status: { kind: 'ready', stale: !!record?.summary }, meta: context.meta };
  }
  // The tab didn't answer, but a stored summary is still perfectly readable.
  if (record && isFreshSummary(record)) return { status: { kind: 'summary' }, meta: metaFromRecord(record) };
  if (context.error === 'no_content_script') return { status: { kind: 'needs_reload' }, meta: null };
  const message =
    context.error === 'player_not_ready' || context.error === 'not_a_video_page'
      ? "The YouTube player isn't ready yet. Wait a moment and try again."
      : `Couldn't read this video's details${context.detail ? ` (${context.detail})` : ''}.`;
  return { status: { kind: 'context_error', error: { message } }, meta: null };
}

// ---------------------------------------------------------------------------
// Pipeline runs + persistence
// ---------------------------------------------------------------------------

interface RunBase {
  settings: Settings;
  logger: Logger;
  signal?: AbortSignal;
}

function pipelineContext(a: RunBase & { meta: VideoMeta; transcript: Transcript }): PipelineContext {
  return {
    client: createGeminiClient(a.settings.apiKey),
    logger: a.logger,
    meta: a.meta,
    transcript: a.transcript,
    signal: a.signal,
  };
}

/**
 * Read-modify-write with the freshest stored copy, so two operations finishing close together
 * (e.g. expanding a point while a chat reply lands) don't overwrite each other's results.
 */
async function patchRecord(
  fallback: VideoRecord,
  makePatch: (latest: VideoRecord) => Partial<Omit<VideoRecord, 'videoId'>>,
): Promise<VideoRecord> {
  const latest = (await getVideo(fallback.videoId)) ?? fallback;
  return updateVideo(fallback.videoId, makePatch(latest));
}

export type SummarizeOutcome = { ok: true; record: VideoRecord } | { ok: false; failure: TranscriptFailure };

/** Transcript → summary → saved VideoRecord. LLM/storage errors are thrown to the caller. */
export async function runSummarize(
  a: RunBase & {
    tabId: number;
    meta: VideoMeta;
    existing: VideoRecord | null;
    onStep?: (step: 'transcript' | 'summary') => void;
  },
): Promise<SummarizeOutcome> {
  a.onStep?.('transcript');
  const tr = await requestTranscript(a.tabId, a.meta.videoId);
  if (!tr.ok) {
    a.logger.event('transcript.failed', { error: tr.error, attempts: tr.attempts.length }, { level: 'warn', videoId: a.meta.videoId });
    return { ok: false, failure: tr };
  }
  a.logger.setTags({ videoId: a.meta.videoId, transcriptSource: tr.transcript.source, promptVersion: PROMPT_VERSION });

  a.onStep?.('summary');
  const ctx = pipelineContext({ ...a, transcript: tr.transcript });
  const result = await summarize(ctx, a.settings.models.summary);
  const record = buildVideoRecord({
    meta: a.meta,
    transcript: tr.transcript,
    summary: result.summary,
    usage: result.usage,
    existing: a.existing,
    now: Date.now(),
  });
  await putVideo(record);
  return { ok: true, record };
}

/** Details for one point: cached in the record after the first (paid) call. */
export async function runExpand(
  a: RunBase & { record: VideoRecord; meta: VideoMeta; pointId: string },
): Promise<{ record: VideoRecord; fromCache: boolean }> {
  if (a.record.details[a.pointId]) return { record: a.record, fromCache: true };
  const summary = a.record.summary;
  if (!summary) throw new Error('There is no summary to expand.');

  const ctx = pipelineContext({ ...a, transcript: a.record.transcript });
  const { details, usage } = await expandPoint(ctx, a.settings.models.details, summary, a.pointId);
  const record = await patchRecord(a.record, (latest) => ({
    details: { ...latest.details, [a.pointId]: { ...details, visuals: latest.details[a.pointId]?.visuals } },
    totalCostUsd: latest.totalCostUsd + costOf(usage),
  }));
  return { record, fromCache: false };
}

/** "Look at the visuals" for one point; stored as details[pointId].visuals. */
export async function runVisuals(
  a: RunBase & { record: VideoRecord; meta: VideoMeta; pointId: string },
): Promise<VideoRecord> {
  const point = a.record.summary?.points.find((p) => p.id === a.pointId);
  if (!point) throw new Error(`Unknown point ${a.pointId}.`);

  const ctx = pipelineContext({ ...a, transcript: a.record.transcript });
  const { text, usage } = await analyzeVisuals(ctx, a.settings.models.visuals, point);
  return patchRecord(a.record, (latest) => {
    const current = latest.details[a.pointId] ?? { subpoints: [], context: '' };
    return {
      details: { ...latest.details, [a.pointId]: { ...current, visuals: text } },
      totalCostUsd: latest.totalCostUsd + costOf(usage),
    };
  });
}

/** One chat turn, streamed through onDelta; both messages are saved once the reply completes. */
export async function runChat(
  a: RunBase & {
    record: VideoRecord;
    meta: VideoMeta;
    userText: string;
    focusPointId: string | null;
    onDelta?: (textSoFar: string) => void;
  },
): Promise<VideoRecord> {
  const summary = a.record.summary;
  if (!summary) throw new Error('Summarize the video before chatting about it.');

  const ctx = pipelineContext({ ...a, transcript: a.record.transcript });
  const { userMessage, reply } = await sendChat(ctx, a.settings.models.chat, {
    summary,
    history: a.record.chat,
    userText: a.userText,
    focusPointId: a.focusPointId,
    onDelta: a.onDelta,
  });
  return patchRecord(a.record, (latest) => ({
    chat: [...latest.chat, userMessage, reply],
    totalCostUsd: latest.totalCostUsd + costOf(userMessage.usage) + costOf(reply.usage),
  }));
}

/**
 * An AbortController that also aborts when `parent` aborts. Used for chat: "Stop" aborts only
 * the reply, while a video change aborts everything for the old video.
 */
export function childAbortController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) child.abort();
  else parent.addEventListener('abort', () => child.abort(), { once: true });
  return child;
}

