// Chapter extraction (design §1: chapters are a *hint* for the summary, not its structure).
// Pure functions: input is page JSON or a description string.

import type { Chapter } from '../types';
import { asArray, asNumber, asString, dig, findAllByKey, ytText } from './json';
import { normalizeText, parseClock } from './text';

/** The video id that a "next"/watch-page response (ytInitialData) belongs to, if we can tell. */
export function watchDataVideoId(watchData: unknown): string | null {
  return (
    asString(dig(watchData, 'currentVideoEndpoint', 'watchEndpoint', 'videoId')) ??
    // Fallback seen in some responses (assumed): the endpoint the page was opened with.
    asString(dig(watchData, 'endpoint', 'watchEndpoint', 'videoId')) ??
    null
  );
}

/**
 * Chapters from the watch page data (window.ytInitialData or a fresher equivalent).
 *
 * Assumed shape (not verified on today's YouTube):
 *   playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer
 *     .playerBar.multiMarkersPlayerBarRenderer.markersMap = [
 *       { key: "DESCRIPTION_CHAPTERS" | "AUTO_CHAPTERS",
 *         value: { chapters: [ { chapterRenderer: { title: { simpleText }, timeRangeStartMillis } } ] } } ]
 *
 * Creator chapters (DESCRIPTION_CHAPTERS) win over YouTube's auto chapters.
 * If the exact path moved, we fall back to searching for any `markersMap` in the data.
 */
export function chaptersFromWatchData(watchData: unknown): Chapter[] {
  const exact = dig(
    watchData,
    'playerOverlays',
    'playerOverlayRenderer',
    'decoratedPlayerBarRenderer',
    'decoratedPlayerBarRenderer',
    'playerBar',
    'multiMarkersPlayerBarRenderer',
    'markersMap',
  );
  const maps: unknown[] = Array.isArray(exact) ? [exact] : findAllByKey(watchData, 'markersMap', 200_000);

  for (const wantedKey of ['DESCRIPTION_CHAPTERS', 'AUTO_CHAPTERS']) {
    for (const map of maps) {
      for (const entry of asArray(map)) {
        if (asString(dig(entry, 'key')) !== wantedKey) continue;
        const chapters = asArray(dig(entry, 'value', 'chapters'))
          .map((c): Chapter | null => {
            const title = ytText(dig(c, 'chapterRenderer', 'title'));
            const ms = asNumber(dig(c, 'chapterRenderer', 'timeRangeStartMillis'));
            if (title === undefined || ms === undefined) return null;
            return { title: normalizeText(title), startSec: Math.round(ms / 1000) };
          })
          .filter((c): c is Chapter => c !== null && c.title !== '');
        if (chapters.length > 0) return chapters.sort((a, b) => a.startSec - b.startSec);
      }
    }
  }
  return [];
}

// A timestamp like "0:00", "12:04", "1:02:03", optionally in brackets.
const TS = String.raw`[\[(]?((?:\d{1,3}:)?\d{1,2}:\d{2})[\])]?`;
// Separators people put between timestamp and title: "-", "–", "—", ":", "|", "•".
const SEP = String.raw`[\s\-–—:|•·]*`;
// "00:00 Intro", "1:02:03 - Topic", "▶ 0:00 Intro", "(0:00) Intro"
const TS_FIRST = new RegExp(String.raw`^\s*(?:[-•*▶►→]\s*)?${TS}${SEP}(.*\S)\s*$`);
// "Intro - 00:00", "Intro (0:00)"
const TS_LAST = new RegExp(String.raw`^\s*(?:[-•*▶►→]\s*)?(.*?\S)${SEP}${TS}\s*$`);

function parseChapterLine(line: string): Chapter | null {
  let m = TS_FIRST.exec(line);
  if (m) {
    const sec = parseClock(m[1]!);
    const title = cleanTitle(m[2]!);
    if (sec !== null && title) return { title, startSec: sec };
  }
  m = TS_LAST.exec(line);
  if (m) {
    const sec = parseClock(m[2]!);
    const title = cleanTitle(m[1]!);
    if (sec !== null && title) return { title, startSec: sec };
  }
  return null;
}

function cleanTitle(raw: string): string {
  return normalizeText(raw.replace(/^[\s\-–—:|•·]+|[\s\-–—:|•·]+$/g, ''));
}

/**
 * Parses chapter lines out of a video description, following YouTube's own rules:
 * the list must start at 0:00, have at least 3 entries, and be in ascending order.
 * We take the first run of consecutive timestamp lines that starts at 0:00 and stop at the first
 * non-ascending one; anything else (e.g. "at 5:30 he says…" in a paragraph) is ignored.
 * Timestamps beyond the video's duration end the list too.
 */
export function chaptersFromDescription(description: string, durationSec?: number): Chapter[] {
  const lines = description.split(/\r?\n/);
  let chapters: Chapter[] = [];
  let started = false;
  for (const line of lines) {
    const ch = parseChapterLine(line);
    if (!started) {
      if (ch && ch.startSec === 0) {
        started = true;
        chapters = [ch];
      }
      continue;
    }
    if (!ch) {
      // Blank lines inside the list are fine; other text ends it.
      if (line.trim() === '') continue;
      break;
    }
    const prev = chapters[chapters.length - 1]!;
    if (ch.startSec <= prev.startSec) break;
    if (durationSec !== undefined && durationSec > 0 && ch.startSec >= durationSec) break;
    chapters.push(ch);
  }
  return chapters.length >= 3 ? chapters : [];
}
