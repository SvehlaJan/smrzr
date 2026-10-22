// Summary / details / visuals / chat orchestration: design §5.
//
// Files in this folder:
//   compact.ts    transcript → ~20–30 s timestamped lines (§5.1)
//   prompts.ts    all prompt text + response schemas; the shared cacheable prefix (§5.2)
//   timestamps.ts validation/snapping of model timestamps (§5.2)
//   run.ts        LLM call wrapper with telemetry + structured-output retry (§8.2)
import type { LlmClient, LlmMessage } from '../llm/client';
import type { Logger } from '../telemetry';
import type { ChatMessage, KeyPoint, LlmUsage, PointDetails, SubPoint, Summary, Transcript, VideoMeta } from '../types';
import { compactTranscript, type CompactTranscript } from './compact';
import {
  DETAILS_SCHEMA,
  SUMMARY_SCHEMA,
  buildChatPreamble,
  buildDetailsTask,
  buildSharedPrefix,
  buildSummaryTask,
  buildVisualsPrompt,
  formatChatUserText,
} from './prompts';
import { callLlm, generateStructured } from './run';
import { checkRange, checkTimestamp } from './timestamps';

/** Bump whenever prompts change in a way that should invalidate stored summaries. (Defined in prompts.ts.) */
export { PROMPT_VERSION } from './prompts';
export { compactTranscript, formatClock, formatHms } from './compact';
export type { CompactTranscript, CompactLine } from './compact';
export { InvalidOutputError } from './run';

export interface PipelineContext {
  client: LlmClient;
  logger: Logger;
  meta: VideoMeta;
  transcript: Transcript;
  signal?: AbortSignal;
}

export interface SummaryResult {
  summary: Summary;
  usage: LlmUsage;
  /** How many timestamps were snapped to a real segment / hidden as unverifiable. */
  validation: { snapped: number; hidden: number };
}

/** Longest clip sent for "Look at the visuals" (video tokens are expensive). */
export const MAX_VISUALS_CLIP_SEC = 5 * 60;
/** Clip length used when a point has a start but no end. */
const DEFAULT_VISUALS_CLIP_SEC = 2 * 60;

// The compacted transcript is needed by every call; compute it once per Transcript object.
const compactCache = new WeakMap<Transcript, CompactTranscript>();
function getCompact(transcript: Transcript): CompactTranscript {
  let compact = compactCache.get(transcript);
  if (!compact) {
    compact = compactTranscript(transcript);
    compactCache.set(transcript, compact);
  }
  return compact;
}

// ---------- summary (§5.2) ----------

export async function summarize(ctx: PipelineContext, model: string): Promise<SummaryResult> {
  const compact = getCompact(ctx.transcript);
  const prefix = buildSharedPrefix(ctx.meta, compact);

  const { value: raw, usage } = await generateStructured(
    ctx,
    'summary',
    model,
    { system: prefix.system, messages: [...prefix.messages, buildSummaryTask()], responseSchema: SUMMARY_SCHEMA },
    parseSummaryJson,
  );

  // Timestamps: validated in code, not trusted.
  let snapped = 0;
  let hidden = 0;
  const points: KeyPoint[] = raw.points.map((p, i) => {
    const checked = checkRange(p.startSec, p.endSec, compact.lineStarts, ctx.meta.durationSec);
    snapped += checked.snapped;
    hidden += checked.hidden;
    return { id: `p${i + 1}`, title: p.title, gist: p.gist, startSec: checked.startSec, endSec: checked.endSec };
  });

  ctx.logger.event('summary.validated', { points: points.length, snapped, hidden }, { videoId: ctx.meta.videoId });
  return { summary: { tldr: raw.tldr, points }, usage, validation: { snapped, hidden } };
}

interface RawSummary {
  tldr: string;
  points: { title: string; gist: string; startSec: unknown; endSec: unknown }[];
}

/** Checks the shape of the summary JSON. Timestamps are not checked here (bad ones are hidden later). */
export function parseSummaryJson(json: unknown): RawSummary {
  if (!isObject(json)) throw new Error('summary is not an object');
  if (typeof json.tldr !== 'string' || json.tldr.trim() === '') throw new Error('missing "tldr"');
  if (!Array.isArray(json.points) || json.points.length === 0) throw new Error('"points" must be a non-empty array');

  const points = json.points.map((p, i) => {
    if (!isObject(p)) throw new Error(`point ${i + 1} is not an object`);
    if (typeof p.title !== 'string' || p.title.trim() === '') throw new Error(`point ${i + 1} has no title`);
    if (typeof p.gist !== 'string' || p.gist.trim() === '') throw new Error(`point ${i + 1} has no gist`);
    return { title: p.title.trim(), gist: p.gist.trim(), startSec: p.startSec, endSec: p.endSec };
  });
  // The schema says at most 7; if the model ignores that, keep the first 7 rather than failing.
  return { tldr: json.tldr.trim(), points: points.slice(0, 7) };
}

// ---------- point details (§5.3) ----------

export async function expandPoint(
  ctx: PipelineContext,
  model: string,
  summary: Summary,
  pointId: string,
): Promise<{ details: PointDetails; usage: LlmUsage }> {
  const point = summary.points.find((p) => p.id === pointId);
  if (!point) throw new Error(`Unknown point id "${pointId}"`);

  const compact = getCompact(ctx.transcript);
  const prefix = buildSharedPrefix(ctx.meta, compact);
  const { value: raw, usage } = await generateStructured(
    ctx,
    'details',
    model,
    { system: prefix.system, messages: [...prefix.messages, ...buildDetailsTask(summary, point)], responseSchema: DETAILS_SCHEMA },
    parseDetailsJson,
  );

  let snapped = 0;
  let hidden = 0;
  const subpoints: SubPoint[] = raw.subpoints.map((s) => {
    const checked = checkTimestamp(s.startSec, compact.lineStarts, ctx.meta.durationSec);
    if (checked.snapped) snapped++;
    if (checked.hidden) hidden++;
    return { text: s.text, startSec: checked.value };
  });

  ctx.logger.event('details.validated', { pointId, subpoints: subpoints.length, snapped, hidden }, { videoId: ctx.meta.videoId });
  return { details: { subpoints, context: raw.context }, usage };
}

interface RawDetails {
  subpoints: { text: string; startSec: unknown }[];
  context: string;
}

export function parseDetailsJson(json: unknown): RawDetails {
  if (!isObject(json)) throw new Error('details is not an object');
  if (!Array.isArray(json.subpoints) || json.subpoints.length === 0) throw new Error('"subpoints" must be a non-empty array');
  const subpoints = json.subpoints.map((s, i) => {
    if (!isObject(s) || typeof s.text !== 'string' || s.text.trim() === '') throw new Error(`subpoint ${i + 1} has no text`);
    return { text: s.text.trim(), startSec: s.startSec };
  });
  const context = typeof json.context === 'string' ? json.context.trim() : '';
  return { subpoints: subpoints.slice(0, 6), context };
}

// ---------- visuals (§5.4) ----------

/** "Look at the visuals" for one point: sends the clipped YouTube video (design §5.4). */
export async function analyzeVisuals(ctx: PipelineContext, model: string, point: KeyPoint): Promise<{ text: string; usage: LlmUsage }> {
  const clip = visualsClip(point, ctx.meta.durationSec);
  const compact = getCompact(ctx.transcript);
  const excerpt = compact.lines
    .filter((l) => l.startSec >= clip.startSec - 15 && l.startSec < clip.endSec)
    .map((l) => `[${l.startSec}s] ${l.text}`)
    .join('\n');

  const messages: LlmMessage[] = [
    {
      role: 'user',
      parts: [
        // Video before text, as Gemini recommends for media prompts.
        {
          video: {
            url: `https://www.youtube.com/watch?v=${encodeURIComponent(ctx.meta.videoId)}`,
            startSec: clip.startSec,
            endSec: clip.endSec,
            lowResolution: true,
          },
        },
        { text: buildVisualsPrompt(ctx.meta, point, clip, excerpt) },
      ],
    },
  ];

  const result = await callLlm(ctx, 'visuals', model, { messages });
  return { text: result.text.trim(), usage: result.usage };
}

/**
 * The [start, end] seconds to send for a point. Throws when the point has no validated start time.
 * Without an end, uses a 2-minute clip. Always capped at 5 minutes and to the video length.
 */
export function visualsClip(point: KeyPoint, durationSec: number): { startSec: number; endSec: number } {
  if (point.startSec === null) {
    throw new Error('This point has no verified timestamp, so there is no clip to look at.');
  }
  const startSec = Math.max(0, Math.floor(point.startSec));
  let endSec = point.endSec !== null && point.endSec > startSec ? point.endSec : startSec + DEFAULT_VISUALS_CLIP_SEC;
  endSec = Math.min(endSec, startSec + MAX_VISUALS_CLIP_SEC);
  if (durationSec > 0) endSec = Math.min(endSec, durationSec);
  if (endSec <= startSec) throw new Error('This point is at the very end of the video, so there is no clip to look at.');
  return { startSec, endSec: Math.ceil(endSec) };
}

// ---------- chat (§5.5) ----------

export interface ChatArgs {
  summary: Summary;
  history: ChatMessage[];
  userText: string;
  focusPointId: string | null;
  /** Called with the full reply text so far while streaming. */
  onDelta?: (textSoFar: string) => void;
}

export async function sendChat(ctx: PipelineContext, model: string, args: ChatArgs): Promise<{ userMessage: ChatMessage; reply: ChatMessage }> {
  const compact = getCompact(ctx.transcript);
  const prefix = buildSharedPrefix(ctx.meta, compact);
  const messages = buildChatMessages(prefix.messages, args);

  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    text: args.userText,
    focusPointId: args.focusPointId,
    citations: [],
    createdAt: Date.now(),
  };

  const result = await callLlm(
    ctx,
    'chat',
    model,
    { system: prefix.system, messages, googleSearch: true },
    args.onDelta ?? (() => {}),
  );

  const reply: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'model',
    text: result.text,
    focusPointId: args.focusPointId,
    citations: result.grounding?.citations ?? [],
    createdAt: Date.now(),
    usage: result.usage,
  };
  if (result.grounding?.searchEntryPointHtml) reply.searchEntryPointHtml = result.grounding.searchEntryPointHtml;
  return { userMessage, reply };
}

/**
 * Full chat contents: shared prefix → summary + chat rules → history → new user message.
 * Stored user messages contain only what the user typed; the focus header is re-added here from
 * focusPointId, the same way every time, so earlier turns stay byte-identical (cacheable).
 * Consecutive messages with the same role (e.g. a user message whose reply failed) are merged,
 * because Gemini expects user/model turns to alternate.
 */
export function buildChatMessages(prefixMessages: LlmMessage[], args: Pick<ChatArgs, 'summary' | 'history' | 'userText' | 'focusPointId'>): LlmMessage[] {
  const turns: LlmMessage[] = [];
  const push = (role: 'user' | 'model', text: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text });
    } else {
      turns.push({ role, parts: [{ text }] });
    }
  };

  for (const m of args.history) {
    if (m.role === 'user') push('user', formatChatUserText(args.summary, m.focusPointId, m.text));
    else if (m.text.trim() !== '') push('model', m.text);
  }
  push('user', formatChatUserText(args.summary, args.focusPointId, args.userText));

  // The preamble ends with a model turn, so history must start with a user turn: drop leading model turns.
  while (turns[0]?.role === 'model') turns.shift();

  return [...prefixMessages, ...buildChatPreamble(args.summary), ...turns];
}

// ---------- quick actions ----------

export interface QuickAction {
  id: 'fact_check' | 'explain_simpler' | 'whats_newer' | 'sources';
  label: string;
  /** Prompt text sent as the user message (the focused point is added by sendChat). */
  prompt: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'fact_check',
    label: 'Fact-check',
    prompt:
      'Fact-check this point. List the specific factual claims the video makes about it (with their [m:ss] times), search for evidence, and give each claim a verdict: supported, mostly supported, disputed or unverifiable, with a one-line reason. Prefer primary sources such as papers, official statistics and original documents over articles that only repeat the claim, and say plainly where the video and the sources disagree.',
  },
  {
    id: 'explain_simpler',
    label: 'Explain simpler',
    prompt:
      'Explain this point in simpler terms, for a smart person with no background in the subject. Define any jargon, and use one concrete example or analogy if it helps. Keep what the video says separate from what you add as general knowledge. No web search is needed for this.',
  },
  {
    id: 'whats_newer',
    label: "What's newer?",
    prompt:
      'What has changed since this video was made? Search for newer research, data or developments about this point, give their dates, and say whether they strengthen, weaken or overturn what the video claims. If nothing important is newer, say so.',
  },
  {
    id: 'sources',
    label: 'Sources',
    prompt:
      'Find the primary sources behind this point: the studies, papers, datasets, official documents or original statements it relies on. For each one, say briefly what it actually found or says and whether the video represents it accurately. If the video names no source and none can be identified, say so.',
  },
];

// ---------- helpers ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
