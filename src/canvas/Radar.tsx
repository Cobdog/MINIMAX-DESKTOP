/**
 * Canvas Phase 1 — the titlebar radar (§4 attention model), INSIDE the
 * canvas route.
 *
 * Aggregate "N running · M queued · K needs attention" over jobsStore (linked
 * canvas jobs plus any unlinked job facts the store holds) and the document's
 * stale chains. Click = zoom-to-attention on the worst item (failed > stale —
 * weight ordering from derive.attention). The engine chip + GPU meter's home
 * is here per the spec; Phase 1 renders the chip honestly as not-yet-wired
 * (the canvas consumes no engine — generation is Phase 2).
 */
import { Activity, Briefcase, LayoutList, Library, Settings, Stethoscope } from 'lucide-react'
import { useJobsStore } from '../state/jobsStore'
import { attention } from './derive'
import { useCanvasStore } from './store'

export function Radar() {
  const tiles = useCanvasStore((state) => state.tiles)
  const chainJobs = useCanvasStore((state) => state.chainJobs)
  const projects = useCanvasStore((state) => state.projects)
  const documents = useCanvasStore((state) => state.documents)
  const openProjects = useCanvasStore((state) => state.openProjects)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const closeProject = useCanvasStore((state) => state.closeProject)
  const openProject = useCanvasStore((state) => state.openProject)
  const requestCamera = useCanvasStore((state) => state.requestCamera)
  const select = useCanvasStore((state) => state.select)
  const toast = useCanvasStore((state) => state.toast)
  const setIndexOpen = useCanvasStore((state) => state.setIndexOpen)
  const engine = useCanvasStore((state) => state.engine)
  const jobs = useJobsStore((state) => state.jobs)

  const linked = new Set(Object.values(chainJobs))
  const unlinked = jobs.filter((job) => !linked.has(job.id))
  const aggregate = attention(tiles)
  // One queue, both surfaces (D1/D2): unlinked ACTIVE work (renders submitted
  // from the old CreateView) still counts toward running/queued. Needs-
  // attention stays derived from the open canvases' OBJECTS only — an
  // unlinked failed job has no object here to dismiss; the index + JobsView
  // carry it (contract a: failure states are durable ON the object).
  const counts = {
    running: aggregate.counts.running + unlinked.filter((job) => job.status === 'running').length,
    queued: aggregate.counts.queued + unlinked.filter((job) => job.status === 'queued').length,
    needsAttention: aggregate.counts.needsAttention,
  }

  const zoomToAttention = () => {
    const worst = attention(useCanvasStore.getState().tiles).worst
    if (worst) {
      select(worst.tileId)
      requestCamera({ kind: 'fly', tileId: worst.tileId })
    } else {
      toast('neutral', 'Nothing needs attention — the queue is calm.')
    }
  }

  const tabs = openProjects.map((id) => documents[id]?.project ?? projects.find((project) => project.id === id)).filter((project): project is NonNullable<typeof project> => Boolean(project))

  return <header className="canvas-titlebar" data-canvas-titlebar>
    <div className="canvas-tabs" data-canvas-tabs>
      {tabs.map((project) => (
        <span key={project.id} className={`canvas-tab ${project.id === activeProjectId ? 'active' : ''}`} data-canvas-tab={project.id}>
          <button type="button" className="canvas-tab-name" onClick={() => void openProject(project.id)}>{project.name}</button>
          <button type="button" className="canvas-tab-close" aria-label={`Close ${project.name}`} onClick={() => void closeProject(project.id)}>×</button>
        </span>
      ))}
    </div>

    <button
      type="button"
      className={`canvas-radar ${counts.needsAttention ? 'attention' : ''}`}
      data-canvas-radar
      data-running={counts.running}
      data-queued={counts.queued}
      data-attention={counts.needsAttention}
      onClick={zoomToAttention}
      title="Zoom to the worst item needing attention"
    >
      <Activity size={13} />
      <span className="canvas-radar-text" data-canvas-radar-text>
        {counts.running === 0 && counts.queued === 0 && counts.needsAttention === 0
          ? 'calm'
          : [
            counts.running ? `${counts.running} running` : '',
            counts.queued ? `${counts.queued} queued` : '',
            counts.needsAttention ? `${counts.needsAttention} needs attention` : '',
          ].filter(Boolean).join(' · ')}
      </span>
    </button>

    <button type="button" className={`canvas-engine-chip ${engine.connected ? (engine.modelReady ? 'online' : 'degraded') : ''}`} data-canvas-engine data-engine-connected={engine.connected} data-engine-ready={engine.modelReady} title={engine.connected ? (engine.modelReady ? 'Local engine connected — MiniMax H3 ready' : 'Engine connected but H3 model components are missing — install them and refresh') : 'Engine offline — start ComfyUI to generate'}>
      <span className="status-dot" /> {engine.connected ? (engine.modelReady ? 'H3 engine ready' : 'engine on · models missing') : 'engine offline'}
    </button>

    <div className="canvas-titlebar-spacer" />
    <button type="button" className="canvas-index-button" data-canvas-timeline-button onClick={() => useCanvasStore.getState().setTimelineOpen(true)} title="The timeline projection — the plan chronology + measured transitions (V)">
      <LayoutList size={12} /> timeline <kbd>V</kbd>
    </button>
    <button type="button" className="canvas-index-button" data-canvas-library-button onClick={() => useCanvasStore.getState().setLibraryOpen(true)} title="The library projection — every completed output across the session (V)">
      <Library size={12} /> library <kbd>V</kbd>
    </button>
    <button type="button" className="canvas-index-button" data-canvas-studios-button onClick={() => useCanvasStore.getState().setStudiosDock({ tab: 'characters' })} title="Studios — asset authoring (characters, hair, wardrobe, accessories, locations) + the movie planner, docked">
      <Briefcase size={12} /> studios
    </button>
    <button type="button" className="canvas-index-button" data-canvas-diagnostics-button onClick={() => useCanvasStore.getState().setDiagnosticsDock(true)} title="Diagnostics — the PII-scrubbed report surface, docked">
      <Stethoscope size={12} /> diagnostics
    </button>
    <button type="button" className="canvas-index-button" data-canvas-settings-button onClick={() => useCanvasStore.getState().setSettingsDock(true)} title="Settings — docked as a floating panel on every surface">
      <Settings size={12} /> settings
    </button>
    <button type="button" className="canvas-index-button" data-canvas-index-button onClick={() => setIndexOpen(true)}>
      index <kbd>⌘K</kbd>
    </button>
  </header>
}
