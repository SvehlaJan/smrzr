// Provider-neutral LLM interface (design §5.6). Gemini is the only implementation for now;
// everything above this layer (src/pipeline, UI) must only depend on this file.

import type { Citation, LlmUsage } from '../types';

export interface LlmPart {
  text?: string;
  /** A YouTube URL for video input, optionally clipped (design §5.4). */
  video?: { url: string; startSec?: number; endSec?: number; lowResolution?: boolean };
}

export interface LlmMessage {
  role: 'user' | 'model';
  parts: LlmPart[];
}

export interface GenerateRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  /** JSON schema (OpenAPI subset accepted by Gemini). When set, the response text is JSON. */
  responseSchema?: object;
  /** Enable Google Search grounding. */
  googleSearch?: boolean;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Grounding {
  citations: Citation[];
  searchQueries: string[];
  /** HTML for the search suggestions chip that Google's terms require to be displayed. */
  searchEntryPointHtml?: string;
}

export interface GenerateResult {
  text: string;
  finishReason: string;
  usage: LlmUsage;
  grounding?: Grounding;
  latencyMs: number;
}

export interface ModelInfo {
  /** Id usable in GenerateRequest.model, without the "models/" prefix. */
  id: string;
  displayName: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    /** 'auth' = bad/missing key, 'quota' = 429/billing, 'blocked' = safety block, 'network', 'bad_request', 'server', 'aborted' */
    readonly kind: 'auth' | 'quota' | 'blocked' | 'network' | 'bad_request' | 'server' | 'aborted',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmClient {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Streams text deltas through onDelta; resolves with the full result. */
  stream(req: GenerateRequest, onDelta: (textSoFar: string) => void): Promise<GenerateResult>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}
