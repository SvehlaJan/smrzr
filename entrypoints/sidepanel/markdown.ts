// A tiny, SAFE markdown parser for model replies.
//
// Why not a library / innerHTML: model output is untrusted (the transcript it read can contain
// anything), so we never turn it into HTML strings. This parser produces a plain data tree;
// `components/Markdown.tsx` turns that tree into React elements, and React escapes all text.
// `<img onerror=…>` in a reply therefore shows up as literal text.
//
// Supported: paragraphs, "# headings" (rendered bold), "-"/"*" bullet lists, "1." numbered
// lists, **bold**, *italic* / _italic_, `inline code`, citation markers [1] / [1, 2] and
// timestamps [12:04] / [1:02:03]. Everything else stays text.

import { parseTimestamp } from './format';

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'cite'; index: number }
  | { type: 'time'; sec: number };

export type Block =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'heading'; children: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; start: number; items: Inline[][] };

// One alternation; the first group that matched tells us which token we found.
// Order matters: `code` first (its content is literal), then bold before italic.
const INLINE_TOKEN = new RegExp(
  [
    '`([^`\\n]+)`', // 1: inline code
    '\\*\\*(?!\\s)([^\\n]+?)\\*\\*', // 2: **bold**
    '__(?!\\s)([^\\n]+?)__', // 3: __bold__
    '\\*(?![\\s*])([^*\\n]+?)\\*', // 4: *italic*
    '(?<![\\w])_(?![\\s_])([^_\\n]+?)_(?![\\w])', // 5: _italic_ (not inside snake_case)
    '\\[(\\d{1,3}(?:\\s*,\\s*\\d{1,3})*)\\]', // 6: [1] or [1, 2] citations
    '\\[((?:\\d{1,2}:)?\\d{1,3}:\\d{2})\\]', // 7: [12:04] or [1:02:03] timestamps
  ].join('|'),
  'g',
);

/** Parses one line (or a joined list item) into inline nodes. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += text;
    else out.push({ type: 'text', text });
  };

  // A fresh RegExp per call: global regexes carry `lastIndex` state, and we recurse.
  const re = new RegExp(INLINE_TOKEN.source, 'g');
  let pos = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    pushText(src.slice(pos, m.index));
    pos = m.index + m[0].length;
    const [whole, code, bold1, bold2, em1, em2, cites, time] = m;

    if (code !== undefined) out.push({ type: 'code', text: code });
    else if (bold1 !== undefined || bold2 !== undefined) out.push({ type: 'strong', children: parseInline(bold1 ?? bold2 ?? '') });
    else if (em1 !== undefined || em2 !== undefined) out.push({ type: 'em', children: parseInline(em1 ?? em2 ?? '') });
    else if (cites !== undefined) {
      cites.split(',').forEach((n, i) => {
        if (i > 0) pushText(' ');
        out.push({ type: 'cite', index: Number(n.trim()) });
      });
    } else if (time !== undefined) {
      const sec = parseTimestamp(time);
      if (sec === null) pushText(whole);
      else out.push({ type: 'time', sec });
    } else pushText(whole);
  }
  pushText(src.slice(pos));
  return out;
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*•+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const CONTINUATION = /^\s{2,}\S/;

/** Splits text into blocks. Single newlines inside a paragraph are kept as line breaks. */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] | null = null;
  let list: { type: 'ul' | 'ol'; start: number; items: string[] } | null = null;

  const flush = () => {
    if (para) blocks.push({ type: 'p', lines: para.map(parseInline) });
    if (list) {
      const items = list.items.map(parseInline);
      blocks.push(list.type === 'ul' ? { type: 'ul', items } : { type: 'ol', start: list.start, items });
    }
    para = null;
    list = null;
  };

  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim() || RULE.test(line)) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', children: parseInline(heading[1] ?? '') });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      const text = (bullet ? bullet[1] : numbered?.[2]) ?? '';
      if (para || (list && list.type !== type)) flush();
      if (!list) list = { type, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push(text);
      continue;
    }
    // Indented line right after a list item: it continues that item.
    if (list && CONTINUATION.test(line) && list.items.length > 0) {
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }
    if (list) flush();
    (para ??= []).push(line.trim());
  }
  flush();
  return blocks;
}

/** Only http(s) links are ever rendered as clickable (no javascript:, data:, …). */
export function safeHref(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
