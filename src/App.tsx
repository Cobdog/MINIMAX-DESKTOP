import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import QRCode from 'qrcode'
import { createId } from './lib/createId'
import {
  Activity,
  AlertCircle,
  Aperture,
  Check,
  ChevronDown,
  Clapperboard,
  CircleStop,
  Clock3,
  ExternalLink,
  Film,
  Folder,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  Image as ImageIcon,
  Library,
  ListVideo,
  LoaderCircle,
  MapPin,
  PanelLeftClose,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Settings,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Users,
  Volume2,
  WandSparkles,
  X,
} from 'lucide-react'
import { buildMiniMaxWorkflow, extractOutputUrl, frameCount } from './lib/workflow'
import { buildLtx25Workflow } from './lib/ltx25Workflow'
import { fitWholeCharacter, prepareImage } from './lib/imageCrop'
import { inferLtx25Selections, inferSelections } from './lib/modelSelection'
import { choices, type ObjectInfo } from './lib/comfyInfo'
import { useLivePreview, type LiveProgress } from './lib/useLivePreview'
import { RenderSize } from './components/RenderSize'
import { ImageCrop } from './components/ImageCrop'
import { ZImageWorkspace } from './components/ZImageWorkspace'
import { ClipEditor } from './components/ClipEditor'
import { MoviePlanner } from './components/MoviePlanner'
import { Ltx25Workspace } from './components/Ltx25Workspace'
import { VideoReferenceClipper } from './components/VideoReferenceClipper'
import { CharacterStudio } from './components/CharacterStudio'
import { WardrobeStudio } from './components/WardrobeStudio'
import { LocationStudio } from './components/LocationStudio'
import { AiChatHead } from './components/AiChatHead'
import { SmartPromptEditor, type SmartPromptEditorHandle } from './components/SmartPromptEditor'
import { RenderConstruction } from './components/RenderConstruction'
import { CHARACTER_LIBRARY_EVENT, characterReferences, loadCharacterProjects, updateCharacterProject } from './lib/characterLibrary'
import { loadWardrobeProjects, wardrobeReferences, WARDROBE_LIBRARY_EVENT } from './lib/wardrobeLibrary'
import { loadLocationProjects, locationReferences, updateLocationProject, LOCATION_LIBRARY_EVENT } from './lib/locationLibrary'
import { allocateWorkspaceReferences, buildPromptAssistantRequest, composeReferenceInstructions } from './lib/promptComposer'
import { applyDialoguePolicy } from './lib/dialogPolicy'
import type {
  AppSettings,
  CharacterProject,
  ComfyStatus,
  GenerationJob,
  GenerationMode,
  GpuTelemetry,
  Ltx25GenerationOptions,
  LocationProject,
  LanStatus,
  MediaFile,
  MediaKind,
  ModelFile,
  ModelKind,
  ModelSelection,
  MovieProject,
  MovieReferenceBinding,
  ResolvedMovieShot,
  WardrobeProject,
  MovieShot,
  OllamaModel,
  UpscaleMode,
  View,
} from './types'

type PersistedWorkspace = {
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
  clothingPolicy: 'wardrobe' | 'underwear' | 'unrestricted'
  sigmaShiftMode: 'model' | 'custom'
  shiftVideo: number
  shiftAudio: number
  loraStrength: number
  seed: number
  advanced: boolean
  liveEnabled: boolean
  upscaleMode: UpscaleMode
  rtxModel: string
  firstFrame: MediaFile | null
  lastFrame: MediaFile | null
  referenceImages: MediaFile[]
  referenceVideos: MediaFile[]
  referenceAudios: MediaFile[]
  selectedReferenceCharacterIds: string[]
  selectedReferenceLocationIds: string[]
  activeJobId: string | null
  movieHandoff: MovieLink | null
}

type MovieLink = { projectId: string; sceneId: string; shotId: string }

const workspaceDefaults: PersistedWorkspace = {
  mode: 'text', prompt: '', duration: 5, resolution: '1344x768', turbo: 'off', steps: 20,
  sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, refImageSize: 'match', noDialogue: true, clothingPolicy: 'wardrobe',
  sigmaShiftMode: 'model', shiftVideo: 12, shiftAudio: 3, loraStrength: 1, seed: Math.floor(Math.random() * 1_000_000_000),
  advanced: false, liveEnabled: true, upscaleMode: 'off', rtxModel: '', firstFrame: null,
  lastFrame: null, referenceImages: [], referenceVideos: [], referenceAudios: [], selectedReferenceCharacterIds: [], selectedReferenceLocationIds: [], activeJobId: null, movieHandoff: null,
}

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

function readWorkspace(): PersistedWorkspace {
  try {
    const stored = JSON.parse(localStorage.getItem('minimax.workspace') ?? '{}') as Partial<PersistedWorkspace>
    const workspace = { ...workspaceDefaults, ...stored }
    // Existing installs predate the explicit experimental opt-in. Migrate them
    // back to the official ComfyUI sampling pair to prevent stale combinations
    // such as heun+karras from continuing to produce surprising output.
    if (!stored.experimentalSampling) {
      workspace.sampler = 'res_multistep'
      workspace.scheduler = 'simple'
      workspace.experimentalSampling = false
    }
    if (workspace.mode === 'reference' && workspace.turbo === '8') workspace.turbo = 'off'
    workspace.steps = Math.max(16, Math.min(30, Number(workspace.steps) || 20))
    return workspace
  } catch {
    return workspaceDefaults
  }
}

function withoutPreview(file: MediaFile | null) {
  if (!file) return null
  const stored = { ...file }
  delete stored.preview
  return stored
}

const modeInfo: Array<{ id: GenerationMode; label: string; note: string; icon: typeof Film }> = [
  { id: 'text', label: 'Text', note: 'Prompt to video', icon: WandSparkles },
  { id: 'image', label: 'Image', note: 'Animate one frame', icon: ImageIcon },
  { id: 'frames', label: 'First + last', note: 'Direct the transition', icon: Aperture },
  { id: 'reference', label: 'Reference', note: 'Images, video, audio', icon: Sparkles },
]

const diagnosticPrompt = 'A woman standing beside a window in soft daylight, natural skin texture, subtle head movement, realistic cinematic photography.'
const validatedH3Files = [
  { label: 'FL2VA', kind: 'diffusion_models' as const, expected: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', fallback: /^minimax_h3_fl2va.*\.safetensors$/i },
  { label: 'Text encoder', kind: 'text_encoders' as const, expected: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', fallback: /^qwen3vl_32b_minimax_h3.*\.safetensors$/i },
  { label: 'Video VAE', kind: 'vae' as const, expected: 'minimax_h3_video_vae_fp16.safetensors', fallback: /^minimax_h3_video_vae.*\.safetensors$/i },
  { label: 'Audio VAE', kind: 'vae' as const, expected: 'minimax_h3_audio_vae_fp32.safetensors', fallback: /^minimax_h3_audio_vae.*\.safetensors$/i },
  { label: 'Turbo 8', kind: 'loras' as const, expected: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', fallback: /^minimax_h3_fl2v_turbo_8step.*\.safetensors$/i },
]

function h3StackReport(models: ModelFile[]) {
  const rows = validatedH3Files.map((definition) => {
    const files = models.filter((model) => model.kind === definition.kind)
    const exact = files.find((model) => model.name.toLowerCase() === definition.expected.toLowerCase())
    const fallback = files.find((model) => definition.fallback.test(model.name))
    return { ...definition, selected: exact?.name ?? fallback?.name ?? '', validated: Boolean(exact) }
  })
  return { rows, validated: rows.every((row) => row.validated), ready: rows.every((row) => row.selected) }
}

function playableOutputUrl(value?: string) {
  if (!value || value.startsWith('minimax-media:')) return value
  try {
    const url = new URL(value)
    return url.pathname === '/view' ? `minimax-media://comfy?url=${encodeURIComponent(value)}` : value
  } catch {
    return value
  }
}

const initialJobs = (): GenerationJob[] => {
  try {
    const stored = JSON.parse(localStorage.getItem('minimax.jobs') ?? '[]') as GenerationJob[]
    return stored.map((job) => ({ ...job, outputUrl: playableOutputUrl(job.outputUrl) }))
  } catch {
    return []
  }
}

function recordMovieOutput(link: MovieLink | undefined, outputUrl: string) {
  if (!link) return
  try {
    const projects = JSON.parse(localStorage.getItem('minimax.movie-projects') ?? '[]') as MovieProject[]
    const next = projects.map((project) => project.id !== link.projectId ? project : { ...project, updatedAt: Date.now(), scenes: project.scenes.map((scene) => scene.id !== link.sceneId ? scene : { ...scene, shots: scene.shots.map((shot) => shot.id !== link.shotId ? shot : { ...shot, outputUrl, renderedAt: Date.now(), stage: 'rendered' as const }) }) })
    localStorage.setItem('minimax.movie-projects', JSON.stringify(next))
  } catch { /* Keep the completed generation even if legacy movie data cannot be updated. */ }
}

function recordCharacterTurntable(characterProjectId: string | undefined, outputUrl: string) {
  if (!characterProjectId) return
  updateCharacterProject(characterProjectId, { turntableVideo: { path: outputUrl, name: 'Generated character turntable', kind: 'video', preview: outputUrl } })
}

function recordLocationWalkthrough(locationProjectId: string | undefined, outputUrl: string) {
  if (!locationProjectId) return
  updateLocationProject(locationProjectId, { walkthroughVideo: { path: outputUrl, name: 'Generated location walkthrough', kind: 'video', preview: outputUrl } })
}

async function extractAutomatedReferenceSet(kind: 'character' | 'location', projectId: string | undefined, source: string, duration: number, settings: AppSettings) {
  if (!projectId || !source) return
  try {
    const positions = [0.05, .25, .5, .75, .95].map((ratio) => Math.max(0, Math.min(duration - .04, duration * ratio)))
    const references = await Promise.all(positions.map(async (position) => {
      const result = await window.minimax.extractVideoFrame(source, position, settings.outputDirectory, settings.ffmpegPath)
      return { ...result, kind: 'image' as const, preview: await window.minimax.mediaUrl(result.path) }
    }))
    if (kind === 'character') updateCharacterProject(projectId, { referenceMode: 'set', referenceImages: references, selectedReferencePaths: undefined })
    else updateLocationProject(projectId, { referenceMode: 'set', referenceImages: references, selectedReferencePaths: undefined })
  } catch { /* The completed video stays attached; manual extraction remains available in the studio. */ }
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`
}

function shortPrompt(prompt: string) {
  return prompt.length > 76 ? `${prompt.slice(0, 76)}…` : prompt
}

function syncReferencePrompt(value: string, previous: MovieReferenceBinding[], next: MovieReferenceBinding[]) {
  let result = value
    .replace(/Character:\s*([^—\n]+?)\s*—\s*(?=<Picture \d+>)[^\n]*?from another character\./g, (_match, name: string) => `Character: ${name.trim()}.`)
    .replace(/Location:\s*preserve the approved ([^;\n]+?) environment from [^;\n]+;\s*keep its architecture, layout, materials, lighting, landmarks, and geography consistent\./gi, (_match, name: string) => `Location: ${name.trim()}.`)
  const previousInstructions = composeReferenceInstructions(previous)
  const previousCharacters = [...new Set(previous.filter((binding) => binding.characterId).map((binding) => binding.label.replace(/^Character:\s*/, '').replace(/^Wardrobe:\s*/, '').split(' / ')[0].split(' for ').at(-1)!))]
  for (const name of previousCharacters) {
    const instructions = previousInstructions.filter((line) => line.includes(name)).join(' ')
    result = result.replace(`Character: ${name} — ${instructions}`, `Character: ${name}`)
  }
  for (const line of previousInstructions) result = result.replace(line, '')
  result = result.replace(/References:\s*(?=\n|$)/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const nextInstructions = composeReferenceInstructions(next).join(' ')
  return [result, nextInstructions ? `References: ${nextInstructions}` : ''].filter(Boolean).join('\n\n')
}

function App() {
  const persisted = useMemo(readWorkspace, [])
  const [view, setView] = useState<View>('create')
  const [sidebarOpen, setSidebarOpen] = useState(true)
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
  const [clothingPolicy, setClothingPolicy] = useState<'wardrobe' | 'underwear' | 'unrestricted'>(persisted.clothingPolicy)
  const [sigmaShiftMode, setSigmaShiftMode] = useState<'model' | 'custom'>(persisted.sigmaShiftMode)
  const [shiftVideo, setShiftVideo] = useState(persisted.shiftVideo)
  const [shiftAudio, setShiftAudio] = useState(persisted.shiftAudio)
  const [loraStrength, setLoraStrength] = useState(persisted.loraStrength)
  const [info, setInfo] = useState<ObjectInfo>({})
  const [liveEnabled, setLiveEnabled] = useState(persisted.liveEnabled)
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
  const [diagnosticRunning, setDiagnosticRunning] = useState(false)
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set())
  const cancellationRequests = useRef(new Set<string>())
  const mediaHydrated = useRef(false)
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'neutral'; text: string } | null>(null)
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [promptSuggestion, setPromptSuggestion] = useState('')
  const [promptingTool, setPromptingTool] = useState<'enhance' | 'timeline' | 'audio' | null>(null)
  const [lanOpen, setLanOpen] = useState(false)
  const [lanStatus, setLanStatus] = useState<LanStatus>({ running: false })
  const [lanQr, setLanQr] = useState('')
  const [videoClipDraft, setVideoClipDraft] = useState<{ source: MediaFile; replaceIndex?: number } | null>(null)
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
    void window.minimax.getLanStatus().then(setLanStatus)
  }, [])

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
    if (!lanOpen || !lanStatus.url) {
      setLanQr('')
      return
    }
    void QRCode.toDataURL(lanStatus.url, { width: 300, margin: 2, color: { dark: '#101412', light: '#ffffff' } }).then(setLanQr)
  }, [lanOpen, lanStatus.url])

  useEffect(() => {
    if (!lanOpen) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setLanOpen(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [lanOpen])

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
    void window.minimax.syncMobileCharacters(characterProjects.map((character) => ({
      id: character.id,
      name: character.name,
      description: character.description,
      wardrobe: '',
      voiceNotes: character.voiceNotes,
      visualStyle: character.visualStyle,
      references: characterReferences(character).map((file) => ({ name: file.name, preview: file.preview ?? '' })).filter((file) => file.preview),
    }))).catch(() => undefined)
  }, [characterProjects])
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
      mode, prompt, duration, resolution, turbo, steps, sampler, scheduler, experimentalSampling, refImageSize, noDialogue, clothingPolicy,
      sigmaShiftMode, shiftVideo, shiftAudio, loraStrength, seed, advanced, liveEnabled,
      upscaleMode, rtxModel, firstFrame: withoutPreview(firstFrame), lastFrame: withoutPreview(lastFrame),
      referenceImages: referenceImages.map((file) => withoutPreview(file)!),
      referenceVideos: referenceVideos.map((file) => withoutPreview(file)!),
      referenceAudios: referenceAudios.map((file) => withoutPreview(file)!), selectedReferenceCharacterIds, selectedReferenceLocationIds, activeJobId, movieHandoff,
    }
    localStorage.setItem('minimax.workspace', JSON.stringify(workspace))
  }, [activeJobId, advanced, clothingPolicy, duration, experimentalSampling, firstFrame, lastFrame, liveEnabled, loraStrength, mode, movieHandoff, noDialogue, prompt, refImageSize, referenceAudios, referenceImages, referenceVideos, resolution, rtxModel, sampler, scheduler, seed, selectedReferenceCharacterIds, selectedReferenceLocationIds, shiftAudio, shiftVideo, sigmaShiftMode, steps, turbo, upscaleMode])

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
    const timer = window.setInterval(() => {
      for (const job of jobsRef.current.filter((j) => j.status === 'queued' || j.status === 'running')) {
        const promptId = job.promptId
        if (!promptId) continue
        void window.minimax.getHistory(settings.comfyUrl, promptId).then(async (history) => {
          const entry = history[promptId] as { status?: { status_str?: string; completed?: boolean; messages?: unknown[] } } | undefined
          const outputUrl = playableOutputUrl(extractOutputUrl(history, promptId, settings.comfyUrl))
          if (entry?.status?.status_str === 'error') {
            setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'failed', error: 'ComfyUI reported an execution error. The original may still be saved if upscaling failed.' } : item))
          } else if (outputUrl && entry?.status?.completed) {
            recordMovieOutput(job.movieLink, outputUrl)
            if (job.characterProjectId) {
              const localOutput = await window.minimax.findLatestOutput(settings.outputDirectory, job.createdAt)
              recordCharacterTurntable(job.characterProjectId, localOutput ?? outputUrl)
              recordLocationWalkthrough(job.locationProjectId, localOutput ?? outputUrl)
              if (localOutput) await extractAutomatedReferenceSet('character', job.characterProjectId, localOutput, job.duration, settings)
              if (localOutput) await extractAutomatedReferenceSet('location', job.locationProjectId, localOutput, job.duration, settings)
            } else if (job.locationProjectId) {
              const localOutput = await window.minimax.findLatestOutput(settings.outputDirectory, job.createdAt)
              recordLocationWalkthrough(job.locationProjectId, localOutput ?? outputUrl)
              if (localOutput) await extractAutomatedReferenceSet('location', job.locationProjectId, localOutput, job.duration, settings)
            }
            setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'completed', progress: 100, outputUrl } : item))
          } else if (entry?.status?.completed) {
            const localOutput = await window.minimax.findLatestOutput(settings.outputDirectory, job.createdAt)
            if (localOutput) recordMovieOutput(job.movieLink, localOutput)
            if (localOutput) recordCharacterTurntable(job.characterProjectId, localOutput)
            if (localOutput) recordLocationWalkthrough(job.locationProjectId, localOutput)
            if (localOutput) await extractAutomatedReferenceSet('character', job.characterProjectId, localOutput, job.duration, settings)
            if (localOutput) await extractAutomatedReferenceSet('location', job.locationProjectId, localOutput, job.duration, settings)
            setJobs((current) => current.map((item) => item.id === job.id ? localOutput ? { ...item, status: 'completed', progress: 100, outputUrl: localOutput } : { ...item, status: 'running', progress: 98 } : item))
          } else {
            setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'running' } : item))
          }
        }).catch(() => undefined)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [pendingKey, settings, status.connected])

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
      setVideoClipDraft({ source: { ...picked, kind: 'video', preview } })
      return
    }
    await chooseMedia(kind, (file) => {
      if (kind === 'image') { setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setReferenceImages((current) => current.length < 9 ? [...current, file] : current) }
      if (kind === 'audio') setReferenceAudios((current) => current.length < 3 ? [...current, file] : current)
    })
  }

  const workspaceBindingsFor = (characterIds: string[], locationIds: string[]) => {
    const selectedCharacters = characterIds.map((id) => characterProjects.find((project) => project.id === id)).filter(Boolean) as CharacterProject[]
    const selectedLocations = locationIds.map((id) => locationProjects.find((project) => project.id === id)).filter(Boolean) as LocationProject[]
    return allocateWorkspaceReferences(
      selectedCharacters.map((character) => ({ id: character.id, name: character.name, identity: characterReferences(character), wardrobeIds: character.wardrobeIds })),
      wardrobeProjects,
      selectedLocations.map((location) => ({ id: location.id, name: location.name, images: locationReferences(location) })),
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
    const identityCount = bindings.filter((item) => item.purpose !== 'wardrobe').length
    const wardrobeCount = bindings.filter((item) => item.purpose === 'wardrobe').length
    const locationCount = bindings.filter((item) => item.purpose === 'location').length
    setNotice({ tone: 'success', text: selectedCharacters.length ? `Using ${identityCount - locationCount} identity, ${wardrobeCount} wardrobe, and ${locationCount} location picture${locationCount === 1 ? '' : 's'} across ${bindings.length} of 9 slots.` : locationCount ? `Cast cleared. Keeping ${locationCount} location picture${locationCount === 1 ? '' : 's'}.` : 'Cleared character references.' })
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

  const resetWorkspace = () => {
    setPrompt('')
    setPromptSuggestion('')
    setFirstFrame(null)
    setLastFrame(null)
    setReferenceImages([])
    setReferenceVideos([])
    setReferenceAudios([])
    setActiveJobId(null)
    setMovieHandoff(null)
    setSelectedReferenceCharacterIds([])
    setSelectedReferenceLocationIds([])
    setNotice({ tone: 'success', text: 'Workspace cleared. Saved videos and queue history were not deleted.' })
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

  const generateLtx = async (options: Ltx25GenerationOptions, input: MediaFile | null, handoff?: { characterProjectId?: string; locationProjectId?: string }) => {
    if (!settings) return
    if (!status.connected) {
      setNotice({ tone: 'error', text: 'Start ComfyUI and verify the server connection in Settings.' })
      return
    }
    if (!options.prompt) {
      setNotice({ tone: 'error', text: 'Add an LTX prompt before generating.' })
      return
    }
    if (options.mode === 'image' && !input) {
      setNotice({ tone: 'error', text: 'Choose a first frame for LTX image-to-video.' })
      return
    }
    if (!ltxSelection.diffusion || !ltxSelection.textEncoder || !ltxSelection.videoVae || !ltxSelection.audioVae || !ltxSelection.latentUpscaler) {
      setNotice({ tone: 'error', text: 'The LTX‑2.5 distilled transformer, Gemma encoder, video/audio VAEs, or latent spatial upscaler is missing.' })
      return
    }
    const missingNodes = LTX_NATIVE_REQUIRED_NODES.filter((node) => !info[node])
    if (missingNodes.length) {
      setNotice({ tone: 'error', text: `Update ComfyUI before using LTX‑2.5. Missing core nodes: ${missingNodes.join(', ')}.` })
      return
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
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        setNotice({ tone: 'success', text: `${options.preset === 'quality' ? 'Two-stage quality' : 'Single-stage Turbo'} LTX‑2.5 generation added to ComfyUI.` })
        if (!handoff) setCharacterHandoff(null)
      }
    } catch (error) {
      const cancelled = cancellationRequests.current.has(localId)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : error instanceof Error ? error.message : String(error) } : item))
      setNotice(cancelled ? { tone: 'success', text: 'LTX generation cancelled.' } : { tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      cancellationRequests.current.delete(localId)
      setLtxSubmitting(false)
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
    const activeBindings = clothingPolicy === 'wardrobe' ? workspaceBindings : workspaceBindings.filter((binding) => binding.purpose !== 'wardrobe')
    const hasLibrarySelection = workspaceBindings.length > 0
    const renderReferenceImages = hasLibrarySelection ? activeBindings.map((binding) => referenceImages.find((file) => file.path === binding.file.path) ?? binding.file) : referenceImages
    const referenceDirection = composeReferenceInstructions(activeBindings).join(' ')
    const missingReferenceDirection = referenceDirection && !prompt.includes(referenceDirection) ? referenceDirection : ''
    const policyDirection = clothingPolicy === 'wardrobe'
      ? missingReferenceDirection
      : clothingPolicy === 'underwear'
        ? `${missingReferenceDirection} Clothing intent: keep only the underwear shown in each named adult character's own identity reference; do not add outer garments and ignore supplied wardrobe outfits.`
        : `${missingReferenceDirection} Clothing intent: adult fictional characters only; follow the scene prompt's explicit clothing or nudity direction. Clothing visible in identity references is not mandatory and must not override the scene prompt.`
    const effectivePrompt = applyDialoguePolicy([prompt.trim(), mode === 'reference' && hasLibrarySelection ? policyDirection.trim() : ''].filter(Boolean).join(' '), noDialogue)
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
        <div className="titlebar-brand"><span className="brand-mark"><Film size={16} /></span><span>MiniMax Studio</span></div>
        <div className="titlebar-drag" />
        <GpuMeter value={gpu} />
        {view === 'create' && <button className="titlebar-action" onClick={resetWorkspace} title="Clear the prompt, loaded media, and current output"><RotateCcw size={14} />Reset workspace</button>}
        <button className="titlebar-action" onClick={() => { setLanOpen(true); void window.minimax.getLanStatus().then(setLanStatus) }} title="Share MiniMax Studio over your local network"><QrCode size={14} />LAN</button>
        <button className={`connection-chip ${status.connected ? 'online' : ''}`} onClick={() => void checkConnection(settings.comfyUrl)} title="Check ComfyUI connection">
          {checking ? <LoaderCircle size={14} className="spin" /> : <span className="status-dot" />}
          {status.connected ? `Local engine · ${status.latencyMs} ms` : 'Engine offline'}
        </button>
      </header>

      <aside className="sidebar">
        <div className="sidebar-top">
          <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)} aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}><PanelLeftClose size={18} /></button>
        </div>
        <nav aria-label="Primary navigation">
          <div className="nav-group"><span className="nav-section-label">Generate</span>
            <NavButton active={view === 'create'} icon={WandSparkles} label="Create" onClick={() => { setCharacterHandoff(null); setView('create') }} />
            <NavButton active={view === 'ltx25'} icon={Aperture} label="LTX 2.5" onClick={() => setView('ltx25')} />
          </div>
          <div className="nav-group"><span className="nav-section-label">Plan</span>
            <NavButton active={view === 'zimage'} icon={ImageIcon} label="Create Image" onClick={() => setView('zimage')} />
            <NavButton active={view === 'characters'} icon={Users} label="Characters" itemType="character" onClick={() => setView('characters')} />
            <NavButton active={view === 'wardrobes'} icon={Shirt} label="Wardrobe" itemType="wardrobe" onClick={() => setView('wardrobes')} />
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
          <CreateView
            info={info}
            sampler={sampler} setSampler={setSampler} scheduler={scheduler} setScheduler={setScheduler}
            experimentalSampling={experimentalSampling} setExperimentalSampling={setExperimentalSampling}
            refImageSize={refImageSize} setRefImageSize={setRefImageSize}
            noDialogue={noDialogue} setNoDialogue={setNoDialogue}
            clothingPolicy={clothingPolicy} setClothingPolicy={setClothingPolicy}
            sigmaShiftMode={sigmaShiftMode} setSigmaShiftMode={setSigmaShiftMode}
            shiftVideo={shiftVideo} setShiftVideo={setShiftVideo} shiftAudio={shiftAudio} setShiftAudio={setShiftAudio}
            loraStrength={loraStrength} setLoraStrength={setLoraStrength}
            liveEnabled={liveEnabled} setLiveEnabled={setLiveEnabled} liveConnected={live.connected} livePreview={live.preview}
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
            ollamaAvailable={ollamaModels.length > 0}
            ollamaModel={settings.ollamaModel}
            promptSuggestion={promptSuggestion}
            promptingTool={promptingTool}
            onPromptTool={(tool) => void runPromptTool(tool)}
            onUseSuggestion={() => { setPrompt(promptSuggestion); setPromptSuggestion('') }}
            onDismissSuggestion={() => setPromptSuggestion('')}
          />
        </div>
        {view === 'ltx25' && <Ltx25Workspace
          settings={settings}
          models={ltxSelection}
          pipelineReady={LTX_NATIVE_REQUIRED_NODES.every((node) => Boolean(info[node]))}
          missingNodes={LTX_NATIVE_REQUIRED_NODES.filter((node) => !info[node])}
          connected={status.connected}
          liveConnected={live.connected}
          livePreview={live.preview}
          latestJob={jobs.find((job) => job.provider === 'ltx25')}
          submitting={ltxSubmitting}
          cancelling={Boolean(jobs.find((job) => job.provider === 'ltx25' && ['queued', 'running'].includes(job.status)) && cancellingIds.has(jobs.find((job) => job.provider === 'ltx25' && ['queued', 'running'].includes(job.status))!.id))}
          ollamaAvailable={ollamaModels.length > 0}
          onChooseImage={chooseLtxImage}
          onGenerate={(options, file) => void generateLtx(options, file)}
          onCancel={(job) => void cancelJob(job)}
        />}
        <div hidden={view !== 'zimage'}><ZImageWorkspace key="first-frame" url={settings.comfyUrl} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} ollamaUrl={settings.ollamaUrl} ollamaModel={settings.ollamaModel} outputDirectory={settings.outputDirectory} onUse={(file, frameResolution) => {
          setFirstFrame(file); setResolution(frameResolution); setMode('image'); setActiveJobId(null); setView('create'); setNotice({ tone: 'success', text: 'Z-Image frame loaded into the MiniMax I2V workspace.' })
        }} /></div>
        {view === 'characters' && <CharacterStudio settings={settings} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} automationJob={jobs.find((job) => job.characterProjectId)} onNotice={(tone, text) => setNotice({ tone, text })} onCreateTurntable={(project) => {
          if (!project.baseImage) return
          const firstFrame = fitWholeCharacter({ ...project.baseImage }); delete firstFrame.preview
          void generateLtx({ mode: 'image', prompt: `Character identity turntable reference video of ${project.name}. The character remains completely still in a neutral full-body pose while the camera performs one smooth complete 360-degree orbit at constant speed. Even neutral studio lighting, plain background, stable face and body proportions, no cuts, no pose changes, no expression changes, no clothing changes, no added objects, no text, no dialogue.`, width: 768, height: 768, duration: 6, preset: 'quality', seed: Math.floor(Math.random() * 1_000_000_000), filenamePrefix: 'MiniMax_character_turntable' }, firstFrame, { characterProjectId: project.id })
        }} />}
        {view === 'wardrobes' && <WardrobeStudio settings={settings} info={info} connected={status.connected} onNotice={(tone, text) => setNotice({ tone, text })} />}
        {view === 'locations' && <LocationStudio settings={settings} info={info} connected={status.connected} automationJob={jobs.find((job) => job.locationProjectId)} onNotice={(tone, text) => setNotice({ tone, text })} onCreateWalkthrough={(project: LocationProject) => {
          if (!project.baseImage) return
          const firstFrame = { ...project.baseImage }; delete firstFrame.preview
          void generateLtx({ mode: 'image', prompt: `Comprehensive cinematic location walkthrough reference video of ${project.name}. Begin with a wide establishing view, then move slowly along the perimeter in one continuous stabilized path. Deliberately pan through every corner and each wall in sequence, revealing entrances, windows, floor, ceiling, furniture, fixtures, landmarks, and the spatial relationship between them. Use a wide-angle lens and smooth measured turns so no corner remains hidden. Preserve exactly the same architecture, room dimensions, object placement, materials, lighting, weather, and geography from the first frame. No cuts, no teleporting, no layout changes, no duplicated objects, no people as focal subjects, no dialogue, no text, no logos.`, width: 1344, height: 768, duration: 10, preset: 'quality', seed: Math.floor(Math.random() * 1_000_000_000), filenamePrefix: 'MiniMax_location_walkthrough' }, firstFrame, { locationProjectId: project.id })
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
        {view === 'library' && <LibraryView jobs={jobs.filter((job) => job.status === 'completed')} onEdit={() => setView('editor')} />}
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
      {lanOpen && <LanCompanionDialog status={lanStatus} qr={lanQr} onRotate={async () => setLanStatus(await window.minimax.rotateLanToken())} onClose={() => setLanOpen(false)} />}
      {videoClipDraft && <VideoReferenceClipper source={videoClipDraft.source} onClose={() => setVideoClipDraft(null)} onCreate={createVideoReferenceClip} />}
    </div>
  )
}

function LanCompanionDialog({ status, qr, onRotate, onClose }: { status: LanStatus; qr: string; onRotate(): Promise<void>; onClose(): void }) {
  const [rotating, setRotating] = useState(false)
  return <div className="lan-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="lan-dialog" role="dialog" aria-modal="true" aria-labelledby="lan-dialog-title">
      <header><div><QrCode size={20} /><span><strong id="lan-dialog-title">Share over your LAN</strong><small>Touch-first mobile creation or the complete Studio interface</small></span></div><button className="icon-button" onClick={onClose} aria-label="Close LAN sharing"><X size={18} /></button></header>
      {status.running && status.url ? <div className="lan-dialog-body">
        <div className="lan-qr">{qr ? <img src={qr} alt="QR code for the MiniMax mobile companion" /> : <LoaderCircle className="spin" aria-label="Preparing QR code" />}</div>
        <div className="lan-instructions"><span className="lan-ready"><Check size={15} />LAN server ready</span><h2>Open on another device</h2><p>Scan for the touch-first mobile workspace, or open the full interface on a tablet or computer connected to the same trusted Wi-Fi or LAN.</p><label>Mobile address<input readOnly value={status.url} onFocus={(event) => event.currentTarget.select()} /></label><label>Full Studio address<input readOnly value={status.desktopUrl ?? status.url.replace('?mobile=1', '?desktop=1')} onFocus={(event) => event.currentTarget.select()} /></label><small>The full Studio view shares the interface and browser-local project state. Hardware generation and local-file access remain protected by the authenticated LAN services. Windows Firewall may ask to allow private-network access the first time.</small></div>
      </div> : <div className="lan-dialog-error"><AlertCircle size={22} /><span><strong>Mobile server unavailable</strong><p>{status.error ?? 'Restart MiniMax Studio, then try again.'}</p></span></div>}
      <footer><button className="secondary-button" disabled={rotating || !status.running} title="Invalidate previously scanned mobile links" onClick={async () => { if (!window.confirm('Rotate the mobile access link? Previously scanned links will stop working.')) return; setRotating(true); try { await onRotate() } finally { setRotating(false) } }}><RotateCcw size={14} />{rotating ? 'Rotating…' : 'Rotate access link'}</button><button className="primary-button" onClick={onClose}>Done</button></footer>
    </section>
  </div>
}

function GpuMeter({ value }: { value: GpuTelemetry | null }) {
  const usage = value?.usagePercent
  const vram = value?.vramPercent
  const available = Boolean(value?.available && usage !== undefined && vram !== undefined)
  const title = available ? `${value?.name ?? 'GPU'} · ${usage}% utilization · ${vram}% VRAM (${value?.vramUsedMb ?? 0} / ${value?.vramTotalMb ?? 0} MB)` : 'GPU telemetry unavailable'
  return <div className={`gpu-meter ${available ? 'available' : ''}`} title={title} aria-label={title}><Gauge size={14} /><span><small>GPU</small><strong>{available ? `${usage}%` : '—'}</strong></span><i aria-hidden="true"><b style={{ width: `${available ? usage : 0}%` }} /></i><span><small>VRAM</small><strong>{available ? `${vram}%` : '—'}</strong></span></div>
}

function NavButton({ active, icon: Icon, label, count, itemType, onClick }: { active: boolean; icon: typeof Film; label: string; count?: number; itemType?: 'character' | 'wardrobe' | 'location'; onClick(): void }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} data-item-type={itemType} aria-label={label} onClick={onClick}><Icon size={19} /><span>{label}</span>{count ? <em>{count}</em> : null}</button>
}

function Notice({ tone, text, onClose }: { tone: 'error' | 'success' | 'neutral'; text: string; onClose(): void }) {
  return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{tone === 'error' ? <AlertCircle size={17} /> : tone === 'success' ? <Check size={17} /> : <Activity size={17} />}<span>{text}</span><button onClick={onClose} aria-label="Dismiss"><X size={16} /></button></div>
}

type CreateViewProps = {
  info: ObjectInfo
  sampler: string; setSampler(value: string): void; scheduler: string; setScheduler(value: string): void
  experimentalSampling: boolean; setExperimentalSampling(value: boolean): void
  refImageSize: 'match' | 'max'; setRefImageSize(value: 'match' | 'max'): void
  sigmaShiftMode: 'model' | 'custom'; setSigmaShiftMode(value: 'model' | 'custom'): void
  shiftVideo: number; setShiftVideo(value: number): void; shiftAudio: number; setShiftAudio(value: number): void
  loraStrength: number; setLoraStrength(value: number): void
  liveEnabled: boolean; setLiveEnabled(value: boolean): void; liveConnected: boolean; livePreview: { promptId: string; url: string } | null
  upscaleMode: UpscaleMode; setUpscaleMode(value: UpscaleMode): void; ltxAvailable: boolean; ltxMissingNodes: readonly string[]
  noDialogue: boolean; setNoDialogue(value: boolean): void
  clothingPolicy: 'wardrobe' | 'underwear' | 'unrestricted'; setClothingPolicy(value: 'wardrobe' | 'underwear' | 'unrestricted'): void
  rtxModels: string[]; rtxModel: string; setRtxModel(value: string): void
  updateReference(index: number, file: MediaFile): void
  mode: GenerationMode; setMode(value: GenerationMode): void
  prompt: string; setPrompt(value: string): void
  duration: number; setDuration(value: number): void
  resolution: string; setResolution(value: string): void
  turbo: 'off' | '4' | '8'; setTurbo(value: 'off' | '4' | '8'): void
  steps: number; setSteps(value: number): void
  seed: number; setSeed(value: number): void
  advanced: boolean; setAdvanced(value: boolean): void
  firstFrame: MediaFile | null; lastFrame: MediaFile | null
  setFirstFrame(value: MediaFile | null): void; setLastFrame(value: MediaFile | null): void
  chooseMedia(kind: MediaKind, setter: (file: MediaFile) => void): Promise<void>
  referenceImages: MediaFile[]; referenceVideos: MediaFile[]; referenceAudios: MediaFile[]
  characters: CharacterProject[]; wardrobes: WardrobeProject[]; locations: LocationProject[]; selectedCharacterIds: string[]; selectedLocationIds: string[]; loadCharacter(characterId: string): void; loadWardrobe(wardrobeId: string): void; loadLocation(locationId: string): void
  removeReference(kind: MediaKind, index: number): void
  chooseReference(kind: MediaKind): Promise<void>
  editVideoReference(index: number): void
  h3Validated: boolean
  modelReady: boolean; selection: ModelSelection; submitting: boolean; cancelling: boolean; connected: boolean
  ollamaAvailable: boolean; ollamaModel: string; promptSuggestion: string
  promptingTool: 'enhance' | 'timeline' | 'audio' | null
  onPromptTool(tool: 'enhance' | 'timeline' | 'audio'): void
  onUseSuggestion(): void; onDismissSuggestion(): void
  onGenerate(): void; onCancel(job: GenerationJob): void; latestJob?: GenerationJob
}

function CreateView(props: CreateViewProps) {
  const {
    info, sampler, setSampler, scheduler, setScheduler, experimentalSampling, setExperimentalSampling, refImageSize, setRefImageSize,
    sigmaShiftMode, setSigmaShiftMode, shiftVideo, setShiftVideo, shiftAudio, setShiftAudio, loraStrength, setLoraStrength, liveEnabled, setLiveEnabled, liveConnected, livePreview,
    upscaleMode, setUpscaleMode, ltxAvailable, ltxMissingNodes, noDialogue, setNoDialogue, clothingPolicy, setClothingPolicy, rtxModels, rtxModel, setRtxModel, updateReference,
    mode, setMode, prompt, setPrompt, duration, setDuration, resolution, setResolution, turbo, setTurbo, steps, setSteps,
    seed, setSeed, advanced, setAdvanced, firstFrame, lastFrame, setFirstFrame, setLastFrame, chooseMedia,
    referenceImages, referenceVideos, referenceAudios, characters, wardrobes, locations, selectedCharacterIds, selectedLocationIds, loadCharacter, loadWardrobe, loadLocation, removeReference, chooseReference, editVideoReference, h3Validated, modelReady, selection,
    submitting, cancelling, connected, ollamaAvailable, ollamaModel, promptSuggestion, promptingTool,
    onPromptTool, onUseSuggestion, onDismissSuggestion, onGenerate, onCancel, latestJob,
  } = props
  const promptRef = useRef<SmartPromptEditorHandle>(null)
  const sourceMediaTriggerRef = useRef<HTMLButtonElement>(null)
  const sourceMediaCloseRef = useRef<HTMLButtonElement>(null)
  const [sourceMediaOpen, setSourceMediaOpen] = useState(false)
  const selectedCharacters = selectedCharacterIds.map((id) => characters.find((character) => character.id === id)).filter(Boolean) as CharacterProject[]
  const selectedLocations = selectedLocationIds.map((id) => locations.find((location) => location.id === id)).filter(Boolean) as LocationProject[]
  const selectedWardrobes = [...new Set(selectedCharacters.flatMap((character) => character.wardrobeIds.slice(0, 1)))].map((id) => wardrobes.find((wardrobe) => wardrobe.id === id)).filter(Boolean) as WardrobeProject[]
  const selectedBindings = allocateWorkspaceReferences(selectedCharacters.map((character) => ({ id: character.id, name: character.name, identity: characterReferences(character), wardrobeIds: character.wardrobeIds })), wardrobes, selectedLocations.map((location) => ({ id: location.id, name: location.name, images: locationReferences(location) })))
  const sourceMediaCount = referenceImages.length + referenceVideos.length + referenceAudios.length
  const closeSourceMedia = useCallback(() => {
    setSourceMediaOpen(false)
    window.requestAnimationFrame(() => sourceMediaTriggerRef.current?.focus())
  }, [])
  const keepSourceMediaFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  useEffect(() => {
    if (!sourceMediaOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSourceMedia()
    }
    window.addEventListener('keydown', closeOnEscape)
    window.requestAnimationFrame(() => sourceMediaCloseRef.current?.focus())
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeSourceMedia, sourceMediaOpen])
  useEffect(() => {
    if (mode !== 'reference' && sourceMediaOpen) setSourceMediaOpen(false)
  }, [mode, sourceMediaOpen])
  const insertPromptText = (text: string) => promptRef.current?.insert(text)
  const smartCharacterOptions = characters.filter((character) => characterReferences(character).length > 0).map((character) => {
    const projected = selectedCharacterIds.includes(character.id) ? selectedCharacters : [...selectedCharacters, character]
    const projectedBindings = allocateWorkspaceReferences(projected.map((item) => ({ id: item.id, name: item.name, identity: characterReferences(item), wardrobeIds: item.wardrobeIds })), wardrobes, selectedLocations.map((location) => ({ id: location.id, name: location.name, images: locationReferences(location) })))
    const wardrobeCount = projectedBindings.filter((binding) => binding.characterId === character.id && binding.purpose === 'wardrobe').length
    return { id: `character.${character.id}`, category: 'character' as const, label: character.name, description: wardrobeCount ? `${character.description || 'Character Studio identity'} · wardrobe isolated` : character.description || 'Character Studio identity', insertion: `Character: ${character.name}.`, thumbnail: characterReferences(character)[0]?.preview, meta: `${projectedBindings.filter((binding) => binding.characterId === character.id).length} allocated refs`, onSelect: (nextPrompt: string) => { setPrompt(nextPrompt); loadCharacter(character.id) } }
  })
  const smartWardrobeOptions = wardrobes.filter((wardrobe) => wardrobeReferences(wardrobe).length > 0).map((wardrobe) => { const files = wardrobeReferences(wardrobe).slice(0, 9); const tags = files.map((_, index) => `<Picture ${index + 1}>`).join(', ').replace(/, ([^,]+)$/, ' and $1'); return { id: `wardrobe.${wardrobe.id}`, category: 'wardrobe' as const, label: wardrobe.name, description: wardrobe.description || 'Approved Wardrobe Studio outfit', insertion: `Wardrobe: apply the approved ${wardrobe.name} outfit from ${tags}; preserve its garments, materials, colors, fit, and accessories.`, thumbnail: files[0]?.preview, meta: `${files.length} approved`, onSelect: (nextPrompt: string) => { setPrompt(nextPrompt); loadWardrobe(wardrobe.id) } } })
  const smartLocationOptions = locations.filter((location) => locationReferences(location).length > 0).map((location) => { const files = locationReferences(location); const projected = selectedLocationIds.includes(location.id) ? selectedLocations : [...selectedLocations, location]; const projectedBindings = allocateWorkspaceReferences(selectedCharacters.map((character) => ({ id: character.id, name: character.name, identity: characterReferences(character), wardrobeIds: character.wardrobeIds })), wardrobes, projected.map((item) => ({ id: item.id, name: item.name, images: locationReferences(item) }))); return { id: `location.${location.id}`, category: 'location' as const, label: location.name, description: location.description || 'Approved Location Studio environment', insertion: `Location: ${location.name}.`, thumbnail: files[0]?.preview, meta: `${projectedBindings.filter((binding) => binding.locationId === location.id).length} allocated view${projectedBindings.filter((binding) => binding.locationId === location.id).length === 1 ? '' : 's'}`, onSelect: (nextPrompt: string) => { setPrompt(nextPrompt); loadLocation(location.id) } } })
  const applyCreatePreset = (preset: 'quality' | 'turbo' | 'preview') => {
    const [width, height] = resolution.split('x').map(Number)
    const portrait = height > width
    const square = height === width
    const base = preset === 'preview' ? square ? '640x640' : portrait ? '480x864' : '864x480' : square ? '768x768' : portrait ? '768x1344' : '1344x768'
    setResolution(base)
    setTurbo(preset === 'quality' ? 'off' : '8')
    setSteps(20); setSampler('res_multistep'); setScheduler('simple'); setExperimentalSampling(false)
    setSigmaShiftMode('model'); setShiftVideo(12); setShiftAudio(3); setLoraStrength(1); setUpscaleMode('off')
  }
  return (
    <div className="create-page">
      <div className="page-heading">
        <div><p className="eyebrow">LOCAL VIDEO WORKSPACE</p><h1>Create with MiniMax H3</h1><p>Generate synchronized video and audio through your local ComfyUI engine.</p></div>
        <div className="heading-state"><span className={modelReady && h3Validated ? 'ok' : 'warn'}>{modelReady && h3Validated ? <Check size={15} /> : <AlertCircle size={15} />}{!modelReady ? 'Check model paths' : h3Validated ? 'Validated H3 stack' : 'Custom H3 stack'}</span></div>
      </div>

      <div className="workspace-grid">
        <section className="composer-panel">
          <div className="mode-tabs" role="tablist" aria-label="Generation mode">
            {modeInfo.map((item) => <button key={item.id} role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'selected' : ''} onClick={() => { setMode(item.id); if (item.id === 'reference' && turbo === '8') setTurbo('off') }}><item.icon size={18} /><span><strong>{item.label}</strong><small>{item.note}</small></span></button>)}
          </div>

          <section className="create-section create-direction-section">
            <div className="create-section-heading"><span><WandSparkles size={15} /></span><div><strong>Shot direction</strong><small>Describe the subject, action, camera, lighting, and sound.</small></div><em className={prompt.trim() ? 'complete' : ''}>{prompt.trim() ? 'Ready' : 'Required'}</em></div>
          <div className="field-group prompt-field">
            {mode === 'reference' && (selectedCharacters.length > 0 || selectedWardrobes.length > 0 || selectedLocations.length > 0) && <SelectedReferenceStrip characters={selectedCharacters} wardrobes={selectedWardrobes} locations={selectedLocations} />}
            <div className="field-label"><label htmlFor="prompt">Prompt</label><span>{prompt.length.toLocaleString()} characters</span></div>
            <SmartPromptEditor ref={promptRef} id="prompt" value={prompt} onChange={setPrompt} options={[...smartCharacterOptions, ...smartWardrobeOptions, ...smartLocationOptions]} placeholder={mode === 'reference' ? 'Describe the scene and references. Type // for production presets…' : 'Describe the shot, subject, movement, camera, lighting, and audio…'} />
            <label className="no-dialogue-toggle" title="Adds a render instruction that blocks spoken words, narration, singing, lip-sync, captions, and text overlays."><input type="checkbox" checked={noDialogue} onChange={(event) => setNoDialogue(event.target.checked)} /><span><strong>No dialogue</strong><small>{noDialogue ? 'Ambient sound only' : 'Dialogue and lip-sync allowed'}</small></span></label>
            {mode === 'reference' && <ReferencePromptHelper pictureCount={referenceImages.length} videoCount={referenceVideos.length} audioCount={referenceAudios.length} referenceInstructions={composeReferenceInstructions(selectedBindings)} onInsert={insertPromptText} />}
            <div className="prompt-tools" aria-label="Local Ollama prompt tools">
              <div className="prompt-tool-buttons">
                <button type="button" onClick={() => onPromptTool('enhance')} disabled={!ollamaAvailable || Boolean(promptingTool)} title="Rewrite the prompt for stronger MiniMax video direction">
                  {promptingTool === 'enhance' ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}Enhance
                </button>
                <button type="button" onClick={() => onPromptTool('timeline')} disabled={!ollamaAvailable || Boolean(promptingTool)} title="Add a concise sequence of timed shots">
                  {promptingTool === 'timeline' ? <LoaderCircle size={14} className="spin" /> : <Clock3 size={14} />}Shot timeline
                </button>
                <button type="button" onClick={() => onPromptTool('audio')} disabled={!ollamaAvailable || Boolean(promptingTool)} title="Improve ambience, dialogue, and sound cues">
                  {promptingTool === 'audio' ? <LoaderCircle size={14} className="spin" /> : <Volume2 size={14} />}Audio pass
                </button>
              </div>
              <span className={`local-model-chip ${ollamaAvailable ? 'online' : ''}`} title={ollamaAvailable ? `Local Ollama model: ${ollamaModel}` : 'Configure Ollama in Settings'}>
                <span />{ollamaAvailable ? ollamaModel : 'Ollama offline'}
              </span>
            </div>
            {promptSuggestion && (
              <div className="assistant-result" role="status">
                <div className="assistant-result-heading"><span><Sparkles size={14} />Local suggestion</span><small>Review before replacing your prompt</small></div>
                <textarea aria-label="Ollama prompt suggestion" value={promptSuggestion} readOnly />
                <div className="assistant-actions"><button type="button" className="secondary-button" onClick={onDismissSuggestion}>Dismiss</button><button type="button" className="primary-button" onClick={onUseSuggestion}><Check size={14} />Use suggestion</button></div>
              </div>
            )}
          </div>
          </section>

          {(mode === 'image' || mode === 'frames' || mode === 'reference') && <section className={`create-section create-input-section ${mode === 'reference' ? 'source-media-section' : ''}`}>
            <div className="create-section-heading"><span><ImageIcon size={15} /></span><div><strong>Source media</strong><small>{mode === 'reference' ? 'Choose reusable identity, motion, and audio references.' : mode === 'frames' ? 'Set the opening and closing composition.' : 'Choose the frame this shot begins from.'}</small></div><em className={(mode === 'reference' ? referenceImages.length + referenceVideos.length + referenceAudios.length > 0 : firstFrame && (mode !== 'frames' || lastFrame)) ? 'complete' : ''}>{mode === 'reference' ? `${referenceImages.length + referenceVideos.length + referenceAudios.length} loaded` : mode === 'frames' ? `${Number(Boolean(firstFrame)) + Number(Boolean(lastFrame))} of 2` : firstFrame ? 'Ready' : 'Required'}</em></div>
          {(mode === 'image' || mode === 'frames') && (
            <div className={`frame-grid ${mode === 'image' ? 'single' : ''}`}>
              <div><MediaDrop label="First frame" note="PNG, JPG or WebP" file={firstFrame} onChoose={() => void chooseMedia('image', (file) => setFirstFrame(file))} onRemove={() => setFirstFrame(null)} />{firstFrame && <ImageCrop label="First frame" file={firstFrame} resolution={resolution} onChange={setFirstFrame} />}</div>
              {mode === 'frames' && <div><MediaDrop label="Last frame" note="Automatically fitted to output size" file={lastFrame} onChoose={() => void chooseMedia('image', (file) => setLastFrame(file))} onRemove={() => setLastFrame(null)} />{lastFrame && <ImageCrop label="Last frame" file={lastFrame} resolution={resolution} onChange={setLastFrame} />}</div>}
            </div>
          )}
          {mode === 'reference' && (
            <div className="source-media-summary">
              <div className="source-media-overview" aria-label="Selected source media summary">
                <SourceMediaStat icon={Users} label="Cast" value={selectedCharacterIds.length ? `${selectedCharacterIds.length} selected` : 'None'} />
                <SourceMediaStat icon={MapPin} label="Locations" value={selectedLocationIds.length ? `${selectedLocationIds.length} selected` : 'None'} />
                <SourceMediaStat icon={ImageIcon} label="Pictures" value={`${referenceImages.length} of 9`} />
                <SourceMediaStat icon={Film} label="Video + audio" value={`${referenceVideos.length} + ${referenceAudios.length}`} />
              </div>
              <div className="source-media-summary-footer">
                <span><strong>{clothingPolicy === 'wardrobe' ? 'Assigned wardrobe' : clothingPolicy === 'underwear' ? 'Underwear' : 'Unrestricted'}</strong><small>{refImageSize === 'max' ? 'Maximum identity' : 'Balanced fidelity'}</small></span>
                <button ref={sourceMediaTriggerRef} type="button" className="primary-button source-media-manage" onClick={() => setSourceMediaOpen(true)}><SlidersHorizontal size={15} />Manage source media</button>
              </div>
            </div>
          )}
          </section>}

          {sourceMediaOpen && mode === 'reference' && (
            <div className="modal-backdrop source-media-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSourceMedia() }}>
              <section className="source-media-modal" role="dialog" aria-modal="true" aria-labelledby="source-media-modal-title" aria-describedby="source-media-modal-description" onKeyDown={keepSourceMediaFocus}>
                <header>
                  <div><span><ImageIcon size={18} /></span><div><small>REFERENCE WORKSPACE</small><strong id="source-media-modal-title">Source media</strong><p id="source-media-modal-description">Build the cast, locations, look, motion, and sound for this render.</p></div></div>
                  <div className="source-media-header-actions"><em>{sourceMediaCount} loaded</em><button ref={sourceMediaCloseRef} type="button" aria-label="Close source media" onClick={closeSourceMedia}><X size={18} /></button></div>
                </header>
                <div className="source-media-modal-body">
                  <section className="source-media-modal-section"><div className="source-media-section-title"><span>01</span><div><strong>Libraries</strong><small>Select reusable people and environments. Their approved pictures share the 9-picture budget.</small></div></div><div className="reference-groups source-media-library-groups"><CharacterReferencePicker characters={characters} values={selectedCharacterIds} onChange={loadCharacter} /><LocationReferencePicker locations={locations} values={selectedLocationIds} onChange={loadLocation} /></div></section>
                  <section className="source-media-modal-section"><div className="source-media-section-title"><span>02</span><div><strong>Reference behavior</strong><small>Decide how clothing and source-image detail should influence the render.</small></div></div><div className="reference-groups source-media-policy-groups"><fieldset className="reference-fidelity clothing-policy"><legend><Shirt size={15} /><span><strong>Clothing intent</strong><small>Controls whether identity-photo clothing or assigned wardrobe is authoritative.</small></span></legend><div><label className={clothingPolicy === 'wardrobe' ? 'selected' : ''}><input type="radio" name="clothing-policy" checked={clothingPolicy === 'wardrobe'} onChange={() => setClothingPolicy('wardrobe')} /><span><strong>Assigned wardrobe</strong><small>Wardrobe Studio images exclusively control clothing. Identity-photo clothes are discarded.</small></span></label><label className={clothingPolicy === 'underwear' ? 'selected' : ''}><input type="radio" name="clothing-policy" checked={clothingPolicy === 'underwear'} onChange={() => setClothingPolicy('underwear')} /><span><strong>Underwear</strong><small>Use each adult character's own identity reference without assigned outerwear.</small></span></label><label className={clothingPolicy === 'unrestricted' ? 'selected' : ''}><input type="radio" name="clothing-policy" checked={clothingPolicy === 'unrestricted'} onChange={() => setClothingPolicy('unrestricted')} /><span><strong>Unrestricted</strong><small>Follow explicit adult fictional clothing or nudity direction in the scene prompt.</small></span></label></div></fieldset><fieldset className="reference-fidelity"><legend><Gauge size={15} /><span><strong>Reference fidelity</strong><small>Choose how much source-image detail H3 preserves.</small></span></legend><div><label className={refImageSize === 'match' ? 'selected' : ''}><input type="radio" name="reference-fidelity" checked={refImageSize === 'match'} onChange={() => setRefImageSize('match')} /><span><strong>Balanced</strong><small>Fit references to the output canvas. Faster and uses less memory.</small></span></label><label className={refImageSize === 'max' ? 'selected' : ''}><input type="radio" name="reference-fidelity" checked={refImageSize === 'max'} onChange={() => setRefImageSize('max')} /><span><strong>Maximum identity</strong><small>Keep more original image detail. Slower and uses more memory.</small></span></label></div></fieldset></div></section>
                  <section className="source-media-modal-section"><div className="source-media-section-title"><span>03</span><div><strong>Files and crops</strong><small>Add standalone pictures, motion references, and audio cues.</small></div></div><div className="reference-groups source-media-file-groups"><ReferenceRow icon={ImageIcon} label="Pictures" limit="Up to 9" kind="image" files={referenceImages} onAdd={() => void chooseReference('image')} onRemove={(index) => removeReference('image', index)} />{referenceImages.length > 0 && <div className="reference-crops">{referenceImages.map((file, i) => <details key={`${file.path}-${i}`}><summary>Picture {i + 1} · crop to output</summary><ImageCrop label={`Picture ${i + 1}`} file={file} resolution={resolution} onChange={(next) => updateReference(i, next)} /></details>)}</div>}<ReferenceRow icon={Film} label="Videos" limit="Up to 3 · trim longer sources to 2–15 seconds" kind="video" files={referenceVideos} onAdd={() => void chooseReference('video')} onEdit={editVideoReference} onRemove={(index) => removeReference('video', index)} /><ReferenceRow icon={Volume2} label="Audio" limit="Up to 3" kind="audio" files={referenceAudios} onAdd={() => void chooseReference('audio')} onRemove={(index) => removeReference('audio', index)} /></div></section>
                </div>
                <footer><span>{sourceMediaCount ? `${sourceMediaCount} file${sourceMediaCount === 1 ? '' : 's'} ready for this render` : 'No standalone files added yet'}</span><button type="button" className="primary-button" onClick={closeSourceMedia}><Check size={15} />Done</button></footer>
              </section>
            </div>
          )}

        </section>

        <aside className="preview-panel">
          <div className="panel-heading"><div><span>OUTPUT</span><strong>Current workspace</strong></div>{latestJob && <StatusBadge status={latestJob.status} />}</div>
          {liveEnabled && livePreview?.promptId === latestJob?.promptId && latestJob && ['running', 'queued'].includes(latestJob.status) && <figure className="live-preview"><img src={livePreview?.url} alt="Live generation preview" /><figcaption>Live preview · intermediate frame</figcaption></figure>}
          <div className="preview-stage">
            {latestJob?.outputUrl ? <VideoPlayer src={latestJob.outputUrl} /> : latestJob && ['queued', 'running'].includes(latestJob.status) ? <div className="render-state constructing"><RenderConstruction /><strong>{latestJob.progressLabel ?? (latestJob.status === 'queued' ? 'Waiting in queue' : 'Rendering locally')}</strong><span>{latestJob.currentStep !== undefined && latestJob.totalSteps ? `Live sampler step ${latestJob.currentStep} of ${latestJob.totalSteps}` : `${latestJob.width} × ${latestJob.height} · ${latestJob.duration}s`}</span><div className="progress"><i style={{ width: `${latestJob.progress}%` }} /></div><small>{Math.round(latestJob.progress)}% · live ComfyUI status</small></div> : <div className="empty-preview"><div className="preview-icon"><Film size={28} /></div><strong>Your video will appear here</strong><span>Configure a shot, then send it to the local engine.</span></div>}
          </div>
          <div className="pipeline-summary">
            <PipelineItem ready={Boolean(mode === 'reference' ? selection.ref2va : selection.fl2va)} label="Diffusion" value={mode === 'reference' ? selection.ref2va : selection.fl2va} />
            <PipelineItem ready={Boolean(selection.textEncoder)} label="Encoder" value={selection.textEncoder} />
            <PipelineItem ready={Boolean(selection.videoVae && selection.audioVae)} label="Video + audio VAE" value={selection.videoVae && selection.audioVae ? 'Both detected' : 'Missing component'} />
          </div>
          <section className="create-section create-output-section preview-output-settings">
            <div className="create-section-heading"><span><Gauge size={15} /></span><div><strong>Output and quality</strong><small>Tune the next render directly beneath its preview.</small></div><em className="complete">{resolution.replace('x', ' × ')} · {duration}s</em></div>
            {mode !== 'reference' && <div className="create-presets" aria-label="Recommended H3 presets"><button type="button" onClick={() => applyCreatePreset('quality')}><strong>Native Quality</strong><small>1344 × 768 · 20 steps</small></button><button type="button" onClick={() => applyCreatePreset('turbo')}><strong>Turbo 8</strong><small>Native canvas · official LoRA</small></button><button type="button" onClick={() => applyCreatePreset('preview')}><strong>Preview</strong><small>864 × 480 · Turbo 8</small></button></div>}
            <RenderSize value={resolution} onChange={setResolution} />
            <div className="render-controls"><div className="field-group"><label htmlFor="duration">Duration</label><div className="range-line"><input id="duration" type="range" min="2" max="15" step="0.5" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><output>{duration}s</output></div></div><SelectField label="Sampling quality" value={turbo === '4' && mode !== 'reference' ? '8' : turbo} onChange={(value) => { if (mode !== 'reference') applyCreatePreset(value === 'off' ? 'quality' : 'turbo'); else { setTurbo(value as 'off' | '4'); setSampler('res_multistep'); setScheduler('simple'); setExperimentalSampling(false); setSigmaShiftMode('model'); setShiftVideo(12); setShiftAudio(3); setLoraStrength(1); setUpscaleMode('off'); if (value === 'off') { const [rw, rh] = resolution.split('x').map(Number); setResolution(rw === rh ? '768x768' : rw > rh ? '1344x768' : '768x1344') } } }} options={mode === 'reference' ? [["off", 'Native quality · 20 steps'], ["4", 'Official 4-step Ref2V']] : [["off", 'Native quality · 20 steps'], ["8", 'Official Turbo 8']]} /></div>
            <div className="render-extras"><label><input type="checkbox" checked={liveEnabled} onChange={(event) => setLiveEnabled(event.target.checked)} />Live preview <small>{liveEnabled ? liveConnected ? 'Connected · waiting for preview frames' : 'Connecting to ComfyUI…' : 'Off'}</small></label><p className="field-help">Always shows a standard first-frame preview. Start ComfyUI with <code>--preview-method auto</code> for additional previews while sampling.</p><div className="upscale-options" role="group" aria-labelledby="upscale-label"><span id="upscale-label">Post-render upscale</span><label><input type="radio" name="upscale" checked={upscaleMode === 'off'} onChange={() => setUpscaleMode('off')} />Off</label><label><input type="radio" name="upscale" checked={upscaleMode === 'ltx'} disabled={!ltxAvailable} onChange={() => setUpscaleMode('ltx')} />LTX 2.5 latent · 2×</label><label><input type="radio" name="upscale" checked={upscaleMode === 'rtx'} disabled={rtxModels.length === 0} onChange={() => setUpscaleMode('rtx')} />RTX / CUDA frames · 2× · experimental</label></div>{upscaleMode === 'rtx' && <SelectField label="AI upscale model" value={rtxModel} onChange={setRtxModel} options={rtxModels.map((name) => [name, name])} />}<p className={`field-help ${upscaleMode === 'rtx' ? 'upscale-warning' : ''}`}>{upscaleMode === 'ltx' ? `Verified latent pipeline: MiniMax frames are encoded with the LTX‑2.5 video VAE, spatially upsampled exactly 2× in latent space, decoded, trimmed to the original duration, and joined to the untouched MiniMax audio. Final size: ${resolution.split('x').map((value) => Number(value) * 2).join(' × ')}.` : upscaleMode === 'rtx' ? `Experimental frame-by-frame upscale using ${rtxModel || 'the selected model'}. It does not understand motion and can amplify noise, flicker, or temporal shimmer. Diagnose output quality with upscale Off first.` : !ltxAvailable && ltxMissingNodes.length ? `LTX 2× is unavailable until ComfyUI provides: ${ltxMissingNodes.join(', ')}.` : !ltxAvailable && rtxModels.length === 0 ? 'No compatible upscale models were reported by ComfyUI.' : 'The original MiniMax video is saved without post-processing.'}</p></div>
            <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><SlidersHorizontal size={16} />Advanced controls<ChevronDown size={15} className={advanced ? 'rotated' : ''} /></button>
            {advanced && <div className="advanced-grid"><NumberField label="Full-quality steps" value={steps} min={16} max={30} onChange={setSteps} disabled={turbo !== 'off'} /><NumberField label="Seed" value={seed} min={0} max={999999999999} onChange={setSeed} /><NumberField label="LoRA strength" value={loraStrength} min={0} max={2} step={0.05} onChange={setLoraStrength} disabled={turbo === 'off'} /><label className="sampling-opt-in"><input type="checkbox" checked={experimentalSampling} onChange={(event) => setExperimentalSampling(event.target.checked)} />Use custom sampler and scheduler</label><SelectField label="Experimental Turbo override" value={turbo} onChange={(value) => setTurbo(value as 'off' | '4' | '8')} options={[["off", 'Off · native quality'], ["8", 'Official 8-step'], ["4", '4-step · preview testing']]} /><SelectField label="Sampler" value={experimentalSampling ? sampler : 'res_multistep'} onChange={setSampler} disabled={!experimentalSampling} options={[...new Set([sampler, 'res_multistep', ...choices(info, 'KSamplerSelect', 'sampler_name')])].map((value) => [value, value])} /><SelectField label="Scheduler" value={experimentalSampling ? scheduler : 'simple'} onChange={setScheduler} disabled={!experimentalSampling} options={[...new Set([scheduler, 'simple', ...choices(info, 'BasicScheduler', 'scheduler')])].map((value) => [value, value])} /><SelectField label="Sigma shifts" value={sigmaShiftMode} onChange={(value) => setSigmaShiftMode(value as 'model' | 'custom')} options={[["model", 'Model defaults · video 12 / audio 3'], ["custom", 'Custom official sigma-shift node']]} /><NumberField label="Video sigma shift" value={shiftVideo} min={0.01} max={100} step={0.01} onChange={setShiftVideo} disabled={sigmaShiftMode !== 'custom'} /><NumberField label="Audio sigma shift" value={shiftAudio} min={0.01} max={100} step={0.01} onChange={setShiftAudio} disabled={sigmaShiftMode !== 'custom'} /><p className="field-help">The published ComfyUI workflow uses <strong>res_multistep + simple</strong>, CFG 1, denoise 1, 24 fps, and the model’s native 12/3 shifts. Custom sampling—including Euler + Beta for converted Turbo LoRAs—is experimental and should be tested against the same seed.</p></div>}
            <p className="field-help render-duration">{frameCount(duration)} frames · {(frameCount(duration) / 24).toFixed(2)}s actual duration at 24 fps. Rounded up to MiniMax’s frame grid.</p>
          </section>
          <div className="generate-bar preview-generate-bar"><div className="generation-summary"><Gauge size={17} /><span><strong>{resolution.replace('x', ' × ')}</strong><small>{duration}s · 24 fps · {turbo === 'off' ? `${steps} steps` : `${turbo}-step turbo`}</small></span></div><div className="generate-actions">{latestJob && ['queued', 'running'].includes(latestJob.status) && <button className="danger-button" onClick={() => onCancel(latestJob)} disabled={cancelling}><CircleStop size={16} />{cancelling ? 'Stopping…' : 'Cancel generation'}</button>}<button className="primary-button generation-button" onClick={onGenerate} disabled={submitting || !connected || !modelReady}>{submitting ? <LoaderCircle size={18} className="spin" /> : <Play size={18} fill="currentColor" />}{submitting ? 'Submitting…' : 'Generate video'}</button></div></div>
        </aside>
      </div>
    </div>
  )
}

function SourceMediaStat({ icon: Icon, label, value }: { icon: typeof Film; label: string; value: string }) {
  return <span className="source-media-stat"><Icon size={15} /><span><small>{label}</small><strong>{value}</strong></span></span>
}

function SelectedReferenceStrip({ characters, wardrobes, locations }: { characters: CharacterProject[]; wardrobes: WardrobeProject[]; locations: LocationProject[] }) {
  const items = [
    ...characters.map((character) => ({ id: `character-${character.id}`, label: character.name, type: 'Character', preview: characterReferences(character)[0]?.preview, icon: Users })),
    ...wardrobes.map((wardrobe) => ({ id: `wardrobe-${wardrobe.id}`, label: wardrobe.name, type: 'Wardrobe', preview: wardrobeReferences(wardrobe)[0]?.preview, icon: Shirt })),
    ...locations.map((location) => ({ id: `location-${location.id}`, label: location.name, type: 'Location', preview: locationReferences(location)[0]?.preview, icon: MapPin })),
  ]
  return <div className="selected-reference-strip" aria-label="References used in this render"><div><strong>Used in this render</strong><small>Visual identity, wardrobe, and location anchors</small></div><div>{items.map((item) => <figure key={item.id}>{item.preview ? <img src={item.preview} alt="" /> : <span><item.icon size={16} /></span>}<figcaption><small>{item.type}</small><strong title={item.label}>{item.label}</strong></figcaption></figure>)}</div></div>
}

function VideoPlayer({ src }: { src: string }) {
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => setFailure(''), [src])

  if (failure) {
    return <div className="playback-error" role="alert"><AlertCircle size={25} /><strong>Video could not be decoded</strong><span>{failure}</span><button className="secondary-button" onClick={() => { setFailure(''); setAttempt((value) => value + 1) }}><RefreshCw size={15} />Retry playback</button></div>
  }

  return <video key={`${src}-${attempt}`} src={src} controls autoPlay loop playsInline preload="auto" onCanPlay={(event) => void event.currentTarget.play().catch(() => undefined)} onError={(event) => { const mediaError = event.currentTarget.error; setFailure(mediaError?.message || `Electron media error ${mediaError?.code ?? 'unknown'}`) }} />
}

function MediaDrop({ label, note, file, onChoose, onRemove }: { label: string; note: string; file: MediaFile | null; onChoose(): void; onRemove(): void }) {
  return <div className={`media-drop ${file ? 'has-file' : ''}`}>{file?.preview ? <img src={file.preview} alt="" /> : null}<div className="media-drop-content"><span className="upload-icon"><Upload size={19} /></span><strong>{file?.name ?? label}</strong><small>{file ? 'Ready to use' : note}</small><button onClick={onChoose}>{file ? 'Replace' : 'Choose image'}</button></div>{file && <button className="remove-media" onClick={onRemove} aria-label={`Remove ${label}`}><X size={15} /></button>}</div>
}

function ReferenceRow({ icon: Icon, label, limit, kind, files, onAdd, onEdit, onRemove }: { icon: typeof Film; label: string; limit: string; kind: MediaKind; files: MediaFile[]; onAdd(): void; onEdit?(index: number): void; onRemove(index: number): void }) {
  return <div className="reference-row"><div className="reference-title"><span><Icon size={17} /></span><div><strong>{label}</strong><small>{limit}</small></div></div><div className="reference-files">{files.map((file, index) => <div className="file-pill" key={`${file.path}-${index}`}>{file.preview && kind === 'image' ? <img src={file.preview} alt="" /> : <Icon size={15} />}<span><strong>{kind === 'image' ? `Picture ${index + 1}` : kind === 'video' ? `Video ${index + 1}` : `Audio ${index + 1}`}</strong><small>{file.clip ? `${(file.clip.end - file.clip.start).toFixed(1)}s · ${file.name}` : file.name}</small></span>{onEdit && <button onClick={() => onEdit(index)} aria-label={`Edit clip ${file.name}`} title="Change reference clip"><Scissors size={13} /></button>}<button onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`}><X size={14} /></button></div>)}<button className="add-reference" onClick={onAdd} disabled={files.length >= (kind === 'image' ? 9 : 3)}><Plus size={16} />Add {kind}</button></div></div>
}

function CharacterReferencePicker({ characters, values, onChange }: { characters: CharacterProject[]; values: string[]; onChange(value: string): void }) {
  return <fieldset className="character-reference-picker multi-character-picker"><legend>Characters in this render</legend><div><span><Users size={17} /></span><span><strong>Character library</strong><small>Select several people. Identity and wardrobe references are allocated fairly within the 9-picture limit.</small></span></div><div className="character-reference-choices">{characters.map((character) => { const count = characterReferences(character).length; const selected = values.includes(character.id); return <label className={selected ? 'selected' : ''} key={character.id}><input type="checkbox" checked={selected} disabled={!count} onChange={() => onChange(character.id)} /><span><strong>{character.name}</strong><small>{count ? `${count} identity image${count === 1 ? '' : 's'}${character.wardrobeIds.length ? ' · wardrobe assigned' : ''}` : 'No approved identity images'}</small></span></label> })}</div>{values.length > 0 && <button type="button" className="secondary-button" onClick={() => onChange('')}>Clear cast</button>}</fieldset>
}

function LocationReferencePicker({ locations, values, onChange }: { locations: LocationProject[]; values: string[]; onChange(value: string): void }) {
  if (!locations.length) return null
  return <fieldset className="character-reference-picker multi-character-picker location-reference-picker"><legend>Locations in this render</legend><div><span><MapPin size={17} /></span><span><strong>Location library</strong><small>Add environments alongside the cast. All selected assets share the 9-picture limit.</small></span></div><div className="character-reference-choices">{locations.map((location) => { const count = locationReferences(location).length; const selected = values.includes(location.id); return <label className={selected ? 'selected' : ''} key={location.id}><input type="checkbox" checked={selected} disabled={!count} onChange={() => onChange(location.id)} /><span><strong>{location.name}</strong><small>{count ? `${count} approved view${count === 1 ? '' : 's'}` : 'No approved location views'}</small></span></label> })}</div>{values.length > 0 && <button type="button" className="secondary-button" onClick={() => onChange('')}>Clear locations</button>}</fieldset>
}

function ReferencePromptHelper({ pictureCount, videoCount, audioCount, referenceInstructions, onInsert }: { pictureCount: number; videoCount: number; audioCount: number; referenceInstructions: string[]; onInsert(value: string): void }) {
  const pictureTags = Array.from({ length: pictureCount }, (_, index) => `<Picture ${index + 1}>`)
  const identityText = referenceInstructions.join(' ')
  const directionSections = [
    ['Scene', 'Scene: '],
    ['Action', 'Action: '],
    ['Camera', 'Camera: '],
    ['Lighting', 'Lighting: '],
    ['Sound', 'Sound: '],
    ['Continuity', 'Continuity: '],
  ] as const
  const starter = [
    identityText,
    'Scene: ',
    'Action: ',
    'Camera: ',
    'Lighting: ',
    'Sound: ',
    referenceInstructions.length ? 'Continuity: Keep each named person distinct. Never exchange faces, bodies, garments, colors, or accessories between characters.' : '',
  ].filter(Boolean).join('\n')
  return <div className="reference-prompt-helper" aria-label="Reference prompt helpers"><div><strong>Quick-build prompt</strong><small>Insert media tags or production sections at the cursor.</small></div><div className="reference-tag-actions">{pictureTags.map((tag) => <button type="button" key={tag} onClick={() => onInsert(tag)}>{tag}</button>)}{Array.from({ length: videoCount }, (_, index) => <button type="button" key={`video-${index}`} onClick={() => onInsert(`<Video ${index + 1}>`)}>{`<Video ${index + 1}>`}</button>)}{Array.from({ length: audioCount }, (_, index) => <button type="button" key={`audio-${index}`} onClick={() => onInsert(`<Audio ${index + 1}>`)}>{`<Audio ${index + 1}>`}</button>)}{identityText && <button className="reference-identity-insert" type="button" onClick={() => onInsert(identityText)}>Cast + wardrobe rules</button>}</div><div className="reference-tag-actions reference-direction-actions">{directionSections.map(([label, value]) => <button type="button" key={label} onClick={() => onInsert(value)}>{label}</button>)}<button className="reference-template-insert" type="button" onClick={() => onInsert(starter)}>Insert full template</button></div>{pictureTags.length === 0 && videoCount === 0 && audioCount === 0 && <small className="reference-tag-empty">Load a picture, video, or audio reference to create matching tags.</small>}</div>
}

function SelectField({ label, value, options, onChange, disabled }: { label: string; value: string; options: string[][]; onChange(value: string): void; disabled?: boolean }) {
  const id = useId()
  return <div className="field-group"><label htmlFor={id}>{label}</label><div className="select-wrap"><select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option value={optionValue} key={optionValue}>{text}</option>)}</select><ChevronDown size={15} /></div></div>
}

function NumberField({ label, value, min, max, step, onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void; disabled?: boolean }) {
  return <div className="field-group"><label>{label}</label><input className="number-input" type="number" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></div>
}

function PipelineItem({ ready, label, value }: { ready: boolean; label: string; value: string }) {
  return <div className="pipeline-item"><span className={ready ? 'ready' : ''}>{ready ? <Check size={13} /> : <AlertCircle size={13} />}</span><div><strong>{label}</strong><small title={value}>{value || 'Not detected'}</small></div></div>
}

function StatusBadge({ status }: { status: GenerationJob['status'] }) {
  return <span className={`status-badge ${status}`}>{status === 'running' && <LoaderCircle size={12} className="spin" />}{status}</span>
}

function LibraryView({ jobs, onEdit }: { jobs: GenerationJob[]; onEdit(): void }) {
  return <div className="standard-page"><div className="page-heading"><div><p className="eyebrow">LOCAL LIBRARY</p><h1>Video library</h1><p>Completed videos from this workstation.</p></div><button className="primary-button" onClick={onEdit}><Scissors size={16} />Open clip editor</button></div>{jobs.length === 0 ? <div className="empty-page"><History size={28} /><strong>Completed generations will appear here.</strong><span>New work is saved automatically on this device.</span></div> : <div className="library-grid">{jobs.map((job) => <article className="library-card" key={job.id}><video src={job.outputUrl} controls preload="metadata" /><div><StatusBadge status={job.status} /><strong>{shortPrompt(job.prompt)}</strong><small>{job.width} × {job.height} · {job.duration}s · {job.mode}</small><a className="secondary-button" href={job.outputUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open video</a></div></article>)}</div>}</div>
}

function JobsView({ title, note, jobs, empty, cancellingIds, onCancel }: { title: string; note: string; jobs: GenerationJob[]; empty: string; cancellingIds: Set<string>; onCancel(job: GenerationJob): Promise<void> }) {
  return <div className="standard-page"><div className="page-heading"><div><p className="eyebrow">LOCAL WORKSPACE</p><h1>{title}</h1><p>{note}</p></div></div>{jobs.length === 0 ? <div className="empty-page"><History size={28} /><strong>{empty}</strong><span>New work is saved automatically on this device.</span></div> : <div className="job-list">{jobs.map((job) => <article className={`job-row ${['running', 'queued'].includes(job.status) ? 'constructing' : ''}`} key={job.id}><div className="job-thumbnail">{job.outputUrl ? <video src={job.outputUrl} muted /> : job.status === 'running' ? <LoaderCircle className="spin" /> : <Film />}</div><div className="job-copy"><div><StatusBadge status={job.status} /><span>{new Date(job.createdAt).toLocaleString()}</span></div><strong>{shortPrompt(job.prompt)}</strong><small>{job.width} × {job.height} · {job.duration}s · {job.mode}</small>{['running', 'queued'].includes(job.status) && <><small className="job-progress-label">{job.progressLabel ?? (job.status === 'queued' ? 'Waiting in queue' : 'Rendering locally')}{job.currentStep !== undefined && job.totalSteps ? ` · ${job.currentStep}/${job.totalSteps}` : ''}</small><div className="progress compact"><i style={{ width: `${job.progress}%` }} /></div></>}{job.error && <p className="job-error">{job.error}</p>}</div><div className="job-actions">{job.outputUrl && <a className="secondary-button" href={job.outputUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open</a>}{['running', 'queued'].includes(job.status) && <button className="danger-button" disabled={cancellingIds.has(job.id)} onClick={() => void onCancel(job)}>{cancellingIds.has(job.id) ? <LoaderCircle size={15} className="spin" /> : <CircleStop size={15} />}{cancellingIds.has(job.id) ? 'Stopping…' : 'Stop'}</button>}</div></article>)}</div>}</div>
}

function SettingsView({ settings, setSettings, info, models, h3Report, scanning, status, checking, diagnosticRunning, ollamaModels, onRefreshOllama, onScan, onCheck, onSave, onApplyDefaults, onRunDiagnostics }: { settings: AppSettings; setSettings(value: AppSettings): void; info: ObjectInfo; models: ModelFile[]; h3Report: ReturnType<typeof h3StackReport>; scanning: boolean; status: ComfyStatus; checking: boolean; diagnosticRunning: boolean; ollamaModels: OllamaModel[]; onRefreshOllama(): void; onScan(): void; onCheck(): void; onSave(): void; onApplyDefaults(): void; onRunDiagnostics(): void }) {
  const pathRows: Array<{ kind: ModelKind; label: string; note: string }> = [
    { kind: 'diffusion_models', label: 'Diffusion models', note: 'FL2VA and Ref2VA checkpoints' },
    { kind: 'text_encoders', label: 'Text encoders', note: 'Qwen3-VL MiniMax encoder' },
    { kind: 'vae', label: 'VAE models', note: 'Video and audio decoders' },
    { kind: 'loras', label: 'LoRAs', note: '4-step and 8-step turbo adapters' },
    { kind: 'vae_approx', label: 'Preview models', note: 'Tiny H3 preview decoder' },
    { kind: 'clip_vision', label: 'Vision encoders', note: 'Optional reference encoders' },
  ]
  const defaults = settings.generationDefaults
  const updateDefaults = (patch: Partial<AppSettings['generationDefaults']>) => setSettings({ ...settings, generationDefaults: { ...defaults, ...patch } })
  const applyPreset = (preset: 'quality' | 'official-turbo' | 'preview') => {
    const common = { resolution: '1344x768', duration: 5, steps: 20, loraStrength: 1, shiftVideo: 12, upscaleMode: 'off' as const }
    if (preset === 'quality') updateDefaults({ ...common, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
    else if (preset === 'official-turbo') updateDefaults({ ...common, turbo: '8', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
    else updateDefaults({ ...common, resolution: '864x480', turbo: '8', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
  }
  const samplerOptions = [...new Set([defaults.sampler, 'res_multistep', 'euler', 'gradient_estimation', 'ipndm', 'deis', 'heun', ...choices(info, 'KSamplerSelect', 'sampler_name')])]
  const schedulerOptions = [...new Set([defaults.scheduler, 'simple', 'beta', 'normal', ...choices(info, 'BasicScheduler', 'scheduler')])]
  const warnedSampler = ['euler_ancestral', 'lcm', 'dpmpp_3m_sde'].includes(defaults.sampler)
  return <div className="standard-page settings-page"><div className="page-heading"><div><p className="eyebrow">APPLICATION</p><h1>Settings</h1><p>Point the studio at your existing local engine and model folders.</p></div><button className="primary-button" onClick={onSave}><Save size={17} />Save settings</button></div>
    <section className="settings-section"><div className="settings-heading"><div><Activity size={19} /><span><strong>ComfyUI engine</strong><small>The desktop app communicates only with this local address.</small></span></div><span className={`health-pill ${status.connected ? 'online' : ''}`}>{status.connected ? 'Connected' : 'Offline'}</span></div><div className="connection-row"><div className="field-group grow"><label htmlFor="comfy-url">Server URL</label><input id="comfy-url" value={settings.comfyUrl} onChange={(event) => setSettings({ ...settings, comfyUrl: event.target.value })} /></div><button className="secondary-button test-button" onClick={onCheck} disabled={checking}>{checking ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Test connection</button></div>{status.connected && status.stats?.devices?.[0] && <div className="device-strip"><Gauge size={17} /><span><strong>{status.stats.devices[0].name ?? 'Compute device'}</strong><small>{status.stats.devices[0].vram_total ? `${formatBytes(status.stats.devices[0].vram_total)} VRAM · ${formatBytes(status.stats.devices[0].vram_free ?? 0)} free` : 'ComfyUI device detected'}</small></span></div>}</section>
    <section className="settings-section h3-stack-section">
      <div className="settings-heading"><div><Gauge size={19} /><span><strong>H3 engine stack</strong><small>Compares the selected files with the validated official ComfyUI stack.</small></span></div><span className={`health-pill ${h3Report.validated ? 'online' : ''}`}>{h3Report.validated ? 'Validated' : h3Report.ready ? 'Custom' : 'Incomplete'}</span></div>
      <div className="h3-stack-list">{h3Report.rows.map((row) => <div key={row.label} className={row.validated ? 'validated' : 'custom'}><span>{row.validated ? <Check size={14} /> : <AlertCircle size={14} />}</span><div><strong>{row.label}</strong><small title={row.selected || row.expected}>{row.selected || `Missing · expected ${row.expected}`}</small></div><em>{row.validated ? 'Recommended' : row.selected ? 'Non-standard' : 'Missing'}</em></div>)}</div>
      {!h3Report.validated && <p className="settings-warning"><AlertCircle size={15} />Some components differ from the validated H3 stack. Generation remains available, but output quality may differ.</p>}
      <div className="diagnostic-action"><span><strong>Fixed quality comparison</strong><small>Queues Native Quality and Turbo 8 at 1344 × 768, 5 seconds, seed 12345, with no upscale.</small></span><button className="secondary-button" disabled={!status.connected || diagnosticRunning || !h3Report.ready} onClick={onRunDiagnostics}>{diagnosticRunning ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}{diagnosticRunning ? 'Queuing tests…' : 'Run H3 Quality Test'}</button></div>
    </section>
    <section className="settings-section generation-defaults-section">
      <div className="settings-heading"><div><SlidersHorizontal size={19} /><span><strong>Generation defaults</strong><small>Choose the starting values for the main Create workspace.</small></span></div><button className="secondary-button" onClick={onApplyDefaults}>Apply to Create</button></div>
      <div className="preset-row" aria-label="Generation presets">
        <button type="button" onClick={() => applyPreset('quality')}><strong>Native Quality</strong><small>1344 × 768 · 20 steps · no upscale</small></button>
        <button type="button" onClick={() => applyPreset('official-turbo')}><strong>Turbo 8</strong><small>Native canvas · official LoRA 1.0</small></button>
        <button type="button" onClick={() => applyPreset('preview')}><strong>Preview</strong><small>864 × 480 · official Turbo 8</small></button>
      </div>
      <div className="generation-defaults-grid">
        <SelectField label="Default resolution" value={defaults.resolution} onChange={(resolution) => updateDefaults({ resolution })} options={['608x352', '864x480', '1056x608', '1344x768', '768x1344', '768x768'].map((value) => [value, value.replace('x', ' × ')])} />
        <NumberField label="Default duration (seconds)" value={defaults.duration} min={2} max={15} step={0.5} onChange={(duration) => updateDefaults({ duration })} />
        <SelectField label="Default quality" value={defaults.turbo === '4' ? '8' : defaults.turbo} onChange={(turbo) => updateDefaults({ turbo: turbo as 'off' | '8' })} options={[["off", 'Native quality · 20 steps'], ["8", 'Official Turbo 8']]} />
        <NumberField label="Full-quality steps" value={defaults.steps} min={16} max={30} onChange={(steps) => updateDefaults({ steps })} />
        <SelectField label="Reference image fidelity" value={defaults.refImageSize} onChange={(refImageSize) => updateDefaults({ refImageSize: refImageSize as 'match' | 'max' })} options={[["match", 'Match output · faster'], ["max", 'Maximum identity · slower']]} />
        <SelectField label="Default post-render upscale" value={defaults.upscaleMode} onChange={(upscaleMode) => updateDefaults({ upscaleMode: upscaleMode as UpscaleMode })} options={[["off", 'Off · recommended for diagnosis'], ["ltx", 'LTX 2.5 latent · 2×'], ["rtx", 'RTX/CUDA frames · 2× · experimental']]} />
        <label className="settings-check"><input type="checkbox" checked={defaults.livePreview} onChange={(event) => updateDefaults({ livePreview: event.target.checked })} /><span><strong>Live preview by default</strong><small>Uses ComfyUI progress and preview events.</small></span></label>
      </div>
      <details className="experimental-settings"><summary><AlertCircle size={15} /><span><strong>Experimental sampling</strong><small>Custom samplers, shifts, LoRA strength, and 4-step FL2V can make output less stable.</small></span><ChevronDown size={15} /></summary><div className="generation-defaults-grid"><label className="settings-check"><input type="checkbox" checked={defaults.experimentalSampling} onChange={(event) => updateDefaults({ experimentalSampling: event.target.checked })} /><span><strong>Enable custom sampler</strong><small>Otherwise res_multistep + simple is forced.</small></span></label><SelectField label="Experimental Turbo override" value={defaults.turbo} onChange={(turbo) => updateDefaults({ turbo: turbo as 'off' | '4' | '8' })} options={[["off", 'Off'], ["8", 'Official 8-step'], ["4", '4-step preview testing']]} /><NumberField label="Turbo LoRA strength" value={defaults.loraStrength} min={0} max={2} step={0.05} onChange={(loraStrength) => updateDefaults({ loraStrength })} /><SelectField label="Sampler" value={defaults.experimentalSampling ? defaults.sampler : 'res_multistep'} disabled={!defaults.experimentalSampling} onChange={(sampler) => updateDefaults({ sampler })} options={samplerOptions.map((value) => [value, value])} /><SelectField label="Scheduler" value={defaults.experimentalSampling ? defaults.scheduler : 'simple'} disabled={!defaults.experimentalSampling} onChange={(scheduler) => updateDefaults({ scheduler })} options={schedulerOptions.map((value) => [value, value])} /><SelectField label="Sigma shifts" value={defaults.sigmaShiftMode} onChange={(sigmaShiftMode) => updateDefaults({ sigmaShiftMode: sigmaShiftMode as 'model' | 'custom' })} options={[["model", 'Native model defaults · 12 / 3'], ["custom", 'Custom MiniMaxH3SigmaShift node']]} /><NumberField label="Video sigma shift" value={defaults.shiftVideo} min={0.01} max={100} step={0.01} disabled={defaults.sigmaShiftMode !== 'custom'} onChange={(shiftVideo) => updateDefaults({ shiftVideo })} /><NumberField label="Audio sigma shift" value={defaults.shiftAudio} min={0.01} max={100} step={0.01} disabled={defaults.sigmaShiftMode !== 'custom'} onChange={(shiftAudio) => updateDefaults({ shiftAudio })} /></div></details>
      {warnedSampler && <p className="settings-warning"><AlertCircle size={15} />This sampler is on the compatibility-risk list you supplied. Test a short clip before committing to a final render.</p>}
      <p className="settings-note">The production path is 1344 × 768, 20 steps, res_multistep + simple, CFG 1, denoise 1, 24 fps, native 12/3 shifts, and upscale off. Custom sampling is intentionally separated because it complicates quality diagnosis.</p>
    </section>
    <section className="settings-section ollama-section">
      <div className="settings-heading">
        <div><Sparkles size={19} /><span><strong>Ollama prompt assistant</strong><small>Uses only text models installed on this computer.</small></span></div>
        <span className={`health-pill ${ollamaModels.length > 0 ? 'online' : ''}`}>{ollamaModels.length > 0 ? `${ollamaModels.length} local` : 'Offline'}</span>
      </div>
      <div className="ollama-grid">
        <div className="field-group"><label htmlFor="ollama-url">Ollama URL</label><input id="ollama-url" value={settings.ollamaUrl} onChange={(event) => setSettings({ ...settings, ollamaUrl: event.target.value })} /></div>
        <div className="field-group"><label htmlFor="ollama-model">Local model</label><div className="select-wrap"><select id="ollama-model" value={settings.ollamaModel} onChange={(event) => setSettings({ ...settings, ollamaModel: event.target.value })} disabled={ollamaModels.length === 0}>{ollamaModels.length === 0 ? <option value="">No local text models detected</option> : ollamaModels.map((model) => <option value={model.name} key={model.name}>{model.name}{model.parameterSize ? ` · ${model.parameterSize}` : ''}</option>)}</select><ChevronDown size={15} /></div></div>
        <button className="secondary-button test-button" onClick={onRefreshOllama}><RefreshCw size={16} />Refresh models</button>
      </div>
      <p className="settings-note">Prompts go directly to the local Ollama server. Embedding and cloud-backed models are excluded.</p>
    </section>
    <section className="settings-section"><div className="settings-heading"><div><HardDrive size={19} /><span><strong>Model locations</strong><small>Files are indexed in place and are never moved or copied.</small></span></div><button className="secondary-button" onClick={onScan} disabled={scanning}>{scanning ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{scanning ? 'Scanning…' : 'Rescan'}</button></div><div className="path-table">{pathRows.map((row) => { const count = models.filter((model) => model.kind === row.kind).length; return <div className="path-row" key={row.kind}><div className="path-kind"><Folder size={17} /><span><strong>{row.label}</strong><small>{row.note}</small></span></div><div className="path-input"><input value={settings.paths[row.kind]} onChange={(event) => setSettings({ ...settings, paths: { ...settings.paths, [row.kind]: event.target.value } })} /><button onClick={async () => { const path = await window.minimax.chooseDirectory(settings.paths[row.kind]); if (path) setSettings({ ...settings, paths: { ...settings.paths, [row.kind]: path } }) }} aria-label={`Browse for ${row.label}`}><FolderOpen size={17} /></button></div><span className="file-count">{count} files</span></div>})}</div></section>
    <section className="settings-section"><div className="settings-heading"><div><FolderOpen size={19} /><span><strong>Output & clip tools</strong><small>Completed videos, extracted frames, and editor exports stay local.</small></span></div></div><div className="connection-row"><div className="field-group grow"><label htmlFor="output-path">Output directory</label><input id="output-path" value={settings.outputDirectory} onChange={(event) => setSettings({ ...settings, outputDirectory: event.target.value })} /></div><button className="secondary-button test-button" onClick={async () => { const path = await window.minimax.chooseDirectory(settings.outputDirectory); if (path) setSettings({ ...settings, outputDirectory: path }) }}><FolderOpen size={16} />Browse</button></div><div className="connection-row clip-tool-path"><div className="field-group grow"><label htmlFor="ffmpeg-path">FFmpeg executable</label><input id="ffmpeg-path" value={settings.ffmpegPath} onChange={(event) => setSettings({ ...settings, ffmpegPath: event.target.value })} /></div></div><p className="settings-note">The clip editor uses FFmpeg for frame extraction, trim points, joining, and full-project export.</p></section>
  </div>
}

export default App
