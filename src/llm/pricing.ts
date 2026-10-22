// Rough price table (USD per 1M tokens) for cost estimates shown in the panel. Design §6.
//
// ⚠ APPROXIMATE. These numbers come from third-party price trackers (Oct 2026), not from an
// official Google price list, and Google changes prices often (Flash is announced to double on
// 2027-01-01). They are only used for the "this video: $0.04" estimate, never for billing.
// Search grounding fees (free tier, then per-1000-requests) are NOT included.
//
// Matching is pattern-based so new model versions ("gemini-3.2-flash-preview") get a sensible
// estimate without a code change. Rows are checked top to bottom; first match wins, so the more
// specific "flash-lite" must come before "flash".

interface PriceRow {
  /** Human-readable family name, for debugging only. */
  family: string;
  pattern: RegExp;
  inputPerM: number;
  outputPerM: number;
  /** Some models charge more for long prompts (above `thresholdTokens` prompt tokens). */
  longContext?: { thresholdTokens: number; inputPerM: number; outputPerM: number };
}

const PRICE_TABLE: PriceRow[] = [
  { family: 'flash-lite', pattern: /^gemini-.*flash-lite/, inputPerM: 0.25, outputPerM: 1.5 },
  { family: 'flash', pattern: /^gemini-.*flash/, inputPerM: 0.75, outputPerM: 3.75 },
  {
    family: 'pro',
    pattern: /^gemini-.*pro/,
    inputPerM: 2.0,
    outputPerM: 12.0,
    longContext: { thresholdTokens: 200_000, inputPerM: 4.0, outputPerM: 18.0 },
  },
];

/** Cached input tokens cost roughly this fraction of the normal input price. */
const CACHED_INPUT_FACTOR = 0.25;

/**
 * Estimated cost of one call in USD. Returns null when the model is not recognized.
 *
 * @param inputTokens  all prompt tokens, INCLUDING the cached ones (that is how Gemini reports
 *                     `promptTokenCount`), so cached tokens are not counted twice.
 * @param outputTokens answer tokens + thinking tokens (both are billed as output).
 * @param cachedTokens the part of `inputTokens` served from the implicit cache.
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, cachedTokens: number): number | null {
  const id = model.replace(/^models\//, '').toLowerCase();
  const row = PRICE_TABLE.find((r) => r.pattern.test(id));
  if (!row) return null;

  let inputPrice = row.inputPerM;
  let outputPrice = row.outputPerM;
  if (row.longContext && inputTokens > row.longContext.thresholdTokens) {
    inputPrice = row.longContext.inputPerM;
    outputPrice = row.longContext.outputPerM;
  }

  const cached = Math.min(Math.max(cachedTokens, 0), Math.max(inputTokens, 0));
  const uncached = Math.max(inputTokens, 0) - cached;
  const usd =
    (uncached * inputPrice + cached * inputPrice * CACHED_INPUT_FACTOR + Math.max(outputTokens, 0) * outputPrice) / 1_000_000;
  return usd;
}
