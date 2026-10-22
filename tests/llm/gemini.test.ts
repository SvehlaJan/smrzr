import { describe, expect, it, vi } from 'vitest';
import { LlmError, type GenerateRequest } from '../../src/llm/client';
import { buildRequestBody, createGeminiClient } from '../../src/llm/gemini';
import { estimateCostUsd } from '../../src/llm/pricing';
import { fetchSequence, jsonResponse, okBody, sse, streamResponse } from './helpers';

const KEY = 'AIzaSyTESTKEY_0123456789abcdefghijklmno';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function client(fetchImpl: typeof fetch) {
  return createGeminiClient(KEY, { fetchImpl, retryDelayMs: 1 });
}

const simpleReq: GenerateRequest = { model: 'gemini-3-flash', messages: [{ role: 'user', parts: [{ text: 'Hi' }] }] };

/** Runs a call that must fail and returns the LlmError. */
async function failure(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error('expected the call to fail');
}

describe('request', () => {
  it('POSTs to generateContent with the key only in the x-goog-api-key header', async () => {
    const fetchMock = fetchSequence(jsonResponse(200, okBody('Hello')));
    await client(fetchMock).generate(simpleReq);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/models/gemini-3-flash:generateContent`);
    expect(String(url)).not.toContain(KEY);
    expect(String(url)).not.toContain('key=');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(KEY);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('strips a "models/" prefix from the model id', async () => {
    const fetchMock = fetchSequence(jsonResponse(200, okBody('x')));
    await client(fetchMock).generate({ ...simpleReq, model: 'models/gemini-2.5-pro' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/models/gemini-2.5-pro:generateContent`);
  });

  it('maps system, roles, text, clipped low-res video, schema, search and temperature', () => {
    const schema = { type: 'OBJECT', properties: { a: { type: 'STRING' } } };
    const body = buildRequestBody({
      model: 'm',
      system: 'Be nice.',
      messages: [
        { role: 'user', parts: [{ video: { url: 'https://www.youtube.com/watch?v=abc', startSec: 12.4, endSec: 39.2, lowResolution: true } }, { text: 'What is shown?' }] },
        { role: 'model', parts: [{ text: 'A chart.' }] },
      ],
      responseSchema: schema,
      googleSearch: true,
      temperature: 0.2,
    });

    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'Be nice.' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: 'https://www.youtube.com/watch?v=abc' }, videoMetadata: { startOffset: '12s', endOffset: '40s' } },
            { text: 'What is shown?' },
          ],
        },
        { role: 'model', parts: [{ text: 'A chart.' }] },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema,
        mediaResolution: 'MEDIA_RESOLUTION_LOW',
      },
      tools: [{ googleSearch: {} }],
    });
  });

  it('omits optional fields when not requested', () => {
    const body = buildRequestBody(simpleReq);
    expect(body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] });
  });
});

describe('generate result', () => {
  it('joins non-thought parts and maps usage + cost', async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Thinking about it…', thought: true }, { text: 'Hello ' }, { text: 'world' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 40_000,
          candidatesTokenCount: 500,
          thoughtsTokenCount: 300,
          cachedContentTokenCount: 30_000,
          totalTokenCount: 40_800,
        },
      }),
    );
    const res = await client(fetchMock).generate(simpleReq);

    expect(res.text).toBe('Hello world');
    expect(res.finishReason).toBe('STOP');
    expect(res.usage).toEqual({
      model: 'gemini-3-flash',
      inputTokens: 40_000,
      outputTokens: 800,
      cachedTokens: 30_000,
      estCostUsd: estimateCostUsd('gemini-3-flash', 40_000, 800, 30_000),
    });
    expect(res.usage.estCostUsd).toBeGreaterThan(0);
    expect(res.grounding).toBeUndefined();
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('builds citations and inserts [n] markers at UTF-8 byte offsets (non-ASCII text)', async () => {
    const s1 = 'Kofein zvyšuje bdělost 😀.';
    const s2 = ' Spánek je důležitý — 睡眠.';
    const text = s1 + s2;
    const bytes = (s: string) => new TextEncoder().encode(s).length;

    const fetchMock = fetchSequence(
      jsonResponse(
        200,
        okBody(text, {
          groundingMetadata: {
            webSearchQueries: ['caffeine alertness', 'sleep importance'],
            searchEntryPoint: { renderedContent: '<div>chips</div>' },
            groundingChunks: [
              { web: { uri: 'https://vertexaisearch.cloud.google.com/a', title: 'nih.gov' } },
              { web: { uri: 'https://vertexaisearch.cloud.google.com/b', title: 'who.int' } },
            ],
            groundingSupports: [
              { segment: { startIndex: 0, endIndex: bytes(s1), text: s1 }, groundingChunkIndices: [0] },
              { segment: { startIndex: bytes(s1), endIndex: bytes(text) }, groundingChunkIndices: [1, 0] },
            ],
          },
        }),
      ),
    );
    const res = await client(fetchMock).generate({ ...simpleReq, googleSearch: true });

    expect(res.text).toBe(`${s1}[1]${s2}[1][2]`);
    expect(res.grounding).toEqual({
      citations: [
        { index: 1, title: 'nih.gov', uri: 'https://vertexaisearch.cloud.google.com/a' },
        { index: 2, title: 'who.int', uri: 'https://vertexaisearch.cloud.google.com/b' },
      ],
      searchQueries: ['caffeine alertness', 'sleep importance'],
      searchEntryPointHtml: '<div>chips</div>',
    });
  });

  it('adds search tool tokens to input tokens', async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, { ...okBody('x'), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, toolUsePromptTokenCount: 50 } }),
    );
    const res = await client(fetchMock).generate(simpleReq);
    expect(res.usage.inputTokens).toBe(150);
  });

  it('returns null cost for an unknown model', async () => {
    const fetchMock = fetchSequence(jsonResponse(200, okBody('x')));
    const res = await client(fetchMock).generate({ ...simpleReq, model: 'some-future-model' });
    expect(res.usage.estCostUsd).toBeNull();
  });
});

describe('stream', () => {
  it('parses SSE split mid-line and mid-character, skips thoughts, reports text so far', async () => {
    const text = sse(
      { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Ahoj ' }] } }], usageMetadata: { promptTokenCount: 10 } },
      { candidates: [{ content: { parts: [{ text: 'světe 🌍' }] } }] },
      {
        candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
      },
    );
    // Cut the byte stream into awkward pieces, including inside multi-byte characters.
    const bytes = new TextEncoder().encode(text);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) pieces.push(bytes.slice(i, i + 7));

    const fetchMock = fetchSequence(streamResponse(pieces));
    const deltas: string[] = [];
    const res = await client(fetchMock).stream(simpleReq, (t) => deltas.push(t));

    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/models/gemini-3-flash:streamGenerateContent?alt=sse`);
    expect(deltas).toEqual(['Ahoj ', 'Ahoj světe 🌍', 'Ahoj světe 🌍!']);
    expect(res.text).toBe('Ahoj světe 🌍!');
    expect(res.finishReason).toBe('STOP');
    expect(res.usage.inputTokens).toBe(10);
    expect(res.usage.outputTokens).toBe(7);
  });

  it('handles a stream without a trailing blank line and grounding in the last chunk', async () => {
    const last = {
      candidates: [
        {
          content: { parts: [{ text: 'b.' }] },
          finishReason: 'STOP',
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://x', title: 'x.org' } }],
            groundingSupports: [{ segment: { endIndex: 4 }, groundingChunkIndices: [0] }],
          },
        },
      ],
    };
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a. ' }] } }] })}\n\ndata: ${JSON.stringify(last)}`;
    const res = await client(fetchSequence(streamResponse([body]))).stream(simpleReq, () => {});
    // Full text is "a. b." and the segment ends at byte 4 ("a. b").
    expect(res.text).toBe('a. b[1].');
    expect(res.grounding?.citations).toHaveLength(1);
  });

  it('throws the mapped error when the stream contains an error object', async () => {
    const body = sse({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }, { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } });
    const err = await failure(client(fetchSequence(streamResponse([body]))).stream(simpleReq, () => {}));
    expect(err.kind).toBe('server');
    expect(err.message).toContain('overloaded');
  });

  it('does not retry streaming calls', async () => {
    const fetchMock = fetchSequence(jsonResponse(500, { error: { code: 500, message: 'boom', status: 'INTERNAL' } }));
    const err = await failure(client(fetchMock).stream(simpleReq, () => {}));
    expect(err.kind).toBe('server');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('errors', () => {
  const apiError = (code: number, status: string, message: string, reason?: string) =>
    jsonResponse(code, { error: { code, status, message, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] } });

  it('400 API_KEY_INVALID → auth', async () => {
    const err = await failure(client(fetchSequence(apiError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'))).generate(simpleReq));
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(400);
    expect(err.message).toContain('API key not valid');
  });

  it('401/403 → auth', async () => {
    expect((await failure(client(fetchSequence(apiError(403, 'PERMISSION_DENIED', 'denied'))).generate(simpleReq))).kind).toBe('auth');
    expect((await failure(client(fetchSequence(apiError(401, 'UNAUTHENTICATED', 'no'))).generate(simpleReq))).kind).toBe('auth');
  });

  it('429 → quota', async () => {
    const err = await failure(client(fetchSequence(apiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'))).generate(simpleReq));
    expect(err.kind).toBe('quota');
  });

  it('other 4xx → bad_request, without retry', async () => {
    const fetchMock = fetchSequence(apiError(404, 'NOT_FOUND', 'models/gemini-0 is not found'));
    const err = await failure(client(fetchMock).generate(simpleReq));
    expect(err.kind).toBe('bad_request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx → server after one retry', async () => {
    const fetchMock = fetchSequence(apiError(503, 'UNAVAILABLE', 'overloaded'));
    const err = await failure(client(fetchMock).generate(simpleReq));
    expect(err.kind).toBe('server');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('5xx then success → result', async () => {
    const fetchMock = fetchSequence(apiError(500, 'INTERNAL', 'oops'), jsonResponse(200, okBody('ok')));
    const res = await client(fetchMock).generate(simpleReq);
    expect(res.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('non-JSON error body still maps by status', async () => {
    const res = { ok: false, status: 502, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response;
    const err = await failure(client(fetchSequence(res)).generate(simpleReq));
    expect(err.kind).toBe('server');
    expect(err.status).toBe(502);
  });

  it('fetch TypeError → network (retried once)', async () => {
    const fetchMock = fetchSequence(new TypeError('Failed to fetch'));
    const err = await failure(client(fetchMock).generate(simpleReq));
    expect(err.kind).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('promptFeedback.blockReason → blocked', async () => {
    const fetchMock = fetchSequence(jsonResponse(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }));
    const err = await failure(client(fetchMock).generate(simpleReq));
    expect(err.kind).toBe('blocked');
    expect(err.message).toContain('PROHIBITED_CONTENT');
  });

  it('finishReason SAFETY with no text → blocked', async () => {
    const fetchMock = fetchSequence(jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }));
    expect((await failure(client(fetchMock).generate(simpleReq))).kind).toBe('blocked');
  });

  it('never puts the API key into error messages', async () => {
    const fetchMock = fetchSequence(apiError(400, 'INVALID_ARGUMENT', `Bad key ${KEY} and AIzaSyOTHERKEY_abcdefghijklmnopqrstuvw`));
    const err = await failure(client(fetchMock).generate(simpleReq));
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(err.message).toContain('<redacted>');

    const netErr = await failure(client(fetchSequence(new TypeError(`connect failed for ${KEY}`))).generate(simpleReq));
    expect(netErr.message).not.toContain(KEY);
  });
});

describe('abort', () => {
  it('already-aborted signal → aborted without calling fetch', async () => {
    const fetchMock = fetchSequence(jsonResponse(200, okBody('x')));
    const controller = new AbortController();
    controller.abort();
    const err = await failure(client(fetchMock).generate({ ...simpleReq, signal: controller.signal }));
    expect(err.kind).toBe('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('abort during fetch → aborted, no retry', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }),
    );
    const promise = client(fetchMock as unknown as typeof fetch).generate({ ...simpleReq, signal: controller.signal });
    controller.abort();
    const err = await failure(promise);
    expect(err.kind).toBe('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('abort during the retry delay → aborted', async () => {
    const controller = new AbortController();
    const fetchMock = fetchSequence(jsonResponse(500, { error: { code: 500 } }));
    const slow = createGeminiClient(KEY, { fetchImpl: fetchMock, retryDelayMs: 10_000 });
    const promise = slow.generate({ ...simpleReq, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const err = await failure(promise);
    expect(err.kind).toBe('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('abort while streaming → aborted', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(sse({ candidates: [{ content: { parts: [{ text: 'a' }] } }] })));
        controller.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    });
    const res = { ok: true, status: 200, body } as unknown as Response;
    const promise = client(fetchSequence(res)).stream({ ...simpleReq, signal: controller.signal }, () => controller.abort());
    const err = await failure(promise);
    expect(err.kind).toBe('aborted');
  });
});

describe('timeouts', () => {
  /** A fetch that never answers, but rejects like Chrome's fetch when its signal aborts. */
  const hangingFetch = () =>
    vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }),
    );

  /** A streaming response that sends `chunks` (one every `everyMs`), then stays silent; errors on abort. */
  const trickleFetch = (chunks: string[], everyMs: number) =>
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          chunks.forEach((text, i) =>
            setTimeout(() => c.enqueue(encoder.encode(sse({ candidates: [{ content: { parts: [{ text }] } }] }))), i * everyMs),
          );
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    });

  it('generate: a request with no answer times out as a network error (not aborted), without retry', async () => {
    const fetchMock = hangingFetch();
    const c = createGeminiClient(KEY, { fetchImpl: fetchMock as unknown as typeof fetch, retryDelayMs: 1, generateTimeoutMs: 30 });
    const err = await failure(c.generate(simpleReq));
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/timed out/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('generate: the caller aborting before the deadline is still "aborted"', async () => {
    const controller = new AbortController();
    const c = createGeminiClient(KEY, { fetchImpl: hangingFetch() as unknown as typeof fetch, generateTimeoutMs: 10_000 });
    const promise = c.generate({ ...simpleReq, signal: controller.signal });
    controller.abort();
    expect((await failure(promise)).kind).toBe('aborted');
  });

  it('listModels times out as a network error', async () => {
    const c = createGeminiClient(KEY, { fetchImpl: hangingFetch() as unknown as typeof fetch, listModelsTimeoutMs: 30 });
    const err = await failure(c.listModels());
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/timed out/);
  });

  it('stream: fails as a network "timed out" error when no chunk arrives for the idle timeout', async () => {
    const deltas: string[] = [];
    const c = createGeminiClient(KEY, { fetchImpl: trickleFetch(['a'], 0), streamIdleTimeoutMs: 40 });
    const err = await failure(c.stream(simpleReq, (t) => deltas.push(t)));
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/timed out/);
    expect(deltas).toEqual(['a']);
  });

  it('stream: the idle timer restarts on every chunk, so a slow but steady stream completes', async () => {
    // 5 chunks 25 ms apart = ~100 ms total, longer than the 60 ms idle timeout; then the stream ends.
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 5; i++) {
            setTimeout(() => {
              c.enqueue(encoder.encode(sse({ candidates: [{ content: { parts: [{ text: String(i) }] } }] })));
              if (i === 4) c.close();
            }, i * 25);
          }
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    });
    const c = createGeminiClient(KEY, { fetchImpl: fetchMock as unknown as typeof fetch, streamIdleTimeoutMs: 60 });
    const res = await c.stream(simpleReq, () => {});
    expect(res.text).toBe('01234');
  });
});

describe('listModels', () => {
  it('follows nextPageToken and keeps generateContent models', async () => {
    const fetchMock = fetchSequence(
      jsonResponse(200, {
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'page2',
      }),
      jsonResponse(200, {
        models: [{ name: 'models/gemini-3-pro-preview', displayName: 'Gemini 3 Pro Preview', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }],
      }),
    );
    const models = await client(fetchMock).listModels();

    expect(models).toEqual([
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536 },
      { id: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro Preview', inputTokenLimit: 1048576, outputTokenLimit: 65536 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url1 = String(fetchMock.mock.calls[0]![0]);
    const url2 = String(fetchMock.mock.calls[1]![0]);
    expect(url1).toBe(`${BASE}/models?pageSize=1000`);
    expect(url2).toBe(`${BASE}/models?pageSize=1000&pageToken=page2`);
    expect(url1 + url2).not.toContain(KEY);
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
  });

  it('maps an invalid key to auth', async () => {
    const fetchMock = fetchSequence(jsonResponse(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }));
    expect((await failure(client(fetchMock).listModels())).kind).toBe('auth');
  });
});
