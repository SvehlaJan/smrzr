import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '@/entrypoints/sidepanel/components/Markdown';
import { PanelProvider } from '@/entrypoints/sidepanel/components/PanelContext';
import { parseInline, parseMarkdown } from '@/entrypoints/sidepanel/markdown';
import { messagingMock, resetMocks } from './mocks';

vi.mock('@/src/messaging', async () => (await import('./mocks')).messagingMock);
vi.mock('@/src/telemetry', async () => (await import('./mocks')).telemetryMock);

beforeEach(resetMocks);
afterEach(cleanup);

const CITATIONS = [
  { index: 1, title: 'Depner et al. 2019', uri: 'https://example.org/paper' },
  { index: 3, title: 'Evil', uri: 'javascript:alert(1)' },
];

function renderMd(text: string) {
  return render(
    <PanelProvider tabId={5} videoId="abcdefghijk" onOpenReport={() => {}}>
      <Markdown text={text} citations={CITATIONS} />
    </PanelProvider>,
  );
}

describe('Markdown renderer', () => {
  it('renders HTML in model text as plain text (no injection)', () => {
    const { container } = renderMd('Look: <img src=x onerror="alert(1)"> and <script>alert(2)</script>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('renders bold, italic, code, and lists', () => {
    const { container } = renderMd('**Verdict: mostly supported** and *caveats* with `n=36`\n\n- one\n- two\n\n1. first\n2. second');
    expect(container.querySelector('strong')?.textContent).toBe('Verdict: mostly supported');
    expect(container.querySelector('em')?.textContent).toBe('caveats');
    expect(container.querySelector('code')?.textContent).toBe('n=36');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('links [n] markers to matching http(s) citations only', () => {
    const { container } = renderMd('The study [1] is real; see also [2] and [3].');
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    const a = links[0]!;
    expect(a.textContent).toBe('[1]');
    expect(a.getAttribute('href')).toBe('https://example.org/paper');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    // Unknown [2] and javascript: [3] stay plain text.
    expect(container.textContent).toContain('[2]');
    expect(container.textContent).toContain('[3]');
  });

  it('turns timestamps into seek buttons', () => {
    renderMd('In the video [12:04] and later [1:02:03].');
    fireEvent.click(screen.getByRole('button', { name: 'Jump to 12:04' }));
    expect(messagingMock.requestSeek).toHaveBeenCalledWith(5, 724);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to 1:02:03' }));
    expect(messagingMock.requestSeek).toHaveBeenLastCalledWith(5, 3723);
  });
});

describe('markdown parser', () => {
  it('splits multi-citations and keeps snake_case intact', () => {
    expect(parseInline('a [1, 2]')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'cite', index: 1 },
      { type: 'text', text: ' ' },
      { type: 'cite', index: 2 },
    ]);
    expect(parseInline('snake_case_name')).toEqual([{ type: 'text', text: 'snake_case_name' }]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
  });

  it('keeps invalid timestamps as text', () => {
    expect(parseInline('[12:75]')).toEqual([{ type: 'text', text: '[12:75]' }]);
  });

  it('groups paragraphs and lists', () => {
    const blocks = parseMarkdown('# Verdict\nline one\nline two\n\n- a\n  continued\n- b');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'p', 'ul']);
    const list = blocks[2];
    expect(list?.type === 'ul' && list.items[0]).toEqual([{ type: 'text', text: 'a continued' }]);
  });
});
