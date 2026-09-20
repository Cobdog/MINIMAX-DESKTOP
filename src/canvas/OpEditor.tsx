/**
 * Canvas Phase 3 — the op modal editor (§5.1, L8 DECIDED: modal-only v1 —
 * this is the ONLY op editor; the tile's chips open it, they never edit
 * inline).
 *
 * A Base UI dialog (StudioDialog — focus trap, Escape, aria-modal) over the
 * canvas. Left: the live preview stage — the tile's canonical media with the
 * WHOLE stack composed onto it (L3 DECIDED: live-update; the same
 * opPreviewStyle the tile poster applies). Right: the stack itself — add
 * rows (type-directed per media kind), per-op undo (⌘Z undoes the last
 * unbaked op), drag/button reorder (baked ops frozen), and bake as an
 * explicit two-step irreversible marker. The brush mask paints on the stage
 * (token-styled brush, strokes stored normalized so the stack replays).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Brush, Eraser, Lock, Plus, Undo2 } from 'lucide-react'
import { StudioDialog } from '../ui/StudioDialog'
import { documentsApi } from './api'
import { moveOpPermutation, opKindsFor, OP_META, opPreviewStyle, opSummary, readOpSettings, type MaskStroke } from './ops'
import { useCanvasStore } from './store'
import type { DocumentChain, DocumentOp } from './derive'

const CANVAS_OP_TITLE = 'canvas-op-title'

/** The servable preview source for the chain's canonical take: the durable
 *  content-addressed blob first, the session preview second, none third (the
 *  editor still works — the stage shows the honest empty state). */
function previewSourceOf(chain: DocumentChain | null, droppedPreview: string | undefined): { url: string | null; kind: 'image' | 'video' | null } {
  const take = chain?.outputs.flatMap((output) => output.takes).find((entry) => entry.supersededBy === null) ?? null
  const blob = take?.artifacts.find((artifact) => artifact.startsWith('canvas-blobs/'))
  if (blob) {
    const kind = take?.metrics?.kind
    return { url: documentsApi.blobFileUrl(blob), kind: kind === 'video' ? 'video' : 'image' }
  }
  if (droppedPreview) return { url: droppedPreview, kind: chain && chain.settings?.mediaType === 'video' ? 'video' : 'image' }
  return { url: null, kind: null }
}

export function OpEditor() {
  const opEditor = useCanvasStore((state) => state.opEditor)
  const setOpEditor = useCanvasStore((state) => state.setOpEditor)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const tiles = useCanvasStore((state) => state.tiles)
  const droppedPreviews = useCanvasStore((state) => state.droppedPreviews)
  const addStackOp = useCanvasStore((state) => state.addStackOp)
  const updateStackOp = useCanvasStore((state) => state.updateStackOp)
  const removeStackOp = useCanvasStore((state) => state.removeStackOp)
  const reorderStackOps = useCanvasStore((state) => state.reorderStackOps)
  const bakeStackOp = useCanvasStore((state) => state.bakeStackOp)
  const toast = useCanvasStore((state) => state.toast)

  const [selectedOpId, setSelectedOpId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [confirmingBake, setConfirmingBake] = useState<string | null>(null)
  const [brush, setBrush] = useState<{ size: number; erase: boolean }>({ size: 0.05, erase: false })
  const [scrub, setScrub] = useState(0)

  const stageRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const strokeRef = useRef<{ points: number[] } | null>(null)

  const chainId = opEditor?.chainId ?? null
  const doc = activeProjectId ? documents[activeProjectId] : null
  const chain = chainId && doc ? doc.chains.find((entry) => entry.id === chainId) ?? null : null
  const tile = chainId ? tiles.find((entry) => entry.id === chainId) ?? null : null
  const ops: DocumentOp[] = useMemo(() => chain?.ops ?? [], [chain])
  const mediaKind = tile?.mediaKind ?? null
  const offeredKinds = opKindsFor(mediaKind)
  const style = useMemo(() => opPreviewStyle(ops), [ops])
  const selectedOp = ops.find((op) => op.id === selectedOpId) ?? null
  const source = previewSourceOf(chain, chainId ? droppedPreviews[chainId] : undefined)

  // Adopt the newest op when one lands (adding selects it for editing).
  useEffect(() => {
    if (selectedOpId && ops.some((op) => op.id === selectedOpId)) return
    setSelectedOpId(ops.length ? ops[ops.length - 1]!.id : null)
  }, [ops, selectedOpId])
  useEffect(() => {
    if (!opEditor) {
      setSelectedOpId(null)
      setAddOpen(false)
      setConfirmingBake(null)
    }
  }, [opEditor])

  // §7: ⌘Z per-op undo — the LAST unbaked op goes; native text-field undo is
  // preserved (the typing guard).
  useEffect(() => {
    if (!opEditor) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const lastUnbaked = [...ops].reverse().find((op) => op.bakedAt === null)
      if (!lastUnbaked || !chainId) return
      event.preventDefault()
      void removeStackOp(chainId, lastUnbaked.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chainId, opEditor, ops, removeStackOp])

  // ---- mask overlay painting ---------------------------------------------------

  const paintStrokes = useCallback((strokes: MaskStroke[]) => {
    const canvasEl = overlayRef.current
    const stage = stageRef.current
    if (!canvasEl || !stage) return
    const rect = stage.getBoundingClientRect()
    canvasEl.width = Math.max(1, Math.round(rect.width))
    canvasEl.height = Math.max(1, Math.round(rect.height))
    const ctx = canvasEl.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height)
    for (const stroke of strokes) {
      // Erase strokes replay as destination-out — they REMOVE earlier paint,
      // exactly what the stack order means for a mask.
      ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
      ctx.strokeStyle = 'rgba(232,176,75,0.75)'
      ctx.fillStyle = ctx.strokeStyle
      ctx.lineWidth = Math.max(2, stroke.size * canvasEl.width)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const points = stroke.points.map((value, index) => index % 2 === 0 ? value * canvasEl.width : value * canvasEl.height)
      if (points.length === 2) {
        // A dot (pointer down + up in place) still paints.
        ctx.beginPath()
        ctx.arc(points[0]!, points[1]!, ctx.lineWidth / 2, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      ctx.beginPath()
      for (let index = 0; index + 1 < points.length; index += 2) {
        if (index === 0) ctx.moveTo(points[index]!, points[index + 1]!)
        else ctx.lineTo(points[index]!, points[index + 1]!)
      }
      ctx.stroke()
    }
  }, [])

  // Repaint whenever the selected mask op (or the stack under it) changes.
  useEffect(() => {
    if (!selectedOp || selectedOp.kind !== 'mask') return
    const settings = readOpSettings('mask', selectedOp.settings) as { strokes: MaskStroke[] }
    paintStrokes(settings.strokes)
  }, [paintStrokes, selectedOp, ops])

  const painting = Boolean(selectedOp && selectedOp.kind === 'mask' && selectedOp.bakedAt === null && chainId)

  const stagePoint = (event: React.PointerEvent): { x: number; y: number } | null => {
    const stage = stageRef.current
    if (!stage) return null
    const rect = stage.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }

  const onStagePointerDown = (event: React.PointerEvent) => {
    if (!painting || !selectedOp) return
    const point = stagePoint(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    strokeRef.current = { points: [point.x, point.y] }
  }

  const onStagePointerMove = (event: React.PointerEvent) => {
    if (!painting || !strokeRef.current || !selectedOp) return
    const point = stagePoint(event)
    if (!point) return
    strokeRef.current.points.push(point.x, point.y)
    const settings = readOpSettings('mask', selectedOp.settings) as { strokes: MaskStroke[] }
    paintStrokes([...settings.strokes, { points: [...strokeRef.current.points], size: brush.size, erase: brush.erase }])
  }

  const onStagePointerUp = () => {
    if (!painting || !strokeRef.current || !selectedOp || !chainId) return
    const settings = readOpSettings('mask', selectedOp.settings) as { strokes: MaskStroke[] }
    const stroke: MaskStroke = { points: strokeRef.current.points, size: brush.size, erase: brush.erase }
    strokeRef.current = null
    if (stroke.points.length < 2) return
    void updateStackOp(chainId, selectedOp.id, { strokes: [...settings.strokes, stroke] })
  }

  // ---- op edits (debounced for sliders; immediate for discrete picks) -----------

  const patchSelected = (settings: Record<string, unknown>, immediate = false) => {
    if (!selectedOp || !chainId) return
    const merged = { ...(selectedOp.settings ?? {}), ...settings }
    if (immediate) {
      void updateStackOp(chainId, selectedOp.id, merged)
      return
    }
    window.clearTimeout(patchTimer.current)
    patchTimer.current = window.setTimeout(() => void updateStackOp(chainId, selectedOp.id, merged), 260)
  }
  const patchTimer = useRef(0)

  const addOp = async (kind: (typeof offeredKinds)[number]) => {
    if (!chainId) return
    setAddOpen(false)
    const id = await addStackOp(chainId, kind)
    if (id) setSelectedOpId(id)
  }

  const move = async (op: DocumentOp, delta: -1 | 1) => {
    if (!chainId) return
    const permutation = moveOpPermutation(ops, op.id, delta)
    if (permutation) await reorderStackOps(chainId, permutation)
  }

  const bake = async (op: DocumentOp) => {
    if (!chainId) return
    if (confirmingBake !== op.id) {
      setConfirmingBake(op.id)
      return
    }
    setConfirmingBake(null)
    await bakeStackOp(chainId, op.id)
  }

  const open = Boolean(opEditor && chain && tile)

  return <StudioDialog
    open={open}
    onClose={() => setOpEditor(null)}
    backdropClassName="canvas-opmodal-backdrop"
    popupClassName="canvas-opmodal"
    labelledBy={CANVAS_OP_TITLE}
  >
    <header className="canvas-opmodal-header">
      <div>
        <strong id={CANVAS_OP_TITLE}>Op stack — {tile?.title ?? 'object'}</strong>
        <span>every edit is an op · sources are never silently altered · bake is irreversible</span>
      </div>
      <button type="button" aria-label="Close the op editor" data-canvas-op-close onClick={() => setOpEditor(null)}>×</button>
    </header>

    <div className="canvas-opmodal-body">
      <div className="canvas-opmodal-stagewrap">
        <div className={`canvas-opmodal-stage ${painting ? 'painting' : ''}`} ref={stageRef} data-canvas-op-stage
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerCancel={onStagePointerUp}
        >
          {source.url && source.kind === 'image' && <img className="canvas-opmodal-media" src={source.url} alt={tile?.title ?? 'preview'} style={{ filter: style.filter, transform: style.transform, objectPosition: style.objectPosition, objectFit: style.objectFit }} />}
          {source.url && source.kind === 'video' && <video
            className="canvas-opmodal-media"
            src={source.url}
            muted
            playsInline
            preload="metadata"
            data-canvas-op-video
            style={{ filter: style.filter, transform: style.transform, objectPosition: style.objectPosition, objectFit: style.objectFit }}
            onTimeUpdate={(event) => {
              const current = event.currentTarget.currentTime
              setScrub(current)
              if (current < style.trimStart || current > style.trimEnd) event.currentTarget.currentTime = style.trimStart
            }}
          />}
          {!source.url && <div className="canvas-opmodal-empty">No preview media on the canonical take yet — ops still record on the stack.</div>}
          <canvas className="canvas-opmodal-mask" ref={overlayRef} aria-hidden={painting ? undefined : true} data-canvas-op-mask={selectedOp?.kind === 'mask' ? '1' : undefined} />
          {painting && <span className="canvas-opmodal-brushhint"><Brush size={11} /> drag to paint the mask · brush {Math.round(brush.size * 100)}% {brush.erase ? '· erase' : ''}</span>}
        </div>
        {source.kind === 'video' && (
          <div className="canvas-opmodal-scrub">
            <input
              type="range"
              min={0}
              max={60}
              step={0.05}
              value={scrub}
              aria-label="Preview playhead"
              data-canvas-op-scrub
              onChange={(event) => {
                const next = Number(event.target.value)
                setScrub(next)
                const video = stageRef.current?.querySelector('video')
                if (video) video.currentTime = next
              }}
            />
            <span>{scrub.toFixed(1)}s{Number.isFinite(style.trimEnd) ? ` · trim ${style.trimStart.toFixed(1)}–${style.trimEnd.toFixed(1)}s` : ''}</span>
          </div>
        )}
      </div>

      <aside className="canvas-opmodal-stack" data-canvas-op-stack>
        <div className="canvas-opmodal-addrow">
          <button type="button" className="canvas-chip" data-canvas-op-add onClick={() => setAddOpen((value) => !value)} disabled={!offeredKinds.length}>
            <Plus size={12} /> add op
          </button>
          <span className="canvas-opmodal-count">{ops.length} op{ops.length === 1 ? '' : 's'}</span>
          {addOpen && (
            <div className="canvas-opmodal-addmenu" role="menu" data-canvas-op-addmenu>
              {offeredKinds.map((kind) => {
                const meta = OP_META.find((entry) => entry.kind === kind)!
                return <button type="button" key={kind} role="menuitem" data-canvas-op-add={kind} title={meta.note} onClick={() => void addOp(kind)}>{meta.label}</button>
              })}
              {!offeredKinds.length && <span className="canvas-opmodal-addnote">The canonical take carries no media kind yet.</span>}
            </div>
          )}
        </div>

        <ol className="canvas-opmodal-ops">
          {ops.map((op, index) => {
            const baked = op.bakedAt !== null
            const meta = OP_META.find((entry) => entry.kind === op.kind)
            return <li
              key={op.id}
              className={`canvas-op-row ${selectedOpId === op.id ? 'selected' : ''} ${baked ? 'baked' : ''}`}
              data-canvas-op-row={op.id}
              data-op-kind={op.kind}
              onClick={() => setSelectedOpId(op.id)}
              draggable={!baked}
              onDragStart={(event) => event.dataTransfer.setData('text/op-id', op.id)}
              onDragOver={(event) => { if (!baked) event.preventDefault() }}
              onDrop={(event) => {
                const movedId = event.dataTransfer.getData('text/op-id')
                if (!movedId || movedId === op.id || baked || !chainId) return
                const ids = ops.map((entry) => entry.id)
                const from = ids.indexOf(movedId)
                const to = ids.indexOf(op.id)
                if (from < 0 || to < 0) return
                ids.splice(to, 0, ids.splice(from, 1)[0]!)
                void reorderStackOps(chainId, ids)
              }}
            >
              <span className="canvas-op-ordinal">{index + 1}</span>
              <span className="canvas-op-label">{meta?.label ?? op.kind}</span>
              <span className="canvas-op-summary">{opSummary(op.kind, op.settings)}</span>
              {baked && <span className="canvas-op-baked" title={`baked ${new Date(op.bakedAt!).toLocaleString()} — frozen, irreversible`}><Lock size={10} /> baked</span>}
              <span className="canvas-op-actions">
                {!baked && <>
                  <button type="button" aria-label={`Undo ${meta?.label ?? op.kind} op`} data-canvas-op-undo={op.id} title="Undo this op (⌘Z undoes the last)" onClick={(event) => { event.stopPropagation(); if (chainId) void removeStackOp(chainId, op.id) }}><Undo2 size={11} /></button>
                  <button type="button" aria-label="Move op earlier" data-canvas-op-up={op.id} disabled={index === 0} onClick={(event) => { event.stopPropagation(); void move(op, -1) }}><ArrowUp size={11} /></button>
                  <button type="button" aria-label="Move op later" data-canvas-op-down={op.id} disabled={index === ops.length - 1} onClick={(event) => { event.stopPropagation(); void move(op, 1) }}><ArrowDown size={11} /></button>
                  <button type="button" className={`canvas-op-bake ${confirmingBake === op.id ? 'confirm' : ''}`} data-canvas-op-bake={op.id} onClick={(event) => { event.stopPropagation(); void bake(op) }}>
                    {confirmingBake === op.id ? 'bake — irreversible?' : 'bake'}
                  </button>
                </>}
              </span>
            </li>
          })}
          {!ops.length && <li className="canvas-op-empty">An empty stack — the first op is usually a crop (ImageCrop data) or a trim.</li>}
        </ol>

        {selectedOp && !selectedOp.bakedAt && (
          <div className="canvas-op-edit" data-canvas-op-edit={selectedOp.kind}>
            {selectedOp.kind === 'crop' && (() => {
              const crop = readOpSettings('crop', selectedOp.settings) as { x: number; y: number; zoom: number; fit: 'crop' | 'contain' }
              return <>
                <label>fit
                  <select data-canvas-op-field="fit" value={crop.fit} onChange={(event) => patchSelected({ fit: event.target.value as 'crop' | 'contain' }, true)}>
                    <option value="crop">fill frame · crop edges</option>
                    <option value="contain">fit whole · bars</option>
                  </select>
                </label>
                <label>focal x<input data-canvas-op-field="x" type="range" min={0} max={1} step={0.01} value={crop.x} disabled={crop.fit === 'contain'} onChange={(event) => patchSelected({ x: Number(event.target.value) })} /></label>
                <label>focal y<input data-canvas-op-field="y" type="range" min={0} max={1} step={0.01} value={crop.y} disabled={crop.fit === 'contain'} onChange={(event) => patchSelected({ y: Number(event.target.value) })} /></label>
                <label>zoom<input data-canvas-op-field="zoom" type="range" min={1} max={4} step={0.05} value={crop.zoom} disabled={crop.fit === 'contain'} onChange={(event) => patchSelected({ zoom: Number(event.target.value) })} /></label>
                <p className="canvas-op-note">ImageCrop data — the render crops at upload; the source never changes.</p>
              </>
            })()}
            {selectedOp.kind === 'rotate' && (() => {
              const rotate = readOpSettings('rotate', selectedOp.settings) as { degrees: number }
              return <>
                <label>degrees<input data-canvas-op-field="degrees" type="range" min={-180} max={180} step={1} value={rotate.degrees} onChange={(event) => patchSelected({ degrees: Number(event.target.value) })} /></label>
                <span className="canvas-op-quick">
                  {[[-90, '⟲ 90°'], [90, '⟳ 90°']].map(([delta, label]) => (
                    <button type="button" key={label} data-canvas-op-quick={String(delta)} onClick={() => patchSelected({ degrees: ((rotate.degrees + Number(delta)) % 360 + 360) % 360 - 180 }, true)}>{label}</button>
                  ))}
                  <button type="button" data-canvas-op-quick="0" onClick={() => patchSelected({ degrees: 0 }, true)}>reset</button>
                </span>
              </>
            })()}
            {selectedOp.kind === 'mask' && (() => {
              const mask = readOpSettings('mask', selectedOp.settings) as { strokes: MaskStroke[] }
              return <>
                <div className="canvas-op-brushrow">
                  <span className={`canvas-chip ${!brush.erase ? 'active' : ''}`} data-canvas-op-brushmode="paint" onClick={() => setBrush({ ...brush, erase: false })}><Brush size={11} /> paint</span>
                  <span className={`canvas-chip ${brush.erase ? 'active' : ''}`} data-canvas-op-brushmode="erase" onClick={() => setBrush({ ...brush, erase: true })}><Eraser size={11} /> erase</span>
                  <label>size<input data-canvas-op-field="size" type="range" min={0.01} max={0.3} step={0.005} value={brush.size} onChange={(event) => setBrush({ ...brush, size: Number(event.target.value) })} /></label>
                </div>
                <p className="canvas-op-note">{mask.strokes.length} stroke{mask.strokes.length === 1 ? '' : 's'} — paint on the stage. Strokes store normalized, so reordering the stack replays them.</p>
                <button type="button" className="canvas-chip" data-canvas-op-clearmask onClick={() => patchSelected({ strokes: [] }, true)}>clear mask</button>
              </>
            })()}
            {selectedOp.kind === 'adjust' && (() => {
              const adjust = readOpSettings('adjust', selectedOp.settings) as { brightness: number; contrast: number; saturation: number }
              // Symmetric offset sliders (−1 … +1, 0 = neutral): the neutral
              // point sits at the visual CENTER of each slider, so "brighter"
              // always reads right-of-center (the vision loop caught the
              // 0–3 range putting 1.4 at 47% — geometrically left of center).
              const offsetSlider = (field: 'brightness' | 'contrast' | 'saturation', value: number) => (
                <label>{field}
                  <input
                    data-canvas-op-field={field}
                    type="range"
                    min={-1}
                    max={1}
                    step={0.05}
                    value={Math.max(-1, Math.min(1, value - 1))}
                    onChange={(event) => patchSelected({ [field]: 1 + Number(event.target.value) })}
                  />
                </label>
              )
              return <>
                {offsetSlider('brightness', adjust.brightness)}
                {offsetSlider('contrast', adjust.contrast)}
                {offsetSlider('saturation', adjust.saturation)}
                <p className="canvas-op-note">ctx.filter adjustments — the CSS filter is the visual proxy; center is neutral (1.00), right brightens.</p>
              </>
            })()}
            {selectedOp.kind === 'trim' && (() => {
              const trim = readOpSettings('trim', selectedOp.settings) as { start: number; end: number }
              return <>
                <label>start s<input data-canvas-op-field="start" type="number" min={0} max={Math.max(0, trim.end - 2)} step={0.1} value={Number(trim.start.toFixed(2))} onChange={(event) => patchSelected({ start: Math.max(0, Math.min(trim.end - 2, Number(event.target.value))) }, true)} /></label>
                <label>end s<input data-canvas-op-field="end" type="number" min={trim.start + 2} max={trim.start + 15} step={0.1} value={Number(trim.end.toFixed(2))} onChange={(event) => patchSelected({ end: Math.max(trim.start + 2, Math.min(trim.start + 15, Number(event.target.value))) }, true)} /></label>
                <p className="canvas-op-note">The VideoReferenceClipper section — 2–15 s; the source is untouched.</p>
              </>
            })()}
            {selectedOp.kind === 'upscale' && (() => {
              const upscale = readOpSettings('upscale', selectedOp.settings) as { mode: string }
              return <>
                <label>engine
                  <select data-canvas-op-field="mode" value={upscale.mode} onChange={(event) => patchSelected({ mode: event.target.value }, true)}>
                    <option value="rtx">AI upscale model (RTX)</option>
                    <option value="lbh2d">LBH-123-AI 2D latent</option>
                    <option value="lbh3d">LBH-123-AI 3D latent</option>
                  </select>
                </label>
                <p className="canvas-op-note">Dual-mode: this stack op rides the chain's render (settings stay in sync); the fork gesture covers the fork side.</p>
              </>
            })()}
            {selectedOp.kind === 'stabilize' && (() => {
              const stabilize = readOpSettings('stabilize', selectedOp.settings) as { strength: number }
              return <label>strength<input data-canvas-op-field="strength" type="range" min={0} max={1} step={0.05} value={stabilize.strength} onChange={(event) => patchSelected({ strength: Number(event.target.value) })} /></label>
            })()}
            {selectedOp.kind === 'color-grade' && (() => {
              const grade = readOpSettings('color-grade', selectedOp.settings) as { temperature: number; tint: number }
              return <>
                <label>temperature<input data-canvas-op-field="temperature" type="range" min={-1} max={1} step={0.05} value={grade.temperature} onChange={(event) => patchSelected({ temperature: Number(event.target.value) })} /></label>
                <label>tint<input data-canvas-op-field="tint" type="range" min={-1} max={1} step={0.05} value={grade.tint} onChange={(event) => patchSelected({ tint: Number(event.target.value) })} /></label>
              </>
            })()}
          </div>
        )}

        <footer className="canvas-opmodal-footer">
          <span><kbd>⌘Z</kbd> undo last op · drag rows or arrows to reorder · <kbd>Esc</kbd> closes</span>
          {tile?.ops.length !== ops.length && <button type="button" className="canvas-chip" onClick={() => toast('neutral', 'The tile preview re-derives with the stack — live by design.')}>preview is live</button>}
        </footer>
      </aside>
    </div>
  </StudioDialog>
}
