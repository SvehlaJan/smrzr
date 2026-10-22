// Small, pure formatting helpers used across the panel. No React, no browser APIs,
// so they are trivially unit-testable.

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Seconds → YouTube-style timestamp: "0:45", "12:04", "1:02:03".
 * Negative or non-finite input is treated as 0.
 */
export function formatTimestamp(totalSec: number): string {
  const s = Number.isFinite(totalSec) ? Math.max(0, Math.floor(totalSec)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/**
 * "12:04" → 724, "1:02:03" / "01:02:03" → 3723. Returns null for anything malformed.
 * In the two-part form minutes may exceed 59 ("75:30"), because models write that.
 */
export function parseTimestamp(label: string): number | null {
  const parts = label.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 2) {
    const [m, s] = nums as [number, number];
    return s < 60 ? m * 60 + s : null;
  }
  const [h, m, s] = nums as [number, number, number];
  return m < 60 && s < 60 ? h * 3600 + m * 60 + s : null;
}

/** Video length for headers and lists ("2:41:07"). Empty string when unknown (0 / NaN). */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  return formatTimestamp(sec);
}

/** "$0.04"; tiny non-zero amounts show as "<$0.01" so they don't look free. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a short date. */
export function formatRelativeDate(ts: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.round((now - ts) / 1000));
  if (diffSec < 60) return 'just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
