// Catches errors thrown while rendering the views below it, so one broken view shows an error
// card (with "Report issue") instead of a blank panel. React only offers this as a class component
// (there is no hook for it).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getLogger } from '../logger';
import { ErrorCard } from './ErrorCard';

interface Props {
  children: ReactNode;
  /** When this changes (e.g. another view or video), a previous error is cleared. */
  resetKey?: string;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  /** Called by React during rendering: switch to the fallback UI. */
  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  /** Called by React after the fallback is shown: the place for side effects like logging. */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    getLogger().error(error, { task: 'render', componentStack: info.componentStack?.slice(0, 1000) });
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <ErrorCard
          message="Something went wrong while showing this screen."
          onRetry={() => this.setState({ failed: false })}
        />
      );
    }
    return this.props.children;
  }
}
