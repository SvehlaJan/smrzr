// Strategy 3 "dom": open YouTube's transcript panel in the page and read its rows.
// Ugly but independent of any API: it only depends on element names (which change too, so all
// selectors are listed at the top of this file). Runs in the MAIN world with the other strategies,
// though it only touches the DOM.
//
// Caveat: the panel shows YouTube's default transcript language, which for English videos is
// normally the English track, but we can't force our chosen track here.

import type { StrategyResult, TranscriptStrategyImpl } from '../chain';
import { rowFromTextLines, segmentsFromDomRows, type DomRow } from '../domParse';
import { TRANSCRIPT_PANEL_ID } from '../panelApi';

// ---- selectors (assumed from youtube.com as last seen; verify on real pages) ----
const PANEL_SELECTOR = `ytd-engagement-panel-section-list-renderer[target-id="${TRANSCRIPT_PANEL_ID}"]`;
/** The "Show transcript" button in the expanded description. */
const OPEN_BUTTON_SELECTORS = [
  'ytd-video-description-transcript-section-renderer button',
  'ytd-video-description-transcript-section-renderer ytd-button-renderer',
];
/** One row each. The second name is a newer "view model" component YouTube has been migrating to. */
const SEGMENT_SELECTORS = ['ytd-transcript-segment-renderer', 'transcript-segment-view-model'];
const TIMESTAMP_SELECTOR = '.segment-timestamp';
const TEXT_SELECTOR = '.segment-text';
// The panel's open/closed state is a plain attribute on the panel element.
const VISIBILITY_ATTR = 'visibility';
const EXPANDED = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
const HIDDEN = 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN';

export interface DomStrategyDeps {
  doc: Document;
  waitMs?: number;
  pollMs?: number;
}

function findSegmentElements(doc: Document): Element[] {
  for (const sel of SEGMENT_SELECTORS) {
    const els = Array.from(doc.querySelectorAll(sel));
    if (els.length > 0) return els;
  }
  return [];
}

/** Reads one row: known class names first, otherwise the texts of the row's leaf elements. */
export function readRow(el: Element): DomRow | null {
  const time = el.querySelector(TIMESTAMP_SELECTOR)?.textContent;
  const text = el.querySelector(TEXT_SELECTOR)?.textContent;
  if (time && text) return { timeText: time, text };
  const leaves = Array.from(el.querySelectorAll('*')).filter((e) => e.children.length === 0);
  const lines = leaves.length > 0 ? leaves.map((e) => e.textContent ?? '') : (el.textContent ?? '').split('\n');
  return rowFromTextLines(lines);
}

/** Tries the button first (what a user would do), then forcing the panel open. Returns false if neither exists. */
function openPanel(doc: Document): boolean {
  for (const sel of OPEN_BUTTON_SELECTORS) {
    const btn = doc.querySelector<HTMLElement>(sel);
    if (btn) {
      btn.click();
      return true;
    }
  }
  const panel = doc.querySelector(PANEL_SELECTOR);
  if (panel) {
    panel.setAttribute(VISIBILITY_ATTR, EXPANDED);
    return true;
  }
  return false;
}

/** Polls until segment elements exist and their count stopped changing (the list renders in batches). */
async function waitForSegments(doc: Document, waitMs: number, pollMs: number): Promise<Element[]> {
  const deadline = Date.now() + waitMs;
  let lastCount = -1;
  while (Date.now() < deadline) {
    const els = findSegmentElements(doc);
    if (els.length > 0 && els.length === lastCount) return els;
    lastCount = els.length;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return findSegmentElements(doc);
}

export function createDomStrategy(deps: DomStrategyDeps): TranscriptStrategyImpl {
  const waitMs = deps.waitMs ?? 8_000;
  const pollMs = deps.pollMs ?? 250;
  return {
    name: 'dom',
    timeoutMs: waitMs + 2_000,
    async run(): Promise<StrategyResult> {
      const { doc } = deps;
      const prevVisibility = doc.querySelector(PANEL_SELECTOR)?.getAttribute(VISIBILITY_ATTR) ?? null;
      let opened = false;
      try {
        let els = findSegmentElements(doc);
        if (els.length === 0) {
          opened = openPanel(doc);
          if (!opened) return { ok: false, outcome: 'error', detail: 'no transcript button or panel in page' };
          els = await waitForSegments(doc, waitMs, pollMs);
        }
        if (els.length === 0) {
          return { ok: false, outcome: 'timeout', detail: `no ${SEGMENT_SELECTORS.join('/')} after ${waitMs}ms` };
        }
        const rows = els.map(readRow).filter((r): r is DomRow => r !== null);
        const segments = segmentsFromDomRows(rows);
        if (segments.length === 0) {
          return { ok: false, outcome: 'parse_error', detail: `${els.length} rows, none parseable` };
        }
        return { ok: true, segments };
      } finally {
        // Put the panel back the way the viewer had it.
        if (opened && prevVisibility !== EXPANDED) {
          doc.querySelector(PANEL_SELECTOR)?.setAttribute(VISIBILITY_ATTR, prevVisibility ?? HIDDEN);
        }
      }
    },
  };
}
