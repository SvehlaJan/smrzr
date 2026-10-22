import type { TranscriptFailure as Failure } from '../session';
import { transcriptFailureMessage } from '../session';
import { ErrorCard } from './ErrorCard';

/** Transcript errors, with the per-strategy attempts in a collapsible list for debugging. */
export function TranscriptFailure({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  const showAttempts = failure.error === 'all_strategies_failed' && failure.attempts.length > 0;
  return (
    <ErrorCard message={transcriptFailureMessage(failure)} onRetry={failure.error === 'all_strategies_failed' ? onRetry : undefined}>
      {showAttempts && (
        // <details>/<summary> is the browser's built-in collapsible section.
        <details className="attempts">
          <summary>What was tried ({failure.attempts.length})</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">Strategy</th>
                <th scope="col">Outcome</th>
                <th scope="col">ms</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {failure.attempts.map((a, i) => (
                <tr key={i}>
                  <td>{a.strategy}</td>
                  <td>{a.outcome}</td>
                  <td>{Math.round(a.ms)}</td>
                  <td>{a.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </ErrorCard>
  );
}
