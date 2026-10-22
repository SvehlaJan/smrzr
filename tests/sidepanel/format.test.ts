import { describe, expect, it } from 'vitest';
import { LlmError } from '@/src/llm/client';
import { describeError, isAbortError } from '@/entrypoints/sidepanel/errors';
import {
  formatCost,
  formatDuration,
  formatRelativeDate,
  formatTimestamp,
  parseTimestamp,
} from '@/entrypoints/sidepanel/format';
import { isYouTubeUrl, parseVideoId } from '@/entrypoints/sidepanel/youtube';

describe('formatTimestamp / parseTimestamp', () => {
  it('formats like YouTube', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(45.9)).toBe('0:45');
    expect(formatTimestamp(724)).toBe('12:04');
    expect(formatTimestamp(3723)).toBe('1:02:03');
    expect(formatTimestamp(-5)).toBe('0:00');
    expect(formatTimestamp(Number.NaN)).toBe('0:00');
  });

  it('parses m:ss, mm:ss and h:mm:ss, rejecting malformed values', () => {
    expect(parseTimestamp('12:04')).toBe(724);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('00:12:04')).toBe(724);
    expect(parseTimestamp('75:30')).toBe(4530);
    expect(parseTimestamp('12:60')).toBeNull();
    expect(parseTimestamp('1:60:00')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('12')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('is empty for unknown durations', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(9667)).toBe('2:41:07');
  });
});

describe('formatCost', () => {
  it('formats dollars with two decimals and marks tiny costs', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.04)).toBe('$0.04');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});

describe('formatRelativeDate', () => {
  const now = new Date(2026, 9, 22, 12, 0, 0).getTime();
  it('uses relative words for recent dates', () => {
    expect(formatRelativeDate(now - 10_000, now)).toBe('just now');
    expect(formatRelativeDate(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatRelativeDate(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(formatRelativeDate(now - 30 * 3600_000, now)).toBe('yesterday');
    expect(formatRelativeDate(now - 4 * 86400_000, now)).toBe('4 days ago');
  });
  it('falls back to a short date', () => {
    const out = formatRelativeDate(now - 30 * 86400_000, now);
    expect(out).not.toMatch(/ago/);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('YouTube URL parsing', () => {
  it('extracts ids from watch URLs only', () => {
    expect(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(parseVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(parseVideoId('https://evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseVideoId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseVideoId(null)).toBeNull();
  });
  it('recognises YouTube hosts', () => {
    expect(isYouTubeUrl('https://www.youtube.com/')).toBe(true);
    expect(isYouTubeUrl('chrome://newtab')).toBe(false);
  });
});

describe('error descriptions', () => {
  it('maps LlmError kinds to friendly text and ignores aborts', () => {
    expect(describeError(new LlmError('401', 'auth', 401))?.message).toMatch(/Gemini rejected this API key/);
    expect(describeError(new LlmError('429', 'quota', 429))?.message).toBe('Gemini quota or billing limit reached.');
    expect(describeError(new LlmError('stop', 'aborted'))).toBeNull();
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(describeError(new Error('Could not establish connection. Receiving end does not exist.'))?.message).toMatch(/Reload the tab/);
  });
});
