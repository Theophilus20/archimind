import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** Keeps one broken page (or the 3D view) from taking down the whole studio. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; compact?: boolean }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[ArchiMind] ${this.props.label ?? 'view'} crashed: ${error.message}\n${info.componentStack ?? ''}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.compact ? '' : 'page-inner'} style={{ padding: this.props.compact ? 16 : undefined }}>
        <div className="card card-pad" style={{ borderColor: 'var(--red)' }}>
          <div style={{ fontWeight: 500, color: 'var(--red)', marginBottom: 6 }}>Something went wrong in {this.props.label ?? 'this view'}.</div>
          <div className="small muted" style={{ marginBottom: 12 }}>{this.state.error.message}</div>
          <button className="btn btn-outline btn-sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
