// Gemini implementation of LlmClient over the REST API (no SDK): design §5.6.
// The API key is sent ONLY as the `x-goog-api-key` header, never as a `?key=` URL param (design §8.3).
import type { LlmClient } from './client';
import { notImplemented } from '../notImplemented';

export function createGeminiClient(apiKey: string, opts?: { baseUrl?: string; fetchImpl?: typeof fetch }): LlmClient {
  return notImplemented('createGeminiClient');
}
