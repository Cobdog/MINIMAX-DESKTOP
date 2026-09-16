/**
 * Canvas Phase 1 — the canvas session store.
 *
 * Everything the route renders except the camera: the open-project session,
 * loaded documents, derived tiles/edges, selection, the launcher, mock queue
 * links, toasts. The CAMERA is deliberately NOT here (camera.ts owns it,
 * outside React) — the store only ever emits rare `cameraCommands` that the
 * substrate executes through the d3-zoom attachment.
 *
 * Phase-1 honesty notes:
 *  - the seed tile's job is a MOCK parked in jobsStore (derive.CANVAS_MOCK_JOB_PREFIX);
 *    generation itself is Phase 2 and nothing here schedules work;
 *  - view persistence (camera + tile layout) rides the project's camera_json
 *    blob — the Phase-0 schema has no tile-geometry column (flagged seam).
 */
import { create } from 'zustand'
import { documentsApi, type ProjectMeta } from './api'
import { type CameraState, createCamera, parseViewBlob, type ViewBlob } from './camera'
import {
  attention,
  CANVAS_MOCK_JOB_PREFIX,
  type CanvasDocument,
  deriveEdges,
  deriveTiles,
  seedSpawnPoint,
  TILE_W,
  type Tile,
  type Edge,
} from './derive'
import { useJobsStore } from '../state/jobsStore'
import type { GenerationJob } from '../types'

/** The camera singleton for this route — attach in Substrate, never subscribe
 *  per-frame in React. */
export const camera = createCamera()

export type CameraCommand =
  | { kind: 'fly'; tileId: string }
  | { kind: 'jump'; camera: CameraState }
  | { kind: 'fit' }

export type CanvasToast = { id: number; tone: 'error' | 'success' | 'neutral'; text: string }

type CanvasState = {
  phase: 'boot' | 'ready'
  projects: ProjectMeta[]
  openProjects: string[]
  activeProjectId: string | null
  documents: Record<string, CanvasDocument>
  /** Derived for the ACTIVE document only. */
  tiles: Tile[]
  edges: Edge[]
  layout: ViewBlob['layout']
  selection: { tileId: string } | null
  chainJobs: Record<string, string>
  dismissedFailures: string[]
  droppedPreviews: Record<string, string>
  toasts: CanvasToast[]
  inspectorOpen: boolean
  indexOpen: boolean
  cameraCommands: CameraCommand[]
  cameraCommandSeq: number
  viewDirty: boolean
}

type CanvasActions = {
  boot(): Promise<void>
  refreshProjects(): Promise<void>
  openProject(id: string, options?: { restoreCamera?: boolean }): Promise<void>
  closeProject(id: string): Promise<void>
  createCanvas(name?: string): Promise<string | null>
  submitPrompt(text: string, mediaType: 'video' | 'image'): Promise<void>
  dropMedia(file: { name: string; kind: 'image' | 'video' | 'audio'; previewUrl?: string }): Promise<void>
  select(tileId: string | null): void
  dismissFailure(tileId: string): void
  setInspectorOpen(open: boolean): void
  setIndexOpen(open: boolean): void
  toast(tone: CanvasToast['tone'], text: string): void
  dismissToast(id: number): void
  /** Rare camera intents — the substrate executes + clears them. */
  requestCamera(command: CameraCommand): void
  clearCameraCommands(): void
  /** Camera settled (debounced by the substrate) — persist the view blob. */
  persistView(): void
  /** jobsStore changed — recompute statuses (cheap; job events are rare). */
  recompute(): void
}

let toastSeq = 1

export const useCanvasStore = create<CanvasState & CanvasActions>()((set, get) => {
  /** Recompute tiles+edges from the active document + job links. */
  const recomputeTiles = () => {
    const state = get()
    const activeDoc = state.activeProjectId ? state.documents[state.activeProjectId] ?? null : null
    if (!activeDoc) {
      set({ tiles: [], edges: [] })
      return
    }
    const jobs = useJobsStore.getState().jobs
    const tiles = deriveTiles(activeDoc, jobs, state.chainJobs, state.layout, new Set(state.dismissedFailures))
    const edges = deriveEdges(activeDoc, tiles)
    set({ tiles, edges })
  }

  const saveSession = async (openProjects: string[], activeProject: string | null) => {
    try {
      await documentsApi.saveSession({ openProjects, activeProject })
    } catch (error) {
      get().toast('error', `Could not save the canvas session: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const loadDocument = async (id: string): Promise<CanvasDocument | null> => {
    try {
      const loaded = await documentsApi.getProject(id)
      set((state) => ({ documents: { ...state.documents, [id]: loaded } }))
      return loaded
    } catch (error) {
      get().toast('error', `Could not open this canvas: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  return {
    phase: 'boot',
    projects: [],
    openProjects: [],
    activeProjectId: null,
    documents: {},
    tiles: [],
    edges: [],
    layout: undefined,
    selection: null,
    chainJobs: {},
    dismissedFailures: [],
    droppedPreviews: {},
    toasts: [],
    inspectorOpen: false,
    indexOpen: false,
    cameraCommands: [],
    cameraCommandSeq: 0,
    viewDirty: false,

    boot: async () => {
      try {
        const [projects, session] = await Promise.all([documentsApi.listProjects(), documentsApi.getSession()])
        set({ projects, openProjects: session.openProjects, activeProjectId: session.activeProject })
        const active = session.activeProject
        if (active && projects.some((project) => project.id === active)) {
          const bootDoc = await loadDocument(active)
          if (bootDoc) {
            const view = parseViewBlob(bootDoc.project.camera)
            set({ layout: view.layout })
            recomputeTiles()
            get().requestCamera({ kind: 'jump', camera: view.camera })
          }
        } else {
          // An empty or missing session boots to the launcher (§4).
          set({ activeProjectId: null, openProjects: session.openProjects.filter((id) => projects.some((project) => project.id === id)) })
        }
      } catch (error) {
        get().toast('error', `The canvas could not reach the document store: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        set({ phase: 'ready' })
      }
    },

    refreshProjects: async () => {
      try {
        set({ projects: await documentsApi.listProjects() })
      } catch {
        // Listed resume cards going stale is ambient — the next refresh retries.
      }
    },

    openProject: async (id, options) => {
      const state = get()
      if (state.activeProjectId === id) return
      const doc = state.documents[id] ?? (await loadDocument(id))
      if (!doc) return
      const openProjects = [id, ...state.openProjects.filter((openId) => openId !== id)].slice(0, 8)
      const view = parseViewBlob(doc.project.camera)
      set({ activeProjectId: id, openProjects, layout: view.layout, selection: null })
      recomputeTiles()
      get().requestCamera(options?.restoreCamera === false ? { kind: 'fit' } : { kind: 'jump', camera: view.camera })
      void saveSession(openProjects, id)
      void get().refreshProjects()
    },

    closeProject: async (id) => {
      const state = get()
      const openProjects = state.openProjects.filter((openId) => openId !== id)
      let activeProjectId = state.activeProjectId
      if (activeProjectId === id) {
        activeProjectId = openProjects[0] ?? null
        if (activeProjectId) {
          const nextDoc = state.documents[activeProjectId] ?? (await loadDocument(activeProjectId))
          if (nextDoc) {
            const view = parseViewBlob(nextDoc.project.camera)
            set({ layout: view.layout })
            get().requestCamera({ kind: 'jump', camera: view.camera })
          }
        } else {
          set({ layout: undefined, tiles: [], edges: [], selection: null })
        }
      }
      set({ activeProjectId, openProjects })
      recomputeTiles()
      void saveSession(openProjects, activeProjectId)
    },

    createCanvas: async (name) => {
      try {
        const project = await documentsApi.createProject(name ?? `Canvas ${new Date().toLocaleDateString()}`)
        await get().openProject(project.id, { restoreCamera: false })
        set((state) => ({ projects: [project, ...state.projects.filter((entry) => entry.id !== project.id)] }))
        return project.id
      } catch (error) {
        get().toast('error', `Could not create a canvas: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    submitPrompt: async (text, mediaType) => {
      const prompt = text.trim()
      const state = get()
      if (!prompt) return
      let projectId = state.activeProjectId
      if (!projectId) {
        const created = await get().createCanvas()
        if (!created) return
        projectId = created
      }
      try {
        const viewport = globalThis.document.querySelector<HTMLElement>('.canvas-viewport')
        const spawn = viewport
          ? seedSpawnPoint(camera.get(), viewport.clientWidth, viewport.clientHeight)
          : { x: 120, y: 96 }
        const chain = await documentsApi.createChain({
          projectId,
          kind: 'generation',
          inputSpec: { fresh: { prompt, mediaKind: mediaType } },
          settings: { prompt, mediaType },
        })
        // Spatial-queue contract c: the seed tile spawns at the prompt bar.
        // Pin the placement so later re-derivations keep it there.
        const chainId = chain?.id ?? `pending:${toastSeq++}`
        const jobId = `${CANVAS_MOCK_JOB_PREFIX}${chainId}`
        set((current) => ({
          layout: { ...(current.layout ?? {}), [chainId]: { x: spawn.x, y: spawn.y, w: TILE_W } },
          chainJobs: { ...current.chainJobs, [chainId]: jobId },
          viewDirty: true,
        }))
        // The mock job parks in jobsStore — real generation is Phase 2.
        useJobsStore.getState().setJobs((jobs) => [...jobs.filter((job) => job.id !== jobId), mockJobRecord(jobId, prompt, mediaType)])
        const refreshed = await loadDocument(projectId)
        if (refreshed) recomputeTiles()
        set({ selection: { tileId: chainId }, inspectorOpen: true })
        get().requestCamera({ kind: 'fly', tileId: chainId })
        get().persistView()
      } catch (error) {
        get().toast('error', `Could not create the seed object: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    dropMedia: async (file) => {
      const state = get()
      let projectId = state.activeProjectId
      if (!projectId) {
        const created = await get().createCanvas()
        if (!created) return
        projectId = created
      }
      try {
        const viewport = globalThis.document.querySelector<HTMLElement>('.canvas-viewport')
        const spawn = viewport
          ? seedSpawnPoint(camera.get(), viewport.clientWidth, viewport.clientHeight)
          : { x: 120, y: 96 }
        const chain = await documentsApi.createChain({
          projectId,
          kind: 'media',
          inputSpec: { fresh: { media: { name: file.name, kind: file.kind } } },
          settings: { name: file.name },
        })
        const chainId = chain?.id ?? `pending:${toastSeq++}`
        set((current) => ({
          layout: { ...(current.layout ?? {}), [chainId]: { x: spawn.x, y: spawn.y, w: TILE_W } },
          droppedPreviews: file.previewUrl ? { ...current.droppedPreviews, [chainId]: file.previewUrl } : current.droppedPreviews,
          viewDirty: true,
        }))
        const refreshed = await loadDocument(projectId)
        if (refreshed) recomputeTiles()
        set({ selection: { tileId: chainId }, inspectorOpen: true })
        get().requestCamera({ kind: 'fly', tileId: chainId })
        get().persistView()
        get().toast('neutral', `${file.name} landed as a ${file.kind} object — ingestion wires up in Phase 2.`)
      } catch (error) {
        get().toast('error', `The dropped file could not land on the canvas: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    select: (tileId) => set({ selection: tileId ? { tileId } : null, inspectorOpen: tileId ? true : get().inspectorOpen }),

    dismissFailure: (tileId) => {
      set((state) => ({ dismissedFailures: state.dismissedFailures.includes(tileId) ? state.dismissedFailures : [...state.dismissedFailures, tileId] }))
      recomputeTiles()
    },

    setInspectorOpen: (open) => set({ inspectorOpen: open }),
    setIndexOpen: (open) => set({ indexOpen: open }),

    toast: (tone, text) => {
      const id = toastSeq++
      set((state) => ({ toasts: [...state.toasts.slice(-3), { id, tone, text }] }))
      window.setTimeout(() => get().dismissToast(id), tone === 'error' ? 6500 : 4200)
    },
    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

    requestCamera: (command) => set((state) => ({ cameraCommands: [...state.cameraCommands.slice(-3), command], cameraCommandSeq: state.cameraCommandSeq + 1 })),
    clearCameraCommands: () => set({ cameraCommands: [] }),

    persistView: () => {
      const state = get()
      const projectId = state.activeProjectId
      // The L33 benchmark stages a synthetic, non-persisted document — its
      // view must never hit the documents API.
      if (!projectId || projectId.startsWith('bench-')) return
      const view = { camera: camera.get(), layout: state.layout ?? {} }
      void documentsApi.updateProjectView(projectId, view).catch((error: unknown) => {
        get().toast('error', `Camera could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      })
    },

    recompute: () => recomputeTiles(),
  }
})

/** The mock seed job in GenerationJob form (jobsStore holds full records). */
function mockJobRecord(jobId: string, prompt: string, mediaType: 'video' | 'image'): GenerationJob {
  return {
    id: jobId,
    mode: 'text',
    prompt,
    createdAt: Date.now(),
    status: 'queued',
    progress: 0,
    width: 1344,
    height: 768,
    duration: 6,
    provider: 'minimax',
    mediaType,
    manifest: { canvasPhase1Mock: true },
  }
}

/** Selector helper: radar aggregates over the derived tiles (§4). */
export const selectAttention = (state: CanvasState) => attention(state.tiles)

// ---- gated test surface (?probe=canvas) -------------------------------------
// Same precedent as transientProbe: shipped but inert in every normal
// session; drives the REAL store paths (a job event arriving) so the e2e
// suite can exercise the failure contract without an engine.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('probe') === 'canvas') {
  Object.defineProperty(window, '__canvasScenario', {
    configurable: true,
    value: (name: string) => {
      const state = useCanvasStore.getState()
      if (name === 'fail-worst') {
        // Flip the first linked canvas-mock job to failed — the exact store
        // transition a real failure event makes (contract a: durable on the
        // object until dismissed, reason attached).
        const entry = Object.entries(state.chainJobs)[0]
        if (!entry) return { ok: false, reason: 'no linked job' }
        const [chainId, jobId] = entry
        useJobsStore.getState().setJobs((jobs) => jobs.map((job) => job.id === jobId ? { ...job, status: 'failed', error: 'engine exploded (scenario)' } : job))
        state.recompute()
        return { ok: true, chainId, jobId }
      }
      if (name === 'stale-worst') {
        const tile = state.tiles.find((entry) => entry.status === 'stale') ?? state.tiles[0]
        if (!tile) return { ok: false, reason: 'no tile' }
        return { ok: true, tileId: tile.id }
      }
      return { ok: false, reason: `unknown scenario ${name}` }
    },
  })
}
