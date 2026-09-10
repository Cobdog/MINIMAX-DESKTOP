import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createId } from './lib/createId'
import { isPastRunningDeadline, isTerminalStatus, reduceJobPoll, type PollObservation, type PollReduction } from './lib/jobReducer'
import { STORAGE_ERROR_EVENT } from './lib/libraryStorage'
import {
  Aperture,
  Clapperboard,
  Film,
  HardDrive,
  Image as ImageIcon,
  Library,
  ListVideo,
  LoaderCircle,
  MapPin,
  Menu,
  Music2,
  PanelLeftClose,
  RotateCcw,
  Scissors,
  Settings,
  Shirt,
  Users,
  Watch,
  WandSparkles,
} from 'lucide-react'
import { buildMiniMaxWorkflow, extractOutputFile, extractOutputUrl, outputFileFromUrl } from './lib/workflow'
import { buildLtx25Workflow } from './lib/ltx25Workflow'
import { ACE_STEP_REQUIRED_NODES, buildAceStepWorkflow, inferAceStepSelections } from './lib/aceStepWorkflow'
import { fitWholeCharacter, prepareImage } from './lib/imageCrop'
import { inferLtx25Selections, inferSelections } from './lib/modelSelection'
import { choices, type ObjectInfo } from './lib/comfyInfo'
import { useLivePreview, type LiveProgress } from './lib/useLivePreview'
import { ZImageWorkspace } from './components/ZImageWorkspace'
import { ClipEditor } from './components/ClipEditor'
import { MoviePlanner } from './components/MoviePlanner'
import { Ltx25Workspace } from './components/Ltx25Workspace'
import { AceStepWorkspace } from './components/AceStepWorkspace'
import { VideoReferenceClipper } from './components/VideoReferenceClipper'
import { CharacterStudio } from './components/CharacterStudio'
import { HairStudio } from './components/HairStudio'
import { WardrobeStudio } from './components/WardrobeStudio'
import { LocationStudio } from './components/LocationStudio'
import { AccessoryStudio } from './components/AccessoryStudio'
import { AiChatHead } from './components/AiChatHead'
import type { CharacterDialogueDraft } from './components/CharacterDialogueModal'
import { GpuMeter, NavButton, Notice } from './components/chrome'
import { CreateView } from './views/CreateView'
import { LibraryView } from './views/LibraryView'
import { JobsView } from './views/JobsView'
import { SettingsView } from './views/SettingsView'
import { CHARACTER_LIBRARY_EVENT, characterReferences, loadCharacterProjects } from './lib/characterLibrary'
import { loadWardrobeProjects, wardrobeReferences, WARDROBE_LIBRARY_EVENT } from './lib/wardrobeLibrary'
import { loadLocationProjects, locationReferences, LOCATION_LIBRARY_EVENT } from './lib/locationLibrary'
import { allocateWorkspaceReferences, buildPromptAssistantRequest, composeReferenceInstructions } from './lib/promptComposer'
import { buildCharacterDialogueRequest } from './lib/dialogPolicy'
import { readWorkspace, withoutPreview, workspaceDefaults, type MovieLink, type PersistedWorkspace } from './lib/workspace'
import { diagnosticPrompt, findH3PreviewOverrideNode, h3StackReport } from './lib/h3Stack'
import { composeH3Prompt, resolveRenderReferenceImages, syncReferencePrompt } from './lib/promptPolicies'
import { extractAutomatedReferenceSet, initialJobs, playableOutputUrl, recordCharacterTurntable, recordLocationWalkthrough, recordMovieOutput } from './lib/jobRecords'
import type {
  AppSettings,
  AceStepGenerationOptions,
  CharacterProject,
  ComfyStatus,
  GenerationJob,
  GenerationMode,
  GpuTelemetry,
  Ltx25GenerationOptions,
  LocationProject,
  MediaFile,
  MediaKind,
  ModelFile,
  MovieProject,
  MovieReferenceBinding,
  ResolvedMovieShot,
  WardrobeProject,
  MovieShot,
  OllamaModel,
  UpscaleMode,
  View,
} from './types'

const LTX_UPSCALE_REQUIRED_NODES = [
  'VAEEncodeTiled', 'LatentUpscaleModelLoader', 'LTXVLatentUpsampler',
  'VAEDecodeTiled', 'ImageFromBatch', 'RepeatImageBatch', 'ImageBatch',
] as const

const LTX_NATIVE_REQUIRED_NODES = [
  'LTXVConditioning', 'LTXVEmptyLatentAudio', 'EmptyLTXVLatentVideo',
  'LTXVDualCFGGuider', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent',
  'LTXVLatentUpsampler', 'LTXVAudioVAEDecode', 'ManualSigmas',
  'VAEDecodeTiled', 'CLIPTextEncode', 'KSamplerSelect', 'SamplerCustomAdvanced',
] as const

function App() {
  const persisted = useMemo(readWorkspace, [])
  const [view, setView] = useState<View>('create')
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 680)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [models, setModels] = useState<ModelFile[]>([])
  const [scanning, setScanning] = useState(false)
  const [status, setStatus] = useState<ComfyStatus>({ connected: false, latencyMs: 0 })
  const [checking, setChecking] = useState(false)
  const [gpu, setGpu] = useState<GpuTelemetry | null>(null)
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
  const [info, setInfo] = useState<ObjectInfo>({})
  const h3PreviewOverrideNode = findH3PreviewOverrideNode(info)
  const [liveEnabled, setLiveEnabled] = useState(persisted.liveEnabled)
  const [livePreviewMode, setLivePreviewMode] = useState<'standard' | 'h3-override'>(persisted.livePreviewMode)
  const [upscaleMode, setUpscaleMode] = useState<UpscaleMode>(persisted.upscaleMode)
  const upscaleModel = choices(info, 'LatentUpscaleModelLoader', 'model_name').find((n) => /ltx-2\.5.*spatial.*x2/i.test(n)) ?? ''
  const upscaleVae = choices(info, 'VAELoader', 'vae_name').find((n) => /ltx-2\.5.*video.*vae/i.test(n)) ?? ''
  const missingLtxUpscaleNodes = LTX_UPSCALE_REQUIRED_NODES.filter((node) => !info[node])
  const ltxUpscaleReady = Boolean(upscaleModel && upscaleVae && missingLtxUpscaleNodes.length === 0)
  const rtxModels = choices(info, 'UpscaleModelLoader', 'model_name')
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
  const [jobs, setJobs] = useState<GenerationJob[]>(initialJobs)
  const [activeJobId, setActiveJobId] = useState<string | null>(persisted.activeJobId)
  const [movieHandoff, setMovieHandoff] = useState<MovieLink | null>(persisted.movieHandoff)
  const [characterHandoff, setCharacterHandoff] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [ltxSubmitting, setLtxSubmitting] = useState(false)
  const [aceSubmitting, setAceSubmitting] = useState(false)
  const [diagnosticRunning, setDiagnosticRunning] = useState(false)
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set())
  const cancellationRequests = useRef(new Set<string>())
  const mediaHydrated = useRef(false)
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'neutral'; text: string } | null>(null)
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [promptSuggestion, setPromptSuggestion] = useState('')
  const [promptingTool, setPromptingTool] = useState<'enhance' | 'timeline' | 'audio' | null>(null)
  const [dialogueGenerating, setDialogueGenerating] = useState(false)
  const [videoClipDraft, setVideoClipDraft] = useState<{ source: MediaFile; replaceIndex?: number } | null>(null)
  const [createResetKey, setCreateResetKey] = useState(0)
  const [ltxResetKey, setLtxResetKey] = useState(0)
  const [zImageResetKey, setZImageResetKey] = useState(0)
  const [ltxResetAt, setLtxResetAt] = useState(0)
  const onLiveProgress = useCallback((id: string, update: LiveProgress) => {
    if (!id) return
    setJobs((current) => current.map((j) => j.promptId === id && ['running', 'queued'].includes(j.status) ? { ...j, ...update, progress: update.progress ?? j.progress, status: 'running' } : j))
  }, [])
  // Keep the lightweight ComfyUI event socket active even when image previews
  // are hidden so queue, node, and sampler-step progress remain real-time.
  const live = useLivePreview(settings?.comfyUrl, true, onLiveProgress)

  const selection = useMemo(() => inferSelections(models, turbo), [models, turbo])
  const h3Report = useMemo(() => h3StackReport(models), [models])
  const ltxSelection = useMemo(() => inferLtx25Selections(models, choices(info, 'LatentUpscaleModelLoader', 'model_name')), [models, info])
  const aceSelection = useMemo(() => inferAceStepSelections(models), [models])
  const activeModel = mode === 'reference' ? selection.ref2va : selection.fl2va
  const activeLora = mode === 'reference' ? selection.ref2vLora : selection.fl2vLora
  const requiredModels = [activeModel, selection.textEncoder, selection.videoVae, selection.audioVae]
  const modelReady = requiredModels.every(Boolean) && (turbo === 'off' || Boolean(activeLora))
  const pendingJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running')
  const pendingKey = pendingJobs.map((job) => job.id).join(',')
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs

  const scanModels = useCallback(async (nextSettings: AppSettings) => {
    setScanning(true)
    try {
      const found = await window.minimax.scanModels(nextSettings)
      setModels(found)
    } finally {
      setScanning(false)
    }
  }, [])

  const checkConnection = useCallback(async (url: string) => {
    setChecking(true)
    const nextStatus = await window.minimax.getComfyStatus(url)
    setStatus(nextStatus)
    if (nextStatus.connected) {
      try { setInfo(await window.minimax.getObjectInfo(url)) } catch { setInfo({}) }
    } else setInfo({})
    setChecking(false)
    return nextStatus
  }, [])

  const refreshOllama = useCallback(async (nextSettings: AppSettings) => {
    try {
      const found = await window.minimax.listOllamaModels(nextSettings.ollamaUrl)
      setOllamaModels(found.filter((model) => model.local && model.family !== 'nomic-bert'))
    } catch {
      setOllamaModels([])
    }
  }, [])

  useEffect(() => {
    void window.minimax.getSettings().then((loaded) => {
      setSettings(loaded)
      void Promise.all([scanModels(loaded), checkConnection(loaded.comfyUrl), refreshOllama(loaded)])
    })
  }, [checkConnection, refreshOllama, scanModels])

  useEffect(() => {
    let disposed = false
    const refresh = () => {
      if (document.hidden) return
      void window.minimax.getGpuTelemetry().then((value) => { if (!disposed) setGpu(value) }).catch(() => { if (!disposed) setGpu({ available: false }) })
    }
    refresh()
    const timer = window.setInterval(refresh, 4000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    localStorage.setItem('minimax.jobs', JSON.stringify(jobs.slice(0, 100)))
  }, [jobs])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.tone === 'error' ? 6500 : 4500)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const refresh = () => setCharacterProjects(loadCharacterProjects())
    window.addEventListener(CHARACTER_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(CHARACTER_LIBRARY_EVENT, refresh)
  }, [])
  useEffect(() => {
    const onStorageError = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; message: string }>).detail
      setNotice({ tone: 'error', text: `A library could not be saved (${detail.key}): ${detail.message}` })
    }
    window.addEventListener(STORAGE_ERROR_EVENT, onStorageError)
    return () => window.removeEventListener(STORAGE_ERROR_EVENT, onStorageError)
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

  useEffect(() => {
    if (!settings || !pendingKey || !status.connected) return
    // Applies a reduction only while the job is still non-terminal, so a stale
    // in-flight poll response can neither resurrect nor duplicate work.
    const applyReduction = (jobId: string, reduction: PollReduction) => {
      setJobs((current) => {
        let changed = false
        const next = current.map((item) => {
          if (item.id !== jobId || isTerminalStatus(item.status) || reduction.job === item) return item
          changed = true
          return reduction.job
        })
        return changed ? next : current
      })
    }
    const timer = window.setInterval(() => {
      for (const job of jobsRef.current.filter((j) => j.status === 'queued' || j.status === 'running')) {
        const promptId = job.promptId
        if (!promptId) continue
        void window.minimax.getHistory(settings.comfyUrl, promptId).then(async (history) => {
          const entry = history[promptId] as { status?: { status_str?: string; completed?: boolean; messages?: unknown[] } } | undefined
          const mediaType = job.mediaType ?? 'video'
          const outputUrl = playableOutputUrl(extractOutputUrl(history, promptId, settings.comfyUrl, mediaType))
          let observation: PollObservation
          if (entry?.status?.status_str === 'error') {
            observation = { kind: 'executionError' }
          } else if (entry?.status?.completed) {
            // Attribute the output by the exact filename ComfyUI reported —
            // never by the newest file on disk, which can belong to a
            // concurrent render and would poison library reference sets. A
            // descriptor that resolves remotely but not locally still
            // completes the job (streamed via the media proxy).
            const file = extractOutputFile(history, promptId, mediaType)
            if (file) {
              const localOutput = await window.minimax.resolveOutput(settings.outputDirectory, file)
              observation = { kind: 'completed', outputUrl: outputUrl ?? localOutput ?? '', localOutputPath: localOutput ?? undefined }
            } else {
              observation = { kind: 'completedNoLocalOutput' }
            }
          } else {
            observation = { kind: 'incomplete' }
          }
          const reduction = reduceJobPoll(job, observation, Date.now())
          if (reduction.transitionedTo === 'completed') {
            // Re-check live state: an earlier in-flight response may have
            // already completed this job and fired these side effects.
            const current = jobsRef.current.find((item) => item.id === job.id)
            if (current && !isTerminalStatus(current.status)) {
              const remote = reduction.job.outputUrl ?? ''
              recordMovieOutput(job.movieLink, remote)
              let extractionError: string | null = null
              const local = reduction.job.localOutputPath
              if (job.characterProjectId) {
                recordCharacterTurntable(job.characterProjectId, local ?? remote)
                if (local) extractionError = await extractAutomatedReferenceSet('character', job.characterProjectId, local, job.duration, settings)
              } else if (job.locationProjectId) {
                recordLocationWalkthrough(job.locationProjectId, local ?? remote)
                if (local) extractionError = await extractAutomatedReferenceSet('location', job.locationProjectId, local, job.duration, settings)
              }
              if (extractionError) setNotice({ tone: 'error', text: `The video rendered, but its reference frames could not be extracted: ${extractionError}` })
            }
          }
          applyReduction(job.id, reduction)
        }).catch(() => undefined)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [pendingKey, settings, status.connected])

  // Deadline sweep, independent of ComfyUI connectivity: a job whose polls
  // stopped resolving (server died mid-render) must still reach a terminal
  // state instead of showing "running" forever.
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const job of jobsRef.current) {
        if (!isPastRunningDeadline(job, Date.now())) continue
        const reduction = reduceJobPoll(job, { kind: 'pollFailed' }, Date.now())
        if (reduction.transitionedTo) setJobs((current) => current.map((item) => item.id === job.id && !isTerminalStatus(item.status) ? reduction.job : item))
      }
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const chooseMedia = async (kind: MediaKind, setter: (file: MediaFile) => void) => {
    const picked = await window.minimax.chooseMedia(kind)
    if (!picked) return
    let preview: string | undefined
    if (kind === 'image') preview = await window.minimax.fileDataUrl(picked.path)
    setter({ ...picked, kind, preview })
  }

  const continueFromRenderedVideo = async (job: GenerationJob, position: number | 'last') => {
    if (!settings || !job.outputUrl) return
    try {
      const descriptor = outputFileFromUrl(job.outputUrl)
      const source = job.localOutputPath ?? (descriptor ? await window.minimax.resolveOutput(settings.outputDirectory, descriptor) : null)
      if (!source) throw new Error('The completed video file could not be found in the output folder.')
      const extracted = await window.minimax.extractVideoFrame(source, position, settings.outputDirectory, settings.ffmpegPath)
      const frame: MediaFile = { ...extracted, kind: 'image', preview: await window.minimax.mediaUrl(extracted.path) }
      setFirstFrame(frame)
      setLastFrame(null)
      setMode('image')
      setNotice({ tone: 'success', text: `${position === 'last' ? 'The final frame' : `The frame at ${position.toFixed(1)}s`} is loaded as the exact starting point for the next video. The first clip remains unchanged.` })
    } catch (error) {
      setNotice({ tone: 'error', text: `Could not prepare the continuation frame: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  const chooseMany = async (kind: MediaKind) => {
    if (kind === 'video') {
      const picked = await window.minimax.chooseMedia('video')
      if (!picked) return
      const preview = await window.minimax.mediaUrl(picked.path)
      setVideoClipDraft({ source: { ...picked, kind: 'video', preview } })
      return
    }
    await chooseMedia(kind, (file) => {
      if (kind === 'image') { setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setReferenceImages((current) => current.length < 9 ? [...current, file] : current) }
      if (kind === 'audio') setReferenceAudios((current) => current.length < 3 ? [...current, file] : current)
    })
  }

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

  const loadReferenceCharacter = async (characterId: string) => {
    const previousBindings = workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    const selectedIds = characterId ? (selectedReferenceCharacterIds.includes(characterId) ? selectedReferenceCharacterIds.filter((id) => id !== characterId) : [...selectedReferenceCharacterIds, characterId]) : []
    setSelectedReferenceCharacterIds(selectedIds)
    setMode('reference')
    const selectedCharacters = selectedIds.map((id) => characterProjects.find((project) => project.id === id)).filter(Boolean) as CharacterProject[]
    if (selectedCharacters.some((character) => characterReferences(character).length === 0)) {
      setNotice({ tone: 'error', text: 'Every selected character needs at least one approved identity image.' })
      return
    }
    const bindings = workspaceBindingsFor(selectedIds, selectedReferenceLocationIds)
    await applyWorkspaceBindings(previousBindings, bindings)
    const identityCount = bindings.filter((item) => item.purpose === 'character' || item.purpose === 'character-angle').length
    const hairCount = bindings.filter((item) => item.purpose === 'hair').length
    const wardrobeCount = bindings.filter((item) => item.purpose === 'wardrobe').length
    const locationCount = bindings.filter((item) => item.purpose === 'location').length
    setNotice({ tone: 'success', text: selectedCharacters.length ? `Using ${identityCount} identity, ${hairCount} hair, ${wardrobeCount} wardrobe, and ${locationCount} location picture${locationCount === 1 ? '' : 's'} across ${bindings.length} of 9 slots.` : locationCount ? `Cast cleared. Keeping ${locationCount} location picture${locationCount === 1 ? '' : 's'}.` : 'Cleared character references.' })
  }

  const loadReferenceLocation = async (locationId: string) => {
    const previousBindings = workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    if (!locationId) {
      setSelectedReferenceLocationIds([]); setMode('reference')
      const bindings = workspaceBindingsFor(selectedReferenceCharacterIds, [])
      await applyWorkspaceBindings(previousBindings, bindings)
      setNotice({ tone: 'success', text: bindings.length ? `Locations cleared. Keeping ${bindings.length} character and wardrobe picture${bindings.length === 1 ? '' : 's'}.` : 'Cleared location references.' })
      return
    }
    const location = locationProjects.find((project) => project.id === locationId)
    if (!location) return
    const sources = locationReferences(location)
    if (!sources.length) { setNotice({ tone: 'error', text: `${location.name} needs an approved reference image first.` }); return }
    const selectedIds = selectedReferenceLocationIds.includes(locationId) ? selectedReferenceLocationIds.filter((id) => id !== locationId) : [...selectedReferenceLocationIds, locationId]
    setSelectedReferenceLocationIds(selectedIds); setMode('reference')
    const bindings = workspaceBindingsFor(selectedReferenceCharacterIds, selectedIds)
    await applyWorkspaceBindings(previousBindings, bindings)
    const locationCount = bindings.filter((item) => item.purpose === 'location').length
    setNotice({ tone: 'success', text: selectedIds.includes(locationId) ? `Added ${location.name}. Characters, wardrobe, and locations now use ${bindings.length} of 9 picture slots.` : `${location.name} removed. ${locationCount} location picture${locationCount === 1 ? '' : 's'} remain.` })
  }

  const loadReferenceWardrobe = async (wardrobeId: string) => {
    const wardrobe = wardrobeProjects.find((project) => project.id === wardrobeId)
    if (!wardrobe) return
    const approved = wardrobeReferences(wardrobe).slice(0, 9).map(fitWholeCharacter)
    if (!approved.length) { setNotice({ tone: 'error', text: `${wardrobe.name} has no approved wardrobe images yet.` }); return }
    const images = await Promise.all(approved.map(async (file) => { if (file.preview) return file; try { return { ...file, preview: await window.minimax.fileDataUrl(file.path) } } catch { return file } }))
    setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setMode('reference'); setReferenceImages(images)
    setNotice({ tone: 'success', text: `Loaded ${images.length} approved wardrobe reference${images.length === 1 ? '' : 's'} for ${wardrobe.name}.` })
  }

  const editVideoReference = async (index: number) => {
    const file = referenceVideos[index]
    if (!file) return
    const sourcePath = file.clip?.sourcePath ?? file.path
    const preview = await window.minimax.mediaUrl(sourcePath)
    setVideoClipDraft({ source: { ...file, path: sourcePath, name: file.clip?.sourceName ?? file.name, preview }, replaceIndex: index })
  }

  const createVideoReferenceClip = async (start: number, end: number) => {
    if (!settings || !videoClipDraft) return
    const source = videoClipDraft.source
    const result = await window.minimax.trimVideo(source.path, start, end, settings.outputDirectory, settings.ffmpegPath)
    const clipped: MediaFile = { ...result, kind: 'video', clip: { sourcePath: source.path, sourceName: source.name, start, end } }
    setReferenceVideos((current) => videoClipDraft.replaceIndex === undefined
      ? current.length < 3 ? [...current, clipped] : current
      : current.map((file, index) => index === videoClipDraft.replaceIndex ? clipped : file))
    setVideoClipDraft(null)
    setNotice({ tone: 'success', text: `${(end - start).toFixed(1)}s reference clip created. The original video was not changed.` })
  }

  const saveAppSettings = async () => {
    if (!settings) return
    await window.minimax.saveSettings(settings)
    await scanModels(settings)
    await checkConnection(settings.comfyUrl)
    await refreshOllama(settings)
    setNotice({ tone: 'success', text: 'Settings saved and model folders rescanned.' })
  }

  const applyGenerationDefaults = () => {
    if (!settings) return
    const defaults = settings.generationDefaults
    setResolution(defaults.resolution)
    setDuration(defaults.duration)
    setTurbo(mode === 'reference' && defaults.turbo === '8' ? 'off' : defaults.turbo)
    setSteps(defaults.steps)
    setSampler(defaults.sampler)
    setScheduler(defaults.scheduler)
    setExperimentalSampling(defaults.experimentalSampling)
    setRefImageSize(defaults.refImageSize)
    setLiveEnabled(defaults.livePreview)
    setSigmaShiftMode(defaults.sigmaShiftMode)
    setShiftVideo(defaults.shiftVideo)
    setShiftAudio(defaults.shiftAudio)
    setLoraStrength(defaults.loraStrength)
    setUpscaleMode(defaults.upscaleMode)
    setNotice({ tone: 'success', text: 'Saved generation defaults applied to the current Create workspace.' })
  }

  const runPromptTool = async (tool: 'enhance' | 'timeline' | 'audio') => {
    if (!settings || !prompt.trim()) {
      setNotice({ tone: 'error', text: 'Write a rough prompt first, then ask the local assistant to refine it.' })
      return
    }
    if (!settings.ollamaModel || ollamaModels.length === 0) {
      setNotice({ tone: 'error', text: 'No local Ollama text model is available. Check Ollama in Settings.' })
      return
    }
    const workspaceBindings = workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    const referenceMap = mode === 'reference' ? [
      ...referenceImages.map((file, index) => `<Picture ${index + 1}> = ${workspaceBindings[index]?.label ?? file.name}`),
      ...referenceVideos.map((file, index) => `<Video ${index + 1}> = ${file.name}`),
      ...referenceAudios.map((file, index) => `<Audio ${index + 1}> = ${file.name}`),
    ] : undefined
    const request = buildPromptAssistantRequest(tool, prompt, { duration, mode, referenceMap, noDialogue })
    setPromptingTool(tool)
    setPromptSuggestion('')
    try {
      const response = await window.minimax.generateWithOllama(settings.ollamaUrl, settings.ollamaModel, request)
      setPromptSuggestion(response)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setPromptingTool(null)
    }
  }

  const resetCreateWorkspace = () => {
    const defaults = settings?.generationDefaults
    setMode('text')
    setPrompt('')
    setPromptSuggestion('')
    setPromptingTool(null)
    setDialogueGenerating(false)
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
    setVideoClipDraft(null)
    setActiveJobId(null)
    setMovieHandoff(null)
    setCharacterHandoff(null)
    setSelectedReferenceCharacterIds([])
    setSelectedReferenceLocationIds([])
    setCreateResetKey((value) => value + 1)
    setNotice({ tone: 'success', text: 'MiniMax Create reset. Saved libraries, rendered files, and queue history were not deleted.' })
  }

  const generateCharacterDialogue = async (draft: CharacterDialogueDraft) => {
    if (!settings || !settings.ollamaModel || ollamaModels.length === 0) throw new Error('No local Ollama text model is available. Check Ollama in Settings.')
    setDialogueGenerating(true)
    try {
      return await window.minimax.generateWithOllama(settings.ollamaUrl, settings.ollamaModel, buildCharacterDialogueRequest({
        characterName: draft.character.name,
        characterDescription: draft.character.description,
        voiceNotes: draft.character.voiceNotes,
        shotPrompt: prompt,
        intent: draft.intent,
        requiredWords: draft.requiredWords,
        delivery: draft.delivery,
        length: draft.length,
        language: draft.language,
        duration,
      }))
    } finally {
      setDialogueGenerating(false)
    }
  }

  const resetCurrentWorkspace = () => {
    if (view === 'create') {
      resetCreateWorkspace()
      return
    }
    if (view === 'ltx25') {
      localStorage.removeItem('ltx25.workspace')
      setLtxResetAt(Date.now())
      setLtxResetKey((value) => value + 1)
      setNotice({ tone: 'success', text: 'LTX 2.5 reset. Its prompt, first frame, options, and current preview were cleared.' })
      return
    }
    if (view === 'zimage') {
      localStorage.removeItem('minimax.zimage-workspace')
      setZImageResetKey((value) => value + 1)
      setNotice({ tone: 'success', text: 'Create Image reset. Its prompt, options, selection, and current preview were cleared.' })
    }
  }

  const cancelJob = async (job: GenerationJob) => {
    if (!settings) return
    if (!['queued', 'running'].includes(job.status) || cancellingIds.has(job.id)) return
    cancellationRequests.current.add(job.id)
    setCancellingIds((current) => new Set(current).add(job.id))
    if (!job.promptId) {
      setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'cancelled', error: undefined } : item))
      setNotice({ tone: 'neutral', text: 'Cancelling input preparation…' })
      return
    }
    try {
      const result = await window.minimax.cancelPrompt(settings.comfyUrl, job.promptId)
      if (result.cancelled) {
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'cancelled', error: undefined } : item))
        setNotice({ tone: 'success', text: result.state === 'pending' ? 'Queued generation removed.' : 'Running generation stopped.' })
      } else {
        setNotice({ tone: 'neutral', text: result.state === 'finished' ? 'That generation already finished.' : 'That generation is no longer in the ComfyUI queue.' })
      }
    } catch (error) {
      cancellationRequests.current.delete(job.id)
      setNotice({ tone: 'error', text: `Could not stop generation: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setCancellingIds((current) => { const next = new Set(current); next.delete(job.id); return next })
    }
  }

  const chooseLtxImage = async (): Promise<MediaFile | null> => {
    const picked = await window.minimax.chooseMedia('image')
    if (!picked) return null
    return { ...picked, kind: 'image', preview: await window.minimax.fileDataUrl(picked.path) }
  }

  const useStartFrameInLtx = (file: MediaFile) => {
    let workspace: Record<string, unknown> = {}
    try { workspace = JSON.parse(localStorage.getItem('ltx25.workspace') ?? '{}') as Record<string, unknown> } catch { /* Replace malformed legacy workspace data. */ }
    const storedFrame = { ...file }
    delete storedFrame.preview
    localStorage.setItem('ltx25.workspace', JSON.stringify({ ...workspace, mode: 'image', firstFrame: storedFrame }))
    setLtxResetAt(Date.now())
    setLtxResetKey((value) => value + 1)
    setView('ltx25')
    setNotice({ tone: 'success', text: `${file.name} loaded as the LTX 2.5 image-to-video starting frame.` })
  }

  const generateLtx = async (options: Ltx25GenerationOptions, input: MediaFile | null, handoff?: { characterProjectId?: string; locationProjectId?: string }) => {
    if (!settings) return 'Studio settings are still loading.'
    if (!status.connected) {
      const message = 'Start ComfyUI and verify the server connection in Settings.'
      setNotice({ tone: 'error', text: message })
      return message
    }
    if (!options.prompt) {
      const message = 'Add an LTX prompt before generating.'
      setNotice({ tone: 'error', text: message })
      return message
    }
    if (options.mode === 'image' && !input) {
      const message = 'Choose a first frame for LTX image-to-video.'
      setNotice({ tone: 'error', text: message })
      return message
    }
    if (!ltxSelection.diffusion || !ltxSelection.textEncoder || !ltxSelection.videoVae || !ltxSelection.audioVae || !ltxSelection.latentUpscaler) {
      const message = 'The LTX‑2.5 distilled transformer, Gemma encoder, video/audio VAEs, or latent spatial upscaler is missing.'
      setNotice({ tone: 'error', text: message })
      return message
    }
    const missingNodes = LTX_NATIVE_REQUIRED_NODES.filter((node) => !info[node])
    if (missingNodes.length) {
      const message = `Update ComfyUI before using LTX‑2.5. Missing core nodes: ${missingNodes.join(', ')}.`
      setNotice({ tone: 'error', text: message })
      return message
    }

    const localId = createId()
    const job: GenerationJob = { id: localId, provider: 'ltx25', mode: options.mode, prompt: options.prompt, createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: input ? 'Preparing first frame' : 'Preparing workflow', width: options.width, height: options.height, duration: options.duration, characterProjectId: handoff?.characterProjectId ?? characterHandoff ?? undefined, locationProjectId: handoff?.locationProjectId }
    setJobs((current) => [job, ...current])
    setActiveJobId(localId)
    setLtxSubmitting(true)
    setNotice({ tone: 'neutral', text: 'Preparing the official LTX‑2.5 ComfyUI graph…' })
    try {
      const uploaded = input ? await window.minimax.uploadImageData(settings.comfyUrl, await prepareImage(input, options.width, options.height)) : undefined
      if (cancellationRequests.current.has(localId)) throw new Error('Generation cancelled before submission.')
      const graph = buildLtx25Workflow(options, ltxSelection, uploaded)
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, live.clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
        return 'The LTX 2.5 survey was cancelled before it started.'
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        setNotice({ tone: 'success', text: `${options.preset === 'quality' ? 'Two-stage quality' : 'Single-stage Turbo'} LTX‑2.5 generation added to ComfyUI.` })
        if (!handoff) setCharacterHandoff(null)
        return null
      }
    } catch (error) {
      const cancelled = cancellationRequests.current.has(localId)
      const message = cancelled ? 'LTX generation cancelled.' : error instanceof Error ? error.message : String(error)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : error instanceof Error ? error.message : String(error) } : item))
      setNotice(cancelled ? { tone: 'success', text: message } : { tone: 'error', text: message })
      return message
    } finally {
      cancellationRequests.current.delete(localId)
      setLtxSubmitting(false)
    }
  }

  const generateAceStep = async (options: AceStepGenerationOptions) => {
    if (!settings) return
    if (!status.connected) {
      setNotice({ tone: 'error', text: 'Start ComfyUI and verify the server connection in Settings.' })
      return
    }
    const selectedModel = options.model === 'sft' ? aceSelection.sft : aceSelection.base
    if (!selectedModel || !aceSelection.vae || !aceSelection.textEncoderSmall || !aceSelection.textEncoderLarge) {
      setNotice({ tone: 'error', text: `The ACE-Step ${options.model.toUpperCase()} model, audio VAE, and both Qwen ACE text encoders are required.` })
      return
    }
    const missingNodes = ACE_STEP_REQUIRED_NODES.filter((node) => !info[node])
    if (missingNodes.length) {
      setNotice({ tone: 'error', text: `Update ComfyUI before using ACE-Step 1.5. Missing core nodes: ${missingNodes.join(', ')}.` })
      return
    }
    const localId = createId()
    const job: GenerationJob = {
      id: localId, provider: 'acestep', mediaType: 'audio', mode: 'text', prompt: options.tags,
      createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: 'Preparing ACE-Step workflow',
      width: 0, height: 0, duration: options.duration,
    }
    setJobs((current) => [job, ...current])
    setAceSubmitting(true)
    setNotice({ tone: 'neutral', text: `Preparing the official ACE-Step XL ${options.model.toUpperCase()} ComfyUI graph…` })
    try {
      const graph = buildAceStepWorkflow(options, aceSelection)
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, live.clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        setNotice({ tone: 'success', text: `ACE-Step XL ${options.model.toUpperCase()} music generation added to ComfyUI.` })
      }
    } catch (error) {
      const cancelled = cancellationRequests.current.has(localId)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : error instanceof Error ? error.message : String(error) } : item))
      setNotice(cancelled ? { tone: 'success', text: 'Music generation cancelled.' } : { tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      cancellationRequests.current.delete(localId)
      setAceSubmitting(false)
    }
  }

  const generate = async () => {
    if (!settings) return
    if (upscaleMode === 'ltx' && (!upscaleModel || !upscaleVae)) {
      setNotice({ tone: 'error', text: 'LTX 2.5 spatial upscaler and video VAE must be available in ComfyUI.' })
      return
    }
    if (upscaleMode === 'ltx' && missingLtxUpscaleNodes.length) {
      setNotice({ tone: 'error', text: `Update ComfyUI before using LTX 2× upscale. Missing nodes: ${missingLtxUpscaleNodes.join(', ')}.` })
      return
    }
    if (upscaleMode === 'rtx' && !rtxModel) {
      setNotice({ tone: 'error', text: 'Choose an AI upscale model installed in ComfyUI first.' })
      return
    }
    if (upscaleMode === 'rtx' && !window.confirm('RTX/CUDA upscale processes every frame independently and can amplify MiniMax noise or temporal shimmer. Continue with this experimental post-process?')) return
    if (!prompt.trim()) {
      setNotice({ tone: 'error', text: 'Add a prompt before generating.' })
      return
    }
    if (!status.connected) {
      setNotice({ tone: 'error', text: 'Start ComfyUI and verify the server connection in Settings.' })
      return
    }
    if (!modelReady) {
      setNotice({ tone: 'error', text: 'One or more required MiniMax H3 model components are missing.' })
      return
    }
    if (liveEnabled && livePreviewMode === 'h3-override' && !h3PreviewOverrideNode) {
      setNotice({ tone: 'error', text: 'MiniMax H3 animated preview is selected, but its Preview Override node was not detected. Install or enable the custom node, restart ComfyUI, then click the Local engine status to refresh.' })
      return
    }
    if (liveEnabled && livePreviewMode === 'h3-override' && !selection.previewVae) {
      setNotice({ tone: 'error', text: 'MiniMax H3 animated preview requires taeh3_decoder.safetensors in ComfyUI/models/vae_approx. Refresh the Local engine after adding it.' })
      return
    }
    if ((mode === 'image' || mode === 'frames') && !firstFrame) {
      setNotice({ tone: 'error', text: 'Choose a first frame for this mode.' })
      return
    }
    if (mode === 'frames' && !lastFrame) {
      setNotice({ tone: 'error', text: 'Choose a last frame for first-and-last-frame generation.' })
      return
    }
    if (mode === 'reference' && referenceImages.length + referenceVideos.length + referenceAudios.length === 0) {
      setNotice({ tone: 'error', text: 'Add at least one reference image, video, or audio file.' })
      return
    }
    if (mode === 'reference' && (referenceImages.length > 9 || referenceVideos.length > 3 || referenceAudios.length > 3)) {
      setNotice({ tone: 'error', text: 'Reference limits are 9 pictures, 3 videos, and 3 audio files. Remove extras before rendering.' })
      return
    }

    setSubmitting(true)
    setNotice({ tone: 'neutral', text: 'Uploading inputs and preparing the ComfyUI graph…' })
    const workspaceBindings = workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    const renderReferenceImages = resolveRenderReferenceImages(referenceImages, workspaceBindings, clothingPolicy)
    const effectivePrompt = composeH3Prompt({ prompt, mode, bindings: workspaceBindings, clothingPolicy, noDialogue, naturalMovement })
    const [width, height] = resolution.split('x').map(Number)
    const localId = createId()
    const job: GenerationJob = {
      id: localId,
      mode,
      prompt: effectivePrompt,
      createdAt: Date.now(),
      status: 'queued',
      progress: 2,
      progressLabel: 'Preparing and uploading inputs',
      width: width * (upscaleMode === 'off' ? 1 : 2),
      height: height * (upscaleMode === 'off' ? 1 : 2),
      duration,
      movieLink: movieHandoff ?? undefined,
      characterProjectId: characterHandoff ?? undefined,
    }
    setJobs((current) => [job, ...current])
    setActiveJobId(localId)
    try {
      const upload = async (file: MediaFile, fitToOutput = false) => file.kind === 'image' && (fitToOutput || Boolean(file.crop))
        ? window.minimax.uploadImageData(settings.comfyUrl, await prepareImage(file, width, height))
        : window.minimax.uploadInput(settings.comfyUrl, file.path)
      const [first, last, images, videos, audios] = await Promise.all([
        firstFrame && (mode === 'image' || mode === 'frames') ? upload(firstFrame, true) : undefined,
        lastFrame && mode === 'frames' ? upload(lastFrame, true) : undefined,
        Promise.all(mode === 'reference' ? renderReferenceImages.map((file) => upload(file)) : []),
        Promise.all(mode === 'reference' ? referenceVideos.map((file) => upload(file)) : []),
        Promise.all(mode === 'reference' ? referenceAudios.map((file) => upload(file)) : []),
      ])
      if (cancellationRequests.current.has(localId)) throw new Error('Generation cancelled before submission.')
      const graph = buildMiniMaxWorkflow({
        mode,
        prompt: effectivePrompt,
        width,
        height,
        duration,
        seed,
        steps,
        turbo,
        experimentalSampling,
        loraStrength,
        sampler: experimentalSampling ? sampler : 'res_multistep',
        scheduler: experimentalSampling ? scheduler : 'simple',
        upscale: upscaleMode === 'ltx' ? { type: 'ltx', model: upscaleModel, vae: upscaleVae } : upscaleMode === 'rtx' ? { type: 'rtx', model: rtxModel } : undefined,
        refImageSize,
        sigmaShift: sigmaShiftMode === 'custom' ? { video: shiftVideo, audio: shiftAudio } : undefined,
        previewOverride: liveEnabled && livePreviewMode === 'h3-override' && h3PreviewOverrideNode ? { frames: 50, fps: 12, nodeType: h3PreviewOverrideNode, vaeName: selection.previewVae, jpegQuality: 85 } : undefined,
        filenamePrefix: `video/MiniMax_H3_${Date.now()}`,
        firstFrame: firstFrame?.path,
        lastFrame: lastFrame?.path,
        referenceImages: renderReferenceImages.map((item) => item.path),
        referenceVideos: referenceVideos.map((item) => item.path),
        referenceAudios: referenceAudios.map((item) => item.path),
      }, selection, { first, last, images, videos, audios })
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, live.clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled', error: undefined } : item))
        setNotice({ tone: 'success', text: 'Generation cancelled.' })
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        setNotice({ tone: 'success', text: 'Generation added to the local ComfyUI queue.' })
        setCharacterHandoff(null)
      }
      setSeed(Math.floor(Math.random() * 1_000_000_000))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = cancellationRequests.current.has(localId)
      setJobs((current) => current.map((item) => item.id === localId ? cancelled ? { ...item, status: 'cancelled', error: undefined } : { ...item, status: 'failed', error: message } : item))
      setNotice(cancelled ? { tone: 'success', text: 'Generation cancelled.' } : { tone: 'error', text: message })
    } finally {
      cancellationRequests.current.delete(localId)
      setCancellingIds((current) => { const next = new Set(current); next.delete(localId); return next })
      setSubmitting(false)
    }
  }

  const runH3Diagnostics = async () => {
    if (!settings || diagnosticRunning) return
    if (!status.connected) return setNotice({ tone: 'error', text: 'Connect ComfyUI before running the H3 diagnostic.' })
    const qualityModels = inferSelections(models, 'off')
    const turboModels = inferSelections(models, '8')
    if (![qualityModels.fl2va, qualityModels.textEncoder, qualityModels.videoVae, qualityModels.audioVae, turboModels.fl2vLora].every(Boolean)) {
      return setNotice({ tone: 'error', text: 'The FL2VA base stack and official 8-step Turbo LoRA are required for the diagnostic.' })
    }
    const tests = [
      { name: 'Native quality', turbo: 'off' as const, selection: qualityModels, filenamePrefix: 'video/MiniMax_DIAGNOSTIC_NATIVE' },
      { name: 'Official Turbo 8', turbo: '8' as const, selection: turboModels, filenamePrefix: 'video/MiniMax_DIAGNOSTIC_TURBO8' },
    ]
    setDiagnosticRunning(true)
    setNotice({ tone: 'neutral', text: 'Queuing the fixed-seed Native and Turbo 8 diagnostic pair…' })
    let queuedCount = 0
    for (const [index, test] of tests.entries()) {
      const id = createId()
      const job: GenerationJob = { id, provider: 'minimax', mode: 'text', prompt: `[H3 diagnostic · ${test.name}] ${diagnosticPrompt}`, createdAt: Date.now() + index, status: 'queued', progress: 2, progressLabel: 'Preparing diagnostic workflow', width: 1344, height: 768, duration: 5 }
      setJobs((current) => [job, ...current])
      try {
        const graph = buildMiniMaxWorkflow({ mode: 'text', prompt: diagnosticPrompt, width: 1344, height: 768, duration: 5, seed: 12345, steps: 20, turbo: test.turbo, sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: test.filenamePrefix, referenceImages: [], referenceVideos: [], referenceAudios: [] }, test.selection, { images: [], videos: [], audios: [] })
        const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, live.clientId)
        queuedCount += 1
        setJobs((current) => current.map((item) => item.id === id ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: index === 0 ? 'Native test queued' : 'Turbo 8 test queued behind Native' } : item))
        if (index === tests.length - 1) setActiveJobId(id)
      } catch (error) {
        setJobs((current) => current.map((item) => item.id === id ? { ...item, status: 'failed', error: error instanceof Error ? error.message : String(error) } : item))
      }
    }
    setDiagnosticRunning(false)
    setNotice(queuedCount === 2
      ? { tone: 'success', text: 'H3 diagnostic pair queued with identical prompt, seed, resolution, duration, and official sampling.' }
      : { tone: 'error', text: queuedCount ? 'Only one diagnostic render could be queued. Check the failed Queue entry.' : 'The diagnostic renders could not be queued. Check ComfyUI and try again.' })
    setView('queue')
  }

  if (!settings) {
    return <div className="boot"><LoaderCircle className="spin" /><span>Opening MiniMax Studio…</span></div>
  }

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <header className="titlebar" aria-label="Application title bar">
        <button className="titlebar-mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open workspace menu"><Menu size={18} /></button>
        <div className="titlebar-brand"><span className="brand-mark"><Film size={16} /></span><span>MiniMax Studio</span></div>
        <div className="titlebar-drag" />
        {(view === 'create' || view === 'ltx25' || view === 'zimage') && <button className="titlebar-action titlebar-reset" onClick={resetCurrentWorkspace} title="Reset prompts, options, media, selections, and the current preview in this workspace"><RotateCcw size={14} />Reset workspace</button>}
        <GpuMeter value={gpu} />
        <button className={`connection-chip ${status.connected ? 'online' : ''}`} onClick={() => void checkConnection(settings.comfyUrl)} title="Check ComfyUI connection">
          {checking ? <LoaderCircle size={14} className="spin" /> : <span className="status-dot" />}
          {status.connected ? `Local engine · ${status.latencyMs} ms` : 'Engine offline'}
        </button>
      </header>

      {sidebarOpen && <button className="mobile-sidebar-backdrop" aria-label="Close workspace menu" onClick={() => setSidebarOpen(false)} />}
      <aside className="sidebar" onClick={(event) => { if (window.innerWidth <= 680 && (event.target as HTMLElement).closest('button')) setSidebarOpen(false) }}>
        <div className="sidebar-top">
          <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)} aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}><PanelLeftClose size={18} /></button>
        </div>
        <nav aria-label="Primary navigation">
          <div className="nav-group"><span className="nav-section-label">Generate</span>
            <NavButton active={view === 'create'} icon={WandSparkles} label="Create" onClick={() => { setCharacterHandoff(null); setView('create') }} />
            <NavButton active={view === 'ltx25'} icon={Aperture} label="LTX 2.5" onClick={() => setView('ltx25')} />
            <NavButton active={view === 'music'} icon={Music2} label="Music" onClick={() => setView('music')} />
          </div>
          <div className="nav-group"><span className="nav-section-label">Plan</span>
            <NavButton active={view === 'zimage'} icon={ImageIcon} label="Create Image" onClick={() => setView('zimage')} />
            <NavButton active={view === 'characters'} icon={Users} label="Characters" itemType="character" onClick={() => setView('characters')} />
            <NavButton active={view === 'hair'} icon={Scissors} label="Hair" onClick={() => setView('hair')} />
            <NavButton active={view === 'wardrobes'} icon={Shirt} label="Wardrobe" itemType="wardrobe" onClick={() => setView('wardrobes')} />
            <NavButton active={view === 'accessories'} icon={Watch} label="Accessories" onClick={() => setView('accessories')} />
            <NavButton active={view === 'locations'} icon={MapPin} label="Locations" itemType="location" onClick={() => setView('locations')} />
          </div>
          <div className="nav-group"><span className="nav-section-label">Review</span>
            <NavButton active={view === 'queue'} icon={ListVideo} label="Queue" count={pendingJobs.length} onClick={() => setView('queue')} />
            <NavButton active={view === 'library'} icon={Library} label="Library" onClick={() => setView('library')} />
            <NavButton active={view === 'editor'} icon={Scissors} label="Clip editor" onClick={() => setView('editor')} />
          </div>
        </nav>
        <div className="sidebar-spacer" />
        <div className={`model-health ${modelReady ? 'healthy' : ''}`}>
          <HardDrive size={17} />
          <div><strong>{modelReady ? 'Models ready' : 'Models incomplete'}</strong><span>{models.length} local files indexed</span></div>
        </div>
        <nav className="sidebar-secondary" aria-label="Advanced tools"><div className="nav-group"><span className="nav-section-label">Advanced tools</span><NavButton active={view === 'movie'} icon={Clapperboard} label="Movie" onClick={() => setView('movie')} /></div></nav>
        <NavButton active={view === 'settings'} icon={Settings} label="Settings" onClick={() => setView('settings')} />
      </aside>

      <main className="main-area">
        {notice && <Notice tone={notice.tone} text={notice.text} onClose={() => setNotice(null)} />}
        <div hidden={view !== 'create'}>
          <CreateView key={`create-${createResetKey}`}
            info={info}
            sampler={sampler} setSampler={setSampler} scheduler={scheduler} setScheduler={setScheduler}
            experimentalSampling={experimentalSampling} setExperimentalSampling={setExperimentalSampling}
            refImageSize={refImageSize} setRefImageSize={setRefImageSize}
            noDialogue={noDialogue} setNoDialogue={setNoDialogue}
            naturalMovement={naturalMovement} setNaturalMovement={setNaturalMovement}
            clothingPolicy={clothingPolicy} setClothingPolicy={setClothingPolicy}
            sigmaShiftMode={sigmaShiftMode} setSigmaShiftMode={setSigmaShiftMode}
            shiftVideo={shiftVideo} setShiftVideo={setShiftVideo} shiftAudio={shiftAudio} setShiftAudio={setShiftAudio}
            loraStrength={loraStrength} setLoraStrength={setLoraStrength}
            liveEnabled={liveEnabled} setLiveEnabled={setLiveEnabled} livePreviewMode={livePreviewMode} setLivePreviewMode={setLivePreviewMode} liveConnected={live.connected} livePreview={live.preview}
            upscaleMode={upscaleMode} setUpscaleMode={setUpscaleMode} ltxAvailable={ltxUpscaleReady} ltxMissingNodes={missingLtxUpscaleNodes}
            rtxModels={rtxModels} rtxModel={rtxModel} setRtxModel={setRtxModel}
            updateReference={(index, file) => setReferenceImages((items) => items.map((item, i) => i === index ? file : item))}
            mode={mode}
            setMode={setMode}
            prompt={prompt}
            setPrompt={setPrompt}
            duration={duration}
            setDuration={setDuration}
            resolution={resolution}
            setResolution={setResolution}
            turbo={turbo}
            setTurbo={setTurbo}
            steps={steps}
            setSteps={setSteps}
            seed={seed}
            setSeed={setSeed}
            advanced={advanced}
            setAdvanced={setAdvanced}
            firstFrame={firstFrame}
            lastFrame={lastFrame}
            setFirstFrame={setFirstFrame}
            setLastFrame={setLastFrame}
            chooseMedia={chooseMedia}
            referenceImages={referenceImages}
            characters={characterProjects}
            wardrobes={wardrobeProjects}
            locations={locationProjects}
            selectedCharacterIds={selectedReferenceCharacterIds}
            selectedLocationIds={selectedReferenceLocationIds}
            loadCharacter={(characterId) => void loadReferenceCharacter(characterId)}
            loadWardrobe={(wardrobeId) => void loadReferenceWardrobe(wardrobeId)}
            loadLocation={(locationId) => void loadReferenceLocation(locationId)}
            refreshSourceMedia={refreshSourceMedia}
            referenceVideos={referenceVideos}
            referenceAudios={referenceAudios}
            removeReference={(kind, index) => {
              if (kind === 'image') { setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setReferenceImages((items) => items.filter((_, itemIndex) => itemIndex !== index)) }
              if (kind === 'video') setReferenceVideos((items) => items.filter((_, itemIndex) => itemIndex !== index))
              if (kind === 'audio') setReferenceAudios((items) => items.filter((_, itemIndex) => itemIndex !== index))
            }}
            chooseReference={chooseMany}
            editVideoReference={(index) => void editVideoReference(index)}
            h3Validated={h3Report.validated}
            modelReady={modelReady}
            selection={selection}
            submitting={submitting}
            cancelling={Boolean(activeJobId && cancellingIds.has(activeJobId))}
            connected={status.connected}
            onGenerate={() => void generate()}
            latestJob={activeJobId ? jobs.find((job) => job.id === activeJobId) : undefined}
            onCancel={(job) => void cancelJob(job)}
            onContinue={continueFromRenderedVideo}
            ollamaAvailable={ollamaModels.length > 0}
            ollamaModel={settings.ollamaModel}
            promptSuggestion={promptSuggestion}
            promptingTool={promptingTool}
            dialogueGenerating={dialogueGenerating}
            onPromptTool={(tool) => void runPromptTool(tool)}
            onGenerateDialogue={generateCharacterDialogue}
            onUseSuggestion={() => { setPrompt(promptSuggestion); setPromptSuggestion('') }}
            onDismissSuggestion={() => setPromptSuggestion('')}
          />
        </div>
        {view === 'ltx25' && <Ltx25Workspace key={`ltx-${ltxResetKey}`}
          settings={settings}
          models={ltxSelection}
          pipelineReady={LTX_NATIVE_REQUIRED_NODES.every((node) => Boolean(info[node]))}
          missingNodes={LTX_NATIVE_REQUIRED_NODES.filter((node) => !info[node])}
          connected={status.connected}
          liveConnected={live.connected}
          livePreview={live.preview}
          latestJob={jobs.find((job) => job.provider === 'ltx25' && job.createdAt > ltxResetAt)}
          submitting={ltxSubmitting}
          cancelling={Boolean(jobs.find((job) => job.provider === 'ltx25' && ['queued', 'running'].includes(job.status)) && cancellingIds.has(jobs.find((job) => job.provider === 'ltx25' && ['queued', 'running'].includes(job.status))!.id))}
          ollamaAvailable={ollamaModels.length > 0}
          onChooseImage={chooseLtxImage}
          onGenerate={(options, file) => void generateLtx(options, file)}
          onCancel={(job) => void cancelJob(job)}
        />}
        {view === 'music' && <AceStepWorkspace
          settings={settings}
          models={aceSelection}
          connected={status.connected}
          pipelineReady={ACE_STEP_REQUIRED_NODES.every((node) => Boolean(info[node]))}
          missingNodes={ACE_STEP_REQUIRED_NODES.filter((node) => !info[node])}
          latestJob={jobs.find((job) => job.provider === 'acestep')}
          submitting={aceSubmitting}
          cancelling={Boolean(jobs.find((job) => job.provider === 'acestep' && ['queued', 'running'].includes(job.status)) && cancellingIds.has(jobs.find((job) => job.provider === 'acestep' && ['queued', 'running'].includes(job.status))!.id))}
          ollamaAvailable={ollamaModels.length > 0}
          onGenerate={(options) => void generateAceStep(options)}
          onCancel={(job) => void cancelJob(job)}
        />}
        <div hidden={view !== 'zimage'}><ZImageWorkspace key={`first-frame-${zImageResetKey}`} url={settings.comfyUrl} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} ollamaUrl={settings.ollamaUrl} ollamaModel={settings.ollamaModel} outputDirectory={settings.outputDirectory} onUse={(file, frameResolution) => {
          setFirstFrame(file); setResolution(frameResolution); setMode('image'); setActiveJobId(null); setView('create'); setNotice({ tone: 'success', text: 'Z-Image frame loaded into the MiniMax I2V workspace.' })
        }} /></div>
        {view === 'characters' && <CharacterStudio settings={settings} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} automationJob={jobs.find((job) => job.characterProjectId)} onNotice={(tone, text) => setNotice({ tone, text })} onCreateTurntable={(project) => {
          if (!project.baseImage) return Promise.resolve('Approve a character identity image before rendering the survey.')
          const firstFrame = fitWholeCharacter({ ...project.baseImage }); delete firstFrame.preview
          return generateLtx({ mode: 'image', prompt: `Ten-second character identity coverage survey of ${project.name} in one continuous stabilized take. Preserve the exact identity, facial geometry, skin, hair, body proportions, clothing, and neutral studio background from the first frame. From 0 to 2 seconds hold a sharp neutral full-body front view with the entire head, hands, and feet visible. From 2 to 5 seconds make a slow stabilized camera push to a sharp head-and-shoulders close-up. From 5 to 7 seconds hold the face clearly while moving through frontal and gentle three-quarter facial angles so the eyes, nose, mouth, jawline, ears, hairline, and distinguishing marks remain readable. From 7 to 10 seconds pull back smoothly to a complete full-body view and continue a restrained orbit through three-quarter, side, and rear body angles. The character stays still with a neutral expression and unchanged pose. Even soft studio lighting, accurate anatomy, crisp individual frames, fast shutter. No cuts, no identity drift, no morphing, no pose changes, no expression changes, no clothing changes, no added objects, no motion blur, no smearing, no ghosting, no whip pans, no text, no dialogue.`, width: 768, height: 1024, duration: 10, preset: 'quality', seed: Math.floor(Math.random() * 1_000_000_000), filenamePrefix: 'MiniMax_character_identity_survey' }, firstFrame, { characterProjectId: project.id })
        }} />}
        {view === 'hair' && <HairStudio settings={settings} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} onNotice={(tone, text) => setNotice({ tone, text })} />}
        {view === 'wardrobes' && <WardrobeStudio settings={settings} info={info} connected={status.connected} onNotice={(tone, text) => setNotice({ tone, text })} />}
        {view === 'accessories' && <AccessoryStudio settings={settings} info={info} connected={status.connected} onNotice={(tone, text) => setNotice({ tone, text })} />}
        {view === 'locations' && <LocationStudio settings={settings} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} automationJob={jobs.find((job) => job.locationProjectId)} onNotice={(tone, text) => setNotice({ tone, text })} onCreateWalkthrough={(project: LocationProject, options?: { duration: number; cameraLanguage: string }) => {
          if (!project.baseImage) return Promise.resolve('Approve a location image before rendering the walkthrough.')
          const firstFrame = { ...project.baseImage }; delete firstFrame.preview
          const walkthroughDirection = project.environmentMode === 'nature'
            ? `Comprehensive cinematic natural-landscape survey of ${project.name}. Begin with a wide establishing view, then move slowly through the terrain in one continuous stabilized path. Deliberately reveal landforms, vegetation zones, water features, rock formations, horizon lines, and their spatial relationships. Preserve the exact terrain, ecology, vegetation placement, lighting, weather, and geography from the first frame. Untouched nature only: no buildings, cabins, houses, ruins, roads, streets, bridges, fences, signs, vehicles, power lines, utility poles, constructed paths, or other human-made objects.`
            : `Comprehensive cinematic location walkthrough reference video of ${project.name}. Begin with a wide establishing view, then move slowly along the perimeter in one continuous stabilized path. Deliberately pan through every important zone and spatial connection, revealing entrances, landmarks, surfaces, fixtures, terrain, and object placement. Preserve exactly the same architecture, dimensions, materials, lighting, weather, and geography from the first frame.`
          const locationProfile = [project.description, project.atmosphere && `Atmosphere and lighting: ${project.atmosphere}.`, project.timeOfDay && `Time and weather: ${project.timeOfDay}.`, project.continuityAnchors && `Fixed continuity anchors: ${project.continuityAnchors}.`, project.visualStyle && `Visual treatment: ${project.visualStyle}.`].filter(Boolean).join(' ')
          const cameraLanguage = options?.cameraLanguage ?? 'Use only wide and extra-wide shots with an 18–24mm lens. Begin with a complete establishing view, then move slowly and smoothly to reveal the environment’s spatial relationships. Never use close-ups.'
          const clarityDirection = 'Maintain crisp, sharp frames with a fast shutter and slow stabilized camera movement. No motion blur, temporal smearing, ghosting, rolling-shutter distortion, speed ramps, whip pans, or rapid camera movement.'
          return generateLtx({ mode: 'image', prompt: `${walkthroughDirection} Location description: ${locationProfile} Camera language: ${cameraLanguage} Image clarity: ${clarityDirection} No cuts, no teleporting, no layout changes, no duplicated objects, no people as focal subjects, no dialogue, no text, no logos.`, width: 1344, height: 768, duration: Math.max(5, Math.min(20, options?.duration ?? 10)), preset: 'quality', seed: Math.floor(Math.random() * 1_000_000_000), filenamePrefix: 'MiniMax_location_walkthrough' }, firstFrame, { locationProjectId: project.id })
        }} />}
        {view === 'movie' && <MoviePlanner settings={settings} ollamaAvailable={ollamaModels.length > 0} ollamaModel={settings.ollamaModel} onNotice={(tone, text) => setNotice({ tone, text })} onOpenShot={async (shot: MovieShot, aspectRatio: MovieProject['aspectRatio'], resolved: ResolvedMovieShot, context: { projectId: string; sceneId: string; continuationSource?: string }) => {
          setCharacterHandoff(null)
          setSelectedReferenceCharacterIds([])
          setSelectedReferenceLocationIds([])
          setPrompt(resolved.compiledPrompt)
          setDuration(Math.max(2, Math.min(15, shot.duration)))
          setMode(resolved.effectiveMode)
          if (resolved.effectiveMode === 'reference' && turbo === '8') setTurbo('off')
          setResolution(aspectRatio === '9:16' ? '768x1344' : aspectRatio === '1:1' ? '768x768' : '1344x768')
          let inheritedFrame: MediaFile | null = null
          if (context.continuationSource) {
            try {
              const extracted = await window.minimax.extractVideoFrame(context.continuationSource, 'last', settings.outputDirectory, settings.ffmpegPath)
              inheritedFrame = { ...extracted, kind: 'image', preview: await window.minimax.mediaUrl(extracted.path) }
            } catch (error) {
              setNotice({ tone: 'error', text: `Could not prepare the continuation frame: ${error instanceof Error ? error.message : String(error)}` })
              return
            }
          }
          setMovieHandoff({ projectId: context.projectId, sceneId: context.sceneId, shotId: shot.id })
          const resolvedImages = resolved.references.map((binding) => binding.purpose === 'continuity' && inheritedFrame ? inheritedFrame : binding.file)
          setFirstFrame(resolved.effectiveMode === 'image' ? inheritedFrame : null); setLastFrame(null); setReferenceImages(resolved.effectiveMode === 'reference' ? resolvedImages : []); setReferenceVideos(resolved.effectiveMode === 'reference' ? shot.referenceVideos ?? [] : []); setReferenceAudios(resolved.effectiveMode === 'reference' ? shot.referenceAudios ?? [] : [])
          setActiveJobId(null); setView('create')
          const inputNote = resolved.effectiveMode === 'reference' ? ` Loaded ${resolvedImages.length} semantically resolved reference image${resolvedImages.length === 1 ? '' : 's'}.` : inheritedFrame ? ' The previous scene’s last frame was loaded automatically for continuous I2V.' : resolved.effectiveMode === 'image' ? ' Add the approved first frame before rendering.' : resolved.effectiveMode === 'frames' ? ' Add the approved first and last frames before rendering.' : ''
          setNotice({ tone: 'success', text: `${shot.title} loaded into Create.${inputNote}` })
        }} />}
        {view === 'queue' && <JobsView title="Queue" note="Running and recent local generations" jobs={jobs} empty="No generations have been queued." cancellingIds={cancellingIds} onCancel={cancelJob} />}
        {view === 'library' && <LibraryView jobs={jobs.filter((job) => job.status === 'completed')} settings={settings} onEdit={() => setView('editor')} onUseLtx={useStartFrameInLtx} onNotice={(tone, text) => setNotice({ tone, text })} />}
        {view === 'editor' && <ClipEditor settings={settings} jobs={jobs} onNotice={(tone, text) => setNotice({ tone, text })} onUseFrame={(file, target, clip) => {
          if (target === 'reference') { setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setReferenceImages((items) => [...items, file].slice(0, 9)); setMode('reference') }
          else if (target === 'last') { setLastFrame(file); setMode('frames') }
          else { setFirstFrame(file); setMode(target === 'first' ? 'frames' : 'image') }
          setActiveJobId(null); setView('create')
          setNotice({ tone: 'success', text: target === 'i2v' ? `Frame loaded from ${clip.name} as the I2V first frame. The new render will remain a separate video until you add and export it in Clip Editor.` : 'Extracted frame loaded into Create.' })
        }} />}
        {view === 'settings' && <SettingsView settings={settings} setSettings={setSettings} info={info} models={models} h3Report={h3Report} scanning={scanning} status={status} checking={checking} diagnosticRunning={diagnosticRunning} ollamaModels={ollamaModels} onRefreshOllama={() => void refreshOllama(settings)} onScan={() => void scanModels(settings)} onCheck={() => void checkConnection(settings.comfyUrl)} onSave={() => void saveAppSettings()} onApplyDefaults={applyGenerationDefaults} onRunDiagnostics={() => void runH3Diagnostics()} />}
      </main>
      <AiChatHead available={ollamaModels.length > 0} ollamaUrl={settings.ollamaUrl} ollamaModel={settings.ollamaModel} onUseImage={(imagePrompt) => {
        setView('zimage')
        window.dispatchEvent(new CustomEvent('minimax:load-image-prompt', { detail: imagePrompt }))
        setNotice({ tone: 'success', text: 'Image prompt loaded into Create Image.' })
      }} onUseVideo={(videoPrompt) => {
        setPrompt(videoPrompt); setMode('text'); setNoDialogue(true); setActiveJobId(null); setView('create')
        setNotice({ tone: 'success', text: 'Video prompt loaded into Create with No dialogue enabled.' })
      }} />
      {videoClipDraft && <VideoReferenceClipper source={videoClipDraft.source} onClose={() => setVideoClipDraft(null)} onCreate={createVideoReferenceClip} />}
    </div>
  )
}

export default App
