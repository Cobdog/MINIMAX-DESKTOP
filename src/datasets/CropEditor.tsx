/**
 * Dataset manager — the stamp crop editor (spec §3, exactly):
 *  - drag places the crop stamp;
 *  - scroll-wheel resizes the crop;
 *  - shift+scroll scrubs the aspect spectrum — ONE ordered list from widest
 *    to tallest, LINEAR with hard stops at both ends (it never loops);
 *  - middle-click mirrors the current ratio when its mirror exists in the
 *    enabled list (16:9↔9:16, 4:3↔3:4; 1:1 mirrors to itself);
 *  - crops are FULL-RESOLUTION aspect-ratio crops, snapped to the 32-px grid;
 *    the video is never resized.
 * Scroll/shift+scroll belong to the crop stamp INSIDE this editor only — the
 * canvas's wheel-zoom semantics are untouched (audit-clean).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlipHorizontal2, Grid2x2, Move, Scissors } from 'lucide-react'
import { datasetsApi, mediaUrlFor, type AspectEntry, type CropRect, type LibraryLayer, type LibrarySource } from './api'

const GRID = 32

type Props = {
  source: LibrarySource
  layer: LibraryLayer | null
  aspects: AspectEntry[]
  onClose(): void
  onSaved(): void
}

type Draft = { crop: CropRect; trim: { inFrame: number | null; outFrame: number | null }; aspectId: string }

function snap(value: number, limit: number): number {
  return Math.max(GRID, Math.min(Math.round(value / GRID) * GRID, Math.floor(limit / GRID) * GRID))
}

/** Largest grid rect with the aspect inside the frame, anchored at center. */
function rectForRatio(ratio: number, width: number, height: number, anchor: { cx: number; cy: number }): CropRect {
  const maxW = Math.floor(width / GRID) * GRID
  const maxH = Math.floor(height / GRID) * GRID
  let w = maxW
  let h = Math.round(w / ratio)
  if (h > maxH) {
    h = maxH
    w = Math.round(h * ratio)
  }
  w = snap(w, maxW)
  h = snap(h, maxH)
  const x = Math.max(0, Math.min(Math.round((anchor.cx - w / 2) / GRID) * GRID, maxW - w))
  const y = Math.max(0, Math.min(Math.round((anchor.cy - h / 2) / GRID) * GRID, maxH - h))
  return { x, y, w, h }
}

function clampToFrame(rect: CropRect, width: number, height: number): CropRect {
  const maxW = Math.floor(width / GRID) * GRID
  const maxH = Math.floor(height / GRID) * GRID
  const w = snap(rect.w, maxW)
  const h = snap(rect.h, maxH)
  return { w, h, x: Math.max(0, Math.min(snap(rect.x, maxW), maxW - w)), y: Math.max(0, Math.min(snap(rect.y, maxH), maxH - h)) }
}

export function CropEditor({ source, layer, aspects, onClose, onSaved }: Props) {
  const enabled = useMemo(() => aspects.filter((aspect) => aspect.enabled), [aspects])
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [aspectIndex, setAspectIndex] = useState(() => {
    const initial = layer?.crop ? enabled.findIndex((aspect) => Math.abs(aspect.ratio - layer.crop!.w / layer.crop!.h) < 0.05) : enabled.findIndex((aspect) => aspect.id === '16:9')
    return initial >= 0 ? initial : 0
  })
  const [draft, setDraft] = useState<Draft>(() => ({
    crop: layer?.crop ?? { x: 0, y: 0, w: Math.floor(source.probe.width / GRID) * GRID, h: Math.floor(source.probe.height / GRID) * GRID },
    trim: layer?.trim ?? { inFrame: 0, outFrame: null },
    aspectId: '',
  }))
  const [name, setName] = useState(layer?.name ?? '')
  const [dragging, setDragging] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mirrorHint, setMirrorHint] = useState<string | null>(null)
  const dragStart = useRef<{ px: number; py: number; rect: CropRect } | null>(null)

  const totalFrames = source.decodedFrames ?? Math.max(1, Math.round((source.probe.durationSec ?? 1) * (source.probe.fps ?? 24)))
  const aspect = enabled[aspectIndex]

  const setCrop = useCallback((next: CropRect) => {
    setDraft((current) => ({ ...current, crop: clampToFrame(next, source.probe.width, source.probe.height) }))
  }, [source.probe.width, source.probe.height])

  // The wheel contract: scroll = resize; shift+scroll = aspect scrub with
  // HARD STOPS (clamped index — the spectrum never loops, spec §3).
  // App-tour wave (d6iy68r, review M4): every tick moves each dimension at
  // least ONE grid step in the tick's direction. The multiplicative 6 %
  // alone deadlocks below ~267 px (6 % < 16 px, and each tick restarted
  // from the previous SNAPPED value — 256, 192, 160… were fixed points;
  // the review measured 15+ ticks with zero change). The draft is always
  // grid-snapped (clampToFrame below), so value ± GRID lands exactly on
  // grid and the snap stays display/save truth. Sub-floor sizes still
  // refuse at save-time with the floor reason — resizable, never stranded.
  const onWheel = useCallback((event: WheelEvent) => {
    event.preventDefault()
    if (event.shiftKey) {
      setAspectIndex((current) => {
        const next = event.deltaY > 0 ? Math.min(current + 1, enabled.length - 1) : Math.max(current - 1, 0)
        if (next === current) {
          setStatus(event.deltaY > 0 ? 'Aspect spectrum hard stop — 9:16-class is the tallest enabled ratio (it never loops).' : 'Aspect spectrum hard stop — the widest enabled ratio is here (it never loops).')
        } else {
          setStatus('')
        }
        return next
      })
    } else {
      setDraft((current) => {
        const factor = event.deltaY > 0 ? 0.94 : 1.06
        const step = (value: number) => {
          const scaled = value * factor
          if (factor < 1 && value - scaled < GRID) return value - GRID
          if (factor > 1 && scaled - value < GRID) return value + GRID
          return scaled
        }
        const cx = current.crop.x + current.crop.w / 2
        const cy = current.crop.y + current.crop.h / 2
        const w = step(current.crop.w)
        const h = step(current.crop.h)
        return { ...current, crop: clampToFrame({ x: cx - w / 2, y: cy - h / 2, w, h }, source.probe.width, source.probe.height) }
      })
      setStatus('')
    }
  }, [enabled.length, source.probe.width, source.probe.height])

  // Aspect change re-fits the rect at the current center, keeping size close.
  useEffect(() => {
    if (!aspect) return
    setDraft((current) => {
      const cx = current.crop.x + current.crop.w / 2
      const cy = current.crop.y + current.crop.h / 2
      const area = current.crop.w * current.crop.h
      const w = Math.sqrt(area * aspect.ratio)
      const h = w / aspect.ratio
      return { ...current, aspectId: aspect.id, crop: rectForRatio(aspect.ratio, source.probe.width, source.probe.height, { cx, cy }) && clampToFrame({ x: cx - w / 2, y: cy - h / 2, w, h }, source.probe.width, source.probe.height) }
    })
  }, [aspect, source.probe.width, source.probe.height])

  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // App-tour wave (d6iy68r, review m3): the editor answers Escape (Close
  // was the only exit). Not while a save is in flight — the save's outcome
  // (or its refusal reason) belongs on screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const bounds = stageRef.current?.getBoundingClientRect()
    if (!bounds) return
    const scale = source.probe.width / bounds.width
    const px = (event.clientX - bounds.left) * scale
    const py = (event.clientY - bounds.top) * scale
    dragStart.current = { px, py, rect: { ...draft.crop } }
    setDragging(true)
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
    // A fresh drag PLACES the stamp at the pointer with the current aspect.
    const rect = rectForRatio(aspect?.ratio ?? 1, source.probe.width, source.probe.height, { cx: px, cy: py })
    const w = Math.min(draft.crop.w, rect.w * 2)
    const h = Math.round(w / (aspect?.ratio ?? 1))
    setCrop({ x: px - w / 2, y: py - h / 2, w, h })
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragging || !dragStart.current) return
    const bounds = stageRef.current?.getBoundingClientRect()
    if (!bounds) return
    const scale = source.probe.width / bounds.width
    const dx = (event.clientX - bounds.left) * scale - dragStart.current.px
    const dy = (event.clientY - bounds.top) * scale - dragStart.current.py
    const base = dragStart.current.rect
    setCrop({ ...base, x: base.x + dx, y: base.y + dy })
  }

  const endDrag = () => {
    setDragging(false)
    dragStart.current = null
  }

  // Middle-click mirror (spec §3): jump to the mirrored ratio when it exists
  // in the enabled list; the hint names why when it does not.
  const onAuxClick = (event: React.MouseEvent) => {
    if (event.button !== 1 || !aspect) return
    event.preventDefault()
    const mirrored = 1 / aspect.ratio
    const target = enabled.find((entry) => Math.abs(entry.ratio - mirrored) < 0.004 && Math.abs(entry.ratio - aspect.ratio) > 0.004)
    if (target) {
      setAspectIndex(enabled.indexOf(target))
      setStatus(`Mirrored to ${target.label}.`)
      setMirrorHint(null)
    } else {
      setMirrorHint(`No mirror for ${aspect.label} in the enabled list${aspect.ratio === 1 ? ' (1:1 mirrors to itself)' : ' — enable or add it first'}.`)
    }
  }

  const save = async () => {
    setBusy(true)
    setSaveError(null)
    try {
      const payload = {
        sourceId: source.id,
        name: name.trim() || `crop ${draft.crop.w}×${draft.crop.h}`,
        crop: draft.crop,
        trim: source.kind === 'video' ? { inFrame: draft.trim.inFrame ?? 0, outFrame: draft.trim.outFrame ?? totalFrames } : null,
      }
      if (layer) await datasetsApi.updateLayer(layer.id, payload)
      else await datasetsApi.createLayer(payload)
      onSaved()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const displayScale = 1 // crop coordinates are source px; CSS scales visually
  const trimIn = draft.trim.inFrame ?? 0
  const trimOut = draft.trim.outFrame ?? totalFrames

  return <div className="ds-editor-overlay" data-ds-editor>
    <div className="ds-editor">
      <header className="ds-editor-head">
        <div>
          <h2>{layer ? 'Edit layer' : 'New layer'} — {source.name}</h2>
          <p className="ds-sub">{source.probe.width}×{source.probe.height} · {source.kind === 'image' ? 'still' : `${(source.probe.fps ?? 0).toFixed(3)} fps · ${totalFrames} decoded frames`}</p>
        </div>
        <button type="button" className="ds-btn ghost" onClick={onClose}>Close</button>
      </header>
      <div className="ds-editor-body">
        <div
          ref={stageRef}
          className="ds-editor-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onAuxClick={onAuxClick}
          data-ds-stage
        >
          {source.kind === 'video'
            ? <video ref={videoRef} src={mediaUrlFor(source.id)} muted loop playsInline controls={false} className="ds-editor-media" />
            : <img src={mediaUrlFor(source.id)} alt="" className="ds-editor-media" />}
          <div
            className={`ds-crop-rect ${dragging ? 'dragging' : ''}`}
            style={{
              left: `${(draft.crop.x / source.probe.width) * 100}%`,
              top: `${(draft.crop.y / source.probe.height) * 100}%`,
              width: `${(draft.crop.w / source.probe.width) * 100}%`,
              height: `${(draft.crop.h / source.probe.height) * 100}%`,
              transform: `scale(${displayScale})`,
            }}
            data-ds-crop-rect
          >
            <span className="ds-crop-size">{draft.crop.w}×{draft.crop.h}</span>
          </div>
          <div className="ds-crop-outside" aria-hidden="true" />
        </div>
        <aside className="ds-editor-side">
          <div className="ds-field">
            <label>Layer name</label>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="crop 480×832" maxLength={80} />
          </div>
          <div className="ds-aspect-strip" data-ds-aspect-strip>
            {enabled.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                className={`ds-aspect-chip ${index === aspectIndex ? 'active' : ''} ${!entry.official ? 'custom' : ''}`}
                onClick={() => setAspectIndex(index)}
                disabled={index === aspectIndex}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <p className="ds-hint"><Move size={12} /> drag places the stamp · <Grid2x2 size={12} /> scroll resizes · shift+scroll scrubs the spectrum (hard stops, never loops) · <FlipHorizontal2 size={12} /> middle-click mirrors</p>
          {status && <p className="ds-status">{status}</p>}
          {mirrorHint && <p className="ds-status warn">{mirrorHint}</p>}
          <div className="ds-crop-readout">
            <span>x {draft.crop.x} · y {draft.crop.y}</span>
            <span>w {draft.crop.w} · h {draft.crop.h} <em>(32-grid)</em></span>
            <span>ratio {(draft.crop.w / draft.crop.h).toFixed(3)}</span>
          </div>
          {source.kind === 'video' && <div className="ds-trim" data-ds-trim>
            <div className="ds-trim-head">
              <Scissors size={12} /> trim window (frame-accurate)
            </div>
            <div className="ds-trim-inputs">
              <label>in <input type="number" min={0} max={totalFrames - 1} value={trimIn} onChange={(event) => setDraft((current) => ({ ...current, trim: { ...current.trim, inFrame: Math.max(0, Math.min(Number(event.target.value) || 0, (current.trim.outFrame ?? totalFrames) - 1) ) } }))} /></label>
              <label>out <input type="number" min={1} max={totalFrames} value={trimOut} onChange={(event) => setDraft((current) => ({ ...current, trim: { ...current.trim, outFrame: Math.max((current.trim.inFrame ?? 0) + 1, Math.min(Number(event.target.value) || totalFrames, totalFrames)) } }))} /></label>
            </div>
            <input
              type="range"
              className="ds-trim-range"
              min={0}
              max={totalFrames}
              value={trimOut}
              onChange={(event) => setDraft((current) => ({ ...current, trim: { inFrame: current.trim.inFrame, outFrame: Math.max(trimIn + 1, Number(event.target.value)) } }))}
            />
            <p className="ds-hint">{trimOut - trimIn} frames selected — the grid target is chosen at export, never baked into the trim.</p>
          </div>}
          {saveError && <p className="ds-error">{saveError}</p>}
          <button type="button" className="ds-btn primary" onClick={save} disabled={busy} data-ds-save-layer>
            {busy ? 'Saving…' : layer ? 'Save layer' : 'Create layer'}
          </button>
        </aside>
      </div>
    </div>
  </div>
}
