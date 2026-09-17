/**
 * Canvas Phase 1 — the substrate (§3).
 *
 * One CSS-transform root (`.canvas-world`) under a d3-zoom viewport. The
 * camera store is the ONLY thing on the pan/zoom path: the attachment applies
 * the transform on rAF, the zoom readout is a direct DOM write, and React
 * re-renders ONLY when the semantic-zoom band or the culled tile/edge set
 * membership actually changes — never per frame. The render canary
 * (`data-canvas-renders`) counts substrate renders so the e2e suite can
 * assert the discipline against real pans and zooms.
 *
 * Culling: viewport + margin (screen-px margin converted to world units by
 * 1/k) → tiles/edges outside are unmounted; mounted tiles additionally carry
 * `content-visibility: auto` so the browser skips their layout/paint when
 * off-screen inside the margin band.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Maximize2, Minus, Plus } from 'lucide-react'
import {
  bandFor,
  cameraForRect,
  type CameraState,
  type ZoomBand,
  rectsIntersect,
  visibleWorldRect,
  zoomAbout,
} from './camera'
import { attachCamera, type CameraAttachment } from './cameraDom'
import { edgePath, edgeRect, tileRect, tilesBoundingRect, type Edge, type Tile } from './derive'
import { camera, useCanvasStore } from './store'
import { CanvasTile } from './Tile'

/** Screen-px margin around the viewport that stays mounted (spec: viewport +
 *  margin culling). Generous: band-crossing renders must not thrash while a
 *  fast pan sweeps the surface. */
const CULL_MARGIN_PX = 600
const PERSIST_DEBOUNCE_MS = 600

function SubstrateBase() {
  const tiles = useCanvasStore((state) => state.tiles)
  const edges = useCanvasStore((state) => state.edges)
  const selection = useCanvasStore((state) => state.selection)
  const droppedPreviews = useCanvasStore((state) => state.droppedPreviews)
  const select = useCanvasStore((state) => state.select)
  const dismissFailure = useCanvasStore((state) => state.dismissFailure)
  const cameraCommandSeq = useCanvasStore((state) => state.cameraCommandSeq)

  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const readoutRef = useRef<HTMLSpanElement>(null)
  const canaryRef = useRef<HTMLSpanElement>(null)
  const attachmentRef = useRef<CameraAttachment | null>(null)
  const rendersRef = useRef(0)
  const sizeRef = useRef({ w: 1920, h: 1080 })
  const tilesRef = useRef<Tile[]>(tiles)
  const edgesRef = useRef<Edge[]>(edges)
  const viewRef = useRef({ band: 'mid' as ZoomBand, tileSig: '', edgeSig: '' })
  const persistTimerRef = useRef(0)

  const [band, setBand] = useState<ZoomBand>('mid')
  const [visibleTileSig, setVisibleTileSig] = useState('')
  const [visibleEdgeSig, setVisibleEdgeSig] = useState('')

  tilesRef.current = tiles
  edgesRef.current = edges

  // The render canary — incremented on EVERY substrate render (no deps).
  useEffect(() => {
    rendersRef.current += 1
    if (canaryRef.current) canaryRef.current.dataset.canvasRenders = String(rendersRef.current)
  })

  /** The single camera-derived view recompute: band + culled membership.
   *  Signature-gated so pure pan/zoom inside a band/set is render-free. */
  const recomputeView = (state: CameraState) => {
    const nextBand = bandFor(state.k)
    if (nextBand !== viewRef.current.band) {
      viewRef.current.band = nextBand
      setBand(nextBand)
    }
    const rect = visibleWorldRect(state, sizeRef.current.w, sizeRef.current.h, CULL_MARGIN_PX)
    const tileSig = tilesRef.current.filter((tile) => rectsIntersect(rect, tileRect(tile))).map((tile) => tile.id).join('|')
    if (tileSig !== viewRef.current.tileSig) {
      viewRef.current.tileSig = tileSig
      setVisibleTileSig(tileSig)
    }
    const edgeSig = edgesRef.current.filter((edge) => rectsIntersect(rect, edgeRect(edge))).map((edge) => edge.id).join('|')
    if (edgeSig !== viewRef.current.edgeSig) {
      viewRef.current.edgeSig = edgeSig
      setVisibleEdgeSig(edgeSig)
    }
  }

  // Camera attach: d3-zoom gestures → store; rAF applies the transform
  // (cameraDom). This subscription owns the zoom readout (direct DOM write —
  // transient), the debounced view autosave, and the signature-gated
  // recompute above. StrictMode-safe: full detach on cleanup.
  useEffect(() => {
    const viewport = viewportRef.current
    const world = worldRef.current
    if (!viewport || !world) return undefined
    const applyInitial = () => {
      const rect = viewport.getBoundingClientRect()
      sizeRef.current = { w: rect.width || 1920, h: rect.height || 1080 }
    }
    applyInitial()

    const attachment = attachCamera(viewport, world, camera)
    attachmentRef.current = attachment
    // Initial paint before any gesture.
    world.style.transform = `translate(${camera.get().x}px, ${camera.get().y}px) scale(${camera.get().k})`

    const schedulePersist = () => {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = window.setTimeout(() => {
        if (useCanvasStore.getState().activeProjectId) useCanvasStore.getState().persistView()
      }, PERSIST_DEBOUNCE_MS)
    }

    // Perf wave 1 (profile rec 3): the cull recompute is O(tiles+edges) per
    // call — filter + signature join over the whole document — and a pan
    // drives camera.set up to 6x per frame, so the synchronous path paid up
    // to 6 recomputes per frame for one usable answer. Coalesced to ONE per
    // frame on the rAF applier (never a timer): the flush reads the LATEST
    // camera state and runs before paint, so the mounted set is computed
    // from the same state the transform applies in the same frame — culling
    // never lags a frame. The zoom readout + autosave stay on the direct
    // path (transient DOM write / already debounced).
    let recomputeFrame = 0
    const scheduleRecompute = () => {
      if (recomputeFrame) return
      recomputeFrame = requestAnimationFrame(() => {
        recomputeFrame = 0
        recomputeView(camera.get())
      })
    }

    const unsubscribe = camera.subscribe((state) => {
      if (readoutRef.current) readoutRef.current.textContent = `${Math.round(state.k * 100)}%`
      scheduleRecompute()
      schedulePersist()
    })
    recomputeView(camera.get())

    const observer = new ResizeObserver(() => {
      const rect = viewport.getBoundingClientRect()
      sizeRef.current = { w: rect.width || 1920, h: rect.height || 1080 }
      scheduleRecompute()
    })
    observer.observe(viewport)

    return () => {
      observer.disconnect()
      unsubscribe()
      if (recomputeFrame) cancelAnimationFrame(recomputeFrame)
      window.clearTimeout(persistTimerRef.current)
      attachment.detach()
      attachmentRef.current = null
    }
    // camera + store are singletons; re-attaching per tiles-change would drop gestures mid-pan.
  }, [])

  // Document changed → re-derive the culled set against the CURRENT camera.
  // recomputeView reads tiles/edges through refs by design.
  useEffect(() => {
    recomputeView(camera.get())
  }, [tiles, edges])

  // Rare camera intents (zoom-to-attention, restore, fit) execute through
  // the d3-zoom attachment — animated by d3 transitions, zero React renders.
  useEffect(() => {
    const attachment = attachmentRef.current
    if (!attachment) return
    const state = useCanvasStore.getState()
    for (const command of state.cameraCommands) {
      if (command.kind === 'jump') {
        attachment.jumpTo(command.camera)
      } else if (command.kind === 'fit') {
        const bounds = tilesBoundingRect(state.tiles)
        if (bounds) attachment.flyTo(cameraForRect(bounds, sizeRef.current.w, sizeRef.current.h, { fit: true }), 350)
      } else if (command.kind === 'fly') {
        const tile = state.tiles.find((entry) => entry.id === command.tileId)
        if (tile) {
          const k = Math.max(0.9, Math.min(1.15, camera.get().k))
          attachment.flyTo(cameraForRect(tileRect(tile), sizeRef.current.w, sizeRef.current.h, { k }), 450)
        }
      }
    }
    if (state.cameraCommands.length) state.clearCameraCommands()
    // the seq is the trigger; commands are read at call time.
  }, [cameraCommandSeq])

  const visibleIds = new Set(visibleTileSig ? visibleTileSig.split('|') : [])
  const visibleEdgeIds = new Set(visibleEdgeSig ? visibleEdgeSig.split('|') : [])
  const visibleTiles = tiles.filter((tile) => visibleIds.has(tile.id))

  const zoomBy = (factor: number) => {
    const { w, h } = sizeRef.current
    camera.set(zoomAbout(camera.get(), factor, w / 2, h / 2))
  }

  return <div className="canvas-main">
    <div
      className="canvas-viewport"
      ref={viewportRef}
      data-canvas-viewport
      onClick={(event) => {
        // Empty-space click deselects (d3-zoom already suppressed the click
        // when the pointer moved — its clickDistance contract).
        if (event.target === viewportRef.current || event.target === worldRef.current) select(null)
      }}
    >
      <div className="canvas-world" ref={worldRef} data-canvas-world>
        <svg className="canvas-edges" data-canvas-edges aria-hidden="true">
          <defs>
            <marker id="canvas-edge-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" className="canvas-edge-arrow-head" />
            </marker>
          </defs>
          {edges.filter((edge) => visibleEdgeIds.has(edge.id)).map((edge) => (
            <path key={edge.id} d={edgePath(edge)} className="canvas-edge" data-canvas-edge={edge.id} />
          ))}
        </svg>
        {visibleTiles.map((tile) => (
          <CanvasTile
            key={tile.id}
            tile={tile}
            band={band}
            selected={selection.tileIds.includes(tile.id)}
            previewUrl={droppedPreviews[tile.id]}
            onSelect={select}
            onDismissFailure={dismissFailure}
            onEndpoint={(chainId, direction) => useCanvasStore.getState().setEndpointMenu({ chainId, direction })}
            onFork={(chainId) => useCanvasStore.getState().setForkMenu({ chainId })}
            onOpenOps={(chainId) => useCanvasStore.getState().setOpEditor({ chainId })}
            onSwitchTake={(chainId, takeId) => void useCanvasStore.getState().switchCanonical(chainId, takeId)}
          />
        ))}
      </div>
      {/* transient-channel readout: written directly by the camera
          subscription, never through React state */}
      <span className="canvas-zoom-readout" ref={readoutRef} data-canvas-zoom>{`${Math.round(camera.get().k * 100)}%`}</span>
      <span className="canvas-render-canary" ref={canaryRef} data-canvas-renders="0" aria-hidden />
    </div>
    <div className="canvas-zoom-controls">
      <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><Minus size={13} /></button>
      <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}><Plus size={13} /></button>
      <button type="button" aria-label="Zoom to fit" onClick={() => useCanvasStore.getState().requestCamera({ kind: 'fit' })}><Maximize2 size={13} /></button>
    </div>
  </div>
}

/** Render-isolated on purpose: the substrate re-renders ONLY on its own
 *  store subscriptions (tiles/edges/selection/camera commands) — parent
 *  state changes (toasts, menus) must never spend a substrate render (the
 *  transient discipline the render canary asserts). */
export const Substrate = memo(SubstrateBase)
