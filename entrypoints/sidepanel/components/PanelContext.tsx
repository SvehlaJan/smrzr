// Panel-wide actions available to any component without passing props through every
// level (React "context" ≈ dependency injection scoped to a subtree):
//   - seek(sec): jump the YouTube player (used by every timestamp button)
//   - openReport(): open the "Report issue" dialog (used by every error card)

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { requestSeek } from '@/src/messaging';
import { handleError } from '../errors';
import { logUiAction } from '../logger';

export interface PanelActions {
  seek(sec: number): void;
  openReport(): void;
}

const PanelContext = createContext<PanelActions>({ seek: () => {}, openReport: () => {} });

export function usePanel(): PanelActions {
  return useContext(PanelContext);
}

const SEEK_FAILED = "Couldn't jump in the video. Reload the YouTube tab and try again.";

export function PanelProvider(props: {
  tabId: number | null;
  videoId: string | null;
  onOpenReport: () => void;
  children: ReactNode;
}) {
  const { tabId, videoId, onOpenReport } = props;
  const [notice, setNotice] = useState<string | null>(null);

  const seek = useCallback(
    (sec: number) => {
      if (tabId === null) return;
      logUiAction('seek', { sec }, videoId);
      setNotice(null);
      requestSeek(tabId, sec)
        .then((res) => {
          if (!res?.ok) setNotice(SEEK_FAILED);
        })
        .catch((err) => {
          handleError(err, { videoId, task: 'seek' });
          setNotice(SEEK_FAILED);
        });
    },
    [tabId, videoId],
  );

  const value = useMemo(() => ({ seek, openReport: onOpenReport }), [seek, onOpenReport]);

  return (
    <PanelContext.Provider value={value}>
      {props.children}
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}
    </PanelContext.Provider>
  );
}
