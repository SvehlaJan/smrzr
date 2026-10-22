// One fetch helper for the strategies that talk to YouTube's servers, so that "HTTP error",
// "HTTP 200 with an empty body" and "network failure / timeout" are classified the same way
// everywhere. Runs in the MAIN world, i.e. requests go out with youtube.com's own cookies.

import type { TranscriptOutcome } from '../types';
import { errorDetail } from './chain';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type TextFetchResult =
  | { ok: true; body: string; status: number }
  | { ok: false; outcome: Exclude<TranscriptOutcome, 'ok'>; detail: string };

export async function fetchText(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<TextFetchResult> {
  // AbortController cancels the request if YouTube doesn't answer in time.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { credentials: 'same-origin', ...init, signal: controller.signal });
    if (!res.ok) return { ok: false, outcome: 'http_error', detail: `HTTP ${res.status}` };
    const body = await res.text();
    // The PO-token refusal: status 200, nothing in the body (design §4). A failure, not "no captions".
    if (body.trim() === '') return { ok: false, outcome: 'empty_200', detail: `HTTP ${res.status}, empty body` };
    return { ok: true, body, status: res.status };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, outcome: 'timeout', detail: `no response after ${timeoutMs}ms` };
    return { ok: false, outcome: 'error', detail: errorDetail(err) };
  } finally {
    clearTimeout(timer);
  }
}
