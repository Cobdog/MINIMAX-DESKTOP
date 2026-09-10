/** The MiniMax Create workspace domain: every persisted creation field, the
 *  character/wardrobe/location libraries it binds references from, reference
 *  selection and ordering, media picking, and workspace reset. Generation
 *  submission itself stays in App — this hook owns what is being composed. */
import { useEffect, useRef, useState } from 'react'
import type { AppSettings, CharacterProject, GenerationMode, LocationProject, MediaFile, MediaKind, MovieReferenceBinding, UpscaleMode, WardrobeProject } from '../types'
import { CHARACTER_LIBRARY_EVENT, characterReferences, loadCharacterProjects } from '../lib/characterLibrary'
import { loadWardrobeProjects, wardrobeReferences, WARDROBE_LIBRARY_EVENT } from '../lib/wardrobeLibrary'
import { loadLocationProjects, locationReferences, LOCATION_LIBRARY_EVENT } from '../lib/locationLibrary'
import { allocateWorkspaceReferences, composeReferenceInstructions } from '../lib/promptComposer'
import { fitWholeCharacter } from '../lib/imageCrop'
import { syncReferencePrompt } from '../lib/promptPolicies'
import { readWorkspace, withoutPreview, workspaceDefaults, type MovieLink, type PersistedWorkspace } from '../lib/workspace'
import type { NoticeTone } from './useGenerationQueue'

export type VideoClipDraft = { source: MediaFile; replaceIndex?: number }

export function useCreateWorkspace(options: {
  settings: AppSettings | null
  rtxModels: string[]
  notify(tone: NoticeTone, text: string): void
  setVideoClipDraft(dispatch: (value: VideoClipDraft | null) => VideoClipDraft | null): void
}) {
  const { settings, rtxModels, notify, setVideoClipDraft } = options
  const persisted = useState(readWorkspace)[0]
  const [mode, setMode] = useState<GenerationMode>(persisted.mode)
  const [prompt, setPrompt] = useState(persisted.prompt)
  const [duration, setDuration] = useState(persisted.duration)
  const [resolution, setResolution] = useState(persisted.resolution)
  const [turbo, setTurbo] = useState<'off' | '4' | '8'>(persisted.turbo)
  const [steps, setSteps] = useState(persisted.steps)
  const [sampler, setSampler] = useState(persisted.sampler)
  const [scheduler, setScheduler] = useState(persisted.scheduler)
  const [experimentalSampling, setExperimentalSampling] = useState(persisted.experimentalSampling)
  const [refImageSize, setRefImageSize] = useState<'match' | 'max'>(persisted.refImageSize)
  const [noDialogue, setNoDialogue] = useState(persisted.noDialogue)
  const [naturalMovement, setNaturalMovement] = useState(persisted.naturalMovement)
  const [clothingPolicy, setClothingPolicy] = useState<'wardrobe' | 'underwear' | 'unrestricted'>(persisted.clothingPolicy)
  const [sigmaShiftMode, setSigmaShiftMode] = useState<'model' | 'custom'>(persisted.sigmaShiftMode)
  const [shiftVideo, setShiftVideo] = useState(persisted.shiftVideo)
  const [shiftAudio, setShiftAudio] = useState(persisted.shiftAudio)
  const [loraStrength, setLoraStrength] = useState(persisted.loraStrength)
  const [liveEnabled, setLiveEnabled] = useState(persisted.liveEnabled)
  const [livePreviewMode, setLivePreviewMode] = useState<'standard' | 'h3-override'>(persisted.livePreviewMode)
  const [upscaleMode, setUpscaleMode] = useState<UpscaleMode>(persisted.upscaleMode)
  const [rtxModel, setRtxModel] = useState(persisted.rtxModel)
  const [seed, setSeed] = useState(persisted.seed)
  const [advanced, setAdvanced] = useState(persisted.advanced)
  const [firstFrame, setFirstFrame] = useState<MediaFile | null>(persisted.firstFrame)
  const [lastFrame, setLastFrame] = useState<MediaFile | null>(persisted.lastFrame)
  const [referenceImages, setReferenceImages] = useState<MediaFile[]>(persisted.referenceImages)
  const [referenceVideos, setReferenceVideos] = useState<MediaFile[]>(persisted.referenceVideos)
  const [referenceAudios, setReferenceAudios] = useState<MediaFile[]>(persisted.referenceAudios)
  const [characterProjects, setCharacterProjects] = useState<CharacterProject[]>(loadCharacterProjects)
  const [wardrobeProjects, setWardrobeProjects] = useState<WardrobeProject[]>(loadWardrobeProjects)
  const [locationProjects, setLocationProjects] = useState<LocationProject[]>(loadLocationProjects)
  const [selectedReferenceCharacterIds, setSelectedReferenceCharacterIds] = useState<string[]>(persisted.selectedReferenceCharacterIds)
  const [selectedReferenceLocationIds, setSelectedReferenceLocationIds] = useState<string[]>(persisted.selectedReferenceLocationIds)
  const [activeJobId, setActiveJobId] = useState<string | null>(persisted.activeJobId)
  const [movieHandoff, setMovieHandoff] = useState<MovieLink | null>(persisted.movieHandoff)
  const [characterHandoff, setCharacterHandoff] = useState<string | null>(null)
  const [createResetKey, setCreateResetKey] = useState(0)
  const mediaHydrated = useRef(false)

  useEffect(() => {
    const refresh = () => setCharacterProjects(loadCharacterProjects())
    window.addEventListener(CHARACTER_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(CHARACTER_LIBRARY_EVENT, refresh)
  }, [])
  useEffect(() => {
    const refresh = () => setWardrobeProjects(loadWardrobeProjects())
    window.addEventListener(WARDROBE_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(WARDROBE_LIBRARY_EVENT, refresh)
  }, [])
  useEffect(() => {
    const refresh = () => setLocationProjects(loadLocationProjects())
    window.addEventListener(LOCATION_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(LOCATION_LIBRARY_EVENT, refresh)
  }, [])

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

  useEffect(() => {
    const workspace: PersistedWorkspace = {
      mode, prompt, duration, resolution, turbo, steps, sampler, scheduler, experimentalSampling, refImageSize, noDialogue, naturalMovement, clothingPolicy,
      sigmaShiftMode, shiftVideo, shiftAudio, loraStrength, seed, advanced, liveEnabled, livePreviewMode,
      upscaleMode, rtxModel, firstFrame: withoutPreview(firstFrame), lastFrame: withoutPreview(lastFrame),
      referenceImages: referenceImages.map((file) => withoutPreview(file)!),
      referenceVideos: referenceVideos.map((file) => withoutPreview(file)!),
      referenceAudios: referenceAudios.map((file) => withoutPreview(file)!), selectedReferenceCharacterIds, selectedReferenceLocationIds, activeJobId, movieHandoff,
    }
    localStorage.setItem('minimax.workspace', JSON.stringify(workspace))
  }, [activeJobId, advanced, clothingPolicy, duration, experimentalSampling, firstFrame, lastFrame, liveEnabled, livePreviewMode, loraStrength, mode, movieHandoff, naturalMovement, noDialogue, prompt, refImageSize, referenceAudios, referenceImages, referenceVideos, resolution, rtxModel, sampler, scheduler, seed, selectedReferenceCharacterIds, selectedReferenceLocationIds, shiftAudio, shiftVideo, sigmaShiftMode, steps, turbo, upscaleMode])

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
  }, [firstFrame, lastFrame, referenceImages, settings])

  useEffect(() => {
    if (!rtxModel && rtxModels.length) setRtxModel(rtxModels[0])
  }, [rtxModel, rtxModels])

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
  }, [characterProjects, locationProjects, selectedReferenceCharacterIds, selectedReferenceLocationIds, wardrobeProjects])

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
    const file = referenceVideos[index]
    if (!file) return
    const sourcePath = file.clip?.sourcePath ?? file.path
    const preview = await window.minimax.mediaUrl(sourcePath)
    setVideoClipDraft(() => ({ source: { ...file, path: sourcePath, name: file.clip?.sourceName ?? file.name, preview }, replaceIndex: index }))
  }

  const resetCreateWorkspace = () => {
    const defaults = settings?.generationDefaults
    setMode('text')
    setPrompt('')
    setDuration(defaults?.duration ?? workspaceDefaults.duration)
    setResolution(defaults?.resolution ?? workspaceDefaults.resolution)
    setTurbo(defaults?.turbo ?? workspaceDefaults.turbo)
    setSteps(defaults?.steps ?? workspaceDefaults.steps)
    setSampler(defaults?.sampler ?? workspaceDefaults.sampler)
    setScheduler(defaults?.scheduler ?? workspaceDefaults.scheduler)
    setExperimentalSampling(defaults?.experimentalSampling ?? workspaceDefaults.experimentalSampling)
    setRefImageSize(defaults?.refImageSize ?? workspaceDefaults.refImageSize)
    setNoDialogue(true)
    setClothingPolicy('wardrobe')
    setSigmaShiftMode(defaults?.sigmaShiftMode ?? workspaceDefaults.sigmaShiftMode)
    setShiftVideo(defaults?.shiftVideo ?? workspaceDefaults.shiftVideo)
    setShiftAudio(defaults?.shiftAudio ?? workspaceDefaults.shiftAudio)
    setLoraStrength(defaults?.loraStrength ?? workspaceDefaults.loraStrength)
    setLiveEnabled(defaults?.livePreview ?? workspaceDefaults.liveEnabled)
    setLivePreviewMode('standard')
    setUpscaleMode(defaults?.upscaleMode ?? workspaceDefaults.upscaleMode)
    setRtxModel('')
    setSeed(Math.floor(Math.random() * 1_000_000_000))
    setAdvanced(false)
    setFirstFrame(null)
    setLastFrame(null)
    setReferenceImages([])
    setReferenceVideos([])
    setReferenceAudios([])
    setVideoClipDraft(() => null)
    setActiveJobId(null)
    setMovieHandoff(null)
    setCharacterHandoff(null)
    setSelectedReferenceCharacterIds([])
    setSelectedReferenceLocationIds([])
    setCreateResetKey((value) => value + 1)
    notify('success', 'MiniMax Create reset. Saved libraries, rendered files, and queue history were not deleted.')
  }

  return {
    // persisted creation fields
    mode, setMode, prompt, setPrompt, duration, setDuration, resolution, setResolution,
    turbo, setTurbo, steps, setSteps, sampler, setSampler, scheduler, setScheduler,
    experimentalSampling, setExperimentalSampling, refImageSize, setRefImageSize,
    noDialogue, setNoDialogue, naturalMovement, setNaturalMovement,
    clothingPolicy, setClothingPolicy, sigmaShiftMode, setSigmaShiftMode,
    shiftVideo, setShiftVideo, shiftAudio, setShiftAudio, loraStrength, setLoraStrength,
    liveEnabled, setLiveEnabled, livePreviewMode, setLivePreviewMode,
    upscaleMode, setUpscaleMode, rtxModel, setRtxModel, seed, setSeed, advanced, setAdvanced,
    // media and references
    firstFrame, setFirstFrame, lastFrame, setLastFrame,
    referenceImages, setReferenceImages, referenceVideos, setReferenceVideos, referenceAudios, setReferenceAudios,
    // libraries
    characterProjects, wardrobeProjects, locationProjects,
    selectedReferenceCharacterIds, setSelectedReferenceCharacterIds,
    selectedReferenceLocationIds, setSelectedReferenceLocationIds,
    // handoffs and reset
    activeJobId, setActiveJobId, movieHandoff, setMovieHandoff, characterHandoff, setCharacterHandoff,
    createResetKey, resetCreateWorkspace,
    // helpers
    chooseMedia, chooseMany, editVideoReference, refreshSourceMedia,
    workspaceBindingsFor, loadReferenceCharacter, loadReferenceLocation, loadReferenceWardrobe,
  }
}

export type CreateWorkspace = ReturnType<typeof useCreateWorkspace>
