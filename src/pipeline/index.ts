// Summary / details / visuals / chat orchestration: design §5.
import type { LlmClient } from '../llm/client';
import type { Logger } from '../telemetry';
import type { ChatMessage, KeyPoint, LlmUsage, PointDetails, Summary, Transcript, VideoMeta } from '../types';
import { notImplemented } from '../notImplemented';

/** Bump whenever prompts change in a way that should invalidate stored summaries. */
export const PROMPT_VERSION = 1;

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

export function summarize(ctx: PipelineContext, model: string): Promise<SummaryResult> {
  return notImplemented('summarize');
}

export function expandPoint(ctx: PipelineContext, model: string, summary: Summary, pointId: string): Promise<{ details: PointDetails; usage: LlmUsage }> {
  return notImplemented('expandPoint');
}

/** "Look at the visuals" for one point: sends the clipped YouTube video (design §5.4). */
export function analyzeVisuals(ctx: PipelineContext, model: string, point: KeyPoint): Promise<{ text: string; usage: LlmUsage }> {
  return notImplemented('analyzeVisuals');
}

export interface ChatArgs {
  summary: Summary;
  history: ChatMessage[];
  userText: string;
  focusPointId: string | null;
  /** Called with the full reply text so far while streaming. */
  onDelta?: (textSoFar: string) => void;
}

export function sendChat(ctx: PipelineContext, model: string, args: ChatArgs): Promise<{ userMessage: ChatMessage; reply: ChatMessage }> {
  return notImplemented('sendChat');
}

export interface QuickAction {
  id: 'fact_check' | 'explain_simpler' | 'whats_newer' | 'sources';
  label: string;
  /** Prompt text sent as the user message (the focused point is added by sendChat). */
  prompt: string;
}

export const QUICK_ACTIONS: QuickAction[] = [];
