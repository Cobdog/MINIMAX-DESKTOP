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
 */
import { useContext, useState } from 'react'
import { Rnd } from 'react-rnd'
import { Settings, X } from 'lucide-react'
import { h3StackReport } from '../lib/h3Stack'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { SettingsView } from '../views/SettingsView'
import type { AppSettings } from '../types'
import { CanvasSessionContext } from './sessionContext'
import { useCanvasStore } from './store'

export function SettingsDock() {
  const open = useCanvasStore((state) => state.settingsDock)
  const setSettingsDock = useCanvasStore((state) => state.setSettingsDock)
  const toast = useCanvasStore((state) => state.toast)
  // QOL wave (rrxlw2r): the fetch affordance's focus ids (an unavailable
  // canvas menu row deep-linked here) — consumed once by the FetchBrowser.
  const fetchFocus = useCanvasStore((state) => state.fetchFocus)
  const setFetchFocus = useCanvasStore((state) => state.setFetchFocus)
  const context = useContext(CanvasSessionContext)
  const [diagnosticRunning, setDiagnosticRunning] = useState(false)

  if (!open || !context) return null
  const { session, runDiagnostics } = context
  const { settings, setSettings, models, scanning, status, checking, ollamaModels, scanModels, checkConnection, refreshOllama } = session
  if (!settings) return null

  const save = async () => {
    try {
      // The old shell's exact save sequence: persist FIRST, then rescan +
      // recheck + refresh the LLM providers (saveSettings returns the
      // server-normalized settings).
      await window.minimax.saveSettings(settings)
      await Promise.all([scanModels(settings), checkConnection(settings.comfyUrl)])
      await refreshOllama(settings)
      toast('success', 'Settings saved and model folders rescanned.')
    } catch (error) {
      toast('error', `Settings could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const applyDefaults = () => {
    const next: AppSettings = {
      ...settings,
      generationDefaults: {
        ...settings.generationDefaults,
        resolution: '1344x768',
        duration: 6,
        steps: 30,
        turbo: 'off',
        sampler: 'res_multistep',
        scheduler: 'simple',
        experimentalSampling: false,
        sigmaShiftMode: 'model',
        shiftVideo: 12,
        shiftAudio: 3,
        loraStrength: 1,
        upscaleMode: 'off',
      },
    }
    void setSettings(next)
    toast('success', 'Recommended defaults applied — every NEW canvas chain starts from them (existing chains keep their own settings).')
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
    default={{ x: 120, y: 96, width: 720, height: Math.min(760, window.innerHeight - 160) }}
    minWidth={420}
    minHeight={280}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
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
          onSave={() => void save()}
          onApplyDefaults={applyDefaults}
          onRunDiagnostics={() => void runDiagnosticsNow()}
          fetchFocusEntryIds={fetchFocus ?? undefined}
          onFetchFocusConsumed={() => setFetchFocus(null)}
        />
      </ErrorBoundary>
    </div>
  </Rnd>
}
