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
 * bake/undo, canonical-pointer switching, locks) and the pose-rig dock
 * state. The stills intent (34afx79, 2026-09-19) renders H3-1F — the
 * h3image Generate-T=1 family through the workbench's shared submit core
 * (images/submit.ts), engine-selected per chain via the two-slot seam in
 * canvas/stillIntent.ts. (LTX and Z-Image are fully removed — Phase 0,
 * 2026-09-20; git history is the archive.)
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

import { documentsApi, DocumentsHttpError, type ProjectMeta } from './api'
import { isWorkbenchJob, landWorkbenchTake } from '../images/landing'
import { sessionContract } from '../images/session'
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
  TILE_W,
  type Tile,
  type Edge,
} from './derive'
import {
  buildCanvasRenderRequest,
  buildOutputIndex,
  canvasChainOption,
  chainSettingsDefaults,
  effectiveMode,
  emptyLibraries,
  forkInputSpec,
  latentPathFor,
  mediaForOutput,
  MODE_LABEL,
  motionContextFolder,
  MOTION_CONTEXT_NODES,
  planCanvasGraph,
  readChainSettings,
  resolveChainReferences,
  takeMotionContext,
  type CanvasAssetEntry,
  type CanvasChainSettings,
  type CanvasLibraries,
  type ForkSubstrate,
  type MotionContextFacts,
} from './generation'
import {
  episodeRunEnd,
  gapAfter,
  GAP_LABEL,
  newPlanDocument,
  newSegment,
  planDocumentFromChains,
  readPlanDocument,
  type PlanDocumentData,
  type PlanGapKind,
  type PlanSegment,
} from './plan'
import { activeLorasOf, compileLoraTimeline, loraTimelineToPlanDocument, readLoraTimelineDoc } from './loraTimeline'
import { DEFAULT_SETTINGS, type OpKind } from './ops'
import type { EndpointDirection, EndpointOption, OptionAvailability } from './options'
import { findH3PreviewOverrideNode } from '../lib/h3Stack'
import { mergeModelOverrides, resolveModelOverrides, resolveModels, type ModelFamilyId, type OverrideResolution } from '../lib/modelOverrides'
import { inferSelections } from '../lib/modelSelection'
import { submitH3Render, validateH3Render } from '../lib/h3Submit'
import { submitWorkbenchGeneration, validateWorkbenchRequest } from '../images/submit'
import { canvasEditHandoff, canvasH3OneFrameRequest, queuedImageEngineRefusal, stashCanvasEditHandoff } from './stillIntent'
import { buildH3ImageGraph, H3IMG_RECIPE_PINS } from '../lib/graph/h3image'
import { submitMusic3, validateMusic3 } from '../lib/music3Submit'
import { submitAceStep, validateAceStep } from '../lib/aceStepSubmit'
import { buildMusic3Workflow, inferMusic3Selection, type Music3GenerationOptions } from '../lib/music3Workflow'
import { buildAceStepWorkflow, inferAceStepSelections } from '../lib/aceStepWorkflow'
import { characterReferences, loadCharacterProjects } from '../lib/characterLibrary'
import { locationReferences, loadLocationProjects } from '../lib/locationLibrary'
import { loadWardrobeProjects } from '../lib/wardrobeLibrary'
import { useJobsStore } from '../state/jobsStore'
import { useSessionStore } from '../state/sessionStore'
import type { AceStepGenerationOptions, GenerationJob, MediaFile, ModelOverrideSlots, ModelSelection } from '../types'

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

/** The approved picture paths of a library entry (the §6 projection's
 *  canonical reference sets). */
function characterReferencesOf(character: ReturnType<typeof loadCharacterProjects>[number]): string[] {
  return characterReferences(character).map((file) => file.path)
}

function locationReferencesOf(location: ReturnType<typeof loadLocationProjects>[number]): string[] {
  return locationReferences(location).map((file) => file.path)
}

/** Motion-Context readiness: all four node classes reported by the engine. */
function motionContextReady(): boolean {
  const info = engineFacts().info
  return MOTION_CONTEXT_NODES.every((node) => Boolean(info?.[node]))
}

/** The model-override layers for one family as the seam sees them: the
 *  chain's explicit picks over the global (Settings) picks. */
function familyOverrides(family: ModelFamilyId, chainOverrides?: ModelOverrideSlots): ModelOverrideSlots {
  const settings = useSessionStore.getState().settings
  return mergeModelOverrides(chainOverrides, settings?.modelOverrides?.[family])
}

/** The override RESOLUTION for a family (refusals block submissions;
 *  degradations warn) — the honest-UI companion to the resolved selection. */
function overrideOutcomeFor(family: ModelFamilyId, chainOverrides?: ModelOverrideSlots): OverrideResolution {
  const { models } = engineFacts()
  return resolveModelOverrides(family, models, familyOverrides(family, chainOverrides))
}

/** H3 readiness for one turbo tier (the App-root computation, per chain).
 *  Overrides apply through the seam — inference itself is untouched. */
function selectionFor(turbo: 'off' | '4' | '8', family: string, chainOverrides?: ModelOverrideSlots): ModelSelection {
  const { models } = engineFacts()
  return resolveModels('minimax',
    inferSelections(models, turbo, family || undefined),
    models,
    familyOverrides('minimax', chainOverrides),
  ).selection
}

/** Music 3 / ACE-Step selections with overrides through the same seam. */
function music3SelectionOf(chainOverrides?: ModelOverrideSlots) {
  const { models } = engineFacts()
  return resolveModels('music3', inferMusic3Selection(models), models, familyOverrides('music3', chainOverrides)).selection
}

function aceSelectionOf(chainOverrides?: ModelOverrideSlots) {
  const { models } = engineFacts()
  return resolveModels('acestep', inferAceStepSelections(models), models, familyOverrides('acestep', chainOverrides)).selection
}

/** The offline plan probe's fully-resolved H3 image selection (34afx79) —
 * construction is pure, so the plan builds with TEST names exactly like the
 * video plan's fakeSelection. Mirrors the h3img golden matrix's
 * canvas-t1-inline entry (scripts/lib/h3img-matrix.cjs). */
const CANVAS_T1_TEST_SELECTION = {
  fl2va: 'TEST-fl2va.safetensors',
  ref2va: 'TEST-ref2va.safetensors',
  textEncoder: 'TEST-qwen3vl.safetensors',
  videoVae: 'TEST-video-vae.safetensors',
  audioVae: 'TEST-audio-vae.safetensors',
  t1ImageVae: 'TEST-minimax_h3_t1_image_vae.safetensors',
  turboLora: 'TEST-fl2v-turbo-8step.safetensors',
  detailAdapterLora: 'TEST-detail-adapter.safetensors',
  krea2: null,
  klein: { unet: '', textEncoder: '', vae: '' },
} as const

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
  /** The GLOBAL asset store resolved for binding (§2 asset, Phase 4). */
  assets: CanvasAssetEntry[]
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
  /** Phase 4 (§7 V): the library projection overlay (library-as-projection). */
  libraryOpen: boolean
  /** Phase 5b (§6): the timeline projection overlay — the chronological
   *  projection of chain outputs / the plan (the V-flip family's second
   *  member; V cycles ∅ → timeline → library → ∅, dated 2026-09-17). */
  timelineOpen: boolean
  /** The plan the timeline projects — null = the unplanned chronology (chain
   *  outputs in creation order). */
  timelinePlanId: string | null
  /** The measured gap menu popover (§6): hard cut / NLE / FLF splice /
   *  dip-to-black / diegetic bridge, verdicts from the transitions research. */
  gapMenu: { planId: string; afterSegmentId: string } | null
  /** Phase 4 (§8): Settings docked as a floating panel (the thin surface). */
  settingsDock: boolean
  /** Dock stacking counter (review M11, 2026-09-19): a dock that opens or is
   *  grabbed takes the NEXT z — three open docks no longer stack at the same
   *  z with DOM order deciding the winner. Each dock keeps its own assigned
   *  value; only this counter is shared. */
  dockZ: number
  /** Phase 5: the PII-scrubbed diagnostics surface docked (inventory row 10:
   *  "diagnostics ride the radar/engine chip"). */
  diagnosticsDock: boolean
  /** Phase 4 (§5.4): the audio engine dock (Music 3 / ACE-Step as ops). */
  audioDock: { engine: 'music3' | 'acestep'; chainId?: string } | null
  cameraCommands: CameraCommand[]
  cameraCommandSeq: number
  viewDirty: boolean
}

type CanvasActions = {
  boot(): Promise<void>
  refreshProjects(): Promise<void>
  refreshLibraries(): void
  /** Phase 4: the global asset store — load rows for binding, and project
   *  the shared libraries into canvas_asset (copy-never-destroy). */
  refreshAssets(): Promise<void>
  syncLibraryAssets(): Promise<void>
  /** Consent-gated global-asset bind (§2 asset_fork): fork-into-project on
   *  first bind, then the reference rides the ordered picture budget. */
  bindGlobalAsset(chainId: string, assetId: string): Promise<void>
  /** Phase 4 overlays: the library projection (V) + the Settings dock. */
  setLibraryOpen(open: boolean): void
  /** Phase 5b (§6): the timeline projection + the Director actions — plan
   *  documents, the measured gap menu, segment seeding (consent-gated), and
   *  the latent-episode render (the scene-chain successor). */
  setTimelineOpen(open: boolean): void
  /** §7 V — the projection flip through the family: ∅ → timeline → library
   *  → ∅ (the spec's listed order; the library stays one button away). */
  cycleProjection(): void
  setGapMenu(menu: { planId: string; afterSegmentId: string } | null): void
  createPlan(): Promise<string | null>
  /** The unplanned chronology becomes a persisted plan (adopt-chronology). */
  adoptChronology(): Promise<string | null>
  /** Read-modify-write the plan document through the mutator, then reload. */
  updatePlanDocument(planId: string, mutate: (plan: PlanDocumentData) => PlanDocumentData): Promise<void>
  addPlanSegment(planId: string): Promise<void>
  updatePlanSegment(planId: string, segmentId: string, patch: Partial<Pick<PlanSegment, 'title' | 'prompt' | 'duration' | 'referenceCharacterIds' | 'referenceLocationIds'>>): Promise<void>
  removePlanSegment(planId: string, segmentId: string): Promise<void>
  /** Choose a gap kind (persisted); an FLF choice runs the continuation-frame
   *  splice when both sides can wire (the Phase-5 toast-note handoff, moved
   *  into the gap machinery). */
  setPlanGap(planId: string, afterSegmentId: string, kind: PlanGapKind): Promise<void>
  /** The MoviePlanner shot-handoff successor: seed the segment's chain
   *  (consent-gated — created + selected, never submitted) and write the
   *  chain_ref back into the plan. An FLF gap before this segment auto-wires
   *  the continuation frame when the prior take exists. */
  seedSegmentChain(planId: string, segmentId: string): Promise<string | null>
  /** One segment's consented generation (a click IS the consent). */
  submitSegment(planId: string, segmentId: string): Promise<{ ok: boolean; message?: string }>
  /** The scene-chain successor: a contiguous run of seeded segments rendered
   *  as ONE Motion-Context latent episode (segment N continues N-1's latent;
   *  every job links to its segment chain so takes LAND on the objects). */
  submitPlanEpisode(planId: string, fromSegmentId: string): Promise<{ ok: boolean; message?: string }>
  /** The LoRA timeline's compile step (7twfk6o, consent-gated — the Apply
   *  click IS the consent): the chain's painted ranges compile into a plan
   *  document whose segments carry their LoRA stacks, then every segment
   *  seeds its chain (created + selected, NEVER submitted). Returns the new
   *  plan id, or null with the refusal reasons toasted. */
  applyLoraTimeline(chainId: string): Promise<{ ok: boolean; planId?: string; reasons?: string[] }>
  setSettingsDock(open: boolean): void
  /** Dock stacking (review M11): take the next z for a dock opening or
   *  being grabbed; returns the value to apply. */
  raiseDock(): number
  setDiagnosticsDock(open: boolean): void
  setAudioDock(dock: { engine: 'music3' | 'acestep'; chainId?: string } | null): void
  /** One audio chain submit (Music 3 / ACE-Step as ops): the dock creates
   *  the chain + settings, submitChain carries it (rerun-stable). */
  createAudioChain(engine: 'music3' | 'acestep', caption: string): Promise<string | null>
  /** The dock's pre-submit validation for a NOT-YET-CREATED audio chain —
   *  the same ladders submitChain runs (honest offline refusals inline). */
  validateAudioDraft(engine: 'music3' | 'acestep', caption: string): string | null
  openProject(id: string, options?: { restoreCamera?: boolean }): Promise<void>
  /** Re-reads the ACTIVE project document + rederives (surfaces that
   *  write through documentsApi directly — the image workbench — refresh
   *  through this instead of reaching into store internals). */
  reloadActiveDocument(): Promise<void>
  closeProject(id: string): Promise<void>
  createCanvas(name?: string): Promise<string | null>
  /** The launcher's prompt submit: spawn the seed chain, then REAL submit. */
  submitPrompt(text: string, mediaType: 'video' | 'image'): Promise<void>
  /** Phase 5 (Studios dock): seed a chain from a kept surface — the
   *  MoviePlanner shot handoff. Richer than the launcher's submitPrompt
   *  (compiled prompt + library reference ids + duration/resolution from the
   *  shot) and CONSENT-GATED: it creates + selects the object; nothing
   *  auto-executes (principle 5 — review in the properties panel, generate
   *  from there). Returns the new chain id, or null on failure. */
  seedChain(input: { prompt: string } & Partial<CanvasChainSettings>): Promise<string | null>
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
    // Jobs are newest-first; walking them forward lets an OLDER job for the
    // same chain clobber the link (a rerun or post-failure retry then never
    // lands its take — audit D7). Reverse so the NEWEST job for a chain wins.
    for (const job of [...jobs].reverse()) {
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

  // Stale-response sequencing (timeline-gap-menu vision FAIL, cleanup wave
  // twmpu4m): concurrent plan writes each reload the project document, and
  // HTTP responses can arrive OUT OF ORDER — applying them last-write-wins
  // could REGRESS the store to an older document (segment ids churn, the
  // editor remounts from the stale doc, and uncontrolled inputs repaint
  // empty while the persisted document is correct — exactly the judged
  // empty-textarea defect). Each fetch bumps a per-project token; only the
  // latest-issued fetch may apply its response to the store. Callers still
  // receive their own fetch's document (the plan-conflict rebase needs the
  // freshest data IT can get; its CAS write catches any residual staleness).
  const documentFetchTokens = new Map<string, number>()
  const loadDocument = async (id: string): Promise<CanvasDocument | null> => {
    const token = (documentFetchTokens.get(id) ?? 0) + 1
    documentFetchTokens.set(id, token)
    try {
      const loaded = await documentsApi.getProject(id)
      if (documentFetchTokens.get(id) === token) set((state) => ({ documents: { ...state.documents, [id]: loaded } }))
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

  /** A completed render that landed while no client was watching (page
   *  closed, server down at completion) must still land its take once the
   *  document is (re)loaded — the landing loop only fires on jobs-store
   *  changes, which do not happen at boot (and the jobs boot-load can
   *  settle before this store's subscription attaches). Bounded retry
   *  schedule covers the boot ordering either way; guarded by
   *  landingInFlight against recursion from the landing's own reload. */
  const landAfterDocumentLoad = () => {
    for (const delay of [0, 600, 1800]) {
      window.setTimeout(() => { if (!landingInFlight) void landCompletions() }, delay)
    }
  }

  /** Completed jobs that have not landed a take on their chain yet → append
   *  output + take (canonical auto-pointed, blob registered server-side).
   *  Idempotent by the take's jobId (server-enforced at the write boundary);
   *  re-entrancy-guarded so overlapping jobs notifications cannot
   *  double-append. Cancelled jobs unlink.
   *
   *  Remote-only completions (B2): a job without a local file lands through
   *  the server-side fetch of the engine's EXACT output descriptor; when
   *  that is impossible, the failure lands VISIBLY on the object (an
   *  errored take carrying the reason + the preserved descriptor) — never a
   *  silent idle tile, never a lost render. Landing retries are bounded
   *  (m6): after MAX_LANDING_ATTEMPTS the failure parks durably instead of
   *  retrying + toasting on every tick forever. */
  let landingInFlight = false
  const landingAttempts = new Map<string, number>()
  const MAX_LANDING_ATTEMPTS = 3
  const LANDING_HEARTBEAT = 10

  /** The ComfyUI output descriptor encoded in a job's (translated) media
   *  URL — filename/subfolder/type survive webMediaUrl's translation, so a
   *  reloaded job still knows exactly which engine file to fetch. */
  const engineOutputDescriptorFromUrl = (url: string | null | undefined): { filename: string; subfolder?: string; type?: string } | null => {
    if (!url || !url.startsWith('/api/lan/media')) return null
    try {
      const parsed = new URL(url, 'http://minimax.local')
      const filename = parsed.searchParams.get('filename')
      if (!filename) return null
      const subfolder = parsed.searchParams.get('subfolder') ?? ''
      const type = parsed.searchParams.get('type') ?? ''
      return { filename, ...(subfolder ? { subfolder } : {}), ...(type ? { type } : {}) }
    } catch {
      return null
    }
  }

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
      if (job.status === 'completed' && !landed.has(jobId) && (job.localOutputPath || job.outputUrl)) pending.push({ chainId, job })
    }
    if (!pending.length) return
    landingInFlight = true
    try {
      for (const { chainId, job } of pending) {
        const chain = doc.chains.find((entry) => entry.id === chainId)
        if (!chain) continue
        // H3 image workbench (k9vu6t0): a workbench job lands as ONE packet
        // take whose artifacts are the N frame outputs (all of them, scored
        // by the first-party scorer) — the packet-aware branch, never the
        // one-artifact video path.
        if (isWorkbenchJob(job)) {
          const attempt = (landingAttempts.get(job.id) ?? 0) + 1
          landingAttempts.set(job.id, attempt)
          try {
            const result = await landWorkbenchTake({
              chain,
              job,
              settings: useSessionStore.getState().settings,
              comfyUrl: useSessionStore.getState().settings?.comfyUrl ?? '',
              ensureOutput: async (targetChainId) => (await documentsApi.createOutput({ chainId: targetChainId, substrates: ['decoded'] })).id,
            })
            if (result.landed) get().toast('success', 'The image packet landed — the take strip holds its frames; the scorer\'s pick is marked.')
            else if (result.error) get().toast('error', `The workbench render could not land: ${result.error}`)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (attempt === MAX_LANDING_ATTEMPTS || attempt % LANDING_HEARTBEAT === 0) {
              get().toast('error', `The finished workbench render could not land: ${message}`)
            }
          }
          continue
        }
        // Phase 4: a render whose graph saved a sampler latent records its
        // saved-clip facts (manifest.motionContext, written by the submit
        // core) — the take becomes latent-forkable (substratesForTake).
        const manifest = job.manifest && typeof job.manifest === 'object' ? (job.manifest as Record<string, unknown>) : null
        const manifestMotion = manifest && manifest.motionContext && typeof manifest.motionContext === 'object' ? (manifest.motionContext as Record<string, unknown>) : null
        const motionContext = manifestMotion && typeof manifestMotion.folder === 'string' && typeof manifestMotion.clipIndex === 'number'
          ? { folder: manifestMotion.folder, clipIndex: manifestMotion.clipIndex }
          : null
        const descriptor = engineOutputDescriptorFromUrl(job.outputUrl)
        let sourcePath: string | null = job.localOutputPath ?? null
        let remoteFetched = false
        let failureReason: string | null = sourcePath ? null : 'the render finished without a local output file'
        if (!sourcePath && descriptor) {
          try {
            const ingested = await documentsApi.ingestEngineOutput({ ...descriptor, kind: job.mediaType ?? 'video' })
            sourcePath = ingested.path
            remoteFetched = true
            failureReason = null
          } catch (error) {
            failureReason = `the engine output could not be fetched: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        const attempt = (landingAttempts.get(job.id) ?? 0) + 1
        landingAttempts.set(job.id, attempt)
        const canRetry = attempt < MAX_LANDING_ATTEMPTS
        if (failureReason && canRetry) continue // bounded retry (m6): the next jobs tick tries again, silently
        try {
          let outputId = chain.outputs[0]?.id ?? null
          if (!outputId) {
            const output = await documentsApi.createOutput({ chainId, substrates: ['decoded'] })
            outputId = output.id
          }
          // Latent durability (B1): the engine-side RELATIVE latent resolves
          // against the output directory at landing — an absolute existing
          // file the server registers into the content-addressed blob tree
          // (hashed, evictable, exported) instead of a raw relative string
          // that dies with the engine's output directory.
          const settings = useSessionStore.getState().settings
          const latentPath = motionContext
            ? (settings?.outputDirectory ? `${settings.outputDirectory.replace(/\/+$/, '')}/${latentPathFor(motionContext)}` : latentPathFor(motionContext))
            : null
          const metrics: Record<string, unknown> = {
            kind: job.mediaType ?? 'video',
            duration: job.duration,
            width: job.width,
            height: job.height,
            sourcePath: sourcePath,
            outputUrl: job.outputUrl ?? null,
            ...(remoteFetched && descriptor ? { remoteProvenance: { fetched: true, filename: descriptor.filename, subfolder: descriptor.subfolder ?? null, type: descriptor.type ?? null } } : {}),
            ...(failureReason ? { landingError: failureReason, outputFile: descriptor } : {}),
            ...(motionContext ? { motionContext } : {}),
            // Which LoRAs were active on this take (7twfk6o): the turbo LoRA
            // the manifest's models record already names (at its strength) +
            // the temporal stack recorded at submit — every take states its
            // own LoRA truth (activeLorasOf, pure + unit-tested).
            ...activeLorasOf(manifest),
          }
          await documentsApi.appendTake({
            outputId,
            jobId: job.id,
            artifacts: sourcePath ? [sourcePath] : [],
            ...(latentPath ? { latentPath } : {}),
            metrics,
          })
          if (failureReason) get().toast('error', `“${chainPromptOf(chain)}” finished, but ${failureReason}. The failure is recorded on the object — nothing was silently dropped.`)
          else get().toast('success', `The render landed on “${chainPromptOf(chain)}”.`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // Transient landing failures (documents server unreachable) retry
          // silently while attempts remain; beyond that a slow heartbeat
          // toast keeps the failure visible without spamming every tick.
          if (attempt === MAX_LANDING_ATTEMPTS || attempt % LANDING_HEARTBEAT === 0) {
            get().toast('error', `The finished render could not land on “${chainPromptOf(chain)}”: ${message}`)
          }
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
   *  output index, reference bindings (library + canvas + global assets),
   *  first/last media, and — Phase 4 — the latent-continuation facts when the
   *  chain is a substrate=latents fork. */
  const chainRenderContext = (chainId: string) => {
    const doc = activeDocument()
    if (!doc) return null
    const chain = doc.chains.find((entry) => entry.id === chainId)
    if (!chain) return null
    const settings = readChainSettings(chain.settings, useSessionStore.getState().settings)
    const outputs = buildOutputIndex(doc)
    const resolveMedia = (outputId: string) => mediaForOutput(outputs.get(outputId))
    const bindings = resolveChainReferences(settings, get().libraries, resolveMedia, get().assets)
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
    // Phase 4 latent continuation: a substrate=latents fork resolves the
    // SOURCE take's saved-clip facts (its Motion-Context provenance). Absent
    // facts = the honest refusal below, never a silent decode-instead.
    const outputRef = chain.inputSpec && typeof chain.inputSpec.outputRef === 'object' ? (chain.inputSpec.outputRef as Record<string, unknown>) : null
    const isLatentFork = outputRef?.substrate === 'latents'
    let latentContinuation: MotionContextFacts | null = null
    let latentRefusal: string | null = null
    if (isLatentFork) {
      const sourceOutputId = typeof outputRef?.outputId === 'string' ? outputRef.outputId : null
      const sourceTakeId = typeof outputRef?.takeId === 'string' ? outputRef.takeId : null
      const entry = sourceOutputId ? outputs.get(sourceOutputId) : undefined
      const sourceTake = entry ? (sourceTakeId ? entry.chain.outputs.flatMap((output) => output.takes).find((take) => take.id === sourceTakeId) ?? null : entry.take) : null
      latentContinuation = takeMotionContext(sourceTake)
      if (!latentContinuation) latentRefusal = 'The source take has no saved latent context — it rendered before the Motion-Context nodes were installed. Rerun it (a fresh take saves its latent), or fork the decoded media instead.'
    }
    return { doc, chain, settings, outputs, bindings, firstFrame, lastFrame, referenceMedia, referenceVideos, referenceAudios, isLatentFork, latentContinuation, latentRefusal }
  }

  /** The FLF continuation-frame splice (§6 — the measured champion, 36 dB
   *  class): the left chain's canonical VIDEO take → its FINAL frame
   *  (server-side ffmpeg 'last' extraction, no engine) → a real media object
   *  whose output wires as the right chain's first frame. This is the
   *  Phase-5 toast-note handoff moved into the gap machinery. Returns the
   *  frame output id, or an honest refusal. */
  const continuationFrameFor = async (leftChainId: string): Promise<{ outputId: string } | { refusal: string }> => {
    const doc = activeDocument()
    const chain = doc?.chains.find((entry) => entry.id === leftChainId)
    const session = useSessionStore.getState()
    if (!doc || !chain || !session.settings) return { refusal: 'The prior segment has no chain on this canvas.' }
    const outputs = buildOutputIndex(doc)
    const outputId = chain.outputs[0]?.id ?? null
    const resolved = outputId ? mediaForOutput(outputs.get(outputId)) : null
    if (!resolved || resolved.media.kind !== 'video') return { refusal: 'Render the prior segment first — the continuation frame comes from its final rendered frame.' }
    try {
      const frame = await window.minimax.extractVideoFrame(resolved.media.path, 'last', session.settings.outputDirectory, session.settings.ffmpegPath)
      const frameChain = await documentsApi.createChain({
        projectId: doc.project.id,
        kind: 'media',
        inputSpec: { fresh: { media: { name: frame.name, kind: 'image', path: frame.path } } },
        settings: { name: frame.name, mediaType: 'image' },
      })
      const frameOutput = await documentsApi.createOutput({ chainId: frameChain.id, substrates: ['decoded'] })
      await documentsApi.appendTake({
        outputId: frameOutput.id,
        artifacts: [frame.path],
        metrics: { kind: 'image', name: frame.name, sourcePath: frame.path, continuationOf: { chainId: leftChainId, takeId: resolved.take.id } },
      })
      return { outputId: frameOutput.id }
    } catch (error) {
      return { refusal: `The continuation frame could not be extracted: ${error instanceof Error ? error.message : String(error)}` }
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
    selection: { tileIds: [] },
    libraries: emptyLibraries,
    assets: [],
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
    libraryOpen: false,
    timelineOpen: false,
    timelinePlanId: null,
    gapMenu: null,
    settingsDock: false,
    dockZ: 60,
    diagnosticsDock: false,
    audioDock: null,
    cameraCommands: [],
    cameraCommandSeq: 0,
    viewDirty: false,

    boot: async () => {
      get().refreshLibraries()
      void get().syncLibraryAssets().then(() => get().refreshAssets()).catch(() => undefined)
      void get().refreshAssets()
      try {
        const [listing, session] = await Promise.all([documentsApi.listProjects(), documentsApi.getSession()])
        set({ projects: listing.projects, openProjects: session.openProjects, activeProjectId: session.activeProject })
        // Version-refusal isolation (M4): a project this build cannot open is
        // skipped server-side; the boot still happens. One honest note per
        // boot — never a bricked canvas, never a silent drop.
        if (listing.skipped.length) {
          get().toast('neutral', `${listing.skipped.length} canvas${listing.skipped.length === 1 ? '' : 'es'} ${listing.skipped.length === 1 ? 'was' : 'were'} written by a newer MiniMax Studio and ${listing.skipped.length === 1 ? 'is' : 'are'} hidden until the app is upgraded — the other canvases are unaffected.`)
        }
        const active = session.activeProject
        if (active && listing.projects.some((project) => project.id === active)) {
          const bootDoc = await loadDocument(active)
          if (bootDoc) {
            const view = parseViewBlob(bootDoc.project.camera)
            set({ layout: view.layout })
            recomputeTiles()
            get().requestCamera({ kind: 'jump', camera: view.camera })
            // A render that completed while no client was watching lands
            // its take now (audit D7: the loop otherwise only fires on
            // jobs-store changes, which do not happen at boot).
            landAfterDocumentLoad()
          }
        } else {
          // An empty or missing session boots to the launcher (§4).
          set({ activeProjectId: null, openProjects: session.openProjects.filter((id) => listing.projects.some((project) => project.id === id)) })
        }
      } catch (error) {
        get().toast('error', `The canvas could not reach the document store: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        set({ phase: 'ready' })
      }
    },

    refreshProjects: async () => {
      try {
        set({ projects: (await documentsApi.listProjects()).projects })
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

    refreshAssets: async () => {
      try {
        const rows = await documentsApi.listAssets()
        // Resolve for binding: character/location kinds whose curated
        // reference set yields renderable picture files (paths → MediaFile).
        // Prompt/refmod/wardrobe assets surface elsewhere (the prompt library
        // insert + wardrobe studio flows) — they are not picture bindings.
        const assets: CanvasAssetEntry[] = []
        for (const row of rows) {
          if (row.kind !== 'character' && row.kind !== 'location') continue
          const label = typeof row.fields.name === 'string' && row.fields.name ? row.fields.name : typeof row.fields.label === 'string' && row.fields.label ? row.fields.label : row.id.slice(0, 12)
          const images = (row.canonicalReferenceSet ?? [])
            .filter((path): path is string => typeof path === 'string' && Boolean(path))
            .map((path) => ({ path, name: path.split('/').pop() ?? path, kind: 'image' as const }))
          if (!images.length) continue
          assets.push({ id: row.id, kind: row.kind, label, images })
        }
        set({ assets })
      } catch (error) {
        // A failed load surfaces honestly (the panel shows no global-asset
        // rows); the next boot, sync, or library event retries.
        get().toast('error', `The global asset store could not load: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    syncLibraryAssets: async () => {
      // The libraries → global asset store projection (§6, copy-never-destroy):
      // every library location/character entry upserts a canvas_asset row
      // carrying its approved reference set. The old surface keeps reading its
      // own stores untouched; the canvas gains the global-store binding (F3).
      // Deprojection (m5): the projection tracks its source — an entry
      // deleted in its studio leaves the bindable surface (tombstone) and one
      // that returns restores. Only library:* rows are ever touched (the
      // legacy-import and user assets are not this projection's to manage).
      const { libraries } = get()
      const entries: Array<{ id: string; kind: 'character' | 'location'; fields: Record<string, unknown>; references: string[] }> = []
      for (const character of libraries.characters) {
        const references = characterReferencesOf(character)
        if (references.length) entries.push({ id: `library:character:${character.id}`, kind: 'character', fields: { name: character.name, description: character.description ?? '', libraryId: character.id }, references })
      }
      for (const location of libraries.locations) {
        const references = locationReferencesOf(location)
        if (references.length) entries.push({ id: `library:location:${location.id}`, kind: 'location', fields: { name: location.name, description: location.description ?? '', environmentMode: location.environmentMode, libraryId: location.id }, references })
      }
      const currentIds = new Set(entries.map((entry) => entry.id))
      try {
        for (const entry of entries) {
          await documentsApi.upsertAsset({ id: entry.id, kind: entry.kind, fields: entry.fields, canonicalReferenceSet: entry.references })
        }
        const live = await documentsApi.listAssets()
        const trashed = await documentsApi.listAssets(undefined, true)
        for (const row of [...live, ...trashed]) {
          if (!row.id.startsWith('library:')) continue
          if (!currentIds.has(row.id) && row.deletedAt === undefined) await documentsApi.deleteAsset(row.id)
          if (currentIds.has(row.id) && row.deletedAt !== undefined) await documentsApi.restoreAsset(row.id)
        }
        await get().refreshAssets()
      } catch {
        // A failed projection is ambient (the libraries still bind directly);
        // the next library event or boot retries the sync.
      }
    },

    bindGlobalAsset: async (chainId, assetId) => {
      const doc = activeDocument()
      const asset = get().assets.find((entry) => entry.id === assetId)
      if (!doc || !asset) return
      const chain = doc.chains.find((entry) => entry.id === chainId)
      if (!chain) return
      try {
        // Consent gate (§2 asset_fork, F3): the FIRST bind of an asset into a
        // project records the explicit fork — lineage home + consent stamp.
        const forked = (doc.assetForks ?? []).some((fork) => fork.assetId === assetId)
        if (!forked) {
          await documentsApi.forkAsset({ projectId: doc.project.id, assetId, forkedSettings: { label: asset.label, kind: asset.kind } })
          get().toast('neutral', `“${asset.label}” forked into this project — its reference set is bound with lineage back to the global asset.`)
        }
        const settings = readChainSettings(chain.settings, useSessionStore.getState().settings)
        const binding = !settings.referenceAssetIds.includes(assetId)
        await get().setChainSettings(chainId, { referenceAssetIds: binding ? [...settings.referenceAssetIds, assetId] : settings.referenceAssetIds.filter((id) => id !== assetId) })
        // The identity payload carries the asset as a ref (§2: reference set
        // / assets ride every window) — MERGE on bind, drop on unbind, so a
        // second asset never erases the first's record.
        const identityRefs = new Set(chain.identity?.refAssetIds ?? [])
        if (binding) identityRefs.add(assetId)
        else identityRefs.delete(assetId)
        await documentsApi.upsertIdentity({ chainId, refAssetIds: [...identityRefs] })
        const refreshed = await loadDocument(doc.project.id)
        if (refreshed) recomputeTiles()
      } catch (error) {
        get().toast('error', `The global asset could not be bound: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    setLibraryOpen: (open) => set({ libraryOpen: open }),

    // ---- Phase 5b (§6): the Director Suite -----------------------------------

    setTimelineOpen: (open) => set({ timelineOpen: open, gapMenu: null }),

    cycleProjection: () => {
      // §7 V — the projection flip through the family. Dated 2026-09-17: the
      // cycle is ∅ → timeline → library → ∅ (the spec's listed order; the
      // library stays one titlebar button away). Phase 4's V toggled the
      // library alone — the family grew.
      const state = get()
      if (state.timelineOpen) set({ timelineOpen: false, libraryOpen: true, gapMenu: null })
      else if (state.libraryOpen) set({ libraryOpen: false })
      else set({ timelineOpen: true })
    },

    setGapMenu: (menu) => set({ gapMenu: menu }),

    createPlan: async () => {
      let projectId = get().activeProjectId
      if (!projectId) {
        const created = await get().createCanvas()
        if (!created) return null
        projectId = created
      }
      try {
        const plan = await documentsApi.upsertPlan({ projectId, document: newPlanDocument() as unknown as Record<string, unknown> })
        const refreshed = await loadDocument(projectId)
        if (refreshed) recomputeTiles()
        set({ timelinePlanId: plan.id })
        return plan.id
      } catch (error) {
        get().toast('error', `The plan could not be created: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    adoptChronology: async () => {
      const doc = activeDocument()
      if (!doc) {
        get().toast('neutral', 'Open a canvas first — the chronology comes from its objects.')
        return null
      }
      try {
        const document = planDocumentFromChains(doc)
        if (!document.segments.length) {
          get().toast('neutral', 'Nothing to plan yet — chain outputs land here as the chronology.')
          return null
        }
        const plan = await documentsApi.upsertPlan({ projectId: doc.project.id, document: document as unknown as Record<string, unknown> })
        const refreshed = await loadDocument(doc.project.id)
        if (refreshed) recomputeTiles()
        set({ timelinePlanId: plan.id })
        get().toast('success', `Plan created from ${document.segments.length} chain output${document.segments.length === 1 ? '' : 's'} — the chronology is editable with measured transitions.`)
        return plan.id
      } catch (error) {
        get().toast('error', `The plan could not be created: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    updatePlanDocument: async (planId, mutate) => {
      const doc = activeDocument()
      const planRow = doc?.plans?.find((plan) => plan.id === planId)
      if (!doc || !planRow) return
      // Optimistic concurrency (M5): the write carries the version this edit
      // started from (expectedUpdatedAt). A 409 means a concurrent edit won —
      // the mutator is RE-APPLIED once to the fresh document (per-field
      // patches merge cleanly); a second conflict surfaces instead of
      // silently clobbering the winner.
      const write = async (row: typeof planRow): Promise<boolean> => {
        const next = mutate(readPlanDocument(row.document))
        try {
          await documentsApi.upsertPlan({ projectId: doc!.project.id, id: planId, document: next as unknown as Record<string, unknown>, expectedUpdatedAt: row.updatedAt })
          return true
        } catch (error) {
          if (error instanceof DocumentsHttpError && error.status === 409) return false
          throw error
        }
      }
      try {
        if (await write(planRow)) {
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
          return
        }
        const reloaded = await loadDocument(doc.project.id)
        const freshRow = reloaded?.plans?.find((plan) => plan.id === planId)
        if (reloaded && freshRow) recomputeTiles()
        if (!freshRow) return
        if (await write(freshRow)) {
          const refreshed = await loadDocument(doc.project.id)
          if (refreshed) recomputeTiles()
          return
        }
        get().toast('error', 'This plan is being edited faster than it can save — the last change lost the race. Wait a moment and retry it.')
      } catch (error) {
        get().toast('error', `The plan could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    addPlanSegment: async (planId) => {
      await get().updatePlanDocument(planId, (plan) => ({ ...plan, segments: [...plan.segments, newSegment(plan.segments.length + 1)] }))
    },

    updatePlanSegment: async (planId, segmentId, patch) => {
      await get().updatePlanDocument(planId, (plan) => ({ ...plan, segments: plan.segments.map((segment) => segment.id === segmentId ? { ...segment, ...patch } : segment) }))
    },

    removePlanSegment: async (planId, segmentId) => {
      await get().updatePlanDocument(planId, (plan) => ({
        ...plan,
        segments: plan.segments.filter((segment) => segment.id !== segmentId),
        gaps: plan.gaps.filter((gap) => gap.afterSegmentId !== segmentId),
      }))
    },

    setPlanGap: async (planId, afterSegmentId, kind) => {
      set({ gapMenu: null })
      await get().updatePlanDocument(planId, (plan) => ({
        ...plan,
        gaps: [...plan.gaps.filter((gap) => gap.afterSegmentId !== afterSegmentId), { afterSegmentId, kind }],
      }))
      if (kind !== 'flf') {
        get().toast('neutral', `Transition set: ${GAP_LABEL[kind]}.`)
        return
      }
      // FLF: run the continuation-frame splice now (the menu gates readiness,
      // this is the retryable execution).
      const doc = activeDocument()
      const planRow = doc?.plans?.find((plan) => plan.id === planId)
      if (!doc || !planRow) return
      const plan = readPlanDocument(planRow.document)
      const index = plan.segments.findIndex((segment) => segment.id === afterSegmentId)
      const left = index >= 0 ? plan.segments[index] : undefined
      const right = index >= 0 ? plan.segments[index + 1] : undefined
      if (!left || !right) return
      if (!left.chainId || !right.chainId) {
        get().toast('neutral', 'FLF splice recorded — seed both segments to wire the continuation frame.')
        return
      }
      const frame = await continuationFrameFor(left.chainId)
      if ('refusal' in frame) {
        get().toast('error', frame.refusal)
        return
      }
      await get().setChainSettings(right.chainId, { firstFrameOutputId: frame.outputId, lastFrameOutputId: null })
      get().toast('success', 'FLF splice wired — the prior segment’s final frame is the next segment’s first frame (36 dB class, tranche 1).')
    },

    seedSegmentChain: async (planId, segmentId) => {
      const doc = activeDocument()
      const planRow = doc?.plans?.find((plan) => plan.id === planId)
      if (!doc || !planRow) return null
      const plan = readPlanDocument(planRow.document)
      const index = plan.segments.findIndex((segment) => segment.id === segmentId)
      const segment = index >= 0 ? plan.segments[index] : undefined
      if (!segment) return null
      // An FLF gap before this segment wires the continuation frame when the
      // prior take exists (MoviePlanner BLOCKED the handoff until the frame
      // existed; the canvas seeds anyway + reports honestly — dated 2026-09-17,
      // the splice is retryable from the gap menu once the prior renders).
      let firstFrameOutputId: string | null = null
      const previous = index > 0 ? plan.segments[index - 1] : undefined
      if (previous && previous.chainId && gapAfter(plan, previous.id).kind === 'flf') {
        const frame = await continuationFrameFor(previous.chainId)
        if ('outputId' in frame) firstFrameOutputId = frame.outputId
        else get().toast('neutral', `${frame.refusal} Seeding without it — retry the splice from the gap once it renders.`)
      }
      const chainId = await get().seedChain({
        prompt: segment.prompt,
        mediaType: 'video',
        duration: Math.max(2, Math.min(15, segment.duration)),
        referenceCharacterIds: segment.referenceCharacterIds,
        referenceLocationIds: segment.referenceLocationIds,
        ...(firstFrameOutputId ? { firstFrameOutputId } : {}),
      })
      if (!chainId) return null
      await get().updatePlanDocument(planId, (current) => ({ ...current, segments: current.segments.map((entry) => entry.id === segmentId ? { ...entry, chainId } : entry) }))
      return chainId
    },

    submitSegment: async (planId, segmentId) => {
      const doc = activeDocument()
      const planRow = doc?.plans?.find((plan) => plan.id === planId)
      const segment = planRow ? readPlanDocument(planRow.document).segments.find((entry) => entry.id === segmentId) : undefined
      if (!segment) return { ok: false, message: 'That segment is not in this plan.' }
      if (!segment.chainId) return { ok: false, message: 'Seed this segment first — it has no object to generate.' }
      return get().submitChain(segment.chainId)
    },

    submitPlanEpisode: async (planId, fromSegmentId) => {
      const doc = activeDocument()
      const planRow = doc?.plans?.find((plan) => plan.id === planId)
      if (!doc || !planRow) return { ok: false, message: 'The plan is not on an open canvas.' }
      const plan = readPlanDocument(planRow.document)
      const fromIndex = plan.segments.findIndex((segment) => segment.id === fromSegmentId)
      if (fromIndex < 0) return { ok: false, message: 'That segment is not in this plan.' }
      const facts = engineFacts()
      if (!facts.settings) return { ok: false, message: 'Studio settings are still loading.' }
      if (!facts.connected) return { ok: false, message: 'Start ComfyUI and verify the server connection in Settings.' }
      if (!motionContextReady()) return { ok: false, message: 'Latent chaining needs the ComfyUI-H3-Motion-Context custom nodes — install them, then refresh the engine.' }
      // The run: contiguous FLF-connected segments (a non-FLF gap is a
      // deliberate discontinuity — it ends the episode), stopping at the
      // first unseeded segment.
      const runEnd = episodeRunEnd(plan, fromIndex)
      let effectiveEnd = fromIndex
      while (effectiveEnd < runEnd && plan.segments[effectiveEnd].chainId) effectiveEnd += 1
      if (effectiveEnd - fromIndex < 2) return { ok: false, message: 'A latent chain needs at least two seeded segments joined by FLF gaps.' }
      const episodeKey = plan.segments[fromIndex].chainId!
      let queued = 0
      for (let index = fromIndex; index < effectiveEnd; index += 1) {
        const segment = plan.segments[index]
        const context = chainRenderContext(segment.chainId!)
        if (!context) continue
        const selection = selectionFor(context.settings.turbo, context.settings.turboFamily, context.settings.modelOverrides)
        // The scene-chain convention: segment N saves clip N into the episode
        // folder; N > 0 loads clip N-1 as never-denoised conditioning.
        const chainOption = { index: index - fromIndex, folder: motionContextFolder(episodeKey) }
        const request = buildCanvasRenderRequest(context.settings, { firstFrame: context.firstFrame, lastFrame: context.lastFrame, referenceImages: context.referenceMedia, referenceVideos: context.referenceVideos, referenceAudios: context.referenceAudios }, context.bindings, chainOption)
        const result = await submitH3Render(
          { ...request, manifestExtra: { canvas: { chainId: segment.chainId, projectId: doc.project.id } } },
          {
            settings: facts.settings,
            connected: facts.connected,
            modelReady: modelReadyFor(selection, context.settings.turbo),
            selection,
            models: facts.models,
            info: facts.info,
            clientId: engineBridge.clientId,
            h3PreviewOverrideNode: findH3PreviewOverrideNode(facts.info) || undefined,
            modelOverrides: overrideOutcomeFor('minimax', context.settings.modelOverrides),
          },
          {
            notify: (tone, text) => get().toast(tone === 'neutral' ? 'neutral' : tone, text),
            setJobs: (update) => useJobsStore.getState().setJobs(update),
            cancellationRequests: engineBridge.cancellationRequests ?? { current: new Set<string>() },
            onJobCreated: (jobId) => {
              set((current) => ({ chainJobs: { ...current.chainJobs, [segment.chainId!]: jobId } }))
              recomputeTiles()
            },
          },
        )
        if (!result.ok) {
          // The latent chain breaks at a refused segment — the remaining
          // segments stay unqueued (never a doomed continuation).
          get().toast('error', `Segment ${index - fromIndex + 1} refused: ${result.message} The chain stopped there — earlier segments are queued.`)
          return queued ? { ok: true } : { ok: false, message: result.message }
        }
        queued += 1
      }
      get().toast('success', `${queued}-segment latent chain queued — motion and audio continue at the latent level; each take lands on its own object.`)
      return { ok: true }
    },

    applyLoraTimeline: async (chainId) => {
      const context = chainRenderContext(chainId)
      const projectId = get().activeProjectId
      if (!context || !projectId) return { ok: false, reasons: ['The chain is not on an open canvas.'] }
      const settings = context.settings
      const compile = compileLoraTimeline(readLoraTimelineDoc(settings.loraTimeline), settings.duration)
      if (!compile.ok) {
        get().toast('error', `The LoRA timeline did not compile — ${compile.reasons[0]}`)
        return { ok: false, reasons: compile.reasons }
      }
      const planDocument = loraTimelineToPlanDocument(compile, {
        prompt: settings.prompt,
        referenceCharacterIds: settings.referenceCharacterIds,
        referenceLocationIds: settings.referenceLocationIds,
      })
      try {
        const plan = await documentsApi.upsertPlan({ projectId, document: planDocument as unknown as Record<string, unknown> })
        // Seed every segment's chain (the Apply click IS the consent — created
        // + selected, never submitted). The source chain's render shape rides
        // along; each segment's OWN stack is the whole point.
        const seeded: Array<{ segmentId: string; chainId: string }> = []
        for (const segment of compile.segments) {
          const newChainId = await get().seedChain({
            prompt: settings.prompt,
            mediaType: 'video',
            duration: Number(segment.durationSeconds.toFixed(3)),
            resolution: settings.resolution,
            turbo: settings.turbo,
            turboFamily: settings.turboFamily,
            steps: settings.steps,
            refImageSize: settings.refImageSize,
            clothingPolicy: settings.clothingPolicy,
            noDialogue: settings.noDialogue,
            naturalMovement: settings.naturalMovement,
            referenceCharacterIds: settings.referenceCharacterIds,
            referenceLocationIds: settings.referenceLocationIds,
            loraStack: segment.loras.map((entry) => ({ ...entry })),
          })
          if (!newChainId) {
            get().toast('error', `Segment “${segment.title}” could not seed — the plan is saved; seed the rest from the timeline.`)
            break
          }
          seeded.push({ segmentId: segment.id, chainId: newChainId })
        }
        if (seeded.length) {
          await get().updatePlanDocument(plan.id, (current) => ({
            ...current,
            segments: current.segments.map((segment) => {
              const match = seeded.find((entry) => entry.segmentId === segment.id)
              return match ? { ...segment, chainId: match.chainId } : segment
            }),
          }))
        }
        set({ timelinePlanId: plan.id, timelineOpen: true })
        get().toast('success', `Compiled ${compile.segments.length} LoRA segment${compile.segments.length === 1 ? '' : 's'} (${compile.totalSeconds.toFixed(1)}s planned, 17n+5 grid) — seeded as objects. Generate from the timeline.`)
        return { ok: true, planId: plan.id }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        get().toast('error', `The LoRA timeline could not compile: ${message}`)
        return { ok: false, reasons: [message] }
      }
    },

    setSettingsDock: (open) => {
      set({ settingsDock: open })
    },
    raiseDock: () => {
      const next = get().dockZ + 1
      set({ dockZ: next })
      return next
    },
    setDiagnosticsDock: (open) => set({ diagnosticsDock: open }),
    setAudioDock: (dock) => set({ audioDock: dock }),

    validateAudioDraft: (engine, caption) => {
      const facts = engineFacts()
      if (!caption.trim()) return engine === 'music3' ? 'Write at least one caption section before generating.' : 'Describe the track (tags) before generating.'
      if (engine === 'music3') {
        return validateMusic3(
          { caption, lyrics: '', duration: 60, seed: 1, tiledDecode: true, filenamePrefix: 'audio/plan' },
          { connected: facts.connected, selection: music3SelectionOf() },
        )
      }
      return validateAceStep(
        { model: 'base', tags: caption, lyrics: '', instrumental: false, duration: 60, seed: 1, bpm: 120, timeSignature: '4', language: 'en', keyScale: 'C major', generateAudioCodes: false, filenamePrefix: 'audio/plan' },
        { connected: facts.connected, info: facts.info, selection: aceSelectionOf() },
      )
    },

    createAudioChain: async (engine, caption) => {
      const state = get()
      let projectId = state.activeProjectId
      if (!projectId) {
        const created = await get().createCanvas()
        if (!created) return null
        projectId = created
      }
      try {
        const chain = await documentsApi.createChain({
          projectId,
          kind: 'generation',
          settings: {
            ...chainSettingsDefaults(useSessionStore.getState().settings),
            prompt: caption,
            mediaType: 'audio',
            audio: { engine, caption, lyrics: '', duration: 60, seed: Math.floor(Math.random() * 1_000_000_000), instrumental: false, model: 'base', bpm: 120 },
          } as unknown as Record<string, unknown>,
        })
        if (!chain) return null
        set({ viewDirty: true })
        const anchor = { x: 120, y: 96, w: TILE_W }
        const spawn = avoidOverlap(anchor, get().tiles.map((tile) => ({ x: tile.x, y: tile.y, w: tile.w, h: tile.h })))
        set((current) => ({ layout: { ...(current.layout ?? {}), [chain.id]: spawn } }))
        const refreshed = await loadDocument(projectId)
        if (refreshed) recomputeTiles()
        set({ selection: { tileIds: [chain.id] } })
        get().requestCamera({ kind: 'fly', tileId: chain.id })
        get().persistView()
        return chain.id
      } catch (error) {
        get().toast('error', `The audio object could not be created: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
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
    },

    reloadActiveDocument: async () => {
      const activeId = get().activeProjectId
      if (!activeId) return
      const refreshed = await loadDocument(activeId)
      if (refreshed) {
        recomputeTiles()
        void landCompletions()
      }
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

    seedChain: async (input) => {
      let projectId = get().activeProjectId
      if (!projectId) {
        const created = await get().createCanvas()
        if (!created) return null
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
          inputSpec: { fresh: { prompt: input.prompt, mediaKind: input.mediaType ?? defaults.mediaType } },
          settings: { ...defaults, ...input },
        })
        if (!chain) return null
        const chainId = chain.id
        set((current) => ({
          layout: { ...(current.layout ?? {}), [chainId]: { x: spawn.x, y: spawn.y, w: TILE_W } },
          viewDirty: true,
        }))
        const refreshed = await loadDocument(projectId)
        if (refreshed) recomputeTiles()
        set({ selection: { tileIds: [chainId] }, inspectorOpen: true, endpointMenu: null, forkMenu: null })
        get().requestCamera({ kind: 'fly', tileId: chainId })
        get().persistView()
        return chainId
      } catch (error) {
        get().toast('error', `Could not create the object: ${error instanceof Error ? error.message : String(error)}`)
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
      // §5.4 engines-as-ops (Phase 4): AUDIO chains submit through their
      // shared cores — the dock edits the settings blob, this path executes
      // (reruns are settings-stable for audio too).
      if (settings.mediaType === 'audio') {
        const facts = engineFacts()
        if (!facts.settings) return { ok: false, message: 'Studio settings are still loading.' }
        const io = {
          notify: (tone: 'error' | 'success' | 'neutral', text: string) => get().toast(tone === 'neutral' ? 'neutral' : tone, text),
          setJobs: (update: (current: GenerationJob[]) => GenerationJob[]) => useJobsStore.getState().setJobs(update),
          cancellationRequests: engineBridge.cancellationRequests ?? { current: new Set<string>() },
          onJobCreated: (jobId: string) => {
            set((current) => ({ chainJobs: { ...current.chainJobs, [chainId]: jobId } }))
            recomputeTiles()
          },
        }
        if (settings.audio.engine === 'acestep') {
          const options: AceStepGenerationOptions = {
            model: settings.audio.model,
            tags: settings.audio.caption,
            lyrics: settings.audio.lyrics,
            instrumental: settings.audio.instrumental,
            duration: Math.max(10, Math.min(360, settings.audio.duration)),
            seed: settings.audio.seed,
            bpm: settings.audio.bpm,
            timeSignature: '4',
            language: 'en',
            keyScale: 'C major',
            generateAudioCodes: false,
            filenamePrefix: `audio/Canvas_ACEStep_${Date.now()}`,
          }
          // The canvas link rides the manifest (M1): without it a reload
          // mid-render permanently orphans the landing (chainJobs relink
          // reads manifest.canvas.chainId only).
          const result = await submitAceStep(options, { settings: facts.settings, connected: facts.connected, info: facts.info, selection: aceSelectionOf(settings.modelOverrides), clientId: engineBridge.clientId }, io, { canvas: { chainId, projectId } })
          return result.ok ? { ok: true } : { ok: false, message: result.message }
        }
        const options: Music3GenerationOptions = {
          caption: settings.audio.caption,
          lyrics: settings.audio.lyrics,
          duration: settings.audio.duration,
          seed: settings.audio.seed,
          tiledDecode: true,
          filenamePrefix: `audio/Canvas_Music3_${Date.now()}`,
        }
        const result = await submitMusic3(options, { settings: facts.settings, connected: facts.connected, info: facts.info, selection: music3SelectionOf(settings.modelOverrides), clientId: engineBridge.clientId }, io, { canvas: { chainId, projectId } })
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      }
      // §5.4 engines-as-ops, rerouted 2026-09-19 (34afx79): image INTENT is
      // engine-selected per chain (the two-slot seam in stillIntent.ts) and
      // renders H3-1F — the h3image Generate-T=1 family through the
      // workbench's SHARED submit core, so the still lands takes like any
      // chain (the packet-aware landing branch). A BOUND image (the old
      // control/canny surface) is no canvas graph at all: it hands off to
      // the workbench's Edit surface with the image anchored as Picture 1 —
      // the dated decision that retired the dead ControlNet-Union path with
      // Z-Image itself. Frames/reference modes remain H3 video concepts.
      const stillIntent = settings.mediaType === 'image' && (effectiveMode(settings) === 'text' || effectiveMode(settings) === 'image')
      if (stillIntent) {
        const mode = effectiveMode(settings)
        const facts = engineFacts()
        const queued = queuedImageEngineRefusal(settings.imageEngine)
        if (queued) {
          get().toast('error', queued)
          return { ok: false, message: queued }
        }
        if (mode === 'image') {
          if (!firstFrame) return { ok: false, message: 'Choose a first frame for this mode.' }
          // The Edit handoff: stash the bound image + intent, then full-nav
          // to the workbench (the surface-switcher precedent — the handoff
          // key carries the payload across the page load, like the poserig
          // inbox). The receiving surface announces it; no job parks here.
          stashCanvasEditHandoff(canvasEditHandoff(settings.prompt, firstFrame))
          window.location.assign('/?images=1')
          return { ok: true }
        }
        if (!facts.settings) return { ok: false, message: 'Studio settings are still loading.' }
        const result = await submitWorkbenchGeneration(
          canvasH3OneFrameRequest(chainId, settings),
          { settings: facts.settings, connected: facts.connected, models: facts.models, info: facts.info, clientId: engineBridge.clientId },
          {
            notify: (tone, text) => get().toast(tone === 'neutral' ? 'neutral' : tone, text),
            setJobs: (update) => useJobsStore.getState().setJobs(update),
            cancellationRequests: engineBridge.cancellationRequests ?? { current: new Set<string>() },
            onJobCreated: (jobId) => {
              set((current) => ({ chainJobs: { ...current.chainJobs, [chainId]: jobId } }))
              recomputeTiles()
            },
          },
        )
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      }
      const selection = selectionFor(settings.turbo, settings.turboFamily, settings.modelOverrides)
      const facts = engineFacts()
      if (!facts.settings) return { ok: false, message: 'Studio settings are still loading.' }
      // Phase 4 latent-fork gate: a substrate=latents fork renders through
      // the Motion-Context machinery — the source take's saved clip loads as
      // never-denoised conditioning (no re-encode). Honest refusals first.
      if (context.isLatentFork) {
        if (!motionContextReady()) return { ok: false, message: 'Latent continuation needs the ComfyUI-H3-Motion-Context custom nodes — install them, then refresh the engine.' }
        if (context.latentRefusal) return { ok: false, message: context.latentRefusal }
      }
      const chainOption = motionContextReady() ? canvasChainOption(chainId, context.isLatentFork ? context.latentContinuation : null) : undefined
      const request = buildCanvasRenderRequest(settings, { firstFrame, lastFrame, referenceImages: referenceMedia, referenceVideos, referenceAudios }, bindings, chainOption)
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
          modelOverrides: overrideOutcomeFor('minimax', settings.modelOverrides),
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
      const facts = engineFacts()
      // Audio engines (§5.4 Phase 4) validate through their own ladders.
      if (settings.mediaType === 'audio') {
        if (settings.audio.engine === 'acestep') {
          return validateAceStep(
            { model: settings.audio.model, tags: settings.audio.caption, lyrics: settings.audio.lyrics, instrumental: settings.audio.instrumental, duration: settings.audio.duration, seed: settings.audio.seed, bpm: settings.audio.bpm, timeSignature: '4', language: 'en', keyScale: 'C major', generateAudioCodes: false, filenamePrefix: 'audio/plan' },
            { connected: facts.connected, info: facts.info, selection: aceSelectionOf(settings.modelOverrides) },
          )
        }
        return validateMusic3(
          { caption: settings.audio.caption, lyrics: settings.audio.lyrics, duration: settings.audio.duration, seed: settings.audio.seed, tiledDecode: true, filenamePrefix: 'audio/plan' },
          { connected: facts.connected, selection: music3SelectionOf(settings.modelOverrides) },
        )
      }
      // The stills intent (34afx79) validates through the seam: the queued
      // second engine refuses honestly; image+control states the Edit-surface
      // handoff; H3-1F rides the workbench's own ladder (family availability
      // on the H3 stack, exactly like the workbench surface gates it).
      if (settings.mediaType === 'image' && (effectiveMode(settings) === 'text' || effectiveMode(settings) === 'image')) {
        const queued = queuedImageEngineRefusal(settings.imageEngine)
        if (queued) return queued
        if (effectiveMode(settings) === 'image') {
          return firstFrame
            ? 'Image-with-reference renders on the workbench\'s Edit surface — generate opens it with this image anchored as the source (Picture 1). The canvas ships no control-stills path (dated 2026-09-19, task 34afx79).'
            : 'Choose a first frame for this mode.'
        }
        if (!facts.settings) return 'Studio settings are still loading.'
        return validateWorkbenchRequest(
          canvasH3OneFrameRequest(chainId, settings),
          { settings: facts.settings, connected: facts.connected, models: facts.models, info: facts.info },
        )
      }
      // The latent-fork gate (Phase 4): honest refusals before the H3 ladder.
      if (context.isLatentFork) {
        if (!motionContextReady()) return 'Latent continuation needs the ComfyUI-H3-Motion-Context custom nodes — install them, then refresh the engine.'
        if (context.latentRefusal) return context.latentRefusal
      }
      const selection = selectionFor(settings.turbo, settings.turboFamily, settings.modelOverrides)
      const request = buildCanvasRenderRequest(settings, { firstFrame, lastFrame, referenceImages: referenceMedia, referenceVideos, referenceAudios }, bindings)
      return validateH3Render(request, {
        connected: facts.connected,
        modelReady: facts.settings ? modelReadyFor(selection, settings.turbo) : false,
        selection,
        h3PreviewOverrideNode: findH3PreviewOverrideNode(facts.info) || undefined,
        modelOverrides: overrideOutcomeFor('minimax', settings.modelOverrides),
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
            ...(source.withUpscale ? { upscaleMode: 'rtx' as const } : {}),
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
      // The 'r' gesture clears what it remediates (M2) — the SAME
      // clear-on-ok step rerunChain uses, per chain: a submit that goes out
      // clears the stale flag; a refused (offline) submit leaves the chain
      // visibly stale. Without this, every rerun landed but the objects
      // stayed flagged stale forever.
      for (const tile of stale) {
        const result = await get().submitChain(tile.id)
        if (result.ok) {
          try {
            await documentsApi.updateChain({ id: tile.id, stale: false })
          } catch {
            // The rerun went out; the flag clear is retried on the next
            // document write (the rerunChain precedent).
          }
        }
      }
      const doc = activeDocument()
      if (doc) {
        const refreshed = await loadDocument(doc.project.id)
        if (refreshed) recomputeTiles()
      }
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
          const mode = (settings && typeof settings.mode === 'string' ? settings.mode : 'rtx') as CanvasChainSettings['upscaleMode']
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
        if (typeof settings.mode === 'string' && ['rtx', 'lbh2d', 'lbh3d'].includes(settings.mode)) {
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
      const selection = selectionFor('off', '')
      // The audio engines (§5.4 Phase 4): detection over the shared infer*,
      // with global overrides consulted (euxwdva).
      const music3Selection = music3SelectionOf()
      const aceSelection = aceSelectionOf()
      return {
        connected: facts.connected,
        h3Ready: modelReadyFor(selection, 'off'),
        motionContextReady: MOTION_CONTEXT_NODES.every((node) => Boolean(facts.info[node])),
        music3: {
          available: Boolean(facts.connected && music3Selection.diffusion && music3Selection.textEncoder && music3Selection.vae),
          missing: [music3Selection.diffusion ? '' : 'Music 3 diffusion model', music3Selection.textEncoder ? '' : 'Music 3 text encoder', music3Selection.vae ? '' : 'Music 3 DAV VAE'].filter(Boolean),
        },
        acestep: {
          available: Boolean(facts.connected && (aceSelection.base || aceSelection.sft) && aceSelection.vae && aceSelection.textEncoderSmall && aceSelection.textEncoderLarge),
          missing: [(aceSelection.base || aceSelection.sft) ? '' : 'ACE-Step XL model', aceSelection.vae ? '' : 'ACE audio VAE', (aceSelection.textEncoderSmall && aceSelection.textEncoderLarge) ? '' : 'Qwen ACE text encoders'].filter(Boolean),
        },
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
    value: async (name: string) => {
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
      if (name === 'live-progress') {
        // F6 seam: park a RUNNING job with a promptId on the first seed
        // chain — the fabric's live events for that promptId then drive the
        // tile's progress readout and preview painter exactly as a real
        // engine submission would (the e2e fake engine emits them targeted).
        const tile = state.tiles.find((entry) => entry.kind === 'seed' && !entry.jobId)
        if (!tile) return { ok: false, reason: 'no unlinked seed chain' }
        const jobId = `${CANVAS_MOCK_JOB_PREFIX}${tile.id}`
        useCanvasStore.setState((current) => ({ chainJobs: { ...current.chainJobs, [tile.id]: jobId } }))
        useJobsStore.getState().setJobs((jobs) => [...jobs.filter((job) => job.id !== jobId), {
          id: jobId, mode: 'text', prompt: tile.prompt, createdAt: Date.now(), status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start', promptId: 'e2e-live-1',
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
      if (name === 'complete-mock-remote') {
        // B2: complete the first linked job the way an EXTERNAL-engine render
        // completes — no local output path, only the (translated) media URL
        // carrying the engine's exact output descriptor. With no engine
        // reachable, the bounded landing attempts exhaust and the failure
        // parks VISIBLY on the object (an errored take with the reason and
        // the preserved descriptor) — never a silent idle tile.
        const entry = Object.entries(state.chainJobs)[0]
        if (!entry) return { ok: false, reason: 'no linked job' }
        const [chainId, jobId] = entry
        useJobsStore.getState().setJobs((jobs) => jobs.map((job) => job.id === jobId ? {
          ...job, status: 'completed', progress: 100, localOutputPath: undefined,
          outputUrl: '/api/lan/media?filename=Canvas_Remote_Mock.mp4&subfolder=video&type=output',
          manifest: { canvas: { chainId, projectId: 'mock' } },
        } : job))
        for (let tick = 0; tick < 12; tick += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 120))
          useCanvasStore.getState().recompute()
          const doc = useCanvasStore.getState().documents[useCanvasStore.getState().activeProjectId ?? ''] ?? null
          const take = doc?.chains.find((chain) => chain.id === chainId)?.outputs[0]?.takes.find((candidate) => candidate.jobId === jobId) ?? null
          if (take) {
            const tile = useCanvasStore.getState().tiles.find((candidate) => candidate.id === chainId) ?? null
            return {
              ok: true, jobId, chainId,
              landedError: typeof take.metrics?.landingError === 'string' ? take.metrics.landingError : null,
              descriptorPreserved: take.metrics?.outputFile && typeof (take.metrics.outputFile as Record<string, unknown>).filename === 'string' ? (take.metrics.outputFile as Record<string, unknown>).filename : null,
              artifacts: take.artifacts.length,
              tileStatus: tile?.status ?? null,
            }
          }
        }
        return { ok: false, reason: 'the errored landing never parked (no take with the job id)' }
      }
      if (name === 'seed-audio-mock') {
        // M1: create an audio chain the way the dock does, then park the
        // mock queued job WITH the canvas manifest link — exactly the record
        // the fixed audio submit cores write. A RELOAD must rebuild the
        // chainJobs link from that manifest, so completing the job after the
        // reload lands the take on the audio chain (the orphaned-landing
        // regression: pre-fix audio jobs carried no manifest).
        const chainId = await state.createAudioChain('music3', 'upbeat courtyard drums')
        if (!chainId) return { ok: false, reason: 'createAudioChain returned no id' }
        const projectId = useCanvasStore.getState().activeProjectId
        if (!projectId) return { ok: false, reason: 'no active project' }
        const jobId = `${CANVAS_MOCK_JOB_PREFIX}audio:${chainId}`
        useJobsStore.getState().setJobs((jobs) => [...jobs.filter((job) => job.id !== jobId), {
          id: jobId, mode: 'text', prompt: 'upbeat courtyard drums', createdAt: Date.now(), status: 'queued', progress: 0,
          width: 0, height: 0, duration: 60, provider: 'music3', mediaType: 'audio',
          manifest: { canvas: { chainId, projectId } },
        }])
        useCanvasStore.getState().recompute()
        return { ok: true, chainId, jobId, projectId }
      }
      if (name === 'rerun-stale-clears') {
        // M2: the 'r' gesture must clear the stale flags it remediates. The
        // submit itself is stubbed ok (the gesture's contract is under test,
        // not the engine) — exactly the rerunChain clear-on-ok step. The
        // assertions read the SERVER document (the persisted flag).
        const target = useCanvasStore.getState().tiles[0]
        if (!target) return { ok: false, reason: 'no tile' }
        const projectId = useCanvasStore.getState().activeProjectId
        if (!projectId) return { ok: false, reason: 'no active project' }
        await documentsApi.updateChain({ id: target.id, stale: true })
        const before = await documentsApi.getProject(projectId)
        if (!before.chains.find((chain) => chain.id === target.id)?.stale) return { ok: false, reason: 'the chain did not mark stale' }
        // Drop the cached document and reopen — the tiles must re-derive with
        // the stale flag so rerunStale's sweep sees the chain.
        useCanvasStore.setState((current) => ({ activeProjectId: null, documents: Object.fromEntries(Object.entries(current.documents).filter(([key]) => key !== projectId)) }))
        await useCanvasStore.getState().openProject(projectId)
        const realSubmit = useCanvasStore.getState().submitChain
        useCanvasStore.setState({ submitChain: async () => ({ ok: true }) })
        try {
          await useCanvasStore.getState().rerunStale()
        } finally {
          useCanvasStore.setState({ submitChain: realSubmit })
        }
        const after = await documentsApi.getProject(projectId)
        const chainAfter = after.chains.find((chain) => chain.id === target.id)
        return { ok: true, chainId: target.id, staleCleared: chainAfter ? chainAfter.stale === false : null }
      }
      if (name === 'complete-mock-latent') {
        // Phase 4: complete the first linked job the way a Motion-Context
        // render completes — the manifest carries the saved-clip facts, so
        // the landed take records latentPath + metrics.motionContext (the
        // substrate=latents fork's source of truth). Exercises the REAL
        // landing path; no engine needed.
        const entry = Object.entries(state.chainJobs)[0]
        if (!entry) return { ok: false, reason: 'no linked job' }
        const mediaTile = state.tiles.find((tile) => tile.kind === 'media' && tile.previewPath)
        if (!mediaTile) return { ok: false, reason: 'no media take to land' }
        const [chainId, jobId] = entry
        const sourcePath = mediaTile.previewPath ?? ''
        if (!sourcePath) return { ok: false, reason: 'no stored source path' }
        useJobsStore.getState().setJobs((jobs) => jobs.map((job) => job.id === jobId ? {
          ...job, status: 'completed', progress: 100, localOutputPath: sourcePath,
          manifest: { canvas: { chainId, projectId: 'mock' }, motionContext: { folder: `h3_context/${chainId}/clip`, clipIndex: 0 } },
        } : job))
        useCanvasStore.getState().recompute()
        return { ok: true, jobId, chainId, folder: `h3_context/${chainId}/clip` }
      }
      if (name === 'stale-worst') {
        const tile = state.tiles.find((entry) => entry.status === 'stale') ?? state.tiles[0]
        if (!tile) return { ok: false, reason: 'no tile' }
        return { ok: true, tileId: tile.id }
      }
      if (name === 'seed-chain') {
        // Phase 5 (Studios dock): drive the REAL MoviePlanner shot-handoff
        // path — a chain seeded from compiled shot settings, CONSENT-GATED
        // (created + selected, never submitted; no job may exist for it).
        const jobsBefore = useJobsStore.getState().jobs.length
        const chainId = await useCanvasStore.getState().seedChain({
          prompt: 'the drummer steps off the night train into the rain',
          mediaType: 'video',
          duration: 9,
          resolution: '768x1344',
          referenceCharacterIds: [],
          referenceLocationIds: [],
        })
        if (!chainId) return { ok: false, reason: 'seedChain returned no id' }
        const after = useCanvasStore.getState()
        return {
          ok: true,
          chainId,
          selected: after.selection.tileIds[0] === chainId,
          inspector: after.inspectorOpen,
          jobsCreated: useJobsStore.getState().jobs.length - jobsBefore,
          // async document writes settle before the e2e reads activeDocument
        }
      }
      return { ok: false, reason: `unknown scenario ${name}` }
    },
  })

  /** Engine-free submit-plan probe: maps a selection spec through the REAL
   *  builder + graph construction and returns the built graph's facts plus
   *  the honest validation against the live session (offline → the real
   *  refusal string). This is what the e2e suite asserts per mode. The
   *  stills intent (34afx79) routes through the H3-1F seam — `imageEngine`
   *  selects the slot. Phase 4: `mediaType: 'audio'` routes through the
   *  audio cores; `latentFrom` builds the Motion-Context latent-fork
   *  graph. */
  Object.defineProperty(window, '__canvasSubmitPlan', {
    configurable: true,
    value: (spec: {
      prompt?: string
      mediaType?: 'video' | 'image' | 'audio'
      engine?: 'h3'
      imageEngine?: 'h3-1f' | 'krea2'
      audioEngine?: 'music3' | 'acestep'
      firstFrameOutputId?: string | null
      lastFrameOutputId?: string | null
      referenceOutputIds?: string[]
      referenceCharacterIds?: string[]
      turbo?: 'off' | '4' | '8'
      duration?: number
      resolution?: string
      latentFrom?: { folder: string; clipIndex: number }
      /** Chain-level model overrides (euxwdva) — merged over the global
       *  Settings picks exactly like a real chain's would be. */
      modelOverrides?: ModelOverrideSlots
    }) => {
      const settings = {
        ...chainSettingsDefaults(useSessionStore.getState().settings),
        prompt: spec.prompt ?? 'a lone drummer on a night train',
        mediaType: spec.mediaType ?? 'video',
        engine: spec.engine ?? 'h3',
        imageEngine: spec.imageEngine ?? 'h3-1f',
        firstFrameOutputId: spec.firstFrameOutputId ?? null,
        lastFrameOutputId: spec.lastFrameOutputId ?? null,
        referenceOutputIds: spec.referenceOutputIds ?? [],
        referenceCharacterIds: spec.referenceCharacterIds ?? [],
        turbo: spec.turbo ?? 'off',
        duration: spec.duration ?? 6,
        resolution: spec.resolution ?? '1344x768',
      }
      // Audio engines (§5.4 Phase 4): the dock's plan seam.
      if (settings.mediaType === 'audio') {
        const facts = engineFacts()
        const audioEngine = spec.audioEngine ?? 'music3'
        if (audioEngine === 'music3') {
          const validation = validateMusic3(
            { caption: settings.prompt, lyrics: '', duration: 60, seed: 1, tiledDecode: true, filenamePrefix: 'audio/plan' },
            { connected: facts.connected, selection: music3SelectionOf() },
          )
          const graph = buildMusic3Workflow({ caption: settings.prompt, lyrics: '', duration: 60, seed: 1, tiledDecode: true, filenamePrefix: 'audio/MUSIC3_plan' }, { diffusion: 'TEST-music3.safetensors', textEncoder: 'TEST-music3-te.safetensors', vae: 'TEST-music3-dav.safetensors' })
          const nodes = Object.values(graph)
          return {
            mode: 'music3',
            validation,
            graph: {
              nodeClasses: nodes.map((node) => node.class_type),
              saveAudio: nodes.some((node) => node.class_type === 'SaveAudioAdvanced'),
              textEncode: nodes.some((node) => node.class_type === 'MiniMaxMusic3TextEncode'),
              total: nodes.length,
            },
          }
        }
        const validation = validateAceStep(
          { model: 'base', tags: settings.prompt, lyrics: '', instrumental: false, duration: 60, seed: 1, bpm: 120, timeSignature: '4', language: 'en', keyScale: 'C major', generateAudioCodes: false, filenamePrefix: 'audio/plan' },
          { connected: facts.connected, info: facts.info, selection: aceSelectionOf() },
        )
        const graph = buildAceStepWorkflow(
          { model: 'base', tags: settings.prompt, lyrics: '', instrumental: false, duration: 60, seed: 1, bpm: 120, timeSignature: '4', language: 'en', keyScale: 'C major', generateAudioCodes: false, filenamePrefix: 'audio/ACE_plan' },
          { base: 'TEST-ace-base.safetensors', sft: 'TEST-ace-sft.safetensors', vae: 'TEST-ace-vae.safetensors', textEncoderSmall: 'TEST-qwen06b.safetensors', textEncoderLarge: 'TEST-qwen4b.safetensors' },
        )
        const nodes = Object.values(graph)
        return {
          mode: 'acestep',
          validation,
          graph: {
            nodeClasses: nodes.map((node) => node.class_type),
            saveAudio: nodes.some((node) => node.class_type === 'SaveAudioAdvanced'),
            textEncode: nodes.some((node) => node.class_type === 'TextEncodeAceStepAudio1.5'),
            total: nodes.length,
          },
        }
      }
      // The LTX-2.5 general engine plan branch was removed with LTX
      // (Phase 0, 2026-09-20) — H3 and the audio engines remain the plan
      // seams below.

      // The stills intent (34afx79): the seam's plan — the queued engine
      // refuses, image+control reports the Edit-surface handoff (no graph is
      // the honest answer there), and H3-1F maps through the same request the
      // submit core builds (the T=1 graph facts the e2e asserts; the golden
      // for the inline shape lives in the h3img matrix as canvas-t1-inline).
      if (settings.mediaType === 'image' && (effectiveMode(settings) === 'text' || effectiveMode(settings) === 'image')) {
        const facts = engineFacts()
        const queued = queuedImageEngineRefusal(settings.imageEngine)
        if (queued) return { mode: 'image-queued-engine', validation: queued, graph: null }
        const snapshot = useCanvasStore.getState()
        const doc = snapshot.activeProjectId ? snapshot.documents[snapshot.activeProjectId] : null
        const outputs = doc ? buildOutputIndex(doc) : new Map()
        const controlImage = settings.firstFrameOutputId ? mediaForOutput(outputs.get(settings.firstFrameOutputId))?.media ?? null : null
        if (effectiveMode(settings) === 'image') {
          return {
            mode: 'h3-1f-edit-handoff',
            validation: controlImage
              ? 'Image-with-reference renders on the workbench\'s Edit surface — generate opens it with this image anchored as the source (Picture 1).'
              : 'Choose a first frame for this mode.',
            handoff: { surface: '/?images=1', family: 'h3img.edit.freeform', sourceAnchored: Boolean(controlImage) },
            graph: null,
          }
        }
        const request = canvasH3OneFrameRequest('plan', settings)
        const validation = !facts.settings
          ? 'Studio settings are still loading.'
          : validateWorkbenchRequest(request, { settings: facts.settings, connected: facts.connected, models: facts.models, info: facts.info })
        const graph = buildH3ImageGraph({
          family: request.settings.family,
          prompt: sessionContract(request.settings, { sourceAnchored: false }),
          width: Number(settings.resolution.split('x')[0]) || 1344,
          height: Number(settings.resolution.split('x')[1]) || 768,
          seed: settings.seed,
          tier: H3IMG_RECIPE_PINS.t1.frames,
          refs: [],
          loras: [],
          filenamePrefix: 'images/H3IMG_plan',
        }, CANVAS_T1_TEST_SELECTION, facts.info)
        const nodes = Object.values(graph)
        return {
          mode: 'h3-1f',
          validation,
          graph: {
            nodeClasses: nodes.map((node) => node.class_type),
            hybrid: nodes.some((node) => node.class_type === 'MiniMaxH3HybridLoader'),
            unetModel: (nodes.find((node) => node.class_type === 'UNETLoader')?.inputs.unet_name ?? null) as string | null,
            t1Vae: (nodes.find((node) => node.class_type === 'VAELoader')?.inputs.vae_name ?? null) as string | null,
            sampler: nodes.find((node) => node.class_type === 'KSamplerSelect')?.inputs.sampler_name ?? null,
            scheduler: nodes.find((node) => node.class_type === 'BasicScheduler')?.inputs.scheduler ?? null,
            steps: nodes.find((node) => node.class_type === 'BasicScheduler')?.inputs.steps ?? null,
            loadImageCount: nodes.filter((node) => node.class_type === 'LoadImage').length,
            saveImageCount: nodes.filter((node) => node.class_type === 'SaveImage').length,
            total: nodes.length,
          },
        }
      }
      const snapshot = useCanvasStore.getState()
      const doc = snapshot.activeProjectId ? snapshot.documents[snapshot.activeProjectId] : null
      const outputs = doc ? buildOutputIndex(doc) : new Map()
      const resolveMedia = (outputId: string) => mediaForOutput(outputs.get(outputId))
      const bindings = resolveChainReferences(settings, snapshot.libraries, resolveMedia, snapshot.assets)
      const firstFrame = settings.firstFrameOutputId ? resolveMedia(settings.firstFrameOutputId)?.media ?? null : null
      const lastFrame = settings.lastFrameOutputId ? resolveMedia(settings.lastFrameOutputId)?.media ?? null : null
      const referenceMedia = settings.referenceOutputIds.map((outputId) => resolveMedia(outputId)?.media ?? null).filter(Boolean)
      // Phase 4: the latent-fork chain option (the offline seam asserts the
      // Motion-Context node shape without an engine).
      const chainOption = spec.latentFrom ? canvasChainOption('plan', spec.latentFrom) : motionContextReady() ? canvasChainOption('plan', null) : undefined
      const request = buildCanvasRenderRequest(settings, { firstFrame, lastFrame, referenceImages: referenceMedia as MediaFile[], referenceVideos: [], referenceAudios: [] }, bindings, chainOption)
      const facts = engineFacts()
      const selection = selectionFor(settings.turbo, settings.turboFamily, spec.modelOverrides)
      const validation = validateH3Render(request, {
        connected: facts.connected,
        modelReady: facts.settings ? modelReadyFor(selection, settings.turbo) : false,
        selection,
        h3PreviewOverrideNode: findH3PreviewOverrideNode(facts.info) || undefined,
        modelOverrides: overrideOutcomeFor('minimax', spec.modelOverrides),
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
      const loadLatent = graph['24'] as { class_type: string; inputs: Record<string, unknown> } | undefined
      const saveLatent = graph['28'] as { class_type: string; inputs: Record<string, unknown> } | undefined
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
          motionContext: {
            loadLatent: loadLatent?.class_type === 'MiniMaxH3MotionContextLoadLatent' ? loadLatent.inputs : null,
            context: nodes.some((node) => node.class_type === 'MiniMaxH3MotionContext'),
            saveLatent: saveLatent?.class_type === 'MiniMaxH3MotionContextSaveLatent' ? saveLatent.inputs : null,
            trim: nodes.some((node) => node.class_type === 'MiniMaxH3MotionContextTrim'),
          },
          total: nodes.length,
        },
      }
    },
  })
}
