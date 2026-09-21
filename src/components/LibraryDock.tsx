/**
 * The Library / Get-models surface (remediation R-15, Wave 3 — M2's fix:
 * FetchBrowser was a complete store-with-consent-flows embedded INSIDE the
 * settings scroll, 41% of the 15k-px page). Promoted to its own floating
 * overlay, reachable from Settings' one-line entry, the first-run notice,
 * the wizard's packs step, and every typed-hole fetch affordance
 * (setLibraryDock(open, focusEntryIds) — the deep-link machinery).
 *
 * The dock is self-contained on the SHARED session store (any surface can
 * mount it): saving settings is not its job (Settings owns the form); a
 * fetch's destination facts ride the consent dialog exactly as before.
 * Fetch completion re-pulls the model inventory AND announces itself on the
 * window event the Settings pack board listens for (the R-10 discipline:
 * fetched packs auto-install, so the pack chips re-resolve without a manual
 * Refresh — wherever the board is mounted).
 */
import { useContext, useEffect, useState } from 'react'
import { Rnd } from 'react-rnd'
import { Library, X } from 'lucide-react'
import { FetchBrowser } from './FetchBrowser'
import { useSessionStore } from '../state/sessionStore'
import { CanvasSessionContext } from '../canvas/sessionContext'
import { dockDefaultGeometry } from '../canvas/dockGeometry'
import { useCanvasStore } from '../canvas/store'

/** The pack-board refresh event (the CHARACTER_LIBRARY_EVENT precedent —
 *  cross-component refresh without store churn): fired after any fetch
 *  completes here, consumed by the Settings pack board wherever it is
 *  mounted (its own Refresh stays for the manual path). */
export const PACKS_CHANGED_EVENT = 'minimax:packs-changed'

export function LibraryDock() {
  const open = useCanvasStore((state) => state.libraryDock)
  const focus = useCanvasStore((state) => state.libraryFocus)
  const setLibraryDock = useCanvasStore((state) => state.setLibraryDock)
  const raiseDock = useCanvasStore((state) => state.raiseDock)
  const context = useContext(CanvasSessionContext)
  const settings = useSessionStore((state) => state.settings)
  const setSettings = useSessionStore((state) => state.setSettings)
  const [dockZ, setDockZ] = useState(60)
  useEffect(() => { if (open) setDockZ(raiseDock()) }, [open, raiseDock])
  // Consume the focus ids once the browser has acted on them.
  const [heldFocus, setHeldFocus] = useState<string[] | null>(null)
  useEffect(() => {
    if (open && focus) {
      setHeldFocus(focus)
      useCanvasStore.setState({ libraryFocus: null })
    }
  }, [open, focus])

  if (!open || !settings || !context) return null
  const { session } = context

  return <Rnd
    className="canvas-settings-dock canvas-library-dock"
    data-canvas-library-dock
    style={{ zIndex: dockZ }}
    onPointerDownCapture={() => setDockZ(raiseDock())}
    default={dockDefaultGeometry({ x: 200, y: 120, width: 760, height: Math.min(780, window.innerHeight - 180) })}
    minWidth={460}
    minHeight={300}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    resizeHandleClasses={{ bottomRight: 'settings-resize-handle-br' }}
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <Library size={13} />
      <strong>Library — get models</strong>
      <button type="button" aria-label="Close library" data-canvas-library-close onClick={() => setLibraryDock(false)}><X size={13} /></button>
    </header>
    <div className="canvas-settings-body" data-canvas-library-body>
      <FetchBrowser
        settings={settings}
        setSettings={(value) => void setSettings(value)}
        onAfterFetch={() => {
          // (R-10 discipline) A fetched pack auto-installs and fetched
          // weights land engine-side: re-pull the inventory, then announce so
          // any mounted pack board re-resolves its chips.
          void session.scanModels(settings, { refresh: true })
          window.dispatchEvent(new CustomEvent(PACKS_CHANGED_EVENT))
        }}
        onAdoptCheckout={(path) => {
          void setSettings({ ...settings, engine: { ...settings.engine, checkoutPath: path } })
          session.checkConnection(settings.comfyUrl)
        }}
        focusEntryIds={heldFocus ?? undefined}
        onFocusConsumed={() => setHeldFocus(null)}
      />
    </div>
  </Rnd>
}
