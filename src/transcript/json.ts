// Tiny helpers for walking YouTube's untyped JSON safely.
//
// YouTube's page data (player response, "ytInitialData", innertube API responses) is huge,
// undocumented and changes shape often. Instead of declaring big TypeScript interfaces that
// would lie to us, we treat it as `unknown` and read single fields with these helpers, which
// return `undefined` instead of throwing when something is missing.

/** Reads a nested property, e.g. `dig(obj, 'videoDetails', 'title')`. Numbers index arrays. */
export function dig(value: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Accepts numbers and numeric strings (YouTube sends many numbers as strings, e.g. "lengthSeconds": "754"). */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * YouTube renders text either as `{ simpleText: "..." }` or as `{ runs: [{ text: "..." }, ...] }`.
 * Returns the plain string for both shapes.
 */
export function ytText(value: unknown): string | undefined {
  const simple = asString(dig(value, 'simpleText'));
  if (simple !== undefined) return simple;
  const runs = dig(value, 'runs');
  if (Array.isArray(runs)) {
    return runs.map((r) => asString(dig(r, 'text')) ?? '').join('');
  }
  // Newer "view model" components sometimes use `{ content: "..." }`.
  return asString(dig(value, 'content'));
}

/**
 * Depth-first search for every value stored under `key`, anywhere in the tree.
 * Used where YouTube's nesting changes often but the leaf renderer name stays stable.
 * `maxNodes` guards against pathological inputs.
 */
export function findAllByKey(root: unknown, key: string, maxNodes = 500_000): unknown[] {
  const found: unknown[] = [];
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < maxNodes) {
    const node = stack.pop();
    visited++;
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      // Push in reverse so that items are visited in document order.
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i]!;
      if (k === key) found.push(obj[k]);
      stack.push(obj[k]);
    }
  }
  // Matches come out in (roughly) document order; callers that care sort by timestamp anyway.
  return found;
}
