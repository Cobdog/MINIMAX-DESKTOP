/**
 * Canvas Phase 5 — Diagnostics docked (§8; inventory row 10: "diagnostics
 * ride the radar/engine chip").
 *
 * DiagnosticsView was built for exactly this move (store-fed, zero App-level
 * prop plumbing — its header note says so); the old shell's route died with
 * the shell, and the surface now opens from the titlebar next to Settings.
 * Everything stays on the machine (PII-scrubbed by construction).
 */
import { Rnd } from 'react-rnd'
import { Stethoscope, X } from 'lucide-react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { DiagnosticsView } from '../views/DiagnosticsView'
import { useCanvasStore } from './store'

export function DiagnosticsDock() {
  const open = useCanvasStore((state) => state.diagnosticsDock)
  const setDiagnosticsDock = useCanvasStore((state) => state.setDiagnosticsDock)

  if (!open) return null

  return <Rnd
    className="canvas-settings-dock"
    data-canvas-diagnostics-dock
    default={{ x: 160, y: 120, width: 760, height: Math.min(720, window.innerHeight - 180) }}
    minWidth={460}
    minHeight={300}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <Stethoscope size={13} />
      <strong>Diagnostics — docked</strong>
      <button type="button" aria-label="Close diagnostics" data-canvas-diagnostics-close onClick={() => setDiagnosticsDock(false)}><X size={13} /></button>
    </header>
    <div className="canvas-settings-body" data-canvas-diagnostics-body>
      <ErrorBoundary label="diagnostics">
        <DiagnosticsView />
      </ErrorBoundary>
    </div>
  </Rnd>
}
