// Fakes for pipeline tests: an in-memory Logger and a scripted LlmClient.
import type { GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client';
import type { PipelineContext } from '../../src/pipeline';
import type { LlmExchange, Logger } from '../../src/telemetry';
import type { Transcript, VideoMeta } from '../../src/types';

export interface FakeLogger extends Logger {
  events: { name: string; data?: Record<string, unknown>; opts?: unknown }[];
  errors: { err: unknown; context?: Record<string, unknown> }[];
  tags: Record<string, unknown>[];
  exchanges: LlmExchange[];
}

export function fakeLogger(): FakeLogger {
  const logger: FakeLogger = {
    events: [],
    errors: [],
    tags: [],
    exchanges: [],
    event(name, data, opts) {
      logger.events.push({ name, data, opts });
    },
    error(err, context) {
      logger.errors.push({ err, context });
    },
    setTags(tags) {
      logger.tags.push(tags);
    },
    recordExchange(x) {
      logger.exchanges.push(x);
    },
  };
  return logger;
}

export interface FakeClient extends LlmClient {
  requests: GenerateRequest[];
  streamed: boolean[];
}

/** Each call consumes the next reply (text, or an Error to throw). */
export function fakeClient(...replies: (string | Partial<GenerateResult> | Error)[]): FakeClient {
  let i = 0;
  const next = (req: GenerateRequest): GenerateResult => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    if (reply instanceof Error) throw reply;
    const base: GenerateResult = {
      text: '',
      finishReason: 'STOP',
      latencyMs: 42,
      usage: { model: req.model, inputTokens: 1000, outputTokens: 100, cachedTokens: 800, estCostUsd: 0.001 },
    };
    return typeof reply === 'string' ? { ...base, text: reply } : { ...base, ...reply };
  };
  const client: FakeClient = {
    requests: [],
    streamed: [],
    async generate(req) {
      client.requests.push(req);
      client.streamed.push(false);
      return next(req);
    },
    async stream(req, onDelta) {
      client.requests.push(req);
      client.streamed.push(true);
      const result = next(req);
      onDelta(result.text.slice(0, 3));
      onDelta(result.text);
      return result;
    },
    async listModels() {
      return [];
    },
  };
  return client;
}

export const META: VideoMeta = {
  videoId: 'abc123XYZ_0',
  title: 'Sleep, caffeine & light — Episode 142',
  channel: 'Sleep Pod',
  durationSec: 600,
  chapters: [
    { title: 'Intro', startSec: 0 },
    { title: 'Caffeine', startSec: 120 },
  ],
  isLive: false,
  captionTracks: [],
};

/** 10 minutes of 4-second caption fragments. Each fragment says its own start time. */
export function sampleTranscript(): Transcript {
  const segments = [];
  for (let t = 0; t < 600; t += 4) {
    segments.push({ start: t, dur: 4, text: `words at second ${t}.` });
  }
  return { videoId: META.videoId, language: 'en', kind: 'asr', source: 'player', segments };
}

export function makeCtx(client: LlmClient, logger = fakeLogger()): PipelineContext & { logger: FakeLogger } {
  return { client, logger, meta: META, transcript: sampleTranscript() };
}
