// Turning thrown errors into short, human messages for error cards.

import { LlmError } from '@/src/llm/client';
import { getLogger } from './logger';

export interface UiError {
  message: string;
  /** True when the fix lives in Settings (show an "Open Settings" button). */
  settings?: boolean;
}

type LlmErrorKind = LlmError['kind'];

function llmKind(err: unknown): LlmErrorKind | null {
  if (err instanceof LlmError) return err.kind;
  // Duck-typing fallback in case the error crossed a module boundary (e.g. two bundles).
  if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'LlmError') {
    const kind = (err as { kind?: unknown }).kind;
    return typeof kind === 'string' ? (kind as LlmErrorKind) : null;
  }
  return null;
}

/** User pressed Stop, the video changed, or the panel is going away. Never shown, never logged. */
export function isAbortError(err: unknown): boolean {
  if (llmKind(err) === 'aborted') return true;
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Chrome's error when `tabs.sendMessage` finds no content script in the tab, e.g. the tab
 * was already open before the extension was installed/reloaded.
 */
export function isNoReceiverError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Receiving end does not exist|Could not establish connection/i.test(msg);
}

const LLM_MESSAGES: Record<Exclude<LlmErrorKind, 'aborted'>, UiError> = {
  auth: { message: 'Gemini rejected this API key.', settings: true },
  quota: { message: 'Gemini quota or billing limit reached.' },
  blocked: { message: 'Gemini blocked this response (safety filter).' },
  network: { message: "Couldn't reach Gemini. Check your connection and try again." },
  server: { message: 'Gemini is having problems right now. Try again in a moment.' },
  bad_request: { message: 'Gemini rejected the request. Please report this so it can be fixed.' },
};

/** Friendly description, or null for errors that should be silently ignored (aborts). */
export function describeError(err: unknown): UiError | null {
  if (isAbortError(err)) return null;
  const kind = llmKind(err);
  if (kind && kind !== 'aborted') return LLM_MESSAGES[kind];
  if (isNoReceiverError(err)) {
    return { message: "Couldn't reach the YouTube tab. Reload the tab and try again." };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { message: `Something went wrong: ${detail}` };
}

/**
 * The one place UI code sends caught errors: logs them (unless they are aborts) and
 * returns what to show. `null` means "show nothing".
 */
export function handleError(err: unknown, context: { videoId?: string | null; task: string }): UiError | null {
  if (isAbortError(err)) return null;
  getLogger().error(err, { task: context.task, videoId: context.videoId ?? undefined });
  return describeError(err);
}
