/**
 * Workbench submission core (task k9vu6t0) — the h3Submit discipline for
 * the image families: validate → upload → build (buildH3ImageGraph) →
 * submit → job bookkeeping. Nothing here touches a store; every fact
 * arrives as data. The manifest carries the FULL provenance (spec §2:
 * inputs, refs+roles+transports, LoRAs+strengths, path profile, seed, the
 * generated contract) plus the canvas link the landing loop keys on and the
 * h3img record the packet-aware landing reads.
 */
import { createId } from '../lib/createId'
import { extractAllOutputFiles } from '../lib/workflow'
import { buildH3ImageGraph, detectH3ImgFamilies, findH3ImgFamily, inferH3ImgSelection, H3IMG_RECIPE_PINS } from '../lib/graph/h3image'
import { resolveKrea2EditModels } from '../lib/graph/krea2edit'
import { prepareImage } from '../lib/imageCrop'
import type { ObjectInfo } from '../lib/comfyInfo'
import type { AppSettings, GenerationJob, MediaFile, ModelFile } from '../types'
import type { H3ImgRefRole, H3ImgRefSlot, H3ImgTransport } from '../lib/graph/h3image'
import { sessionContract } from './session'
import type { WorkbenchSessionSettings } from './session'

export type WorkbenchSubmitFacts = {
  settings: AppSettings
  connected: boolean
  models: ModelFile[]
  info: ObjectInfo
  clientId?: string
}

export type WorkbenchSubmitIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
  cancellationRequests?: { current: Set<string> }
  /** The canvas inline path (34afx79) links its chain the MOMENT the job
   *  record exists — the h3Submit discipline: the queued ring parks on its
   *  chain during upload, not only once the manifest relinks it. */
  onJobCreated?(jobId: string): void
}

/** One ready-to-upload reference (the session slot resolved to media + its
 * provenance tuple). */
export type ResolvedRef = { media: MediaFile; role: H3ImgRefRole; transport: H3ImgTransport; note: string }

export type WorkbenchGenerationRequest = {
  chainId: string
  settings: WorkbenchSessionSettings
  /** The session's refs resolved to renderable media, in slot order. */
  refs: ResolvedRef[]
  /** The anchored source (edit/directed families; the T=1 I2I anchor). */
  source: MediaFile | null
  /** Refine-only: the engine instruction + the frame being refined. */
  refine?: { engine: 'krea2' | 'klein'; instruction: string; frame: MediaFile; parentTakeId: string }
}

export function buildH3ImgSelection(facts: Pick<WorkbenchSubmitFacts, 'models'>) {
  return inferH3ImgSelection(facts.models, resolveKrea2EditModels(facts.models))
}

/** Family availability for the facts (the mode rail's gating). */
export function workbenchAvailability(facts: Pick<WorkbenchSubmitFacts, 'info' | 'models'>) {
  return detectH3ImgFamilies(facts.info, facts.models)
}

/** The validation ladder: family known + available → intent → engine →
 * per-kind needs → budgets. Returns the refusal message or null. Pure. */
export function validateWorkbenchRequest(request: WorkbenchGenerationRequest, facts: WorkbenchSubmitFacts): string | null {
  const family = findH3ImgFamily(request.settings.family)
  if (!family) return `Unknown workbench family '${request.settings.family}'.`
  const detection = family.detect(facts.info, facts.models)
  if (!detection.available) {
    const missing = [...detection.missingModels, ...detection.missingNodes.map((node) => `node pack: ${node}`)]
    return `${family.label} is not available: ${missing.join('; ')}.`
  }
  if (!request.settings.intent.trim() && !request.refine) return 'Describe what you want before generating.'
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  if (request.refs.length > 9) return 'Beyond 9 references is not available in v1 — curate down (the surface states why; RefMod bundling arrives with the RefMod factory).'
  if ((family.kind === 'edit' || family.kind === 'generate-directed') && !request.source) return `${family.label} needs the anchored source image (Picture 1).`
  if (family.kind === 'compose' && request.refs.length === 0) return 'Compose needs at least one reference.'
  if (request.refine && !request.refine.instruction.trim()) return 'Name the defect to refine (never re-describe the scene).'
  return null
}

/** Builds the H3ImgRefSlot list the graph builder takes (uploaded names are
 * substituted at submit time by the caller passing the upload results). */
export function graphRefSlots(refs: ResolvedRef[], uploads: Array<{ name: string } | undefined>): H3ImgRefSlot[] {
  return refs.map((ref, index) => ({
    name: uploads[index]?.name,
    role: ref.role,
    transport: ref.transport,
    note: ref.note,
  }))
}

/**
 * Validates, uploads, builds, and submits one workbench generation. The
 * job's manifest carries the canvas chain link (the landing loop keys on
 * manifest.canvas.chainId exactly like H3 video renders) and the h3img
 * provenance record the packet-aware landing consumes (family, tier, refs,
 * the scorer inputs). Refusal messages surface through the notice tier —
 * validation never parks a job.
 */
export async function submitWorkbenchGeneration(
  request: WorkbenchGenerationRequest,
  facts: WorkbenchSubmitFacts,
  io: WorkbenchSubmitIo,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const refusal = validateWorkbenchRequest(request, facts)
  if (refusal) {
    io.notify('error', refusal)
    return { ok: false, message: refusal }
  }
  const family = findH3ImgFamily(request.settings.family)!
  const detection = family.detect(facts.info, facts.models)
  const { settings } = facts
  const [width, height] = request.settings.resolution.split('x').map(Number)
  const localId = createId()
  const job: GenerationJob = {
    id: localId,
    mode: 'reference',
    prompt: request.settings.intent,
    createdAt: Date.now(),
    status: 'queued',
    progress: 2,
    progressLabel: 'Preparing workbench generation',
    width,
    height,
    duration: 0,
    provider: 'minimax',
    mediaType: 'image',
  }
  io.setJobs((current) => [job, ...current])
  io.onJobCreated?.(localId)
  try {
    io.notify('neutral', 'Uploading references and preparing the graph…')
    const upload = async (file: MediaFile, fitToOutput = false) => file.kind === 'image' && (fitToOutput || Boolean(file.crop))
      ? window.minimax.uploadImageData(settings.comfyUrl, await prepareImage(file, width, height))
      : window.minimax.uploadInput(settings.comfyUrl, file.path)
    const refUploads = await Promise.all(request.refs.map((ref) => upload(ref.media)))
    const sourceUpload = request.source ? await upload(request.source, true) : undefined
    const refineFrameUpload = request.refine ? await upload(request.refine.frame, true) : undefined
    if (io.cancellationRequests?.current.has(localId)) throw new Error('Generation cancelled before submission.')

    // The tier is profile-derived where a profile pins it: refine emits one
    // frame through its own engine, and the T=1 Fast profile generates
    // exactly one frame BY RECIPE — the session's packet-tier dial (5/9/13)
    // never reaches the builder for those (34afx79: before this pin the
    // dial's default tripped the builder's "exactly one frame" guard on
    // every T=1 submission).
    const tier = request.refine ? 1 : family.profile === 't1' ? H3IMG_RECIPE_PINS.t1.frames : (family.tier ?? request.settings.tier)
    const contract = request.refine ? request.refine.instruction : sessionContract(request.settings, { sourceAnchored: Boolean(request.source) && (family.kind === 'edit' || family.kind === 'generate-directed') })
    const filenamePrefix = `images/H3IMG_${request.chainId.slice(0, 8)}_${Date.now()}`
    const graph = buildH3ImageGraph(
      {
        family: request.refine ? (request.refine.engine === 'krea2' ? 'h3img.refine.krea2' : 'h3img.refine.klein') : request.settings.family,
        prompt: contract,
        width,
        height,
        seed: request.settings.seed,
        tier,
        refs: request.refine ? [] : graphRefSlots(request.refs, refUploads),
        source: request.refine ? refineFrameUpload?.name : sourceUpload?.name,
        steps: undefined,
        loras: request.refine ? [] : request.settings.loras,
        filenamePrefix,
        refineInstruction: request.refine?.instruction,
      },
      buildH3ImgSelection(facts),
      facts.info,
    )

    const provenance = {
      family: request.refine ? (request.refine.engine === 'krea2' ? 'h3img.refine.krea2' : 'h3img.refine.klein') : request.settings.family,
      profile: family.profile,
      tier,
      frames: tier,
      prompt: contract,
      refs: request.refs.map((ref) => ({ role: ref.role, transport: ref.transport, name: ref.media.name })),
      loras: request.settings.loras,
      seed: request.settings.seed,
      resolution: request.settings.resolution,
      hybrid: detection.hybrid,
      canonicalFrameIndex: 0,
      scorer: null,
      ...(request.refine ? { parentTakeId: request.refine.parentTakeId, op: 'refine' as const, engine: request.refine.engine } : {}),
    }
    const manifest: Record<string, unknown> = {
      mode: 'reference',
      prompt: contract,
      width,
      height,
      duration: 0,
      seed: request.settings.seed,
      filenamePrefix,
      h3img: provenance,
      canvas: { chainId: request.chainId },
    }

    const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, facts.clientId)
    if (io.cancellationRequests?.current.has(localId)) {
      await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
      io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled', error: undefined } : item))
      io.notify('success', 'Generation cancelled.')
    } else {
      io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start', manifest, graph } : item))
      io.notify('success', `${family.label} added to the local ComfyUI queue.`)
    }
    return { ok: true, jobId: localId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = io.cancellationRequests?.current.has(localId) ?? false
    io.setJobs((current) => current.map((item) => item.id === localId ? cancelled ? { ...item, status: 'cancelled', error: undefined } : { ...item, status: 'failed', error: message } : item))
    io.notify(cancelled ? 'success' : 'error', cancelled ? 'Generation cancelled.' : message)
    return { ok: false, message }
  } finally {
    io.cancellationRequests?.current.delete(localId)
  }
}

/** Frame attribution for a finished workbench job: EVERY image output of
 * the prompt (the per-frame publish nodes), in frame order. The landing
 * loop calls this before appending the take. */
export function frameDescriptorsForJob(history: Record<string, unknown>, promptId: string) {
  return extractAllOutputFiles(history, promptId, 'image')
}
