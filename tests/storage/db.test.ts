import { beforeEach, describe, expect, it } from 'vitest';
import { db, deleteVideo, getVideo, listHistory, putVideo, updateVideo } from '../../src/storage/db';
import type { VideoRecord } from '../../src/types';

function makeVideo(videoId: string, overrides: Partial<VideoRecord> = {}): VideoRecord {
  return {
    videoId,
    title: `Video ${videoId}`,
    channel: 'Some Channel',
    durationSec: 600,
    transcript: {
      videoId,
      language: 'en',
      kind: 'manual',
      source: 'player',
      segments: [{ start: 0, dur: 5, text: 'hello world' }],
    },
    details: {},
    chat: [],
    promptVersion: 1,
    totalCostUsd: 0,
    createdAt: 1000,
    lastOpenedAt: 1000,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.videos.clear();
});

describe('video CRUD', () => {
  it('puts, gets and deletes a record', async () => {
    const v = makeVideo('abc');
    await putVideo(v);
    expect(await getVideo('abc')).toEqual(v);

    await deleteVideo('abc');
    expect(await getVideo('abc')).toBeUndefined();
  });

  it('returns undefined for unknown videos', async () => {
    expect(await getVideo('nope')).toBeUndefined();
  });

  it('put replaces an existing record', async () => {
    await putVideo(makeVideo('abc', { title: 'Old' }));
    await putVideo(makeVideo('abc', { title: 'New' }));
    expect((await getVideo('abc'))?.title).toBe('New');
    expect(await db.videos.count()).toBe(1);
  });
});

describe('updateVideo', () => {
  it('shallow-merges the patch and returns the merged record', async () => {
    await putVideo(makeVideo('abc', { details: { p1: { subpoints: [], context: 'x' } } }));
    const summary = { tldr: 'tl;dr', points: [] };
    const updated = await updateVideo('abc', { summary, lastOpenedAt: 2000 });

    expect(updated.summary).toEqual(summary);
    expect(updated.lastOpenedAt).toBe(2000);
    expect(updated.title).toBe('Video abc'); // untouched fields survive
    expect(updated.details.p1?.context).toBe('x');
    expect(await getVideo('abc')).toEqual(updated);
  });

  it('replaces nested objects instead of deep-merging them (shallow merge)', async () => {
    await putVideo(makeVideo('abc', { details: { p1: { subpoints: [], context: 'x' } } }));
    const updated = await updateVideo('abc', { details: { p2: { subpoints: [], context: 'y' } } });
    expect(Object.keys(updated.details)).toEqual(['p2']);
  });

  it('throws when the record does not exist', async () => {
    await expect(updateVideo('missing', { title: 'x' })).rejects.toThrow(/missing/);
    expect(await getVideo('missing')).toBeUndefined();
  });

  it('cannot change the primary key', async () => {
    await putVideo(makeVideo('abc'));
    const updated = await updateVideo('abc', { videoId: 'other' } as Partial<VideoRecord>);
    expect(updated.videoId).toBe('abc');
    expect(await getVideo('other')).toBeUndefined();
  });
});

describe('listHistory', () => {
  beforeEach(async () => {
    await putVideo(makeVideo('a', { title: 'Sleep and Caffeine', channel: 'Huberman', lastOpenedAt: 300, summary: { tldr: '', points: [] }, totalCostUsd: 0.04 }));
    await putVideo(makeVideo('b', { title: 'Rust for beginners', channel: 'Code Channel', lastOpenedAt: 100 }));
    await putVideo(makeVideo('c', { title: 'News of the week', channel: 'SLEEPY news', lastOpenedAt: 200 }));
  });

  it('returns newest first by lastOpenedAt, without transcripts', async () => {
    const items = await listHistory();
    expect(items.map((i) => i.videoId)).toEqual(['a', 'c', 'b']);
    expect(items[0]).toEqual({
      videoId: 'a',
      title: 'Sleep and Caffeine',
      channel: 'Huberman',
      durationSec: 600,
      hasSummary: true,
      totalCostUsd: 0.04,
      lastOpenedAt: 300,
    });
    expect(items[1]?.hasSummary).toBe(false);
    expect(items[0]).not.toHaveProperty('transcript');
  });

  it('searches title or channel case-insensitively', async () => {
    expect((await listHistory({ search: 'sleep' })).map((i) => i.videoId)).toEqual(['a', 'c']);
    expect((await listHistory({ search: 'CODE' })).map((i) => i.videoId)).toEqual(['b']);
    expect(await listHistory({ search: 'zzz' })).toEqual([]);
    expect(await listHistory({ search: '   ' })).toHaveLength(3);
  });

  it('applies the limit after filtering', async () => {
    expect((await listHistory({ limit: 2 })).map((i) => i.videoId)).toEqual(['a', 'c']);
    expect((await listHistory({ search: 'sleep', limit: 1 })).map((i) => i.videoId)).toEqual(['a']);
  });

  it('defaults to 100 items', async () => {
    await db.videos.bulkPut(Array.from({ length: 120 }, (_, i) => makeVideo(`bulk${i}`, { lastOpenedAt: 1000 + i })));
    const items = await listHistory();
    expect(items).toHaveLength(100);
    expect(items[0]?.videoId).toBe('bulk119');
  });
});
