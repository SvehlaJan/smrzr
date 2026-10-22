import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '@/src/llm/client';
import type { PipelineContext, ChatArgs } from '@/src/pipeline';
import type { ChatMessage } from '@/src/types';
import { makeRecord, META, VIDEO_ID, VideoHarness } from './fixtures';
import { memoryDb, messagingMock, pipelineMock, resetMocks } from './mocks';

vi.mock('@/src/messaging', async () => (await import('./mocks')).messagingMock);
vi.mock('@/src/telemetry', async () => (await import('./mocks')).telemetryMock);
vi.mock('@/src/pipeline', async () => (await import('./mocks')).pipelineMock);
vi.mock('@/src/storage/db', async () => (await import('./mocks')).dbMock);
vi.mock('@/src/llm/gemini', async () => (await import('./mocks')).geminiMock);

beforeEach(() => {
  resetMocks();
  messagingMock.requestVideoContext.mockResolvedValue({ ok: true, meta: META });
  memoryDb.set(VIDEO_ID, makeRecord());
});
afterEach(cleanup);

function message(role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `${role}-${text}`, role, text, focusPointId: null, citations: [], createdAt: 1, ...extra };
}

async function renderReady() {
  render(<VideoHarness />);
  await screen.findByRole('button', { name: /Weekend catch-up sleep/ });
}

describe('ChatDock', () => {
  it('shows and clears the focus chip from a point’s Discuss button', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Discuss point 1' }));
    expect(screen.getByText('Focus: #1 Weekend catch-up sleep fixes alertness')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear focus' }));
    expect(screen.queryByText(/Focus: #1/)).toBeNull();
  });

  it('quick action sends its prompt with the current focus and persists the turn', async () => {
    pipelineMock.sendChat.mockImplementation(async (_ctx: PipelineContext, _model: string, args: ChatArgs) => ({
      userMessage: message('user', args.userText, { focusPointId: args.focusPointId }),
      reply: message('model', 'Mostly supported [1].', {
        citations: [{ index: 1, title: 'Depner 2019', uri: 'https://example.org/depner' }],
        searchEntryPointHtml: '<div class="chip">sleep study</div>',
        usage: { model: 'pro-1', inputTokens: 1, outputTokens: 1, cachedTokens: 0, estCostUsd: 0.07 },
      }),
    }));
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Discuss point 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fact-check' }));

    await screen.findByText('Depner 2019'); // sources list
    const [, model, args] = pipelineMock.sendChat.mock.calls[0]!;
    expect(model).toBe('pro-1');
    expect(args).toMatchObject({ userText: 'Fact-check this.', focusPointId: 'p1', history: [] });

    const cite = screen.getByRole('link', { name: '[1]' });
    expect(cite.getAttribute('href')).toBe('https://example.org/depner');
    const iframe = document.querySelector('iframe.search-suggestions')!;
    expect(iframe.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    expect(iframe.getAttribute('srcdoc')).toContain('sleep study');
    expect(document.querySelector('.messages .chip')).toBeNull(); // never injected into our DOM

    const saved = memoryDb.get(VIDEO_ID)!;
    expect(saved.chat.map((m) => m.role)).toEqual(['user', 'model']);
    expect(saved.totalCostUsd).toBeCloseTo(0.1);
  });

  it('shows the user message and streams the reply; Stop aborts the request', async () => {
    let signal: AbortSignal | undefined;
    let push: (s: string) => void = () => {};
    pipelineMock.sendChat.mockImplementation(
      (ctx: PipelineContext, _model: string, args: ChatArgs) =>
        new Promise((_resolve, reject) => {
          signal = ctx.signal;
          push = (s) => args.onDelta?.(s);
          ctx.signal?.addEventListener('abort', () => reject(new LlmError('aborted', 'aborted')));
        }),
    );
    await renderReady();

    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Is that study real?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('Is that study real?')).toBeTruthy();
    expect(input.value).toBe('');
    act(() => push('In the video **the guest**'));
    expect(screen.getByText('the guest').tagName).toBe('STRONG');

    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText('the guest')).toBeNull());
    // Nothing persisted, no error shown, and the text is back in the box for a retry.
    expect(memoryDb.get(VIDEO_ID)?.chat).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.value).toBe('Is that study real?');
  });

  it('Shift+Enter does not send', async () => {
    await renderReady();
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(pipelineMock.sendChat).not.toHaveBeenCalled();
  });

  it('shows a friendly error card when Gemini fails', async () => {
    pipelineMock.sendChat.mockRejectedValue(new LlmError('429', 'quota', 429));
    await renderReady();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Gemini quota or billing limit reached.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Report issue/ })).toBeTruthy();
  });
});
