import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../src/llm/client';
import { parseVersion, pickDefaultModels, pickNewest, selectableModels } from '../../src/llm/models';
import { estimateCostUsd } from '../../src/llm/pricing';

describe('estimateCostUsd', () => {
  it('prices flash, flash-lite and pro per 1M tokens', () => {
    expect(estimateCostUsd('gemini-3-flash', 1_000_000, 1_000_000, 0)).toBeCloseTo(0.75 + 3.75);
    expect(estimateCostUsd('gemini-2.5-flash-lite', 1_000_000, 1_000_000, 0)).toBeCloseTo(0.25 + 1.5);
    expect(estimateCostUsd('gemini-3.1-pro-preview', 100_000, 100_000, 0)).toBeCloseTo(0.1 * 2.0 + 0.1 * 12.0);
    expect(estimateCostUsd('models/gemini-3-flash-preview', 0, 1_000_000, 0)).toBeCloseTo(3.75);
  });

  it('uses the long-context price for pro above 200k prompt tokens', () => {
    expect(estimateCostUsd('gemini-3-pro', 200_000, 0, 0)).toBeCloseTo(0.4);
    expect(estimateCostUsd('gemini-3-pro', 250_000, 100_000, 0)).toBeCloseTo(0.25 * 4 + 0.1 * 18);
  });

  it('charges cached tokens at 25% without double counting', () => {
    // 40k prompt tokens of which 30k cached: 10k full price + 30k at 25%.
    const cost = estimateCostUsd('gemini-3-flash', 40_000, 0, 30_000)!;
    expect(cost).toBeCloseTo((10_000 * 0.75 + 30_000 * 0.75 * 0.25) / 1_000_000);
    // Cached can never exceed input.
    expect(estimateCostUsd('gemini-3-flash', 100, 0, 500)).toBeCloseTo((100 * 0.75 * 0.25) / 1_000_000);
  });

  it('returns null for unknown models', () => {
    expect(estimateCostUsd('gemma-3-27b-it', 1000, 1000, 0)).toBeNull();
    expect(estimateCostUsd('claude-sonnet', 1000, 1000, 0)).toBeNull();
  });
});

const m = (id: string): ModelInfo => ({ id, displayName: id, inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 });

// Roughly what models.list returned in late 2026 (generateContent models only).
const REALISTIC = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-preview-09-2025',
  'gemini-2.5-flash-image',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro',
  'gemini-2.5-pro-preview-tts',
  'gemini-2.5-computer-use-preview-10-2025',
  'gemini-2.5-flash-native-audio-preview-09-2025',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-3-pro-image-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
  'gemini-robotics-er-1.5-preview',
  'gemini-embedding-001',
  'gemini-live-2.5-flash-preview',
  'learnlm-2.0-flash-experimental',
  'gemma-3-27b-it',
  'imagen-4.0-generate-001',
  'veo-3.0-generate-001',
  'aqa',
  'deep-research-pro-preview-12-2025',
].map(m);

describe('selectableModels', () => {
  it('keeps only Gemini text models', () => {
    const ids = selectableModels(REALISTIC).map((x) => x.id);
    expect(ids).toEqual([
      'gemini-2.0-flash',
      'gemini-2.0-flash-001',
      'gemini-2.0-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash-preview-09-2025',
      'gemini-2.5-pro',
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'gemini-pro-latest',
    ]);
  });
});

describe('pickDefaultModels', () => {
  it('picks the newest Flash (not Lite) and the newest Pro', () => {
    expect(pickDefaultModels(REALISTIC)).toEqual({
      summary: 'gemini-3-flash-preview',
      details: 'gemini-3-flash-preview',
      visuals: 'gemini-3-flash-preview',
      chat: 'gemini-3.1-pro-preview',
    });
  });

  it('prefers stable over preview at the same version', () => {
    const picked = pickDefaultModels(['gemini-3-flash-preview', 'gemini-3-flash', 'gemini-3-pro-preview', 'gemini-3-pro', 'gemini-2.5-pro'].map(m));
    expect(picked.summary).toBe('gemini-3-flash');
    expect(picked.chat).toBe('gemini-3-pro');
  });

  it('a newer preview beats an older stable', () => {
    expect(pickDefaultModels(['gemini-3-pro', 'gemini-3.1-pro-preview', 'gemini-2.5-pro'].map(m)).chat).toBe('gemini-3.1-pro-preview');
  });

  it('uses -latest aliases only when nothing else exists', () => {
    expect(pickDefaultModels(['gemini-flash-latest', 'gemini-pro-latest'].map(m))).toEqual({
      summary: 'gemini-flash-latest',
      details: 'gemini-flash-latest',
      visuals: 'gemini-flash-latest',
      chat: 'gemini-pro-latest',
    });
  });

  it('falls back to any selectable model, or "" when none', () => {
    expect(pickDefaultModels(['gemini-2.5-flash-lite'].map(m))).toEqual({
      summary: 'gemini-2.5-flash-lite',
      details: 'gemini-2.5-flash-lite',
      visuals: 'gemini-2.5-flash-lite',
      chat: 'gemini-2.5-flash-lite',
    });
    expect(pickDefaultModels(['gemini-2.5-pro'].map(m)).summary).toBe('gemini-2.5-pro');
    expect(pickDefaultModels([m('gemma-3-27b-it'), m('imagen-4.0-generate-001')])).toEqual({ summary: '', details: '', visuals: '', chat: '' });
    expect(pickDefaultModels([])).toEqual({ summary: '', details: '', visuals: '', chat: '' });
  });

  it('parses versions', () => {
    expect(parseVersion('gemini-3.1-pro-preview')).toEqual([3, 1]);
    expect(parseVersion('gemini-3-pro')).toEqual([3]);
    expect(parseVersion('gemini-flash-latest')).toBeNull();
    expect(pickNewest(['gemini-2.5-flash', 'gemini-2.5-flash-001'].map(m))?.id).toBe('gemini-2.5-flash');
  });
});
