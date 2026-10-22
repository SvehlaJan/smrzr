// Parsers and URL helpers for YouTube's caption endpoint `/api/timedtext`.
//
// Pure functions only (no fetch, no DOM) so they can be unit-tested with fixtures.
//
// The endpoint can return several formats depending on the `fmt` URL parameter:
//   - fmt=json3 → JSON  { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }   (what we ask for)
//   - no fmt    → legacy XML  <transcript><text start="1.2" dur="3.4">…</text></transcript>
//   - fmt=srv3  → XML  <timedtext><body><p t="1200" d="3400">…</p></body></timedtext>  (milliseconds)
// We accept all three so a format change on YouTube's side doesn't break us silently.

import type { TranscriptSegment } from '../types';
import { asNumber, asString, dig } from './json';
import { decodeEntities, normalizeText } from './text';

export class TranscriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptParseError';
  }
}

/**
 * Parses the json3 caption format.
 * Shape (verified in the past, assumed still current):
 *   { "events": [
 *       { "tStartMs": 0, "dDurationMs": 5000, "id": 1, "wpWinPosId": 1, ... },          ← window setup, no segs: skip
 *       { "tStartMs": 1200, "dDurationMs": 3400, "segs": [{ "utf8": "hello" }, { "utf8": " world", "tOffsetMs": 400 }] },
 *       { "tStartMs": 4600, "aAppend": 1, "segs": [{ "utf8": "\n" }] },                   ← ASR line break: empty → dropped
 *   ] }
 */
export function parseJson3(json: unknown): TranscriptSegment[] {
  const events = dig(json, 'events');
  if (!Array.isArray(events)) throw new TranscriptParseError('json3: no events array');
  const segments: TranscriptSegment[] = [];
  for (const ev of events) {
    const segs = dig(ev, 'segs');
    if (!Array.isArray(segs)) continue;
    const text = normalizeText(segs.map((s) => asString(dig(s, 'utf8')) ?? '').join(''));
    if (!text) continue;
    const startMs = asNumber(dig(ev, 'tStartMs')) ?? 0;
    const durMs = asNumber(dig(ev, 'dDurationMs')) ?? 0;
    segments.push({ start: startMs / 1000, dur: durMs / 1000, text });
  }
  return segments;
}

/** Reads an attribute value from the attribute part of an XML tag, e.g. `start="1.2" dur="3"`. */
function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  if (!m) return undefined;
  return m[2] ?? m[3];
}

/** Removes inner tags like <s>, <font>, <br/> and decodes entities. */
function xmlInnerText(inner: string): string {
  const withoutTags = inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
  // Legacy captions are often double-escaped ("&amp;#39;"), so decode twice.
  return normalizeText(decodeEntities(decodeEntities(withoutTags)));
}

/**
 * Parses the legacy XML format (seconds) and srv3 (milliseconds).
 * Regex-based instead of DOMParser so it runs anywhere and never interprets markup as HTML.
 */
export function parseTimedtextXml(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  // Legacy: <text start="12.34" dur="2.5">Hello &amp;#39;world&amp;#39;</text>
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (let m = textRe.exec(xml); m; m = textRe.exec(xml)) {
    const attrs = m[1] ?? '';
    const text = xmlInnerText(m[2] ?? '');
    if (!text) continue;
    const start = asNumber(attr(attrs, 'start')) ?? 0;
    const dur = asNumber(attr(attrs, 'dur')) ?? 0;
    segments.push({ start, dur, text });
  }
  if (segments.length > 0) return segments;

  // srv3: <p t="1200" d="3400">Hello <s>world</s></p>
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  for (let m = pRe.exec(xml); m; m = pRe.exec(xml)) {
    const attrs = m[1] ?? '';
    const text = xmlInnerText(m[2] ?? '');
    if (!text) continue;
    const t = asNumber(attr(attrs, 't')) ?? 0;
    const d = asNumber(attr(attrs, 'd')) ?? 0;
    segments.push({ start: t / 1000, dur: d / 1000, text });
  }
  return segments;
}

/**
 * Parses a raw timedtext response body in whatever format it came in.
 * Throws TranscriptParseError when the body is not recognizable.
 * NOTE: callers must check for an empty body *before* calling this (empty = PO-token refusal).
 */
export function parseTimedtextBody(body: string): TranscriptSegment[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) return parseTimedtextXml(trimmed);
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new TranscriptParseError('timedtext: body is neither JSON nor XML');
  }
  return parseJson3(json);
}

// ---------- URL helpers ----------

/** True for URLs of the caption endpoint, absolute or relative. */
export function isTimedtextUrl(url: string, base = 'https://www.youtube.com/'): boolean {
  try {
    return new URL(url, base).pathname === '/api/timedtext';
  } catch {
    return false;
  }
}

/** The `v=` (video id) parameter of a timedtext URL, or null. */
export function timedtextVideoId(url: string, base = 'https://www.youtube.com/'): string | null {
  try {
    return new URL(url, base).searchParams.get('v');
  } catch {
    return null;
  }
}

/**
 * Rewrites a captured (or baseUrl) timedtext URL into the request we want to make:
 *   - fmt=json3 (replacing srv3/vtt/whatever the player used)
 *   - c=WEB added when missing (the player's own requests carry it; some reports say it's needed with pot=)
 *   - optionally switch to another track: set lang/kind and drop `tlang` (auto-translation)
 * Everything else (signature, expire, pot=, potc=, …) is kept untouched.
 */
export function buildJson3Url(
  url: string,
  opts: { base?: string; track?: { languageCode: string; kind: 'manual' | 'asr' }; pot?: string } = {},
): string {
  const u = new URL(url, opts.base ?? 'https://www.youtube.com/');
  u.searchParams.set('fmt', 'json3');
  if (!u.searchParams.has('c')) u.searchParams.set('c', 'WEB');
  if (opts.track) {
    u.searchParams.delete('tlang');
    u.searchParams.set('lang', opts.track.languageCode);
    if (opts.track.kind === 'asr') u.searchParams.set('kind', 'asr');
    else u.searchParams.delete('kind');
  }
  if (opts.pot && !u.searchParams.has('pot')) {
    u.searchParams.set('pot', opts.pot);
  }
  return u.toString();
}

/** Language / kind / translation params of a timedtext URL, for deciding whether a captured URL fits our track. */
export function timedtextTrackParams(url: string, base = 'https://www.youtube.com/'): {
  lang: string | null;
  kind: string | null;
  tlang: string | null;
  pot: string | null;
} {
  try {
    const p = new URL(url, base).searchParams;
    return { lang: p.get('lang'), kind: p.get('kind'), tlang: p.get('tlang'), pot: p.get('pot') };
  } catch {
    return { lang: null, kind: null, tlang: null, pot: null };
  }
}
