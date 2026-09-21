/**
 * First-run guidance (QOL wave, rrxlw2r, 2026-09-18; registry-only since
 * Wave 2 R-12; R-16 rework, Wave 3): the FALLBACK surface for the empty
 * registry. The wizard (FirstRunWizard) absorbs the journey on a fresh
 * home; this notice catches every path that skipped, closed, or outran it —
 * two sentences, two buttons (m3's wall-of-text fix; the implementation
 * detail moved into the wizard's steps where it's actionable).
 *
 * Dismissible ONCE per browser (the LicenseNotice precedent — localStorage,
 * never a nag): dismissed means dismissed until the profile is reset. The
 * latch is keep-listed (§4): dismiss-once, never-flash-before-scan.
 */
import { useEffect, useState } from 'react'
import { HardDrive, X } from 'lucide-react'
import { useSessionStore } from '../state/sessionStore'
import { useCanvasStore } from './store'
import { WIZARD_STATE_EVENT } from './FirstRunWizard'

const DISMISS_KEY = 'minimax.first-run-dismissed'

/** Reopen signal the notice's CTA fires (the wizard listens and resets its
 *  skipped/done state — reopening is one click from the fallback surface). */
export const WIZARD_REOPEN_EVENT = 'minimax:reopen-wizard'

export function FirstRunNotice() {
  const models = useSessionStore((state) => state.models)
  const scanning = useSessionStore((state) => state.scanning)
  const setSettingsDock = useCanvasStore((state) => state.setSettingsDock)
  const setLibraryDock = useCanvasStore((state) => state.setLibraryDock)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })
  // Scan-settled latch: never flash the notice in the pre-scan boot window
  // (models=[] before the first scan even starts).
  const [sawScan, setSawScan] = useState(false)
  useEffect(() => {
    if (scanning) setSawScan(true)
  }, [scanning])
  // (R-16) While the wizard is actively presenting, IT owns the moment — the
  // notice waits (it appears the moment the wizard is skipped or closed).
  const [wizardPresenting, setWizardPresenting] = useState(false)
  const readWizardPresenting = () => {
    try {
      const raw = localStorage.getItem('minimax.wizard')
      const parsed = raw ? JSON.parse(raw) as { done?: boolean; skipped?: boolean } : {}
      return parsed.done !== true && parsed.skipped !== true
    } catch { return false }
  }
  useEffect(() => {
    setWizardPresenting(readWizardPresenting())
    const onWizardState = () => setWizardPresenting(readWizardPresenting())
    window.addEventListener(WIZARD_STATE_EVENT, onWizardState)
    return () => window.removeEventListener(WIZARD_STATE_EVENT, onWizardState)
  }, [])

  if (dismissed || !sawScan || scanning || models.length > 0 || wizardPresenting) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* Non-fatal: it may show again next visit. */ }
    setDismissed(true)
  }

  const reopenWizard = () => {
    window.dispatchEvent(new CustomEvent(WIZARD_REOPEN_EVENT))
  }

  const openLibrary = () => {
    setLibraryDock(true)
  }

  return <div className="canvas-first-run" role="note" aria-label="Model setup guidance" data-canvas-first-run>
    <HardDrive size={16} />
    <div className="canvas-first-run-body">
      <strong>No models visible — one setup step before the first render.</strong>
      <span>
        The connected engine's own registry is the model source of truth — the studio uses exactly what it can see.
      </span>
      <div className="canvas-first-run-actions">
        <button type="button" onClick={reopenWizard}>Resume setup</button>
        <button type="button" onClick={openLibrary}>Get models</button>
        <button type="button" className="canvas-first-run-secondary" onClick={() => setSettingsDock(true)}>Engine settings</button>
      </div>
    </div>
    <button type="button" className="canvas-first-run-dismiss" aria-label="Dismiss setup guidance" onClick={dismiss}><X size={14} /></button>
  </div>
}
