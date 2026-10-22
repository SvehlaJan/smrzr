// "Report issue" (design §8): one sentence from you + a full debug bundle, sent to Sentry
// or copied to the clipboard as JSON.

import { useEffect, useState } from 'react';
import { buildDebugBundle, sendIssueReport } from '@/src/telemetry';
import { handleError } from '../errors';
import { logUiAction } from '../logger';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; what: 'send' | 'copy' }
  | { kind: 'sent'; eventId: string }
  | { kind: 'info'; text: string }
  | { kind: 'error'; text: string };

export function ReportDialog({ videoId, onClose }: { videoId: string | null; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const busy = status.kind === 'busy';

  // Escape closes the dialog, like a native modal.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async () => {
    logUiAction('report', { via: 'sentry', chars: message.trim().length }, videoId);
    setStatus({ kind: 'busy', what: 'send' });
    try {
      const res = await sendIssueReport({ message: message.trim(), videoId });
      if (res.ok) setStatus({ kind: 'sent', eventId: res.eventId });
      else if (res.reason === 'sentry_disabled')
        setStatus({
          kind: 'error',
          text: 'Sentry is off (or not configured). Turn on “Send error reports to Sentry” in Settings, or use “Copy debug bundle”.',
        });
      else setStatus({ kind: 'error', text: 'Sending failed. Use “Copy debug bundle” instead.' });
    } catch (err) {
      handleError(err, { videoId, task: 'report' });
      setStatus({ kind: 'error', text: 'Sending failed. Use “Copy debug bundle” instead.' });
    }
  };

  const copy = async () => {
    logUiAction('report', { via: 'clipboard' }, videoId);
    setStatus({ kind: 'busy', what: 'copy' });
    try {
      const json = JSON.stringify(await buildDebugBundle(videoId), null, 2);
      await navigator.clipboard.writeText(json);
      setStatus({ kind: 'info', text: `Debug bundle copied (${Math.ceil(json.length / 1024)} KB). Paste it into a chat or save it as a file.` });
    } catch (err) {
      handleError(err, { videoId, task: 'debug_bundle' });
      setStatus({ kind: 'error', text: "Couldn't copy the debug bundle." });
    }
  };

  return (
    // Clicking the dimmed backdrop closes; clicks inside the dialog don't bubble up to it.
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="report-title">Report issue</h2>
        <label className="field">
          <span>What went wrong?</span>
          <textarea
            autoFocus
            rows={4}
            value={message}
            placeholder="e.g. point 4 jumps 10 minutes too late"
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <p className="muted small">
          The report includes this video's transcript, prompts, model responses and recent log (never your API key).
        </p>

        {status.kind === 'sent' && (
          <p className="ok-text" role="status">
            Sent. Event id: <code>{status.eventId}</code>
          </p>
        )}
        {status.kind === 'info' && <p className="ok-text" role="status">{status.text}</p>}
        {status.kind === 'error' && <p className="error-text" role="alert">{status.text}</p>}

        <div className="row gap wrap">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send()}>
            {status.kind === 'busy' && status.what === 'send' ? 'Sending…' : 'Send to Sentry'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void copy()}>
            {status.kind === 'busy' && status.what === 'copy' ? 'Copying…' : 'Copy debug bundle'}
          </button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
