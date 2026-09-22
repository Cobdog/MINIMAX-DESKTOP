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
 *
 * Wave 3 (R-15, tg52kaq): the STICKY SAVE footer — the save affordance is
 * pinned to the dock (not the page heading 15k px away, audit M1) and it is
 * DIRTY-AWARE (the footer states unsaved-changes vs all-saved against the
 * last persisted snapshot). R-15's Library surface: the view's onOpenLibrary
 * opens the LibraryDock (focus ids ride through for the pack deep-links).
 * R-21: the dock mounts on every surface (each provides the session
 * context) — opening it never replaces the view.
 */
import { useContext, useEffect, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import { Save, Settings, X } from 'lucide-react'
import { h3StackReport } from '../lib/h3Stack'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { PACKS_CHANGED_EVENT } from '../components/LibraryDock'
import { SettingsView } from '../views/SettingsView'
import { useSessionStore } from '../state/sessionStore'
import { CanvasSessionContext } from './sessionContext'
import { dockDefaultGeometry } from './dockGeometry'
import { useCanvasStore } from './store'

export function SettingsDock() {
  const open = useCanvasStore((state) => state.settingsDock)
  const focusSection = useCanvasStore((state) => state.settingsDockSection)
  const setSettingsDock = useCanvasStore((state) => state.setSettingsDock)
  const setLibraryDock = useCanvasStore((state) => state.setLibraryDock)
  // (R-01) The pack board re-resolves its live chips on every object_info
  // re-pull (engine recovery included) — selected before the early return so
  // the hook order is unconditional.
  const infoEpoch = useSessionStore((state) => state.engineWatch.infoEpoch)
  const toast = useCanvasStore((state) => state.toast)
  const raiseDock = useCanvasStore((state) => state.raiseDock)
  const context = useContext(CanvasSessionContext)
  const [diagnosticRunning, setDiagnosticRunning] = useState(false)
  // Dock stacking (review M11): this dock's own z, raised on open and on
  // any pointer grab — independent of the other docks' z values.
  const [dockZ, setDockZ] = useState(60)
  useEffect(() => { if (open) setDockZ(raiseDock()) }, [open, raiseDock])

  // The dirty-aware save (R-15/M1): the last PERSISTED snapshot. Adopted on
  // first settings arrival; rewritten after every successful save; the
  // footer's state line compares against it live. The snapshot is defensive
  // BY DESIGN: it runs outside the view's error boundary, so an adversarial
  // settings object (a poisoned getter — the error-boundary e2e's exact
  // case) must degrade to "dirty", never crash the shell.
  const savedRef = useRef<string | null>(null)
  const settings = useSessionStore((state) => state.settings)
  const snapshotOf = (value: unknown): string | null => {
    try { return JSON.stringify(value) } catch { return null }
  }
  if (open && settings && savedRef.current === null) savedRef.current = snapshotOf(settings)
  const dirty = Boolean(open && settings && savedRef.current !== null && snapshotOf(settings) !== savedRef.current)

  if (!open || !context || !settings) return null
  const { session, runDiagnostics } = context
  const { setSettings, models, scanning, status, checking, ollamaModels, scanModels, checkConnection, refreshOllama } = session

  const save = async () => {
    try {
      // The old shell's exact save sequence: persist FIRST, then re-pull the
      // inventory + recheck + refresh the LLM providers. M4 (review
      // 2026-09-19): the wrapper now surfaces the server's save-warnings
      // (well-formed but nonexistent paths) instead of dropping them for a
      // flat success — the save still succeeds; the toast names every miss.
      const saved = await window.minimax.saveSettings(settings)
      savedRef.current = snapshotOf(settings)
      await Promise.all([scanModels(saved.settings, { refresh: true }), checkConnection(saved.settings.comfyUrl)])
      await refreshOllama(saved.settings)
      // (R-10/R-15) The save can change the pack install target — announce so
      // the pack board re-resolves its chips (the library fetch fires the
      // same event).
      window.dispatchEvent(new CustomEvent(PACKS_CHANGED_EVENT))
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
          h3Report={h3StackReport(models, settings.modelOverrides?.minimax, session.info)}
          scanning={scanning}
          status={status}
          checking={checking}
          diagnosticRunning={diagnosticRunning}
          ollamaModels={ollamaModels}
          onRefreshOllama={() => void refreshOllama(settings)}
          onScan={() => void scanModels(settings, { refresh: true })}
          onCheck={() => void checkConnection(settings.comfyUrl)}
          onRunDiagnostics={() => void runDiagnosticsNow()}
          onOpenLibrary={(focusEntryIds) => setLibraryDock(true, focusEntryIds)}
        />
      </ErrorBoundary>
    </div>
    {/* R-15/M1: the sticky, dirty-aware save — always at the dock's foot,
        never a 15k-px scroll away. */}
    {/* The section deep-link is consumed on open (R-19): scroll once the
        view mounts, then clear it so reopen lands at the top. */}
    {focusSection && <SettingsSectionFocus section={focusSection} onConsumed={() => useCanvasStore.setState({ settingsDockSection: null })} />}
    <footer className="canvas-settings-footer" data-settings-save-footer>
      <span className={`settings-dirty-state ${dirty ? 'dirty' : ''}`} data-settings-dirty={dirty ? 'unsaved' : 'saved'} role="status">
        {dirty ? 'Unsaved changes' : 'All changes saved'}
      </span>
      <button type="button" className="primary-button" data-save-settings onClick={() => void save()}>
        <Save size={15} /> Save settings
      </button>
    </footer>
  </Rnd>
}

/** Scrolls the settings body to the deep-linked section once, then reports
 *  consumption (the param is one-shot). */
function SettingsSectionFocus(props: { section: string; onConsumed(): void }) {
  useEffect(() => {
    const target = document.querySelector(`[data-settings-section="${props.section}"]`)
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' })
    const timer = window.setTimeout(props.onConsumed, 400)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
