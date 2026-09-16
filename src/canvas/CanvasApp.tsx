/**
 * Canvas Phase 1 — the route root behind ?canvas=1 (§3/§4).
 *
 * Mounts ONLY under the canvas route (main.tsx lazily loads this module like
 * the prototypes; every normal app route never imports it). Own titlebar
 * (radar + canvas tabs), the substrate, the launcher overlay for empty
 * canvases, the floating inspector, the summonable index, ambient toasts,
 * session wiring (open/close/order + camera autosave through the documents
 * API), and the drop-anything routing. NO engine usage — the canvas renders
 * media from the document store; generation itself is Phase 2.
 *
 * ?canvas=1&bench=1 mounts the L33 rendering-budget harness instead
 * (Benchmark.tsx) — same substrate, synthetic document, measurement protocol.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IndexOverlay } from './IndexOverlay'
import { Inspector } from './Inspector'
import { Launcher } from './Launcher'
import { Radar } from './Radar'
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
  const dropMedia = useCanvasStore((state) => state.dropMedia)
  const setIndexOpen = useCanvasStore((state) => state.setIndexOpen)
  const requestCamera = useCanvasStore((state) => state.requestCamera)

  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!benchMode) void boot()
  }, [boot])

  // jobsStore → derived tile statuses (job events are rare; recompute is
  // one derive pass over the active document).
  useEffect(() => useJobsStore.subscribe(() => useCanvasStore.getState().recompute()), [])

  // §7 base keys: Escape deselect / close index, J/K cycle, ⌘K index.
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
        if (useCanvasStore.getState().indexOpen) setIndexOpen(false)
        else select(null)
        return
      }
      if (typing) return
      const state = useCanvasStore.getState()
      if (!state.tiles.length) return
      if (event.key === 'j' || event.key === 'k') {
        const index = state.tiles.findIndex((tile) => tile.id === state.selection?.tileId)
        const delta = event.key === 'j' ? 1 : -1
        const next = state.tiles[(index + delta + state.tiles.length) % state.tiles.length]
        if (next) {
          select(next.id)
          requestCamera({ kind: 'fly', tileId: next.id })
        }
      }
      if (event.key === 'f') requestCamera({ kind: 'fit' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestCamera, select, setIndexOpen])

  // Drop-anything: the drop routes itself by media kind (§4) and lands as a
  // media object. Works over any canvas state — empty or populated.
  const handleFile = useCallback((file: File) => {
    const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null
    if (!type) {
      useCanvasStore.getState().toast('error', `${file.name} is not a media kind the canvas knows (image / video / audio).`)
      return
    }
    const previewUrl = type === 'image' || type === 'video' ? URL.createObjectURL(file) : undefined
    void dropMedia({ name: file.name, kind: type, previewUrl })
  }, [dropMedia])

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
      if (file) handleFile(file)
    }}
  >
    <Radar />
    <div className="canvas-stage">
      <Substrate />
      {phase === 'ready' && emptyCanvas && <Launcher onPickFile={() => fileInputRef.current?.click()} />}
    </div>
    <Inspector />
    <IndexOverlay />
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
        if (file) handleFile(file)
        event.target.value = ''
      }}
    />
    <span className="canvas-tile-count" data-canvas-tile-count aria-hidden>{tiles.length} {tiles.length === 1 ? 'object' : 'objects'}</span>
  </div>
}
