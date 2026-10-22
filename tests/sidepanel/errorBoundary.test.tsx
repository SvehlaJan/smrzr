import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/entrypoints/sidepanel/components/ErrorBoundary';
import { PanelProvider } from '@/entrypoints/sidepanel/components/PanelContext';
import { loggerMock, resetMocks } from './mocks';

vi.mock('@/src/messaging', async () => (await import('./mocks')).messagingMock);
vi.mock('@/src/telemetry', async () => (await import('./mocks')).telemetryMock);

beforeEach(() => {
  resetMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports caught render errors too
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let shouldThrow = true;
function Fragile() {
  if (shouldThrow) throw new Error('render bug');
  return <p>All good</p>;
}

function renderBoundary(resetKey: string, onOpenReport = () => {}) {
  return render(
    <PanelProvider tabId={1} videoId="v" onOpenReport={onOpenReport}>
      <ErrorBoundary resetKey={resetKey}>
        <Fragile />
      </ErrorBoundary>
    </PanelProvider>,
  );
}

describe('ErrorBoundary', () => {
  it('shows an error card with Report issue instead of a blank panel, and logs the error once', () => {
    shouldThrow = true;
    const onOpenReport = vi.fn();
    renderBoundary('video:v', onOpenReport);

    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong while showing this screen/);
    fireEvent.click(screen.getByRole('button', { name: /Report issue/ }));
    expect(onOpenReport).toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.error.mock.calls[0]?.[0]).toMatchObject({ message: 'render bug' });
    expect(loggerMock.error.mock.calls[0]?.[1]).toMatchObject({ task: 'render' });
  });

  it('recovers with "Try again" and when the view changes', () => {
    shouldThrow = true;
    const { rerender } = renderBoundary('video:v');
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('All good')).toBeTruthy();

    shouldThrow = true;
    rerender(
      <PanelProvider tabId={1} videoId="v" onOpenReport={() => {}}>
        <ErrorBoundary resetKey="history:v">
          <Fragile />
        </ErrorBoundary>
      </PanelProvider>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    shouldThrow = false;
    rerender(
      <PanelProvider tabId={1} videoId="v" onOpenReport={() => {}}>
        <ErrorBoundary resetKey="settings:v">
          <Fragile />
        </ErrorBoundary>
      </PanelProvider>,
    );
    expect(screen.getByText('All good')).toBeTruthy();
  });
});
