// "Copy debug bundle" / "Report issue" payload. Design §8.1 (layer 3).
// Contains EVERYTHING about one video (transcript, prompts, raw responses), but never the API key.
import { browser } from 'wxt/browser';
import { getVideo } from '../storage/db';
import { getSettings } from '../storage/settings';
import type { LogEvent } from '../types';
import { flushPendingWrites, readExchanges, readRecentEvents } from './eventLog';
import type { DebugBundle } from './index';
import { scrubSecrets } from './scrub';

/** How many of the newest events from *all* videos are included for context. */
const GLOBAL_EVENT_COUNT = 100;
/** Upper bound for the per-video events (the ring buffer holds 1000 in total anyway). */
const VIDEO_EVENT_LIMIT = 1000;

export function getExtensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
}

export async function buildDebugBundle(videoId: string | null): Promise<DebugBundle> {
  // Include events that were logged a moment ago but are still being written.
  await flushPendingWrites();

  const [settings, video, globalEvents, videoEvents, exchanges] = await Promise.all([
    getSettings(),
    videoId ? getVideo(videoId).then((v) => v ?? null) : Promise.resolve(null),
    readRecentEvents({ limit: GLOBAL_EVENT_COUNT }),
    videoId ? readRecentEvents({ videoId, limit: VIDEO_EVENT_LIMIT }) : Promise.resolve([]),
    videoId ? readExchanges(videoId) : Promise.resolve([]),
  ]);

  const bundle: DebugBundle = {
    createdAt: new Date().toISOString(),
    extensionVersion: getExtensionVersion(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    settings: {
      ...settings,
      // Dropped explicitly (design §8.3); scrubSecrets below is only the safety net.
      apiKey: settings.apiKey ? '<redacted>' : '<empty>',
    },
    videoId,
    video,
    events: mergeEvents(videoEvents, globalEvents),
    exchanges,
  };
  return scrubSecrets(bundle);
}

/** Pretty-printed bundle, for the "Copy debug bundle" button (the UI puts it on the clipboard). */
export async function copyDebugBundle(videoId: string | null): Promise<string> {
  return JSON.stringify(await buildDebugBundle(videoId), null, 2);
}

/** Union of both lists without duplicates, in chronological order. */
function mergeEvents(a: LogEvent[], b: LogEvent[]): LogEvent[] {
  const byId = new Map<number, LogEvent>();
  const withoutId: LogEvent[] = [];
  for (const e of [...a, ...b]) {
    if (e.id === undefined) withoutId.push(e);
    else byId.set(e.id, e);
  }
  return [...byId.values(), ...withoutId].sort((x, y) => x.ts - y.ts || (x.id ?? 0) - (y.id ?? 0));
}
