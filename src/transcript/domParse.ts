// Pure part of the DOM strategy (strategy 3): turning the rows we scraped from YouTube's
// transcript panel into segments. The browser part (opening the panel, finding elements)
// lives in strategies/dom.ts.

import type { TranscriptSegment } from '../types';
import { normalizeText, parseClock } from './text';

/** One row of the transcript panel as read from the page: "12:04" + "so the study took…". */
export interface DomRow {
  timeText: string;
  text: string;
}

/**
 * Converts panel rows into segments. The panel shows only start times, so each segment's
 * duration is the gap to the next row (the last one gets `lastDurSec`).
 * Rows with an unparseable timestamp or no text are skipped.
 */
export function segmentsFromDomRows(rows: DomRow[], lastDurSec = 3): TranscriptSegment[] {
  const parsed: { start: number; text: string }[] = [];
  for (const row of rows) {
    const start = parseClock(row.timeText);
    const text = normalizeText(row.text);
    if (start === null || !text) continue;
    parsed.push({ start, text });
  }
  return parsed.map((p, i) => {
    const next = parsed[i + 1];
    const dur = next && next.start > p.start ? next.start - p.start : lastDurSec;
    return { start: p.start, dur, text: p.text };
  });
}

/**
 * Fallback row reader when we don't recognize the element structure: takes the element's
 * visible text lines, uses the first line that looks like a timestamp as the time and the
 * remaining lines as the text.
 */
export function rowFromTextLines(lines: string[]): DomRow | null {
  const cleaned = lines.map((l) => l.trim()).filter((l) => l !== '');
  const idx = cleaned.findIndex((l) => parseClock(l) !== null);
  if (idx === -1) return null;
  const text = cleaned.filter((_, i) => i !== idx).join(' ');
  if (!text) return null;
  return { timeText: cleaned[idx]!, text };
}
