// Uses a real happy-dom Window: its postMessage is async and sets event.source to the win,
// like the browser. (Vitest's global `window` is a wrapper, so event.source wouldn't match it.)
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEvent } from '../../src/types';
import {
  BridgeRemoteError,
  BridgeTimeoutError,
  createBridgeClient,
  createBridgeServer,
  type BridgeClient,
  type BridgeHandlers,
  type BridgeServer,
} from '../../src/transcript/bridge';

let client: BridgeClient | undefined;
let server: BridgeServer | undefined;
let happy: HappyWindow;
let win: Window;

beforeEach(() => {
  happy = new HappyWindow({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  win = happy as unknown as Window;
});

afterEach(async () => {
  client?.dispose();
  server?.dispose();
  client = server = undefined;
  await happy.happyDOM.close();
});

function handlers(over: Partial<BridgeHandlers> = {}): BridgeHandlers {
  return {
    getVideoContext: async () => ({ ok: false, error: 'not_a_video_page' }),
    getTranscript: async () => ({ ok: false, error: 'live', attempts: [] }),
    ...over,
  };
}

describe('bridge', () => {
  it('matches responses to requests, even when answered out of order', async () => {
    const slow = new Promise<void>((r) => setTimeout(r, 30));
    server = createBridgeServer(
      win,
      handlers({
        getTranscript: async (videoId) => {
          if (videoId === 'slow') await slow;
          return { ok: false, error: 'all_strategies_failed', attempts: [{ strategy: 'player', outcome: 'error', ms: 0, detail: videoId }] };
        },
      }),
    );
    client = createBridgeClient(win);
    const [a, b] = await Promise.all([
      client.request({ type: 'getTranscript', videoId: 'slow' }),
      client.request({ type: 'getTranscript', videoId: 'fast' }),
    ]);
    expect(a.attempts[0]!.detail).toBe('slow');
    expect(b.attempts[0]!.detail).toBe('fast');
  });

  it('routes getVideoContext', async () => {
    server = createBridgeServer(win, handlers());
    client = createBridgeClient(win);
    await expect(client.request({ type: 'getVideoContext' })).resolves.toEqual({ ok: false, error: 'not_a_video_page' });
  });

  it('rejects with BridgeRemoteError when the handler throws', async () => {
    server = createBridgeServer(win, handlers({ getVideoContext: async () => { throw new Error('boom'); } }));
    client = createBridgeClient(win);
    await expect(client.request({ type: 'getVideoContext' })).rejects.toBeInstanceOf(BridgeRemoteError);
  });

  it('times out when nobody answers (MAIN script missing)', async () => {
    client = createBridgeClient(win);
    await expect(client.request({ type: 'getVideoContext' }, 30)).rejects.toBeInstanceOf(BridgeTimeoutError);
  });

  it('ignores untagged messages, wrong directions and unknown request ids', async () => {
    const getVideoContext = vi.fn(async () => ({ ok: false as const, error: 'not_a_video_page' as const }));
    server = createBridgeServer(win, handlers({ getVideoContext }));
    client = createBridgeClient(win);
    win.postMessage({ type: 'getVideoContext' }, '*'); // untagged
    win.postMessage({ __smrzr: true, dir: 'to-isolated', kind: 'response', requestId: 'nope', response: 1 }, '*');
    await new Promise((r) => setTimeout(r, 20));
    expect(getVideoContext).not.toHaveBeenCalled();
    // The real request still works afterwards.
    await expect(client.request({ type: 'getVideoContext' })).resolves.toMatchObject({ ok: false });
    expect(getVideoContext).toHaveBeenCalledTimes(1);
  });

  it('delivers MAIN-world log events, forcing component "main"', async () => {
    server = createBridgeServer(win, handlers());
    client = createBridgeClient(win);
    const received: LogEvent[] = [];
    client.onLog((e) => received.push(e));
    server.log('transcript.captured', { hasPot: true }, { level: 'debug', videoId: 'vid' });
    // A forged event from the page with a bogus component/level gets normalized.
    win.postMessage({ __smrzr: true, dir: 'to-isolated', kind: 'log', event: { name: 'x', component: 'panel', level: 'fatal' } }, '*');
    win.postMessage({ __smrzr: true, dir: 'to-isolated', kind: 'log', event: { nope: 1 } }, '*');
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ component: 'main', level: 'debug', name: 'transcript.captured', videoId: 'vid', data: { hasPot: true } });
    expect(received[1]).toMatchObject({ component: 'main', level: 'info', name: 'x' });
  });

  it('caps oversized log data', async () => {
    server = createBridgeServer(win, handlers());
    client = createBridgeClient(win);
    const received: LogEvent[] = [];
    client.onLog((e) => received.push(e));
    server.log('big', { blob: 'x'.repeat(5000) });
    await new Promise((r) => setTimeout(r, 20));
    expect(received[0]!.data).toEqual({ truncated: true, chars: expect.any(Number) });
  });
});
