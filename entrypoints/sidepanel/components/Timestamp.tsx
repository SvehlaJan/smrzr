import { formatTimestamp } from '../format';
import { usePanel } from './PanelContext';

/** "[12:04]" button that seeks the YouTube player. */
export function Timestamp({ sec }: { sec: number }) {
  const { seek } = usePanel();
  const label = formatTimestamp(sec);
  return (
    <button
      type="button"
      className="ts"
      aria-label={`Jump to ${label}`}
      onClick={(e) => {
        // Timestamps sit inside clickable rows; don't also toggle/expand the row.
        e.stopPropagation();
        seek(sec);
      }}
    >
      [{label}]
    </button>
  );
}
