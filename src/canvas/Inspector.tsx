/**
 * Canvas Phase 1 — the floating inspector shell (§3: react-rnd; L24 decided:
 * floats freely, follows selection optionally).
 *
 * Phase 1 ships the SHELL: drag + resize + selection-following content (the
 * selected tile's document facts). The real properties panel — bindings,
 * op-stack editing, per-op undo — is Phase 2's absorption surface.
 */
import { Rnd } from 'react-rnd'
import { X } from 'lucide-react'
import { STATUS_LABEL } from './derive'
import { useCanvasStore } from './store'

export function Inspector() {
  const open = useCanvasStore((state) => state.inspectorOpen)
  const setInspectorOpen = useCanvasStore((state) => state.setInspectorOpen)
  const selection = useCanvasStore((state) => state.selection)
  const tiles = useCanvasStore((state) => state.tiles)
  const tile = selection ? tiles.find((entry) => entry.id === selection.tileId) ?? null : null

  if (!open || !tile) return null

  return <Rnd
    className="canvas-inspector"
    data-canvas-inspector
    default={{ x: window.innerWidth - 396, y: 96, width: 340, height: 420 }}
    minWidth={280}
    minHeight={220}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <strong>{tile.title}</strong>
      <button type="button" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}><X size={13} /></button>
    </header>
    <div className="canvas-inspector-body">
      <dl>
        <dt>state</dt>
        <dd><span className="canvas-tile-ring" data-status={tile.status} /> {STATUS_LABEL[tile.status]}</dd>
        <dt>kind</dt>
        <dd>{tile.kind} · {tile.lockState}</dd>
        {tile.prompt && <><dt>prompt</dt><dd className="canvas-inspector-prompt">{tile.prompt}</dd></>}
        {tile.jobId && <><dt>job</dt><dd className="canvas-inspector-mono">{tile.jobId}</dd></>}
        <dt>ops</dt>
        <dd>{tile.ops.length ? tile.ops.map((op) => op.kind).join(' · ') : 'none'}</dd>
        <dt>takes</dt>
        <dd>{tile.canonical ? `canonical ${tile.canonical.id.slice(0, 8)}${tile.priors ? ` + ${tile.priors} prior${tile.priors > 1 ? 's' : ''}` : ''}` : 'none yet'}</dd>
        <dt>position</dt>
        <dd className="canvas-inspector-mono">{Math.round(tile.x)}, {Math.round(tile.y)} @ {Math.round(tile.w)}w</dd>
      </dl>
      <p className="canvas-inspector-note">
        Properties, bindings, and per-op undo land in Phase 2 — this shell
        proves the float + selection-follow seam.
      </p>
    </div>
  </Rnd>
}
