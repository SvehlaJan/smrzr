// IndexedDB (Dexie) history of summarized videos. Design §7.
import type { VideoRecord } from '../types';
import { notImplemented } from '../notImplemented';

export interface HistoryItem {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  hasSummary: boolean;
  totalCostUsd: number;
  lastOpenedAt: number;
}

export function getVideo(videoId: string): Promise<VideoRecord | undefined> {
  return notImplemented('getVideo');
}
export function putVideo(record: VideoRecord): Promise<void> {
  return notImplemented('putVideo');
}
/** Shallow-merges patch into an existing record. Throws if the record doesn't exist. */
export function updateVideo(videoId: string, patch: Partial<Omit<VideoRecord, 'videoId'>>): Promise<VideoRecord> {
  return notImplemented('updateVideo');
}
/** Newest first by lastOpenedAt; `search` matches title or channel, case-insensitive. */
export function listHistory(opts?: { search?: string; limit?: number }): Promise<HistoryItem[]> {
  return notImplemented('listHistory');
}
export function deleteVideo(videoId: string): Promise<void> {
  return notImplemented('deleteVideo');
}
