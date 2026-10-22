import type { LlmTask } from '../types';
import type { ModelInfo } from './client';
import { notImplemented } from '../notImplemented';

/** Newest Flash for summary/details/visuals, newest Pro for chat (design §5.6). Empty string when nothing fits. */
export function pickDefaultModels(models: ModelInfo[]): Record<LlmTask, string> {
  return notImplemented('pickDefaultModels');
}

/** Filters models.list output down to text-generation Gemini models worth showing in the dropdowns. */
export function selectableModels(models: ModelInfo[]): ModelInfo[] {
  return notImplemented('selectableModels');
}
