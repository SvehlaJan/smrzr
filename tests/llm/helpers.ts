// Hand-made fetch responses for Gemini client tests (no network in tests).
import { vi } from 'vitest';

/** Minimal Response stand-in with a JSON body. */
export function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    body: null,
  } as unknown as Response;
}

/** Response whose body streams the given byte chunks (to simulate network chunking). */
export function streamResponse(chunks: (string | Uint8Array)[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      controller.close();
    },
  });
  return { ok: true, status: 200, body, json: async () => ({}), text: async () => '' } as unknown as Response;
}

/** SSE text for a list of response chunks. */
export function sse(...payloads: unknown[]): string {
  return payloads.map((p) => `data: ${JSON.stringify(p)}\r\n\r\n`).join('');
}

/** A fetch mock that returns the given responses in order (the last one repeats). */
export function fetchSequence(...responses: (Response | Error)[]) {
  let i = 0;
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r as Response;
  });
}

/** Typical successful generateContent response. */
export function okBody(text: string, extra: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', ...extra }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, totalTokenCount: 1100 },
  };
}
