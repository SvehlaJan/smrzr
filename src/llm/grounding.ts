// Google Search grounding → citations + [n] markers in the answer text (design §5.5).
//
// Citations are built ONLY from the response's grounding metadata, never from URLs the model types
// into its answer (typed URLs are where hallucinated links come from).
import type { Citation } from '../types';
import type { Grounding } from './client';

/** The subset of Gemini's `groundingMetadata` we use. Field names per the v1beta REST API. */
export interface GeminiGroundingMetadata {
  webSearchQueries?: string[];
  searchEntryPoint?: { renderedContent?: string };
  groundingChunks?: { web?: { uri?: string; title?: string } }[];
  groundingSupports?: {
    segment?: { partIndex?: number; startIndex?: number; endIndex?: number; text?: string };
    groundingChunkIndices?: number[];
  }[];
}

/**
 * Converts the grounding metadata and inserts citation markers like "[1][3]" into `text`.
 * Returns the text unchanged (and no grounding) when there is no metadata.
 */
export function applyGrounding(text: string, meta: GeminiGroundingMetadata | undefined): { text: string; grounding?: Grounding } {
  if (!meta) return { text };

  // Citation n = groundingChunks[n-1]. Chunks without a web source (should not happen with
  // Google Search) keep their position so numbering stays aligned, but get no citation.
  const citations: Citation[] = [];
  (meta.groundingChunks ?? []).forEach((chunk, i) => {
    if (chunk.web?.uri) {
      citations.push({ index: i + 1, title: chunk.web.title || chunk.web.uri, uri: chunk.web.uri });
    }
  });
  const validIndices = new Set(citations.map((c) => c.index));

  // Collect markers per insertion position (UTF-16 index into `text`).
  const markersAt = new Map<number, Set<number>>();
  for (const support of meta.groundingSupports ?? []) {
    const segment = support.segment;
    if (!segment || segment.endIndex === undefined) continue;
    const position = findSegmentEnd(text, segment.endIndex, segment.text);
    const indices = (support.groundingChunkIndices ?? []).map((i) => i + 1).filter((n) => validIndices.has(n));
    if (indices.length === 0) continue;
    const set = markersAt.get(position) ?? new Set<number>();
    indices.forEach((n) => set.add(n));
    markersAt.set(position, set);
  }

  // Insert from the end backwards so earlier positions stay valid.
  let result = text;
  const positions = [...markersAt.keys()].sort((a, b) => b - a);
  for (const pos of positions) {
    const numbers = [...(markersAt.get(pos) ?? [])].sort((a, b) => a - b);
    const marker = numbers.map((n) => `[${n}]`).join('');
    result = result.slice(0, pos) + marker + result.slice(pos);
  }

  const grounding: Grounding = {
    citations,
    searchQueries: meta.webSearchQueries ?? [],
  };
  if (meta.searchEntryPoint?.renderedContent) grounding.searchEntryPointHtml = meta.searchEntryPoint.renderedContent;
  return { text: result, grounding };
}

/**
 * Where a grounding segment ends, as a UTF-16 index into `text` (what JS strings use).
 *
 * ASSUMPTION (verify against live responses): `endIndex` is a UTF-8 BYTE offset into the
 * concatenated answer text. As a safety net, when the segment's own `text` is given and does not
 * end at the computed position (e.g. offsets relative to a single part), we look the text up.
 */
function findSegmentEnd(text: string, endByteOffset: number, segmentText: string | undefined): number {
  const fromBytes = utf8OffsetToUtf16Index(text, endByteOffset);
  if (!segmentText || text.slice(0, fromBytes).endsWith(segmentText)) return fromBytes;
  const found = text.indexOf(segmentText);
  return found >= 0 ? found + segmentText.length : fromBytes;
}

/**
 * Converts a UTF-8 byte offset into a UTF-16 string index.
 * Same result as counting `new TextEncoder().encode(char).length` per character, without
 * allocating. Walks whole code points, so the result never lands inside a surrogate pair (an
 * emoji is 4 UTF-8 bytes and 2 UTF-16 units). An offset that falls inside a character is rounded
 * up to the end of that character; an offset past the end returns text.length.
 */
export function utf8OffsetToUtf16Index(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    index += char.length; // 1, or 2 for a surrogate pair
    if (bytes >= byteOffset) return index;
  }
  return text.length;
}
