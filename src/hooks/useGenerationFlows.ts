/** Generation submission flows for every provider (MiniMax H3, LTX 2.5,
 *  ACE-Step, and the fixed-seed H3 diagnostic pair): validation, upload,
 *  graph submission, and cancellation-aware job bookkeeping. */
import { useState } from 'react'
import { createId } from '../lib/createId'
import { buildMiniMaxWorkflow, frameIndexForSeconds, guideFrameWarning } from '../lib/workflow'
import { buildLtx25Workflow } from '../lib/ltx25Workflow'
import { ACE_STEP_REQUIRED_NODES, buildAceStepWorkflow } from '../lib/aceStepWorkflow'
import { prepareImage } from '../lib/imageCrop'
import { inferSelections } from '../lib/modelSelection'
import type { ObjectInfo } from '../lib/comfyInfo'
import { diagnosticPrompt } from '../lib/h3Stack'
import { composeH3Prompt, resolveRenderReferenceImages } from '../lib/promptPolicies'
import type { useStudioSession } from './useStudioSession'
import type { useGenerationQueue, NoticeTone } from './useGenerationQueue'
import type { useCreateWorkspace } from './useCreateWorkspace'
import type { AceStepGenerationOptions, GenerationJob, Ltx25GenerationOptions, MediaFile, ModelSelection } from '../types'

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
    const job: GenerationJob = { id: localId, provider: 'ltx25', mode: ltxOptions.mode, prompt: ltxOptions.prompt, createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: input ? 'Preparing first frame' : 'Preparing workflow', width: ltxOptions.width, height: ltxOptions.height, duration: ltxOptions.duration, characterProjectId: handoff?.characterProjectId ?? ws.characterHandoff ?? undefined, locationProjectId: handoff?.locationProjectId }
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
    mode: 'off' | 'ltx' | 'rtx'
    model: string
    vae: string
    missingNodes: readonly string[]
  }) => {
    if (!settings) return
    const { mode, prompt, firstFrame, lastFrame, referenceImages, referenceVideos, referenceAudios, duration, resolution, turbo, steps, sampler, scheduler, experimentalSampling, loraStrength, seed, sigmaShiftMode, shiftVideo, shiftAudio, refImageSize, liveEnabled, livePreviewMode, clothingPolicy, noDialogue, naturalMovement, movieHandoff, characterHandoff, selectedReferenceCharacterIds, selectedReferenceLocationIds, setActiveJobId } = ws
    if (upscale.mode === 'ltx' && (!upscale.model || !upscale.vae)) {
      notify('error', 'LTX 2.5 spatial upscaler and video VAE must be available in ComfyUI.')
      return
    }
    if (upscale.mode === 'ltx' && upscale.missingNodes.length) {
      notify('error', `Update ComfyUI before using LTX 2× upscale. Missing nodes: ${upscale.missingNodes.join(', ')}.`)
      return
    }
    if (upscale.mode === 'rtx' && !ws.rtxModel) {
      notify('error', 'Choose an AI upscale model installed in ComfyUI first.')
      return
    }
    if (upscale.mode === 'rtx' && !window.confirm('RTX/CUDA upscale processes every frame independently and can amplify MiniMax noise or temporal shimmer. Continue with this experimental post-process?')) return
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
    const invalidGuide = ws.timelineGuides.find((guide) => guideFrameWarning(guide.seconds, duration))
    if (mode === 'reference' && invalidGuide) {
      notify('error', guideFrameWarning(invalidGuide.seconds, duration)!)
      return
    }

    setSubmitting(true)
    notify('neutral', 'Uploading inputs and preparing the ComfyUI graph…')
    const workspaceBindings = ws.workspaceBindingsFor(selectedReferenceCharacterIds, selectedReferenceLocationIds)
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
      width: width * (upscale.mode === 'off' ? 1 : 2),
      height: height * (upscale.mode === 'off' ? 1 : 2),
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
      const guides = mode === 'reference' ? ws.timelineGuides : []
      const [first, last, images, videos, audios, guideUploads] = await Promise.all([
        firstFrame && (mode === 'image' || mode === 'frames') ? upload(firstFrame, true) : undefined,
        lastFrame && mode === 'frames' ? upload(lastFrame, true) : undefined,
        Promise.all(mode === 'reference' ? renderReferenceImages.map((file) => upload(file)) : []),
        Promise.all(mode === 'reference' ? referenceVideos.map((file) => upload(file)) : []),
        Promise.all(mode === 'reference' ? referenceAudios.map((file) => upload(file)) : []),
        Promise.all(guides.map(({ file }) => upload(file))),
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
        upscale: upscale.mode === 'ltx' ? { type: 'ltx', model: upscale.model, vae: upscale.vae } : upscale.mode === 'rtx' ? { type: 'rtx', model: ws.rtxModel } : undefined,
        refImageSize,
        sigmaShift: sigmaShiftMode === 'custom' ? { video: shiftVideo, audio: shiftAudio } : undefined,
        previewOverride: liveEnabled && livePreviewMode === 'h3-override' && h3PreviewOverrideNode ? { frames: 50, fps: 12, nodeType: h3PreviewOverrideNode, vaeName: selection.previewVae, jpegQuality: 85 } : undefined,
        filenamePrefix: `video/MiniMax_H3_${Date.now()}`,
        firstFrame: firstFrame?.path,
        lastFrame: lastFrame?.path,
        referenceImages: renderReferenceImages.map((item) => item.path),
        referenceVideos: referenceVideos.map((item) => item.path),
        referenceAudios: referenceAudios.map((item) => item.path),
        timelineGuides: guides.length ? guides.map((guide) => ({ frameIndex: frameIndexForSeconds(guide.seconds) })) : undefined,
      }, selection, { first, last, images, videos, audios, guides: guideUploads })
      const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, clientId)
      if (cancellationRequests.current.has(localId)) {
        await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled', error: undefined } : item))
        notify('success', 'Generation cancelled.')
      } else {
        setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
        notify('success', 'Generation added to the local ComfyUI queue.')
        ws.setCharacterHandoff(null)
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

  return { generate, generateLtx, generateAceStep, runH3Diagnostics, submitting, ltxSubmitting, aceSubmitting, diagnosticRunning }
}
