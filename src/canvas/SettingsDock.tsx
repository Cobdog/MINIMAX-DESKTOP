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
 * the winner. The LTX-2.3 run row is wired through the shared submit core
 * (it used to be unreachable dead code: onRunLtxUtility was never passed).
 */
import { useContext, useEffect, useState } from 'react'
import { Rnd } from 'react-rnd'
import { Settings, X } from 'lucide-react'
import { h3StackReport } from '../lib/h3Stack'
import { submitLtx23Utility } from '../lib/ltx23UtilitySubmit'
import type { Ltx23UtilityKind } from '../lib/graph/ltx23'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { SettingsView } from '../views/SettingsView'
import type { MediaFile } from '../types'
import { useJobsStore } from '../state/jobsStore'
import { CanvasSessionContext } from './sessionContext'
import { dockDefaultGeometry } from './dockGeometry'
import { engineBridge, useCanvasStore } from './store'

export function SettingsDock() {
  const open = useCanvasStore((state) => state.settingsDock)
  const setSettingsDock = useCanvasStore((state) => state.setSettingsDock)
  const toast = useCanvasStore((state) => state.toast)
  const raiseDock = useCanvasStore((state) => state.raiseDock)
  // QOL wave (rrxlw2r): the fetch affordance's focus ids (an unavailable
  // canvas menu row deep-linked here) — consumed once by the FetchBrowser.
  const fetchFocus = useCanvasStore((state) => state.fetchFocus)
  const setFetchFocus = useCanvasStore((state) => state.setFetchFocus)
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
      // The old shell's exact save sequence: persist FIRST, then rescan +
      // recheck + refresh the LLM providers. M4 (review 2026-09-19): the
      // wrapper now surfaces the server's save-warnings (well-formed but
      // nonexistent paths) instead of dropping them for a flat success —
      // the save still succeeds; the toast names every miss.
      const saved = await window.minimax.saveSettings(settings)
      await Promise.all([scanModels(saved.settings), checkConnection(saved.settings.comfyUrl)])
      await refreshOllama(saved.settings)
      toast('success', saved.warnings?.length
        ? `Settings saved and model folders rescanned. Warnings: ${saved.warnings.join(' · ')}`
        : 'Settings saved and model folders rescanned.')
    } catch (error) {
      toast('error', `Settings could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // M7 (review 2026-09-19): the LTX-2.3 utilities run row — wired through
  // the SAME shared core the canvas uses (lib/ltx23UtilitySubmit.ts), so the
  // row the section copy always promised actually submits. Validation and
  // refusals surface as toasts from the core; the job lands in the shared
  // queue like every other run.
  const runLtxUtility = async (options: { tool: Ltx23UtilityKind; input: MediaFile | null; audio?: MediaFile | null; prompt?: string }): Promise<string | null> => {
    const result = await submitLtx23Utility(
      {
        tool: options.tool,
        prompt: options.prompt,
        video: options.tool === 'ia2v' ? null : options.input,
        image: options.tool === 'ia2v' ? options.input ?? null : undefined,
        audio: options.audio ?? null,
      },
      { settings, connected: status.connected, info: session.info, models, clientId: engineBridge.clientId },
      {
        notify: (tone, text) => toast(tone, text),
        setJobs: (update) => useJobsStore.getState().setJobs(update),
        cancellationRequests: engineBridge.cancellationRequests ?? { current: new Set<string>() },
      },
    )
    return result.ok ? null : result.message
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
          models={models}
          h3Report={h3StackReport(models, settings.modelOverrides?.minimax)}
          scanning={scanning}
          status={status}
          checking={checking}
          diagnosticRunning={diagnosticRunning}
          ollamaModels={ollamaModels}
          onRefreshOllama={() => void refreshOllama(settings)}
          onScan={() => void scanModels(settings)}
          onCheck={() => void checkConnection(settings.comfyUrl)}
          onSave={save}
          onRunDiagnostics={() => void runDiagnosticsNow()}
          onRunLtxUtility={runLtxUtility}
          fetchFocusEntryIds={fetchFocus ?? undefined}
          onFetchFocusConsumed={() => setFetchFocus(null)}
        />
      </ErrorBoundary>
    </div>
  </Rnd>
}
