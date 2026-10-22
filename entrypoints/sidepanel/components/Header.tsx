import { formatCost, formatDuration } from '../format';

export type View = 'video' | 'history' | 'settings';

const VIEW_TITLES: Record<Exclude<View, 'video'>, string> = { history: 'History', settings: 'Settings' };

export function Header(props: {
  view: View;
  title: string | null;
  durationSec: number | null;
  costUsd: number | null;
  onBack(): void;
  onReport(): void;
  onHistory(): void;
  onSettings(): void;
}) {
  const { view } = props;
  return (
    <header className="header">
      <div className="header-main">
        {view === 'video' ? (
          <>
            <h1 className="header-title" title={props.title ?? undefined}>
              {props.title ?? 'smrzr'}
            </h1>
            <div className="header-meta">
              {props.durationSec ? <span>{formatDuration(props.durationSec)}</span> : null}
              {props.costUsd !== null && (
                <span className="cost" title="Gemini cost so far for this video">
                  {formatCost(props.costUsd)}
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <button type="button" className="icon-btn" aria-label="Back to video" onClick={props.onBack}>
              ←
            </button>
            <h1 className="header-title">{VIEW_TITLES[view]}</h1>
          </>
        )}
      </div>
      <nav className="header-actions" aria-label="Panel">
        <button type="button" className="icon-btn" aria-label="Report issue" title="Report issue" onClick={props.onReport}>
          ⚑
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="History"
          title="History"
          aria-pressed={view === 'history'}
          onClick={props.onHistory}
        >
          🕘
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Settings"
          title="Settings"
          aria-pressed={view === 'settings'}
          onClick={props.onSettings}
        >
          ⚙
        </button>
      </nav>
    </header>
  );
}
