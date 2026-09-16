/**
 * Canvas Phase 3 — the canvas session store.
 *
 * Everything the route renders except the camera: the open-project session,
 * loaded documents, derived tiles/edges, selection (single + batch), the
 * launcher, library bindings, the endpoint/fork menus, toasts — and, since
 * Phase 2, GENERATION: chains submit REAL H3 renders through the shared
 * flows core (lib/h3Submit.ts) with per-chain settings unwound from the old
 * workspace singleton, completed jobs land as takes on their chains, and
 * dropped bytes ingest into content-addressed blobs. Phase 3 adds the OP
 * STACK surface (§5.1: the modal editor's store actions — add/edit/reorder/
 * bake/undo, canonical-pointer switching, locks), the LTX-2.3 utility
 * invocation through the shared core (lib/ltx23UtilitySubmit.ts), Z-Image
 * stills as an op (lib/zImageSubmit.ts), and the pose-rig dock state.
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
  collectOutputRefs,
  deriveEdges,
  deriveTiles,
  seedSpawnPoint,
  TILE_H_MEDIA,
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
import { DEFAULT_SETTINGS, type OpKind } from './ops'
import type { EndpointDirection, EndpointOption, OptionAvailability } from './options'
import { findH3PreviewOverrideNode } from '../lib/h3Stack'
import { inferSelections } from '../lib/modelSelection'
import { submitH3Render, validateH3Render } from '../lib/h3Submit'
import { submitLtx23Utility, validateLtx23Utility } from '../lib/ltx23UtilitySubmit'
import { submitZImage, validateZImage, planZImageGraph } from '../lib/zImageSubmit'
import { buildLtx23UtilityGraph, findLtx23Utility } from '../lib/graph'
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
  /** Phase 3 (§5.1): the op modal's target chain — L8 DECIDED: modal-only
   *  v1 (no inline chip controls). */
  opEditor: { chainId: string } | null
  /** Phase 3 (§5.2): the pose-rig dock's target chain (control-track export). */
  poseRig: { chainId: string } | null
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
  /** Real submission for one chain (per-chain settings → shared cores; image
   *  intent routes to Z-Image per §5.4 engines-as-ops). */
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
  fork(source: { chainId: string; outputId: string; takeId?: string | null; substrate: ForkSubstrate; withUpscale?: boolean }): Promise<void>
  setEndpointMenu(menu: { chainId: string; direction: EndpointDirection } | null): void
  setForkMenu(menu: { chainId: string } | null): void
  rerunStale(): Promise<void>
  /** One chain's consented re-execution: submit + clear the stale flag. */
  rerunChain(chainId: string): Promise<void>
  cancelChainJob(chainId: string): Promise<void>
  dismissFailure(tileId: string): void
  setInspectorOpen(open: boolean): void
  setIndexOpen(open: boolean): void
  setOpEditor(editor: { chainId: string } | null): void
  setPoseRig(panel: { chainId: string } | null): void
  /** §5.1 op-stack edits — each lands in the document store then recomputes
   *  (the tile's preview LIVE-UPDATES: L3 decided live-update). */
  addStackOp(chainId: string, kind: OpKind, settings?: Record<string, unknown>): Promise<string | null>
  updateStackOp(chainId: string, opId: string, settings: Record<string, unknown>): Promise<void>
  removeStackOp(chainId: string, opId: string): Promise<void>
  reorderStackOps(chainId: string, orderedIds: string[]): Promise<void>
  bakeStackOp(chainId: string, opId: string): Promise<void>
  /** Canonical-pointer switch on the take strip (F5/takes): the chosen take
   *  becomes canonical; the displaced one becomes a prior; downstream forks
   *  of this chain go stale (locks gate — locked chains stay pristine). */
  switchCanonical(chainId: string, takeId: string): Promise<void>
  /** §7 P — pin (lock/unlock) a chain: locked chains gate propagation and
   *  keep ALL takes resident (tier 1). */
  setChainLock(chainId: string, locked: boolean): Promise<void>
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
    // a React render on the pan/zoom path (the transient discipline). Op
    // edits join the signature (Phase 3): a settings/bake change IS a
    // live-update signal for the tile preview.
    const tileSig = tiles.map((tile) => `${tile.id}:${tile.status}:${tile.kind}:${Math.round(tile.x)},${Math.round(tile.y)}:${tile.priors}:${tile.canonical?.id ?? ''}:${tile.previewPath ?? ''}:${tile.prompt.length}:${tile.lockState}:${tile.stale}:${tile.ops.map((op) => `${op.id}${op.bakedAt ?? ''}${JSON.stringify(op.settings)}`).join(',')}`).join('|')
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
    opEditor: null,
    poseRig: null,
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
      // §5.4 engines-as-ops (Phase 3): image INTENT routes the still surface —
      // nothing-selected = a Z-Image Turbo still; a selected image = the Fun
      // ControlNet Union graph over that image (the zImageControlnet
      // machinery). Selection still decides the surface (L4), extended to the
      // image engine; frames/reference modes remain H3 video concepts.
      const stillIntent = settings.mediaType === 'image' && (effectiveMode(settings) === 'text' || effectiveMode(settings) === 'image')
      if (stillIntent) {
        const mode = effectiveMode(settings)
        const facts = engineFacts()
        if (!facts.settings) return { ok: false, message: 'Studio settings are still loading.' }
        const result = await submitZImage(
          {
            prompt: settings.prompt,
            seed: settings.seed,
            width: Number(settings.resolution.split('x')[0]) || 1344,
            height: Number(settings.resolution.split('x')[1]) || 768,
            surface: mode === 'image' ? 'control' : 'plain',
            controlImage: mode === 'image' ? firstFrame : null,
            controlMode: 'canny',
            filenamePrefix: `MiniMax_first_frames/Canvas_ZImage_${Date.now()}`,
            manifestExtra: { canvas: { chainId, projectId } },
          },
          { settings: facts.settings, connected: facts.connected, info: facts.info },
          {
            notify: (tone, text) => get().toast(tone === 'neutral' ? 'neutral' : tone, text),
            setJobs: (update) => useJobsStore.getState().setJobs(update),
            onJobCreated: (jobId) => {
              set((current) => ({ chainJobs: { ...current.chainJobs, [chainId]: jobId } }))
              recomputeTiles()
            },
          },
        )
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      }
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
      // The still surface (§5.4) validates through its own ladder.
      if (settings.mediaType === 'image' && (effectiveMode(settings) === 'text' || effectiveMode(settings) === 'image')) {
        const facts = engineFacts()
        return validateZImage(
          {
            prompt: settings.prompt, seed: settings.seed, width: 1344, height: 768,
            surface: effectiveMode(settings) === 'image' ? 'control' : 'plain',
            controlImage: effectiveMode(settings) === 'image' ? firstFrame : null,
            controlMode: 'canny',
          },
          { connected: facts.connected, info: facts.info },
        )
      }
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
        // §5.4 engines-as-ops (Phase 3): a REAL utility run — a new chain
        // consuming this tile's output (the edge is what it consumes), the
        // official-template graph through the SHARED core (the Settings
        // utilities and this surface submit through one code path), the job
        // linked to the chain so the result lands as its take.
        const sourceChain = doc.chains.find((entry) => entry.id === chainId)
        const outputId = sourceChain?.outputs[0]?.id ?? null
        if (!outputId) {
          get().toast('error', 'That object has no output yet — generate or drop media first.')
          return
        }
        const media = mediaForOutput(buildOutputIndex(doc).get(outputId))
        if (!media) {
          get().toast('error', 'That object’s output has no renderable media to run the utility over.')
          return
        }
        const settings = readChainSettings(sourceChain?.settings ?? {})
        try {
          const utility = findLtx23Utility(`ltx23.${action.tool}`)
          const utilityChain = await documentsApi.createChain({
            projectId: doc.project.id,
            kind: 'generation',
            inputSpec: forkInputSpec({ outputId, takeId: null, substrate: 'decoded' }),
            settings: {
              ...chainSettingsDefaults(useSessionStore.getState().settings),
              prompt: utility?.promptDefault ?? '',
              mediaType: 'video',
            } as unknown as Record<string, unknown>,
          })
          set({ viewDirty: true })
          const sourceTile = get().tiles.find((tile) => tile.id === chainId)
          // Cluster-on-parent (L25), stacked BELOW the fork row so a fork and
          // a utility from the same source never overlap.
          const place = sourceTile ? { x: sourceTile.x + TILE_W + 140, y: sourceTile.y + TILE_H_MEDIA + 60, w: TILE_W } : { x: 120, y: 96, w: TILE_W }
          set((current) => ({ layout: { ...(current.layout ?? {}), [utilityChain.id]: place } }))
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
          set({ selection: { tileIds: [utilityChain.id] }, inspectorOpen: true })
          get().requestCamera({ kind: 'fly', tileId: utilityChain.id })
          get().persistView()
          const facts = engineFacts()
          if (!facts.settings) {
            get().toast('error', 'Studio settings are still loading.')
            return
          }
          const result = await submitLtx23Utility(
            { tool: action.tool as never, video: media.media, prompt: settings.prompt || undefined, manifestExtra: { canvas: { chainId: utilityChain.id, projectId: doc.project.id }, utility: action.tool } },
            { settings: facts.settings, connected: facts.connected, info: facts.info, models: facts.models, clientId: engineBridge.clientId },
            {
              notify: (tone, text) => get().toast(tone === 'neutral' ? 'neutral' : tone, text),
              setJobs: (update) => useJobsStore.getState().setJobs(update),
              onJobCreated: (jobId) => {
                set((current) => ({ chainJobs: { ...current.chainJobs, [utilityChain.id]: jobId } }))
                recomputeTiles()
              },
            },
          )
          if (result.ok) get().toast('success', `The ${utility?.label ?? action.tool} chain is running — the result lands here as its take.`)
        } catch (error) {
          get().toast('error', `The utility chain could not start: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      if (action.kind === 'pose-rig') {
        // §5.2 (Phase 3): the pose rig docks as a floating canvas panel; its
        // export lands as this chain's control track.
        set({ endpointMenu: null, poseRig: { chainId } })
        return
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
        // renders arrive with the Motion-Context chains (the Phase-4 engine
        // seam — the substrate records on the fork today).
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
            // Upscale dual-mode (§5.1): the FORK side records the engine
            // upscale on the new chain (the stack side is the upscale op).
            ...(source.withUpscale ? { upscaleMode: 'ltx' as const } : {}),
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

    rerunChain: async (chainId) => {
      // One chain's consented re-execution: the submit runs, then the stale
      // flag clears (a rerun IS the consent invariant 3 names). Submitting
      // first keeps the honest state if the submit refuses offline — the
      // chain stays visibly stale until a submit actually goes out.
      const result = await get().submitChain(chainId)
      if (result.ok) {
        try {
          await documentsApi.updateChain({ id: chainId, stale: false })
          const doc = activeDocument()
          if (doc) {
            const refreshed = await loadDocument(doc.project.id)
            if (refreshed) recomputeTiles()
          }
        } catch {
          // The rerun went out; the stale flag clearing is retried on the
          // next document write. Ambient — not worth an error toast.
        }
      }
    },

    // ---- §5.1 op-stack edits (the modal editor's store actions) ---------------

    addStackOp: async (chainId, kind, settings) => {
      try {
        // The upscale op rides the EXISTING render path (chain settings carry
        // the mode the H3 request builder reads) — the op is its visible
        // stack entry; both stay in sync through this action + the editor.
        if (kind === 'upscale') {
          const mode = (settings && typeof settings.mode === 'string' ? settings.mode : 'ltx') as CanvasChainSettings['upscaleMode']
          await get().setChainSettings(chainId, { upscaleMode: mode })
        }
        const op = await documentsApi.addOp(chainId, kind, settings ?? DEFAULT_SETTINGS[kind]() as unknown as Record<string, unknown>)
        const doc = activeDocument()
        if (doc) {
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
        }
        return op.id
      } catch (error) {
        get().toast('error', `The op could not be added: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    updateStackOp: async (chainId, opId, settings) => {
      try {
        await documentsApi.updateOpSettings(opId, settings)
        if (typeof settings.mode === 'string' && ['ltx', 'rtx', 'lbh2d', 'lbh3d'].includes(settings.mode)) {
          await get().setChainSettings(chainId, { upscaleMode: settings.mode as CanvasChainSettings['upscaleMode'] })
        }
        const doc = activeDocument()
        if (doc) {
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
        }
      } catch (error) {
        get().toast('error', `The op edit could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    removeStackOp: async (chainId, opId) => {
      try {
        await documentsApi.deleteOp(opId)
        const doc = activeDocument()
        if (doc) {
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
        }
        get().toast('neutral', 'Op undone — the stack re-rendered without it; the source is untouched.')
      } catch (error) {
        get().toast('error', `The op could not be undone: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    reorderStackOps: async (chainId, orderedIds) => {
      try {
        await documentsApi.reorderOps(chainId, orderedIds)
        const doc = activeDocument()
        if (doc) {
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
        }
      } catch (error) {
        get().toast('error', `The stack could not be reordered: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    bakeStackOp: async (chainId, opId) => {
      try {
        await documentsApi.bakeOp(opId)
        const doc = activeDocument()
        if (doc) {
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
        }
        get().toast('neutral', 'Op baked — irreversible by design; the frozen settings are now part of the source’s history.')
      } catch (error) {
        get().toast('error', `The op could not be baked: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    // ---- takes / locks (F5 + L21) ---------------------------------------------

    switchCanonical: async (chainId, takeId) => {
      const doc = activeDocument()
      const chain = doc?.chains.find((entry) => entry.id === chainId)
      const output = chain?.outputs[0]
      if (!doc || !output) return
      if (output.takes.find((take) => take.id === takeId)?.supersededBy == null) return // already canonical: never a write
      let propagationError: string | null = null
      try {
        await documentsApi.supersedeTake({ outputId: output.id, takeId })
        // Stale propagation (invariant 3): downstream forks of this chain
        // consume the output's CANONICAL take — a pointer switch is an
        // upstream change. Locks gate: locked chains stay pristine. A failed
        // per-consumer mark never rolls the pointer back — it surfaces and
        // the next document write retries it.
        const owned = new Set(chain.outputs.map((entry) => entry.id))
        for (const other of doc.chains) {
          if (other.id === chainId || other.lockState === 'locked') continue
          const refs = new Set<string>()
          collectOutputRefs(other.inputSpec, refs)
          if (![...refs].some((outputId) => owned.has(outputId))) continue
          try {
            await documentsApi.updateChain({ id: other.id, stale: true })
          } catch (error) {
            propagationError = error instanceof Error ? error.message : String(error)
          }
        }
        get().toast('success', propagationError
          ? `Canonical take switched — but marking a downstream fork stale failed (${propagationError}). It will mark on the next upstream change.`
          : 'Canonical take switched — the displaced take stays as a prior; nothing was deleted.')
      } catch (error) {
        get().toast('error', `The canonical pointer could not switch: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      // Always re-derive after the pointer moved, whatever propagation did.
      const refreshed = await loadDocument(doc.project.id)
      if (refreshed) recomputeTiles()
    },

    setChainLock: async (chainId, locked) => {
      const doc = activeDocument()
      if (!doc) return
      try {
        await documentsApi.updateChain({ id: chainId, lockState: locked ? 'locked' : 'unlocked' })
        const refreshed = await loadDocument(doc.project.id)
        if (refreshed) recomputeTiles()
        get().toast(locked ? 'success' : 'neutral', locked ? 'Chain locked — propagation is gated; every take stays resident.' : 'Chain unlocked — upstream changes mark it stale again.')
      } catch (error) {
        get().toast('error', `The lock could not change: ${error instanceof Error ? error.message : String(error)}`)
      }
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
    setOpEditor: (editor) => set({ opEditor: editor, endpointMenu: null, forkMenu: null }),
    setPoseRig: (panel) => set({ poseRig: panel, endpointMenu: null }),
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
   *  refusal string). This is what the e2e suite asserts per mode. Phase 3:
   *  a `mediaType: 'image'` spec routes through the Z-Image plan (§5.4
   *  stills) exactly like submitChain does. */
  Object.defineProperty(window, '__canvasSubmitPlan', {
    configurable: true,
    value: (spec: {
      prompt?: string
      mediaType?: 'video' | 'image'
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
        mediaType: spec.mediaType ?? 'video',
        firstFrameOutputId: spec.firstFrameOutputId ?? null,
        lastFrameOutputId: spec.lastFrameOutputId ?? null,
        referenceOutputIds: spec.referenceOutputIds ?? [],
        referenceCharacterIds: spec.referenceCharacterIds ?? [],
        turbo: spec.turbo ?? 'off',
        duration: spec.duration ?? 6,
        resolution: spec.resolution ?? '1344x768',
      }
      // The still surface (§5.4): construction through the Z-Image machinery.
      if (settings.mediaType === 'image' && (effectiveMode(settings) === 'text' || effectiveMode(settings) === 'image')) {
        const facts = engineFacts()
        const snapshot = useCanvasStore.getState()
        const doc = snapshot.activeProjectId ? snapshot.documents[snapshot.activeProjectId] : null
        const outputs = doc ? buildOutputIndex(doc) : new Map()
        const controlImage = settings.firstFrameOutputId ? mediaForOutput(outputs.get(settings.firstFrameOutputId))?.media ?? null : null
        const surface = effectiveMode(settings) === 'image' ? 'control' as const : 'plain' as const
        const validation = validateZImage(
          { prompt: settings.prompt, seed: settings.seed, width: 1344, height: 768, surface, controlImage, controlMode: 'canny' },
          { connected: facts.connected, info: facts.info },
        )
        const fakeZSelection = { model: 'TEST-z_image_turbo.safetensors', encoder: 'TEST-qwen_3_4b.safetensors', vae: 'TEST-ae.safetensors', controlnet: 'TEST-zimage-fun-controlnet-union.safetensors' }
        const graph = planZImageGraph({ prompt: settings.prompt, seed: 1, width: 1344, height: 768, surface, controlImage, controlMode: 'canny' }, fakeZSelection, surface === 'control' ? { controlImage: 'plan-control.png' } : {})
        const nodes = Object.values(graph)
        return {
          mode: surface === 'control' ? 'z-image-control' : 'z-image',
          validation,
          graph: {
            nodeClasses: nodes.map((node) => node.class_type),
            unetModel: nodes.find((node) => node.class_type === 'UNETLoader')?.inputs.unet_name ?? null,
            loadImageCount: nodes.filter((node) => node.class_type === 'LoadImage').length,
            saveNode: nodes.some((node) => node.class_type === 'SaveImage'),
            controlnet: nodes.some((node) => node.class_type === 'QwenImageDiffsynthControlnet'),
            total: nodes.length,
          },
        }
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

  /** Engine-free UTILITY-plan probe (Phase 3, §5.4): the typed-hole → graph
   *  construction seam. Returns the honest availability refusal against the
   *  live engine (offline → detection refuses) AND the official-template
   *  graph facts built through the REAL factory with a fully-resolved TEST
   *  selection — construction never needs an engine. */
  Object.defineProperty(window, '__canvasUtilityPlan', {
    configurable: true,
    value: (tool: string) => {
      const facts = engineFacts()
      const isIa2v = tool === 'ia2v'
      const request = {
        tool: tool as never,
        seed: 1,
        video: isIa2v ? null : { path: '/plan/source.mp4', name: 'source.mp4', kind: 'video' as const },
        image: isIa2v ? { path: '/plan/portrait.png', name: 'portrait.png', kind: 'image' as const } : null,
        audio: isIa2v ? { path: '/plan/voice.wav', name: 'voice.wav', kind: 'audio' as const } : null,
      }
      const validation = validateLtx23Utility(request, { connected: facts.connected, info: facts.info, models: facts.models })
      const utility = findLtx23Utility(`ltx23.${tool}`)
      if (!utility) return { tool, validation, graph: null, refusal: `unknown utility ${tool}` }
      // Every slot the registry requires, resolved to TEST names — the exact
      // contract requireSlots enforces, so the factory builds for real.
      const fakeSelection = Object.fromEntries(utility.modelSlots.map((slot) => [slot, `TEST-${String(slot)}.safetensors`])) as never
      try {
        const graph = buildLtx23UtilityGraph({
          tool: request.tool,
          seed: 1,
          filenamePrefix: 'video/LTX23_plan',
          video: request.video ? { name: 'plan-source.mp4' } : undefined,
          image: request.image ? { name: 'plan-portrait.png' } : undefined,
          audio: request.audio ? { name: 'plan-voice.wav' } : undefined,
        }, fakeSelection)
        const nodes = Object.values(graph)
        const audioSourceClass = Object.values(graph)
          .filter((node) => node.class_type === 'CreateVideo')
          .map((node) => {
            if (!Array.isArray(node.inputs.audio)) return null
            const sourceId = String((node.inputs.audio as [string, number])[0])
            return graph[sourceId]?.class_type ?? null
          })
        return {
          tool,
          validation,
          graph: {
            nodeClasses: nodes.map((node) => node.class_type),
            loadVideoCount: nodes.filter((node) => node.class_type === 'LoadVideo').length,
            manualSigmasCount: nodes.filter((node) => node.class_type === 'ManualSigmas').length,
            saveVideo: nodes.some((node) => node.class_type === 'SaveVideo'),
            audioSourceClass,
            total: nodes.length,
          },
        }
      } catch (error) {
        return { tool, validation, graph: null, refusal: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
