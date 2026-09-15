/** The persisted MiniMax Create workspace: every field the Create view edits,
 *  saved to localStorage between sessions. */
import type { GenerationMode, MediaFile, UpscaleMode } from '../types'

export type MovieLink = { projectId: string; sceneId: string; shotId: string }

export type PersistedWorkspace = {
  mode: GenerationMode
  prompt: string
  duration: number
  resolution: string
  turbo: 'off' | '4' | '8'
  /** Explicit turbo family (optimization-registry entry id, '' = auto-rank). */
  turboFamily: string
  /** 'auto' lets 4-step families use the dedicated larryvrh loader/sampler
   *  pair when installed; 'plain' forces the stock LoraLoaderModelOnly path. */
  turboLoader: 'auto' | 'plain'
  steps: number
  sampler: string
  scheduler: string
  experimentalSampling: boolean
  refImageSize: 'match' | 'max'
  noDialogue: boolean
  naturalMovement: boolean
  clothingPolicy: 'wardrobe' | 'underwear' | 'unrestricted'
  sigmaShiftMode: 'model' | 'custom'
  shiftVideo: number
  shiftAudio: number
  loraStrength: number
  seed: number
  advanced: boolean
  liveEnabled: boolean
  livePreviewMode: 'standard' | 'h3-override'
  upscaleMode: UpscaleMode
  rtxModel: string
  firstFrame: MediaFile | null
  lastFrame: MediaFile | null
  referenceImages: MediaFile[]
  referenceVideos: MediaFile[]
  referenceAudios: MediaFile[]
  /** Reference-mode timeline keyframes pinned via MiniMaxH3AddGuide. */
  timelineGuides: Array<{ file: MediaFile; seconds: number }>
  selectedReferenceCharacterIds: string[]
  selectedReferenceLocationIds: string[]
  activeJobId: string | null
  movieHandoff: MovieLink | null
}

export const workspaceDefaults: PersistedWorkspace = {
  mode: 'text', prompt: '', duration: 5, resolution: '1344x768', turbo: 'off', turboFamily: '', turboLoader: 'auto', steps: 30,
  sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, refImageSize: 'match', noDialogue: true, naturalMovement: true, clothingPolicy: 'wardrobe',
  sigmaShiftMode: 'model', shiftVideo: 12, shiftAudio: 3, loraStrength: 1, seed: Math.floor(Math.random() * 1_000_000_000),
  advanced: false, liveEnabled: true, livePreviewMode: 'standard', upscaleMode: 'off', rtxModel: '', firstFrame: null,
  lastFrame: null, referenceImages: [], referenceVideos: [], referenceAudios: [], timelineGuides: [], selectedReferenceCharacterIds: [], selectedReferenceLocationIds: [], activeJobId: null, movieHandoff: null,
}

/** Normalizes a persisted workspace (localStorage snapshot or server copy)
 *  over the defaults, applying the same compatibility fixes regardless of
 *  where the bytes came from. */
export function normalizeWorkspace(stored: Partial<PersistedWorkspace>): PersistedWorkspace {
  const workspace = { ...workspaceDefaults, ...stored }
  // Existing installs predate the explicit experimental opt-in. Migrate them
  // back to the official ComfyUI sampling pair to prevent stale combinations
  // such as heun+karras from continuing to produce surprising output.
  if (!stored.experimentalSampling) {
    workspace.sampler = 'res_multistep'
    workspace.scheduler = 'simple'
    workspace.experimentalSampling = false
  }
  // Reference mode had no 8-step LoRA before lightx2v's Ref2VA 8-step: reset
  // legacy 8-step reference choices, but preserve an explicit Ref2VA 8-step
  // family pick (the one supported path to 8-step reference generation).
  // The fast tier has two measured families since the 2026-09-15 bake-off
  // (task muwufpp): larryvrh v4_step600_ema is the default, lightx2v Ref2VA
  // 8-step the runner-up — both survive a reload.
  const REF2V_TURBO8_FAMILIES = new Set(['turbo.larryvrh-v4-8', 'turbo.lightx2v-ref2v-8'])
  if (workspace.mode === 'reference' && workspace.turbo === '8' && !REF2V_TURBO8_FAMILIES.has(stored.turboFamily ?? '')) workspace.turbo = 'off'
  workspace.steps = Math.max(16, Math.min(30, Number(workspace.steps) || 30))
  if (stored.steps === 20) workspace.steps = 30
  return workspace
}

export function readWorkspace(): PersistedWorkspace {
  try {
    const stored = JSON.parse(localStorage.getItem('minimax.workspace') ?? '{}') as Partial<PersistedWorkspace>
    return normalizeWorkspace(stored && typeof stored === 'object' ? stored : {})
  } catch {
    return workspaceDefaults
  }
}

/** Strips data: previews before persistence so localStorage quotas are not
 *  burned on megabyte-scale base64 duplicates of the same files. */
export function withoutPreview(file: MediaFile | null) {
  if (!file) return null
  const stored = { ...file }
  delete stored.preview
  return stored
}
