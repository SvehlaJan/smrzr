import type { ReactNode } from 'react';
import { usePanel } from './PanelContext';

/** Every error card offers "Report issue" (design §8), plus optional retry / settings buttons. */
export function ErrorCard(props: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  onOpenSettings?: () => void;
  children?: ReactNode;
}) {
  const { openReport } = usePanel();
  return (
    <div className="card error-card" role="alert">
      <p className="error-text">{props.message}</p>
      {props.children}
      <div className="row gap">
        {props.onRetry && (
          <button type="button" className="btn" onClick={props.onRetry}>
            {props.retryLabel ?? 'Try again'}
          </button>
        )}
        {props.onOpenSettings && (
          <button type="button" className="btn" onClick={props.onOpenSettings}>
            Open Settings
          </button>
        )}
        <button type="button" className="btn btn-quiet" onClick={openReport}>
          ⚑ Report issue
        </button>
      </div>
    </div>
  );
}
