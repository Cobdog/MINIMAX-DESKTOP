export type View = 'create' | 'ltx25' | 'music' | 'music3' | 'zimage' | 'characters' | 'hair' | 'wardrobes' | 'accessories' | 'locations' | 'movie' | 'queue' | 'library' | 'editor' | 'settings'
export type GenerationMode = 'text' | 'image' | 'frames' | 'reference'
export type ModelKind = 'diffusion_models' | 'text_encoders' | 'vae' | 'loras' | 'vae_approx' | 'clip_vision'
export type MediaKind = 'image' | 'video' | 'audio'
export type UpscaleMode = 'off' | 'ltx' | 'rtx' | 'lbh2d' | 'lbh3d'
export type ReferencePurpose = 'character' | 'character-angle' | 'hair' | 'wardrobe' | 'accessory' | 'location' | 'continuity' | 'product' | 'style' | 'generic'
export type PromptPresetCategory = 'camera' | 'shot' | 'angle' | 'lens' | 'lighting' | 'audio' | 'style' | 'movement' | 'transition' | 'character' | 'wardrobe' | 'location' | 'embedding' | 'looseness'
export type PromptPreset = { id: string; category: PromptPresetCategory; label: string; keywords: string[]; description: string; insertion: string }
export type MovieReferenceBinding = { file: MediaFile; purpose: ReferencePurpose; label: string; characterId?: string; hairStyleId?: string; wardrobeId?: string; accessoryId?: string; locationId?: string; locationEnvironmentMode?: LocationProject['environmentMode']; source: 'character-studio' | 'hair-studio' | 'wardrobe-studio' | 'accessory-studio' | 'location-studio' | 'movie' | 'shot' | 'continuity' }
export type ResolvedMovieShot = { preferredMode: GenerationMode; effectiveMode: GenerationMode; references: MovieReferenceBinding[]; compiledPrompt: string; routeReason: string; omittedReferences: MovieReferenceBinding[] }

export type GenerationDefaults = {
  resolution: string
  duration: number
  turbo: 'off' | '4' | '8'
  steps: number
  sampler: string
  scheduler: string
  experimentalSampling: boolean
  refImageSize: 'match' | 'max'
  livePreview: boolean
  sigmaShiftMode: 'model' | 'custom'
  shiftVideo: number
  shiftAudio: number
  loraStrength: number
  upscaleMode: UpscaleMode
}

/** Self-managed engine runtime (managed ComfyUI, increment 1). External mode
 *  (the default) is byte-for-byte the pre-runtime behavior: no spawns, no
 *  polls, no route side effects. Managed mode launches a ComfyUI the studio
 *  itself supervises from a checkout the USER nominates (clone-on-demand is a
 *  later increment). */
export type EngineMode = 'external' | 'managed'

/** One pre-launch hook step a profile asks the runtime to run before spawn.
 *  Increment 2 ships the consent-patch tier; the shape stays declarative so
 *  new hook kinds (e.g. fetcher checkouts) extend it without migration. */
export type EngineLaunchHook = { kind: 'patch'; patchId: string }

/** A launch profile = env + pre-launch hook steps + port policy (increment 2
 *  of task 3ay7wbz). Profiles are pure data: the RuntimeManager resolves the
 *  active one, injects its env into the spawn, runs its hooks, and honors its
 *  reserved ports. The seeded 'vdn' profile carries NO env by default — the
 *  upstream VDN_H3_* variables are lab/ablation toggles read at runtime by
 *  the node, so the profile exposes only the seam a user would set. */
export type EngineLaunchProfile = {
  label: string
  description: string
  env: Record<string, string>
  hooks: EngineLaunchHook[]
  portPolicy: { reserve?: number[] }
}

/** Recorded user consent for one engine patch. A patch is NEVER applied
 *  unless this record exists with consented: true — the runtime degrades
 *  (launches unpatched, notes it) instead. */
export type PatchConsentRecord = { consented: boolean; at?: number; comfyVersion?: string }

export type ManagedEngineConfig = {
  mode: EngineMode
  /** Absolute path to an existing ComfyUI checkout (must contain main.py). */
  checkoutPath: string
  /** Python executable for the checkout ('' → python3/python by platform). */
  pythonPath: string
  /** Preferred port; 0 = auto-allocate scanning upward from 8191, clear of
  *  the reserved user instances (8188, 8189). */
  portPreference: number
  /** Launch the managed engine when the server boots (boot reconcile adopts
   *  a healthy recorded instance instead of double-spawning). */
  autoStart: boolean
  /** Active launch profile id (default | vdn | user-defined). */
  profile: string
  /** User-editable launch profiles, keyed by id. Seeded with the studio's
   *  defaults; user edits win for a given id, and unknown stored ids are
   *  dropped at normalize time. */
  profiles: Record<string, EngineLaunchProfile>
  /** Consent ledger for engine core patches (keyed by patch id). */
  patches: Record<string, PatchConsentRecord>
}

export type ManagedEngineState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
export type ManagedEngineHealth = 'unknown' | 'ok' | 'unreachable'
export type ManagedEngineStatus = {
  mode: EngineMode
  state: ManagedEngineState
  /** Launch profile the engine runs under (the recorded one while running —
   *  adoption included — so a settings change never lies about the live
   *  process's environment). */
  profile?: string
  port?: number
  url?: string
  pid?: number
  /** The running instance was adopted from a previous server run (this
   *  process did not spawn it; stop re-verifies before signalling). */
  adopted?: boolean
  /** Adopted while managed mode is off — reported honestly, never killed by
   *  reconcile; only an explicit stop (or a mode flip) touches it. */
  stray?: boolean
  startedAt?: number
  lastError?: string
  /** Best-effort VRAM contention note (another local ComfyUI has jobs in
   *  flight) — a warning, never a block. */
  warning?: string
  /** Lazy /system_stats sample while running ('unknown' otherwise). */
  health: ManagedEngineHealth
  logTail: string[]
}

// ---- Vendored node packs (increment 2, AC zzdfklo first slice) -------------

/** How a custom-node pack reaches an instance. 'vendor' = the studio ships
 *  the pack inside its own repo at a pinned revision (license-clean only);
 *  'user-fetch' = the user consents to it being fetched/copied into the
 *  instance's custom_nodes/ (for packs whose license does not permit
 *  redistribution, or that are not vendored yet). */
export type NodePackInstallMode = 'vendor' | 'user-fetch'

/** One registry entry (server-side data; the Settings surface renders it). */
export type NodePackDefinition = {
  id: string
  name: string
  description: string
  repoUrl: string
  pinnedRevision: string
  /** SPDX id — 'NO-LICENSE' means the repo carries no license file
   *  (all-rights-reserved by default): never vendored, user-fetch only. */
  licenseSpdx: string
  licenseNote?: string
  installMode: NodePackInstallMode
  homepage?: string
  /** Vendored payload directory (vendor mode only), relative to vendor root. */
  vendorDir?: string
}

/** Availability of one registry entry against a concrete checkout. */
export type NodePackStatus = NodePackDefinition & {
  /** The vendored payload is present in this install (vendor mode). */
  vendored: boolean
  /** The pack is present in the checkout's custom_nodes/. */
  installed: boolean
  /** Revision recorded at install time (studio marker), when installed. */
  installedRevision?: string
  /** How the pack could be installed right now. */
  availability: 'ready' | 'needs-source' | 'unavailable'
  note?: string
}

export type AppSettings = {
  comfyUrl: string
  ollamaUrl: string
  ollamaModel: string
  modelRoot: string
  paths: Record<ModelKind, string>
  outputDirectory: string
  ffmpegPath: string
  generationDefaults: GenerationDefaults
  /** Chosen GPU tier — drives community quant/resolution guidance. */
  gpuTier?: '8' | '16' | '24' | 'blackwell'
  /** ComfyUI version the bundled graphs were last verified against
   *  (self-recorded on first successful connection). */
  testedComfyVersion?: string
  /** llama.cpp router-mode endpoint. Empty (default) → Ollama fallback,
   *  preserving the pre-LLM-layer behavior exactly. */
  llamaCppUrl: string
  /** Active chat model on the router (e.g. DeepSeek V4 Flash 0731). Empty →
   *  the first model the router lists. */
  llamaCppModel: string
  /** Preferred vision/captioning model; empty → auto (active model when
   *  vision-capable, else first vision-capable listed). */
  llamaVisionModel: string
  /** Comma-separated model ids (substring match) that skip the pre-generation
   *  unload choreography. */
  llamaStickyModels: string
  /** Auto-unload router models before generation submits (VRAM hygiene). */
  unloadLlmOnGenerate: boolean
  /** Default thinking mode for freeform enhancement (structured tasks are
   *  always thinking-OFF for speed). */
  llmThinkingDefault: 'off' | 'on'
  /** Prompt-assistant writing style — deliberately content-neutral. */
  promptContentLevel: 'sfw' | 'suggestive' | 'nsfw'
  /** Self-managed engine runtime (increment 1); defaults keep external mode,
   *  which preserves today's behavior exactly. */
  engine: ManagedEngineConfig
}

export type ClipItem = { id: string; name: string; source: string; createdAt: number; start?: number; end?: number; duration?: number }
export type ClipProject = { id: string; name: string; createdAt: number; updatedAt: number; media: ClipItem[]; clips: ClipItem[] }

export type CharacterProject = {
  id: string
  name: string
  description: string
  wardrobe: string
  voiceNotes: string
  visualStyle: string
  referencePrompt: string
  createdAt: number
  updatedAt: number
  referenceMode: 'single' | 'set'
  selectedReferencePaths?: string[]
  baseImage?: MediaFile
  turntableVideo?: MediaFile
  referenceImages: MediaFile[]
  wardrobeIds: string[]
  accessoryIds: string[]
  hairStyleIds: string[]
  identityTemplate: 'custom' | 'cinematic' | 'editorial' | 'everyday'
  hairPreset: string
  skinTone: string
}
export type WardrobeProject = { id: string; name: string; description: string; accessories: string[]; materials: string; colors: string; visualStyle: string; referencePrompt: string; referenceImages: MediaFile[]; selectedReferencePaths?: string[]; createdAt: number; updatedAt: number }
export type AccessoryProject = { id: string; name: string; category: 'jewelry' | 'eyewear' | 'watch' | 'bag' | 'headwear' | 'prop' | 'other'; description: string; materials: string; colors: string; visualStyle: string; referencePrompt: string; referenceImage?: MediaFile; createdAt: number; updatedAt: number }
export type HairStyleProject = { id: string; name: string; description: string; texture: string; length: string; color: string; hairline: string; finish: string; visualStyle: string; referencePrompt: string; referenceImage?: MediaFile; createdAt: number; updatedAt: number }
export type LocationProject = {
  id: string
  name: string
  environmentMode: 'mixed' | 'nature' | 'built'
  description: string
  atmosphere: string
  timeOfDay: string
  continuityAnchors: string
  visualStyle: string
  referencePrompt: string
  createdAt: number
  updatedAt: number
  referenceMode: 'single' | 'set'
  selectedReferencePaths?: string[]
  baseImage?: MediaFile
  walkthroughVideo?: MediaFile
  referenceImages: MediaFile[]
}
export type MovieCharacter = { id: string; libraryCharacterId?: string; libraryUpdatedAt?: number; name: string; description: string; wardrobe: string; voiceNotes: string; referenceImages: MediaFile[] }
export type MovieLocation = { id: string; libraryLocationId?: string; libraryUpdatedAt?: number; environmentMode?: LocationProject['environmentMode']; name: string; description: string; referenceImages: MediaFile[] }
export type MovieChatArea = 'setup' | 'bible' | 'shots' | 'preview'
export type MovieChatMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: number; appliedChanges?: string[]; areas?: MovieChatArea[] }
export type MovieShot = {
  id: string
  title: string
  duration: number
  prompt: string
  dialogue: string
  mode: GenerationMode
  preferredMode?: GenerationMode
  characterIds: string[]
  referenceImages?: MediaFile[]
  referenceVideos?: MediaFile[]
  referenceAudios?: MediaFile[]
  stage: 'planned' | 'ready' | 'rendered' | 'approved'
  outputUrl?: string
  renderedAt?: number
}
export type MovieScene = { id: string; title: string; summary: string; locationId: string; transition: 'connected' | 'cut'; shots: MovieShot[] }
export type MovieProject = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  status: 'planning' | 'paused'
  targetRuntime: number
  computeBudgetMinutes: number
  aspectRatio: '16:9' | '9:16' | '1:1'
  genre: string
  visualStyle: string
  quality: 'preview' | 'balanced' | 'maximum'
  reviewGate: 'shot' | 'scene' | 'batch'
  story: string
  visualRules: string
  characters: MovieCharacter[]
  locations: MovieLocation[]
  scenes: MovieScene[]
  chatMessages: MovieChatMessage[]
}

export type ModelFile = {
  name: string
  /** Server-side only; not sent to the renderer (the API strips it). */
  path?: string
  kind: ModelKind
  bytes: number
}

export type MediaFile = {
  path: string
  name: string
  kind: MediaKind
  preview?: string
  crop?: { x: number; y: number; zoom: number; fit: 'crop' | 'contain' }
  clip?: { sourcePath: string; sourceName: string; start: number; end: number }
}

export type ModelSelection = {
  fl2va: string
  ref2va: string
  textEncoder: string
  videoVae: string
  audioVae: string
  previewVae: string
  fl2vLora: string
  ref2vLora: string
}

export type Ltx25ModelSelection = {
  diffusion: string
  textEncoder: string
  videoVae: string
  audioVae: string
  latentUpscaler: string
}

export type Ltx25GenerationOptions = {
  mode: 'text' | 'image'
  prompt: string
  width: number
  height: number
  duration: number
  seed: number
  preset: 'quality' | 'turbo'
  filenamePrefix: string
}

export type AceStepModelSelection = {
  base: string
  sft: string
  textEncoderSmall: string
  textEncoderLarge: string
  vae: string
}

export type AceStepGenerationOptions = {
  model: 'sft' | 'base'
  tags: string
  lyrics: string
  instrumental: boolean
  duration: number
  bpm: number
  timeSignature: string
  language: string
  keyScale: string
  seed: number
  generateAudioCodes: boolean
  filenamePrefix: string
}

export type GenerationOptions = {
  mode: GenerationMode
  prompt: string
  width: number
  height: number
  duration: number
  seed: number
  steps: number
  turbo: 'off' | '4' | '8'
  /** Turbo loader preference: 'auto' lets a 4-step family use the dedicated
   *  larryvrh loader/sampler pair when that node pack is installed; 'plain'
   *  forces the stock LoraLoaderModelOnly path (community-reported quality
   *  path). Default 'auto'. */
  turboLoader?: 'auto' | 'plain'
  experimentalSampling?: boolean
  previewOverride?: { frames: number; fps: number; nodeType?: string; vaeName?: string; jpegQuality?: number }
  loraStrength?: number
  sampler: string
  scheduler: string
  refImageSize: 'match' | 'max'
  sigmaShift?: { video: number; audio: number }
  filenamePrefix: string
  upscale?: { type: 'ltx'; model: string; vae: string } | { type: 'rtx'; model: string } | { type: 'lbh2d' | 'lbh3d'; model: string }
  firstFrame?: string
  lastFrame?: string
  referenceImages: string[]
  referenceVideos: string[]
  referenceAudios: string[]
  /** Timeline keyframes for reference mode: pinned via chained
   *  MiniMaxH3AddGuide nodes at these frame indices (round(seconds*24);
   *  negative counts from the end). */
  timelineGuides?: Array<{ frameIndex: number }>
  /** Latent chaining (ComfyUI-H3-Motion-Context): every segment saves its
   *  sampler latent as <folder><index>; segment 0 never loads (chain start),
   *  segment N loads clip N-1 and pins its tail as never-denoised
   *  conditioning, trimming the overlap from the delivered output. */
  chain?: { index: number; folder: string; contextLength?: '5' | '22' | '39' | '56'; audioContextLength?: number }
}

export type ComfyStatus = {
  connected: boolean
  latencyMs: number
  stats?: {
    system?: { os?: string; python_version?: string; comfyui_version?: string }
    devices?: Array<{ name?: string; type?: string; vram_total?: number; vram_free?: number }>
  }
  error?: string
}

export type OllamaModel = {
  name: string
  size: number
  family: string
  parameterSize: string
  local: boolean
}

export type LanStatus = {
  running: boolean
  url?: string
  desktopUrl?: string
  port?: number
  error?: string
  secure?: boolean
  certificateFingerprint?: string
}

export type GpuTelemetry = {
  available: boolean
  name?: string
  usagePercent?: number
  vramPercent?: number
  vramUsedMb?: number
  vramTotalMb?: number
}

// ---- Realtime event fabric (wave 1) ---------------------------------------
// One connection per client (WebSocket primary, SSE v2 fallback) carrying a
// typed channel taxonomy. The JSON envelope is `{ch, type, seq, ts, payload}`
// where `seq` is monotonic PER CHANNEL PER CONNECTION: a client that observes
// seq > last + 1 knows events were dropped and emits a synthetic `resync`
// notice so consumers re-fetch authoritative state (for `job`, one history
// poll). Preview frames ride BINARY WebSocket frames instead (see
// server/realtime.ts for the compact header) — never base64 on the WS path.

export type RealtimeJsonChannel = 'job' | 'telemetry' | 'llm' | 'engine' | 'system'
export type RealtimeChannel = RealtimeJsonChannel | 'preview'
export type RealtimeEnvelope<T = unknown> = { ch: RealtimeChannel; type: string; seq: number; ts: number; payload: T }

/** Normalized ComfyUI lifecycle on the `job` channel: normalized ONCE on the
 *  server (from the shared upstream socket) and fanned out; consumers
 *  correlate by promptId. `job_done` is the synthesized terminal marker. */
export type JobLifecycleEvent =
  | { type: 'execution_start'; promptId: string }
  | { type: 'executing'; promptId: string; node: string | null }
  | { type: 'progress'; promptId: string; value: number; max: number }
  | { type: 'executed'; promptId: string; node: string; images: Array<{ filename: string; subfolder?: string; type?: string }> }
  | { type: 'execution_cached'; promptId: string; nodes: string[] }
  | { type: 'execution_error'; promptId: string; nodeType?: string; errorMessage?: string }
  | { type: 'interrupted'; promptId: string }
  | { type: 'execution_success'; promptId: string }
  | { type: 'job_done'; promptId: string; outcome: 'success' | 'error' | 'interrupted' }
  | { type: 'preview_meta'; promptId: string; mime: string; fps?: number; step?: number; totalSteps?: number }
  | { type: 'queue_status'; promptId: string; queueRemaining?: number }

/** Lifecycle events for supervised engine/sidecar processes (wave 2c), emitted
 *  by server/engineProcess.ts through the fabric's engine channel. `name`
 *  identifies which managed process (e.g. 'comfyui', 'trainer', 'refmod'). */
export type EnginePhase = 'booting' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
export type EngineLifecycleEvent = { name: string; phase: EnginePhase; detail?: string; pid?: number; at: number }

/** A GPU/VRAM sample pushed on the telemetry channel while at least one
 *  subscriber is connected (the sampler stops when the last one leaves). */
export type TelemetrySample = GpuTelemetry & { at: number }

/** Request/response LLM streaming over the fabric: the client sends
 *  `{ch:'llm', type:'generate', reqId, payload}`; tokens stream back tagged
 *  with the same reqId until `done`/`error`. Endpoints must pass the server's
 *  local-service (SSRF) guard — local OpenAI-compatible routers only. */
export type LlmStreamRequest = {
  endpoint: string
  model: string
  messages: Array<{ role: string; content: string }>
  options?: Record<string, unknown>
}
export type LlmTokenDelta = { delta: string }
export type LlmDonePayload = { aborted?: boolean; finishReason?: string }
export type LlmErrorPayload = { error: string }

/** One model on the ACTIVE LLM provider (llama.cpp router or Ollama
 *  fallback), enriched by the server's family registry: inferred family,
 *  vision capability, and router load status. */
export type LlmModelStatus = {
  id: string
  family: string
  familyLabel: string
  vision: boolean
  status: string
  active: boolean
}

export type LlmModelsResult = {
  provider: 'router' | 'ollama'
  endpoint: string
  /** The resolved active chat model ('' when none). */
  model: string
  models: LlmModelStatus[]
  connected: boolean
  latencyMs: number
  error?: string
}

/** Composer-facing assistant request: the server resolves the layered system
 *  message from these dimensions (task, target engine, length, content
 *  level) plus the active model's family. */
export type LlmGenerateOptions = {
  task?: string
  targetEngine?: string
  length?: 'concise' | 'standard' | 'detailed'
  contentLevel?: 'sfw' | 'suggestive' | 'nsfw'
  /** Runtime per-request instructions — the composer's [context] layer. */
  instructions?: string
  draft?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string }>
  thinking?: boolean
  model?: string
  /** Send the draft verbatim — no composer layers. */
  raw?: boolean
}

/** Mime types the binary preview channel carries; the wire header stores the
 *  index (0=jpeg, 1=png, 2=webp, 3=mp4 — 3 covers animated H3 override clips). */
export type PreviewMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type GenerationJob = {
  id: string
  promptId?: string
  /** Consecutive polls where ComfyUI history says completed but no output file
   *  has been found yet; drives the give-up cap in lib/jobReducer. */
  noOutputPolls?: number
  mode: GenerationMode
  prompt: string
  createdAt: number
  status: JobStatus
  progress: number
  progressLabel?: string
  currentStep?: number
  totalSteps?: number
  outputUrl?: string
  localOutputPath?: string
  error?: string
  width: number
  height: number
  duration: number
  provider?: 'minimax' | 'ltx25' | 'acestep' | 'music3'
  /** Reproducibility record attached at submit time (persisted). */
  manifest?: Record<string, unknown>
  /** Submit-side graph for in-memory auto-retry only — stripped before
   *  localStorage persistence. */
  graph?: unknown
  /** Set after the automatic engine-reset + tiled-VAE retry. */
  retriedOnce?: boolean
  mediaType?: 'video' | 'audio' | 'image'
  movieLink?: { projectId: string; sceneId: string; shotId: string }
  characterProjectId?: string
  locationProjectId?: string
}

export type UploadedFile = { name: string; subfolder?: string; type?: string }

export type DesktopApi = {
  getObjectInfo(url: string): Promise<Record<string, { input: { required: Record<string, unknown[]> } }>>
  uploadImageData(url: string, data: string): Promise<UploadedFile>
  saveComfyOutputImage(url: string, file: { filename: string; subfolder?: string; type?: string }, outputDirectory: string): Promise<{ path: string; name: string }>
  getSettings(): Promise<AppSettings>
  getGpuTelemetry(): Promise<GpuTelemetry>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  chooseDirectory(initialPath?: string): Promise<string | null>
  chooseMedia(type: MediaKind): Promise<{ path: string; name: string } | null>
  scanModels(settings: AppSettings): Promise<ModelFile[]>
  getComfyStatus(url: string): Promise<ComfyStatus>
  submitPrompt(url: string, prompt: unknown, clientId?: string): Promise<{ prompt_id: string; number?: number; node_errors?: unknown }>
  getHistory(url: string, promptId: string): Promise<Record<string, unknown>>
  cancelPrompt(url: string, promptId: string): Promise<{ cancelled: boolean; state: 'running' | 'pending' | 'finished' | 'unknown' }>
  uploadInput(url: string, filePath: string): Promise<UploadedFile>
  fileDataUrl(filePath: string): Promise<string>
  mediaUrl(filePath: string): Promise<string>
  extractVideoFrame(source: string, position: number | 'last', outputDirectory: string, ffmpegPath: string): Promise<{ path: string; name: string }>
  extractVideoFrames(source: string, positions: number[], outputDirectory: string, ffmpegPath: string): Promise<Array<{ path: string; name: string }>>
  trimVideo(source: string, start: number, end: number, outputDirectory: string, ffmpegPath: string): Promise<{ path: string; name: string }>
  joinVideos(clips: Array<Pick<ClipItem, 'source' | 'start' | 'end'>>, outputDirectory: string, ffmpegPath: string): Promise<{ path: string; url: string }>
  resolveOutput(outputDirectory: string, file: { filename: string; subfolder?: string; type?: string }): Promise<string | null>
  listOllamaModels(url: string): Promise<OllamaModel[]>
  generateWithOllama(url: string, model: string, prompt: string): Promise<string>
  generateStructuredWithOllama(url: string, model: string, prompt: string, schema: Record<string, unknown>): Promise<unknown>
  listLlmModels(url?: string): Promise<LlmModelsResult>
  llmGenerate(options: LlmGenerateOptions & { prompt?: string }): Promise<string>
  llmGenerateStructured(options: LlmGenerateOptions & { schema: Record<string, unknown> }): Promise<unknown>
  llmPrepareStream(options: LlmGenerateOptions): Promise<LlmStreamRequest>
  llmCaptionImage(image: string, instruction?: string): Promise<{ caption: string; model: string }>
  syncMobileCharacters(characters: unknown[]): Promise<{ synced: number }>
  listPromptLibrary(query: { text?: string; limit?: number; cursor?: string; nsfw?: boolean; sort?: string; scope?: 'h3' | 'all' }): Promise<{ items: PromptLibraryItem[]; cursor?: string }>
  runSetupDoctor(): Promise<{ checks: Array<{ id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; recommendation?: string }>; ranAt: number }>
  freeComfyMemory(url: string): Promise<{ freed: boolean }>
  getEngineStatus(): Promise<ManagedEngineStatus>
  startManagedEngine(): Promise<ManagedEngineStatus & { already?: boolean }>
  stopManagedEngine(): Promise<ManagedEngineStatus>
  listEngineNodePacks(): Promise<{ packs: NodePackStatus[] }>
  installEngineNodePack(id: string, sourceDirectory?: string): Promise<NodePackStatus>
  uninstallEngineNodePack(id: string): Promise<NodePackStatus>
  revertEnginePatch(id: string): Promise<{ reverted: boolean; patch: string }>
}

/** One harvested community prompt (Civitai image metadata via the server's
 *  pinned proxy route). */
export type PromptLibraryItem = {
  id: string
  prompt: string
  negativePrompt?: string
  seed?: number
  sampler?: string
  steps?: number
  cfgScale?: number
  width?: number
  height?: number
  username?: string
  stats?: { voteCount?: number; commentCount?: number }
}
