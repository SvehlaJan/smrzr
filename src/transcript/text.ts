// Small pure text helpers shared by the transcript parsers.

/** Collapses newlines/tabs/repeated spaces into single spaces and trims. */
export function normalizeText(text: string): string {
  //   = non-breaking space, ​ = zero-width space; both show up in captions.
  return text.replace(/[\s ​]+/g, ' ').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decodes HTML/XML entities: named (&amp;), decimal (&#39;) and hex (&#x27;).
 * Done by hand (not DOMParser) so it works in tests without a browser and can never run scripts.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Parses a clock-style timestamp as shown in YouTube's UI and descriptions:
 * "12:04" → 724, "1:02:03" → 3723, "0:05" → 5. Returns null for anything else.
 */
export function parseClock(text: string): number | null {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const hours = m[1] !== undefined ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (seconds >= 60) return null;
  // With an hour part, minutes must be 0..59 ("1:75:00" is not a time).
  if (m[1] !== undefined && minutes >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Rough word count for metadata logging (`transcript.selected`). */
export function countWords(texts: Iterable<string>): number {
  let n = 0;
  for (const t of texts) {
    const trimmed = t.trim();
    if (trimmed) n += trimmed.split(/\s+/).length;
  }
  return n;
}
