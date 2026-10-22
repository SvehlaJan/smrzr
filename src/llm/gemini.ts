// Gemini implementation of LlmClient over the REST API (no SDK): design §5.6.
// The API key is sent ONLY as the `x-goog-api-key` header, never as a `?key=` URL param (design §8.3).
//
// Endpoints used (Gemini API v1beta):
//   POST /models/{model}:generateContent
//   POST /models/{model}:streamGenerateContent?alt=sse
//   GET  /models?pageSize=…&pageToken=…
//
// ASSUMPTIONS written from knowledge of the API, not verified against live docs in this sandbox.
// Each one is marked "ASSUMPTION" below; check them with a real key first (M0).
import type { LlmUsage } from '../types';
import { LlmError } from './client';
import type { GenerateRequest, GenerateResult, LlmClient, LlmMessage, LlmPart, ModelInfo } from './client';
import { applyGrounding, type GeminiGroundingMetadata } from './grounding';
import { estimateCostUsd } from './pricing';
import { readSseData } from './sse';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Delay before the single automatic retry (5xx / network errors, non-streaming only). */
  retryDelayMs?: number;
}

// ---------- Gemini wire types (only the fields we use) ----------

interface GeminiPart {
  text?: string;
  /** true for "thinking" summaries; never shown as answer text. */
  thought?: boolean;
  fileData?: { fileUri: string; mimeType?: string };
  videoMetadata?: { startOffset?: string; endOffset?: string };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
    groundingMetadata?: GeminiGroundingMetadata;
  }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    /** Tokens of tool results (e.g. Google Search results) fed back to the model. */
    toolUsePromptTokenCount?: number;
    totalTokenCount?: number;
  };
  /** Present when an error happens in the middle of a stream. */
  error?: GeminiErrorBody['error'];
}

interface GeminiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string; // e.g. "INVALID_ARGUMENT", "RESOURCE_EXHAUSTED"
    details?: { '@type'?: string; reason?: string }[];
  };
}

interface GeminiModel {
  name?: string; // "models/gemini-2.5-flash"
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

/** finishReasons that mean "the answer was withheld for safety/policy reasons". */
const BLOCKING_FINISH_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

export function createGeminiClient(apiKey: string, opts?: GeminiClientOptions): LlmClient {
  const baseUrl = (opts?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  // Bind so `fetch` keeps its `this` (calling an unbound window.fetch throws "Illegal invocation").
  const fetchImpl = opts?.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const retryDelayMs = opts?.retryDelayMs ?? 1000;

  /** Removes the API key (and anything that looks like one) from a string we might show or log. */
  const redact = (s: string): string => {
    let out = apiKey ? s.split(apiKey).join('<redacted>') : s;
    out = out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '<redacted>');
    return out;
  };

  /** One HTTP request. Turns every failure into an LlmError. */
  async function send(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    if (signal?.aborted) throw new LlmError('Request aborted', 'aborted');
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal,
        headers: { 'x-goog-api-key': apiKey, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      });
    } catch (err) {
      throw toTransportError(err, signal, redact);
    }
    if (!response.ok) throw await httpError(response, redact);
    return response;
  }

  /** Runs `fn`, retrying once after a short delay for 5xx and network errors. */
  async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof LlmError) || (err.kind !== 'server' && err.kind !== 'network')) throw err;
      await sleep(retryDelayMs, signal);
      return fn();
    }
  }

  function modelUrl(model: string, method: string): string {
    const id = model.replace(/^models\//, '');
    // Model ids are like "gemini-3.1-pro-preview". Reject anything else instead of building a weird URL.
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new LlmError(`Invalid model id: "${id}"`, 'bad_request');
    return `${baseUrl}/models/${id}:${method}`;
  }

  return {
    async generate(req) {
      const url = modelUrl(req.model, 'generateContent');
      const body = JSON.stringify(buildRequestBody(req));
      const started = Date.now();
      const json = await withRetry(async () => {
        const response = await send(url, { method: 'POST', body }, req.signal);
        return (await readJson(response, req.signal, redact)) as GeminiResponse;
      }, req.signal);
      return toResult(req.model, [json], Date.now() - started);
    },

    async stream(req, onDelta) {
      const url = modelUrl(req.model, 'streamGenerateContent') + '?alt=sse';
      const body = JSON.stringify(buildRequestBody(req));
      const started = Date.now();
      const response = await send(url, { method: 'POST', body }, req.signal);

      const chunks: GeminiResponse[] = [];
      let textSoFar = '';
      try {
        if (!response.body) {
          // No streaming body (should not happen in Chrome): treat the whole text as SSE at once.
          const whole = await response.text();
          for (const payload of whole.split(/\r?\n/).filter((l) => l.startsWith('data:'))) {
            chunks.push(parseChunk(payload.slice(5).trim(), redact));
          }
          textSoFar = chunks.map(answerText).join('');
          if (textSoFar) onDelta(textSoFar);
        } else {
          for await (const payload of readSseData(response.body)) {
            const chunk = parseChunk(payload, redact);
            chunks.push(chunk);
            const delta = answerText(chunk);
            if (delta) {
              textSoFar += delta;
              onDelta(textSoFar);
            }
          }
        }
      } catch (err) {
        throw toTransportError(err, req.signal, redact);
      }
      return toResult(req.model, chunks, Date.now() - started);
    },

    async listModels(signal) {
      const models: ModelInfo[] = [];
      let pageToken: string | undefined;
      // Hard cap on pages so a misbehaving API can't loop us forever.
      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({ pageSize: '1000' });
        if (pageToken) params.set('pageToken', pageToken);
        const url = `${baseUrl}/models?${params.toString()}`;
        const json = await withRetry(async () => {
          const response = await send(url, { method: 'GET' }, signal);
          return (await readJson(response, signal, redact)) as { models?: GeminiModel[]; nextPageToken?: string };
        }, signal);

        for (const m of json.models ?? []) {
          if (!m.name || !(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
          const id = m.name.replace(/^models\//, '');
          models.push({
            id,
            displayName: m.displayName ?? id,
            inputTokenLimit: m.inputTokenLimit ?? 0,
            outputTokenLimit: m.outputTokenLimit ?? 0,
          });
        }
        pageToken = json.nextPageToken || undefined;
        if (!pageToken) break;
      }
      return models;
    },
  };
}

// ---------- request mapping ----------

/** Builds the JSON body for generateContent / streamGenerateContent. Exported for tests. */
export function buildRequestBody(req: GenerateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: req.messages.map(toGeminiContent),
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = req.responseSchema;
  }
  // ASSUMPTION: request-wide media resolution lives in generationConfig.mediaResolution.
  // (Gemini 3 also has a per-part `mediaResolution`; the request-wide one is enough for us.)
  const wantsLowRes = req.messages.some((m) => m.parts.some((p) => p.video?.lowResolution));
  if (wantsLowRes) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  // ASSUMPTION: Gemini 2.x/3.x use the `googleSearch` tool (the 1.5-era name was googleSearchRetrieval).
  if (req.googleSearch) body.tools = [{ googleSearch: {} }];
  return body;
}

function toGeminiContent(message: LlmMessage): GeminiContent {
  return { role: message.role, parts: message.parts.flatMap(toGeminiParts) };
}

/** One LlmPart can carry text and/or a video; Gemini wants one Part per item. */
function toGeminiParts(part: LlmPart): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (part.video) {
    // ASSUMPTION: YouTube URLs go in fileData.fileUri without a mimeType, and the clip is set with
    // videoMetadata (a sibling of fileData in the same Part) using Duration strings like "12s".
    const videoPart: GeminiPart = { fileData: { fileUri: part.video.url } };
    const { startSec, endSec } = part.video;
    if (startSec !== undefined || endSec !== undefined) {
      videoPart.videoMetadata = {};
      if (startSec !== undefined) videoPart.videoMetadata.startOffset = `${Math.max(0, Math.floor(startSec))}s`;
      if (endSec !== undefined) videoPart.videoMetadata.endOffset = `${Math.ceil(endSec)}s`;
    }
    parts.push(videoPart);
  }
  if (part.text !== undefined) parts.push({ text: part.text });
  return parts;
}

// ---------- response mapping ----------

/** Text of candidate 0 without "thought" parts. */
function answerText(response: GeminiResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

function parseChunk(payload: string, redact: (s: string) => string): GeminiResponse {
  let chunk: GeminiResponse;
  try {
    chunk = JSON.parse(payload) as GeminiResponse;
  } catch {
    throw new LlmError('Gemini sent a malformed stream chunk', 'server');
  }
  if (chunk.error) throw errorFromBody(chunk.error.code ?? 500, { error: chunk.error }, redact);
  return chunk;
}

/**
 * Combines one (generate) or many (stream) response chunks into a GenerateResult.
 * For streams: text is concatenated; finishReason, usage and grounding are taken from the last
 * chunk that has them.
 * ASSUMPTION: in a stream, usageMetadata is cumulative and the last groundingMetadata covers the
 * whole answer (its byte offsets refer to the full concatenated text).
 */
function toResult(model: string, chunks: GeminiResponse[], latencyMs: number): GenerateResult {
  const rawText = chunks.map(answerText).join('');

  let finishReason = '';
  let usageMeta: GeminiResponse['usageMetadata'];
  let groundingMeta: GeminiGroundingMetadata | undefined;
  let blockReason: string | undefined;
  for (const chunk of chunks) {
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    if (candidate?.groundingMetadata) groundingMeta = candidate.groundingMetadata;
    if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
  }

  if (blockReason) {
    throw new LlmError(`Gemini blocked the request (${blockReason})`, 'blocked');
  }
  if (rawText.trim() === '' && BLOCKING_FINISH_REASONS.has(finishReason)) {
    throw new LlmError(`Gemini withheld the answer (${finishReason})`, 'blocked');
  }

  const { text, grounding } = applyGrounding(rawText, groundingMeta);

  // ASSUMPTION: toolUsePromptTokenCount (search results fed to the model) is billed as input but
  // is not part of promptTokenCount, so it is added here.
  const inputTokens = (usageMeta?.promptTokenCount ?? 0) + (usageMeta?.toolUsePromptTokenCount ?? 0);
  const outputTokens = (usageMeta?.candidatesTokenCount ?? 0) + (usageMeta?.thoughtsTokenCount ?? 0);
  const cachedTokens = usageMeta?.cachedContentTokenCount ?? 0;
  const id = model.replace(/^models\//, '');
  const usage: LlmUsage = {
    model: id,
    inputTokens,
    outputTokens,
    cachedTokens,
    estCostUsd: estimateCostUsd(id, inputTokens, outputTokens, cachedTokens),
  };

  const result: GenerateResult = { text, finishReason: finishReason || 'UNKNOWN', usage, latencyMs };
  if (grounding) result.grounding = grounding;
  return result;
}

// ---------- errors ----------

async function readJson(response: Response, signal: AbortSignal | undefined, redact: (s: string) => string): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    const transport = toTransportError(err, signal, redact);
    if (transport.kind !== 'network') throw transport;
    throw new LlmError('Gemini returned an unreadable response', 'server', response.status);
  }
}

/** Builds an LlmError from a non-2xx HTTP response. */
async function httpError(response: Response, redact: (s: string) => string): Promise<LlmError> {
  let body: GeminiErrorBody = {};
  try {
    body = (await response.json()) as GeminiErrorBody;
  } catch {
    // Not JSON (e.g. an HTML error page from a proxy). Fall back to the status code only.
  }
  return errorFromBody(response.status, body, redact);
}

/**
 * Maps an HTTP status + Google error body to an LlmError kind.
 * Google error bodies look like:
 *   { "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.",
 *                "status": "INVALID_ARGUMENT",
 *                "details": [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID" }] } }
 */
export function errorFromBody(status: number, body: GeminiErrorBody, redact: (s: string) => string = (s) => s): LlmError {
  const err = body.error ?? {};
  const reasons = (err.details ?? []).map((d) => d.reason ?? '');
  const googleMessage = redact((err.message ?? '').trim());
  const label = err.status ? `${status} ${err.status}` : `${status}`;
  const message = googleMessage ? `Gemini API error (${label}): ${googleMessage}` : `Gemini API error (${label})`;

  let kind: LlmError['kind'];
  if (status === 401 || status === 403 || reasons.includes('API_KEY_INVALID') || /api key not valid/i.test(googleMessage)) {
    kind = 'auth';
  } else if (status === 429 || err.status === 'RESOURCE_EXHAUSTED') {
    kind = 'quota';
  } else if (status >= 500) {
    kind = 'server';
  } else if (status >= 400) {
    kind = 'bad_request';
  } else {
    kind = 'server';
  }
  return new LlmError(message, kind, status);
}

/** Maps fetch / stream-reading exceptions to LlmError ('aborted' or 'network'). */
function toTransportError(err: unknown, signal: AbortSignal | undefined, redact: (s: string) => string): LlmError {
  if (err instanceof LlmError) return err;
  if (signal?.aborted || (err instanceof Error && err.name === 'AbortError') || (err as { name?: string })?.name === 'AbortError') {
    return new LlmError('Request aborted', 'aborted');
  }
  const detail = err instanceof Error ? redact(err.message) : 'unknown error';
  return new LlmError(`Network error while calling Gemini: ${detail}`, 'network');
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmError('Request aborted', 'aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmError('Request aborted', 'aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
