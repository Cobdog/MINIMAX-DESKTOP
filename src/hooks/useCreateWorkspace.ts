/** The MiniMax Create workspace domain: every persisted creation field, the
 *  character/wardrobe/location libraries it binds references from, reference
 *  selection and ordering, media picking, and workspace reset. Generation
 *  submission itself stays in App — this hook owns what is being composed.
 *
 *  Wave 2a: the VALUES live in `useWorkspaceStore` (zustand); this hook is
 *  the facade that keeps every effect (library event syncs, boot load,
 *  persistence, media hydration, reference binding). The return shape is
 *  UNCHANGED so existing consumers compile untouched — but consumers that
 *  need live per-field values (CreateView, App render paths, generation
 *  flows) select from the store directly: the state fields on this facade
 *  are a snapshot from this hook's last render. The facade subscribes ONLY
 *  to the slices its effects consume (libraries, selections, picked media,
 *  rtx model — all low-frequency); the high-frequency editing fields (prompt,
 *  duration, steps, seed, sigma shifts…) no longer re-render the App root
 *  that hosts this hook. */
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AppSettings, CharacterProject, LocationProject, MediaFile, MediaKind, MovieReferenceBinding } from '../types'
import { CHARACTER_LIBRARY_EVENT, characterReferences, loadCharacterProjects } from '../lib/characterLibrary'
import { loadWardrobeProjects, wardrobeReferences, WARDROBE_LIBRARY_EVENT } from '../lib/wardrobeLibrary'
import { loadLocationProjects, locationReferences, LOCATION_LIBRARY_EVENT } from '../lib/locationLibrary'
import { HAIR_LIBRARY_EVENT, loadHairStyleProjects } from '../lib/hairLibrary'
import { allocateWorkspaceReferences, composeReferenceInstructions } from '../lib/promptComposer'
import { fitWholeCharacter } from '../lib/imageCrop'
import { syncReferencePrompt } from '../lib/promptPolicies'
import { normalizeWorkspace, workspaceDefaults } from '../lib/workspace'
import { fetchServerWorkspace, saveServerWorkspace } from '../lib/serverStorage'
import { persistedWorkspaceChanged, useWorkspaceStore, workspaceSnapshot } from '../state/workspaceStore'
import type { NoticeTone } from './useGenerationQueue'
import { useDebouncedPersist } from './useDebouncedPersist'

export type VideoClipDraft = { source: MediaFile; replaceIndex?: number }

export function useCreateWorkspace(options: {
  settings: AppSettings | null
  rtxModels: string[]
  notify(tone: NoticeTone, text: string): void
  setVideoClipDraft(dispatch: (value: VideoClipDraft | null) => VideoClipDraft | null): void
}) {
  const { settings, rtxModels, notify, setVideoClipDraft } = options
  // The effect-consumed slices (see the module doc). useShallow so a library
  // event that returns an equal-by-reference list does not re-render.
  const {
    characterProjects, wardrobeProjects, locationProjects,
    selectedReferenceCharacterIds, selectedReferenceLocationIds,
    firstFrame, lastFrame, referenceImages, rtxModel,
  } = useWorkspaceStore(useShallow((state) => ({
    characterProjects: state.characterProjects,
    wardrobeProjects: state.wardrobeProjects,
    locationProjects: state.locationProjects,
    selectedReferenceCharacterIds: state.selectedReferenceCharacterIds,
    selectedReferenceLocationIds: state.selectedReferenceLocationIds,
    firstFrame: state.firstFrame,
    lastFrame: state.lastFrame,
    referenceImages: state.referenceImages,
    rtxModel: state.rtxModel,
  })))
  // Stable store actions — captured once, never go stale.
  const {
    patch, setMode, setPrompt, setRefImageSize, setClothingPolicy, setRtxModel, setFirstFrame, setLastFrame,
    setReferenceImages, setReferenceAudios, setSelectedReferenceCharacterIds, setSelectedReferenceLocationIds,
    setCharacterHandoff, setCharacterProjects, setWardrobeProjects, setLocationProjects, setHairStyleProjects,
    setStorageBootDone, bumpCreateResetKey,
  } = useWorkspaceStore.getState()
  const mediaHydrated = useRef(false)

  useEffect(() => {
    const refresh = () => setCharacterProjects(loadCharacterProjects())
    window.addEventListener(CHARACTER_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(CHARACTER_LIBRARY_EVENT, refresh)
  }, [setCharacterProjects])
  useEffect(() => {
    const refresh = () => setWardrobeProjects(loadWardrobeProjects())
    window.addEventListener(WARDROBE_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(WARDROBE_LIBRARY_EVENT, refresh)
  }, [setWardrobeProjects])
  useEffect(() => {
    const refresh = () => setLocationProjects(loadLocationProjects())
    window.addEventListener(LOCATION_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(LOCATION_LIBRARY_EVENT, refresh)
  }, [setLocationProjects])
  useEffect(() => {
    const refresh = () => setHairStyleProjects(loadHairStyleProjects())
    window.addEventListener(HAIR_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(HAIR_LIBRARY_EVENT, refresh)
  }, [setHairStyleProjects])

  useEffect(() => {
    let disposed = false
    void Promise.all(characterProjects.map(async (character) => {
      const bindings = allocateWorkspaceReferences([{ id: character.id, name: character.name, identity: characterReferences(character), hairStyleIds: character.hairStyleIds, wardrobeIds: character.wardrobeIds, accessoryIds: character.accessoryIds }], wardrobeProjects, [])
      const wardrobe = wardrobeProjects.find((item) => item.id === character.wardrobeIds[0])
      const references = await Promise.all(bindings.map(async (binding) => {
        let preview = binding.file.preview ?? ''
        if (!preview.startsWith('data:')) {
          try { preview = await window.minimax.fileDataUrl(binding.file.path) } catch { /* Omit inaccessible media from the phone library. */ }
        }
        return { name: binding.file.name, preview, purpose: binding.purpose, label: binding.label }
      }))
      return { id: character.id, name: character.name, description: character.description, wardrobe: wardrobe && wardrobeReferences(wardrobe).length ? wardrobe.name : '', voiceNotes: character.voiceNotes, visualStyle: character.visualStyle, referenceInstructions: composeReferenceInstructions(bindings), references: references.filter((file) => file.preview.startsWith('data:')) }
    })).then((characters) => { if (!disposed) return window.minimax.syncMobileCharacters(characters) }).catch(() => undefined)
    return () => { disposed = true }
  }, [characterProjects, wardrobeProjects])

  // Boot load (wave 1): the server's SQLite workspace is authoritative. The
  // localStorage snapshot above paints instantly (and remains correct on a
  // pre-migration first boot); the server answer replaces it once it lands.
  // A missing server workspace (fresh install, copy not yet run) keeps the
  // local state, and a fetch failure keeps the app working offline. The
  // 3 s fail-safe unblocks persistence even if the request hangs.
  useEffect(() => {
    let disposed = false
    const failSafe = window.setTimeout(() => { if (!disposed) setStorageBootDone(true) }, 3000)
    void fetchServerWorkspace()
      .then((loaded) => {
        if (disposed || !loaded) return
        patch(normalizeWorkspace(loaded))
      })
      .catch(() => undefined)
      .finally(() => { if (!disposed) setStorageBootDone(true) })
    return () => { disposed = true; window.clearTimeout(failSafe) }
  }, [patch, setStorageBootDone])

  // Persistence is debounced (300 ms trailing) and now driven by a store
  // subscription instead of a render-keyed effect: the old effect re-ran on
  // every keystroke through the App root; this listener fires on exactly the
  // same set of changes (any persisted field, plus the boot-done flip) with
  // zero React involvement. Semantics are identical — the write serializes
  // the complete workspace snapshot captured when the change was scheduled,
  // the debounce hook replaces the pending write on each change and flushes
  // the latest on pagehide/beforeunload/unmount, and writes wait for the
  // boot load so a stale local snapshot cannot overwrite the server's newer
  // workspace before it has been read.
  //
  // Multi-tab model: whole-workspace last-write-wins at the server (the
  // newest complete document wins). True cross-tab live sync arrives with
  // the realtime fabric.
  const persistWorkspace = useDebouncedPersist(300)
  useEffect(() => useWorkspaceStore.subscribe((state, previous) => {
    const bootCompleted = !previous.storageBootDone && state.storageBootDone
    if (!state.storageBootDone || (!bootCompleted && !persistedWorkspaceChanged(previous, state))) return
    const workspace = workspaceSnapshot(state)
    persistWorkspace(() => {
      void saveServerWorkspace(workspace).catch(() => {
        // Degraded mode: mirror to the legacy store so a boot while the API
        // is unreachable still finds the workspace.
        try { localStorage.setItem('minimax.workspace', JSON.stringify(workspace)) } catch { /* Quota: the next debounced write retries. */ }
      })
    })
  }), [persistWorkspace])

  useEffect(() => {
    if (!settings || mediaHydrated.current) return
    mediaHydrated.current = true
    const hydrate = async (file: MediaFile | null) => {
      if (!file || file.kind !== 'image' || file.preview) return file
      try { return { ...file, preview: await window.minimax.fileDataUrl(file.path) } } catch { return file }
    }
    void Promise.all([hydrate(firstFrame), hydrate(lastFrame)]).then(([first, last]) => {
      setFirstFrame(first); setLastFrame(last)
    })
    void Promise.all(referenceImages.map(hydrate)).then((files) => setReferenceImages(files.filter(Boolean) as MediaFile[]))
  }, [firstFrame, lastFrame, referenceImages, setFirstFrame, setLastFrame, setReferenceImages, settings])

  useEffect(() => {
    if (!rtxModel && rtxModels.length) setRtxModel(rtxModels[0])
  }, [rtxModel, rtxModels, setRtxModel])

  // Keep selected library assets authoritative. Character Studio and Wardrobe
  // Studio can change a link while this workspace (and even its modal) remains
  // mounted. Rebuild the actual render inputs whenever either library changes
  // so the checked active outfit cannot remain UI-only state.
  useEffect(() => {
    if (!selectedReferenceCharacterIds.length && !selectedReferenceLocationIds.length) return
    let disposed = false
    const selectedCharacters = selectedReferenceCharacterIds.map((id) => characterProjects.find((project) => project.id === id)).filter(Boolean) as CharacterProject[]
    const selectedLocations = selectedReferenceLocationIds.map((id) => locationProjects.find((project) => project.id === id)).filter(Boolean) as LocationProject[]
    const next = allocateWorkspaceReferences(
      selectedCharacters.map((character) => ({ id: character.id, name: character.name, identity: characterReferences(character), hairStyleIds: character.hairStyleIds, wardrobeIds: character.wardrobeIds, accessoryIds: character.accessoryIds })),
      wardrobeProjects,
      selectedLocations.map((location) => ({ id: location.id, name: location.name, images: locationReferences(location), environmentMode: location.environmentMode })),
    )
    void Promise.all(next.map(async ({ file }) => {
      if (file.preview) return file
      try { return { ...file, preview: await window.minimax.fileDataUrl(file.path) } } catch { return file }
    })).then((images) => {
      if (disposed) return
      setReferenceImages(images)
      setPrompt((current) => syncReferencePrompt(current, [], next))
    })
    return () => { disposed = true }
  }, [characterProjects, locationProjects, selectedReferenceCharacterIds, selectedReferenceLocationIds, setPrompt, setReferenceImages, wardrobeProjects])

  const workspaceBindingsFor = (characterIds: string[], locationIds: string[]) => {
    // Resolve every linked record from storage at selection time. A Character
    // Studio save and a Source Media click can occur before React has committed
    // the library event, which previously left the character's new wardrobe out.
    const currentCharacters = loadCharacterProjects()
    const currentLocations = loadLocationProjects()
    const selectedCharacters = characterIds.map((id) => currentCharacters.find((project) => project.id === id)).filter(Boolean) as CharacterProject[]
    const selectedLocations = locationIds.map((id) => currentLocations.find((project) => project.id === id)).filter(Boolean) as LocationProject[]
    const currentWardrobes = loadWardrobeProjects()
    return allocateWorkspaceReferences(
      selectedCharacters.map((character) => ({ id: character.id, name: character.name, identity: characterReferences(character), hairStyleIds: character.hairStyleIds, wardrobeIds: character.wardrobeIds, accessoryIds: character.accessoryIds })),
      currentWardrobes,
      selectedLocations.map((location) => ({ id: location.id, name: location.name, images: locationReferences(location), environmentMode: location.environmentMode })),
    )
  }

  const applyWorkspaceBindings = async (previous: MovieReferenceBinding[], next: MovieReferenceBinding[]) => {
    const images = await Promise.all(next.map(async ({ file: source }) => {
      if (source.preview) return source
      try { return { ...source, preview: await window.minimax.fileDataUrl(source.path) } }
      catch { return source }
    }))
    setReferenceImages(images)
    setPrompt((current) => syncReferencePrompt(current, previous, next))
    return images
  }

  const refreshSourceMedia = async () => {
    const previous = workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    setCharacterProjects(loadCharacterProjects())
    setWardrobeProjects(loadWardrobeProjects())
    setLocationProjects(loadLocationProjects())
    setHairStyleProjects(loadHairStyleProjects())
    const next = workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    if (selectedReferenceCharacterIds.length || selectedReferenceLocationIds.length) await applyWorkspaceBindings(previous, next)
  }

  const loadReferenceCharacter = async (characterId: string) => {
    const previousBindings = workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    const selectedIds = characterId ? (selectedReferenceCharacterIds.includes(characterId) ? selectedReferenceCharacterIds.filter((id) => id !== characterId) : [...selectedReferenceCharacterIds, characterId]) : []
    setSelectedReferenceCharacterIds(selectedIds)
    setMode('reference')
    const selectedCharacters = selectedIds.map((id) => characterProjects.find((project) => project.id === id)).filter(Boolean) as CharacterProject[]
    if (selectedCharacters.some((character) => characterReferences(character).length === 0)) {
      notify('error', 'Every selected character needs at least one approved identity image.')
      return
    }
    const bindings = workspaceBindingsFor(selectedIds, selectedReferenceLocationIds)
    await applyWorkspaceBindings(previousBindings, bindings)
    const identityCount = bindings.filter((item) => item.purpose === 'character' || item.purpose === 'character-angle').length
    const hairCount = bindings.filter((item) => item.purpose === 'hair').length
    const wardrobeCount = bindings.filter((item) => item.purpose === 'wardrobe').length
    const locationCount = bindings.filter((item) => item.purpose === 'location').length
    notify('success', selectedCharacters.length ? `Using ${identityCount} identity, ${hairCount} hair, ${wardrobeCount} wardrobe, and ${locationCount} location picture${locationCount === 1 ? '' : 's'} across ${bindings.length} of 9 slots.` : locationCount ? `Cast cleared. Keeping ${locationCount} location picture${locationCount === 1 ? '' : 's'}.` : 'Cleared character references.')
  }

  const loadReferenceLocation = async (locationId: string) => {
    const previousBindings = workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    if (!locationId) {
      setSelectedReferenceLocationIds([]); setMode('reference')
      const bindings = workspaceBindingsFor(selectedReferenceCharacterIds, [])
      await applyWorkspaceBindings(previousBindings, bindings)
      notify('success', bindings.length ? `Locations cleared. Keeping ${bindings.length} character and wardrobe picture${bindings.length === 1 ? '' : 's'}.` : 'Cleared location references.')
      return
    }
    const location = locationProjects.find((project) => project.id === locationId)
    if (!location) return
    const sources = locationReferences(location)
    if (!sources.length) { notify('error', `${location.name} needs an approved reference image first.`); return }
    const selectedIds = selectedReferenceLocationIds.includes(locationId) ? selectedReferenceLocationIds.filter((id) => id !== locationId) : [...selectedReferenceLocationIds, locationId]
    setSelectedReferenceLocationIds(selectedIds); setMode('reference')
    const bindings = workspaceBindingsFor(selectedReferenceCharacterIds, selectedIds)
    await applyWorkspaceBindings(previousBindings, bindings)
    const locationCount = bindings.filter((item) => item.purpose === 'location').length
    notify('success', selectedIds.includes(locationId) ? `Added ${location.name}. Characters, wardrobe, and locations now use ${bindings.length} of 9 picture slots.` : `${location.name} removed. ${locationCount} location picture${locationCount === 1 ? '' : 's'} remain.`)
  }

  const loadReferenceWardrobe = async (wardrobeId: string) => {
    const wardrobe = wardrobeProjects.find((project) => project.id === wardrobeId)
    if (!wardrobe) return
    const approved = wardrobeReferences(wardrobe).slice(0, 9).map(fitWholeCharacter)
    if (!approved.length) { notify('error', `${wardrobe.name} has no approved wardrobe images yet.`); return }
    const images = await Promise.all(approved.map(async (file) => { if (file.preview) return file; try { return { ...file, preview: await window.minimax.fileDataUrl(file.path) } } catch { return file } }))
    setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setMode('reference'); setReferenceImages(images)
    notify('success', `Loaded ${images.length} approved wardrobe reference${images.length === 1 ? '' : 's'} for ${wardrobe.name}.`)
  }

  const chooseMedia = async (kind: MediaKind, setter: (file: MediaFile) => void) => {
    const picked = await window.minimax.chooseMedia(kind)
    if (!picked) return
    let preview: string | undefined
    if (kind === 'image') preview = await window.minimax.fileDataUrl(picked.path)
    setter({ ...picked, kind, preview })
  }

  const chooseMany = async (kind: MediaKind) => {
    if (kind === 'video') {
      const picked = await window.minimax.chooseMedia('video')
      if (!picked) return
      const preview = await window.minimax.mediaUrl(picked.path)
      setVideoClipDraft(() => ({ source: { ...picked, kind: 'video', preview } }))
      return
    }
    await chooseMedia(kind, (file) => {
      if (kind === 'image') { setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setReferenceImages((current) => current.length < 9 ? [...current, file] : current) }
      if (kind === 'audio') setReferenceAudios((current) => current.length < 3 ? [...current, file] : current)
    })
  }

  const editVideoReference = async (index: number) => {
    // Read through the store: reference videos can change without this
    // facade re-rendering, and the closure must never act on a stale list.
    const file = useWorkspaceStore.getState().referenceVideos[index]
    if (!file) return
    const sourcePath = file.clip?.sourcePath ?? file.path
    const preview = await window.minimax.mediaUrl(sourcePath)
    setVideoClipDraft(() => ({ source: { ...file, path: sourcePath, name: file.clip?.sourceName ?? file.name, preview }, replaceIndex: index }))
  }

  const resetCreateWorkspace = () => {
    const defaults = settings?.generationDefaults
    // One atomic store write (the original called each setter in sequence —
    // React batched them; a single set preserves the same one-notify
    // behavior) plus the remount-key bump.
    const seed = Math.floor(Math.random() * 1_000_000_000)
    patch({
      mode: 'text',
      prompt: '',
      duration: defaults?.duration ?? workspaceDefaults.duration,
      resolution: defaults?.resolution ?? workspaceDefaults.resolution,
      turbo: defaults?.turbo ?? workspaceDefaults.turbo,
      steps: defaults?.steps ?? workspaceDefaults.steps,
      sampler: defaults?.sampler ?? workspaceDefaults.sampler,
      scheduler: defaults?.scheduler ?? workspaceDefaults.scheduler,
      experimentalSampling: defaults?.experimentalSampling ?? workspaceDefaults.experimentalSampling,
      refImageSize: defaults?.refImageSize ?? workspaceDefaults.refImageSize,
      noDialogue: true,
      clothingPolicy: 'wardrobe',
      sigmaShiftMode: defaults?.sigmaShiftMode ?? workspaceDefaults.sigmaShiftMode,
      shiftVideo: defaults?.shiftVideo ?? workspaceDefaults.shiftVideo,
      shiftAudio: defaults?.shiftAudio ?? workspaceDefaults.shiftAudio,
      loraStrength: defaults?.loraStrength ?? workspaceDefaults.loraStrength,
      liveEnabled: defaults?.livePreview ?? workspaceDefaults.liveEnabled,
      livePreviewMode: 'standard',
      upscaleMode: defaults?.upscaleMode ?? workspaceDefaults.upscaleMode,
      rtxModel: '',
      seed,
      advanced: false,
      firstFrame: null,
      lastFrame: null,
      referenceImages: [],
      referenceVideos: [],
      referenceAudios: [],
      timelineGuides: [],
      activeJobId: null,
      movieHandoff: null,
      selectedReferenceCharacterIds: [],
      selectedReferenceLocationIds: [],
    })
    setCharacterHandoff(null)
    bumpCreateResetKey()
    setVideoClipDraft(() => null)
    notify('success', 'MiniMax Create reset. Saved libraries, rendered files, and queue history were not deleted.')
  }

  // A call-time snapshot for shape compatibility (see the module doc). The
  // subscribed slices above are live; everything else is read here.
  const snapshot = useWorkspaceStore.getState()
  return {
    // persisted creation fields
    mode: snapshot.mode, setMode, prompt: snapshot.prompt, setPrompt, duration: snapshot.duration, setDuration: snapshot.setDuration, resolution: snapshot.resolution, setResolution: snapshot.setResolution,
    turbo: snapshot.turbo, setTurbo: snapshot.setTurbo, steps: snapshot.steps, setSteps: snapshot.setSteps, sampler: snapshot.sampler, setSampler: snapshot.setSampler, scheduler: snapshot.scheduler, setScheduler: snapshot.setScheduler,
    experimentalSampling: snapshot.experimentalSampling, setExperimentalSampling: snapshot.setExperimentalSampling, refImageSize: snapshot.refImageSize, setRefImageSize,
    noDialogue: snapshot.noDialogue, setNoDialogue: snapshot.setNoDialogue, naturalMovement: snapshot.naturalMovement, setNaturalMovement: snapshot.setNaturalMovement,
    clothingPolicy: snapshot.clothingPolicy, setClothingPolicy, sigmaShiftMode: snapshot.sigmaShiftMode, setSigmaShiftMode: snapshot.setSigmaShiftMode,
    shiftVideo: snapshot.shiftVideo, setShiftVideo: snapshot.setShiftVideo, shiftAudio: snapshot.shiftAudio, setShiftAudio: snapshot.setShiftAudio, loraStrength: snapshot.loraStrength, setLoraStrength: snapshot.setLoraStrength,
    liveEnabled: snapshot.liveEnabled, setLiveEnabled: snapshot.setLiveEnabled, livePreviewMode: snapshot.livePreviewMode, setLivePreviewMode: snapshot.setLivePreviewMode,
    upscaleMode: snapshot.upscaleMode, setUpscaleMode: snapshot.setUpscaleMode, rtxModel, setRtxModel, seed: snapshot.seed, setSeed: snapshot.setSeed, advanced: snapshot.advanced, setAdvanced: snapshot.setAdvanced,
    // media and references
    firstFrame, setFirstFrame, lastFrame, setLastFrame,
    referenceImages, setReferenceImages, referenceVideos: snapshot.referenceVideos, setReferenceVideos: snapshot.setReferenceVideos, referenceAudios: snapshot.referenceAudios, setReferenceAudios,
    timelineGuides: snapshot.timelineGuides, setTimelineGuides: snapshot.setTimelineGuides,
    // libraries
    characterProjects, wardrobeProjects, locationProjects, hairStyleProjects: snapshot.hairStyleProjects,
    selectedReferenceCharacterIds, setSelectedReferenceCharacterIds,
    selectedReferenceLocationIds, setSelectedReferenceLocationIds,
    // handoffs and reset
    activeJobId: snapshot.activeJobId, setActiveJobId: snapshot.setActiveJobId, movieHandoff: snapshot.movieHandoff, setMovieHandoff: snapshot.setMovieHandoff, characterHandoff: snapshot.characterHandoff, setCharacterHandoff,
    createResetKey: snapshot.createResetKey, resetCreateWorkspace,
    // helpers
    chooseMedia, chooseMany, editVideoReference, refreshSourceMedia,
    workspaceBindingsFor, loadReferenceCharacter, loadReferenceLocation, loadReferenceWardrobe,
  }
}
