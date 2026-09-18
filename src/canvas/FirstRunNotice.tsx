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
    // The Model locations section is the destination; the dock scrolls
    // internally, so give SettingsView a beat to mount first.
    window.setTimeout(() => {
      document.querySelector('.settings-page .path-table')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
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
      <strong>No models found — one setup step before the first render.</strong>
      <span>
        The studio's model folders are empty. Point <em>Settings → Model locations</em> at an existing
        ComfyUI install's models folders (files are indexed in place, never moved — a managed engine
        mirrors them into its checkout as extra_model_paths.yaml), or fetch what you need from the
        consent-gated fetcher below.
      </span>
      <div className="canvas-first-run-actions">
        <button type="button" onClick={openSettings}>Open settings — model locations</button>
        <button type="button" onClick={openFetcher}>Browse fetchable items</button>
      </div>
    </div>
    <button type="button" className="canvas-first-run-dismiss" aria-label="Dismiss setup guidance" onClick={dismiss}><X size={14} /></button>
  </div>
}
