/**
 * Canvas Phase 2 — the canvas session store.
 *
 * Everything the route renders except the camera: the open-project session,
 * loaded documents, derived tiles/edges, selection (single + batch), the
 * launcher, library bindings, the endpoint/fork menus, toasts — and, since
 * Phase 2, GENERATION: chains submit REAL H3 renders through the shared
 * flows core (lib/h3Submit.ts) with per-chain settings unwound from the old
 * workspace singleton, completed jobs land as takes on their chains, and
 * dropped bytes ingest into content-addressed blobs.
 *
 * The camera is deliberately NOT here (camera.ts owns it, outside React) —
 * the store only emits rare `cameraCommands` that the substrate executes.
 *
 * Engine facts (connection, models, object-info, live clientId, queue
 * cancellation) live in the SHARED zustand stores (sessionStore/jobsStore)
 * mounted by the route's EngineHost — this store reads them at call time
 * through the `engineBridge` the host registers. The old CreateView and the
 * canvas thus share one queue, one engine session, one flows core (spec §8
 * D1/D2); the WORKSPACE singleton stays the old surface's own — canvas
 * generation settings live per chain in the document store.
 */
import { create } from 'zustand'
import { documentsApi, type ProjectMeta } from './api'
import { type CameraState, createCamera, parseViewBlob, type ViewBlob } from './camera'
import {
  attention,
  avoidOverlap,
  CANVAS_MOCK_JOB_PREFIX,
  type CanvasDocument,
  deriveEdges,
  deriveTiles,
  seedSpawnPoint,
  TILE_W,
  type Tile,
  type Edge,
} from './derive'
import {
  buildCanvasRenderRequest,
  buildOutputIndex,
  chainSettingsDefaults,
  effectiveMode,
  emptyLibraries,
  forkInputSpec,
  mediaForOutput,
  MODE_LABEL,
  planCanvasGraph,
  readChainSettings,
  resolveChainReferences,
  type CanvasChainSettings,
  type CanvasLibraries,
  type ForkSubstrate,
} from './generation'
import type { EndpointDirection, EndpointOption, OptionAvailability } from './options'
import { findH3PreviewOverrideNode } from '../lib/h3Stack'
import { inferSelections } from '../lib/modelSelection'
import { submitH3Render, validateH3Render } from '../lib/h3Submit'
import { findLtx23Utility } from '../lib/graph'
import { loadCharacterProjects } from '../lib/characterLibrary'
import { loadLocationProjects } from '../lib/locationLibrary'
import { loadWardrobeProjects } from '../lib/wardrobeLibrary'
import { useJobsStore } from '../state/jobsStore'
import { useSessionStore } from '../state/sessionStore'
import type { GenerationJob, MediaFile, ModelSelection } from '../types'

/** The camera singleton for this route — attach in Substrate, never subscribe
 *  per-frame in React. */
export const camera = createCamera()

// ---- the engine bridge (registered by EngineHost) ------------------------------

/** What the route's EngineHost registers at mount: the live-preview clientId,
 *  the queue's cancellation set, and cancellation itself. Everything else is
 *  read from the shared session store at call time. */
export type EngineBridge = {
  clientId?: string
  cancellationRequests?: { current: Set<string> }
  cancelJob?(job: GenerationJob): void
}

export const engineBridge: EngineBridge = {}

/** Call-time engine facts from the shared session store — the same values the
 *  old surface's facades hold, read where the flows read them. */
function engineFacts() {
  const session = useSessionStore.getState()
  return {
    session,
    settings: session.settings,
    models: session.models,
    info: session.info,
    connected: session.status.connected,
  }
}

/** H3 readiness for one turbo tier (the App-root computation, per chain). */
function selectionFor(turbo: 'off' | '4' | '8', family: string): ModelSelection {
  return inferSelections(useSessionStore.getState().models, turbo, family || undefined)
}

function modelReadyFor(selection: ModelSelection, turbo: 'off' | '4' | '8'): boolean {
  const activeModel = turbo === 'off' ? selection.fl2va : selection.ref2va
  return Boolean(selection.fl2va && selection.ref2va && selection.textEncoder && selection.videoVae && selection.audioVae && activeModel)
}

// ---------------------------------------------------------------------------------

export type CameraCommand =
  | { kind: 'fly'; tileId: string }
  | { kind: 'jump'; camera: CameraState }
  | { kind: 'fit' }

export type CanvasToast = { id: number; tone: 'error' | 'success' | 'neutral'; text: string }

export type SelectionState = { tileIds: string[] }

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
  selection: SelectionState
  /** The libraries chains bind references from (the shared global stores). */
  libraries: CanvasLibraries
  /** Mirrored engine facts for honest UI states (EngineHost writes). */
  engine: { connected: boolean; modelReady: boolean }
  chainJobs: Record<string, string>
  dismissedFailures: string[]
  droppedPreviews: Record<string, string>
  toasts: CanvasToast[]
  inspectorOpen: boolean
  indexOpen: boolean
  endpointMenu: { chainId: string; direction: EndpointDirection } | null
  forkMenu: { chainId: string } | null
  cameraCommands: CameraCommand[]
  cameraCommandSeq: number
  viewDirty: boolean
}

type CanvasActions = {
  boot(): Promise<void>
  refreshProjects(): Promise<void>
  refreshLibraries(): void
  openProject(id: string, options?: { restoreCamera?: boolean }): Promise<void>
  closeProject(id: string): Promise<void>
  createCanvas(name?: string): Promise<string | null>
  /** The launcher's prompt submit: spawn the seed chain, then REAL submit. */
  submitPrompt(text: string, mediaType: 'video' | 'image'): Promise<void>
  /** Real H3 submission for one chain (per-chain settings → shared core). */
  submitChain(chainId: string): Promise<{ ok: boolean; message?: string }>
  /** Validation-only preview of a chain's submit (the bar + menus read it). */
  validateChain(chainId: string): string | null
  /** Dropped/picked bytes → blob + output-dir copy → media chain + take. */
  ingestFile(file: { name: string; kind: 'image' | 'video' | 'audio'; bytes: ArrayBuffer; previewUrl?: string }): Promise<void>
  /** Jobs changed: land completions, rebuild links, recompute. */
  recompute(): void
  select(tileId: string | null, options?: { toggle?: boolean }): void
  setChainSettings(chainId: string, patch: Partial<CanvasChainSettings>): Promise<void>
  setChainIdentity(chainId: string, patch: { subjectText?: string; strength?: number }): Promise<void>
  /** One typed-hole menu choice (§3 option menus). */
  runEndpointAction(chainId: string, direction: EndpointDirection, option: EndpointOption, sourceChainId?: string): Promise<void>
  /** Fork a chain's output on a substrate (§2 outputRef). */
  fork(source: { chainId: string; outputId: string; takeId?: string | null; substrate: ForkSubstrate }): Promise<void>
  setEndpointMenu(menu: { chainId: string; direction: EndpointDirection } | null): void
  setForkMenu(menu: { chainId: string } | null): void
  rerunStale(): Promise<void>
  cancelChainJob(chainId: string): Promise<void>
  dismissFailure(tileId: string): void
  setInspectorOpen(open: boolean): void
  setIndexOpen(open: boolean): void
  setEngineFacts(facts: { connected: boolean; modelReady: boolean }): void
  toast(tone: CanvasToast['tone'], text: string): void
  dismissToast(id: number): void
  requestCamera(command: CameraCommand): void
  clearCameraCommands(): void
  persistView(): void
  /** Availability facts for the typed-hole menus (registry-driven). */
  optionAvailability(): OptionAvailability
  /** The chain's resolved reference bindings (the panel + submit read this). */
  chainBindings(chainId: string): ReturnType<typeof resolveChainReferences>
}

let toastSeq = 1

export const useCanvasStore = create<CanvasState & CanvasActions>()((set, get) => {
  /** Last derivation signature — the identity-stability guard's memory. */
  let viewSigs = { tiles: '', edges: '', links: '' }

  /** Recompute tiles+edges from the active document + job links. */
  const recomputeTiles = () => {
    const state = get()
    const activeDoc = state.activeProjectId ? state.documents[state.activeProjectId] ?? null : null
    if (!activeDoc) {
      if (viewSigs.tiles || viewSigs.edges || viewSigs.links || state.tiles.length || state.edges.length) {
        viewSigs = { tiles: '', edges: '', links: '' }
        set({ tiles: [], edges: [] })
      }
      return
    }
    const jobs = useJobsStore.getState().jobs
    // Rebuild chain→job links from persisted manifests (a reload restores the
    // link for jobs whose manifest carries the canvas facts).
    const links: Record<string, string> = { ...state.chainJobs }
    for (const job of jobs) {
      const canvasLink = job.manifest && typeof job.manifest === 'object' ? (job.manifest as Record<string, unknown>).canvas : null
      const chainId = canvasLink && typeof canvasLink === 'object' ? (canvasLink as Record<string, unknown>).chainId : null
      if (typeof chainId === 'string' && activeDoc.chains.some((chain) => chain.id === chainId)) links[chainId] = job.id
    }
    const tiles = deriveTiles(activeDoc, jobs, links, state.layout, new Set(state.dismissedFailures))
    const edges = deriveEdges(activeDoc, tiles)
    // Identity-stability guard: background reloads and jobsStore ticks must
    // not swap the tiles/edges array references when the derivation is
    // unchanged — the substrate subscribes to these, and a new reference is
    // a React render on the pan/zoom path (the transient discipline).
    const tileSig = tiles.map((tile) => `${tile.id}:${tile.status}:${tile.kind}:${Math.round(tile.x)},${Math.round(tile.y)}:${tile.priors}:${tile.canonical?.id ?? ''}:${tile.previewPath ?? ''}:${tile.prompt.length}`).join('|')
    const edgeSig = edges.map((edge) => edge.id).join('|')
    const linksSig = Object.entries(links).map(([chainId, jobId]) => `${chainId}=${jobId}`).join('|')
    if (tileSig === viewSigs.tiles && edgeSig === viewSigs.edges && linksSig === viewSigs.links) return
    viewSigs = { tiles: tileSig, edges: edgeSig, links: linksSig }
    set({ tiles, edges, chainJobs: links })
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

  /** The active document (or null) — the one every chain action targets. */
  const activeDocument = () => {
    const state = get()
    return state.activeProjectId ? state.documents[state.activeProjectId] ?? null : null
  }

  /** Completed jobs that have not landed a take on their chain yet → append
   *  output + take (canonical auto-pointed, blob registered server-side).
   *  Idempotent by the take's jobId; re-entrancy-guarded so overlapping jobs
   *  notifications cannot double-append. Cancelled jobs unlink. */
  let landingInFlight = false
  const landCompletions = async () => {
    if (landingInFlight) return
    const state = get()
    const doc = activeDocument()
    if (!doc) return
    const jobs = useJobsStore.getState().jobs
    const landed = new Set(doc.chains.flatMap((chain) => chain.outputs.flatMap((output) => output.takes.map((take) => take.jobId))))
    const pending: Array<{ chainId: string; job: GenerationJob }> = []
    for (const [chainId, jobId] of Object.entries(state.chainJobs)) {
      const job = jobs.find((entry) => entry.id === jobId)
      if (!job) continue
      if (job.status === 'cancelled') {
        set((current) => { const links = { ...current.chainJobs }; delete links[chainId]; return { chainJobs: links } })
        continue
      }
      if (job.status === 'completed' && !landed.has(jobId) && job.localOutputPath) pending.push({ chainId, job })
    }
    if (!pending.length) return
    landingInFlight = true
    try {
      for (const { chainId, job } of pending) {
        const chain = doc.chains.find((entry) => entry.id === chainId)
        if (!chain || !job.localOutputPath) continue
        try {
          let outputId = chain.outputs[0]?.id ?? null
          if (!outputId) {
            const output = await documentsApi.createOutput({ chainId, substrates: ['decoded'] })
            outputId = output.id
          }
          await documentsApi.appendTake({
            outputId,
            jobId: job.id,
            artifacts: [job.localOutputPath],
            metrics: {
              kind: job.mediaType ?? 'video',
              duration: job.duration,
              width: job.width,
              height: job.height,
              sourcePath: job.localOutputPath,
              outputUrl: job.outputUrl ?? null,
            },
          })
          get().toast('success', `The render landed on “${chainPromptOf(chain)}”.`)
        } catch (error) {
          get().toast('error', `The finished render could not land on its object: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const refreshed = await loadDocument(doc.project.id)
      if (refreshed) recomputeTiles()
    } finally {
      landingInFlight = false
    }
  }

  const chainPromptOf = (chain: { id: string; settings: Record<string, unknown>; inputSpec: Record<string, unknown> }): string => {
    const fresh = chain.inputSpec && typeof chain.inputSpec.fresh === 'object' ? (chain.inputSpec.fresh as Record<string, unknown>) : null
    if (fresh && typeof fresh.prompt === 'string' && fresh.prompt) return fresh.prompt.slice(0, 40)
    return typeof chain.settings.prompt === 'string' && chain.settings.prompt ? chain.settings.prompt.slice(0, 40) : chain.id.slice(0, 8)
  }

  /** Everything a chain submit needs, resolved once: settings (tolerant read),
   *  output index, reference bindings, first/last media. */
  const chainRenderContext = (chainId: string) => {
    const doc = activeDocument()
    if (!doc) return null
    const chain = doc.chains.find((entry) => entry.id === chainId)
    if (!chain) return null
    const settings = readChainSettings(chain.settings, useSessionStore.getState().settings)
    const outputs = buildOutputIndex(doc)
    const resolveMedia = (outputId: string) => mediaForOutput(outputs.get(outputId))
    const bindings = resolveChainReferences(settings, get().libraries, resolveMedia)
    const firstFrame = settings.firstFrameOutputId ? mediaForOutput(outputs.get(settings.firstFrameOutputId))?.media ?? null : null
    const lastFrame = settings.lastFrameOutputId ? mediaForOutput(outputs.get(settings.lastFrameOutputId))?.media ?? null : null
    // Reference media split by kind the way the render slots expect: images
    // compose into the ordered <Picture N> bindings; videos/audios ride the
    // LoadVideo/LoadAudio slots (never a picture slot).
    const referenceMedia = settings.referenceOutputIds
      .map((outputId) => mediaForOutput(outputs.get(outputId))?.media ?? null)
      .filter((media): media is NonNullable<typeof media> => Boolean(media) && (media as MediaFile).kind === 'image') as MediaFile[]
    const referenceVideos = settings.referenceOutputIds
      .map((outputId) => mediaForOutput(outputs.get(outputId))?.media ?? null)
      .filter((media): media is NonNullable<typeof media> => Boolean(media) && (media as MediaFile).kind === 'video') as MediaFile[]
    const referenceAudios = settings.referenceOutputIds
      .map((outputId) => mediaForOutput(outputs.get(outputId))?.media ?? null)
      .filter((media): media is NonNullable<typeof media> => Boolean(media) && (media as MediaFile).kind === 'audio') as MediaFile[]
    return { doc, chain, settings, outputs, bindings, firstFrame, lastFrame, referenceMedia, referenceVideos, referenceAudios }
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
    selection: { tileIds: [] },
    libraries: emptyLibraries,
    engine: { connected: false, modelReady: false },
    chainJobs: {},
    dismissedFailures: [],
    droppedPreviews: {},
    toasts: [],
    inspectorOpen: false,
    indexOpen: false,
    endpointMenu: null,
    forkMenu: null,
    cameraCommands: [],
    cameraCommandSeq: 0,
    viewDirty: false,

    boot: async () => {
      get().refreshLibraries()
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

    refreshLibraries: () => {
      set({
        libraries: {
          characters: loadCharacterProjects(),
          wardrobes: loadWardrobeProjects(),
          locations: loadLocationProjects(),
        },
      })
    },

    openProject: async (id, options) => {
      const state = get()
      if (state.activeProjectId === id) return
      const doc = state.documents[id] ?? (await loadDocument(id))
      if (!doc) return
      const openProjects = [id, ...state.openProjects.filter((openId) => openId !== id)].slice(0, 8)
      const view = parseViewBlob(doc.project.camera)
      set({ activeProjectId: id, openProjects, layout: view.layout, selection: { tileIds: [] } })
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
          set({ layout: undefined, tiles: [], edges: [], selection: { tileIds: [] } })
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
        const anchor = viewport
          ? seedSpawnPoint(camera.get(), viewport.clientWidth, viewport.clientHeight)
          : { x: 120, y: 96 }
        const spawn = avoidOverlap(anchor, get().tiles.map((tile) => ({ x: tile.x, y: tile.y, w: tile.w, h: tile.h })))
        const defaults = chainSettingsDefaults(useSessionStore.getState().settings)
        const chain = await documentsApi.createChain({
          projectId,
          kind: 'generation',
          inputSpec: { fresh: { prompt, mediaKind: mediaType } },
          settings: { ...defaults, prompt, mediaType },
        })
        // Spatial-queue contract c: the seed tile spawns at the prompt bar.
        // Pin the placement so later re-derivations keep it there.
        const chainId = chain?.id ?? `pending:${toastSeq++}`
        set((current) => ({
          layout: { ...(current.layout ?? {}), [chainId]: { x: spawn.x, y: spawn.y, w: TILE_W } },
          viewDirty: true,
        }))
        const refreshed = await loadDocument(projectId)
        if (refreshed) recomputeTiles()
        set({ selection: { tileIds: [chainId] }, inspectorOpen: true, endpointMenu: null, forkMenu: null })
        get().requestCamera({ kind: 'fly', tileId: chainId })
        get().persistView()
        // Phase 2: the REAL submission — validation-refused states stay honest
        // (no job parks in the queue when the engine refuses).
        await get().submitChain(chainId)
      } catch (error) {
        get().toast('error', `Could not create the seed object: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    submitChain: async (chainId) => {
      const context = chainRenderContext(chainId)
      const projectId = get().activeProjectId
      if (!context || !projectId) return { ok: false, message: 'The chain is not on an open canvas.' }
      const { settings, bindings, firstFrame, lastFrame, referenceMedia, referenceVideos, referenceAudios } = context
      const selection = selectionFor(settings.turbo, settings.turboFamily)
      const facts = engineFacts()
      if (!facts.settings) return { ok: false, message: 'Studio settings are still loading.' }
      const request = buildCanvasRenderRequest(settings, { firstFrame, lastFrame, referenceImages: referenceMedia, referenceVideos, referenceAudios }, bindings)
      const result = await submitH3Render(
        { ...request, manifestExtra: { canvas: { chainId, projectId } } },
        {
          settings: facts.settings,
          connected: facts.connected,
          modelReady: modelReadyFor(selection, settings.turbo),
          selection,
          models: facts.models,
          info: facts.info,
          clientId: engineBridge.clientId,
          h3PreviewOverrideNode: findH3PreviewOverrideNode(facts.info) || undefined,
        },
        {
          notify: (tone, text) => get().toast(tone === 'neutral' ? 'neutral' : tone, text),
          setJobs: (update) => useJobsStore.getState().setJobs(update),
          cancellationRequests: engineBridge.cancellationRequests ?? { current: new Set<string>() },
          // Link the moment the job record exists, so the queued ring parks on
          // its chain during upload too.
          onJobCreated: (jobId) => {
            set((current) => ({ chainJobs: { ...current.chainJobs, [chainId]: jobId } }))
            recomputeTiles()
          },
        },
      )
      // Settings-stable reruns (invariant 1): the chain's seed stays exactly
      // as recorded — a rerun reproduces, and no post-run settings write ever
      // marks downstream forks stale (the manifest carries the per-render
      // seed for provenance).
      return result.ok ? { ok: true } : { ok: false, message: result.message }
    },

    validateChain: (chainId) => {
      const context = chainRenderContext(chainId)
      if (!context) return 'The chain is not on an open canvas.'
      const { settings, bindings, firstFrame, lastFrame, referenceMedia, referenceVideos, referenceAudios } = context
      const selection = selectionFor(settings.turbo, settings.turboFamily)
      const facts = engineFacts()
      const request = buildCanvasRenderRequest(settings, { firstFrame, lastFrame, referenceImages: referenceMedia, referenceVideos, referenceAudios }, bindings)
      return validateH3Render(request, {
        connected: facts.connected,
        modelReady: facts.settings ? modelReadyFor(selection, settings.turbo) : false,
        selection,
        h3PreviewOverrideNode: findH3PreviewOverrideNode(facts.info) || undefined,
      })
    },

    ingestFile: async (file) => {
      const state = get()
      let projectId = state.activeProjectId
      if (!projectId) {
        const created = await get().createCanvas()
        if (!created) return
        projectId = created
      }
      try {
        // bytes → base64 (chunked: a multi-hundred-MB read must not build one
        // giant String through apply).
        let binary = ''
        const bytes = new Uint8Array(file.bytes)
        const chunk = 0x8000
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
        }
        const dataBase64 = btoa(binary)
        const ingested = await documentsApi.ingestBlob({ dataBase64, name: file.name, kind: file.kind })
        const viewport = globalThis.document.querySelector<HTMLElement>('.canvas-viewport')
        const anchor = viewport
          ? seedSpawnPoint(camera.get(), viewport.clientWidth, viewport.clientHeight)
          : { x: 120, y: 96 }
        const spawn = avoidOverlap(anchor, get().tiles.map((tile) => ({ x: tile.x, y: tile.y, w: tile.w, h: tile.h })))
        const chain = await documentsApi.createChain({
          projectId,
          kind: 'media',
          inputSpec: { fresh: { media: { name: file.name, kind: file.kind, path: ingested.path, blobPath: ingested.blob.relPath } } },
          settings: { name: file.name, mediaType: file.kind },
        })
        const chainId = chain?.id ?? `pending:${toastSeq++}`
        const output = await documentsApi.createOutput({ chainId, substrates: ['decoded'] })
        await documentsApi.appendTake({
          outputId: output.id,
          artifacts: [ingested.path],
          metrics: { kind: file.kind, name: file.name, sourcePath: ingested.path, blobPath: ingested.blob.relPath },
        })
        set((current) => ({
          layout: { ...(current.layout ?? {}), [chainId]: { x: spawn.x, y: spawn.y, w: TILE_W } },
          droppedPreviews: file.previewUrl ? { ...current.droppedPreviews, [chainId]: file.previewUrl } : current.droppedPreviews,
          viewDirty: true,
        }))
        const refreshed = await loadDocument(projectId)
        if (refreshed) recomputeTiles()
        set({ selection: { tileIds: [chainId] }, inspectorOpen: true })
        get().requestCamera({ kind: 'fly', tileId: chainId })
        get().persistView()
        get().toast('neutral', `${file.name} landed as ${file.kind === 'image' ? 'an' : 'a'} ${file.kind} object — stored and hashed.`)
      } catch (error) {
        get().toast('error', `The dropped file could not land on the canvas: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    recompute: () => {
      recomputeTiles()
      void landCompletions()
    },

    select: (tileId, options) => {
      if (!tileId) {
        set({ selection: { tileIds: [] } })
        return
      }
      set((state) => {
        const current = state.selection.tileIds
        const tileIds = options?.toggle
          ? current.includes(tileId) ? current.filter((id) => id !== tileId) : [...current, tileId]
          : [tileId]
        return { selection: { tileIds }, inspectorOpen: tileIds.length === 1 ? true : state.inspectorOpen }
      })
    },

    setChainSettings: async (chainId, patch) => {
      const doc = activeDocument()
      const chain = doc?.chains.find((entry) => entry.id === chainId)
      if (!chain) return
      const current = readChainSettings(chain.settings, useSessionStore.getState().settings)
      const next = { ...current, ...patch }
      // A no-op edit never writes, never reloads, never marks forks stale.
      if (JSON.stringify(current) === JSON.stringify(next)) return
      try {
        await documentsApi.updateChain({ id: chainId, settings: next as unknown as Record<string, unknown> })
        const refreshed = await loadDocument(doc!.project.id)
        if (refreshed) recomputeTiles()
      } catch (error) {
        get().toast('error', `The chain setting could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    setChainIdentity: async (chainId, patch) => {
      const doc = activeDocument()
      const chain = doc?.chains.find((entry) => entry.id === chainId)
      if (chain) {
        const nextSubject = patch.subjectText ?? chain.identity?.subjectText ?? ''
        const nextStrength = patch.strength ?? chain.identity?.strength ?? 1
        if ((chain.identity?.subjectText ?? '') === nextSubject && Math.abs((chain.identity?.strength ?? 1) - nextStrength) < 1e-9) return // no-op: never write an empty identity row for a mere selection
      }
      try {
        await documentsApi.upsertIdentity({ chainId, ...patch })
        const doc = activeDocument()
        if (doc) {
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
        }
      } catch (error) {
        get().toast('error', `The identity payload could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    runEndpointAction: async (chainId, direction, option, sourceChainId) => {
      const doc = activeDocument()
      if (!doc) return
      set({ endpointMenu: null })
      const action = option.action
      if (action.kind === 'set-first-frame' || action.kind === 'set-last-frame' || action.kind === 'add-reference') {
        // Consume-from: the chain consumes the SELECTED source's canonical output.
        if (!sourceChainId || sourceChainId === chainId) {
          get().toast('neutral', 'Select the object to consume from first, then open this chain’s input menu.')
          return
        }
        const sourceOutput = doc.chains.find((entry) => entry.id === sourceChainId)?.outputs[0]?.id ?? null
        if (!sourceOutput) {
          get().toast('error', 'That object has no output to consume yet.')
          return
        }
        if (action.kind === 'set-first-frame') {
          await get().setChainSettings(chainId, { firstFrameOutputId: sourceOutput, lastFrameOutputId: null, referenceOutputIds: [] })
          get().toast('success', `First frame set — ${MODE_LABEL[effectiveMode(readChainSettings(doc.chains.find((entry) => entry.id === chainId)!.settings))]} ready.`)
        } else if (action.kind === 'set-last-frame') {
          await get().setChainSettings(chainId, { lastFrameOutputId: sourceOutput })
          get().toast('success', 'Last frame set — first + last frame mode ready once a first frame is chosen.')
        } else {
          const chain = doc.chains.find((entry) => entry.id === chainId)
          const settings = readChainSettings(chain?.settings ?? {})
          if (settings.referenceOutputIds.length >= 9) {
            get().toast('error', 'Reference limit reached: 9 pictures.')
            return
          }
          await get().setChainSettings(chainId, { referenceOutputIds: [...settings.referenceOutputIds, sourceOutput] })
          get().toast('success', `Reference added (${settings.referenceOutputIds.length + 1} of 9).`)
        }
        return
      }
      if (action.kind === 'generate') {
        // Produce-into: a NEW chain from this tile's output, roles preset by mode.
        try {
          const sourceChain = doc.chains.find((entry) => entry.id === chainId)
          const sourceOutput = sourceChain?.outputs[0]?.id ?? null
          if (!sourceOutput) {
            get().toast('error', 'That object has no output yet — generate or drop media first.')
            return
          }
          const sourceSettings = readChainSettings(sourceChain?.settings ?? {})
          const media = mediaForOutput(buildOutputIndex(doc).get(sourceOutput))
          const mode = media && media.media.kind === 'image' && action.mode === 'image' ? 'image' : action.mode === 'frames' ? 'frames' : 'reference'
          const settings: Partial<CanvasChainSettings> = {
            ...chainSettingsDefaults(useSessionStore.getState().settings),
            prompt: sourceSettings.prompt,
            referenceOutputIds: mode === 'reference' ? [sourceOutput] : [],
            firstFrameOutputId: mode === 'image' || mode === 'frames' ? sourceOutput : null,
          }
          const chain = await documentsApi.createChain({ projectId: doc.project.id, kind: 'generation', settings: settings as unknown as Record<string, unknown> })
          set({ viewDirty: true })
          // L25: adjacency-near-parent — pin next to the source tile.
          const sourceTile = get().tiles.find((tile) => tile.id === chainId)
          const place = sourceTile ? { x: sourceTile.x + TILE_W + 140, y: sourceTile.y, w: TILE_W } : { x: 120, y: 96, w: TILE_W }
          set((current) => ({ layout: { ...(current.layout ?? {}), [chain.id]: place } }))
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
          set({ selection: { tileIds: [chain.id] }, inspectorOpen: true })
          get().requestCamera({ kind: 'fly', tileId: chain.id })
          get().persistView()
        } catch (error) {
          get().toast('error', `The chain could not be created: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      if (action.kind === 'fork') {
        const sourceChain = doc.chains.find((entry) => entry.id === chainId)
        const outputId = sourceChain?.outputs[0]?.id ?? null
        if (!outputId) {
          get().toast('error', 'That object has no output to fork yet.')
          return
        }
        await get().fork({ chainId, outputId, substrate: action.substrate })
        return
      }
      if (action.kind === 'utility') {
        get().toast('neutral', `The LTX-2.3 ${action.tool} utility lands on canvas with the Phase-3 op stacks — today it runs from Settings → Utilities.`)
      }
    },

    fork: async (source) => {
      const doc = activeDocument()
      if (!doc) return
      set({ forkMenu: null })
      const outputs = buildOutputIndex(doc)
      const entry = outputs.get(source.outputId)
      const settings = readChainSettings(entry?.chain.settings ?? {})
      try {
        const substrate: ForkSubstrate = source.substrate
        let firstFrameOutputId: string | null = null
        let referenceOutputIds: string[] = []
        let extracted: { path: string; frameIndex: number } | null = null
        if (substrate === 'extracted-frame') {
          // The extraction is a real side effect: server-side ffmpeg over the
          // output-contained source. The frame becomes its own media object;
          // the fork references the FRAME's output (edge = what it consumes),
          // with extraction provenance recorded in the input ref.
          const media = mediaForOutput(entry, source.takeId)
          const session = useSessionStore.getState()
          if (!media || !session.settings) throw new Error('The source media is not extractable.')
          const frameIndex = 0
          const extractedFile = await window.minimax.extractVideoFrame(media.media.path, frameIndex, session.settings.outputDirectory, session.settings.ffmpegPath)
          const frameChain = await documentsApi.createChain({
            projectId: doc.project.id,
            kind: 'media',
            inputSpec: { fresh: { media: { name: extractedFile.name, kind: 'image', path: extractedFile.path } } },
            settings: { name: extractedFile.name, mediaType: 'image' },
          })
          const frameOutput = await documentsApi.createOutput({ chainId: frameChain.id, substrates: ['decoded'] })
          await documentsApi.appendTake({
            outputId: frameOutput.id,
            artifacts: [extractedFile.path],
            metrics: { kind: 'image', name: extractedFile.name, sourcePath: extractedFile.path },
          })
          firstFrameOutputId = frameOutput.id
          extracted = { path: extractedFile.path, frameIndex }
        } else if (substrate === 'decoded') {
          const media = mediaForOutput(entry, source.takeId)
          if (media && media.media.kind === 'image') firstFrameOutputId = source.outputId
          else referenceOutputIds = [source.outputId]
        }
        // latents forks record the substrate honestly; latent continuation
        // renders arrive with the Motion-Context chains (Phase 3).
        const inputSpec = forkInputSpec({
          outputId: source.outputId,
          takeId: source.takeId ?? null,
          substrate,
          extractedPath: extracted?.path ?? null,
          frameIndex: extracted?.frameIndex ?? null,
        })
        const fork = await documentsApi.createChain({
          projectId: doc.project.id,
          kind: 'generation',
          inputSpec,
          settings: {
            ...chainSettingsDefaults(useSessionStore.getState().settings),
            prompt: settings.prompt,
            firstFrameOutputId,
            referenceOutputIds,
          } as unknown as Record<string, unknown>,
        })
        set((current) => ({ layout: { ...(current.layout ?? {}), [fork.id]: { x: 0, y: 0, w: TILE_W } }, viewDirty: true }))
        const sourceTile = get().tiles.find((tile) => tile.id === source.chainId)
        if (sourceTile) set((current) => ({ layout: { ...(current.layout ?? {}), [fork.id]: { x: sourceTile.x + TILE_W + 140, y: sourceTile.y + 96, w: TILE_W } } }))
        const refreshed = await loadDocument(doc.project.id)
        if (refreshed) recomputeTiles()
        set({ selection: { tileIds: [fork.id] }, inspectorOpen: true })
        get().requestCamera({ kind: 'fly', tileId: fork.id })
        get().persistView()
        get().toast('success', 'Forked — the source is untouched; the new chain carries its own settings.')
      } catch (error) {
        get().toast('error', `The fork could not be created: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    setEndpointMenu: (menu) => set({ endpointMenu: menu, forkMenu: null }),
    setForkMenu: (menu) => set({ forkMenu: menu, endpointMenu: null }),

    rerunStale: async () => {
      const state = get()
      const stale = state.tiles.filter((tile) => tile.stale || tile.status === 'stale')
      if (!stale.length) {
        get().toast('neutral', 'Nothing is stale — every chain is current.')
        return
      }
      for (const tile of stale) await get().submitChain(tile.id)
    },

    cancelChainJob: async (chainId) => {
      const jobId = get().chainJobs[chainId]
      const job = useJobsStore.getState().jobs.find((entry) => entry.id === jobId)
      if (!job) return
      engineBridge.cancelJob?.(job)
    },

    dismissFailure: (tileId) => {
      set((state) => ({ dismissedFailures: state.dismissedFailures.includes(tileId) ? state.dismissedFailures : [...state.dismissedFailures, tileId] }))
      recomputeTiles()
    },

    setInspectorOpen: (open) => set({ inspectorOpen: open }),
    setIndexOpen: (open) => set({ indexOpen: open }),
    setEngineFacts: (facts) => set({ engine: facts }),

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

    optionAvailability: () => {
      const facts = engineFacts()
      const utilities = [
        'remove-subtitles', 'remove-watermark', 'restore-archival', 'remove-object', 'outpaint', 'ia2v',
      ].map((tool) => {
        const utility = findLtx23Utility(`ltx23.${tool}`)
        if (!utility) return { tool, label: tool, available: false, missing: ['unknown utility'] }
        const detection = utility.detect(facts.info, facts.models)
        return {
          tool,
          label: utility.label,
          available: Boolean(facts.connected && detection.available),
          missing: [...detection.missingNodes.map((node) => `node ${node}`), ...detection.missingModels],
          installHint: utility.ui.installHint,
        }
      })
      const selection = selectionFor('off', '')
      return {
        connected: facts.connected,
        h3Ready: modelReadyFor(selection, 'off'),
        utilities,
      }
    },

    chainBindings: (chainId) => {
      const context = chainRenderContext(chainId)
      return context ? context.bindings : []
    },
  }
})

/** Selector helper: radar aggregates over the derived tiles (§4). */
export const selectAttention = (state: CanvasState) => attention(state.tiles)

// ---- gated test surface (?probe=canvas) -------------------------------------
// Same precedent as transientProbe: shipped but inert in every normal
// session; drives the REAL store paths (a job event arriving) so the e2e
// suite can exercise queue/completion contracts without an engine.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('probe') === 'canvas') {
  Object.defineProperty(window, '__canvasScenario', {
    configurable: true,
    value: (name: string) => {
      const state = useCanvasStore.getState()
      if (name === 'fail-worst') {
        // Flip the first linked canvas job to failed — the exact store
        // transition a real failure event makes (contract a: durable on the
        // object until dismissed, reason attached).
        const entry = Object.entries(state.chainJobs)[0]
        if (!entry) return { ok: false, reason: 'no linked job' }
        const [chainId, jobId] = entry
        useJobsStore.getState().setJobs((jobs) => jobs.map((job) => job.id === jobId ? { ...job, status: 'failed', error: 'engine exploded (scenario)' } : job))
        state.recompute()
        return { ok: true, chainId, jobId }
      }
      if (name === 'seed-mock') {
        // Park an honest mock queued job on the first seed chain (the Phase-1
        // seam preserved for queue-state scenarios; real submits validate).
        const tile = state.tiles.find((entry) => entry.kind === 'seed' && !entry.jobId)
        if (!tile) return { ok: false, reason: 'no unlinked seed chain' }
        const jobId = `${CANVAS_MOCK_JOB_PREFIX}${tile.id}`
        useCanvasStore.setState((current) => ({ chainJobs: { ...current.chainJobs, [tile.id]: jobId } }))
        useJobsStore.getState().setJobs((jobs) => [...jobs.filter((job) => job.id !== jobId), {
          id: jobId, mode: 'text', prompt: tile.prompt, createdAt: Date.now(), status: 'queued', progress: 0,
          width: 1344, height: 768, duration: 6, provider: 'minimax', mediaType: 'video', manifest: { canvasPhase2Mock: true },
        }])
        useCanvasStore.getState().recompute()
        return { ok: true, chainId: tile.id, jobId }
      }
      if (name === 'complete-mock') {
        // Complete the first linked job using the first media take's real
        // stored source — exercises the REAL completion landing path.
        const entry = Object.entries(state.chainJobs)[0]
        if (!entry) return { ok: false, reason: 'no linked job' }
        const mediaTile = state.tiles.find((tile) => tile.kind === 'media' && tile.previewPath)
        if (!mediaTile) return { ok: false, reason: 'no media take to land' }
        const [, jobId] = entry
        const metrics = mediaTile.canonical?.metrics ?? {}
        const sourcePath = mediaTile.previewPath ?? ''
        if (!sourcePath) return { ok: false, reason: 'no stored source path' }
        useJobsStore.getState().setJobs((jobs) => jobs.map((job) => job.id === jobId ? {
          ...job, status: 'completed', progress: 100, localOutputPath: sourcePath, outputUrl: typeof metrics.outputUrl === 'string' ? metrics.outputUrl : undefined,
        } : job))
        useCanvasStore.getState().recompute()
        return { ok: true, jobId, source: mediaTile.previewPath }
      }
      if (name === 'stale-worst') {
        const tile = state.tiles.find((entry) => entry.status === 'stale') ?? state.tiles[0]
        if (!tile) return { ok: false, reason: 'no tile' }
        return { ok: true, tileId: tile.id }
      }
      return { ok: false, reason: `unknown scenario ${name}` }
    },
  })

  /** Engine-free submit-plan probe: maps a selection spec through the REAL
   *  builder + graph construction and returns the built graph's facts plus
   *  the honest validation against the live session (offline → the real
   *  refusal string). This is what the e2e suite asserts per mode. */
  Object.defineProperty(window, '__canvasSubmitPlan', {
    configurable: true,
    value: (spec: {
      prompt?: string
      firstFrameOutputId?: string | null
      lastFrameOutputId?: string | null
      referenceOutputIds?: string[]
      referenceCharacterIds?: string[]
      turbo?: 'off' | '4' | '8'
      duration?: number
      resolution?: string
    }) => {
      const settings = {
        ...chainSettingsDefaults(useSessionStore.getState().settings),
        prompt: spec.prompt ?? 'a lone drummer on a night train',
        firstFrameOutputId: spec.firstFrameOutputId ?? null,
        lastFrameOutputId: spec.lastFrameOutputId ?? null,
        referenceOutputIds: spec.referenceOutputIds ?? [],
        referenceCharacterIds: spec.referenceCharacterIds ?? [],
        turbo: spec.turbo ?? 'off',
        duration: spec.duration ?? 6,
        resolution: spec.resolution ?? '1344x768',
      }
      const snapshot = useCanvasStore.getState()
      const doc = snapshot.activeProjectId ? snapshot.documents[snapshot.activeProjectId] : null
      const outputs = doc ? buildOutputIndex(doc) : new Map()
      const resolveMedia = (outputId: string) => mediaForOutput(outputs.get(outputId))
      const bindings = resolveChainReferences(settings, snapshot.libraries, resolveMedia)
      const firstFrame = settings.firstFrameOutputId ? resolveMedia(settings.firstFrameOutputId)?.media ?? null : null
      const lastFrame = settings.lastFrameOutputId ? resolveMedia(settings.lastFrameOutputId)?.media ?? null : null
      const referenceMedia = settings.referenceOutputIds.map((outputId) => resolveMedia(outputId)?.media ?? null).filter(Boolean)
      const request = buildCanvasRenderRequest(settings, { firstFrame, lastFrame, referenceImages: referenceMedia as MediaFile[], referenceVideos: [], referenceAudios: [] }, bindings)
      const facts = engineFacts()
      const selection = selectionFor(settings.turbo, settings.turboFamily)
      const validation = validateH3Render(request, {
        connected: facts.connected,
        modelReady: facts.settings ? modelReadyFor(selection, settings.turbo) : false,
        selection,
        h3PreviewOverrideNode: findH3PreviewOverrideNode(facts.info) || undefined,
      })
      // The graph builds regardless of the engine — construction is pure.
      const fakeSelection: ModelSelection = {
        fl2va: 'TEST-fl2va.safetensors', ref2va: 'TEST-ref2va.safetensors', textEncoder: 'TEST-qwen3vl.safetensors',
        videoVae: 'TEST-video-vae.safetensors', audioVae: 'TEST-audio-vae.safetensors', previewVae: '',
        fl2vLora: settings.turbo === 'off' ? '' : 'TEST-fl2v-turbo.safetensors', ref2vLora: 'TEST-ref2v-turbo.safetensors',
      }
      const graph = planCanvasGraph(request, fakeSelection, {
        first: request.firstFrame?.name || (request.firstFrame ? 'plan-first' : undefined),
        last: request.lastFrame?.name || (request.lastFrame ? 'plan-last' : undefined),
        images: request.referenceImages.map((item, index) => item.name || `plan-ref-${index + 1}`),
      })
      const nodes = Object.values(graph)
      return {
        mode: request.mode,
        validation,
        width: request.width,
        height: request.height,
        duration: request.duration,
        referenceImageCount: request.referenceImages.length,
        hasFirstFrame: Boolean(request.firstFrame),
        hasLastFrame: Boolean(request.lastFrame),
        graph: {
          nodeClasses: nodes.map((node) => node.class_type),
          unetModel: nodes.find((node) => node.class_type === 'UNETLoader')?.inputs.unet_name ?? null,
          loadImageCount: nodes.filter((node) => node.class_type === 'LoadImage').length,
          loadAudioCount: nodes.filter((node) => node.class_type === 'LoadAudio').length,
          loraLoaderCount: nodes.filter((node) => node.class_type.includes('LoraLoader') || node.class_type.includes('TurboLoRA')).length,
          total: nodes.length,
        },
      }
    },
  })
}
