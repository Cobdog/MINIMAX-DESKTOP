/**
 * Workbench landing (task k9vu6t0, spec §2) — the packet-aware branch of
 * the canvas take-landing loop. A finished workbench job reports N image
 * outputs (the per-frame publish nodes); the video landing collects ONE
 * file, this branch collects EVERY frame, registers each through the
 * server's engine-output ingest (exact descriptors, never newest-file
 * guesses), scores them with the first-party scorer, and appends ONE take
 * whose artifacts are the N frame paths with the full provenance + verdict
 * in metrics.
 *
 * Failure honesty: a render that finished but could not fetch its frames
 * lands an ERRORED take (visible, dismissable — the house rule), never a
 * silent idle. A scorer that cannot decode a frame lands the take with
 * scorer: null and canonicalFrameIndex 0 (pick-by-eye) — scoring failure
 * never blocks landing.
 */
import { documentsApi } from '../canvas/api'
import type { DocumentChain } from '../canvas/derive'
import { extractAllOutputFiles } from '../lib/workflow'
import { scoreFrames } from '../lib/h3imageScorer'
import type { FramePixels, ScorerVerdict } from '../lib/h3imageScorer'
import { readSessionSettings, takeFrames } from './session'
import type { AppSettings, GenerationJob } from '../types'

export type WorkbenchLandingInput = {
  chain: DocumentChain
  job: GenerationJob
  settings: AppSettings | null
  comfyUrl: string
  /** Creates the chain's output row when missing (documentsApi.createOutput). */
  ensureOutput: (chainId: string) => Promise<string>
}

export type WorkbenchLandingResult = { landed: boolean; error?: string }

async function decodeImage(url: string): Promise<FramePixels | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height)
    bitmap.close()
    return { width: imageData.width, height: imageData.height, data: imageData.data }
  } catch {
    return null
  }
}

/** True when the job is a workbench generation (the landing loop branches
 * on this before the one-artifact video path). */
export function isWorkbenchJob(job: GenerationJob): boolean {
  const manifest = job.manifest as Record<string, unknown> | undefined
  return Boolean(manifest && typeof manifest === 'object' && manifest.h3img && typeof manifest.h3img === 'object')
}

/** Reads the job's h3img provenance record (tolerant). */
export function workbenchJobProvenance(job: GenerationJob): Record<string, unknown> | null {
  const manifest = job.manifest as Record<string, unknown> | undefined
  const record = manifest?.h3img
  return record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : null
}

/**
 * Lands one finished workbench job as its packet take. Idempotent by the
 * take's jobId (server-enforced at the write boundary), re-entrancy guarded
 * by the caller's landing loop.
 */
export async function landWorkbenchTake(input: WorkbenchLandingInput): Promise<WorkbenchLandingResult> {
  const { chain, job, comfyUrl } = input
  const provenance = workbenchJobProvenance(job)
  if (!provenance || !job.promptId) return { landed: false, error: 'the job carries no workbench provenance' }

  // Every frame descriptor, in frame order — the exact engine outputs.
  let descriptors: Array<{ filename: string; subfolder?: string; type?: string }> = []
  try {
    const history = await window.minimax.getHistory(comfyUrl, job.promptId)
    descriptors = extractAllOutputFiles(history, job.promptId, 'image')
  } catch (error) {
    return { landed: false, error: `the engine history could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!descriptors.length && !job.localOutputPath) {
    return { landed: false, error: 'the render finished without image outputs' }
  }

  // Ingest every frame through the server-side exact-descriptor fetch
  // (bytes land in the output dir + content-addressed blob tree).
  const artifactPaths: string[] = []
  let failure: string | null = null
  for (const descriptor of descriptors) {
    try {
      const ingested = await documentsApi.ingestEngineOutput({ ...descriptor, kind: 'image' })
      artifactPaths.push(ingested.path)
    } catch (error) {
      failure = `frame ${artifactPaths.length + 1} could not be fetched: ${error instanceof Error ? error.message : String(error)}`
      break
    }
  }
  if (!artifactPaths.length && job.localOutputPath) artifactPaths.push(job.localOutputPath)
  if (!artifactPaths.length) return { landed: false, error: failure ?? 'no frame artifacts could be landed' }

  // First-party scoring (deterministic): decode the frames, prefer the
  // directed tail when the profile says so, subject-reference affinity when
  // the session's refs are servable. Scoring failure never blocks landing.
  let verdict: ScorerVerdict | null = null
  try {
    const pixels: FramePixels[] = []
    for (const path of artifactPaths) {
      const url = path.startsWith('/api/') ? path : `/api/lan/media?source=output&path=${encodeURIComponent(path)}`
      const decoded = await decodeImage(url)
      if (!decoded) throw new Error(`frame ${pixels.length + 1} did not decode`)
      pixels.push(decoded)
    }
    if (pixels.length) {
      const session = readSessionSettings(chain.settings)
      const referenceUrls: string[] = []
      for (const slot of session.refs) {
        if (slot.role !== 'subject' || slot.source.kind !== 'canvas') continue
        const source = slot.source
        const owner = chain.outputs
          .flatMap((output) => output.takes.map((take) => ({ output, take })))
          .find((entry) => (source.takeId ? entry.take.id === source.takeId : entry.output.id === source.outputId))
        const frames = takeFrames(owner?.take ?? null)
        const first = frames.find((frame) => frame.blob ?? frame.path)
        if (first?.blob) referenceUrls.push(`/api/lan/documents/blobs/file?path=${encodeURIComponent(first.blob)}`)
        else if (first?.path) referenceUrls.push(`/api/lan/media?source=output&path=${encodeURIComponent(first.path)}`)
      }
      const references: FramePixels[] = []
      for (const url of referenceUrls.slice(0, 3)) {
        const decoded = await decodeImage(url)
        if (decoded) references.push(decoded)
      }
      verdict = scoreFrames(pixels, {
        directedTail: provenance.tier === 39,
        ...(references.length ? { referenceFrames: references } : {}),
      })
    }
  } catch {
    verdict = null
  }

  const metrics: Record<string, unknown> = {
    kind: 'image',
    duration: 0,
    width: job.width,
    height: job.height,
    sourcePath: artifactPaths[0],
    outputUrl: job.outputUrl ?? null,
    ...(failure ? { landingError: failure, framesLanded: artifactPaths.length } : {}),
    h3img: {
      ...provenance,
      frames: artifactPaths.length,
      canonicalFrameIndex: verdict ? verdict.bestIndex : 0,
      scorer: verdict ? { bestIndex: verdict.bestIndex, reason: verdict.reason, metricBasis: verdict.metricBasis } : null,
    },
  }

  let outputId = chain.outputs[0]?.id ?? null
  if (!outputId) outputId = await input.ensureOutput(chain.id)
  await documentsApi.appendTake({
    outputId,
    jobId: job.id,
    artifacts: artifactPaths,
    metrics,
  })
  return { landed: true }
}

/** The settings-echo helper the surface uses after landing (session store
 * refresh reads the new take through the ordinary document reload). */
export function workbenchTakeSummary(job: GenerationJob): { frames: number; family: string } | null {
  const provenance = workbenchJobProvenance(job)
  if (!provenance) return null
  return { frames: typeof provenance.frames === 'number' ? provenance.frames : 0, family: typeof provenance.family === 'string' ? provenance.family : '' }
}
