/**
 * React error boundary — the client half of the PII-scrubbed diagnostics
 * seam. A render bug anywhere below a boundary replaces that subtree with a
 * dark fallback (the .boot aesthetic) instead of a white screen: in a
 * long-lived studio tab, one crashing view must not take the shell or the
 * other workspaces down with it.
 *
 * Everything it logs or renders passes through the SAME pure sanitizer as
 * the server (src/lib/logSanitize.ts): failure path and reason only — the
 * raw message, which can embed arbitrary prompt text, is never emitted.
 * The short `ref` is the grep handle: it appears in the fallback UI and in
 * the console line, so a screenshot of the app matches its log.
 */
import { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { createId } from '../lib/createId'
import { ERROR_FALLBACK_TITLE, sanitizeError } from '../lib/logSanitize'

type ErrorBoundaryProps = { label?: string; children: ReactNode }
// Object-only state shape (no null union): React 19's JSX element check
// compares class instances structurally and `Readonly<any>` does not accept
// null, so a `X | null` state type rejects the whole class as a component.
type ErrorBoundaryState = { failed: false } | { failed: true; summary: string; path: string; ref: string }

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const detail = sanitizeError(error)
    return { failed: true, summary: detail.reason, path: detail.path, ref: createId().slice(0, 8) }
  }

  componentDidCatch(error: unknown) {
    // React's componentStack argument is not logged: it is redundant with
    // the stack path below, and un-sanitized text is never allowed on
    // principle.
    const detail = sanitizeError(error)
    const label = this.props.label ? `boundary:${this.props.label}` : 'boundary'
    const ref = this.state.failed ? this.state.ref : ''
    console.error(`[${label}] ref=${ref} name=${detail.name} reason=${detail.reason} path=${detail.path}`)
  }

  private reload = () => {
    // Resets boundary state → children remount. If the bug is still there
    // the boundary simply catches again; if it was transient the view heals.
    this.setState({ failed: false })
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="boot error-boundary" role="alert">
          <AlertTriangle size={30} />
          <strong className="error-boundary-title">{ERROR_FALLBACK_TITLE}</strong>
          {this.state.summary && <code className="error-boundary-summary">{this.state.summary}</code>}
          {this.state.path && <span className="error-boundary-path">{this.state.path}</span>}
          <span className="error-boundary-ref">ref {this.state.ref}</span>
          <button type="button" className="secondary-button" onClick={this.reload}>
            <RotateCcw size={14} />
            Reload view
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
