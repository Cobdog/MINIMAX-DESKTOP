import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
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
  AudioLines,
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
import { STORAGE_ERROR_EVENT } from './lib/libraryStorage'
import { choices } from './lib/comfyInfo'
import { outputFileFromUrl } from './lib/workflow'
import { ACE_STEP_REQUIRED_NODES, inferAceStepSelections } from './lib/aceStepWorkflow'
import { MUSIC3_REQUIRED_NODES, inferMusic3Selection } from './lib/music3Workflow'
import { Music3Workspace } from './components/Music3Workspace'
import { fitWholeCharacter } from './lib/imageCrop'
import { inferLtx25Selections, inferSelections } from './lib/modelSelection'
import { inferContactSheetSelection } from './lib/contactSheet'
import { findH3PreviewOverrideNode, h3StackReport } from './lib/h3Stack'
import { useLivePreview } from './lib/useLivePreview'
import { ZImageWorkspace } from './components/ZImageWorkspace'
import { ClipEditor } from './components/ClipEditor'
import { Ltx25Workspace } from './components/Ltx25Workspace'
import { AceStepWorkspace } from './components/AceStepWorkspace'
import { VideoReferenceClipper } from './components/VideoReferenceClipper'
import { AiChatHead } from './components/AiChatHead'
import type { CharacterDialogueDraft } from './components/CharacterDialogueModal'
import { GpuMeter, NavButton, Notice } from './components/chrome'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LicenseNotice } from './components/LicenseNotice'
import { CreateView } from './views/CreateView'
import { LibraryView } from './views/LibraryView'
import { JobsView } from './views/JobsView'
import { SettingsView } from './views/SettingsView'
import { useStudioSession } from './hooks/useStudioSession'
import { useGenerationQueue } from './hooks/useGenerationQueue'
import { useCreateWorkspace, type VideoClipDraft } from './hooks/useCreateWorkspace'
import { useGenerationFlows } from './hooks/useGenerationFlows'
import { buildPromptAssistantRequest } from './lib/promptComposer'
import { buildCharacterDialogueRequest } from './lib/dialogPolicy'
import type {
  GenerationJob,
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


// Heavy views lazy-load: every one of these is conditionally rendered (a clean
// lazy boundary), and together they remove ~170KB from the desktop initial
// parse (perf audit). Named exports map to default for React.lazy.
const MoviePlanner = lazy(() => import('./components/MoviePlanner').then((m) => ({ default: m.MoviePlanner })))
const CharacterStudio = lazy(() => import('./components/CharacterStudio').then((m) => ({ default: m.CharacterStudio })))
const HairStudio = lazy(() => import('./components/HairStudio').then((m) => ({ default: m.HairStudio })))
const WardrobeStudio = lazy(() => import('./components/WardrobeStudio').then((m) => ({ default: m.WardrobeStudio })))
const LocationStudio = lazy(() => import('./components/LocationStudio').then((m) => ({ default: m.LocationStudio })))
const AccessoryStudio = lazy(() => import('./components/AccessoryStudio').then((m) => ({ default: m.AccessoryStudio })))

const viewFallback = <div className="boot"><LoaderCircle className="spin" /><span>Loading…</span></div>

function App() {
  const [view, setView] = useState<View>('create')
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 680)
  const [videoClipDraft, setVideoClipDraft] = useState<VideoClipDraft | null>(null)
  const [ltxResetKey, setLtxResetKey] = useState(0)
  const [zImageResetKey, setZImageResetKey] = useState(0)
  const [ltxResetAt, setLtxResetAt] = useState(0)
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
  const { jobs, cancellingIds, cancelJob, onLiveProgress } = queue

  // Keep the lightweight ComfyUI event socket active even when image previews
  // are hidden so queue, node, and sampler-step progress remain real-time.
  const live = useLivePreview(settings?.comfyUrl, true, onLiveProgress)

  const h3PreviewOverrideNode = findH3PreviewOverrideNode(info)
  const upscaleModel = choices(info, 'LatentUpscaleModelLoader', 'model_name').find((n) => /ltx-2\.5.*spatial.*x2/i.test(n)) ?? ''
  const upscaleVae = choices(info, 'VAELoader', 'vae_name').find((n) => /ltx-2\.5.*video.*vae/i.test(n)) ?? ''
  const missingLtxUpscaleNodes = LTX_UPSCALE_REQUIRED_NODES.filter((node) => !info[node])
  const ltxUpscaleReady = Boolean(upscaleModel && upscaleVae && missingLtxUpscaleNodes.length === 0)
  const rtxModels = choices(info, 'UpscaleModelLoader', 'model_name')
  // LBH-123-AI community latent upscaler availability + first usable model
  // (the combo carries a "(...)" placeholder until models are installed).
  const lbh2dChoices = choices(info, 'MinimaxH3LatentUpscalerNode2D', 'model_name')
  const lbh3dChoices = choices(info, 'MinimaxH3LatentUpscaler3D', 'model_name')
  const lbhModel = lbh3dChoices.find((name) => !name.startsWith('(')) ?? lbh2dChoices.find((name) => !name.startsWith('(')) ?? ''
  const lbh2dAvailable = Boolean(lbh2dChoices.length && lbhModel)
  // Latent chaining availability (ComfyUI-H3-Motion-Context node set).
  const chainAvailable = ['MiniMaxH3MotionContext', 'MiniMaxH3MotionContextLoadLatent', 'MiniMaxH3MotionContextSaveLatent', 'MiniMaxH3MotionContextTrim'].every((node) => Boolean(info[node]))

  // Create workspace: every composed field, libraries, and reference binding.
  const ws = useCreateWorkspace({ settings, rtxModels, notify, setVideoClipDraft })
  const {
    mode, setMode, prompt, setPrompt, duration, resolution, turbo, steps, sampler, scheduler,
    experimentalSampling, refImageSize, noDialogue, naturalMovement, clothingPolicy,
    sigmaShiftMode, shiftVideo, shiftAudio, loraStrength, liveEnabled, setLiveEnabled,
    livePreviewMode, setLivePreviewMode, upscaleMode, rtxModel, seed, advanced, setAdvanced,
    firstFrame, setFirstFrame, lastFrame, setLastFrame,
    referenceImages, setReferenceImages, referenceVideos, setReferenceVideos, referenceAudios, setReferenceAudios, timelineGuides, setTimelineGuides,
    characterProjects, wardrobeProjects, locationProjects, hairStyleProjects,
    selectedReferenceCharacterIds, setSelectedReferenceCharacterIds,
    selectedReferenceLocationIds, setSelectedReferenceLocationIds,
    activeJobId, setActiveJobId, setMovieHandoff, setCharacterHandoff,
    createResetKey, resetCreateWorkspace: resetWorkspaceFields,
    chooseMedia, chooseMany, editVideoReference, refreshSourceMedia,
    workspaceBindingsFor, loadReferenceCharacter, loadReferenceLocation, loadReferenceWardrobe,
  } = ws

  const selection = useMemo(() => inferSelections(models, turbo), [models, turbo])
  const h3Report = useMemo(() => h3StackReport(models), [models])
  const ltxSelection = useMemo(() => inferLtx25Selections(models, choices(info, 'LatentUpscaleModelLoader', 'model_name')), [models, info])
  const aceSelection = useMemo(() => inferAceStepSelections(models), [models])
  const music3Selection = useMemo(() => inferMusic3Selection(models), [models])
  const contactSheetAvailable = Boolean(info['H3ContactSheet'] && info['H3ContactSheetDecode'] && inferContactSheetSelection(models, selection.ref2va, selection.textEncoder, selection.videoVae).turnaroundLora)
  const activeModel = mode === 'reference' ? selection.ref2va : selection.fl2va
  const activeLora = mode === 'reference' ? selection.ref2vLora : selection.fl2vLora
  const requiredModels = [activeModel, selection.textEncoder, selection.videoVae, selection.audioVae]
  const modelReady = requiredModels.every(Boolean) && (turbo === 'off' || Boolean(activeLora))
  const pendingJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running')

  // Graph compatibility: self-record the ComfyUI version the bundled graph
  // families were last verified against; Settings warns when the engine has
  // moved past it (the community's red-nodes-on-update failure mode).
  const comfyVersion = status.stats?.system?.comfyui_version
  useEffect(() => {
    if (!settings || !status.connected || !comfyVersion || settings.testedComfyVersion) return
    const next = { ...settings, testedComfyVersion: comfyVersion }
    session.setSettings(next)
    void window.minimax.saveSettings(next)
  }, [comfyVersion, session, settings, status.connected])

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
    if (view === 'music3') {
      localStorage.removeItem('minimax.music3-workspace')
      setNotice({ tone: 'success', text: 'Music 3 reset. Its caption, lyrics, and settings were cleared.' })
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

  // Generation flows: validation, uploads, graph submission for all providers.
  const flows = useGenerationFlows({
    session, queue, ws, clientId: live.clientId, info, modelReady,
    selection, ltxSelection, aceSelection, h3PreviewOverrideNode,
    notify,
    onQueued: (target) => { if (target) setView(target) },
  })
  const { generateLtx, generateAceStep, runH3Diagnostics, generateMusic3, generateCharacterSheet, submitting, ltxSubmitting, aceSubmitting, music3Submitting, diagnosticRunning } = flows
  const generate = () => flows.generate({
    mode: upscaleMode, model: upscaleModel, vae: upscaleVae, lbhModel, missingNodes: missingLtxUpscaleNodes,
  })

  if (!settings) {
    return <div className="boot"><LoaderCircle className="spin" /><span>Opening MiniMax Studio…</span></div>
  }

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <header className="titlebar" aria-label="Application title bar">
        <button className="titlebar-mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open workspace menu"><Menu size={18} /></button>
        <div className="titlebar-brand"><span className="brand-mark"><Film size={16} /></span><span>MiniMax Studio</span></div>
        <div className="titlebar-drag" />
        <GpuMeter value={gpu} engineOnline={status.connected} />
        <button
          className={`connection-chip ${status.connected ? (modelReady ? 'online' : 'degraded') : ''}`}
          onClick={() => { if (!modelReady) setView('settings'); else void checkConnection(settings.comfyUrl) }}
          title={status.connected ? (modelReady ? 'Local engine connected — click to re-check' : 'The engine is connected but MiniMax H3 model components are missing — click to open Settings') : 'The generation engine is unreachable — click to re-check the connection'}
        >
          {checking ? <LoaderCircle size={14} className="spin" /> : <span className="status-dot" />}
          {!status.connected ? 'Engine offline' : !modelReady ? 'Engine on · models missing' : `Local engine · ${status.latencyMs} ms`}
        </button>
        {(view === 'create' || view === 'ltx25' || view === 'zimage' || view === 'music3') && <button className="titlebar-action titlebar-reset" onClick={resetCurrentWorkspace} title="Reset this workspace: prompts, options, media, selections, and the current preview" aria-label="Reset workspace"><RotateCcw size={14} /></button>}
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
            <NavButton active={view === 'music3'} icon={AudioLines} label="Music 3" onClick={() => setView('music3')} />
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
        <LicenseNotice />
        <div hidden={view !== 'create'}>
          <ErrorBoundary label="create">
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
            upscaleMode={upscaleMode} setUpscaleMode={ws.setUpscaleMode} ltxAvailable={ltxUpscaleReady} ltxMissingNodes={missingLtxUpscaleNodes} lbh2dAvailable={lbh2dAvailable} lbh3dAvailable={Boolean(lbh3dChoices.length && lbhModel)}
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
            timelineGuides={timelineGuides}
            setTimelineGuides={setTimelineGuides}
            characters={characterProjects}
            wardrobes={wardrobeProjects}
            locations={locationProjects}
            hairStyles={hairStyleProjects}
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
            addReferenceImage={(file) => { setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setReferenceImages((current) => current.length < 9 ? [...current, file] : current) }}
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
            onOpenSettings={() => setView('settings')}
          />
          </ErrorBoundary>
        </div>
        {view === 'ltx25' && <ErrorBoundary label="ltx25"><Ltx25Workspace key={`ltx-${ltxResetKey}`}
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
        /></ErrorBoundary>}
        {view === 'music' && <ErrorBoundary label="music"><AceStepWorkspace
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
        /></ErrorBoundary>}
        {view === 'music3' && <ErrorBoundary label="music3"><Music3Workspace
          settings={settings}
          models={music3Selection}
          connected={status.connected}
          pipelineReady={MUSIC3_REQUIRED_NODES.every((node) => Boolean(info[node]))}
          missingNodes={MUSIC3_REQUIRED_NODES.filter((node) => !info[node])}
          latestJob={jobs.find((job) => job.provider === 'music3')}
          submitting={music3Submitting}
          cancelling={Boolean(jobs.find((job) => job.provider === 'music3' && ['queued', 'running'].includes(job.status)) && cancellingIds.has(jobs.find((job) => job.provider === 'music3' && ['queued', 'running'].includes(job.status))!.id))}
          ollamaAvailable={ollamaModels.length > 0}
          onGenerate={(options) => void generateMusic3(options, music3Selection)}
          onCancel={(job: GenerationJob) => void cancelJob(job)}
          onNotice={(tone: 'error' | 'success' | 'neutral', text: string) => setNotice({ tone, text })}
        /></ErrorBoundary>}
        <div hidden={view !== 'zimage'}><ErrorBoundary label="zimage"><ZImageWorkspace key={`first-frame-${zImageResetKey}`} url={settings.comfyUrl} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} ollamaUrl={settings.ollamaUrl} ollamaModel={settings.ollamaModel} outputDirectory={settings.outputDirectory} onUse={(file, frameResolution) => {
          setFirstFrame(file); ws.setResolution(frameResolution); setMode('image'); setActiveJobId(null); setView('create'); notify('success', 'Z-Image frame loaded into the MiniMax I2V workspace.')
        }} /></ErrorBoundary></div>
        {view === 'characters' && <ErrorBoundary label="characters"><Suspense fallback={viewFallback}><CharacterStudio settings={settings} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} automationJob={jobs.find((job) => job.characterProjectId)} onNotice={(tone, text) => setNotice({ tone, text })} onCreateTurntable={(project) => {
          if (!project.baseImage) return Promise.resolve('Approve a character identity image before rendering the survey.')
          if (contactSheetAvailable) return generateCharacterSheet(project, contactSheetAvailable)
          const firstFrame = fitWholeCharacter({ ...project.baseImage }); delete firstFrame.preview
          return generateLtx({ mode: 'image', prompt: `Ten-second character identity coverage survey of ${project.name} in one continuous stabilized take. Preserve the exact identity, facial geometry, skin, hair, body proportions, clothing, and neutral studio background from the first frame. From 0 to 2 seconds hold a sharp neutral full-body front view with the entire head, hands, and feet visible. From 2 to 5 seconds make a slow stabilized camera push to a sharp head-and-shoulders close-up. From 5 to 7 seconds hold the face clearly while moving through frontal and gentle three-quarter facial angles so the eyes, nose, mouth, jawline, ears, hairline, and distinguishing marks remain readable. From 7 to 10 seconds pull back smoothly to a complete full-body view and continue a restrained orbit through three-quarter, side, and rear body angles. The character stays still with a neutral expression and unchanged pose. Even soft studio lighting, accurate anatomy, crisp individual frames, fast shutter. No cuts, no identity drift, no morphing, no pose changes, no expression changes, no clothing changes, no added objects, no motion blur, no smearing, no ghosting, no whip pans, no text, no dialogue.`, width: 768, height: 1024, duration: 10, preset: 'quality', seed: Math.floor(Math.random() * 1_000_000_000), filenamePrefix: 'MiniMax_character_identity_survey' }, firstFrame, { characterProjectId: project.id })
        }} /></Suspense></ErrorBoundary>}
        {view === 'hair' && <ErrorBoundary label="hair"><Suspense fallback={viewFallback}><HairStudio settings={settings} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} onNotice={(tone, text) => setNotice({ tone, text })} /></Suspense></ErrorBoundary>}
        {view === 'wardrobes' && <ErrorBoundary label="wardrobes"><Suspense fallback={viewFallback}><WardrobeStudio settings={settings} info={info} connected={status.connected} onNotice={(tone, text) => setNotice({ tone, text })} /></Suspense></ErrorBoundary>}
        {view === 'accessories' && <ErrorBoundary label="accessories"><Suspense fallback={viewFallback}><AccessoryStudio settings={settings} info={info} connected={status.connected} onNotice={(tone, text) => setNotice({ tone, text })} /></Suspense></ErrorBoundary>}
        {view === 'locations' && <ErrorBoundary label="locations"><Suspense fallback={viewFallback}><LocationStudio settings={settings} info={info} connected={status.connected} ollamaAvailable={ollamaModels.length > 0} automationJob={jobs.find((job) => job.locationProjectId)} onNotice={(tone, text) => setNotice({ tone, text })} onCreateWalkthrough={(project: LocationProject, options?: { duration: number; cameraLanguage: string }) => {
          if (!project.baseImage) return Promise.resolve('Approve a location image before rendering the walkthrough.')
          const firstFrame = { ...project.baseImage }; delete firstFrame.preview
          const walkthroughDirection = project.environmentMode === 'nature'
            ? `Comprehensive cinematic natural-landscape survey of ${project.name}. Begin with a wide establishing view, then move slowly through the terrain in one continuous stabilized path. Deliberately reveal landforms, vegetation zones, water features, rock formations, horizon lines, and their spatial relationships. Preserve the exact terrain, ecology, vegetation placement, lighting, weather, and geography from the first frame. Untouched nature only: no buildings, cabins, houses, ruins, roads, streets, bridges, fences, signs, vehicles, power lines, utility poles, constructed paths, or other human-made objects.`
            : `Comprehensive cinematic location walkthrough reference video of ${project.name}. Begin with a wide establishing view, then move slowly along the perimeter in one continuous stabilized path. Deliberately pan through every important zone and spatial connection, revealing entrances, landmarks, surfaces, fixtures, terrain, and object placement. Preserve exactly the same architecture, dimensions, materials, lighting, weather, and geography from the first frame.`
          const locationProfile = [project.description, project.atmosphere && `Atmosphere and lighting: ${project.atmosphere}.`, project.timeOfDay && `Time and weather: ${project.timeOfDay}.`, project.continuityAnchors && `Fixed continuity anchors: ${project.continuityAnchors}.`, project.visualStyle && `Visual treatment: ${project.visualStyle}.`].filter(Boolean).join(' ')
          const cameraLanguage = options?.cameraLanguage ?? 'Use only wide and extra-wide shots with an 18–24mm lens. Begin with a complete establishing view, then move slowly and smoothly to reveal the environment’s spatial relationships. Never use close-ups.'
          const clarityDirection = 'Maintain crisp, sharp frames with a fast shutter and slow stabilized camera movement. No motion blur, temporal smearing, ghosting, rolling-shutter distortion, speed ramps, whip pans, or rapid camera movement.'
          return generateLtx({ mode: 'image', prompt: `${walkthroughDirection} Location description: ${locationProfile} Camera language: ${cameraLanguage} Image clarity: ${clarityDirection} No cuts, no teleporting, no layout changes, no duplicated objects, no people as focal subjects, no dialogue, no text, no logos.`, width: 1344, height: 768, duration: Math.max(5, Math.min(20, options?.duration ?? 10)), preset: 'quality', seed: Math.floor(Math.random() * 1_000_000_000), filenamePrefix: 'MiniMax_location_walkthrough' }, firstFrame, { locationProjectId: project.id })
        }} /></Suspense></ErrorBoundary>}
        {view === 'movie' && <ErrorBoundary label="movie"><Suspense fallback={viewFallback}><MoviePlanner settings={settings} ollamaAvailable={ollamaModels.length > 0} ollamaModel={settings.ollamaModel} chainAvailable={chainAvailable} onRenderChain={(project, scene) => { void flows.generateSceneChain(project, scene, characterProjects, chainAvailable).then((message) => { if (message) setNotice({ tone: 'error', text: message }) }) }} onNotice={(tone, text) => setNotice({ tone, text })} onOpenShot={async (shot: MovieShot, aspectRatio: MovieProject['aspectRatio'], resolved: ResolvedMovieShot, context: { projectId: string; sceneId: string; continuationSource?: string }) => {
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
        }} /></Suspense></ErrorBoundary>}
        {view === 'queue' && <ErrorBoundary label="queue"><JobsView title="Queue" note="Running and recent local generations" jobs={jobs} empty="No generations have been queued." cancellingIds={cancellingIds} onCancel={cancelJob} /></ErrorBoundary>}
        {view === 'library' && <ErrorBoundary label="library"><LibraryView jobs={jobs.filter((job) => job.status === 'completed')} settings={settings} onEdit={() => setView('editor')} onUseLtx={useStartFrameInLtx} onNotice={(tone, text) => setNotice({ tone, text })} /></ErrorBoundary>}
        {view === 'editor' && <ErrorBoundary label="editor"><ClipEditor settings={settings} jobs={jobs} onNotice={(tone, text) => setNotice({ tone, text })} onUseFrame={(file, target, clip) => {
          if (target === 'reference') { setSelectedReferenceCharacterIds([]); setSelectedReferenceLocationIds([]); setReferenceImages((items) => [...items, file].slice(0, 9)); setMode('reference') }
          else if (target === 'last') { setLastFrame(file); setMode('frames') }
          else { setFirstFrame(file); setMode(target === 'first' ? 'frames' : 'image') }
          setActiveJobId(null); setView('create')
          notify('success', target === 'i2v' ? `Frame loaded from ${clip.name} as the I2V first frame. The new render will remain a separate video until you add and export it in Clip Editor.` : 'Extracted frame loaded into Create.')
        }} /></ErrorBoundary>}
        {view === 'settings' && <ErrorBoundary label="settings"><SettingsView settings={settings} setSettings={session.setSettings} info={info} models={models} h3Report={h3Report} scanning={session.scanning} status={status} checking={checking} diagnosticRunning={diagnosticRunning} ollamaModels={ollamaModels} onRefreshOllama={() => void refreshOllama(settings)} onScan={() => void scanModels(settings)} onCheck={() => void checkConnection(settings.comfyUrl)} onSave={() => void saveAppSettings()} onApplyDefaults={applyGenerationDefaults} onRunDiagnostics={() => void runH3Diagnostics()} /></ErrorBoundary>}
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
