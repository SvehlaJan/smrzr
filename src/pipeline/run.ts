// One place where every pipeline LLM call goes through, so telemetry is consistent (design §8.2):
//   llm.request  → before the call (metadata only)
//   llm.response → after the call (timing, tokens, cost)
//   recordExchange → the full prompt + response, kept locally for manual issue reports only
//   logger.error → on failure, before rethrowing
// Prompts and transcript text are NEVER put into `event` data (that goes to Sentry breadcrumbs).
import type { GenerateRequest, GenerateResult, LlmMessage } from '../llm/client';
import type { LlmTask, LlmUsage } from '../types';
import type { PipelineContext } from './index';
import { PROMPT_VERSION } from './prompts';

/** Rough token estimate: ~4 characters per token for English text. */
export function estimateTokens(req: Pick<GenerateRequest, 'system' | 'messages'>): number {
  let chars = req.system?.length ?? 0;
  for (const m of req.messages) for (const p of m.parts) chars += p.text?.length ?? 0;
  return Math.ceil(chars / 4);
}

/** Request messages in a log-friendly shape: text parts as text, video parts as their URL + clip. */
function messagesForExchange(messages: LlmMessage[]): unknown {
  return messages.map((m) => ({
    role: m.role,
    parts: m.parts.map((p) =>
      p.video ? { video: p.video.url, startSec: p.video.startSec, endSec: p.video.endSec, lowResolution: p.video.lowResolution } : { text: p.text },
    ),
  }));
}

/**
 * Calls the LLM with full telemetry. Uses `stream` when `onDelta` is given, `generate` otherwise.
 * `req.model` and `req.signal` are filled in from the arguments / context.
 */
export async function callLlm(
  ctx: PipelineContext,
  task: LlmTask,
  model: string,
  req: Omit<GenerateRequest, 'model' | 'signal'>,
  onDelta?: (textSoFar: string) => void,
): Promise<GenerateResult> {
  const { logger } = ctx;
  const videoId = ctx.meta.videoId;
  const fullReq: GenerateRequest = { ...req, model, signal: ctx.signal };

  logger.setTags({ task, model, promptVersion: PROMPT_VERSION });
  logger.event(
    'llm.request',
    { task, model, promptVersion: PROMPT_VERSION, estInputTokens: estimateTokens(fullReq), grounded: Boolean(req.googleSearch) },
    { videoId },
  );

  let result: GenerateResult;
  try {
    result = onDelta ? await ctx.client.stream(fullReq, onDelta) : await ctx.client.generate(fullReq);
  } catch (err) {
    logger.error(err, { task, model, videoId });
    throw err;
  }

  logger.event(
    'llm.response',
    {
      task,
      model,
      ms: result.latencyMs,
      finishReason: result.finishReason,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      searchQueries: result.grounding?.searchQueries.length ?? 0,
      estCostUsd: result.usage.estCostUsd,
    },
    { videoId },
  );
  logger.recordExchange({
    ts: Date.now(),
    videoId,
    task,
    model,
    system: req.system,
    requestMessages: messagesForExchange(req.messages),
    responseText: result.text,
    finishReason: result.finishReason,
    latencyMs: result.latencyMs,
  });
  return result;
}

/** Thrown when the model's structured output can't be used even after one retry. */
export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutputError';
  }
}

/**
 * Structured-output call: generate → JSON.parse → `validate`. If parsing or validation fails, logs
 * `llm.invalid_output` and tries ONCE more; a second failure throws InvalidOutputError.
 * `validate` returns the typed value or throws an Error describing what is wrong.
 * The returned usage covers all attempts (both calls were paid for).
 */
export async function generateStructured<T>(
  ctx: PipelineContext,
  task: LlmTask,
  model: string,
  req: Omit<GenerateRequest, 'model' | 'signal'>,
  validate: (json: unknown) => T,
): Promise<{ value: T; usage: LlmUsage }> {
  const MAX_ATTEMPTS = 2;
  let usage: LlmUsage | undefined;
  let lastProblem = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await callLlm(ctx, task, model, req);
    usage = usage ? addUsage(usage, result.usage) : result.usage;
    try {
      const value = validate(parseJsonText(result.text));
      return { value, usage };
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : String(err);
      ctx.logger.event(
        'llm.invalid_output',
        { task, model, error: lastProblem.slice(0, 300), retry: attempt - 1, finishReason: result.finishReason },
        { level: 'warn', videoId: ctx.meta.videoId },
      );
    }
  }

  const error = new InvalidOutputError(`The model returned unusable ${task} output twice (${lastProblem})`);
  ctx.logger.error(error, { task, model, videoId: ctx.meta.videoId });
  throw error;
}

/** JSON.parse that tolerates a ```json … ``` fence around the JSON (should not happen with a response schema). */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const jsonText = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error(trimmed === '' ? 'empty response' : 'response is not valid JSON');
  }
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    model: b.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    estCostUsd: a.estCostUsd === null || b.estCostUsd === null ? null : a.estCostUsd + b.estCostUsd,
  };
}
