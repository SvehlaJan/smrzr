// Timestamp validation (design §5.2): "validation in code, not trust".
//
// Models hallucinate timestamps. Every timestamp the model returns is checked against the real
// transcript line starts:
//   1. not a finite number                     → hidden (null)
//   2. clamp into [0, duration]; if clamping moved it by more than MAX_DISTANCE_SEC, the value was
//      far outside the video                   → hidden
//   3. a line starts within SNAP_DISTANCE_SEC  → snap to that line start
//      (counted as "snapped" only when it moved by more than 2 s; tiny moves are just rounding)
//   4. a line starts within MAX_DISTANCE_SEC   → keep the clamped value as is
//   5. otherwise (a gap with no speech)        → hidden
// The point itself is always kept; only its timestamp is hidden.

export const SNAP_DISTANCE_SEC = 30;
export const MAX_DISTANCE_SEC = 90;
const NOTICEABLE_SNAP_SEC = 2;

export interface CheckedTimestamp {
  value: number | null;
  /** Moved by more than 2 s to a real line start. */
  snapped: boolean;
  /** Could not be validated; value is null. */
  hidden: boolean;
}

/**
 * @param targets ascending candidate times (transcript line starts; for end times also the duration)
 * @param durationSec video length; 0 or less = unknown (no upper clamp)
 */
export function checkTimestamp(raw: unknown, targets: number[], durationSec: number): CheckedTimestamp {
  const hidden: CheckedTimestamp = { value: null, snapped: false, hidden: true };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return hidden;

  const upper = durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
  const clamped = Math.min(Math.max(raw, 0), upper);
  if (Math.abs(clamped - raw) > MAX_DISTANCE_SEC) return hidden;

  const nearest = nearestValue(targets, clamped);
  if (nearest === undefined) return hidden;
  const distance = Math.abs(nearest - clamped);

  if (distance <= SNAP_DISTANCE_SEC) {
    return { value: nearest, snapped: Math.abs(nearest - raw) > NOTICEABLE_SNAP_SEC, hidden: false };
  }
  if (distance <= MAX_DISTANCE_SEC) {
    return { value: Math.round(clamped), snapped: false, hidden: false };
  }
  return hidden;
}

/**
 * Validates a start/end pair. The end is snapped to line starts OR the end of the video (a point
 * that runs to the end of the video ends at `durationSec`, which is not a line start).
 * If the start is hidden, the end is dropped too (an end alone is useless). If end <= start, the
 * end is dropped. Counts: each snapped / hidden value counts once.
 */
export function checkRange(
  rawStart: unknown,
  rawEnd: unknown,
  lineStarts: number[],
  durationSec: number,
): { startSec: number | null; endSec: number | null; snapped: number; hidden: number } {
  const start = checkTimestamp(rawStart, lineStarts, durationSec);
  let snapped = start.snapped ? 1 : 0;
  let hidden = start.hidden ? 1 : 0;
  if (start.value === null) return { startSec: null, endSec: null, snapped, hidden };

  const endTargets = durationSec > 0 ? [...lineStarts, durationSec].sort((a, b) => a - b) : lineStarts;
  const end = checkTimestamp(rawEnd, endTargets, durationSec);
  let endSec = end.value;
  if (end.hidden) hidden++;
  if (endSec !== null && endSec <= start.value) {
    endSec = null;
    hidden++;
  } else if (end.snapped) {
    snapped++;
  }
  return { startSec: start.value, endSec, snapped, hidden };
}

/** Closest value in an ascending array (binary search). undefined for an empty array. */
export function nearestValue(sorted: number[], x: number): number | undefined {
  if (sorted.length === 0) return undefined;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  // sorted[lo] is the first value >= x (or the last value). Compare with its left neighbour.
  const right = sorted[lo] as number;
  const left = lo > 0 ? (sorted[lo - 1] as number) : right;
  return Math.abs(left - x) <= Math.abs(right - x) ? left : right;
}
