/**
 * Canvas Phase 5 — THE app root (§8: the old shell is deleted; the canvas is
 * the default route, ?canvas=1 a harmless alias).
 *
 * Own titlebar (radar + canvas tabs), the engine host (Phase 2: the shared
 * session/queue hooks — real generation), the substrate, the launcher overlay
 * for empty canvases, the properties panel, the contextual bottom bar, the
 * summonable index, ambient toasts, session wiring (open/close/order + camera
 * autosave through the documents API), and the drop-anything ingestion
 * (bytes → content-addressed blobs). Phase 3 added the OP MODAL (§5.1) and
 * the pose-rig dock (§5.2); Phase 4 the audio + settings docks; Phase 5 the
 * STUDIOS + DIAGNOSTICS docks (the kept surfaces' canvas home).
 *
 * ?canvas=1&bench=1 mounts the L33 rendering-budget harness instead
 * (Benchmark.tsx) — same substrate, synthetic document, measurement protocol.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { TransientProbe } from '../state/TransientProbe'
import { AudioDock } from './AudioDock'
import { BottomBar } from './BottomBar'
import { CanvasEngineHost } from './EngineHost'
import { DiagnosticsDock } from './DiagnosticsDock'
import { EndpointMenu } from './EndpointMenu'
import { ForkMenu } from './ForkMenu'
import { IndexOverlay } from './IndexOverlay'
import { LibraryOverlay } from './LibraryOverlay'
import { TimelineOverlay } from './TimelineOverlay'
import { OpEditor } from './OpEditor'
import { PoseRigDock } from './PoseRigDock'
import { PropertiesPanel } from './PropertiesPanel'
import { Launcher } from './Launcher'
import { Radar } from './Radar'
import { SettingsDock } from './SettingsDock'
import { StudiosDock } from './StudiosDock'
import { Substrate } from './Substrate'
import { useCanvasStore } from './store'
import { useJobsStore } from '../state/jobsStore'
import { CanvasBenchmark } from './Benchmark'
import './canvas.css'

const benchMode = new URLSearchParams(window.location.search).get('bench') === '1'

export function CanvasApp() {
  const phase = useCanvasStore((state) => state.phase)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const documents = useCanvasStore((state) => state.documents)
  const tiles = useCanvasStore((state) => state.tiles)
  const toasts = useCanvasStore((state) => state.toasts)
  const boot = useCanvasStore((state) => state.boot)
  const select = useCanvasStore((state) => state.select)
  const ingestFile = useCanvasStore((state) => state.ingestFile)
  const setIndexOpen = useCanvasStore((state) => state.setIndexOpen)
  const requestCamera = useCanvasStore((state) => state.requestCamera)
  const rerunStale = useCanvasStore((state) => state.rerunStale)
  const setForkMenu = useCanvasStore((state) => state.setForkMenu)

  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!benchMode) void boot()
  }, [boot])

  // jobsStore → derived tile statuses + completion landing (job events are
  // rare; recompute is one derive pass over the active document).
  useEffect(() => useJobsStore.subscribe(() => useCanvasStore.getState().recompute()), [])

  // §7 base keys: Escape deselect / close index, J/K cycle, ⌘K index, R
  // rerun-stale, B fork the selection, Enter opens the op modal on a media
  // selection (properties otherwise), P pin/lock, digits 1–9 jump-to-take
  // (canonical pointer switch). The op modal and the pose-rig dock own the
  // keyboard while open (the rig binds its own window keys; ⌘Z inside the
  // modal is the modal's per-op undo) — canvas-wide single-letter keys gate.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setIndexOpen(!useCanvasStore.getState().indexOpen)
        return
      }
      if (event.key === 'Escape') {
        // App-tour wave (d6iy68r, review m1, decided 2026-09-19): ONE action
        // per press. Overlays with their own Escape handlers (index, library,
        // endpoint menu) stopPropagation — the overlay that ACTS owns the
        // keypress and this chain never runs for it (before, closing an
        // overlay ALSO deselected in the same press). This handler stays the
        // owner for everything without its own handler.
        const state = useCanvasStore.getState()
        if (state.indexOpen) setIndexOpen(false)
        else if (state.gapMenu) state.setGapMenu(null)
        else if (state.timelineOpen) state.setTimelineOpen(false)
        else if (state.libraryOpen) state.setLibraryOpen(false)
        else if (state.endpointMenu || state.forkMenu) {
          state.setEndpointMenu(null)
          state.setForkMenu(null)
        } else if (state.studiosDock) state.setStudiosDock(null)
        else if (state.diagnosticsDock) state.setDiagnosticsDock(false)
        else select(null)
        return
      }
      if (typing) return
      // QOL wave (rrxlw2r, 2026-09-18): Alt-modified keys belong to the
      // shared chrome (the surface switcher's Alt+1..9) — the canvas's own
      // single-letter keys (digits included) never fire with Alt held.
      if (event.altKey) return
      const state = useCanvasStore.getState()
      // The modal surfaces own Escape/keys while open.
      if (state.opEditor || state.poseRig) return
      // §7 V — the projection flip through the family: ∅ → timeline →
      // library → ∅ (Phase 5b; Phase 4's V toggled the library alone).
      if (event.key === 'v') {
        state.cycleProjection()
        return
      }
      if (!state.tiles.length) return
      if (event.key === 'j' || event.key === 'k') {
        const index = state.tiles.findIndex((tile) => tile.id === state.selection.tileIds[0])
        const delta = event.key === 'j' ? 1 : -1
        const next = state.tiles[(index + delta + state.tiles.length) % state.tiles.length]
        if (next) {
          select(next.id)
          requestCamera({ kind: 'fly', tileId: next.id })
        }
      }
      if (event.key === 'f') requestCamera({ kind: 'fit' })
      // Rerun every stale chain — one gesture (principle 5).
      if (event.key === 'r') void rerunStale()
      // B opens the fork menu on the selected output tile (§7 branch/fork).
      if (event.key === 'b') {
        const selected = state.selection.tileIds[0]
        const tile = state.tiles.find((entry) => entry.id === selected)
        if (tile && tile.canonical) setForkMenu({ chainId: tile.id })
      }
      // §7: modal open on selection (Enter) — the op modal for a media tile,
      // the properties panel otherwise.
      if (event.key === 'Enter') {
        const selected = state.selection.tileIds[0]
        const tile = state.tiles.find((entry) => entry.id === selected)
        if (!tile) return
        if (tile.kind === 'media' && tile.canonical) useCanvasStore.getState().setOpEditor({ chainId: tile.id })
        else useCanvasStore.getState().setInspectorOpen(true)
      }
      // §7: P pin (lock/unlock) the selection.
      if (event.key === 'p') {
        const selected = state.selection.tileIds[0]
        const tile = state.tiles.find((entry) => entry.id === selected)
        if (tile) void useCanvasStore.getState().setChainLock(tile.id, tile.lockState !== 'locked')
      }
      // §7: digits 1–9 jump-to-take — take N of the selected chain becomes
      // canonical (oldest-first; nothing is ever deleted — F5/takes).
      if (/^[1-9]$/.test(event.key)) {
        const selected = state.selection.tileIds[0]
        const tile = state.tiles.find((entry) => entry.id === selected)
        if (!tile || tile.takes.length < 2) return
        const oldestFirst = [...tile.takes].sort((a, b) => a.createdAt - b.createdAt)
        const take = oldestFirst[Number(event.key) - 1]
        if (take && take.supersededBy !== null) void useCanvasStore.getState().switchCanonical(tile.id, take.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestCamera, select, setIndexOpen, setForkMenu, rerunStale])

  // Drop-anything: the drop routes itself by media kind (§4) and lands as a
  // REAL stored object (bytes → blob row → media chain → tile). Works over
  // any canvas state — empty or populated.
  const handleFile = useCallback(async (file: File) => {
    const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null
    if (!type) {
      useCanvasStore.getState().toast('error', `${file.name} is not a media kind the canvas knows (image / video / audio).`)
      return
    }
    // Session-local preview paints instantly; the ingested blob is the
    // durable copy the tile falls back to after a reload.
    const previewUrl = type === 'image' || type === 'video' ? URL.createObjectURL(file) : undefined
    try {
      const bytes = await file.arrayBuffer()
      await ingestFile({ name: file.name, kind: type, bytes, previewUrl })
    } catch (error) {
      useCanvasStore.getState().toast('error', `${file.name} could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [ingestFile])

  if (benchMode) return <CanvasBenchmark />

  const activeDocument = activeProjectId ? documents[activeProjectId] : null
  const emptyCanvas = !activeDocument || activeDocument.chains.length === 0

  return <div
    className={`canvas-root ${dragging ? 'canvas-dropping' : ''}`}
    data-canvas-root
    data-phase={phase}
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      setDragging(true)
    }}
    onDragLeave={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return
      setDragging(false)
    }}
    onDrop={(event) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files?.[0]
      if (file) void handleFile(file)
    }}
  >
    <CanvasEngineHost>
      <Radar />
      <div className="canvas-stage">
        <Substrate />
        {phase === 'ready' && emptyCanvas && <Launcher onPickFile={() => fileInputRef.current?.click()} />}
      </div>
      <PropertiesPanel />
      <BottomBar />
      <EndpointMenu />
      <ForkMenu />
      <OpEditor />
      <PoseRigDock />
      <AudioDock />
      <SettingsDock />
      <StudiosDock />
      <DiagnosticsDock />
      <IndexOverlay />
      <LibraryOverlay />
      <TimelineOverlay />
    </CanvasEngineHost>
    <div className="canvas-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`canvas-toast ${toast.tone}`} data-canvas-toast={toast.tone}>
          <span>{toast.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => useCanvasStore.getState().dismissToast(toast.id)}>×</button>
        </div>
      ))}
    </div>
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*,video/*,audio/*"
      className="canvas-file-input"
      data-canvas-file-input
      onChange={(event) => {
        const file = event.target.files?.[0]
        if (file) void handleFile(file)
        event.target.value = ''
      }}
    />
    <span className="canvas-tile-count" data-canvas-tile-count aria-hidden>{tiles.length} {tiles.length === 1 ? 'object' : 'objects'}</span>
    {/* The wave-2a transient probe pair (?probe=transient): hidden, inert in
        every normal session, and NOT memoized on purpose — its render count
        is the zero-React-render canary the e2e drives. Carried by the old
        Create view until Phase 5; the app root is its home now. */}
    {new URLSearchParams(window.location.search).get('probe') === 'transient' && <TransientProbe />}
  </div>
}
