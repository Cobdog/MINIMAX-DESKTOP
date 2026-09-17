/** Generation submission flows for every provider (MiniMax H3, LTX 2.5,
 *  ACE-Step, and the fixed-seed H3 diagnostic pair): validation, upload,
 *  graph submission, and cancellation-aware job bookkeeping. */
import { useState } from 'react'
import { createId } from '../lib/createId'
import { buildMiniMaxWorkflow } from '../lib/workflow'
import { submitH3Render } from '../lib/h3Submit'
import { submitLtx23Utility } from '../lib/ltx23UtilitySubmit'
import { submitLtx25 } from '../lib/ltx25Submit'
import { submitAceStep } from '../lib/aceStepSubmit'
import { submitMusic3 } from '../lib/music3Submit'
import { submitH3DiagnosticPair } from '../lib/h3Diagnostics'
import type { Ltx23UtilityKind } from '../lib/graph'
import { prepareImage } from '../lib/imageCrop'
import type { ObjectInfo } from '../lib/comfyInfo'
import { composeH3Prompt, resolveRenderReferenceImages } from '../lib/promptPolicies'
import { resolveMovieShot } from '../lib/promptComposer'
import { buildContactSheetWorkflow, inferContactSheetSelection } from '../lib/contactSheet'
import type { Music3GenerationOptions } from '../lib/music3Workflow'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { useStudioSession } from './useStudioSession'
import type { useGenerationQueue, NoticeTone } from './useGenerationQueue'
import type { useCreateWorkspace } from './useCreateWorkspace'
import type { AceStepGenerationOptions, CharacterProject, GenerationJob, Ltx25GenerationOptions, MediaFile, ModelSelection, MovieProject, UpscaleMode } from '../types'

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
    // Phase 4: the submission core lives in lib/ltx25Submit.ts — this hook and
    // the canvas's typed-hole produce row submit through ONE code path (the
    // h3Submit discipline). The hook keeps its facades (active-job tracking).
    setLtxSubmitting(true)
    try {
      const result = await submitLtx25(
        ltxOptions,
        input,
        { settings, connected: status.connected, info, selection: ltxSelection, clientId },
        {
          notify,
          setJobs,
          cancellationRequests,
          onJobCreated: (jobId) => ws.setActiveJobId(jobId),
        },
        // Wave 2a: read through the store — the App root no longer re-renders
        // on workspace edits, so a captured facade value could be stale.
        { characterProjectId: handoff?.characterProjectId ?? useWorkspaceStore.getState().characterHandoff ?? undefined, locationProjectId: handoff?.locationProjectId },
      )
      if (result.ok && !handoff) ws.setCharacterHandoff(null)
      return result.ok ? null : result.message
    } finally {
      setLtxSubmitting(false)
    }
  }

  /** LTX-2.3 one-graph utility (task 068xwy3): template-faithful video
   *  tools (remove-subtitles / watermark / archival / object, outpaint,
   *  img+audio→video) over the 2.3-dev checkpoint. Phase 3 (j5sj28v): the
   *  submission core lives in lib/ltx23UtilitySubmit.ts — this hook and the
   *  canvas typed-hole menus submit through ONE code path (the h3Submit
   *  discipline). The pick-and-run UI is the canvas's typed-hole menus. */
  const generateLtxUtility = async (options: { tool: Ltx23UtilityKind; input: MediaFile | null; audio?: MediaFile | null; prompt?: string; seed?: number }): Promise<string | null> => {
    if (!settings) return 'Studio settings are still loading.'
    const result = await submitLtx23Utility(
      { tool: options.tool, prompt: options.prompt, seed: options.seed, video: options.tool === 'ia2v' ? null : options.input, image: options.tool === 'ia2v' ? options.input : null, audio: options.audio ?? null },
      { settings, connected: status.connected, info, models, clientId },
      { notify, setJobs, cancellationRequests },
    )
    return result.ok ? null : result.message
  }

  const generateAceStep = async (aceOptions: AceStepGenerationOptions) => {
    if (!settings) return
    // Phase 4: the submission core lives in lib/aceStepSubmit.ts — the old
    // workspace and the canvas audio dock submit through ONE code path.
    setAceSubmitting(true)
    try {
      await submitAceStep(aceOptions, { settings, connected: status.connected, info, selection: aceSelection, clientId }, { notify, setJobs, cancellationRequests })
    } finally {
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
    setDiagnosticRunning(true)
    try {
      // Phase 4: the pair lives in the shared core (lib/h3Diagnostics.ts) —
      // the docked canvas Settings panel runs the same code path.
      await submitH3DiagnosticPair({ settings, connected: status.connected, models, info, clientId }, { notify, setJobs })
      onQueued('queue')
    } finally {
      setDiagnosticRunning(false)
    }
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

  /** MiniMax Music 3: complete songs through the official template graph.
   *  Phase 4: the submission core lives in lib/music3Submit.ts — the old
   *  workspace and the canvas audio dock submit through ONE code path. */
  const generateMusic3 = async (options: Music3GenerationOptions, models3: { diffusion: string; textEncoder: string; vae: string }) => {
    if (!settings) return
    setMusic3Submitting(true)
    try {
      await submitMusic3(options, { settings, connected: status.connected, info, selection: models3, clientId }, { notify, setJobs, cancellationRequests })
    } finally {
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
