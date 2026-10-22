import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyPointCard } from '@/entrypoints/sidepanel/components/KeyPointCard';
import { PanelProvider } from '@/entrypoints/sidepanel/components/PanelContext';
import type { PointDetails } from '@/src/types';
import { makeRecord, META, SUMMARY, TAB_ID, usage, VIDEO_ID, VideoHarness } from './fixtures';
import { dbMock, memoryDb, messagingMock, pipelineMock, resetMocks } from './mocks';

vi.mock('@/src/messaging', async () => (await import('./mocks')).messagingMock);
vi.mock('@/src/telemetry', async () => (await import('./mocks')).telemetryMock);
vi.mock('@/src/pipeline', async () => (await import('./mocks')).pipelineMock);
vi.mock('@/src/storage/db', async () => (await import('./mocks')).dbMock);
vi.mock('@/src/llm/gemini', async () => (await import('./mocks')).geminiMock);

beforeEach(() => {
  resetMocks();
  messagingMock.requestVideoContext.mockResolvedValue({ ok: true, meta: META });
});
afterEach(cleanup);

const DETAILS: PointDetails = {
  subpoints: [
    { text: 'Study design: 5 nights of 5h sleep', startSec: 760 },
    { text: 'No timestamp here', startSec: null },
  ],
  context: 'Insulin sensitivity measures how cells respond to insulin.',
};

function renderCard(pointIndex: number, onExpand = vi.fn()) {
  const point = SUMMARY.points[pointIndex]!;
  render(
    <PanelProvider tabId={TAB_ID} videoId={VIDEO_ID} onOpenReport={() => {}}>
      <ol>
        <KeyPointCard
          point={point}
          number={pointIndex + 1}
          isFocus={false}
          onExpand={onExpand}
          onLookAtVisuals={() => {}}
          onDiscuss={() => {}}
          onOpenSettings={() => {}}
        />
      </ol>
    </PanelProvider>,
  );
  return { onExpand };
}

describe('KeyPointCard', () => {
  it('seeks to the point start without toggling the point', () => {
    const { onExpand } = renderCard(0);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to 12:04' }));
    expect(messagingMock.requestSeek).toHaveBeenCalledWith(TAB_ID, 724);
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('hides the timestamp when startSec is null', () => {
    renderCard(1);
    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();
  });

  it('offers "Look at the visuals" only for points with a verified start time', () => {
    const renderWithDetails = (pointIndex: number) =>
      render(
        <PanelProvider tabId={TAB_ID} videoId={VIDEO_ID} onOpenReport={() => {}}>
          <ol>
            <KeyPointCard
              point={SUMMARY.points[pointIndex]!}
              number={pointIndex + 1}
              details={DETAILS}
              isFocus={false}
              onExpand={() => {}}
              onLookAtVisuals={() => {}}
              onDiscuss={() => {}}
              onOpenSettings={() => {}}
            />
          </ol>
        </PanelProvider>,
      );

    renderWithDetails(1); // p2: startSec === null
    fireEvent.click(screen.getByRole('button', { name: /Delay caffeine/ }));
    expect(screen.getByText('ⓘ Context (not from the video)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Look at the visuals/ })).toBeNull();
    cleanup();

    renderWithDetails(0); // p1: has a start time
    fireEvent.click(screen.getByRole('button', { name: /Weekend catch-up sleep/ }));
    expect(screen.getByRole('button', { name: /Look at the visuals/ })).toBeTruthy();
  });

  it('calls onExpand when opened, not when closed', () => {
    const { onExpand } = renderCard(0);
    const toggle = screen.getByRole('button', { name: /Weekend catch-up sleep/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

describe('KeyPointCard + session (lazy details)', () => {
  it('generates details once, then reuses the cached copy', async () => {
    memoryDb.set(VIDEO_ID, makeRecord());
    pipelineMock.expandPoint.mockResolvedValue({ details: DETAILS, usage: usage(0.005) });
    render(<VideoHarness />);

    const toggle = await screen.findByRole('button', { name: /Weekend catch-up sleep/ });
    fireEvent.click(toggle);
    expect(await screen.findByText('Study design: 5 nights of 5h sleep')).toBeTruthy();
    expect(screen.getByText('ⓘ Context (not from the video)')).toBeTruthy();
    // Sub-point timestamps seek; the null one has no button.
    fireEvent.click(screen.getByRole('button', { name: 'Jump to 12:40' }));
    expect(messagingMock.requestSeek).toHaveBeenCalledWith(TAB_ID, 760);

    expect(pipelineMock.expandPoint).toHaveBeenCalledTimes(1);
    expect(pipelineMock.expandPoint.mock.calls[0]?.[1]).toBe('flash-1');
    expect(pipelineMock.expandPoint.mock.calls[0]?.[3]).toBe('p1');
    const saved = memoryDb.get(VIDEO_ID)!;
    expect(saved.details.p1?.subpoints).toHaveLength(2);
    expect(saved.totalCostUsd).toBeCloseTo(0.035);

    // Collapse and re-open: no second request.
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(await screen.findByText('Study design: 5 nights of 5h sleep')).toBeTruthy();
    expect(pipelineMock.expandPoint).toHaveBeenCalledTimes(1);
  });

  it('never calls expandPoint when details are already stored', async () => {
    memoryDb.set(VIDEO_ID, makeRecord({ details: { p1: DETAILS } }));
    render(<VideoHarness />);
    fireEvent.click(await screen.findByRole('button', { name: /Weekend catch-up sleep/ }));
    expect(screen.getByText('Study design: 5 nights of 5h sleep')).toBeTruthy();
    expect(pipelineMock.expandPoint).not.toHaveBeenCalled();
  });

  it('looks at the visuals and stores the result', async () => {
    memoryDb.set(VIDEO_ID, makeRecord({ details: { p1: DETAILS } }));
    pipelineMock.analyzeVisuals.mockResolvedValue({ text: 'A **chart** of reaction times.', usage: usage(0.02) });
    render(<VideoHarness />);
    fireEvent.click(await screen.findByRole('button', { name: /Weekend catch-up sleep/ }));
    fireEvent.click(screen.getByRole('button', { name: /Look at the visuals/ }));
    expect(await screen.findByText('chart')).toBeTruthy();
    expect(pipelineMock.analyzeVisuals.mock.calls[0]?.[2]).toMatchObject({ id: 'p1' });
    expect(memoryDb.get(VIDEO_ID)?.details.p1?.visuals).toBe('A **chart** of reaction times.');
    expect(dbMock.updateVideo).toHaveBeenCalled();
  });
});
