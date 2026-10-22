// Local event log: two ring buffers in IndexedDB (design §8.1, layer 1).
//
// Only the extension's own pages (side panel, background worker) touch this database. It lives
// in the extension's origin, so YouTube can't read it. Content scripts forward their events to
// the background instead (see forwardingLogger.ts).
import { Dexie, type EntityTable, type Table } from 'dexie';
import type { LogEvent } from '../types';
import type { LlmExchange } from './index';

export const MAX_EVENTS = 1000;
export const MAX_EXCHANGES = 50;
/** Trimming costs a count + delete, so it runs every N writes instead of on every write. */
const EVENT_TRIM_INTERVAL = 50;
/** Exchanges are big (full prompts incl. transcripts), so they're trimmed more eagerly. */
const EXCHANGE_TRIM_INTERVAL = 5;

export type StoredExchange = LlmExchange & { id?: number };

type LogDb = Dexie & {
  events: EntityTable<LogEvent, 'id'>;
  exchanges: EntityTable<StoredExchange, 'id'>;
};

// Created lazily so that merely importing the telemetry module (e.g. from a content script
// bundle) never opens IndexedDB in the wrong origin.
let logDb: LogDb | null = null;

export function getLogDb(): LogDb {
  if (!logDb) {
    const db = new Dexie('smrzr-telemetry') as LogDb;
    // "++id" = auto-increment primary key, which also gives us insertion order for trimming.
    db.version(1).stores({
      events: '++id, ts, videoId',
      exchanges: '++id, ts, videoId',
    });
    logDb = db;
  }
  return logDb;
}

// ---------- fire-and-forget writes ----------

/** In-flight writes, so tests and the debug-bundle builder can wait for them. */
const pending = new Set<Promise<void>>();
let eventWrites = 0;
let exchangeWrites = 0;

/** Resolves when every write started so far has finished (successfully or not). */
export async function flushPendingWrites(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/**
 * Never throws, and the returned promise never rejects: telemetry must not break the feature
 * that's being logged. Callers normally ignore the promise (fire-and-forget).
 */
function track(work: () => Promise<void>, what: string): Promise<void> {
  let p: Promise<void>;
  try {
    p = work().catch((err: unknown) => console.warn(`[smrzr telemetry] ${what} failed`, err));
  } catch (err) {
    console.warn(`[smrzr telemetry] ${what} failed`, err);
    return Promise.resolve();
  }
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
}

export function writeEvent(event: LogEvent): Promise<void> {
  // The first write after startup also trims: an MV3 service worker may be killed long before
  // it reaches 50 writes, and the buffer must still stay bounded.
  const shouldTrim = eventWrites++ % EVENT_TRIM_INTERVAL === 0;
  return track(async () => {
    const db = getLogDb();
    await db.events.add(event);
    if (shouldTrim) await trimTable(db.events, MAX_EVENTS);
  }, 'writeEvent');
}

export function writeExchange(x: LlmExchange): Promise<void> {
  const shouldTrim = exchangeWrites++ % EXCHANGE_TRIM_INTERVAL === 0;
  return track(async () => {
    const db = getLogDb();
    await db.exchanges.add({ ...x });
    if (shouldTrim) await trimTable(db.exchanges, MAX_EXCHANGES);
  }, 'writeExchange');
}

/** Deletes the oldest rows (lowest auto-increment ids) so at most `max` remain. */
export async function trimTable<T, K, I>(table: Table<T, K, I>, max: number): Promise<void> {
  const excess = (await table.count()) - max;
  if (excess <= 0) return;
  // toCollection() iterates in primary-key order, i.e. oldest first.
  const oldest = await table.toCollection().limit(excess).primaryKeys();
  await table.bulkDelete(oldest);
}

// ---------- reads ----------

/** The most recent `limit` events (optionally only for one video), oldest first. */
export async function readRecentEvents(opts?: { videoId?: string; limit?: number }): Promise<LogEvent[]> {
  const limit = opts?.limit ?? 100;
  const db = getLogDb();
  const collection = opts?.videoId
    ? db.events.where('videoId').equals(opts.videoId) // ordered by primary key within the index value
    : db.events.toCollection();
  const newestFirst = await collection.reverse().limit(limit).toArray();
  return newestFirst.reverse();
}

export async function readExchanges(videoId: string): Promise<StoredExchange[]> {
  return getLogDb().exchanges.where('videoId').equals(videoId).toArray();
}

/** Test helper: forget write counters (does not clear the database). */
export function resetEventLogCounters(): void {
  eventWrites = 0;
  exchangeWrites = 0;
}
