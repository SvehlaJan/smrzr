// Transcript compaction (design §5.1).
//
// Raw captions arrive as 2–5 s fragments. We merge them into ~20–30 s lines, each prefixed with
// the time it starts:
//
//   [00:12:04] so the study took healthy young adults and restricted them to five hours…
//   [00:12:31] and then on the weekend they let them sleep as long as they wanted…
//
// FORMAT: always [hh:mm:ss], even for videos shorter than an hour. One fixed format is easier for
// the model to read and for us to reason about than switching formats by video length.
//
// This is fewer tokens than JSON, and the model can cite times that actually exist in the input.
// The line start times are also returned: they are the "real" timestamps that hallucinated model
// timestamps are snapped to (see timestamps.ts).
import type { Transcript } from '../types';

export interface CompactLine {
  /** Whole seconds from the start of the video (rounded down). */
  startSec: number;
  text: string;
}

export interface CompactTranscript {
  /** All lines joined with "\n", ready to paste into a prompt. */
  text: string;
  lines: CompactLine[];
  /** lines[i].startSec, ascending. Used for timestamp snapping. */
  lineStarts: number[];
}

/** A line is closed at a sentence end once it is at least this long… */
const SOFT_LINE_SEC = 20;
/** …and always before it would grow past this. */
const HARD_LINE_SEC = 30;
/** A speaker change (">>") starts a new line if the current one is at least this long. */
const SPEAKER_BREAK_SEC = 10;

export function compactTranscript(transcript: Transcript): CompactTranscript {
  const segments = [...transcript.segments]
    .map((s) => ({ start: s.start, end: s.start + Math.max(s.dur, 0), text: normalizeWhitespace(s.text) }))
    .filter((s) => s.text !== '' && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);

  const lines: CompactLine[] = [];
  let current: { start: number; parts: string[] } | null = null;

  const closeLine = () => {
    if (current && current.parts.length > 0) {
      lines.push({ startSec: Math.max(0, Math.floor(current.start)), text: current.parts.join(' ') });
    }
    current = null;
  };

  for (const seg of segments) {
    if (current) {
      const lengthSoFar = seg.start - current.start;
      const wouldBeLength = seg.end - current.start;
      const lastPart = current.parts[current.parts.length - 1] ?? '';
      const endsSentence = /[.?!…]["')\]]?$/.test(lastPart);
      const speakerChange = seg.text.startsWith('>>');

      if (
        wouldBeLength > HARD_LINE_SEC ||
        (lengthSoFar >= SOFT_LINE_SEC && endsSentence) ||
        (lengthSoFar >= SPEAKER_BREAK_SEC && speakerChange)
      ) {
        closeLine();
      }
    }
    if (!current) current = { start: seg.start, parts: [] };
    current.parts.push(seg.text);
  }
  closeLine();

  // Two lines can round down to the same second (e.g. very short fragments). Keep them separate in
  // the text but de-duplicate the snapping targets.
  const lineStarts = [...new Set(lines.map((l) => l.startSec))];
  const text = lines.map((l) => `[${formatHms(l.startSec)}] ${l.text}`).join('\n');
  return { text, lines, lineStarts };
}

/** Collapses newlines/tabs/multiple spaces into single spaces. Keeps ">>" speaker markers. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 724 → "00:12:04" (always hours, minutes, seconds). */
export function formatHms(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Short clock for chat text: 724 → "12:04", 3725 → "1:02:05". */
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
