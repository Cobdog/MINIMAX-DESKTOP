/** The Create workspace store (wave 2a): every persisted creation field the
 *  `useCreateWorkspace` hook held as React state, plus the libraries it binds
 *  references from and the transient handoff/reset bookkeeping. The hook is
 *  now a facade — its effects stay, but the VALUES live here so components
 *  subscribe through narrow selectors instead of re-rendering the whole tree
 *  on every keystroke (perf audit: prompt state at the App root re-rendered
 *  the entire mounted tree per character typed).
 *
 *  Read pattern: `useWorkspaceStore((s) => s.prompt)` re-renders only when
 *  that slice changes; actions are stable references, safe to pass as props
 *  or capture in long-lived closures. Callers that need a fresh snapshot
 *  outside React (async flows) use `useWorkspaceStore.getState()`.
 *
 *  Setters accept a value OR an updater — the call sites kept the exact
 *  `setX(value)` / `setX((current) => …)` forms they used with useState. */
import { create } from 'zustand'
import type { CharacterProject, GenerationMode, HairStyleProject, LocationProject, MediaFile, UpscaleMode, WardrobeProject } from '../types'
import { loadCharacterProjects } from '../lib/characterLibrary'
import { loadWardrobeProjects } from '../lib/wardrobeLibrary'
import { loadLocationProjects } from '../lib/locationLibrary'
import { loadHairStyleProjects } from '../lib/hairLibrary'
import { readWorkspace, withoutPreview, type MovieLink, type PersistedWorkspace } from '../lib/workspace'

type Updater<T> = T | ((current: T) => T)

const applied = <T>(next: Updater<T>, current: T): T => (typeof next === 'function' ? (next as (current: T) => T)(current) : next)

/** Non-persisted fields are excluded so the debounced workspace write never
 *  serializes library caches or boot latches. */
const persisted = readWorkspace()

export type WorkspaceState = {
  // ---- persisted creation fields (PersistedWorkspace, flattened) ----------
  mode: GenerationMode
  prompt: string
  duration: number
  resolution: string
  turbo: 'off' | '4' | '8'
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
  timelineGuides: Array<{ file: MediaFile; seconds: number }>
  selectedReferenceCharacterIds: string[]
  selectedReferenceLocationIds: string[]
  activeJobId: string | null
  movieHandoff: MovieLink | null
  // ---- libraries (loaded sync from localStorage; refreshed by library events) ----
  characterProjects: CharacterProject[]
  wardrobeProjects: WardrobeProject[]
  locationProjects: LocationProject[]
  hairStyleProjects: HairStyleProject[]
  // ---- non-persisted --------------------------------------------------------
  /** LTX survey → Create handoff; cleared when the workspace consumes it. */
  characterHandoff: string | null
  /** Remount key for the Create view (reset bumps it). */
  createResetKey: number
  /** True once the authoritative server workspace has been read (or timed
   *  out) — persistence writes wait for it so a stale local snapshot cannot
   *  overwrite the server's newer state. */
  storageBootDone: boolean
  // ---- actions ---------------------------------------------------------------
  patch(partial: Partial<PersistedWorkspace>): void
  setMode(mode: Updater<GenerationMode>): void
  setPrompt(prompt: Updater<string>): void
  setDuration(duration: Updater<number>): void
  setResolution(resolution: Updater<string>): void
  setTurbo(turbo: Updater<'off' | '4' | '8'>): void
  setSteps(steps: Updater<number>): void
  setSampler(sampler: Updater<string>): void
  setScheduler(scheduler: Updater<string>): void
  setExperimentalSampling(experimentalSampling: Updater<boolean>): void
  setRefImageSize(refImageSize: Updater<'match' | 'max'>): void
  setNoDialogue(noDialogue: Updater<boolean>): void
  setNaturalMovement(naturalMovement: Updater<boolean>): void
  setClothingPolicy(clothingPolicy: Updater<'wardrobe' | 'underwear' | 'unrestricted'>): void
  setSigmaShiftMode(sigmaShiftMode: Updater<'model' | 'custom'>): void
  setShiftVideo(shiftVideo: Updater<number>): void
  setShiftAudio(shiftAudio: Updater<number>): void
  setLoraStrength(loraStrength: Updater<number>): void
  setSeed(seed: Updater<number>): void
  setAdvanced(advanced: Updater<boolean>): void
  setLiveEnabled(liveEnabled: Updater<boolean>): void
  setLivePreviewMode(livePreviewMode: Updater<'standard' | 'h3-override'>): void
  setUpscaleMode(upscaleMode: Updater<UpscaleMode>): void
  setRtxModel(rtxModel: Updater<string>): void
  setFirstFrame(firstFrame: Updater<MediaFile | null>): void
  setLastFrame(lastFrame: Updater<MediaFile | null>): void
  setReferenceImages(referenceImages: Updater<MediaFile[]>): void
  setReferenceVideos(referenceVideos: Updater<MediaFile[]>): void
  setReferenceAudios(referenceAudios: Updater<MediaFile[]>): void
  setTimelineGuides(timelineGuides: Updater<Array<{ file: MediaFile; seconds: number }>>): void
  setSelectedReferenceCharacterIds(ids: Updater<string[]>): void
  setSelectedReferenceLocationIds(ids: Updater<string[]>): void
  setActiveJobId(activeJobId: Updater<string | null>): void
  setMovieHandoff(movieHandoff: Updater<MovieLink | null>): void
  setCharacterHandoff(characterHandoff: Updater<string | null>): void
  setCharacterProjects(characterProjects: Updater<CharacterProject[]>): void
  setWardrobeProjects(wardrobeProjects: Updater<WardrobeProject[]>): void
  setLocationProjects(locationProjects: Updater<LocationProject[]>): void
  setHairStyleProjects(hairStyleProjects: Updater<HairStyleProject[]>): void
  setStorageBootDone(done: boolean): void
  bumpCreateResetKey(): void
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  ...persisted,
  characterProjects: loadCharacterProjects(),
  wardrobeProjects: loadWardrobeProjects(),
  locationProjects: loadLocationProjects(),
  hairStyleProjects: loadHairStyleProjects(),
  characterHandoff: null,
  createResetKey: 0,
  storageBootDone: false,
  patch: (partial) => set(partial),
  setMode: (mode) => set((state) => ({ mode: applied(mode, state.mode) })),
  setPrompt: (prompt) => set((state) => ({ prompt: applied(prompt, state.prompt) })),
  setDuration: (duration) => set((state) => ({ duration: applied(duration, state.duration) })),
  setResolution: (resolution) => set((state) => ({ resolution: applied(resolution, state.resolution) })),
  setTurbo: (turbo) => set((state) => ({ turbo: applied(turbo, state.turbo) })),
  setSteps: (steps) => set((state) => ({ steps: applied(steps, state.steps) })),
  setSampler: (sampler) => set((state) => ({ sampler: applied(sampler, state.sampler) })),
  setScheduler: (scheduler) => set((state) => ({ scheduler: applied(scheduler, state.scheduler) })),
  setExperimentalSampling: (experimentalSampling) => set((state) => ({ experimentalSampling: applied(experimentalSampling, state.experimentalSampling) })),
  setRefImageSize: (refImageSize) => set((state) => ({ refImageSize: applied(refImageSize, state.refImageSize) })),
  setNoDialogue: (noDialogue) => set((state) => ({ noDialogue: applied(noDialogue, state.noDialogue) })),
  setNaturalMovement: (naturalMovement) => set((state) => ({ naturalMovement: applied(naturalMovement, state.naturalMovement) })),
  setClothingPolicy: (clothingPolicy) => set((state) => ({ clothingPolicy: applied(clothingPolicy, state.clothingPolicy) })),
  setSigmaShiftMode: (sigmaShiftMode) => set((state) => ({ sigmaShiftMode: applied(sigmaShiftMode, state.sigmaShiftMode) })),
  setShiftVideo: (shiftVideo) => set((state) => ({ shiftVideo: applied(shiftVideo, state.shiftVideo) })),
  setShiftAudio: (shiftAudio) => set((state) => ({ shiftAudio: applied(shiftAudio, state.shiftAudio) })),
  setLoraStrength: (loraStrength) => set((state) => ({ loraStrength: applied(loraStrength, state.loraStrength) })),
  setSeed: (seed) => set((state) => ({ seed: applied(seed, state.seed) })),
  setAdvanced: (advanced) => set((state) => ({ advanced: applied(advanced, state.advanced) })),
  setLiveEnabled: (liveEnabled) => set((state) => ({ liveEnabled: applied(liveEnabled, state.liveEnabled) })),
  setLivePreviewMode: (livePreviewMode) => set((state) => ({ livePreviewMode: applied(livePreviewMode, state.livePreviewMode) })),
  setUpscaleMode: (upscaleMode) => set((state) => ({ upscaleMode: applied(upscaleMode, state.upscaleMode) })),
  setRtxModel: (rtxModel) => set((state) => ({ rtxModel: applied(rtxModel, state.rtxModel) })),
  setFirstFrame: (firstFrame) => set((state) => ({ firstFrame: applied(firstFrame, state.firstFrame) })),
  setLastFrame: (lastFrame) => set((state) => ({ lastFrame: applied(lastFrame, state.lastFrame) })),
  setReferenceImages: (referenceImages) => set((state) => ({ referenceImages: applied(referenceImages, state.referenceImages) })),
  setReferenceVideos: (referenceVideos) => set((state) => ({ referenceVideos: applied(referenceVideos, state.referenceVideos) })),
  setReferenceAudios: (referenceAudios) => set((state) => ({ referenceAudios: applied(referenceAudios, state.referenceAudios) })),
  setTimelineGuides: (timelineGuides) => set((state) => ({ timelineGuides: applied(timelineGuides, state.timelineGuides) })),
  setSelectedReferenceCharacterIds: (selectedReferenceCharacterIds) => set((state) => ({ selectedReferenceCharacterIds: applied(selectedReferenceCharacterIds, state.selectedReferenceCharacterIds) })),
  setSelectedReferenceLocationIds: (selectedReferenceLocationIds) => set((state) => ({ selectedReferenceLocationIds: applied(selectedReferenceLocationIds, state.selectedReferenceLocationIds) })),
  setActiveJobId: (activeJobId) => set((state) => ({ activeJobId: applied(activeJobId, state.activeJobId) })),
  setMovieHandoff: (movieHandoff) => set((state) => ({ movieHandoff: applied(movieHandoff, state.movieHandoff) })),
  setCharacterHandoff: (characterHandoff) => set((state) => ({ characterHandoff: applied(characterHandoff, state.characterHandoff) })),
  setCharacterProjects: (characterProjects) => set((state) => ({ characterProjects: applied(characterProjects, state.characterProjects) })),
  setWardrobeProjects: (wardrobeProjects) => set((state) => ({ wardrobeProjects: applied(wardrobeProjects, state.wardrobeProjects) })),
  setLocationProjects: (locationProjects) => set((state) => ({ locationProjects: applied(locationProjects, state.locationProjects) })),
  setHairStyleProjects: (hairStyleProjects) => set((state) => ({ hairStyleProjects: applied(hairStyleProjects, state.hairStyleProjects) })),
  setStorageBootDone: (storageBootDone) => set({ storageBootDone }),
  bumpCreateResetKey: () => set((state) => ({ createResetKey: state.createResetKey + 1 })),
}))

/** The persisted-document keys, in PersistedWorkspace order. The persistence
 *  listener gates on these so non-persisted mutations (library caches, boot
 *  latch, reset key) never trigger a workspace write. */
const PERSISTED_KEYS: ReadonlyArray<keyof PersistedWorkspace> = [
  'mode', 'prompt', 'duration', 'resolution', 'turbo', 'steps', 'sampler', 'scheduler', 'experimentalSampling',
  'refImageSize', 'noDialogue', 'naturalMovement', 'clothingPolicy', 'sigmaShiftMode', 'shiftVideo', 'shiftAudio',
  'loraStrength', 'seed', 'advanced', 'liveEnabled', 'livePreviewMode', 'upscaleMode', 'rtxModel', 'firstFrame',
  'lastFrame', 'referenceImages', 'referenceVideos', 'referenceAudios', 'timelineGuides',
  'selectedReferenceCharacterIds', 'selectedReferenceLocationIds', 'activeJobId', 'movieHandoff',
]

/** True when any persisted field differs between two store states — the exact
 *  set of changes that used to re-run the persistence effect. */
export function persistedWorkspaceChanged(previous: WorkspaceState, next: WorkspaceState): boolean {
  return PERSISTED_KEYS.some((key) => previous[key] !== next[key])
}

/** Builds the persisted document from a store state (previews stripped, same
 *  mapping the persistence effect always performed). */
export function workspaceSnapshot(state: WorkspaceState): PersistedWorkspace {
  return {
    mode: state.mode, prompt: state.prompt, duration: state.duration, resolution: state.resolution, turbo: state.turbo,
    steps: state.steps, sampler: state.sampler, scheduler: state.scheduler, experimentalSampling: state.experimentalSampling,
    refImageSize: state.refImageSize, noDialogue: state.noDialogue, naturalMovement: state.naturalMovement, clothingPolicy: state.clothingPolicy,
    sigmaShiftMode: state.sigmaShiftMode, shiftVideo: state.shiftVideo, shiftAudio: state.shiftAudio, loraStrength: state.loraStrength,
    seed: state.seed, advanced: state.advanced, liveEnabled: state.liveEnabled, livePreviewMode: state.livePreviewMode,
    upscaleMode: state.upscaleMode, rtxModel: state.rtxModel, firstFrame: withoutPreview(state.firstFrame), lastFrame: withoutPreview(state.lastFrame),
    referenceImages: state.referenceImages.map((file) => withoutPreview(file)!),
    referenceVideos: state.referenceVideos.map((file) => withoutPreview(file)!),
    referenceAudios: state.referenceAudios.map((file) => withoutPreview(file)!),
    timelineGuides: state.timelineGuides.map((guide) => ({ file: withoutPreview(guide.file)!, seconds: guide.seconds })),
    selectedReferenceCharacterIds: state.selectedReferenceCharacterIds, selectedReferenceLocationIds: state.selectedReferenceLocationIds,
    activeJobId: state.activeJobId, movieHandoff: state.movieHandoff,
  }
}
