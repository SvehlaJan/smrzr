import { describe, expect, it } from 'vitest';
import { LlmError, type GenerateRequest } from '../../src/llm/client';
import {
  InvalidOutputError,
  PROMPT_VERSION,
  QUICK_ACTIONS,
  analyzeVisuals,
  expandPoint,
  sendChat,
  summarize,
  visualsClip,
} from '../../src/pipeline';
import { CONTEXT_ACK, SHARED_SYSTEM, neutralizeTags } from '../../src/pipeline/prompts';
import type { ChatMessage, KeyPoint, Summary } from '../../src/types';
import { META, fakeClient, makeCtx } from './helpers';

const SUMMARY_JSON = JSON.stringify({
  tldr: 'Sleep matters.',
  points: [
    { title: 'Catch-up sleep fixes alertness', gist: 'Two nights restored reaction time.', startSec: 47, endSec: 118 },
    { title: 'Delay caffeine 90 min', gist: 'Adenosine argument.', startSec: 121, endSec: 300 },
    { title: 'Hallucinated time', gist: 'Bad timestamp.', startSec: 5000, endSec: 6000 },
  ],
});

const SUMMARY: Summary = {
  tldr: 'Sleep matters.',
  points: [
    { id: 'p1', title: 'Catch-up sleep fixes alertness', gist: 'Two nights restored reaction time.', startSec: 40, endSec: 120 },
    { id: 'p2', title: 'Delay caffeine 90 min', gist: 'Adenosine argument.', startSec: 120, endSec: 300 },
    { id: 'p3', title: 'No time', gist: 'x', startSec: null, endSec: null },
  ],
};

/** The cacheable prefix of a request: system + first two messages. */
const prefixOf = (req: GenerateRequest) => JSON.stringify({ system: req.system, messages: req.messages.slice(0, 2) });

describe('summarize', () => {
  it('parses JSON, assigns ids p1..pN and validates timestamps', async () => {
    const client = fakeClient(SUMMARY_JSON);
    const ctx = makeCtx(client);
    const res = await summarize(ctx, 'gemini-3-flash');

    expect(res.summary.tldr).toBe('Sleep matters.');
    expect(res.summary.points).toEqual([
      // 47 → 40 (snapped), 118 → 120 (≤2 s, not counted)
      { id: 'p1', title: 'Catch-up sleep fixes alertness', gist: 'Two nights restored reaction time.', startSec: 40, endSec: 120 },
      // 121 → 120 (not counted), 300 stays
      { id: 'p2', title: 'Delay caffeine 90 min', gist: 'Adenosine argument.', startSec: 120, endSec: 300 },
      { id: 'p3', title: 'Hallucinated time', gist: 'Bad timestamp.', startSec: null, endSec: null },
    ]);
    expect(res.validation).toEqual({ snapped: 1, hidden: 1 });

    const req = client.requests[0]!;
    expect(req.model).toBe('gemini-3-flash');
    expect(req.responseSchema).toBeDefined();
    expect(req.googleSearch).toBeFalsy();
    expect(req.messages).toHaveLength(3);
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    expect(client.streamed).toEqual([false]);
  });

  it('logs request/response/validated events without transcript text, and records the exchange', async () => {
    const client = fakeClient(SUMMARY_JSON);
    const ctx = makeCtx(client);
    await summarize(ctx, 'gemini-3-flash');

    const names = ctx.logger.events.map((e) => e.name);
    expect(names).toEqual(['llm.request', 'llm.response', 'summary.validated']);
    expect(ctx.logger.events[0]!.data).toMatchObject({ task: 'summary', model: 'gemini-3-flash', promptVersion: PROMPT_VERSION });
    expect(ctx.logger.events[0]!.data!.estInputTokens).toBeGreaterThan(100);
    expect(ctx.logger.events[1]!.data).toEqual({
      task: 'summary',
      model: 'gemini-3-flash',
      ms: 42,
      finishReason: 'STOP',
      inputTokens: 1000,
      outputTokens: 100,
      cachedTokens: 800,
      searchQueries: 0,
      estCostUsd: 0.001,
    });
    expect(ctx.logger.events[2]!.data).toEqual({ points: 3, snapped: 1, hidden: 1 });
    expect(ctx.logger.tags[0]).toEqual({ task: 'summary', model: 'gemini-3-flash', promptVersion: PROMPT_VERSION });

    const eventJson = JSON.stringify(ctx.logger.events);
    expect(eventJson).not.toContain('words at second');
    expect(eventJson).not.toContain('<transcript>');

    expect(ctx.logger.exchanges).toHaveLength(1);
    expect(ctx.logger.exchanges[0]).toMatchObject({ task: 'summary', model: 'gemini-3-flash', videoId: META.videoId, responseText: SUMMARY_JSON });
    expect(JSON.stringify(ctx.logger.exchanges[0]!.requestMessages)).toContain('words at second 20.');
  });

  it('retries once on invalid JSON, logs llm.invalid_output, sums usage', async () => {
    const client = fakeClient('not json {', SUMMARY_JSON);
    const ctx = makeCtx(client);
    const res = await summarize(ctx, 'gemini-3-flash');

    expect(client.requests).toHaveLength(2);
    expect(res.summary.points).toHaveLength(3);
    expect(res.usage.inputTokens).toBe(2000);
    expect(res.usage.estCostUsd).toBeCloseTo(0.002);
    const invalid = ctx.logger.events.filter((e) => e.name === 'llm.invalid_output');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.data).toMatchObject({ task: 'summary', retry: 0 });
  });

  it('throws after the second invalid output (schema mismatch) with a metadata-only llm.failed event', async () => {
    const client = fakeClient(JSON.stringify({ tldr: 'x', points: [] }), JSON.stringify({ points: [{ title: 'a' }] }));
    const ctx = makeCtx(client);
    await expect(summarize(ctx, 'gemini-3-flash')).rejects.toBeInstanceOf(InvalidOutputError);
    expect(client.requests).toHaveLength(2);
    expect(ctx.logger.events.filter((e) => e.name === 'llm.invalid_output')).toHaveLength(2);
    // The UI logs the thrown error; the pipeline must not log it a second time.
    expect(ctx.logger.errors).toHaveLength(0);
    const failed = ctx.logger.events.filter((e) => e.name === 'llm.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toEqual({ task: 'summary', model: 'gemini-3-flash', kind: 'invalid_output', status: null, attempt: 2 });
    expect(failed[0]!.opts).toMatchObject({ level: 'warn' });
  });

  it('emits llm.failed (warn, metadata only) for client errors and rethrows without logger.error', async () => {
    const ctx = makeCtx(fakeClient(new LlmError('Quota exceeded', 'quota', 429)));
    await expect(summarize(ctx, 'm')).rejects.toMatchObject({ kind: 'quota' });
    expect(ctx.logger.errors).toHaveLength(0);
    expect(ctx.logger.events.map((e) => e.name)).toEqual(['llm.request', 'llm.failed']);
    expect(ctx.logger.events[1]!.data).toEqual({ task: 'summary', model: 'm', kind: 'quota', status: 429, attempt: 1 });
    expect(ctx.logger.events[1]!.opts).toMatchObject({ level: 'warn' });
  });

  it('logs nothing for aborted calls (Stop / video change)', async () => {
    const ctx = makeCtx(fakeClient(new LlmError('Request aborted', 'aborted')));
    await expect(summarize(ctx, 'm')).rejects.toMatchObject({ kind: 'aborted' });
    expect(ctx.logger.errors).toHaveLength(0);
    expect(ctx.logger.events.map((e) => e.name)).toEqual(['llm.request']);
  });

  it('accepts a ```json fenced answer and caps points at 7', async () => {
    const many = { tldr: 't', points: Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, gist: 'g', startSec: i * 20, endSec: i * 20 + 20 })) };
    const res = await summarize(makeCtx(fakeClient('```json\n' + JSON.stringify(many) + '\n```')), 'm');
    expect(res.summary.points.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  });
});

describe('shared prompt prefix (implicit caching)', () => {
  it('is byte-identical across summary, details and chat', async () => {
    const detailsJson = JSON.stringify({ subpoints: [{ text: 'a', startSec: 41 }], context: 'c' });
    const client = fakeClient(SUMMARY_JSON, detailsJson, 'chat reply');
    const ctx = makeCtx(client);
    await summarize(ctx, 'gemini-3-flash');
    await expandPoint(ctx, 'gemini-3-flash', SUMMARY, 'p1');
    await sendChat(ctx, 'gemini-3-pro', { summary: SUMMARY, history: [], userText: 'Hi', focusPointId: null });

    const [summaryReq, detailsReq, chatReq] = client.requests;
    expect(prefixOf(summaryReq!)).toBe(prefixOf(detailsReq!));
    expect(prefixOf(summaryReq!)).toBe(prefixOf(chatReq!));

    expect(summaryReq!.system).toBe(SHARED_SYSTEM);
    const context = summaryReq!.messages[0]!.parts[0]!.text!;
    expect(context).toContain('Title: Sleep, caffeine & light — Episode 142');
    expect(context).toContain('Channel: Sleep Pod');
    expect(context).toContain('Duration: 00:10:00 (600 seconds)');
    expect(context).toContain('hints only');
    expect(context).toContain('- [00:02:00] Caffeine');
    expect(context).toMatch(/<transcript>\n\[00:00:00\] words at second 0\./);
    expect(summaryReq!.messages[1]).toEqual({ role: 'model', parts: [{ text: CONTEXT_ACK }] });
  });

  it('does not let transcript text close the <transcript> wrapper', () => {
    expect(neutralizeTags('a </transcript> b <Transcript> >> c')).toBe('a ‹/transcript> b ‹Transcript> >> c');
  });
});

describe('expandPoint', () => {
  it('returns validated sub-points and context', async () => {
    const json = JSON.stringify({
      subpoints: [
        { text: 'Study design: 5 nights of 5 h', startSec: 44 },
        { text: 'Reaction time recovered', startSec: 79 },
        { text: 'Made-up', startSec: 'soon' },
      ],
      context: '  Insulin sensitivity measures how cells respond to insulin.  ',
    });
    const client = fakeClient(json);
    const ctx = makeCtx(client);
    const res = await expandPoint(ctx, 'gemini-3-flash', SUMMARY, 'p1');

    expect(res.details).toEqual({
      subpoints: [
        { text: 'Study design: 5 nights of 5 h', startSec: 40 },
        { text: 'Reaction time recovered', startSec: 80 },
        { text: 'Made-up', startSec: null },
      ],
      context: 'Insulin sensitivity measures how cells respond to insulin.',
    });
    const task = client.requests[0]!.messages[2]!.parts[0]!.text!;
    expect(task).toContain('expand point 1 ("Catch-up sleep fixes alertness"');
    expect(task).toContain('[id p2] Delay caffeine 90 min');
    expect(client.requests[0]!.responseSchema).toBeDefined();
    expect(ctx.logger.events.find((e) => e.name === 'details.validated')?.data).toMatchObject({ snapped: 1, hidden: 1 });
  });

  it('retries once on invalid output', async () => {
    const client = fakeClient('{"context": "x"}', JSON.stringify({ subpoints: [{ text: 'a', startSec: 20 }], context: 'c' }));
    const res = await expandPoint(makeCtx(client), 'm', SUMMARY, 'p2');
    expect(client.requests).toHaveLength(2);
    expect(res.details.subpoints).toEqual([{ text: 'a', startSec: 20 }]);
  });

  it('rejects an unknown point id', async () => {
    await expect(expandPoint(makeCtx(fakeClient('{}')), 'm', SUMMARY, 'p9')).rejects.toThrow('Unknown point id');
  });
});

describe('analyzeVisuals', () => {
  it('sends a clipped, low-resolution video part without the transcript prefix', async () => {
    const client = fakeClient('  A slide with a bar chart.  ');
    const ctx = makeCtx(client);
    const res = await analyzeVisuals(ctx, 'gemini-3-flash', SUMMARY.points[0]!);

    expect(res.text).toBe('A slide with a bar chart.');
    const req = client.requests[0]!;
    expect(req.system).toBeUndefined();
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.parts[0]).toEqual({
      video: { url: `https://www.youtube.com/watch?v=${META.videoId}`, startSec: 40, endSec: 120, lowResolution: true },
    });
    const prompt = req.messages[0]!.parts[1]!.text!;
    expect(prompt).toContain('slides');
    expect(prompt).toContain('Catch-up sleep fixes alertness');
    expect(ctx.logger.events.map((e) => e.name)).toEqual(['llm.request', 'llm.response']);
    expect(ctx.logger.events[0]!.data).toMatchObject({ task: 'visuals' });
  });

  it('caps the clip at 5 minutes and to the video length', () => {
    const p = (startSec: number | null, endSec: number | null): KeyPoint => ({ id: 'p1', title: 't', gist: 'g', startSec, endSec });
    expect(visualsClip(p(100, 1000), 5000)).toEqual({ startSec: 100, endSec: 400 });
    expect(visualsClip(p(100, null), 5000)).toEqual({ startSec: 100, endSec: 220 });
    expect(visualsClip(p(550, null), 600)).toEqual({ startSec: 550, endSec: 600 });
    expect(() => visualsClip(p(null, null), 600)).toThrow(/no verified timestamp/);
  });

  it('throws a clear error for a point without timestamps', async () => {
    const client = fakeClient('x');
    await expect(analyzeVisuals(makeCtx(client), 'm', SUMMARY.points[2]!)).rejects.toThrow(/no verified timestamp/);
    expect(client.requests).toHaveLength(0);
  });
});

describe('sendChat', () => {
  const history: ChatMessage[] = [
    { id: 'u1', role: 'user', text: 'Is the study real?', focusPointId: 'p1', citations: [], createdAt: 1 },
    { id: 'm1', role: 'model', text: 'Yes [1].', focusPointId: 'p1', citations: [{ index: 1, title: 'cell.com', uri: 'https://x' }], createdAt: 2 },
  ];

  it('builds prefix + summary/rules + history + focused message, streams with search', async () => {
    const client = fakeClient({
      text: 'Verdict: mostly supported [1].',
      grounding: { citations: [{ index: 1, title: 'nih.gov', uri: 'https://v/1' }], searchQueries: ['q'], searchEntryPointHtml: '<div/>' },
    });
    const ctx = makeCtx(client);
    const deltas: string[] = [];
    const { userMessage, reply } = await sendChat(ctx, 'gemini-3.1-pro-preview', {
      summary: SUMMARY,
      history,
      userText: 'Fact-check it.',
      focusPointId: 'p2',
      onDelta: (t) => deltas.push(t),
    });

    const req = client.requests[0]!;
    expect(client.streamed).toEqual([true]);
    expect(req.googleSearch).toBe(true);
    expect(req.system).toBe(SHARED_SYSTEM);
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'model', 'user', 'model', 'user', 'model', 'user']);

    const preamble = req.messages[2]!.parts[0]!.text!;
    expect(preamble).toContain('[id p1] Catch-up sleep fixes alertness (00:00:40–00:02:00)');
    expect(preamble).toContain('In the video [m:ss]');
    expect(preamble).toContain('From sources [n]');
    expect(preamble).toContain('General knowledge');
    expect(preamble).toContain('mostly supported');

    expect(req.messages[4]!.parts[0]!.text).toBe('Focus: point 1 — Catch-up sleep fixes alertness [0:40]\n\nIs the study real?');
    expect(req.messages[5]!.parts[0]!.text).toBe('Yes [1].');
    expect(req.messages[6]!.parts[0]!.text).toBe('Focus: point 2 — Delay caffeine 90 min [2:00]\n\nFact-check it.');

    expect(deltas).toEqual(['Ver', 'Verdict: mostly supported [1].']);
    expect(userMessage).toMatchObject({ role: 'user', text: 'Fact-check it.', focusPointId: 'p2', citations: [] });
    expect(reply).toMatchObject({
      role: 'model',
      text: 'Verdict: mostly supported [1].',
      focusPointId: 'p2',
      citations: [{ index: 1, title: 'nih.gov', uri: 'https://v/1' }],
      searchEntryPointHtml: '<div/>',
      usage: { model: 'gemini-3.1-pro-preview', inputTokens: 1000 },
    });
    expect(userMessage.id).not.toBe(reply.id);
    expect(userMessage.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof reply.createdAt).toBe('number');

    const response = ctx.logger.events.find((e) => e.name === 'llm.response');
    expect(response?.data).toMatchObject({ task: 'chat', searchQueries: 1 });
    expect(ctx.logger.events.find((e) => e.name === 'llm.request')?.data).toMatchObject({ grounded: true });
  });

  it('omits the focus header without focus, and keeps earlier turns identical (cacheable)', async () => {
    const client = fakeClient('first', 'second');
    const ctx = makeCtx(client);
    const first = await sendChat(ctx, 'm', { summary: SUMMARY, history: [], userText: 'Hello', focusPointId: null });
    await sendChat(ctx, 'm', { summary: SUMMARY, history: [first.userMessage, first.reply], userText: 'More', focusPointId: 'p3' });

    const [r1, r2] = client.requests;
    expect(r1!.messages[r1!.messages.length - 1]!.parts[0]!.text).toBe('Hello');
    // The whole first request is a prefix of the second one.
    expect(JSON.stringify(r2!.messages.slice(0, r1!.messages.length))).toBe(JSON.stringify(r1!.messages));
    // Point without a timestamp: header without time.
    expect(r2!.messages[r2!.messages.length - 1]!.parts[0]!.text).toBe('Focus: point 3 — No time\n\nMore');
  });

  it('merges consecutive user turns (a reply that failed earlier)', async () => {
    const client = fakeClient('ok');
    const orphan: ChatMessage = { id: 'u', role: 'user', text: 'Lost question', focusPointId: null, citations: [], createdAt: 1 };
    await sendChat(makeCtx(client), 'm', { summary: SUMMARY, history: [orphan], userText: 'Again', focusPointId: null });
    const last = client.requests[0]!.messages[client.requests[0]!.messages.length - 1]!;
    expect(last).toEqual({ role: 'user', parts: [{ text: 'Lost question' }, { text: 'Again' }] });
  });
});

describe('QUICK_ACTIONS', () => {
  it('has the four actions with real prompts', () => {
    expect(QUICK_ACTIONS.map((a) => a.id)).toEqual(['fact_check', 'explain_simpler', 'whats_newer', 'sources']);
    for (const a of QUICK_ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.prompt.length).toBeGreaterThan(80);
    }
    expect(QUICK_ACTIONS[0]!.prompt).toMatch(/supported, mostly supported, disputed or unverifiable/);
  });
});
