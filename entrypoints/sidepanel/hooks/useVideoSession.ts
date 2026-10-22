// Everything the video screen needs for ONE video in ONE tab: loading, summarizing, lazy
// point details, visuals and chat. The heavy lifting lives in ../session.ts (no React);
// this hook only owns state, cancellation and logging.
//
// Cancellation: each (tab, video) pair gets its own AbortController. When the active video
// changes, the controller is aborted, so in-flight Gemini requests for the previous video
// stop, and any late results are dropped because their `key` no longer matches.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getVideo, updateVideo } from '@/src/storage/db';
import type { Settings, VideoMeta, VideoRecord } from '@/src/types';
import { handleError, type UiError } from '../errors';
import { getLogger, logUiAction } from '../logger';
import {
  childAbortController,
  fetchVideoContext,
  isFreshSummary,
  metaFromRecord,
  resolveInitialStatus,
  runChat,
  runExpand,
  runSummarize,
  runVisuals,
  setupProblem,
  type SessionStatus,
} from '../session';

export interface OpState {
  loading: boolean;
  error: UiError | null;
}

export interface PointStatus {
  details?: OpState;
  visuals?: OpState;
}

/** A chat turn in progress: the user's message is shown immediately, the reply streams in. */
export interface PendingChat {
  userText: string;
  focusPointId: string | null;
  replySoFar: string;
}

interface SessionState {
  /** `${tabId}:${videoId}`, or null without a video. Async results for another key are dropped. */
  key: string | null;
  status: SessionStatus;
  meta: VideoMeta | null;
  record: VideoRecord | null;
  points: Record<string, PointStatus>;
  chat: PendingChat | null;
  chatError: UiError | null;
}

export interface VideoSession extends SessionState {
  videoId: string | null;
  summarize(): Promise<void>;
  /** Re-ask the tab for the video (after "Reload the tab" etc.). */
  reload(): void;
  /** Called each time a point is expanded; generates details only if they aren't cached. */
  expand(pointId: string): Promise<void>;
  lookAtVisuals(pointId: string): Promise<void>;
  /** Resolves true when the turn completed and was saved; false on error or Stop. */
  sendChat(text: string, focusPointId: string | null, opts?: { quickAction?: string }): Promise<boolean>;
  stopChat(): void;
}

function initialState(key: string | null): SessionState {
  return {
    key,
    status: key ? { kind: 'loading' } : { kind: 'idle' },
    meta: null,
    record: null,
    points: {},
    chat: null,
    chatError: null,
  };
}

function setOp(points: Record<string, PointStatus>, pointId: string, op: keyof PointStatus, value: OpState) {
  return { ...points, [pointId]: { ...points[pointId], [op]: value } };
}

export function useVideoSession(tabId: number | null, videoId: string | null, settings: Settings | null): VideoSession {
  const key = tabId !== null && videoId ? `${tabId}:${videoId}` : null;
  const [stored, setState] = useState<SessionState>(() => initialState(key));
  const [reloadToken, setReloadToken] = useState(0);
  // During the first render after a video change the effect hasn't reset state yet;
  // never show the previous video's data in that frame.
  const state = stored.key === key ? stored : initialState(key);

  // Refs give async callbacks the *latest* values without re-creating them (closures
  // would otherwise capture the values from the render they were created in).
  const stateRef = useRef(state);
  const settingsRef = useRef(settings);
  useEffect(() => {
    stateRef.current = state;
    settingsRef.current = settings;
  });
  const controllerRef = useRef<AbortController>(new AbortController());
  const chatControllerRef = useRef<AbortController | null>(null);
  const inflight = useRef(new Set<string>());

  /** Applies an update only if it still belongs to the current video. */
  const patch = useCallback((forKey: string | null, fn: (s: SessionState) => SessionState) => {
    setState((s) => (s.key === forKey ? fn(s) : s));
  }, []);

  // ---- load on video change -------------------------------------------------------------
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    inflight.current = new Set();
    setState(initialState(key));
    if (!key || tabId === null || !videoId) return () => controller.abort();

    const { signal } = controller;
    const logger = getLogger();
    logger.setTags({ videoId });

    (async () => {
      // Ask the tab and the history at the same time; fetchVideoContext never throws.
      const contextPromise = fetchVideoContext(tabId, videoId, { signal });
      let record: VideoRecord | null = null;
      try {
        record = (await getVideo(videoId)) ?? null;
      } catch (err) {
        handleError(err, { videoId, task: 'load' });
      }
      if (signal.aborted) return;

      if (record && isFreshSummary(record)) {
        // Show the stored summary right away; the tab's answer only adds metadata.
        const fresh = record;
        patch(key, (s) => ({ ...s, record: fresh, meta: metaFromRecord(fresh), status: { kind: 'summary' } }));
        updateVideo(videoId, { lastOpenedAt: Date.now() }).catch((err) => handleError(err, { videoId, task: 'touch' }));
      }

      const context = await contextPromise;
      if (signal.aborted) return;
      const { status, meta } = resolveInitialStatus(record, context);
      // Keep a record the user may already have changed (e.g. expanded a point) meanwhile.
      patch(key, (s) => ({ ...s, record: s.record ?? record, meta: meta ?? s.meta, status }));
    })();

    return () => controller.abort();
  }, [key, reloadToken]); // tabId/videoId are encoded in `key`

  // ---- summarize ------------------------------------------------------------------------
  const summarize = useCallback(async () => {
    const s = stateRef.current;
    const current = settingsRef.current;
    if (!s.key || tabId === null || !s.meta || !current || setupProblem(current, 'summary')) return;
    if (inflight.current.has('summary')) return;
    inflight.current.add('summary');

    const forKey = s.key;
    const vid = s.meta.videoId;
    logUiAction('summarize', {}, vid);
    patch(forKey, (x) => ({ ...x, status: { kind: 'working', step: 'transcript' } }));
    try {
      const out = await runSummarize({
        tabId,
        meta: s.meta,
        settings: current,
        logger: getLogger(),
        signal: controllerRef.current.signal,
        existing: s.record,
        onStep: (step) => patch(forKey, (x) => ({ ...x, status: { kind: 'working', step } })),
      });
      patch(forKey, (x) =>
        out.ok
          ? { ...x, record: out.record, status: { kind: 'summary' }, points: {}, chatError: null }
          : { ...x, status: { kind: 'transcript_failed', failure: out.failure } },
      );
    } catch (err) {
      const ui = handleError(err, { videoId: vid, task: 'summary' });
      patch(forKey, (x) => ({ ...x, status: ui ? { kind: 'error', error: ui } : { kind: 'ready', stale: !!x.record?.summary } }));
    } finally {
      inflight.current.delete('summary');
    }
  }, [tabId, patch]);

  // ---- point details & visuals ------------------------------------------------------------
  /** Shared plumbing for the two per-point operations (details / visuals). */
  const runPointOp = useCallback(
    async (pointId: string, op: keyof PointStatus, run: (record: VideoRecord, meta: VideoMeta, settings: Settings) => Promise<VideoRecord>) => {
      const s = stateRef.current;
      const current = settingsRef.current;
      const record = s.record;
      if (!s.key || !record) return;
      const flightKey = `${op}:${pointId}`;
      if (inflight.current.has(flightKey)) return;

      const forKey = s.key;
      const problem = setupProblem(current, op);
      if (problem || !current) {
        patch(forKey, (x) => ({ ...x, points: setOp(x.points, pointId, op, { loading: false, error: { message: problem ?? '', settings: true } }) }));
        return;
      }

      inflight.current.add(flightKey);
      patch(forKey, (x) => ({ ...x, points: setOp(x.points, pointId, op, { loading: true, error: null }) }));
      try {
        const updated = await run(record, s.meta ?? metaFromRecord(record), current);
        patch(forKey, (x) => ({ ...x, record: updated, points: setOp(x.points, pointId, op, { loading: false, error: null }) }));
      } catch (err) {
        const ui = handleError(err, { videoId: record.videoId, task: op });
        patch(forKey, (x) => ({ ...x, points: setOp(x.points, pointId, op, { loading: false, error: ui }) }));
      } finally {
        inflight.current.delete(flightKey);
      }
    },
    [patch],
  );

  const expand = useCallback(
    async (pointId: string) => {
      const record = stateRef.current.record;
      if (!record) return;
      const cached = !!record.details[pointId];
      logUiAction('expand', { pointId, cached }, record.videoId);
      if (cached) return; // free: already generated and stored
      await runPointOp(pointId, 'details', async (rec, meta, current) => {
        const res = await runExpand({ record: rec, meta, settings: current, logger: getLogger(), signal: controllerRef.current.signal, pointId });
        return res.record;
      });
    },
    [runPointOp],
  );

  const lookAtVisuals = useCallback(
    async (pointId: string) => {
      const record = stateRef.current.record;
      if (!record) return;
      logUiAction('visuals', { pointId }, record.videoId);
      await runPointOp(pointId, 'visuals', (rec, meta, current) =>
        runVisuals({ record: rec, meta, settings: current, logger: getLogger(), signal: controllerRef.current.signal, pointId }),
      );
    },
    [runPointOp],
  );

  // ---- chat -------------------------------------------------------------------------------
  const sendChat = useCallback(
    async (text: string, focusPointId: string | null, opts?: { quickAction?: string }): Promise<boolean> => {
      const s = stateRef.current;
      const current = settingsRef.current;
      const record = s.record;
      const userText = text.trim();
      if (!s.key || !record || !userText || s.chat || chatControllerRef.current) return false;

      const forKey = s.key;
      const problem = setupProblem(current, 'chat');
      if (problem || !current) {
        patch(forKey, (x) => ({ ...x, chatError: { message: problem ?? '', settings: true } }));
        return false;
      }

      logUiAction('chat', { focusPointId, quickAction: opts?.quickAction ?? null, chars: userText.length }, record.videoId);
      const controller = childAbortController(controllerRef.current.signal);
      chatControllerRef.current = controller;
      patch(forKey, (x) => ({ ...x, chatError: null, chat: { userText, focusPointId, replySoFar: '' } }));
      try {
        const updated = await runChat({
          record,
          meta: s.meta ?? metaFromRecord(record),
          settings: current,
          logger: getLogger(),
          signal: controller.signal,
          userText,
          focusPointId,
          onDelta: (textSoFar) => patch(forKey, (x) => (x.chat ? { ...x, chat: { ...x.chat, replySoFar: textSoFar } } : x)),
        });
        patch(forKey, (x) => ({ ...x, record: updated, chat: null }));
        return true;
      } catch (err) {
        const ui = handleError(err, { videoId: record.videoId, task: 'chat' });
        patch(forKey, (x) => ({ ...x, chat: null, chatError: ui }));
        return false;
      } finally {
        if (chatControllerRef.current === controller) chatControllerRef.current = null;
      }
    },
    [patch],
  );

  const stopChat = useCallback(() => chatControllerRef.current?.abort(), []);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return { ...state, videoId, summarize, reload, expand, lookAtVisuals, sendChat, stopChat };
}
