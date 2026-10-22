import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  createLogger,
  flushPendingWrites,
  getLogDb,
  getRecentEvents,
  handleForwardedLog,
  resetTelemetryForTests,
  type LlmExchange,
} from '../../src/telemetry';
import { MAX_EVENTS, MAX_EXCHANGES } from '../../src/telemetry/eventLog';
import type { LogEvent } from '../../src/types';

const KEY = 'AIza' + 'Q'.repeat(35);

function exchange(videoId: string, i = 0): LlmExchange {
  return {
    ts: 1000 + i,
    videoId,
    task: 'summary',
    model: 'gemini-flash',
    requestMessages: [{ role: 'user', text: 'prompt' }],
    responseText: '{}',
    finishReason: 'STOP',
    latencyMs: 10,
  };
}

beforeEach(async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {}); // dev-mode event echo
  fakeBrowser.reset();
  await resetTelemetryForTests();
  const db = getLogDb();
  await Promise.all([db.events.clear(), db.exchanges.clear()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('panel/background logger', () => {
  it('writes events with component, level, videoId and data', async () => {
    const log = createLogger('panel');
    log.event('transcript.attempt', { strategy: 'player', outcome: 'ok' }, { videoId: 'v1' });
    log.event('ui.action', { action: 'summarize' }, { level: 'debug' });
    await flushPendingWrites();

    const events = await getRecentEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      component: 'panel',
      level: 'info',
      name: 'transcript.attempt',
      videoId: 'v1',
      data: { strategy: 'player', outcome: 'ok' },
    });
    expect(events[1]).toMatchObject({ level: 'debug', name: 'ui.action' });
    expect(events[1]).not.toHaveProperty('videoId');
  });

  it('uses the videoId tag as the default videoId', async () => {
    const log = createLogger('panel');
    log.setTags({ videoId: 'tagged', model: 'm' });
    log.event('a');
    log.event('b', undefined, { videoId: 'explicit' });
    log.setTags({ videoId: undefined });
    log.event('c');
    await flushPendingWrites();
    const events = await getRecentEvents();
    expect(events.map((e) => e.videoId)).toEqual(['tagged', 'explicit', undefined]);
  });

  it('logs errors as level "error" events with message and stack', async () => {
    const log = createLogger('background');
    log.error(new Error('boom'), { videoId: 'v9', where: 'test' });
    await flushPendingWrites();
    const [e] = await getRecentEvents();
    expect(e).toMatchObject({ component: 'background', level: 'error', name: 'error', videoId: 'v9' });
    expect(e?.data).toMatchObject({ message: 'boom', errorName: 'Error', where: 'test' });
    expect(typeof e?.data?.stack).toBe('string');
  });

  it('scrubs secrets from event data before storing it', async () => {
    createLogger('panel').event('llm.request', { url: `https://x/?key=${KEY}`, note: KEY });
    await flushPendingWrites();
    const [e] = await getRecentEvents();
    expect(JSON.stringify(e)).not.toContain(KEY);
  });

  it('getRecentEvents filters by video and returns the newest N, oldest first', async () => {
    const log = createLogger('panel');
    for (let i = 0; i < 5; i++) log.event(`e${i}`, undefined, { videoId: i % 2 ? 'odd' : 'even' });
    await flushPendingWrites();
    expect((await getRecentEvents({ videoId: 'even' })).map((e) => e.name)).toEqual(['e0', 'e2', 'e4']);
    expect((await getRecentEvents({ limit: 2 })).map((e) => e.name)).toEqual(['e3', 'e4']);
    expect((await getRecentEvents({ videoId: 'odd', limit: 1 })).map((e) => e.name)).toEqual(['e3']);
  });

  it('records exchanges', async () => {
    createLogger('panel').recordExchange(exchange('v1'));
    await flushPendingWrites();
    expect(await getLogDb().exchanges.count()).toBe(1);
  });
});

describe('ring buffers', () => {
  it(`keeps at most ${MAX_EVENTS} events, dropping the oldest`, async () => {
    const db = getLogDb();
    await db.events.bulkAdd(
      Array.from({ length: MAX_EVENTS + 100 }, (_, i): LogEvent => ({ ts: i, component: 'panel', level: 'info', name: `old${i}` })),
    );
    const log = createLogger('panel');
    log.event('newest'); // first write in this context → trims
    await flushPendingWrites();

    expect(await db.events.count()).toBe(MAX_EVENTS);
    const all = await db.events.toArray();
    expect(all[0]?.name).toBe('old101');
    expect(all.at(-1)?.name).toBe('newest');
  });

  it('trims only every ~50 writes, not on every write', async () => {
    const db = getLogDb();
    await db.events.bulkAdd(
      Array.from({ length: MAX_EVENTS }, (_, i): LogEvent => ({ ts: i, component: 'panel', level: 'info', name: `old${i}` })),
    );
    const log = createLogger('panel');
    log.event('first'); // trims → 1000
    await flushPendingWrites();
    for (let i = 0; i < 10; i++) log.event(`more${i}`);
    await flushPendingWrites();
    expect(await db.events.count()).toBe(MAX_EVENTS + 10);

    for (let i = 0; i < 40; i++) log.event(`fill${i}`); // the 51st write trims again
    await flushPendingWrites();
    expect(await db.events.count()).toBe(MAX_EVENTS);
  });

  it(`keeps at most ${MAX_EXCHANGES} exchanges`, async () => {
    const db = getLogDb();
    await db.exchanges.bulkAdd(Array.from({ length: MAX_EXCHANGES + 10 }, (_, i) => exchange('v', i)));
    createLogger('panel').recordExchange(exchange('latest'));
    await flushPendingWrites();
    expect(await db.exchanges.count()).toBe(MAX_EXCHANGES);
    expect((await db.exchanges.toArray()).at(-1)?.videoId).toBe('latest');
  });
});

describe('logger never throws', () => {
  it('survives IndexedDB writes failing (sync throw and rejection)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = getLogDb();
    vi.spyOn(db.events, 'add').mockImplementationOnce(() => {
      throw new Error('sync failure');
    });
    vi.spyOn(db.exchanges, 'add').mockRejectedValueOnce(new Error('QuotaExceededError'));

    const log = createLogger('panel');
    expect(() => log.event('x')).not.toThrow();
    expect(() => log.recordExchange(exchange('v'))).not.toThrow();
    await expect(flushPendingWrites()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('survives a closed database', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = getLogDb();
    db.close({ disableAutoOpen: true });
    try {
      const log = createLogger('background');
      expect(() => log.event('x')).not.toThrow();
      expect(() => log.error(new Error('y'))).not.toThrow();
      await expect(flushPendingWrites()).resolves.toBeUndefined();
    } finally {
      await db.open();
    }
  });

  it('survives unserializable data', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cyclic: Record<string, unknown> = { fn: () => 1 };
    cyclic.self = cyclic;
    const log = createLogger('panel');
    expect(() => log.event('weird', cyclic)).not.toThrow();
    expect(() => log.error({ not: 'an error' })).not.toThrow();
    expect(() => log.error(undefined)).not.toThrow();
    await flushPendingWrites();
    expect(await getLogDb().events.count()).toBe(3);
  });
});

describe('content/main logger', () => {
  it('forwards events via runtime.sendMessage and writes nothing locally', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const log = createLogger('content');
    log.setTags({ videoId: 'vid1' });
    log.event('transcript.attempt', { strategy: 'panel', outcome: 'empty_200' }, { level: 'warn' });
    log.error(new Error('dom timeout'), { strategy: 'dom' });
    log.recordExchange(exchange('vid1')); // no-op

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'log',
      event: { component: 'content', level: 'warn', name: 'transcript.attempt', videoId: 'vid1', data: { strategy: 'panel', outcome: 'empty_200' } },
    });
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      type: 'log',
      event: { component: 'content', level: 'error', name: 'error', videoId: 'vid1', data: { message: 'dom timeout', strategy: 'dom' } },
    });
    const forwardedStack = (send.mock.calls[1]?.[0] as unknown as { event: LogEvent }).event.data?.stack;
    expect(typeof forwardedStack).toBe('string');
    expect((forwardedStack as string).length).toBeLessThanOrEqual(2000);

    await flushPendingWrites();
    expect(await getLogDb().events.count()).toBe(0);
  });

  it('does not throw when there is no receiver', () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('Receiving end does not exist'));
    expect(() => createLogger('main').event('x')).not.toThrow();
  });
});

describe('handleForwardedLog', () => {
  it('stores valid events, keeping component and videoId', async () => {
    await handleForwardedLog({ ts: 5, component: 'main', level: 'warn', name: 'transcript.attempt', videoId: 'v1', data: { a: 1 } });
    const [e] = await getRecentEvents();
    expect(e).toMatchObject({ ts: 5, component: 'main', level: 'warn', name: 'transcript.attempt', videoId: 'v1', data: { a: 1 } });
  });

  it('ignores malformed events and normalizes bad fields', async () => {
    await handleForwardedLog(null as unknown as LogEvent);
    await handleForwardedLog({ nope: true } as unknown as LogEvent);
    await handleForwardedLog({ ts: 'x', component: 'evil', level: 'loud', name: 'ok', data: 'str' } as unknown as LogEvent);
    const events = await getRecentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ component: 'content', level: 'info', name: 'ok' });
    expect(events[0]).not.toHaveProperty('data');
    expect(typeof events[0]?.ts).toBe('number');
  });

  it('caps the data size and scrubs secrets', async () => {
    await handleForwardedLog({ ts: 1, component: 'content', level: 'info', name: 'big', data: { blob: 'x'.repeat(10_000), k: KEY } });
    const [e] = await getRecentEvents();
    expect(JSON.stringify(e?.data).length).toBeLessThanOrEqual(4096);
    expect(e?.data).toMatchObject({ truncated: true });
    expect(JSON.stringify(e)).not.toContain(KEY);
  });
});
