// Model list filtering and default selection (design §5.6).
//
// Model ids change every few months, so nothing is hardcoded: we look at the ids returned by
// models.list and pick "the newest Flash" / "the newest Pro" by parsing the version number out of
// the id. Typical ids (Oct 2026): gemini-2.5-flash, gemini-2.5-flash-lite, gemini-3-flash-preview,
// gemini-3-pro-preview, gemini-3.1-pro-preview, gemini-flash-latest, gemini-2.5-flash-preview-tts …
import type { LlmTask } from '../types';
import type { ModelInfo } from './client';

/**
 * Words that mark a model as not a plain text-generation model (or not useful for us):
 * embeddings, attributed QA, image/video/speech generation, realtime audio, agents, tuned
 * education models, and the open-weights Gemma family (weaker, no video input).
 * "deep-research" is an agent rather than a chat model.
 */
const EXCLUDED_WORDS = [
  'embedding',
  'aqa',
  'imagen',
  'veo',
  'tts',
  'image', // covers -image, -image-generation, -image-preview
  'live',
  'native-audio',
  'audio',
  'computer-use',
  'robotics',
  'learnlm',
  'gemma',
  'deep-research',
];

/** Filters models.list output down to text-generation Gemini models worth showing in the dropdowns. */
export function selectableModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => {
    const id = m.id.toLowerCase();
    if (!id.startsWith('gemini-')) return false;
    return !EXCLUDED_WORDS.some((word) => id.includes(word));
  });
}

/** Newest Flash for summary/details/visuals, newest Pro for chat (design §5.6). Empty string when nothing fits. */
export function pickDefaultModels(models: ModelInfo[]): Record<LlmTask, string> {
  const candidates = selectableModels(models);
  const anyModel = pickNewest(candidates);
  const flash = pickNewest(candidates.filter((m) => isFlash(m.id))) ?? anyModel;
  const pro = pickNewest(candidates.filter((m) => isPro(m.id))) ?? anyModel;

  const flashId = flash?.id ?? '';
  return { summary: flashId, details: flashId, visuals: flashId, chat: pro?.id ?? '' };
}

// ---------- helpers (exported for tests) ----------

/** "Flash" but not "Flash-Lite". */
export function isFlash(id: string): boolean {
  return /-flash(-|$)/.test(id) && !/-lite(-|$)/.test(id);
}

export function isPro(id: string): boolean {
  return /-pro(-|$)/.test(id);
}

/**
 * Version number from an id: "gemini-3.1-pro-preview" → [3, 1], "gemini-3-pro" → [3],
 * "gemini-flash-latest" → null (an alias without a version).
 */
export function parseVersion(id: string): number[] | null {
  const match = /^gemini-(\d+(?:\.\d+)*)/.exec(id);
  if (!match || !match[1]) return null;
  return match[1].split('.').map(Number);
}

/** 2 = stable, 1 = preview, 0 = experimental. Higher is preferred at equal version. */
function stabilityRank(id: string): number {
  if (/-exp(-|$)|experimental/.test(id)) return 0;
  if (/-preview(-|$)/.test(id)) return 1;
  return 2;
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Picks the "best" model: highest version, then stable over preview over experimental, then the
 * shorter id (plain alias like "gemini-2.5-flash" over "gemini-2.5-flash-001").
 * "-latest" aliases (no version number) are only used when nothing else is available.
 */
export function pickNewest(models: ModelInfo[]): ModelInfo | undefined {
  const versioned = models.filter((m) => parseVersion(m.id) !== null);
  const pool = versioned.length > 0 ? versioned : models;
  let best: ModelInfo | undefined;
  for (const m of pool) {
    if (!best || compareModels(m, best) > 0) best = m;
  }
  return best;
}

/** > 0 when `a` is preferred over `b`. */
function compareModels(a: ModelInfo, b: ModelInfo): number {
  const byVersion = compareVersions(parseVersion(a.id) ?? [], parseVersion(b.id) ?? []);
  if (byVersion !== 0) return byVersion;
  const byStability = stabilityRank(a.id) - stabilityRank(b.id);
  if (byStability !== 0) return byStability;
  if (a.id.length !== b.id.length) return b.id.length - a.id.length;
  // Last resort, just to be deterministic: later dated previews sort higher lexicographically.
  return a.id.localeCompare(b.id);
}
