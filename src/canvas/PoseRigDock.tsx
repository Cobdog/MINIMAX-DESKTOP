/**
 * Canvas Phase 3 — the pose rig dock (§5.2 control-input family, epic
 * 66xhflw integration point).
 *
 * The ?poserig=1 component (src/poserig/, self-contained by design) becomes
 * reachable as a FLOATING canvas tool panel: the typed-hole menu's "Pose
 * rig" entry opens this react-rnd panel (§3: floating panels via react-rnd)
 * mounting the same lazy chunk. Export-to-control-track wiring: the rig's
 * rendered frames land as a content-addressed blob + a canvas_control_track
 * row on the target chain (kind pose, source poserig) — the §2.1 control
 * track, one per shot.
 */
import { lazy, Suspense, useState } from 'react'
import { Rnd } from 'react-rnd'
import { LoaderCircle } from 'lucide-react'
import { documentsApi } from './api'
import { useCanvasStore } from './store'

// The rig keeps its own lazy chunk (three.js + the pose modules) — the
// canvas chunk never pays for it until the dock opens.
const PoseRigApp = lazy(() => import('../poserig/PoseRigApp'))

const fallback = <div className="canvas-poserig-fallback"><LoaderCircle className="spin" size={16} /><span>loading the rig…</span></div>

export function PoseRigDock() {
  const panel = useCanvasStore((state) => state.poseRig)
  const setPoseRig = useCanvasStore((state) => state.setPoseRig)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const tiles = useCanvasStore((state) => state.tiles)
  const [exporting, setExporting] = useState(false)

  if (!panel) return null
  const doc = activeProjectId ? documents[activeProjectId] : null
  const chain = doc?.chains.find((entry) => entry.id === panel.chainId) ?? null
  const tile = tiles.find((entry) => entry.id === panel.chainId) ?? null
  if (!chain || !tile) return null

  /** The rig hands up its rendered contact sheet (PNG data URL); this lands
   *  it as the chain's control input: blob row (hash on ingest, invariant 9)
   *  + control-track row with the sheet's geometry as params. */
  const exportToTrack = async (payload: { dataBase64: string; frames: number; width: number; height: number }) => {
    if (exporting) return
    setExporting(true)
    try {
      const ingested = await documentsApi.ingestBlob({ dataBase64: payload.dataBase64, name: `pose-track-${Date.now()}.png`, kind: 'image' })
      await documentsApi.addControlTrack({
        chainId: chain.id,
        kind: 'pose',
        source: 'poserig',
        inputRef: ingested.path,
        params: { frames: payload.frames, width: payload.width, height: payload.height, blobPath: ingested.blob.relPath },
      })
      useCanvasStore.getState().toast('success', `Pose control track exported — ${payload.frames} frame${payload.frames === 1 ? '' : 's'} at ${payload.width}×${payload.height}, stored and hashed.`)
    } catch (error) {
      useCanvasStore.getState().toast('error', `The control track could not land: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setExporting(false)
    }
  }

  return <Rnd
    className="canvas-poserig-dock"
    data-canvas-poserig
    default={{ x: 96, y: 72, width: Math.min(1180, window.innerWidth - 120), height: Math.min(720, window.innerHeight - 160) }}
    minWidth={720}
    minHeight={420}
    bounds="parent"
    dragHandleClassName="canvas-poserig-header"
  >
    <header className="canvas-poserig-header">
      <strong>Pose rig — control track for “{tile.title}”</strong>
      <span>{exporting ? 'exporting…' : 'palette-exact DWPose · export lands as this chain’s control track'}</span>
      <button type="button" aria-label="Close the pose rig" data-canvas-poserig-close onClick={() => setPoseRig(null)}>×</button>
    </header>
    <div className="canvas-poserig-body">
      <Suspense fallback={fallback}>
        <PoseRigApp dock={{ onExportTrack: (payload) => void exportToTrack(payload) }} />
      </Suspense>
    </div>
  </Rnd>
}
