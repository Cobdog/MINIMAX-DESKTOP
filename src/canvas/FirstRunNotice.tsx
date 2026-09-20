/**
 * First-run guidance (QOL wave, rrxlw2r, 2026-09-18): when the model scan
 * finds NOTHING, the launcher carries an onboarding empty state — the app is
 * never silently dead on a fresh install. Two honest paths: point the studio
 * at an existing ComfyUI install's model folders (Settings → Model locations;
 * weights stay in place — a managed engine mirrors them as
 * extra_model_paths.yaml, never copies), or open the consent-gated fetcher.
 *
 * Dismissible ONCE per browser (the LicenseNotice precedent — localStorage,
 * never a nag): dismissed means dismissed until the profile is reset.
 */
import { useEffect, useState } from 'react'
import { HardDrive, X } from 'lucide-react'
import { useSessionStore } from '../state/sessionStore'
import { useCanvasStore } from './store'

const DISMISS_KEY = 'minimax.first-run-dismissed'

export function FirstRunNotice() {
  const models = useSessionStore((state) => state.models)
  const scanning = useSessionStore((state) => state.scanning)
  const setSettingsDock = useCanvasStore((state) => state.setSettingsDock)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })
  // Scan-settled latch: never flash the notice in the pre-scan boot window
  // (models=[] before the first scan even starts).
  const [sawScan, setSawScan] = useState(false)
  useEffect(() => {
    if (scanning) setSawScan(true)
  }, [scanning])

  if (dismissed || !sawScan || scanning || models.length > 0) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* Non-fatal: it may show again next visit. */ }
    setDismissed(true)
  }

  const openSettings = () => {
    setSettingsDock(true)
    // The engine connection section is the destination (the registry-only
    // decision: the engine's own listing is the model source); the dock
    // scrolls internally, so give SettingsView a beat to mount first.
    window.setTimeout(() => {
      document.querySelector('.settings-page #comfy-url')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 300)
  }

  const openFetcher = () => {
    setSettingsDock(true)
    window.setTimeout(() => {
      document.querySelector('.fetch-section')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 300)
  }

  return <div className="canvas-first-run" role="note" aria-label="Model setup guidance" data-canvas-first-run>
    <HardDrive size={16} />
    <div className="canvas-first-run-body">
      <strong>No models visible — one setup step before the first render.</strong>
      <span>
        The model source of truth is the connected ComfyUI engine's own registry — the studio uses
        what the engine can see, nothing else. Connect the engine in Settings (a running install's
        address, or the managed runtime), or fetch weights through the consent-gated fetcher below
        and they land where the engine reads them. Input and output default under the app's own data
        folder (<em>&lt;app&gt;/data/input</em>, <em>&lt;app&gt;/data/output</em>) — nothing lands in Documents.
      </span>
      <div className="canvas-first-run-actions">
        <button type="button" onClick={openSettings}>Open settings — engine connection</button>
        <button type="button" onClick={openFetcher}>Browse fetchable items</button>
      </div>
    </div>
    <button type="button" className="canvas-first-run-dismiss" aria-label="Dismiss setup guidance" onClick={dismiss}><X size={14} /></button>
  </div>
}
