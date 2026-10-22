// Locally stored videos, newest first, with search and delete.

import { useEffect, useState } from 'react';
import { deleteVideo, listHistory, type HistoryItem } from '@/src/storage/db';
import { ErrorCard } from '../components/ErrorCard';
import { handleError, type UiError } from '../errors';
import { formatCost, formatDuration, formatRelativeDate } from '../format';

export function HistoryView({ currentVideoId, onOpen }: { currentVideoId: string | null; onOpen(videoId: string): void }) {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  // Re-query when the search text changes, debounced so we don't hit IndexedDB per keystroke.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const q = search.trim();
        const list = await listHistory(q ? { search: q } : {});
        if (!cancelled) {
          setItems(list);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(handleError(err, { task: 'history' }));
      }
    }, search ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, refresh]);

  const remove = async (videoId: string) => {
    setConfirmId(null);
    try {
      await deleteVideo(videoId);
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(handleError(err, { videoId, task: 'history_delete' }));
    }
  };

  return (
    <div className="history">
      <input
        type="search"
        className="input"
        placeholder="Search titles and channels"
        aria-label="Search history"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {error && <ErrorCard message={error.message} onRetry={() => setRefresh((n) => n + 1)} />}
      {items === null && !error && <p className="muted progress pad">Loading…</p>}
      {items?.length === 0 && <p className="muted pad">{search ? 'Nothing matches.' : 'No videos yet. Summaries you make show up here.'}</p>}
      <ul className="history-list">
        {items?.map((item) => (
          <li key={item.videoId} className={item.videoId === currentVideoId ? 'current' : undefined}>
            <button type="button" className="history-open" onClick={() => onOpen(item.videoId)}>
              <span className="history-title">{item.title || item.videoId}</span>
              <span className="muted small">
                {[item.channel, formatDuration(item.durationSec), formatCost(item.totalCostUsd), formatRelativeDate(item.lastOpenedAt)]
                  .filter(Boolean)
                  .join(' · ')}
                {!item.hasSummary && ' · no summary'}
              </span>
            </button>
            {confirmId === item.videoId ? (
              <span className="row gap">
                <button type="button" className="btn btn-danger btn-small" onClick={() => void remove(item.videoId)}>
                  Delete
                </button>
                <button type="button" className="btn btn-small" onClick={() => setConfirmId(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="icon-btn"
                aria-label={`Delete ${item.title || item.videoId} from history`}
                title="Delete"
                onClick={() => setConfirmId(item.videoId)}
              >
                🗑
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
