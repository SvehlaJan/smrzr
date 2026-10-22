// Secret scrubbing for everything that leaves the device (Sentry events, breadcrumbs, debug bundles).
// Design §8.3: "The Gemini API key must never leak into telemetry."

/** Google API keys: "AIza" + 35 URL-safe characters. */
const GOOGLE_API_KEY = /AIza[0-9A-Za-z_-]{35}/g;
/** `?key=…` / `&api_key=…` URL query parameters (how Google keys are passed when not sent as a header). */
const KEY_QUERY_PARAM = /([?&](?:key|api_?key)=)[^&#\s"'<>]*/gi;
/** Object property names whose values are always secret. */
const SECRET_PROPERTY = /^(?:api_?key|x-goog-api-key)$/i;

export const REDACTED = '<redacted>';
const MAX_DEPTH = 40;

/** Redacts API keys and `key=` query parameters inside a single string. */
export function scrubString(s: string): string {
  // Cheap pre-checks: most strings contain neither pattern, so skip the regex work.
  let out = s;
  if (out.includes('AIza')) out = out.replace(GOOGLE_API_KEY, REDACTED);
  if (/[?&](?:key|api_?key)=/i.test(out)) out = out.replace(KEY_QUERY_PARAM, `$1${REDACTED}`);
  return out;
}

/**
 * Deep-copies `value` and replaces anything that looks like a secret with "<redacted>":
 * - Google API keys (AIza…) anywhere inside strings,
 * - `key=` / `api_key=` URL query parameters,
 * - values of properties named apiKey / api_key / x-goog-api-key (case-insensitive), except the
 *   placeholders "" and "<empty>" so "no key configured" stays visible in debug bundles.
 *
 * Also makes the result safe to JSON.stringify / store in IndexedDB: cycles become "[Circular]",
 * Errors become plain { name, message, stack } objects and functions become "[Function]".
 */
export function scrubSecrets<T>(value: T): T {
  return scrubValue(value, new Set(), 0) as T;
}

function scrubValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'function') return '[Function]';
  if (value === null || typeof value !== 'object') return value; // number, boolean, undefined, bigint, symbol

  // Binary data can't hold a readable key in a way we could scrub; pass it through untouched.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (value instanceof Date) return new Date(value.getTime());

  // Only objects on the *current path* count as cycles; an object referenced twice from
  // different branches (a DAG) is simply copied twice.
  if (ancestors.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => scrubValue(item, ancestors, depth + 1));

    if (value instanceof Error) {
      return {
        name: value.name,
        message: scrubString(value.message),
        ...(value.stack ? { stack: scrubString(value.stack) } : {}),
      };
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_PROPERTY.test(key) ? redactSecretProperty(child) : scrubValue(child, ancestors, depth + 1);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function redactSecretProperty(v: unknown): unknown {
  if (v === undefined || v === null || v === '' || v === '<empty>' || v === REDACTED) return v;
  return REDACTED;
}

/**
 * Scrubs a Sentry event while leaving `sdkProcessingMetadata` untouched: the SDK keeps live
 * objects there (e.g. Scope instances for spans) that must not be turned into plain copies.
 * That field is internal and is never sent to Sentry.
 */
export function scrubEvent<E extends { sdkProcessingMetadata?: unknown }>(event: E): E {
  const { sdkProcessingMetadata, ...rest } = event;
  const scrubbed = scrubSecrets(rest) as E;
  if (sdkProcessingMetadata !== undefined) scrubbed.sdkProcessingMetadata = sdkProcessingMetadata;
  return scrubbed;
}
