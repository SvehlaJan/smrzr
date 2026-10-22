// Sentry wiring, exercised end-to-end with an in-memory transport (no network).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { db, putVideo } from '../../src/storage/db';
import { saveSettings } from '../../src/storage/settings';
import {
  createLogger,
  getLogDb,
  getRecentEvents,
  handleForwardedLog,
  initTelemetry,
  isSentryEnabled,
  resetTelemetryForTests,
  sendIssueReport,
  withSpan,
} from '../../src/telemetry';
import { setSentryTransportForTests } from '../../src/telemetry/sentry';
import type { VideoRecord } from '../../src/types';

const KEY = 'AIza' + 'c'.repeat(35);
const KEY_PATTERN = /AIza[0-9A-Za-z_-]{35}/;
const DSN = 'https://publickey@o123.ingest.de.sentry.io/456';

// Envelope = [headers, [[itemHeader, payload], ...]]
type EnvelopeItem = [{ type: string; filename?: string; content_type?: string }, unknown];
type Envelope = [Record<string, unknown>, EnvelopeItem[]];

let envelopes: Envelope[] = [];
let statusCode = 200;

function items(type: string): EnvelopeItem[] {
  return envelopes.flatMap((env) => env[1]).filter(([header]) => header.type === type);
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : v));
}

function video(videoId: string): VideoRecord {
  return {
    videoId,
    title: 'Talk',
    channel: 'Chan',
    durationSec: 60,
    transcript: { videoId, language: 'en', kind: 'manual', source: 'player', segments: [{ start: 0, dur: 1, text: `leaked ${KEY}` }] },
    details: {},
    chat: [],
    promptVersion: 1,
    totalCostUsd: 0,
    createdAt: 1,
    lastOpenedAt: 1,
  };
}

beforeEach(async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 'smrzr', version: '0.1.0' });
  vi.stubEnv('WXT_GEMINI_API_KEY', '');
  vi.stubEnv('WXT_SENTRY_DSN', DSN);

  envelopes = [];
  statusCode = 200;
  setSentryTransportForTests(() => ({
    send: async (envelope) => {
      envelopes.push(envelope as unknown as Envelope);
      return { statusCode };
    },
    flush: async () => true,
  }));

  await resetTelemetryForTests();
  const logDb = getLogDb();
  await Promise.all([logDb.events.clear(), logDb.exchanges.clear(), db.videos.clear()]);
});

afterEach(async () => {
  await resetTelemetryForTests();
  setSentryTransportForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('initTelemetry', () => {
  it('stays disabled without a DSN', () => {
    vi.stubEnv('WXT_SENTRY_DSN', '');
    initTelemetry({ component: 'panel', enabled: true });
    expect(isSentryEnabled()).toBe(false);
  });

  it('stays disabled when the user turned Sentry off', () => {
    initTelemetry({ component: 'panel', enabled: false });
    expect(isSentryEnabled()).toBe(false);
  });

  it('is idempotent and can be toggled', () => {
    initTelemetry({ component: 'panel', enabled: true });
    initTelemetry({ component: 'panel', enabled: true });
    expect(isSentryEnabled()).toBe(true);
    initTelemetry({ component: 'panel', enabled: false });
    expect(isSentryEnabled()).toBe(false);
    initTelemetry({ component: 'panel', enabled: true });
    expect(isSentryEnabled()).toBe(true);
  });
});

describe('error capture', () => {
  it('sends errors with tags and recent events as breadcrumbs, scrubbed', async () => {
    initTelemetry({ component: 'panel', enabled: true });
    const log = createLogger('panel');
    log.setTags({ videoId: 'v1', task: 'summary', model: 'gemini-flash', promptVersion: 2 });
    log.event('llm.request', { task: 'summary', url: `https://g/?key=${KEY}` });
    log.error(new Error(`request failed for ${KEY}`), { status: 500 });

    await vi.waitFor(() => expect(items('event')).toHaveLength(1));
    const event = items('event')[0]![1] as {
      tags: Record<string, unknown>;
      release: string;
      environment: string;
      breadcrumbs: { category: string; data?: Record<string, unknown> }[];
      contexts: Record<string, Record<string, unknown>>;
    };
    expect(event.tags).toMatchObject({ videoId: 'v1', task: 'summary', model: 'gemini-flash', promptVersion: 2, component: 'panel' });
    expect(event.release).toBe('smrzr@0.1.0');
    expect(event.environment).toBe(import.meta.env.MODE);
    expect(event.breadcrumbs.map((b) => b.category)).toContain('llm.request');
    expect(event.contexts.details).toEqual({ status: 500 });
    expect(serialize(envelopes)).not.toMatch(KEY_PATTERN);
  });

  it('reports errors forwarded from the YouTube tab with their component', async () => {
    initTelemetry({ component: 'background', enabled: true });
    await handleForwardedLog({
      ts: Date.now(),
      component: 'content',
      level: 'error',
      name: 'error',
      videoId: 'v7',
      data: { message: 'seek failed', errorName: 'TypeError', strategy: 'dom' },
    });
    await vi.waitFor(() => expect(items('event')).toHaveLength(1));
    const event = items('event')[0]![1] as { tags: Record<string, unknown>; exception: { values: { type: string; value: string }[] } };
    expect(event.tags).toMatchObject({ component: 'content', videoId: 'v7' });
    expect(event.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'seek failed' });
  });

  it('logs uncaught errors of our own page through the logger', async () => {
    initTelemetry({ component: 'panel', enabled: true });
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('uncaught!'), message: 'uncaught!' }));
    await vi.waitFor(async () => expect((await getRecentEvents()).some((e) => e.data?.message === 'uncaught!')).toBe(true));
    await vi.waitFor(() => expect(items('event')).toHaveLength(1));
  });
});

describe('sendIssueReport', () => {
  it('returns sentry_disabled when Sentry is off, and logs ui.report', async () => {
    initTelemetry({ component: 'panel', enabled: false });
    expect(await sendIssueReport({ message: 'hi', videoId: 'v1' })).toEqual({ ok: false, reason: 'sentry_disabled' });
    await vi.waitFor(async () => expect((await getRecentEvents()).map((e) => e.name)).toContain('ui.report'));
    expect(envelopes).toHaveLength(0);
  });

  it('sends User Feedback with debug-bundle.json attached and no API key anywhere', async () => {
    await saveSettings({ apiKey: KEY });
    await putVideo(video('v1'));
    initTelemetry({ component: 'panel', enabled: true });
    createLogger('panel').event('summary.validated', { snapped: 1, note: `?key=${KEY}` }, { videoId: 'v1' });

    const result = await sendIssueReport({ message: `point 4 is 10 min off (key ${KEY})`, videoId: 'v1' });
    expect(result).toMatchObject({ ok: true });
    const eventId = (result as { eventId: string }).eventId;
    expect(eventId).toMatch(/^[0-9a-f]{32}$/);

    const feedbackEnvelope = envelopes.find((env) => env[1].some(([h]) => h.type === 'feedback'));
    expect(feedbackEnvelope).toBeDefined();
    expect(feedbackEnvelope![0].event_id).toBe(eventId);

    const feedback = feedbackEnvelope![1].find(([h]) => h.type === 'feedback')![1] as {
      tags: Record<string, unknown>;
      contexts: { feedback: { message: string } };
    };
    expect(feedback.contexts.feedback.message).toBe('point 4 is 10 min off (key <redacted>)');
    expect(feedback.tags).toMatchObject({ videoId: 'v1' });

    // The attachment travels in the same envelope as the feedback.
    const attachment = feedbackEnvelope![1].find(([h]) => h.type === 'attachment');
    expect(attachment).toBeDefined();
    expect(attachment![0]).toMatchObject({ filename: 'debug-bundle.json', content_type: 'application/json' });
    // The SDK encodes attachment payloads as UTF-8 bytes.
    const payload = attachment![1];
    const bundle = JSON.parse(payload instanceof Uint8Array ? new TextDecoder().decode(payload) : String(payload));
    expect(bundle.videoId).toBe('v1');
    expect(bundle.settings.apiKey).toBe('<redacted>');
    expect(bundle.video.transcript.segments[0].text).toBe('leaked <redacted>');
    expect(bundle.events.map((e: { name: string }) => e.name)).toContain('summary.validated');

    const wire = serialize(envelopes);
    expect(wire).toContain('leaked <redacted>'); // proves the attachment bytes are part of the check
    expect(wire).not.toMatch(KEY_PATTERN);
    await vi.waitFor(async () => expect((await getRecentEvents()).map((e) => e.name)).toContain('ui.report'));
  });

  it('returns send_failed when Sentry rejects the envelope', async () => {
    statusCode = 500;
    initTelemetry({ component: 'panel', enabled: true });
    expect(await sendIssueReport({ message: 'hi', videoId: null })).toEqual({ ok: false, reason: 'send_failed' });
  });
});

describe('withSpan', () => {
  it('runs the function directly when Sentry is off', async () => {
    expect(await withSpan('transcript.fetch', async () => 42)).toBe(42);
    expect(envelopes).toHaveLength(0);
  });

  it('sends a transaction when Sentry is on', async () => {
    initTelemetry({ component: 'panel', enabled: true });
    const value = await withSpan('llm.summary', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'done';
    }, { model: 'gemini-flash' });
    expect(value).toBe('done');
    await vi.waitFor(() => expect(items('transaction')).toHaveLength(1));
    const tx = items('transaction')[0]![1] as { transaction: string; contexts: { trace: { op: string } } };
    expect(tx.transaction).toBe('llm.summary');
    expect(tx.contexts.trace.op).toBe('llm');
  });

  it('propagates errors from the wrapped function', async () => {
    initTelemetry({ component: 'panel', enabled: true });
    await expect(withSpan('x', async () => { throw new Error('inner'); })).rejects.toThrow('inner');
  });
});
