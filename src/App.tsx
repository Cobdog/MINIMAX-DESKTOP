import { useCallback, useEffect, useMemo, useState } from 'react'
import { createId } from './lib/createId'
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
import { buildMiniMaxWorkflow, outputFileFromUrl } from './lib/workflow'
import { STORAGE_ERROR_EVENT } from './lib/libraryStorage'
import { buildLtx25Workflow } from './lib/ltx25Workflow'
import { ACE_STEP_REQUIRED_NODES, buildAceStepWorkflow, inferAceStepSelections } from './lib/aceStepWorkflow'
import { fitWholeCharacter, prepareImage } from './lib/imageCrop'
import { inferLtx25Selections, inferSelections } from './lib/modelSelection'
import { choices } from './lib/comfyInfo'
import { useLivePreview } from './lib/useLivePreview'
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
import { useStudioSession } from './hooks/useStudioSession'
import { useGenerationQueue } from './hooks/useGenerationQueue'
import { useCreateWorkspace, type VideoClipDraft } from './hooks/useCreateWorkspace'
import { buildPromptAssistantRequest } from './lib/promptComposer'
import { buildCharacterDialogueRequest } from './lib/dialogPolicy'
import { diagnosticPrompt, findH3PreviewOverrideNode, h3StackReport } from './lib/h3Stack'
import { composeH3Prompt, resolveRenderReferenceImages } from './lib/promptPolicies'
import type {
  AceStepGenerationOptions,
  GenerationJob,
  Ltx25GenerationOptions,
  LocationProject,
  MediaFile,
  MovieProject,
  ResolvedMovieShot,
  MovieShot,
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
  const [view, setView] = useState<View>('create')
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 680)
  const [videoClipDraft, setVideoClipDraft] = useState<VideoClipDraft | null>(null)
  const [ltxResetKey, setLtxResetKey] = useState(0)
  const [zImageResetKey, setZImageResetKey] = useState(0)
  const [ltxResetAt, setLtxResetAt] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [ltxSubmitting, setLtxSubmitting] = useState(false)
  const [aceSubmitting, setAceSubmitting] = useState(false)
  const [diagnosticRunning, setDiagnosticRunning] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'neutral'; text: string } | null>(null)
  const [promptSuggestion, setPromptSuggestion] = useState('')
  const [promptingTool, setPromptingTool] = useState<'enhance' | 'timeline' | 'audio' | null>(null)
  const [dialogueGenerating, setDialogueGenerating] = useState(false)

  const notify = useCallback((tone: 'error' | 'success' | 'neutral', text: string) => setNotice({ tone, text }), [])

  // Session: settings, models, engine status, Ollama, GPU telemetry.
  const session = useStudioSession()
  const { settings, models, status, checking, gpu, info, ollamaModels, scanModels, checkConnection, refreshOllama } = session

  // Job queue: persistence, ComfyUI polling, deadline sweep, cancellation.
  const queue = useGenerationQueue({ settings, connected: status.connected, notify })
  const { jobs, setJobs, cancellingIds, setCancellingIds, cancellationRequests, cancelJob, onLiveProgress } = queue

  // Keep the lightweight ComfyUI event socket active even when image previews
  // are hidden so queue, node, and sampler-step progress remain real-time.
  const live = useLivePreview(settings?.comfyUrl, true, onLiveProgress)

  const h3PreviewOverrideNode = findH3PreviewOverrideNode(info)
  const upscaleModel = choices(info, 'LatentUpscaleModelLoader', 'model_name').find((n) => /ltx-2\.5.*spatial.*x2/i.test(n)) ?? ''
  const upscaleVae = choices(info, 'VAELoader', 'vae_name').find((n) => /ltx-2\.5.*video.*vae/i.test(n)) ?? ''
  const missingLtxUpscaleNodes = LTX_UPSCALE_REQUIRED_NODES.filter((node) => !info[node])
  const ltxUpscaleReady = Boolean(upscaleModel && upscaleVae && missingLtxUpscaleNodes.length === 0)
  const rtxModels = choices(info, 'UpscaleModelLoader', 'model_name')

  // Create workspace: every composed field, libraries, and reference binding.
  const ws = useCreateWorkspace({ settings, rtxModels, notify, setVideoClipDraft })
  const {
    mode, setMode, prompt, setPrompt, duration, resolution, turbo, steps, sampler, scheduler,
    experimentalSampling, refImageSize, noDialogue, naturalMovement, clothingPolicy,
    sigmaShiftMode, shiftVideo, shiftAudio, loraStrength, liveEnabled, setLiveEnabled,
    livePreviewMode, setLivePreviewMode, upscaleMode, rtxModel, seed, advanced, setAdvanced,
    firstFrame, setFirstFrame, lastFrame, setLastFrame,
    referenceImages, setReferenceImages, referenceVideos, setReferenceVideos, referenceAudios, setReferenceAudios,
    characterProjects, wardrobeProjects, locationProjects,
    selectedReferenceCharacterIds, setSelectedReferenceCharacterIds,
    selectedReferenceLocationIds, setSelectedReferenceLocationIds,
    activeJobId, setActiveJobId, movieHandoff, setMovieHandoff, characterHandoff, setCharacterHandoff,
    createResetKey, resetCreateWorkspace: resetWorkspaceFields,
    chooseMedia, chooseMany, editVideoReference, refreshSourceMedia,
    workspaceBindingsFor, loadReferenceCharacter, loadReferenceLocation, loadReferenceWardrobe,
  } = ws

  const selection = useMemo(() => inferSelections(models, turbo), [models, turbo])
  const h3Report = useMemo(() => h3StackReport(models), [models])
  const ltxSelection = useMemo(() => inferLtx25Selections(models, choices(info, 'LatentUpscaleModelLoader', 'model_name')), [models, info])
  const aceSelection = useMemo(() => inferAceStepSelections(models), [models])
  const activeModel = mode === 'reference' ? selection.ref2va : selection.fl2va
  const activeLora = mode === 'reference' ? selection.ref2vLora : selection.fl2vLora
  const requiredModels = [activeModel, selection.textEncoder, selection.videoVae, selection.audioVae]
  const modelReady = requiredModels.every(Boolean) && (turbo === 'off' || Boolean(activeLora))
  const pendingJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running')

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.tone === 'error' ? 6500 : 4500)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const onStorageError = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; message: string }>).detail
      setNotice({ tone: 'error', text: `A library could not be saved (${detail.key}): ${detail.message}` })
    }
    window.addEventListener(STORAGE_ERROR_EVENT, onStorageError)
    return () => window.removeEventListener(STORAGE_ERROR_EVENT, onStorageError)
  }, [])

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
      notify('success', `${position === 'last' ? 'The final frame' : `The frame at ${position.toFixed(1)}s`} is loaded as the exact starting point for the next video. The first clip remains unchanged.`)
    } catch (error) {
      notify('error', `Could not prepare the continuation frame: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    notify('success', `${(end - start).toFixed(1)}s reference clip created. The original video was not changed.`)
  }

  const saveAppSettings = async () => {
    if (!settings) return
    await window.minimax.saveSettings(settings)
    await scanModels(settings)
    await checkConnection(settings.comfyUrl)
    await refreshOllama(settings)
    notify('success', 'Settings saved and model folders rescanned.')
  }

  const applyGenerationDefaults = () => {
    if (!settings) return
    const defaults = settings.generationDefaults
    ws.setResolution(defaults.resolution)
    ws.setDuration(defaults.duration)
    ws.setTurbo(mode === 'reference' && defaults.turbo === '8' ? 'off' : defaults.turbo)
    ws.setSteps(defaults.steps)
    ws.setSampler(defaults.sampler)
    ws.setScheduler(defaults.scheduler)
    ws.setExperimentalSampling(defaults.experimentalSampling)
    ws.setRefImageSize(defaults.refImageSize)
    setLiveEnabled(defaults.livePreview)
    ws.setSigmaShiftMode(defaults.sigmaShiftMode)
    ws.setShiftVideo(defaults.shiftVideo)
    ws.setShiftAudio(defaults.shiftAudio)
    ws.setLoraStrength(defaults.loraStrength)
    ws.setUpscaleMode(defaults.upscaleMode)
    notify('success', 'Saved generation defaults applied to the current Create workspace.')
  }

  const runPromptTool = async (tool: 'enhance' | 'timeline' | 'audio') => {
    if (!settings || !prompt.trim()) {
      notify('error', 'Write a rough prompt first, then ask the local assistant to refine it.')
      return
    }
    if (!settings.ollamaModel || ollamaModels.length === 0) {
      notify('error', 'No local Ollama text model is available. Check Ollama in Settings.')
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
      notify('error', error instanceof Error ? error.message : String(error))
    } finally {
      setPromptingTool(null)
    }
  }

  const resetCreateWorkspace = () => {
    resetWorkspaceFields()
    setPromptSuggestion('')
    setPromptingTool(null)
    setDialogueGenerating(false)
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
      notify('success', 'LTX 2.5 reset. Its prompt, first frame, options, and current preview were cleared.')
      return
    }
    if (view === 'zimage') {
      localStorage.removeItem('minimax.zimage-workspace')
      setZImageResetKey((value) => value + 1)
      notify('success', 'Create Image reset. Its prompt, options, selection, and current preview were cleared.')
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
    notify('success', `${file.name} loaded as the LTX 2.5 image-to-video starting frame.`)
  }

  const generateLtx = async (options: Ltx25GenerationOptions, input: MediaFile | null, handoff?: { characterProjectId?: string; locationProjectId?: string }) => {
    if (!settings) return 'Studio settings are still loading.'
    if (!status.connected) {
      const message = 'Start ComfyUI and verify the server connection in Settings.'
      notify('error', message)
      return message
    }
    if (!options.prompt) {
      const message = 'Add an LTX prompt before generating.'
      notify('error', message)
      return message
    }
    if (options.mode === 'image' && !input) {
      const message = 'Choose a first frame for LTX image-to-video.'
      notify('error', message)
      return message
    }
    if (!ltxSelection.diffusion || !ltxSelection.textEncoder || !ltxSelection.videoVae || !ltxSelection.audioVae || !ltxSelection.latentUpscaler) {
      const message = 'The LTX‑2.5 distilled transformer, Gemma encoder, video/audio VAEs, or latent spatial upscaler is missing.'
      notify('error', message)
      return message
    }
    const missingNodes = LTX_NATIVE_REQUIRED_NODES.filter((node) => !info[node])
    if (missingNodes.length) {
      const message = `Update ComfyUI before using LTX‑2.5. Missing core nodes: ${missingNodes.join(', ')}.`
      notify('error', message)
      return message
    }

    const localId = createId()
    const job: GenerationJob = { id: localId, provider: 'ltx25', mode: options.mode, prompt: options.prompt, createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: input ? 'Preparing first frame' : 'Preparing workflow', width: options.width, height: options.height, duration: options.duration, characterProjectId: handoff?.characterProjectId ?? characterHandoff ?? undefined, locationProjectId: handoff?.locationProjectId }
    setJobs((current) => [job, ...current])
    setActiveJobId(localId)
    setLtxSubmitting(true)
    notify('neutral', 'Preparing the official LTX‑2.5 ComfyUI graph…')
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
        notify('success', `${options.preset === 'quality' ? 'Two-stage quality' : 'Single-stage Turbo'} LTX‑2.5 generation added to ComfyUI.`)
        if (!handoff) setCharacterHandoff(null)
        return null
      }
    } catch (error) {
      const cancelled = cancellationRequests.current.has(localId)
      const message = cancelled ? 'LTX generation cancelled.' : error instanceof Error ? error.message : String(error)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : error instanceof Error ? error.message : String(error) } : item))
      notify(cancelled ? 'success' : 'error', message)
      return message
    } finally {
      cancellationRequests.current.delete(localId)
      setLtxSubmitting(false)
    }
  }

  const generateAceStep = async (options: AceStepGenerationOptions) => {
    if (!settings) return
    if (!status.connected) {
      notify('error', 'Start ComfyUI and verify the server connection in Settings.')
      return
    }
    const selectedModel = options.model === 'sft' ? aceSelection.sft : aceSelection.base
    if (!selectedModel || !aceSelection.vae || !aceSelection.textEncoderSmall || !aceSelection.textEncoderLarge) {
      notify('error', `The ACE-Step ${options.model.toUpperCase()} model, audio VAE, and both Qwen ACE text encoders are required.`)
      return
    }
    const missingNodes = ACE_STEP_REQUIRED_NODES.filter((node) => !info[node])
    if (missingNodes.length) {
      notify('error', `Update ComfyUI before using ACE-Step 1.5. Missing core nodes: ${missingNodes.join(', ')}.`)
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
    notify('neutral', `Preparing the official ACE-Step XL ${options.model.toUpperCase()} ComfyUI graph…`)
    try {
      const graph = buildAceStepWorkflow(options, aceSelection)
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, live.clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        notify('success', `ACE-Step XL ${options.model.toUpperCase()} music generation added to ComfyUI.`)
      }
    } catch (error) {
      const cancelled = cancellationRequests.current.has(localId)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : error instanceof Error ? error.message : String(error) } : item))
      if (cancelled) notify('success', 'Music generation cancelled.')
      else notify('error', error instanceof Error ? error.message : String(error))
    } finally {
      cancellationRequests.current.delete(localId)
      setAceSubmitting(false)
    }
  }

  const generate = async () => {
    if (!settings) return
    if (upscaleMode === 'ltx' && (!upscaleModel || !upscaleVae)) {
      notify('error', 'LTX 2.5 spatial upscaler and video VAE must be available in ComfyUI.')
      return
    }
    if (upscaleMode === 'ltx' && missingLtxUpscaleNodes.length) {
      notify('error', `Update ComfyUI before using LTX 2× upscale. Missing nodes: ${missingLtxUpscaleNodes.join(', ')}.`)
      return
    }
    if (upscaleMode === 'rtx' && !rtxModel) {
      notify('error', 'Choose an AI upscale model installed in ComfyUI first.')
      return
    }
    if (upscaleMode === 'rtx' && !window.confirm('RTX/CUDA upscale processes every frame independently and can amplify MiniMax noise or temporal shimmer. Continue with this experimental post-process?')) return
    if (!prompt.trim()) {
      notify('error', 'Add a prompt before generating.')
      return
    }
    if (!status.connected) {
      notify('error', 'Start ComfyUI and verify the server connection in Settings.')
      return
    }
    if (!modelReady) {
      notify('error', 'One or more required MiniMax H3 model components are missing.')
      return
    }
    if (liveEnabled && livePreviewMode === 'h3-override' && !h3PreviewOverrideNode) {
      notify('error', 'MiniMax H3 animated preview is selected, but its Preview Override node was not detected. Install or enable the custom node, restart ComfyUI, then click the Local engine status to refresh.')
      return
    }
    if (liveEnabled && livePreviewMode === 'h3-override' && !selection.previewVae) {
      notify('error', 'MiniMax H3 animated preview requires taeh3_decoder.safetensors in ComfyUI/models/vae_approx. Refresh the Local engine after adding it.')
      return
    }
    if ((mode === 'image' || mode === 'frames') && !firstFrame) {
      notify('error', 'Choose a first frame for this mode.')
      return
    }
    if (mode === 'frames' && !lastFrame) {
      notify('error', 'Choose a last frame for first-and-last-frame generation.')
      return
    }
    if (mode === 'reference' && referenceImages.length + referenceVideos.length + referenceAudios.length === 0) {
      notify('error', 'Add at least one reference image, video, or audio file.')
      return
    }
    if (mode === 'reference' && (referenceImages.length > 9 || referenceVideos.length > 3 || referenceAudios.length > 3)) {
      notify('error', 'Reference limits are 9 pictures, 3 videos, and 3 audio files. Remove extras before rendering.')
      return
    }

    setSubmitting(true)
    notify('neutral', 'Uploading inputs and preparing the ComfyUI graph…')
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
        notify('success', 'Generation cancelled.')
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        notify('success', 'Generation added to the local ComfyUI queue.')
        setCharacterHandoff(null)
      }
      ws.setSeed(Math.floor(Math.random() * 1_000_000_000))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = cancellationRequests.current.has(localId)
      setJobs((current) => current.map((item) => item.id === localId ? cancelled ? { ...item, status: 'cancelled', error: undefined } : { ...item, status: 'failed', error: message } : item))
      notify(cancelled ? 'success' : 'error', cancelled ? 'Generation cancelled.' : message)
    } finally {
      cancellationRequests.current.delete(localId)
      setCancellingIds((current) => { const next = new Set(current); next.delete(localId); return next })
      setSubmitting(false)
    }
  }

  const runH3Diagnostics = async () => {
    if (!settings || diagnosticRunning) return
    if (!status.connected) return notify('error', 'Connect ComfyUI before running the H3 diagnostic.')
    const qualityModels = inferSelections(models, 'off')
    const turboModels = inferSelections(models, '8')
    if (![qualityModels.fl2va, qualityModels.textEncoder, qualityModels.videoVae, qualityModels.audioVae, turboModels.fl2vLora].every(Boolean)) {
      return notify('error', 'The FL2VA base stack and official 8-step Turbo LoRA are required for the diagnostic.')
    }
    const tests = [
      { name: 'Native quality', turbo: 'off' as const, selection: qualityModels, filenamePrefix: 'video/MiniMax_DIAGNOSTIC_NATIVE' },
      { name: 'Official Turbo 8', turbo: '8' as const, selection: turboModels, filenamePrefix: 'video/MiniMax_DIAGNOSTIC_TURBO8' },
    ]
    setDiagnosticRunning(true)
    notify('neutral', 'Queuing the fixed-seed Native and Turbo 8 diagnostic pair…')
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
    notify(queuedCount === 2 ? 'success' : 'error', queuedCount === 2
      ? 'H3 diagnostic pair queued with identical prompt, seed, resolution, duration, and official sampling.'
      : queuedCount ? 'Only one diagnostic render could be queued. Check the failed Queue entry.' : 'The diagnostic renders could not be queued. Check ComfyUI and try again.')
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
            sampler={sampler} setSampler={ws.setSampler} scheduler={scheduler} setScheduler={ws.setScheduler}
            experimentalSampling={experimentalSampling} setExperimentalSampling={ws.setExperimentalSampling}
            refImageSize={refImageSize} setRefImageSize={ws.setRefImageSize}
            noDialogue={noDialogue} setNoDialogue={ws.setNoDialogue}
            naturalMovement={naturalMovement} setNaturalMovement={ws.setNaturalMovement}
            clothingPolicy={clothingPolicy} setClothingPolicy={ws.setClothingPolicy}
            sigmaShiftMode={sigmaShiftMode} setSigmaShiftMode={ws.setSigmaShiftMode}
            shiftVideo={shiftVideo} setShiftVideo={ws.setShiftVideo} shiftAudio={shiftAudio} setShiftAudio={ws.setShiftAudio}
            loraStrength={loraStrength} setLoraStrength={ws.setLoraStrength}
            liveEnabled={liveEnabled} setLiveEnabled={setLiveEnabled} livePreviewMode={livePreviewMode} setLivePreviewMode={setLivePreviewMode} liveConnected={live.connected} livePreview={live.preview}
            upscaleMode={upscaleMode} setUpscaleMode={ws.setUpscaleMode} ltxAvailable={ltxUpscaleReady} ltxMissingNodes={missingLtxUpscaleNodes}
            rtxModels={rtxModels} rtxModel={rtxModel} setRtxModel={ws.setRtxModel}
            updateReference={(index, file) => setReferenceImages((items) => items.map((item, i) => i === index ? file : item))}
            mode={mode}
            setMode={setMode}
            prompt={prompt}
            setPrompt={setPrompt}
            duration={duration}
            setDuration={ws.setDuration}
            resolution={resolution}
            setResolution={ws.setResolution}
            turbo={turbo}
            setTurbo={ws.setTurbo}
            steps={steps}
            setSteps={ws.setSteps}
            seed={seed}
            setSeed={ws.setSeed}
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
          setFirstFrame(file); ws.setResolution(frameResolution); setMode('image'); setActiveJobId(null); setView('create'); notify('success', 'Z-Image frame loaded into the MiniMax I2V workspace.')
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
          ws.setDuration(Math.max(2, Math.min(15, shot.duration)))
          setMode(resolved.effectiveMode)
          if (resolved.effectiveMode === 'reference' && turbo === '8') ws.setTurbo('off')
          ws.setResolution(aspectRatio === '9:16' ? '768x1344' : aspectRatio === '1:1' ? '768x768' : '1344x768')
          let inheritedFrame: MediaFile | null = null
          if (context.continuationSource) {
            try {
              const extracted = await window.minimax.extractVideoFrame(context.continuationSource, 'last', settings.outputDirectory, settings.ffmpegPath)
              inheritedFrame = { ...extracted, kind: 'image', preview: await window.minimax.mediaUrl(extracted.path) }
            } catch (error) {
              notify('error', `Could not prepare the continuation frame: ${error instanceof Error ? error.message : String(error)}`)
              return
            }
          }
          setMovieHandoff({ projectId: context.projectId, sceneId: context.sceneId, shotId: shot.id })
          const resolvedImages = resolved.references.map((binding) => binding.purpose === 'continuity' && inheritedFrame ? inheritedFrame : binding.file)
          setFirstFrame(resolved.effectiveMode === 'image' ? inheritedFrame : null); setLastFrame(null); setReferenceImages(resolved.effectiveMode === 'reference' ? resolvedImages : []); setReferenceVideos(resolved.effectiveMode === 'reference' ? shot.referenceVideos ?? [] : []); setReferenceAudios(resolved.effectiveMode === 'reference' ? shot.referenceAudios ?? [] : [])
          setActiveJobId(null); setView('create')
          const inputNote = resolved.effectiveMode === 'reference' ? ` Loaded ${resolvedImages.length} semantically resolved reference image${resolvedImages.length === 1 ? '' : 's'}.` : inheritedFrame ? ' The previous scene’s last frame was loaded automatically for continuous I2V.' : resolved.effectiveMode === 'image' ? ' Add the approved first frame before rendering.' : resolved.effectiveMode === 'frames' ? ' Add the approved first and last frames before rendering.' : ''
          notify('success', `${shot.title} loaded into Create.${inputNote}`)
        }} />}
        {view === 'queue' && <JobsView title="Queue" note="Running and recent local generations" jobs={jobs} empty="No generations have been queued." cancellingIds={cancellingIds} onCancel={cancelJob} />}
        {view === 'library' && <LibraryView jobs={jobs.filter((job) => job.status === 'completed')} settings={settings} onEdit={() => setView('editor')} onUseLtx={useStartFrameInLtx} onNotice={(tone, text) => setNotice({ tone, text })} />}
        {view === 'editor' && <ClipEditor settings={settings} jobs={jobs} onNotice={(tone, text) => setNotice({ tone, text })} onUseFrame={(file, target, clip) => {
          if (target === 'reference') { setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setReferenceImages((items) => [...items, file].slice(0, 9)); setMode('reference') }
          else if (target === 'last') { setLastFrame(file); setMode('frames') }
          else { setFirstFrame(file); setMode(target === 'first' ? 'frames' : 'image') }
          setActiveJobId(null); setView('create')
          notify('success', target === 'i2v' ? `Frame loaded from ${clip.name} as the I2V first frame. The new render will remain a separate video until you add and export it in Clip Editor.` : 'Extracted frame loaded into Create.')
        }} />}
        {view === 'settings' && <SettingsView settings={settings} setSettings={session.setSettings} info={info} models={models} h3Report={h3Report} scanning={session.scanning} status={status} checking={checking} diagnosticRunning={diagnosticRunning} ollamaModels={ollamaModels} onRefreshOllama={() => void refreshOllama(settings)} onScan={() => void scanModels(settings)} onCheck={() => void checkConnection(settings.comfyUrl)} onSave={() => void saveAppSettings()} onApplyDefaults={applyGenerationDefaults} onRunDiagnostics={() => void runH3Diagnostics()} />}
      </main>
      <AiChatHead available={ollamaModels.length > 0} ollamaUrl={settings.ollamaUrl} ollamaModel={settings.ollamaModel} onUseImage={(imagePrompt) => {
        setView('zimage')
        window.dispatchEvent(new CustomEvent('minimax:load-image-prompt', { detail: imagePrompt }))
        notify('success', 'Image prompt loaded into Create Image.')
      }} onUseVideo={(videoPrompt) => {
        setPrompt(videoPrompt); setMode('text'); ws.setNoDialogue(true); setActiveJobId(null); setView('create')
        notify('success', 'Video prompt loaded into Create with No dialogue enabled.')
      }} />
      {videoClipDraft && <VideoReferenceClipper source={videoClipDraft.source} onClose={() => setVideoClipDraft(null)} onCreate={createVideoReferenceClip} />}
    </div>
  )
}

export default App
