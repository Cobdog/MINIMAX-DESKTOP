/**
 * Canvas Phase 4 — Settings docked (§8: "Settings docked"; the thin-surface
 * pattern — Settings stays reachable from every surface).
 *
 * A react-rnd floating panel mounting the SAME SettingsView the old shell
 * renders, fed from the canvas route's session context (EngineHost's live
 * useStudioSession values — one poller, both surfaces). Saving rescans and
 * rechecks exactly like the old shell's save path; generation defaults
 * become the canvas's chain-settings defaults (every NEW chain starts
 * there — per-chain divergence is the document model's own).
 *
 * Settings UX wave (g5x37k8, 2026-09-19): the default geometry is
 * viewport-clamped (dockDefaultGeometry) and the dock raises to the top of
 * the dock stack on open and on any grab (store.raiseDock) — three open
 * docks no longer stack at near-identical positions with DOM order picking
 * the winner.
 */
import { useContext, useEffect, useState } from 'react'
import { Rnd } from 'react-rnd'
import { Settings, X } from 'lucide-react'
import { h3StackReport } from '../lib/h3Stack'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { SettingsView } from '../views/SettingsView'
import { useSessionStore } from '../state/sessionStore'
import { CanvasSessionContext } from './sessionContext'
import { dockDefaultGeometry } from './dockGeometry'
import { useCanvasStore } from './store'

export function SettingsDock() {
  const open = useCanvasStore((state) => state.settingsDock)
  const setSettingsDock = useCanvasStore((state) => state.setSettingsDock)
  // (R-01) The pack board re-resolves its live chips on every object_info
  // re-pull (engine recovery included) — selected before the early return so
  // the hook order is unconditional.
  const infoEpoch = useSessionStore((state) => state.engineWatch.infoEpoch)
  const toast = useCanvasStore((state) => state.toast)
  const raiseDock = useCanvasStore((state) => state.raiseDock)
  // QOL wave (rrxlw2r): the fetch affordance's focus ids (an unavailable
  // canvas menu row deep-linked here) — consumed once by the FetchBrowser.
  const context = useContext(CanvasSessionContext)
  const [diagnosticRunning, setDiagnosticRunning] = useState(false)
  // Dock stacking (review M11): this dock's own z, raised on open and on
  // any pointer grab — independent of the other docks' z values.
  const [dockZ, setDockZ] = useState(60)
  useEffect(() => { if (open) setDockZ(raiseDock()) }, [open, raiseDock])

  if (!open || !context) return null
  const { session, runDiagnostics } = context
  const { settings, setSettings, models, scanning, status, checking, ollamaModels, scanModels, checkConnection, refreshOllama } = session
  if (!settings) return null

  const save = async () => {
    try {
      // The old shell's exact save sequence: persist FIRST, then re-pull the
      // inventory + recheck + refresh the LLM providers. M4 (review
      // 2026-09-19): the wrapper now surfaces the server's save-warnings
      // (well-formed but nonexistent paths) instead of dropping them for a
      // flat success — the save still succeeds; the toast names every miss.
      const saved = await window.minimax.saveSettings(settings)
      await Promise.all([scanModels(saved.settings, { refresh: true }), checkConnection(saved.settings.comfyUrl)])
      await refreshOllama(saved.settings)
      toast('success', saved.warnings?.length
        ? `Settings saved and the engine registry refreshed. Warnings: ${saved.warnings.join(' · ')}`
        : 'Settings saved and the engine registry refreshed.')
    } catch (error) {
      toast('error', `Settings could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const runDiagnosticsNow = async () => {
    setDiagnosticRunning(true)
    try {
      await runDiagnostics()
    } finally {
      setDiagnosticRunning(false)
    }
  }

  return <Rnd
    className="canvas-settings-dock"
    data-canvas-settings-dock
    style={{ zIndex: dockZ }}
    onPointerDownCapture={() => setDockZ(raiseDock())}
    default={dockDefaultGeometry({ x: 120, y: 96, width: 720, height: Math.min(760, window.innerHeight - 160) })}
    minWidth={420}
    minHeight={280}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    resizeHandleClasses={{ bottomRight: 'settings-resize-handle-br' }}
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <Settings size={13} />
      <strong>Settings — docked</strong>
      <button type="button" aria-label="Close settings" data-canvas-settings-close onClick={() => setSettingsDock(false)}><X size={13} /></button>
    </header>
    <div className="canvas-settings-body" data-canvas-settings-body>
      {/* Per-surface boundary — the discipline the old shell's per-view
          wrappers carried (a crashing surface must not take the app down). */}
      <ErrorBoundary label="settings">
        <SettingsView
          settings={settings}
          setSettings={(value) => void setSettings(value)}
          info={session.info}
          infoEpoch={infoEpoch}
          models={models}
          h3Report={h3StackReport(models, settings.modelOverrides?.minimax)}
          scanning={scanning}
          status={status}
          checking={checking}
          diagnosticRunning={diagnosticRunning}
          ollamaModels={ollamaModels}
          onRefreshOllama={() => void refreshOllama(settings)}
          onScan={() => void scanModels(settings, { refresh: true })}
          onCheck={() => void checkConnection(settings.comfyUrl)}
          onSave={save}
          onRunDiagnostics={() => void runDiagnosticsNow()}
        />
      </ErrorBoundary>
    </div>
  </Rnd>
}
