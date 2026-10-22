// The main screen: what to show for the active tab's video, driven by session.status.

import { useRef, useState } from 'react';
import type { Settings, VideoMeta, VideoRecord } from '@/src/types';
import { ChatDock } from '../components/ChatDock';
import { ErrorCard } from '../components/ErrorCard';
import { KeyPointCard } from '../components/KeyPointCard';
import { TranscriptFailure } from '../components/TranscriptFailure';
import { formatDuration } from '../format';
import type { VideoSession } from '../hooks/useVideoSession';
import { setupProblem } from '../session';

export interface VideoViewProps {
  session: VideoSession;
  settings: Settings | null;
  onOpenSettings(): void;
  onOpenHistory(): void;
}

export function VideoView({ session, settings, onOpenSettings, onOpenHistory }: VideoViewProps) {
  const { status, meta } = session;

  switch (status.kind) {
    case 'idle':
      return (
        <div className="empty">
          <p>Open a YouTube video to summarize it.</p>
          <button type="button" className="btn" onClick={onOpenHistory}>
            🕘 History
          </button>
        </div>
      );

    case 'loading':
      return <p className="muted progress pad">Loading video…</p>;

    case 'needs_reload':
      return (
        <ErrorCard
          message="smrzr can't talk to this YouTube tab yet. Reload the YouTube tab (it was probably open before smrzr was installed or updated)."
          onRetry={session.reload}
          retryLabel="Check again"
        />
      );

    case 'context_error':
      return <ErrorCard message={status.error.message} onRetry={session.reload} />;

    case 'live':
      return (
        <>
          {meta && <VideoIntro meta={meta} />}
          <p className="notice">Live streams aren't supported yet.</p>
        </>
      );

    case 'ready': {
      const problem = setupProblem(settings, 'summary');
      return (
        <>
          {meta && <VideoIntro meta={meta} />}
          {status.stale && (
            <p className="muted small">The saved summary was made with older prompts. Summarize again to refresh it.</p>
          )}
          {problem ? (
            <div className="card">
              <p>{problem}</p>
              <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                Open Settings
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary btn-block" onClick={() => void session.summarize()}>
              Summarize
            </button>
          )}
        </>
      );
    }

    case 'working':
      return (
        <>
          {meta && <VideoIntro meta={meta} />}
          <p className="progress pad" role="status">
            <span className="spinner" aria-hidden="true" />
            {status.step === 'transcript' ? 'Fetching transcript…' : 'Summarizing…'}
          </p>
          <button type="button" className="btn" onClick={session.cancelSummarize}>
            Cancel
          </button>
        </>
      );

    case 'transcript_failed':
      return (
        <>
          {meta && <VideoIntro meta={meta} />}
          <TranscriptFailure failure={status.failure} onRetry={() => void session.summarize()} />
        </>
      );

    case 'error':
      return (
        <>
          {meta && <VideoIntro meta={meta} />}
          <ErrorCard
            message={status.error.message}
            onRetry={() => void session.summarize()}
            onOpenSettings={status.error.settings ? onOpenSettings : undefined}
          />
        </>
      );

    case 'summary':
      return session.record?.summary ? (
        <SummaryView session={session} record={session.record} onOpenSettings={onOpenSettings} />
      ) : null;
  }
}

function VideoIntro({ meta }: { meta: VideoMeta }) {
  return (
    <div className="intro">
      <p className="intro-title">{meta.title}</p>
      <p className="muted small">
        {[meta.channel, formatDuration(meta.durationSec)].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}

function SummaryView({ session, record, onOpenSettings }: { session: VideoSession; record: VideoRecord; onOpenSettings(): void }) {
  // `summary` is guaranteed by the caller; the fallback keeps TypeScript happy.
  const summary = record.summary ?? { tldr: '', points: [] };
  const [focusPointId, setFocusPointId] = useState<string | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  const discuss = (pointId: string) => {
    setFocusPointId(pointId);
    chatInputRef.current?.focus();
    chatInputRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  return (
    <>
      {summary.tldr && (
        <p className="tldr">
          <strong>TL;DR</strong> {summary.tldr}
        </p>
      )}
      <ol className="points">
        {summary.points.map((point, i) => (
          <KeyPointCard
            key={point.id}
            point={point}
            number={i + 1}
            details={record.details[point.id]}
            status={session.points[point.id]}
            isFocus={focusPointId === point.id}
            onExpand={(id) => void session.expand(id)}
            onLookAtVisuals={(id) => void session.lookAtVisuals(id)}
            onDiscuss={discuss}
            onOpenSettings={onOpenSettings}
          />
        ))}
      </ol>
      <ChatDock
        messages={record.chat}
        pending={session.chat}
        error={session.chatError}
        points={summary.points}
        focusPointId={focusPointId}
        onClearFocus={() => setFocusPointId(null)}
        onSend={(text, opts) => session.sendChat(text, focusPointId, opts)}
        onStop={session.stopChat}
        onOpenSettings={onOpenSettings}
        inputRef={chatInputRef}
      />
    </>
  );
}
