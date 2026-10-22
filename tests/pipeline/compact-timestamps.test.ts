import { describe, expect, it } from 'vitest';
import { compactTranscript, formatClock, formatHms } from '../../src/pipeline/compact';
import { checkRange, checkTimestamp, nearestValue } from '../../src/pipeline/timestamps';
import type { Transcript } from '../../src/types';
import { sampleTranscript } from './helpers';

const tr = (segments: Transcript['segments']): Transcript => ({ videoId: 'v', language: 'en', kind: 'asr', source: 'player', segments });

describe('compactTranscript', () => {
  it('merges fragments into ~20–30 s lines with [hh:mm:ss] prefixes', () => {
    const c = compactTranscript(sampleTranscript());
    expect(c.lineStarts).toEqual(Array.from({ length: 30 }, (_, i) => i * 20));
    expect(c.lines[0]).toEqual({ startSec: 0, text: 'words at second 0. words at second 4. words at second 8. words at second 12. words at second 16.' });
    expect(c.text.split('\n')[1]).toBe('[00:00:20] words at second 20. words at second 24. words at second 28. words at second 32. words at second 36.');
    expect(c.text.split('\n')).toHaveLength(30);
  });

  it('closes a line before it exceeds 30 s when there is no sentence end', () => {
    const segments = Array.from({ length: 20 }, (_, i) => ({ start: i * 3, dur: 3, text: `w${i}` }));
    const c = compactTranscript(tr(segments));
    expect(c.lineStarts).toEqual([0, 30]);
    for (let i = 0; i < c.lines.length; i++) {
      const next = c.lineStarts[i + 1] ?? 60;
      expect(next - c.lineStarts[i]!).toBeLessThanOrEqual(30);
    }
  });

  it('normalizes whitespace, drops empty fragments, keeps >> speaker markers, sorts by time', () => {
    const c = compactTranscript(
      tr([
        { start: 3725.6, dur: 2, text: '  >> and\nthen   we\tsaw ' },
        { start: 3700, dur: 3, text: 'hello there' },
        { start: 3704, dur: 1, text: '   ' },
        { start: 3712, dur: 3, text: '>> who are you?' },
      ]),
    );
    // Each ">>" comes ≥10 s into the current line → it starts a new line.
    expect(c.text).toBe('[01:01:40] hello there\n[01:01:52] >> who are you?\n[01:02:05] >> and then we saw');
    expect(c.lineStarts).toEqual([3700, 3712, 3725]);
  });

  it('does not split on a speaker change early in a line', () => {
    const c = compactTranscript(tr([{ start: 0, dur: 3, text: 'hi.' }, { start: 3, dur: 3, text: '>> hello.' }]));
    expect(c.text).toBe('[00:00:00] hi. >> hello.');
  });

  it('handles an empty transcript', () => {
    expect(compactTranscript(tr([]))).toEqual({ text: '', lines: [], lineStarts: [] });
  });

  it('formats times', () => {
    expect(formatHms(724)).toBe('00:12:04');
    expect(formatHms(9667.9)).toBe('02:41:07');
    expect(formatClock(724)).toBe('12:04');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(5)).toBe('0:05');
  });
});

describe('timestamp validation', () => {
  const starts = [0, 20, 40, 60, 200, 220];

  it('snaps to the nearest line start within 30 s', () => {
    expect(checkTimestamp(47, starts, 600)).toEqual({ value: 40, snapped: true, hidden: false });
    expect(checkTimestamp(41, starts, 600)).toEqual({ value: 40, snapped: false, hidden: false }); // ≤2 s is not "snapped"
    expect(checkTimestamp(225, starts, 600)).toEqual({ value: 220, snapped: true, hidden: false });
  });

  it('keeps the value when the nearest line is 30–90 s away, hides beyond 90 s', () => {
    expect(checkTimestamp(130, starts, 600)).toEqual({ value: 130, snapped: false, hidden: false }); // 70 s from 60 and 200
    expect(checkTimestamp(400, starts, 600)).toEqual({ value: null, snapped: false, hidden: true }); // 180 s from 220
  });

  it('clamps into [0, duration] and hides values far outside the video', () => {
    expect(checkTimestamp(-5, starts, 600)).toEqual({ value: 0, snapped: true, hidden: false });
    expect(checkTimestamp(240, starts, 230)).toEqual({ value: 220, snapped: true, hidden: false }); // clamped to 230 → snaps to 220
    expect(checkTimestamp(5000, starts, 600).hidden).toBe(true);
  });

  it('hides non-finite and non-numbers', () => {
    for (const bad of [NaN, Infinity, '12', null, undefined]) {
      expect(checkTimestamp(bad, starts, 600)).toEqual({ value: null, snapped: false, hidden: true });
    }
    expect(checkTimestamp(10, [], 600).hidden).toBe(true);
  });

  it('checks ranges: end snaps to line starts or duration, must be after start', () => {
    expect(checkRange(21, 59, starts, 600)).toEqual({ startSec: 20, endSec: 60, snapped: 0, hidden: 0 });
    expect(checkRange(200, 235, starts, 240)).toEqual({ startSec: 200, endSec: 240, snapped: 1, hidden: 0 });
    // end before start → end dropped and counted as hidden
    expect(checkRange(40, 25, starts, 600)).toEqual({ startSec: 40, endSec: null, snapped: 0, hidden: 1 });
    // hidden start → end dropped too
    expect(checkRange('x', 40, starts, 600)).toEqual({ startSec: null, endSec: null, snapped: 0, hidden: 1 });
  });

  it('nearestValue', () => {
    expect(nearestValue([], 3)).toBeUndefined();
    expect(nearestValue([10], 3)).toBe(10);
    expect(nearestValue([0, 10, 20], 14)).toBe(10);
    expect(nearestValue([0, 10, 20], 16)).toBe(20);
    expect(nearestValue([0, 10, 20], 99)).toBe(20);
  });
});
