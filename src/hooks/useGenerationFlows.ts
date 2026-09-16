/** Generation submission flows for every provider (MiniMax H3, LTX 2.5,
 *  ACE-Step, and the fixed-seed H3 diagnostic pair): validation, upload,
 *  graph submission, and cancellation-aware job bookkeeping. */
import { useState } from 'react'
import { createId } from '../lib/createId'
import { buildMiniMaxWorkflow } from '../lib/workflow'
import { buildLtx25Workflow } from '../lib/ltx25Workflow'
import { ACE_STEP_REQUIRED_NODES, buildAceStepWorkflow } from '../lib/aceStepWorkflow'
import { submitH3Render } from '../lib/h3Submit'
import { buildLtx23UtilityGraph, findLtx23Utility, resolveLtx23Selection } from '../lib/graph'
import type { Ltx23UtilityKind } from '../lib/graph'
import { prepareImage } from '../lib/imageCrop'
import { inferSelections } from '../lib/modelSelection'
import type { ObjectInfo } from '../lib/comfyInfo'
import { diagnosticPrompt } from '../lib/h3Stack'
import { composeH3Prompt, resolveRenderReferenceImages } from '../lib/promptPolicies'
import { resolveMovieShot } from '../lib/promptComposer'
import { buildMusic3Workflow } from '../lib/music3Workflow'
import { buildContactSheetWorkflow, inferContactSheetSelection } from '../lib/contactSheet'
import type { Music3GenerationOptions } from '../lib/music3Workflow'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { useStudioSession } from './useStudioSession'
import type { useGenerationQueue, NoticeTone } from './useGenerationQueue'
import type { useCreateWorkspace } from './useCreateWorkspace'
import type { AceStepGenerationOptions, CharacterProject, GenerationJob, Ltx25GenerationOptions, MediaFile, ModelSelection, MovieProject, UpscaleMode } from '../types'

const LTX_NATIVE_REQUIRED_NODES = [
  'LTXVConditioning', 'LTXVEmptyLatentAudio', 'EmptyLTXVLatentVideo',
  'LTXVDualCFGGuider', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent',
  'LTXVLatentUpsampler', 'LTXVAudioVAEDecode', 'ManualSigmas',
  'VAEDecodeTiled', 'CLIPTextEncode', 'KSamplerSelect', 'SamplerCustomAdvanced',
] as const

export function useGenerationFlows(options: {
  session: ReturnType<typeof useStudioSession>
  queue: ReturnType<typeof useGenerationQueue>
  ws: ReturnType<typeof useCreateWorkspace>
  clientId: string | undefined
  info: ObjectInfo
  modelReady: boolean
  selection: ModelSelection
  ltxSelection: ReturnType<typeof import('../lib/modelSelection').inferLtx25Selections>
  aceSelection: ReturnType<typeof import('../lib/aceStepWorkflow').inferAceStepSelections>
  h3PreviewOverrideNode: string | undefined
  notify(tone: NoticeTone, text: string): void
  onQueued(view?: 'queue'): void
}) {
  const { session, queue, ws, clientId, info, modelReady, selection, ltxSelection, aceSelection, h3PreviewOverrideNode, notify, onQueued } = options
  const { settings, models, status } = session
  const { setJobs, setCancellingIds, cancellationRequests } = queue
  const [submitting, setSubmitting] = useState(false)
  const [ltxSubmitting, setLtxSubmitting] = useState(false)
  const [aceSubmitting, setAceSubmitting] = useState(false)
  const [diagnosticRunning, setDiagnosticRunning] = useState(false)

  const generateLtx = async (ltxOptions: Ltx25GenerationOptions, input: MediaFile | null, handoff?: { characterProjectId?: string; locationProjectId?: string }) => {
    if (!settings) return 'Studio settings are still loading.'
    if (!status.connected) {
      const message = 'Start ComfyUI and verify the server connection in Settings.'
      notify('error', message)
      return message
    }
    if (!ltxOptions.prompt) {
      const message = 'Add an LTX prompt before generating.'
      notify('error', message)
      return message
    }
    if (ltxOptions.mode === 'image' && !input) {
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
    // Wave 2a: read through the store — the App root no longer re-renders on
    // workspace edits, so the captured facade value could be stale by click time.
    const job: GenerationJob = { id: localId, provider: 'ltx25', mode: ltxOptions.mode, prompt: ltxOptions.prompt, createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: input ? 'Preparing first frame' : 'Preparing workflow', width: ltxOptions.width, height: ltxOptions.height, duration: ltxOptions.duration, characterProjectId: handoff?.characterProjectId ?? useWorkspaceStore.getState().characterHandoff ?? undefined, locationProjectId: handoff?.locationProjectId }
    setJobs((current) => [job, ...current])
    ws.setActiveJobId(localId)
    setLtxSubmitting(true)
    notify('neutral', 'Preparing the official LTX‑2.5 ComfyUI graph…')
    try {
      const uploaded = input ? await window.minimax.uploadImageData(settings.comfyUrl, await prepareImage(input, ltxOptions.width, ltxOptions.height)) : undefined
      if (cancellationRequests.current.has(localId)) throw new Error('Generation cancelled before submission.')
      const graph = buildLtx25Workflow(ltxOptions, ltxSelection, uploaded)
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
        return 'The LTX 2.5 survey was cancelled before it started.'
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        notify('success', `${ltxOptions.preset === 'quality' ? 'Two-stage quality' : 'Single-stage Turbo'} LTX‑2.5 generation added to ComfyUI.`)
        if (!handoff) ws.setCharacterHandoff(null)
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

  /** LTX-2.3 one-graph utility (task 068xwy3): template-faithful video
   *  tools (remove-subtitles / watermark / archival / object, outpaint,
   *  img+audio→video) over the 2.3-dev checkpoint — the headless-builder
   *  pattern (CharacterStudio precedent): validate availability, upload the
   *  input media, submit the official-template graph. The pick-and-run UI
   *  belongs to the canvas redesign epic (vbrstja); today the Settings
   *  utilities section calls this. */
  const generateLtxUtility = async (options: { tool: Ltx23UtilityKind; input: MediaFile | null; audio?: MediaFile | null; prompt?: string; seed?: number }): Promise<string | null> => {
    if (!settings) return 'Studio settings are still loading.'
    if (!status.connected) {
      const message = 'Start ComfyUI and verify the server connection in Settings.'
      notify('error', message)
      return message
    }
    const utility = findLtx23Utility(`ltx23.${options.tool}`)
    if (!utility) return `Unknown LTX-2.3 utility '${options.tool}'.`
    const detection = utility.detect(info, models)
    if (!detection.available) {
      const missing = [...detection.missingNodes.map((nodeClass) => `node ${nodeClass}`), ...detection.missingModels]
      const message = `${utility.label} is not ready — missing: ${missing.join('; ')}. ${utility.ui.installHint ?? ''}`
      notify('error', message)
      return message
    }
    const needsVideo = options.tool !== 'ia2v'
    if (needsVideo && !options.input) return `Choose an input video for ${utility.label} first.`
    if (options.tool === 'ia2v' && (!options.input || !options.audio)) return 'Image + audio → video needs both an input image and an audio file.'
    const localId = createId()
    const job: GenerationJob = {
      id: localId, provider: 'ltx23', mode: 'text', prompt: options.prompt ?? utility.promptDefault,
      createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: `Preparing ${utility.label}`,
      width: 0, height: 0, duration: 0,
    }
    setJobs((current) => [job, ...current])
    notify('neutral', `Preparing the official LTX-2.3 ${utility.label} template graph…`)
    try {
      const seed = options.seed ?? Math.floor(Math.random() * 1_000_000_000)
      // Raw uploads: the templates resize/preprocess inside the graph, so the
      // source files go up untouched (no H3 crop pipeline).
      const uploadedVideo = needsVideo && options.input ? await window.minimax.uploadInput(settings.comfyUrl, options.input.path) : undefined
      const uploadedImage = options.tool === 'ia2v' && options.input ? await window.minimax.uploadInput(settings.comfyUrl, options.input.path) : undefined
      const uploadedAudio = options.tool === 'ia2v' && options.audio ? await window.minimax.uploadInput(settings.comfyUrl, options.audio.path) : undefined
      if (cancellationRequests.current.has(localId)) throw new Error('Generation cancelled before submission.')
      const graph = buildLtx23UtilityGraph({
        tool: options.tool,
        prompt: options.prompt,
        seed,
        filenamePrefix: `video/LTX23_${options.tool}_${Date.now()}`,
        video: uploadedVideo,
        image: uploadedImage,
        audio: uploadedAudio,
      }, resolveLtx23Selection(info, models))
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
        return 'The LTX-2.3 utility run was cancelled before it started.'
      }
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
      notify('success', `${utility.label} added to the ComfyUI queue.`)
      return null
    } catch (error) {
      const cancelled = cancellationRequests.current.has(localId)
      const message = cancelled ? 'LTX-2.3 utility cancelled.' : error instanceof Error ? error.message : String(error)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : message } : item))
      notify(cancelled ? 'success' : 'error', message)
      return message
    } finally {
      cancellationRequests.current.delete(localId)
    }
  }

  const generateAceStep = async (aceOptions: AceStepGenerationOptions) => {
    if (!settings) return
    if (!status.connected) {
      notify('error', 'Start ComfyUI and verify the server connection in Settings.')
      return
    }
    const selectedModel = aceOptions.model === 'sft' ? aceSelection.sft : aceSelection.base
    if (!selectedModel || !aceSelection.vae || !aceSelection.textEncoderSmall || !aceSelection.textEncoderLarge) {
      notify('error', `The ACE-Step ${aceOptions.model.toUpperCase()} model, audio VAE, and both Qwen ACE text encoders are required.`)
      return
    }
    const missingNodes = ACE_STEP_REQUIRED_NODES.filter((node) => !info[node])
    if (missingNodes.length) {
      notify('error', `Update ComfyUI before using ACE-Step 1.5. Missing core nodes: ${missingNodes.join(', ')}.`)
      return
    }
    const localId = createId()
    const job: GenerationJob = {
      id: localId, provider: 'acestep', mediaType: 'audio', mode: 'text', prompt: aceOptions.tags,
      createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: 'Preparing ACE-Step workflow',
      width: 0, height: 0, duration: aceOptions.duration,
    }
    setJobs((current) => [job, ...current])
    setAceSubmitting(true)
    notify('neutral', `Preparing the official ACE-Step XL ${aceOptions.model.toUpperCase()} ComfyUI graph…`)
    try {
      const graph = buildAceStepWorkflow(aceOptions, aceSelection)
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        notify('success', `ACE-Step XL ${aceOptions.model.toUpperCase()} music generation added to ComfyUI.`)
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

  const generate = async (upscale: {
    mode: UpscaleMode
    model: string
    vae: string
    lbhModel: string
    missingNodes: readonly string[]
  }) => {
    if (!settings) return
    if (upscale.mode === 'rtx' && !window.confirm('RTX/CUDA upscale processes every frame independently and can amplify MiniMax noise or temporal shimmer. Continue with this experimental post-process?')) return
    // Wave 2a: workspace fields are read from the store AT CALL TIME — the
    // App root no longer re-renders on workspace edits (that is the point of
    // the zustand substrate), so the `ws` facade's captured values could be
    // stale by the time the user clicks Generate. Same field names, same
    // validation order; only the read moved.
    //
    // Phase 2 (flyuh6h): validation/upload/graph/submit live in the shared
    // core (lib/h3Submit.ts) so the canvas submits through the SAME flows —
    // this hook is now the old surface's request builder: snapshot the
    // workspace, compose the effective prompt + ordered references, delegate.
    const workspace = useWorkspaceStore.getState()
    const { mode, prompt, firstFrame, lastFrame, referenceImages, referenceVideos, referenceAudios, duration, resolution, turbo, turboLoader, steps, sampler, scheduler, experimentalSampling, loraStrength, seed, sigmaShiftMode, shiftVideo, shiftAudio, refImageSize, liveEnabled, livePreviewMode, clothingPolicy, noDialogue, naturalMovement, movieHandoff, characterHandoff, selectedReferenceCharacterIds, selectedReferenceLocationIds, setActiveJobId, rtxModel } = workspace
    const workspaceBindings = ws.workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
    const renderReferenceImages = resolveRenderReferenceImages(referenceImages, workspaceBindings, clothingPolicy)
    const effectivePrompt = composeH3Prompt({ prompt, mode, bindings: workspaceBindings, clothingPolicy, noDialogue, naturalMovement })
    const [width, height] = resolution.split('x').map(Number)
    setSubmitting(true)
    const result = await submitH3Render({
      mode,
      prompt: effectivePrompt,
      width,
      height,
      duration,
      seed,
      steps,
      turbo,
      turboLoader,
      experimentalSampling,
      loraStrength,
      sampler,
      scheduler,
      refImageSize,
      sigmaShift: sigmaShiftMode === 'custom' ? { video: shiftVideo, audio: shiftAudio } : undefined,
      upscale,
      rtxModel,
      firstFrame,
      lastFrame,
      referenceImages: renderReferenceImages,
      referenceVideos,
      referenceAudios,
      timelineGuides: workspace.timelineGuides,
      livePreview: { enabled: liveEnabled, mode: livePreviewMode },
      movieLink: movieHandoff ?? undefined,
      characterProjectId: characterHandoff ?? undefined,
    }, {
      settings,
      connected: status.connected,
      modelReady,
      selection,
      models,
      info,
      clientId,
      h3PreviewOverrideNode,
    }, {
      notify,
      setJobs,
      cancellationRequests,
      onJobCreated: (jobId) => setActiveJobId(jobId),
    })
    if (result.ok) {
      ws.setCharacterHandoff(null)
      workspace.setSeed(Math.floor(Math.random() * 1_000_000_000))
    }
    cancellationRequests.current.delete(result.ok ? result.jobId : '')
    setCancellingIds((current) => { const next = new Set(current); next.delete(result.ok ? result.jobId : ''); return next })
    setSubmitting(false)
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
        const graph = buildMiniMaxWorkflow({ mode: 'text', prompt: diagnosticPrompt, width: 1344, height: 768, duration: 5, seed: 12345, steps: 20, turbo: test.turbo, sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: test.filenamePrefix, referenceImages: [], referenceVideos: [], referenceAudios: [] }, test.selection, { images: [], videos: [], audios: [] }, info)
        const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, clientId)
        queuedCount += 1
        setJobs((current) => current.map((item) => item.id === id ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: index === 0 ? 'Native test queued' : 'Turbo 8 test queued behind Native' } : item))
        if (index === tests.length - 1) ws.setActiveJobId(id)
      } catch (error) {
        setJobs((current) => current.map((item) => item.id === id ? { ...item, status: 'failed', error: error instanceof Error ? error.message : String(error) } : item))
      }
    }
    setDiagnosticRunning(false)
    notify(queuedCount === 2 ? 'success' : 'error', queuedCount === 2
      ? 'H3 diagnostic pair queued with identical prompt, seed, resolution, duration, and official sampling.'
      : queuedCount ? 'Only one diagnostic render could be queued. Check the failed Queue entry.' : 'The diagnostic renders could not be queued. Check ComfyUI and try again.')
    onQueued('queue')
  }

  /** Renders a Movie Planner scene as one latent-chained episode (ComfyUI-H3
   *  Motion-Context): every shot's graph saves its sampler latent; segment N
   *  continues from N-1's tail with never-denoised conditioning, so motion and
   *  audio stay continuous. ComfyUI's own queue provides execution order. */
  const generateSceneChain = async (project: MovieProject, scene: MovieProject['scenes'][number], library: CharacterProject[], motionContextReady: boolean) => {
    if (!settings) return 'Studio settings are still loading.'
    if (!status.connected) return 'Start ComfyUI and verify the server connection in Settings.'
    if (!modelReady) return 'One or more required MiniMax H3 model components are missing.'
    if (!motionContextReady) return 'Install the ComfyUI-H3-Motion-Context custom nodes first, then refresh the engine.'
    const shots = scene.shots.filter((shot) => shot.prompt.trim())
    if (shots.length < 2) return 'A chain needs at least two shots with prompts.'
    const chainId = createId()
    const folder = `h3_context/${chainId}/clip`
    const [width, height] = project.aspectRatio === '9:16' ? [768, 1344] : project.aspectRatio === '1:1' ? [768, 768] : [1344, 768]
    const defaults = settings.generationDefaults
    const chainJobs: GenerationJob[] = []
    for (const [index, shot] of shots.entries()) {
      const resolved = resolveMovieShot(project, scene, shot, library)
      if (resolved.references.length > 9) return `Shot ${index + 1} (${shot.title}) has ${resolved.references.length} references — chains are limited to 9 per segment.`
      const job: GenerationJob = {
        id: createId(), provider: 'minimax', mode: resolved.effectiveMode, prompt: resolved.compiledPrompt,
        createdAt: Date.now() + index, status: 'queued', progress: 2,
        progressLabel: `Chain ${index + 1}/${shots.length} · ${shot.title}`,
        width, height, duration: shot.duration,
        movieLink: { projectId: project.id, sceneId: scene.id, shotId: shot.id },
      }
      chainJobs.push(job)
    }
    setJobs((current) => [...chainJobs, ...current])
    notify('neutral', `Rendering ${shots.length}-shot continuous chain for “${scene.title}”…`)
    let queuedCount = 0
    for (const [index, shot] of shots.entries()) {
      const resolved = resolveMovieShot(project, scene, shot, library)
      const upload = async (file: MediaFile) => file.kind === 'image' && Boolean(file.crop)
        ? window.minimax.uploadImageData(settings.comfyUrl, await prepareImage(file, width, height))
        : window.minimax.uploadInput(settings.comfyUrl, file.path)
      try {
        const images = await Promise.all(resolved.effectiveMode === 'reference' ? resolved.references.map((binding) => upload(binding.file)) : [])
        const videos = await Promise.all(resolved.effectiveMode === 'reference' ? (shot.referenceVideos ?? []).map((file) => upload(file)) : [])
        const audios = await Promise.all(resolved.effectiveMode === 'reference' ? (shot.referenceAudios ?? []).map((file) => upload(file)) : [])
        const graph = buildMiniMaxWorkflow({
          mode: resolved.effectiveMode, prompt: resolved.compiledPrompt, width, height, duration: shot.duration,
          seed: Math.floor(Math.random() * 1_000_000_000), steps: defaults.steps, turbo: defaults.turbo,
          experimentalSampling: defaults.experimentalSampling, loraStrength: defaults.loraStrength,
          sampler: defaults.sampler, scheduler: defaults.scheduler, refImageSize: defaults.refImageSize,
          filenamePrefix: `video/Chain_${chainId}_${String(index + 1).padStart(2, '0')}`,
          referenceImages: resolved.effectiveMode === 'reference' ? resolved.references.map((binding) => binding.file.path) : [],
          referenceVideos: resolved.effectiveMode === 'reference' ? (shot.referenceVideos ?? []).map((file) => file.path) : [],
          referenceAudios: resolved.effectiveMode === 'reference' ? (shot.referenceAudios ?? []).map((file) => file.path) : [],
          chain: { index, folder },
        }, selection, { images, videos, audios })
        const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, clientId)
        queuedCount += 1
        setJobs((current) => current.map((item) => item.id === chainJobs[index].id ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4 } : item))
      } catch (error) {
        setJobs((current) => current.map((item) => item.id === chainJobs[index].id ? { ...item, status: 'failed', error: error instanceof Error ? error.message : String(error) } : item))
      }
    }
    const message = queuedCount === shots.length
      ? `${shots.length}-shot chain queued — segments render in order with continuous latent motion and audio.`
      : `Only ${queuedCount} of ${shots.length} chain segments could be queued. Check the failed Queue entries.`
    notify(queuedCount === shots.length ? 'success' : 'error', message)
    onQueued('queue')
    return null
  }

  const [music3Submitting, setMusic3Submitting] = useState(false)

  /** MiniMax Music 3: complete songs through the official template graph. */
  const generateMusic3 = async (options: Music3GenerationOptions, models3: { diffusion: string; textEncoder: string; vae: string }) => {
    if (!settings) return
    if (!status.connected) { notify('error', 'Start ComfyUI and verify the server connection in Settings.'); return }
    if (!options.caption.trim()) { notify('error', 'Write at least one caption section before generating.'); return }
    if (!models3.diffusion || !models3.textEncoder || !models3.vae) { notify('error', 'The Music 3 diffusion model, text encoder, and DAV VAE are required. Install them, then rescan in Settings.'); return }
    const localId = createId()
    const job: GenerationJob = {
      id: localId, provider: 'music3', mediaType: 'audio', mode: 'text', prompt: options.caption,
      createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: 'Preparing Music 3 workflow',
      width: 0, height: 0, duration: options.duration,
    }
    setJobs((current) => [job, ...current])
    setMusic3Submitting(true)
    notify('neutral', 'Preparing the official MiniMax Music 3 ComfyUI graph…')
    try {
      const graph = buildMusic3Workflow(options, models3)
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Composing locally' } : item))
        notify('success', 'MiniMax Music 3 song generation added to ComfyUI.')
      }
    } catch (error) {
      const cancelled = cancellationRequests.current.has(localId)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : error instanceof Error ? error.message : String(error) } : item))
      if (cancelled) notify('success', 'Music generation cancelled.')
      else notify('error', error instanceof Error ? error.message : String(error))
    } finally {
      cancellationRequests.current.delete(localId)
      setMusic3Submitting(false)
    }
  }

  /** Character sheet via H3 ContactSheet + Turnaround LoRA: five coordinated
   *  views of the approved identity image in one pass through the H3 DiT. */
  const generateCharacterSheet = async (project: { id: string; name: string; baseImage?: MediaFile }, contactAvailable: boolean) => {
    if (!settings) return 'Studio settings are still loading.'
    if (!status.connected) return 'Start ComfyUI and verify the server connection in Settings.'
    if (!project.baseImage) return 'Approve a character identity image first.'
    if (!contactAvailable) return 'Install the ComfyUI-H3-ContactSheet nodes and the five-view turnaround LoRA, then refresh the engine.'
    const selection3 = inferContactSheetSelection(models, selection.ref2va, selection.textEncoder, selection.videoVae)
    if (!selection3.turnaroundLora) return 'The five-view turnaround LoRA (minimax_h3_five_view_*) was not found in the LoRA folder.'
    const localId = createId()
    const job: GenerationJob = {
      id: localId, provider: 'minimax', mediaType: 'image', mode: 'reference',
      prompt: `Five-view character sheet of ${project.name}`,
      createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: 'Preparing contact sheet',
      width: 0, height: 0, duration: 0, characterProjectId: project.id,
    }
    setJobs((current) => [job, ...current])
    try {
      const base = { ...project.baseImage }
      delete base.preview
      const uploaded = await window.minimax.uploadImageData(settings.comfyUrl, await prepareImage(project.baseImage, 1024, 1024))
      const graph = buildContactSheetWorkflow({
        prompt: `the camera orbits the subject of <Picture 1> ninety degrees clockwise`,
        size: 1024, steps: 28, seed: Math.floor(Math.random() * 1_000_000_000),
        referenceName: uploaded.name, filenamePrefix: `MiniMax_CharacterSheet_${project.id}`,
      }, selection3)
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, clientId)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Rendering five coordinated views' } : item))
      notify('success', `Contact sheet for ${project.name} queued — five coordinated views through the H3 model.`)
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: 'failed', error: message } : item))
      notify('error', message)
      return message
    }
  }

  return { generate, generateLtx, generateLtxUtility, generateAceStep, runH3Diagnostics, generateSceneChain, generateMusic3, generateCharacterSheet, submitting, ltxSubmitting, aceSubmitting, music3Submitting, diagnosticRunning }
}
