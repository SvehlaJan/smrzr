// The discussion area under the key points: message list, focus chip, quick actions and
// the input box. It is presentational: sending/stopping is delegated to the session.

import { useState, type KeyboardEvent, type Ref } from 'react';
import { QUICK_ACTIONS } from '@/src/pipeline';
import type { ChatMessage, KeyPoint } from '@/src/types';
import type { UiError } from '../errors';
import type { PendingChat } from '../hooks/useVideoSession';
import { ChatMessageView } from './ChatMessageView';
import { ErrorCard } from './ErrorCard';

export interface ChatDockProps {
  messages: ChatMessage[];
  pending: PendingChat | null;
  error: UiError | null;
  points: KeyPoint[];
  focusPointId: string | null;
  onClearFocus(): void;
  /** Resolves true when the message went through (the input is cleared then). */
  onSend(text: string, opts?: { quickAction?: string }): Promise<boolean>;
  onStop(): void;
  onOpenSettings(): void;
  /** Lets the parent focus the textarea (e.g. after clicking 💬 on a point). */
  inputRef?: Ref<HTMLTextAreaElement>;
}

export function ChatDock(props: ChatDockProps) {
  const { messages, pending, points } = props;
  const [draft, setDraft] = useState('');
  const streaming = pending !== null;

  const pointLabel = (pointId: string | null) => {
    if (!pointId) return null;
    const i = points.findIndex((p) => p.id === pointId);
    return i >= 0 ? `#${i + 1}` : null;
  };
  const focusIndex = points.findIndex((p) => p.id === props.focusPointId);
  const focusPoint = focusIndex >= 0 ? points[focusIndex] : undefined;

  const send = async (text: string, opts?: { quickAction?: string }) => {
    if (!text.trim() || streaming) return;
    const typed = !opts?.quickAction;
    if (typed) setDraft(''); // clear right away; put it back if the turn fails or is stopped
    const ok = await props.onSend(text, opts);
    if (!ok && typed) setDraft((current) => current || text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline. `isComposing` skips IME composition (e.g. CJK input).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <section className="chat" aria-label="Discussion">
      {(messages.length > 0 || pending) && (
        <div className="messages">
          {messages.map((m) => (
            <ChatMessageView
              key={m.id}
              role={m.role}
              text={m.text}
              citations={m.citations}
              searchEntryPointHtml={m.searchEntryPointHtml}
              focusLabel={m.role === 'user' ? pointLabel(m.focusPointId) : null}
            />
          ))}
          {pending && (
            <>
              <ChatMessageView role="user" text={pending.userText} focusLabel={pointLabel(pending.focusPointId)} />
              <ChatMessageView role="model" text={pending.replySoFar} streaming />
            </>
          )}
        </div>
      )}

      {props.error && (
        <ErrorCard message={props.error.message} onOpenSettings={props.error.settings ? props.onOpenSettings : undefined} />
      )}

      <div className="chat-controls">
        {focusPoint && (
          <div className="focus-chip">
            <span className="focus-text">
              Focus: #{focusIndex + 1} {focusPoint.title}
            </span>
            <button type="button" className="icon-btn" aria-label="Clear focus" onClick={props.onClearFocus}>
              ✕
            </button>
          </div>
        )}

        {QUICK_ACTIONS.length > 0 && (
          <div className="chips" role="group" aria-label="Quick actions">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                className="chip"
                disabled={streaming}
                onClick={() => void send(a.prompt, { quickAction: a.id })}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}

        <div className="composer">
          <textarea
            ref={props.inputRef}
            value={draft}
            rows={2}
            placeholder={focusPoint ? `Ask about #${focusIndex + 1}…` : 'Ask about this video…'}
            aria-label="Message"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {streaming ? (
            <button type="button" className="btn" onClick={props.onStop}>
              ■ Stop
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!draft.trim()} onClick={() => void send(draft)}>
              Send
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
