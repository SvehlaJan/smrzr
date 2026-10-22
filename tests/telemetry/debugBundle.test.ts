import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { db, putVideo } from '../../src/storage/db';
import { saveSettings } from '../../src/storage/settings';
import {
  buildDebugBundle,
  copyDebugBundle,
  createLogger,
  flushPendingWrites,
  getLogDb,
  resetTelemetryForTests,
} from '../../src/telemetry';
import type { LogEvent, VideoRecord } from '../../src/types';

const KEY = 'AIza' + 'b'.repeat(35);

function video(videoId: string): VideoRecord {
  return {
    videoId,
    title: 'A podcast',
    channel: 'Chan',
    durationSec: 9000,
    transcript: { videoId, language: 'en', kind: 'asr', source: 'player', segments: [{ start: 0, dur: 3, text: `my key is ${KEY}` }] },
    summary: { tldr: 'tl;dr', points: [{ id: 'p1', title: 't', gist: 'g', startSec: 1, endSec: 2 }] },
    details: { p1: { subpoints: [{ text: 's', startSec: 1 }], context: 'c' } },
    chat: [{ id: 'm1', role: 'user', text: 'hi', focusPointId: 'p1', citations: [], createdAt: 1 }],
    promptVersion: 3,
    totalCostUsd: 0.04,
    createdAt: 1,
    lastOpenedAt: 2,
  };
}

beforeEach(async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 'smrzr', version: '1.2.3' });
  vi.stubEnv('WXT_GEMINI_API_KEY', '');
  await resetTelemetryForTests();
  const logDb = getLogDb();
  await Promise.all([logDb.events.clear(), logDb.exchanges.clear(), db.videos.clear()]);
});

describe('buildDebugBundle', () => {
  it('has the documented shape', async () => {
    await putVideo(video('v1'));
    const bundle = await buildDebugBundle('v1');
    expect(Object.keys(bundle).sort()).toEqual(
      ['createdAt', 'events', 'exchanges', 'extensionVersion', 'settings', 'userAgent', 'video', 'videoId'].sort(),
    );
    expect(bundle.extensionVersion).toBe('1.2.3');
    expect(new Date(bundle.createdAt).toISOString()).toBe(bundle.createdAt);
    expect(bundle.userAgent).toBe(navigator.userAgent);
    expect(bundle.videoId).toBe('v1');
    // The full record: summary, details, chat and transcript (scrubbed).
    expect(bundle.video?.summary?.tldr).toBe('tl;dr');
    expect(bundle.video?.details.p1?.context).toBe('c');
    expect(bundle.video?.chat).toHaveLength(1);
    expect(bundle.video?.transcript.segments[0]?.text).toBe('my key is <redacted>');
  });

  it('redacts the API key in settings, or marks it empty', async () => {
    expect((await buildDebugBundle(null)).settings.apiKey).toBe('<empty>');

    const saved = await saveSettings({ apiKey: KEY, models: { summary: 'flash', details: 'flash', visuals: 'flash', chat: 'pro' } });
    const bundle = await buildDebugBundle(null);
    expect(bundle.settings).toEqual({ ...saved, apiKey: '<redacted>' });
    expect(JSON.stringify(bundle)).not.toContain(KEY);
  });

  it('includes this video’s events plus the last 100 global events, deduplicated and sorted', async () => {
    const logDb = getLogDb();
    const events: LogEvent[] = [];
    // 5 old events for v1, then 150 events for other videos, then 1 more for v1.
    for (let i = 0; i < 5; i++) events.push({ ts: i, component: 'panel', level: 'info', name: `v1-old${i}`, videoId: 'v1' });
    for (let i = 0; i < 150; i++) events.push({ ts: 100 + i, component: 'panel', level: 'info', name: `other${i}`, videoId: 'v2' });
    events.push({ ts: 1000, component: 'content', level: 'warn', name: 'v1-new', videoId: 'v1' });
    await logDb.events.bulkAdd(events);

    const bundle = await buildDebugBundle('v1');
    const names = bundle.events.map((e) => e.name);
    expect(names.slice(0, 5)).toEqual(['v1-old0', 'v1-old1', 'v1-old2', 'v1-old3', 'v1-old4']);
    expect(names).toContain('other149');
    expect(names).toContain('other51'); // the last 100 globals = other51..other149 + v1-new
    expect(names).not.toContain('other50');
    expect(names.filter((n) => n === 'v1-new')).toHaveLength(1); // in both lists, included once
    expect(bundle.events).toHaveLength(5 + 99 + 1);
    const ts = bundle.events.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('includes only this video’s exchanges', async () => {
    const log = createLogger('panel');
    const base = { task: 'summary', model: 'm', requestMessages: [{ text: `?key=${KEY}` }], responseText: 'r', finishReason: 'STOP', latencyMs: 1 };
    log.recordExchange({ ...base, ts: 1, videoId: 'v1' });
    log.recordExchange({ ...base, ts: 2, videoId: 'v2' });
    log.recordExchange({ ...base, ts: 3, videoId: 'v1' });
    await flushPendingWrites();

    const bundle = await buildDebugBundle('v1');
    expect(bundle.exchanges.map((x) => x.ts)).toEqual([1, 3]);
    expect(JSON.stringify(bundle.exchanges)).not.toContain(KEY);
  });

  it('works without a video id or a stored record', async () => {
    createLogger('panel').event('global');
    const noVideo = await buildDebugBundle(null); // also waits for the pending write
    expect(noVideo.video).toBeNull();
    expect(noVideo.exchanges).toEqual([]);
    expect(noVideo.events.map((e) => e.name)).toEqual(['global']);

    expect((await buildDebugBundle('unknown')).video).toBeNull();
  });

  it('falls back to "unknown" when the manifest is unavailable', async () => {
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockImplementation(() => {
      throw new Error('not available');
    });
    expect((await buildDebugBundle(null)).extensionVersion).toBe('unknown');
  });
});

describe('copyDebugBundle', () => {
  it('returns pretty-printed JSON of the bundle', async () => {
    await putVideo(video('v1'));
    const json = await copyDebugBundle('v1');
    expect(json).toContain('\n  "videoId": "v1"');
    expect(JSON.parse(json).video.title).toBe('A podcast');
    expect(json).not.toContain(KEY);
  });
});
