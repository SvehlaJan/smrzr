import { describe, expect, it } from 'vitest';
import { applyGrounding, utf8OffsetToUtf16Index } from '../../src/llm/grounding';
import { readSseData } from '../../src/llm/sse';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('utf8OffsetToUtf16Index', () => {
  it('matches TextEncoder byte counts at every character boundary', () => {
    const text = 'aé€😀b 睡眠 👩‍👩‍👧 z';
    let prefix = '';
    for (const ch of text) {
      prefix += ch;
      expect(utf8OffsetToUtf16Index(text, bytes(prefix))).toBe(prefix.length);
    }
  });

  it('never lands inside a surrogate pair (rounds up to the end of the character)', () => {
    const text = 'x😀y';
    // 'x' = 1 byte, '😀' = 4 bytes (2 UTF-16 units).
    expect(utf8OffsetToUtf16Index(text, 1)).toBe(1);
    expect(utf8OffsetToUtf16Index(text, 2)).toBe(3);
    expect(utf8OffsetToUtf16Index(text, 3)).toBe(3);
    expect(utf8OffsetToUtf16Index(text, 5)).toBe(3);
    expect(utf8OffsetToUtf16Index(text, 6)).toBe(4);
  });

  it('clamps out-of-range offsets', () => {
    expect(utf8OffsetToUtf16Index('abc', 0)).toBe(0);
    expect(utf8OffsetToUtf16Index('abc', -5)).toBe(0);
    expect(utf8OffsetToUtf16Index('abc', 99)).toBe(3);
  });
});

describe('applyGrounding', () => {
  it('returns text unchanged without metadata', () => {
    expect(applyGrounding('hi', undefined)).toEqual({ text: 'hi' });
  });

  it('merges markers at the same position, skips unknown chunk indices', () => {
    const text = 'Čaj obsahuje kofein. Káva víc.';
    const first = 'Čaj obsahuje kofein.';
    const { text: out, grounding } = applyGrounding(text, {
      groundingChunks: [{ web: { uri: 'u1', title: 't1' } }, { web: { uri: 'u2', title: 't2' } }],
      groundingSupports: [
        { segment: { endIndex: bytes(first) }, groundingChunkIndices: [1] },
        { segment: { endIndex: bytes(first) }, groundingChunkIndices: [0, 1, 7] },
        { segment: { endIndex: bytes(text) }, groundingChunkIndices: [9] },
      ],
    });
    expect(out).toBe('Čaj obsahuje kofein.[1][2] Káva víc.');
    expect(grounding?.citations.map((c) => c.index)).toEqual([1, 2]);
    expect(grounding?.searchQueries).toEqual([]);
    expect(grounding?.searchEntryPointHtml).toBeUndefined();
  });

  it('falls back to the segment text when byte offsets do not match', () => {
    const text = 'One. Two.';
    const { text: out } = applyGrounding(text, {
      groundingChunks: [{ web: { uri: 'u', title: 't' } }],
      groundingSupports: [{ segment: { endIndex: 2, text: 'Two.' }, groundingChunkIndices: [0] }],
    });
    expect(out).toBe('One. Two.[1]');
  });
});

describe('readSseData', () => {
  function streamOf(...pieces: string[]) {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(c) {
        pieces.forEach((p) => c.enqueue(enc.encode(p)));
        c.close();
      },
    });
  }

  async function collect(stream: ReadableStream<Uint8Array>) {
    const out: string[] = [];
    for await (const d of readSseData(stream)) out.push(d);
    return out;
  }

  it('joins multi-line data, ignores comments and other fields, handles CRLF', async () => {
    const out = await collect(streamOf(': comment\r\nevent: x\r\ndata: a\r\ndata:b\r\n\r\nda', 'ta: c\n\n'));
    expect(out).toEqual(['a\nb', 'c']);
  });

  it('flushes the last event without a trailing blank line', async () => {
    expect(await collect(streamOf('data: last'))).toEqual(['last']);
  });
});
