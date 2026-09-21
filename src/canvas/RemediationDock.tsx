/**
 * The remediation dock (remediation R-17, Wave 3 — tg52kaq): the render
 * attempt's per-item-consented remediation surface. When a submit-time
 * preflight (R-02) refuses, this panel opens with ONE ACTION PER ROW —
 * fetch (license stated, the consent dialog is the fetcher's own explicit
 * step), install (vendored/first-party, no network), or the honest
 * stock/unknown advice. The Settings pack board stays the audit/override
 * view; this is the point-of-need surface.
 *
 * Mounted wherever renders submit (canvas + workbench — the surfaces that
 * also mount Settings/Library). Listens for PREFLIGHT_REFUSAL_EVENT (the
 * pure submit cores fire it; they never touch a store by design).
 */
import { useEffect, useState } from 'react'
import { Rnd } from 'react-rnd'
import { Check, Download, LoaderCircle, PackageOpen, RefreshCw, Wrench, X } from 'lucide-react'
import { PREFLIGHT_REFUSAL_EVENT, type MissingNodeClass } from '../lib/preflight'
import { remediationRows, type RemediationRow } from '../lib/preflightRemediation'
import { dockDefaultGeometry } from './dockGeometry'
import { useCanvasStore } from './store'

export function RemediationDock() {
  const raiseDock = useCanvasStore((state) => state.raiseDock)
  const setLibraryDock = useCanvasStore((state) => state.setLibraryDock)
  const setSettingsDock = useCanvasStore((state) => state.setSettingsDock)
  const toast = useCanvasStore((state) => state.toast)
  const [rows, setRows] = useState<RemediationRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [dockZ, setDockZ] = useState(60)

  useEffect(() => {
    const onRefusal = (event: Event) => {
      const detail = (event as CustomEvent<{ missing: MissingNodeClass[] }>).detail
      if (!detail || !Array.isArray(detail.missing) || !detail.missing.length) return
      setRows(remediationRows(detail.missing))
      setInstalled(new Set())
      setDockZ(raiseDock())
    }
    window.addEventListener(PREFLIGHT_REFUSAL_EVENT, onRefusal)
    return () => window.removeEventListener(PREFLIGHT_REFUSAL_EVENT, onRefusal)
  }, [raiseDock])

  if (!rows || rows.length === 0) return null

  const close = () => { setRows(null); setBusy(null); setInstalled(new Set()) }

  const install = async (row: RemediationRow) => {
    if (row.action.kind !== 'install' || busy) return
    setBusy(row.className)
    try {
      await window.minimax.installEngineNodePack(row.action.packId)
      setInstalled((current) => new Set(current).add(row.className))
      toast('success', `${row.action.packName} installed — restart the engine to activate it, then generate again.`)
    } catch (error) {
      toast('error', `The install failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  return <Rnd
    className="canvas-settings-dock canvas-remediation-dock"
    data-canvas-remediation-dock
    style={{ zIndex: dockZ }}
    onPointerDownCapture={() => setDockZ(raiseDock())}
    default={dockDefaultGeometry({ x: 240, y: 150, width: 560, height: Math.min(560, window.innerHeight - 260) })}
    minWidth={420}
    minHeight={240}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    resizeHandleClasses={{ bottomRight: 'settings-resize-handle-br' }}
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <Wrench size={13} />
      <strong>This render needs</strong>
      <button type="button" aria-label="Close remediation" data-remediation-close onClick={close}><X size={13} /></button>
    </header>
    <div className="canvas-settings-body" data-remediation-body>
      <p className="canvas-remediation-lede" data-remediation-lede>
        The engine is missing {rows.length === 1 ? 'one node class' : `${rows.length} node classes`} this render needs — nothing was submitted. One action per row; then generate again (the check re-runs on every attempt).
      </p>
      <ul className="canvas-remediation-rows">
        {rows.map((row) => (
          <li className="canvas-remediation-row" key={row.className} data-remediation-row={row.className} data-remediation-kind={row.action.kind}>
            <div className="canvas-remediation-main">
              <strong>{row.className}</strong>
              <small>{row.label}</small>
            </div>
            <div className="canvas-remediation-action">
              {row.action.kind === 'fetch' && (
                <button type="button" className="canvas-chip" data-remediation-fetch={row.action.packId}
                  title={`Opens the library focused on ${row.action.packName} — the license verdict is on the row and the fetch asks again before anything downloads`}
                  onClick={() => setLibraryDock(true, [row.action.kind === 'fetch' ? row.action.catalogEntryId : ''])}>
                  <Download size={12} /> Fetch… <small>{row.action.licenseSpdx}</small>
                </button>
              )}
              {row.action.kind === 'install' && (
                installed.has(row.className)
                  ? <span className="canvas-remediation-done" data-remediation-installed><Check size={12} /> installed — restart to activate</span>
                  : <button type="button" className="canvas-chip" data-remediation-install={row.action.packId}
                    title={row.action.note}
                    disabled={busy === row.className}
                    onClick={() => void install(row)}>
                    {busy === row.className ? <LoaderCircle size={12} className="spin" /> : <PackageOpen size={12} />} Install <small>no network</small>
                  </button>
              )}
              {row.action.kind === 'stock' && (
                <button type="button" className="canvas-chip" data-remediation-stock
                  title="The graph-compatibility view in Settings explains the version contract"
                  onClick={() => setSettingsDock(true)}>
                  <RefreshCw size={12} /> Graph compatibility
                </button>
              )}
              {row.action.kind === 'unknown' && <span className="canvas-remediation-note">no one-action fix — {row.label}</span>}
            </div>
          </li>
        ))}
      </ul>
      <p className="canvas-remediation-note">The full pack board (audit + override) lives in Settings → Setup → Node packs.</p>
    </div>
  </Rnd>
}
