// IndexedDB (Dexie) history of summarized videos. Design §7.
//
// IndexedDB lives per extension origin (chrome-extension://<id>), so the side panel and the
// background worker share this database, while YouTube's page can never see it.
import { Dexie, type EntityTable } from 'dexie';
import type { VideoRecord } from '../types';

export interface HistoryItem {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  hasSummary: boolean;
  totalCostUsd: number;
  lastOpenedAt: number;
}

/**
 * The Dexie instance. Exported for tests and for the debug bundle; app code should use the
 * functions below.
 *
 * Note: we type the tables with an intersection type instead of `class SmrzrDb extends Dexie
 * { videos!: Table }`. With modern TS/esbuild class-field semantics, a declared field would be
 * initialized to `undefined` *after* Dexie's constructor set it up, silently breaking the table.
 */
export const db = new Dexie('smrzr') as Dexie & {
  videos: EntityTable<VideoRecord, 'videoId'>;
};

// Schema string: first entry is the primary key, the rest are indexes (not all fields —
// IndexedDB stores the whole object; only indexed fields can be used in where/orderBy).
// To change the schema later, add `db.version(2).stores({...})` below — never edit version 1.
db.version(1).stores({
  videos: 'videoId, lastOpenedAt',
});

export const DEFAULT_HISTORY_LIMIT = 100;

export async function getVideo(videoId: string): Promise<VideoRecord | undefined> {
  return db.videos.get(videoId);
}

/** Inserts or fully replaces the record with the same videoId. */
export async function putVideo(record: VideoRecord): Promise<void> {
  await db.videos.put(record);
}

/** Shallow-merges patch into an existing record. Throws if the record doesn't exist. */
export async function updateVideo(
  videoId: string,
  patch: Partial<Omit<VideoRecord, 'videoId'>>,
): Promise<VideoRecord> {
  // A read-modify-write inside one transaction, so two concurrent updates (e.g. a chat
  // message and a details expansion finishing at the same time) can't overwrite each other.
  return db.transaction('rw', db.videos, async () => {
    const existing = await db.videos.get(videoId);
    if (!existing) throw new Error(`updateVideo: no record for videoId "${videoId}"`);
    const merged: VideoRecord = { ...existing, ...patch, videoId };
    await db.videos.put(merged);
    return merged;
  });
}

/** Newest first by lastOpenedAt; `search` matches title or channel, case-insensitive. */
export async function listHistory(opts?: { search?: string; limit?: number }): Promise<HistoryItem[]> {
  const limit = opts?.limit ?? DEFAULT_HISTORY_LIMIT;
  const needle = opts?.search?.trim().toLowerCase() ?? '';

  let query = db.videos.orderBy('lastOpenedAt').reverse();
  if (needle) {
    query = query.filter(
      (v) => v.title.toLowerCase().includes(needle) || v.channel.toLowerCase().includes(needle),
    );
  }
  const records = await query.limit(limit).toArray();
  // Strip the heavy parts (transcript, chat, details): the history list only needs a header.
  return records.map(toHistoryItem);
}

export async function deleteVideo(videoId: string): Promise<void> {
  await db.videos.delete(videoId);
}

function toHistoryItem(v: VideoRecord): HistoryItem {
  return {
    videoId: v.videoId,
    title: v.title,
    channel: v.channel,
    durationSec: v.durationSec,
    hasSummary: !!v.summary,
    totalCostUsd: v.totalCostUsd,
    lastOpenedAt: v.lastOpenedAt,
  };
}
