/**
 * Canvas Phase 2 — generation as a document projection (§5.4 engines-as-ops,
 * L4 DECIDED: selection decides the surface).
 *
 * PURE module: the per-chain generation settings schema (the unwound
 * singleton — these live in chain.settings in the document store), the
 * L4 selection→mode mapping, reference binding for canvas chains (the
 * promptComposer/useCreateWorkspace logic re-homed per chain), the
 * H3RenderRequest builder both surfaces share (lib/h3Submit), the
 * engine-free graph plan the tests and the option menus consume, and the
 * fork input-spec construction (§2 outputRef substrates). No React, no DOM,
 * no stores — covered by scripts/test-canvas.cjs through the VM harness.
 */
import type { AppSettings, CharacterProject, GenerationMode, LocationProject, MediaFile, ModelOverrideSlots, ModelSelection, MovieReferenceBinding, UpscaleMode, WardrobeProject } from '../types'
import type { ComfyPrompt } from '../lib/graph'
import { imageEngineChoices } from '../lib/graph/engineFamilies'
import { buildMiniMaxWorkflow } from '../lib/workflow'
import { allocateWorkspaceReferences } from '../lib/promptComposer'
import { characterReferences } from '../lib/characterLibrary'
import { locationReferences } from '../lib/locationLibrary'
import { composeH3Prompt, resolveRenderReferenceImages } from '../lib/promptPolicies'
import { readStructuredDraft, type StructuredPromptDraft } from '../lib/structuredPrompt'
import type { H3RenderRequest } from '../lib/h3Submit'
import type { DocumentChain, DocumentTake } from './derive'
import { readLoraTimelineDoc, type LoraTimelineDoc } from './loraTimeline'

// ---- per-chain generation settings (the unwound workspace singleton) --------

export type CanvasChainSettings = {
  prompt: string
  /** Recorded entry intent (§4 launcher chips). H3 renders video; the image
   *  generator absorption (Z-Image) is the §5.4/Phase-4 seam. The audio
   *  engine (Music 3) creates mediaType 'audio' chains. */
  mediaType: 'video' | 'image' | 'audio'
  /** §5.4 engines-as-ops (Phase 4): which engine a video chain renders
   *  through — H3 (the only engine since LTX's removal, Phase 0 2026-09-20;
   *  the field survives as the documented seam). */
  engine: 'h3'
  /** The image intent's engine (34afx79, 2026-09-19) — the two-slot typed
   *  hole: H3-1F (the h3image Generate-T=1 family) is wired today; Krea 2
   *  stills (mf3wfq6, queued) is the second slot and docks into the same
   *  switch without another rewire. The Z-Image surface this replaced is
   *  retired (lib/zImageSubmit.ts deleted). */
  imageEngine: 'h3-1f' | 'krea2'
  /** Audio-engine facts (mediaType 'audio', Phase 4): which engine + its
   *  request options. The audio dock writes them; submitChain reads them —
   *  reruns are settings-stable (invariant 1) for audio too. Fields the
   *  active engine ignores are simply not read.
   *
   *  'acestep' survives ONLY as stored-document tolerance (the engine was
   *  cut 2026-09-21, nn5ld47 — git history is the archive): the read
   *  preserves it so validate/submit REFUSE honestly instead of silently
   *  rendering a Music 3 track from an ACE-Step chain's tags. The app
   *  itself never writes it. */
  audio: {
    engine: 'music3' | 'acestep'
    /** Music 3: the caption sections. */
    caption: string
    lyrics: string
    duration: number
    seed: number
  }
  duration: number
  resolution: string
  turbo: 'off' | '4' | '8'
  /** Explicit turbo family (optimization-registry entry id, '' = auto-rank). */
  turboFamily: string
  turboLoader: 'auto' | 'plain'
  steps: number
  seed: number
  loraStrength: number
  refImageSize: 'match' | 'max'
  clothingPolicy: 'wardrobe' | 'underwear' | 'unrestricted'
  noDialogue: boolean
  naturalMovement: boolean
  upscaleMode: UpscaleMode
  // L4 selection roles — output ids this chain consumes (typed-hole menus
  // and the properties panel write these; effectiveMode reads them).
  firstFrameOutputId: string | null
  lastFrameOutputId: string | null
  /** Ordered canvas-output references (ref2v <Picture N> sources). */
  referenceOutputIds: string[]
  /** Character/location library bindings (the promptComposer model). */
  referenceCharacterIds: string[]
  referenceLocationIds: string[]
  /** GLOBAL asset-store bindings (Phase 4, §2 asset): consent-gated
   *  fork-into-project first, then their canonical reference sets ride the
   *  same ordered <Picture N> budget. */
  referenceAssetIds: string[]
  /** Reference-mode keyframe guides (§2: persist as chain settings). */
  timelineGuides: Array<{ file: MediaFile; seconds: number }>
  /** Structured H3 prompt editor (fh94g76): which prompt surface is active.
   *  `prompt` stays the single source of truth for the engine — in structured
   *  mode it always holds composeStructuredPrompt(structured); the concat
   *  contract means the engine sees no difference between the modes. */
  promptMode: 'freeform' | 'structured'
  /** The box draft (null in freeform mode; the deterministic parse fills it
   *  on toggle so the switch never loses text). */
  structured: StructuredPromptDraft | null
  /** The chain's temporal LoRA stack (7twfk6o): 0–2 user LoRAs loaded after
   *  the turbo seam, orthogonal to the tier (a quality-tier render may still
   *  carry style LoRAs). Empty = the base look. */
  loraStack: Array<{ name: string; strength: number }>
  /** The authored LoRA-timeline doc (painted ranges + boundary transitions)
   *  this chain compiles into plan segments — null when never painted. */
  loraTimeline: LoraTimelineDoc | null
  /** Chain-level model overrides (task euxwdva): explicit checkpoint /
   *  text-encoder / VAE picks for THIS chain's engine family, over the
   *  global (Settings) picks, over inference. Empty/absent = auto — the
   *  chain renders exactly as before. Resolution order and the family slot
   *  maps: src/lib/modelOverrides.ts (chain > global > auto). */
  modelOverrides: ModelOverrideSlots
}

const RESOLUTIONS = ['1344x768', '768x1344', '768x768']

/** The image intent's engine selection (34afx79) — DERIVED from the
 *  engine-family registry (A-3, Wave 3 rung 1) so the two-slot table and
 *  the registry cannot drift. The second slot is a TYPED HOLE: Krea 2
 *  stills (mf3fwq6) docks into submitChain's imageEngine switch without
 *  another rewire (the audio-engine precedent — one union, one switch, one
 *  honest refusal until its core lands). The cast pins the settings
 *  schema's literal union (the registry is the open set). */
export const IMAGE_ENGINES: Array<{ id: 'h3-1f' | 'krea2'; label: string; note: string }> = imageEngineChoices() as Array<{ id: 'h3-1f' | 'krea2'; label: string; note: string }>

/** Defaults mirror the Create workspace's defaults (workspaceDefaults) plus
 *  the project's saved generation defaults — the canvas chain starts where
 *  the old surface would, then diverges per chain. */
export function chainSettingsDefaults(settings?: AppSettings | null): CanvasChainSettings {
  const defaults = settings?.generationDefaults
  return {
    prompt: '',
    mediaType: 'video',
    engine: 'h3',
    imageEngine: 'h3-1f',
    audio: { engine: 'music3', caption: '', lyrics: '', duration: 60, seed: Math.floor(Math.random() * 1_000_000_000) },
    duration: defaults?.duration ?? 6,
    resolution: defaults?.resolution && RESOLUTIONS.includes(defaults.resolution) ? defaults.resolution : '1344x768',
    turbo: defaults?.turbo ?? 'off',
    turboFamily: '',
    turboLoader: 'auto',
    steps: defaults?.steps ?? 30,
    seed: Math.floor(Math.random() * 1_000_000_000),
    loraStrength: defaults?.loraStrength ?? 1,
    refImageSize: defaults?.refImageSize ?? 'match',
    clothingPolicy: 'wardrobe',
    noDialogue: true,
    naturalMovement: true,
    upscaleMode: 'off',
    firstFrameOutputId: null,
    lastFrameOutputId: null,
    referenceOutputIds: [],
    referenceCharacterIds: [],
    referenceLocationIds: [],
    referenceAssetIds: [],
    timelineGuides: [],
    promptMode: 'freeform',
    structured: null,
    loraStack: [],
    loraTimeline: null,
    modelOverrides: {},
  }
}

/** Tolerant read of chain.settings → CanvasChainSettings (documents are
 *  external data: absent keys fall back to the defaults, wrong types fall
 *  back per-key, never a crash). */
export function readChainSettings(raw: Record<string, unknown>, settings?: AppSettings | null): CanvasChainSettings {
  const base = chainSettingsDefaults(settings)
  const str = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
  const idList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [])
  const audioRaw = (raw.audio && typeof raw.audio === 'object' ? raw.audio : {}) as Record<string, unknown>
  const audio = {
    // A stored 'acestep' engine is PRESERVED (not coerced) so the submit
    // seam can refuse honestly — rendering Music 3 from an ACE-Step
    // chain's tags would be a silent wrong-output (the R-05 class).
    engine: audioRaw.engine === 'acestep' ? 'acestep' as const : 'music3' as const,
    caption: str(audioRaw.caption, ''),
    lyrics: str(audioRaw.lyrics, ''),
    duration: Math.max(5, Math.min(300, num(audioRaw.duration, 60))),
    seed: Math.max(0, Math.floor(num(audioRaw.seed, base.audio.seed))),
  }
  const guides = Array.isArray(raw.timelineGuides)
    ? raw.timelineGuides.filter((guide): guide is { file: MediaFile; seconds: number } => {
      if (!guide || typeof guide !== 'object') return false
      const candidate = guide as Record<string, unknown>
      return Boolean(candidate.file && typeof candidate.file === 'object' && typeof (candidate.file as MediaFile).path === 'string' && typeof candidate.seconds === 'number')
    })
    : []
  const turbo = raw.turbo === 'off' || raw.turbo === '4' || raw.turbo === '8' ? raw.turbo : base.turbo
  const policy = raw.clothingPolicy === 'wardrobe' || raw.clothingPolicy === 'underwear' || raw.clothingPolicy === 'unrestricted' ? raw.clothingPolicy : base.clothingPolicy
  // A stored 'ltx' (the removed Phase-0 mode) falls back to 'off'.
  const upscale = raw.upscaleMode === 'rtx' || raw.upscaleMode === 'lbh2d' || raw.upscaleMode === 'lbh3d' ? raw.upscaleMode : 'off'
  // Model overrides (task euxwdva): per-slot strings only; anything else
  // (wrong type, empty) drops to auto — external data never crashes the read.
  // The H3 per-lane slots (rq0lsax) and the decoder-split VAE trio (epdvxd4)
  // parse here too; legacy 'checkpoint'/'vae' picks on stored chains migrate
  // at the resolution seam, not here, so the stored settings never rewrite
  // behind the user's back.
  const modelOverrides: ModelOverrideSlots = {}
  const rawOverrides = (raw.modelOverrides && typeof raw.modelOverrides === 'object' ? raw.modelOverrides : {}) as Record<string, unknown>
  for (const slot of ['checkpoint', 'fl2va', 'ref2va', 'merged', 'textEncoder', 'vae', 'videoVae', 'audioVae', 'imageVae'] as const) {
    const value = rawOverrides[slot]
    if (typeof value === 'string' && value.trim()) modelOverrides[slot] = value.trim()
  }
  return {
    ...base,
    prompt: str(raw.prompt, base.prompt),
    mediaType: raw.mediaType === 'image' ? 'image' : raw.mediaType === 'audio' ? 'audio' : 'video',
    engine: 'h3',
    imageEngine: raw.imageEngine === 'krea2' ? 'krea2' : 'h3-1f',
    audio,
    duration: Math.max(2, Math.min(15, num(raw.duration, base.duration))),
    resolution: RESOLUTIONS.includes(str(raw.resolution, '')) ? str(raw.resolution, base.resolution) : base.resolution,
    turbo,
    turboFamily: str(raw.turboFamily, base.turboFamily),
    turboLoader: raw.turboLoader === 'plain' ? 'plain' : 'auto',
    steps: Math.max(1, Math.min(60, num(raw.steps, base.steps))),
    seed: Math.max(0, Math.floor(num(raw.seed, base.seed))),
    loraStrength: Math.max(0, Math.min(2, num(raw.loraStrength, base.loraStrength))),
    refImageSize: raw.refImageSize === 'max' ? 'max' : 'match',
    clothingPolicy: policy,
    noDialogue: bool(raw.noDialogue, base.noDialogue),
    naturalMovement: bool(raw.naturalMovement, base.naturalMovement),
    upscaleMode: upscale,
    firstFrameOutputId: typeof raw.firstFrameOutputId === 'string' && raw.firstFrameOutputId ? raw.firstFrameOutputId : null,
    lastFrameOutputId: typeof raw.lastFrameOutputId === 'string' && raw.lastFrameOutputId ? raw.lastFrameOutputId : null,
    referenceOutputIds: idList(raw.referenceOutputIds),
    referenceCharacterIds: idList(raw.referenceCharacterIds),
    referenceLocationIds: idList(raw.referenceLocationIds),
    referenceAssetIds: idList(raw.referenceAssetIds),
    timelineGuides: guides,
    promptMode: raw.promptMode === 'structured' ? 'structured' : 'freeform',
    structured: readStructuredDraft(raw.structured),
    loraStack: (Array.isArray(raw.loraStack)
      ? raw.loraStack
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
          .map((entry) => ({ name: typeof entry.name === 'string' ? entry.name : '', strength: Math.min(2, Math.max(0, num(entry.strength, 1))) }))
          .filter((entry) => entry.name)
      : []).slice(0, 2),
    loraTimeline: raw.loraTimeline && typeof raw.loraTimeline === 'object' && !Array.isArray(raw.loraTimeline) ? readLoraTimelineDoc(raw.loraTimeline) as LoraTimelineDoc : null,
    modelOverrides,
  }
}

// ---- L4: selection decides the surface ----------------------------------------

/**
 * The L4 rule as data: any reference (canvas output refs OR character/location
 * library bindings) selects reference-to-video; first+last frames select
 * first-and-last; a first frame alone selects image-to-video; otherwise
 * text-to-video. Mirrors resolveMovieShotGenerationMode's precedence.
 */
export function effectiveMode(settings: Pick<CanvasChainSettings, 'firstFrameOutputId' | 'lastFrameOutputId' | 'referenceOutputIds' | 'referenceCharacterIds' | 'referenceLocationIds' | 'referenceAssetIds'>): GenerationMode {
  const hasReferences = settings.referenceOutputIds.length > 0 || settings.referenceCharacterIds.length > 0 || settings.referenceLocationIds.length > 0 || settings.referenceAssetIds.length > 0
  if (hasReferences) return 'reference'
  if (settings.firstFrameOutputId && settings.lastFrameOutputId) return 'frames'
  if (settings.firstFrameOutputId) return 'image'
  return 'text'
}

export const MODE_LABEL: Record<GenerationMode, string> = {
  text: 'text → video',
  image: 'image → video',
  frames: 'first + last frame',
  reference: 'reference → video',
}

// ---- output refs → renderable media -------------------------------------------

export type OutputIndexEntry = { chain: DocumentChain; outputId: string; take: DocumentTake | null }

export type OutputIndex = Map<string, OutputIndexEntry>

/** Index every output of a document by output id (the resolver the roles and
 *  the fork gestures share). */
export function buildOutputIndex(document: { chains: DocumentChain[] }): OutputIndex {
  const index: OutputIndex = new Map()
  for (const chain of document.chains) {
    for (const output of chain.outputs) {
      index.set(output.id, { chain, outputId: output.id, take: output.takes.find((take) => take.supersededBy === null) ?? output.takes[0] ?? null })
    }
  }
  return index
}

/** The take a fork/role should consume for an output: the named take when the
 *  caller pinned one (fork-from-early-take), else the canonical take. */
export function takeForOutput(entry: OutputIndexEntry | undefined, takeId?: string | null): DocumentTake | null {
  if (!entry) return null
  if (takeId) return entry.chain.outputs.flatMap((output) => output.takes).find((take) => take.id === takeId) ?? null
  return entry.take
}

/**
 * Resolves an output (+ substrate choice) to the MediaFile a render can
 * upload. The VERIFIED content-addressed blob wins (m3): its bytes are what
 * this take actually produced, while metrics.sourcePath is a convenience
 * copy whose absolute path can be stale or FOREIGN after an archive import —
 * preferring it risks uploading the wrong file (or failing on a path that
 * does not exist on this machine). Blob references render + upload through
 * the server's blob seams (upload-output and the video-frame sources resolve
 * canvas-blobs/ paths); a bare absolute artifact is the pre-blob fallback.
 */
export function mediaForOutput(entry: OutputIndexEntry | undefined, takeId?: string | null): { media: MediaFile; take: DocumentTake } | null {
  const take = takeForOutput(entry, takeId)
  if (!entry || !take) return null
  const metrics = take.metrics ?? {}
  const kind = typeof metrics.kind === 'string' && ['image', 'video', 'audio'].includes(metrics.kind) ? metrics.kind as MediaFile['kind'] : null
  const blobArtifact = take.artifacts.find((artifact) => artifact.startsWith('canvas-blobs/')) ?? null
  const candidate = blobArtifact
    ?? (typeof metrics.sourcePath === 'string' && metrics.sourcePath ? metrics.sourcePath : null)
    ?? take.artifacts.find((artifact) => artifact.startsWith('/')) ?? null
  if (!candidate || !kind) return null
  const name = typeof metrics.name === 'string' && metrics.name ? metrics.name : candidate.split('/').pop() ?? candidate
  // A servable URL lets the upload path prepare the image (crop/fit) without
  // a session-picked preview object URL — canvas objects resolve from the
  // document, and prepareImage throws "No preview available" without this.
  // (blobArtifact above — the wrong-file guard's verified artifact — doubles
  // as the preferred preview source.)
  const preview = blobArtifact
    ? `/api/lan/documents/blobs/file?path=${encodeURIComponent(blobArtifact)}`
    : candidate.startsWith('/')
      ? `/api/lan/media?source=output&path=${encodeURIComponent(candidate)}`
      : undefined
  return { media: { path: candidate, name, kind, ...(preview ? { preview } : {}) }, take }
}

// ---- reference binding (the promptComposer model, per chain) -------------------

/** The libraries a chain binds references from — the SAME global stores the
 *  old surface reads (D1/D2: libraries survive shell-free as infrastructure);
 *  the panel loads them through the shared helpers, this module stays pure. */
export type CanvasLibraries = {
  characters: CharacterProject[]
  wardrobes: WardrobeProject[]
  locations: LocationProject[]
}

export const emptyLibraries: CanvasLibraries = { characters: [], wardrobes: [], locations: [] }

/** One GLOBAL asset-store entry, resolved to the shape a chain binds (Phase 4,
 *  §2 asset/F3): kind character/location with its canonical reference set as
 *  renderable picture files. The store maps canvas_asset rows here; prompt
 *  assets surface through the SmartPromptEditor library instead. */
export type CanvasAssetEntry = {
  id: string
  kind: 'character' | 'location'
  label: string
  /** The curated reference set (L13 recorded-open: curated sets, not takes). */
  images: MediaFile[]
}

/**
 * The ordered reference bindings for one chain: library allocation (the exact
 * allocateWorkspaceReferences round-robin — one authoritative picture per
 * subject/outfit/location before extras) FIRST, then canvas-output references
 * in the chain's recorded order. Reference output ids that no longer resolve
 * are dropped honestly (tombstoned source) — never a hole in <Picture N>.
 */
export function resolveChainReferences(
  settings: CanvasChainSettings,
  libraries: CanvasLibraries,
  resolveMedia: (outputId: string) => { media: MediaFile; take: DocumentTake } | null,
  assets: CanvasAssetEntry[] = [],
): MovieReferenceBinding[] {
  const selectedCharacters = settings.referenceCharacterIds
    .map((id) => libraries.characters.find((character) => character.id === id))
    .filter((character): character is CharacterProject => Boolean(character))
    .filter((character) => characterReferences(character).length > 0)
  const selectedLocations = settings.referenceLocationIds
    .map((id) => libraries.locations.find((location) => location.id === id))
    .filter((location): location is LocationProject => Boolean(location))
    .filter((location) => locationReferences(location).length > 0)
  const bindings = allocateWorkspaceReferences(
    selectedCharacters.map((character) => ({ id: character.id, name: character.name, identity: characterReferences(character), hairStyleIds: character.hairStyleIds, wardrobeIds: character.wardrobeIds, accessoryIds: character.accessoryIds })),
    libraries.wardrobes,
    selectedLocations.map((location) => ({ id: location.id, name: location.name, images: locationReferences(location), environmentMode: location.environmentMode })),
  )
  const canvasRefs: MovieReferenceBinding[] = []
  for (const outputId of settings.referenceOutputIds) {
    const resolved = resolveMedia(outputId)
    if (!resolved) continue
    canvasRefs.push({
      file: resolved.media,
      purpose: 'generic',
      label: `Canvas reference: ${resolved.media.name}`,
      source: 'canvas',
    })
  }
  // Global-asset bindings (Phase 4): each bound asset's curated set joins the
  // SAME ordered picture budget after library + canvas refs — a dropped or
  // tombstoned asset is skipped honestly, never a hole in <Picture N>.
  const assetRefs: MovieReferenceBinding[] = []
  for (const assetId of settings.referenceAssetIds) {
    const asset = assets.find((entry) => entry.id === assetId)
    if (!asset || !asset.images.length) continue
    for (const image of asset.images) {
      assetRefs.push({
        file: image,
        purpose: 'generic',
        label: `${asset.kind === 'location' ? 'Location' : 'Character'} asset: ${asset.label}`,
        source: 'asset',
      })
    }
  }
  return [...bindings, ...canvasRefs, ...assetRefs].slice(0, 9)
}

// ---- request + graph construction ----------------------------------------------

export type CanvasRenderSources = {
  firstFrame: MediaFile | null
  lastFrame: MediaFile | null
  referenceImages: MediaFile[]
  /** Reference VIDEOS/AUDIO from output refs — they upload through the
   *  LoadVideo/LoadAudio slots (never a picture slot); the old surface keeps
   *  the same three-way split. */
  referenceVideos: MediaFile[]
  referenceAudios: MediaFile[]
}

/**
 * Builds the shared H3RenderRequest for one chain: effective mode (L4),
 * composed prompt (composeH3Prompt over the chain's bindings + policies),
 * policy-ordered reference images, and the chain's engine parameters. Pure —
 * the store calls it at submit time; the tests call it to assert graph shape.
 */
export function buildCanvasRenderRequest(
  settings: CanvasChainSettings,
  sources: CanvasRenderSources,
  bindings: MovieReferenceBinding[],
  chain?: H3RenderRequest['chain'],
): H3RenderRequest {
  const mode = effectiveMode(settings)
  const [width, height] = settings.resolution.split('x').map(Number)
  const referenceImages = resolveRenderReferenceImages(sources.referenceImages, bindings, settings.clothingPolicy)
  const prompt = composeH3Prompt({
    prompt: settings.prompt,
    mode,
    bindings,
    clothingPolicy: settings.clothingPolicy,
    noDialogue: settings.noDialogue,
    naturalMovement: settings.naturalMovement,
  })
  return {
    mode,
    prompt,
    width,
    height,
    duration: settings.duration,
    seed: settings.seed,
    steps: settings.steps,
    turbo: settings.turbo,
    turboLoader: settings.turboLoader,
    experimentalSampling: false,
    loraStrength: settings.loraStrength,
    // The temporal LoRA stack rides every H3 render this chain submits
    // (7twfk6o) — the graph chains the loaders after the turbo seam.
    ...(settings.loraStack.length ? { loraStack: settings.loraStack.map((entry) => ({ ...entry })) } : {}),
    sampler: 'res_multistep',
    scheduler: 'simple',
    refImageSize: settings.refImageSize,
    upscale: { mode: settings.upscaleMode, model: '', vae: '', lbhModel: '', missingNodes: [] },
    rtxModel: '',
    firstFrame: mode === 'image' || mode === 'frames' ? sources.firstFrame : null,
    lastFrame: mode === 'frames' ? sources.lastFrame : null,
    referenceImages: mode === 'reference' ? referenceImages : [],
    referenceVideos: mode === 'reference' ? sources.referenceVideos ?? [] : [],
    referenceAudios: mode === 'reference' ? sources.referenceAudios ?? [] : [],
    timelineGuides: mode === 'reference' ? settings.timelineGuides : [],
    // F6 (maintainer decision 2026-09-18): canvas renders request native
    // sampler previews — the frames surface on the generating tile. Mode
    // 'standard' ROUTES (A-DBG, maintainer ruling 2026-09-22): when the
    // PreviewOverride pack's node is served and a taeh3 decoder is present,
    // the submit path wires the pack's node into the model chain (its
    // minimax_h3_preview_override stream owns previews; the server skips
    // the stock preview_method request for that graph); otherwise this is
    // the engine-side vae_approx decode (taeh3 for H3) — the pack-absent
    // fallback. The explicit 'h3-override' mode remains the old surface's
    // strict opt-in.
    livePreview: { enabled: true, mode: 'standard' },
    ...(chain ? { chain } : {}),
    filenamePrefix: `video/Canvas_H3_${Date.now()}`,
  }
}

/** Upload names a graph plan can stub loaders with (submission resolves the
 *  real server-side names; the plan only needs the slot occupancy). */
export type PlanUploads = { first?: string; last?: string; images?: string[]; guides?: string[] }

/**
 * The engine-free graph plan: the exact graph submission would build for this
 * request + model selection, with uploads stubbed by NAME (loader nodes
 * appear exactly when the mode's upload slots are occupied — the same
 * occupancy the real submit produces). This is the seam the probe surface
 * and the engine-independent tests read — graph CONSTRUCTION never needs an
 * engine, only the submit does.
 */
export function planCanvasGraph(request: H3RenderRequest, selection: ModelSelection, uploads: PlanUploads = {}): ComfyPrompt {
  return buildMiniMaxWorkflow({
    mode: request.mode,
    prompt: request.prompt,
    width: request.width,
    height: request.height,
    duration: request.duration,
    seed: request.seed,
    steps: request.steps,
    turbo: request.turbo,
    turboLoader: request.turboLoader,
    experimentalSampling: request.experimentalSampling,
    loraStrength: request.loraStrength,
    ...(request.loraStack?.length ? { loraStack: request.loraStack.map((entry) => ({ ...entry })) } : {}),
    sampler: request.sampler,
    scheduler: request.scheduler,
    refImageSize: request.refImageSize,
    sigmaShift: request.sigmaShift,
    upscale: undefined,
    filenamePrefix: request.filenamePrefix ?? 'video/Canvas_H3_plan',
    firstFrame: request.firstFrame?.path,
    lastFrame: request.lastFrame?.path,
    referenceImages: request.referenceImages.map((item) => item.path),
    referenceVideos: request.referenceVideos.map((item) => item.path),
    referenceAudios: request.referenceAudios.map((item) => item.path),
    timelineGuides: request.timelineGuides.length ? request.timelineGuides.map((guide) => ({ frameIndex: Math.round(guide.seconds * 24) })) : undefined,
    ...(request.chain ? { chain: request.chain } : {}),
  }, selection, {
    first: uploads.first ? { name: uploads.first } : undefined,
    last: uploads.last ? { name: uploads.last } : undefined,
    images: (uploads.images ?? []).map((name) => ({ name })),
    videos: [],
    audios: [],
    guides: (uploads.guides ?? []).map((name) => ({ name })),
  })
}

// ---- fork gestures (§2 outputRef substrates) ------------------------------------

export type ForkSubstrate = 'decoded' | 'extracted-frame' | 'latents'

export const SUBSTRATE_LABEL: Record<ForkSubstrate, string> = {
  'decoded': 'decoded media',
  'extracted-frame': 'extracted frame',
  'latents': 'latents on disk',
}

/** The substrates a take can actually be forked on: decoded always; latents
 *  only when the take carries a latent path (honest availability); extracted
 *  frame only for video takes (an image has no other frame to extract). */
export function substratesForTake(take: DocumentTake | null, mediaKind: MediaFile['kind'] | null): ForkSubstrate[] {
  if (!take) return []
  const substrates: ForkSubstrate[] = ['decoded']
  if (mediaKind === 'video') substrates.push('extracted-frame')
  if (take.latentPath) substrates.push('latents')
  return substrates
}

/**
 * The fork chain's input spec (§2.1): an outputRef naming the source output,
 * the pinned take (fork-from-early-take), and the chosen substrate. The
 * outputId inside is what deriveEdges resolves — the derived edge appears for
 * free. `extractedPath` rides along for extracted-frame forks (the ffmpeg
 * extraction is a real side effect the gesture runs before creating the
 * chain; the render path prefers it over re-extracting).
 */
export function forkInputSpec(source: { outputId: string; takeId: string | null; substrate: ForkSubstrate; extractedPath?: string | null; frameIndex?: number | null }): Record<string, unknown> {
  const outputRef: Record<string, unknown> = {
    outputId: source.outputId,
    substrate: source.substrate,
  }
  if (source.takeId) outputRef.takeId = source.takeId
  if (source.extractedPath) outputRef.extractedPath = source.extractedPath
  if (typeof source.frameIndex === 'number') outputRef.frameIndex = source.frameIndex
  return { outputRef }
}

// ---- latent continuation (Phase 4: the Motion-Context engine seam) ----------

/** The Motion-Context custom-node classes a latent continuation needs (the
 *  same availability computation the old shell's scene chains gate on). */
export const MOTION_CONTEXT_NODES = [
  'MiniMaxH3MotionContext',
  'MiniMaxH3MotionContextLoadLatent',
  'MiniMaxH3MotionContextSaveLatent',
  'MiniMaxH3MotionContextTrim',
] as const

/** Where one canvas chain's sampler latents live (engine-side, under the
 *  ComfyUI output directory — the scene-chain convention). */
export function motionContextFolder(chainId: string): string {
  return `h3_context/${chainId}/clip`
}

/** The saved-clip facts a take carries when its render wrote a latent. */
export type MotionContextFacts = { folder: string; clipIndex: number }

/** Tolerant read of a take's motion-context provenance (take.metrics is
 *  external data): returns null for takes that rendered without the
 *  machinery — the honest signal that latents forks refuse on. */
export function takeMotionContext(take: DocumentTake | null): MotionContextFacts | null {
  const record = take?.metrics?.motionContext
  if (!record || typeof record !== 'object') return null
  const candidate = record as Record<string, unknown>
  if (typeof candidate.folder !== 'string' || !candidate.folder) return null
  if (typeof candidate.clipIndex !== 'number' || !Number.isInteger(candidate.clipIndex) || candidate.clipIndex < 0) return null
  return { folder: candidate.folder, clipIndex: candidate.clipIndex }
}

/** The chain option a CANVAS H3 render carries: with the Motion-Context nodes
 *  installed every render SAVES its sampler latent (index 0 = chain start, no
 *  load, no trim) so its takes are latent-forkable. `loadFrom` pins an
 *  explicit source clip — the substrate=latents fork continuation. */
export function canvasChainOption(chainId: string, continuation: MotionContextFacts | null): NonNullable<H3RenderRequest['chain']> {
  const folder = motionContextFolder(chainId)
  if (!continuation) return { index: 0, folder }
  // The fork continues from the SOURCE's saved clip: it loads that exact clip
  // as never-denoised conditioning (no re-encode) and saves its own
  // continuation into its OWN folder — never a write into the source's.
  return { index: 1, folder, loadFrom: { folder: continuation.folder, clipIndex: continuation.clipIndex } }
}

/** The latent path a take records for a saved clip — the Motion-Context
 *  pack's ACTUAL on-disk slot: SaveLatent with clip_index > 0 writes
 *  `<prefix-basename>_%05d.safetensors` under the ComfyUI output directory
 *  (verified against ComfyUI-H3-Motion-Context nodes.py, 2026-09-17; the
 *  drive's live-verify captured clip_00001/clip_00002.safetensors on disk).
 *  facts.clipIndex is the app's 0-based chain index; the pack's slots are
 *  1-based (clip 1 is the first — Load's clip_index 0 never reads a file),
 *  so +1 here. This must stay byte-aligned with what the engine saves or
 *  the landing-time absolutization resolves against a nonexistent path and
 *  latents never register as blobs. */
export function latentPathFor(facts: MotionContextFacts): string {
  return `${facts.folder}_${String(facts.clipIndex + 1).padStart(5, '0')}.safetensors`
}
