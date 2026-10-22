// One key point: "number. title [ts] 💬" + gist. Clicking the point (not the timestamp)
// expands it; details are generated lazily on first expansion and cached in the record.

import { useId, useState } from 'react';
import type { KeyPoint, PointDetails } from '@/src/types';
import type { PointStatus } from '../hooks/useVideoSession';
import { ErrorCard } from './ErrorCard';
import { Markdown } from './Markdown';
import { Timestamp } from './Timestamp';

export interface KeyPointCardProps {
  point: KeyPoint;
  /** 1-based number shown before the title. */
  number: number;
  details?: PointDetails;
  status?: PointStatus;
  isFocus: boolean;
  /** Called every time the point is opened; the session decides whether a request is needed. */
  onExpand(pointId: string): void;
  onLookAtVisuals(pointId: string): void;
  onDiscuss(pointId: string): void;
  onOpenSettings(): void;
}

export function KeyPointCard(props: KeyPointCardProps) {
  const { point, number, details, status } = props;
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) props.onExpand(point.id);
  };

  return (
    <li className={`point${expanded ? ' expanded' : ''}${props.isFocus ? ' focused' : ''}`}>
      <div className="point-head">
        <button type="button" className="point-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={toggle}>
          <span className="point-num" aria-hidden="true">
            {expanded ? '▾' : '▸'} {number}.
          </span>
          <span className="point-text">
            <span className="point-title">{point.title}</span>
            <span className="point-gist">{point.gist}</span>
          </span>
        </button>
        <div className="point-side">
          {point.startSec !== null && <Timestamp sec={point.startSec} />}
          <button
            type="button"
            className="icon-btn"
            aria-label={`Discuss point ${number}`}
            aria-pressed={props.isFocus}
            title="Discuss this point"
            onClick={() => props.onDiscuss(point.id)}
          >
            💬
          </button>
        </div>
      </div>

      {expanded && (
        <div id={bodyId} className="point-body">
          <PointBody {...props} details={details} status={status} />
        </div>
      )}
    </li>
  );
}

function PointBody({ point, details, status, onExpand, onLookAtVisuals, onOpenSettings }: KeyPointCardProps) {
  const detailsOp = status?.details;
  const visualsOp = status?.visuals;

  if (!details) {
    if (detailsOp?.error) {
      return (
        <ErrorCard
          message={detailsOp.error.message}
          onRetry={() => onExpand(point.id)}
          onOpenSettings={detailsOp.error.settings ? onOpenSettings : undefined}
        />
      );
    }
    return <p className="muted progress">Loading details…</p>;
  }

  return (
    <>
      {details.subpoints.length > 0 && (
        <ul className="subpoints">
          {details.subpoints.map((sp, i) => (
            <li key={i}>
              <span>{sp.text}</span>
              {sp.startSec !== null && <Timestamp sec={sp.startSec} />}
            </li>
          ))}
        </ul>
      )}

      {details.context && (
        <aside className="context-block" aria-label="Context, not from the video">
          <span className="context-label">ⓘ Context (not from the video)</span>
          <p>{details.context}</p>
        </aside>
      )}

      {details.visuals ? (
        <section className="visuals-block" aria-label="What the video shows">
          <span className="context-label">👁 Visuals</span>
          <Markdown text={details.visuals} />
        </section>
      ) : visualsOp?.loading ? (
        <p className="muted progress">Looking at the video…</p>
      ) : (
        <>
          {visualsOp?.error && (
            <ErrorCard
              message={visualsOp.error.message}
              onOpenSettings={visualsOp.error.settings ? onOpenSettings : undefined}
            />
          )}
          {/* Without a verified start time there is no clip to send, so no button. */}
          {point.startSec !== null && (
            <button type="button" className="btn btn-small" onClick={() => onLookAtVisuals(point.id)}>
              👁 Look at the visuals for this part
            </button>
          )}
        </>
      )}
    </>
  );
}
