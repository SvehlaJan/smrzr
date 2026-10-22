import { afterEach, describe, expect, it, vi } from 'vitest';

// Telemetry is implemented by another module; mock it so these tests only check our calls.
const events: { name: string; data?: Record<string, unknown>; opts?: unknown }[] = [];
let createLoggerShouldThrow = false;
vi.mock('../../src/telemetry/forwardingLogger', () => ({
  createForwardingLogger: () => {
    if (createLoggerShouldThrow) throw new Error('Not implemented: createLogger');
    return {
      event: (name: string, data?: Record<string, unknown>, opts?: unknown) => {
        if (name === 'explode') throw new Error('telemetry bug');
        events.push({ name, data, opts });
      },
      error: () => {},
      setTags: () => {},
      recordExchange: () => {},
    };
  },
}));

import type { TranscriptResponse } from '../../src/messaging';
import type { BridgeClient } from '../../src/transcript/bridge';
import { BridgeTimeoutError } from '../../src/transcript/bridge';
import { createTabMessageHandler, createVideoChangeNotifier, isPanelToTab } from '../../src/transcript/isolated';
import { createSafeLogger, logTranscriptResult } from '../../src/transcript/logging';

afterEach(() => {
  events.length = 0;
  createLoggerShouldThrow = false;
  document.body.innerHTML = '';
});

function fakeBridge(request: BridgeClient['request']): BridgeClient {
  return { request, onLog: () => () => {}, dispose: () => {} };
}

const OK: TranscriptResponse = {
  ok: true,
  transcript: {
    videoId: 'vid',
    language: 'en',
    kind: 'asr',
    source: 'player',
    segments: [
      { start: 0, dur: 2, text: 'secret words here' },
      { start: 62.4, dur: 2, text: 'and more' },
    ],
  },
  attempts: [
    { strategy: 'player', outcome: 'empty_200', ms: 120, detail: 'captured: empty_200' },
    { strategy: 'player', outcome: 'ok', ms: 80, segmentCount: 2 },
  ],
};

describe('isPanelToTab', () => {
  it('accepts only well-formed panel messages', () => {
    expect(isPanelToTab({ type: 'getVideoContext' })).toBe(true);
    expect(isPanelToTab({ type: 'getTranscript', videoId: 'v' })).toBe(true);
    expect(isPanelToTab({ type: 'seek', sec: 12 })).toBe(true);
    expect(isPanelToTab({ type: 'seek', sec: NaN })).toBe(false);
    expect(isPanelToTab({ type: 'getTranscript' })).toBe(false);
    expect(isPanelToTab({ type: 'videoChanged', videoId: 'v' })).toBe(false);
    expect(isPanelToTab(null)).toBe(false);
  });
});

describe('tab message handler', () => {
  const log = createSafeLogger('content');

  it('answers not_a_video_page without asking MAIN', async () => {
    const request = vi.fn();
    const handle = createTabMessageHandler({ bridge: fakeBridge(request), doc: document, href: () => 'https://www.youtube.com/', log });
    await expect(handle({ type: 'getVideoContext' })).resolves.toEqual({ ok: false, error: 'not_a_video_page' });
    expect(request).not.toHaveBeenCalled();
  });

  it('maps a bridge timeout to player_not_ready', async () => {
    const bridge = fakeBridge(async () => {
      throw new BridgeTimeoutError('getVideoContext', 3000);
    });
    const handle = createTabMessageHandler({ bridge, doc: document, href: () => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', log });
    await expect(handle({ type: 'getVideoContext' })).resolves.toMatchObject({ ok: false, error: 'player_not_ready' });
  });

  it('passes transcripts through and logs attempts + selection metadata (no text)', async () => {
    const handle = createTabMessageHandler({ bridge: fakeBridge(async () => OK as never), doc: document, href: () => '', log });
    await expect(handle({ type: 'getTranscript', videoId: 'vid' })).resolves.toBe(OK);
    expect(events.map((e) => e.name)).toEqual(['transcript.attempt', 'transcript.attempt', 'transcript.selected']);
    expect(events[0]!.data).toEqual({ strategy: 'player', outcome: 'empty_200', ms: 120, detail: 'captured: empty_200' });
    expect(events[2]!.data).toEqual({ source: 'player', kind: 'asr', language: 'en', segments: 2, words: 5, lastSegmentSec: 62 });
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('turns a bridge failure into all_strategies_failed and logs it', async () => {
    const bridge = fakeBridge(async () => {
      throw new BridgeTimeoutError('getTranscript', 35000);
    });
    const handle = createTabMessageHandler({ bridge, doc: document, href: () => '', log });
    const res = await handle({ type: 'getTranscript', videoId: 'vid' });
    expect(res).toMatchObject({ ok: false, error: 'all_strategies_failed', attempts: [{ outcome: 'error' }] });
    expect(events.map((e) => e.name)).toEqual(['transcript.attempt', 'transcript.failed']);
  });

  it('seeks the video element', async () => {
    const handle = createTabMessageHandler({ bridge: fakeBridge(vi.fn()), doc: document, href: () => '', log });
    await expect(handle({ type: 'seek', sec: 42 })).resolves.toEqual({ ok: false });
    const video = document.createElement('video');
    document.body.append(video);
    await expect(handle({ type: 'seek', sec: 42 })).resolves.toEqual({ ok: true });
    expect(video.currentTime).toBe(42);
  });
});

describe('createVideoChangeNotifier', () => {
  it('sends on change only, including null for non-watch pages', () => {
    let href = 'https://www.youtube.com/';
    const send = vi.fn();
    const notify = createVideoChangeNotifier(() => href, send);
    notify();
    notify();
    href = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
    notify();
    href = 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=10s';
    notify();
    href = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';
    notify();
    expect(send.mock.calls).toEqual([[null], ['aaaaaaaaaaa'], ['bbbbbbbbbbb']]);
  });
});

describe('safe logger', () => {
  it('never throws, even if telemetry fails to initialize or throws per call', () => {
    createLoggerShouldThrow = true;
    const broken = createSafeLogger('content');
    expect(() => broken.event('x')).not.toThrow();
    expect(() => logTranscriptResult(broken, 'vid', OK)).not.toThrow();
    // Creation is retried once telemetry works.
    createLoggerShouldThrow = false;
    broken.event('later');
    expect(events.map((e) => e.name)).toEqual(['later']);
    expect(() => broken.event('explode')).not.toThrow();
  });
});
