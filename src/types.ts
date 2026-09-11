export type View = 'create' | 'ltx25' | 'music' | 'music3' | 'zimage' | 'characters' | 'hair' | 'wardrobes' | 'accessories' | 'locations' | 'movie' | 'queue' | 'library' | 'editor' | 'settings'
export type GenerationMode = 'text' | 'image' | 'frames' | 'reference'
export type ModelKind = 'diffusion_models' | 'text_encoders' | 'vae' | 'loras' | 'vae_approx' | 'clip_vision'
export type MediaKind = 'image' | 'video' | 'audio'
export type UpscaleMode = 'off' | 'ltx' | 'rtx' | 'lbh2d' | 'lbh3d'
export type ReferencePurpose = 'character' | 'character-angle' | 'hair' | 'wardrobe' | 'accessory' | 'location' | 'continuity' | 'product' | 'style' | 'generic'
export type PromptPresetCategory = 'camera' | 'shot' | 'angle' | 'lens' | 'lighting' | 'audio' | 'style' | 'movement' | 'transition' | 'character' | 'wardrobe' | 'location' | 'embedding'
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
  syncMobileCharacters(characters: unknown[]): Promise<{ synced: number }>
  listPromptLibrary(query: { text?: string; limit?: number; cursor?: string; nsfw?: boolean; sort?: string; scope?: 'h3' | 'all' }): Promise<{ items: PromptLibraryItem[]; cursor?: string }>
  runSetupDoctor(): Promise<{ checks: Array<{ id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; recommendation?: string }>; ranAt: number }>
  freeComfyMemory(url: string): Promise<{ freed: boolean }>
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
