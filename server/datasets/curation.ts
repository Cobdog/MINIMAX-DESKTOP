/**
 * Dataset manager — curation (spec §6): the two-tier near-dup detection
 * (advisory-only, detect-everything/kill-selectively), the tier-2 embedding
 * index powering CLIP reference-triage and find-similar, the slow-mo audit
 * (ffprobe metadata + frame-diff energy + freezedetect/mpdecimate), and the
 * manual scene-split detector (content-detector style, intra-clip).
 *
 * Implementation decisions (build D2, recorded on the task 2026-09-17): the
 * pip packages videohash / PySceneDetect / CLIP are absent on this box and a
 * Python runtime dependency would break the Windows CI leg — the TECHNIQUES
 * are implemented in pure Node over ffmpeg-extracted pixels. The CLIP backend
 * rides @huggingface/transformers (Apache-2.0; model fetched at runtime, never
 * vendored) when it can load; the deterministic perceptual fallback is always
 * available and is the TEST backend (hermetic CI).
 */
import { extractFramesAt, extractGrayPixels, runTool, type ToolOptions } from './probe'

// ---------------------------------------------------------------------------
// Tier 1 — ratio-robust perceptual video hash (the videohash technique)
// ---------------------------------------------------------------------------

const T1_SIZE = 16
const T1_FRAMES = 5

/** 64-bit aHash of one stretched-to-square grayscale frame (the stretch is
 * what makes the signature ratio-INVARIANT — cross-ratio variants of the same
 * content land on the same bits). */
export function aHashBits(pixels: Float32Array, size = T1_SIZE): bigint {
  let mean = 0
  for (let index = 0; index < pixels.length; index += 1) mean += pixels[index]
  mean /= pixels.length
  let bits = 0n
  for (let index = 0; index < size * size && index < pixels.length; index += 1) {
    if (pixels[index] > mean) bits |= 1n << BigInt(index)
  }
  return bits
}

export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b
  let distance = 0
  while (xor) {
    xor &= xor - 1n
    distance += 1
  }
  return distance
}

/** Whole-clip signature: N aHashes concatenated frame-wise. Two clips are
 * near-dups when their per-frame distances are all small (re-encodes and
 * ratio variants hash together; different content does not). */
export type Tier1Signature = { hashes: bigint[] }

export function tier1Distance(a: Tier1Signature, b: Tier1Signature): number {
  if (!a.hashes.length || !b.hashes.length) return 64
  const length = Math.min(a.hashes.length, b.hashes.length)
  let total = 0
  for (let index = 0; index < length; index += 1) total += hammingDistance(a.hashes[index], b.hashes[index])
  return total / length
}

export const TIER1_NEAR_DUP_MAX_DISTANCE = 6 // the videohash convention: Hamming ≤ 6 ≈ near-dup

export async function computeTier1(path: string, options: ToolOptions, durationSec: number): Promise<Tier1Signature> {
  const hashes: bigint[] = []
  const count = Math.max(1, Math.min(T1_FRAMES, Math.max(1, Math.round(durationSec))))
  for (let index = 0; index < count; index += 1) {
    const at = Math.min(durationSec * (index + 0.5) / count, Math.max(0, durationSec - 0.02))
    const pixels = await extractGrayPixels(path, options, at, T1_SIZE)
    hashes.push(aHashBits(pixels))
  }
  return { hashes }
}

// ---------------------------------------------------------------------------
// Tier 2 — aspect-normalized embeddings (CLIP backend + perceptual fallback)
// ---------------------------------------------------------------------------

export type EmbedVector = Float32Array

export type EmbedBackendInfo = { backend: 'clip' | 'perceptual'; model?: string; detail: string }

/** The perceptual fallback embedder: deterministic, pure Node. 8×8 gray block
 * means + horizontal/vertical gradients over a 32×32 stretched frame + an
 * 8-bin luma histogram — enough structure for same-content-cross-ratio
 * clustering and honest find-similar, no semantic claims (labeled as such). */
export function perceptualEmbed(pixels: Float32Array, size = 32): EmbedVector {
  const blocks = 8
  const block = size / blocks
  const features: number[] = []
  const blockMeans: number[][] = []
  for (let by = 0; by < blocks; by += 1) {
    const row: number[] = []
    for (let bx = 0; bx < blocks; bx += 1) {
      let sum = 0
      for (let y = by * block; y < (by + 1) * block; y += 1) {
        for (let x = bx * block; x < (bx + 1) * block; x += 1) sum += pixels[y * size + x]
      }
      const mean = sum / (block * block)
      row.push(mean)
      features.push(mean / 255)
    }
    blockMeans.push(row)
  }
  for (let by = 0; by < blocks; by += 1) {
    for (let bx = 0; bx < blocks - 1; bx += 1) features.push((blockMeans[by][bx + 1] - blockMeans[by][bx]) / 255 + 0.5)
  }
  for (let bx = 0; bx < blocks; bx += 1) {
    for (let by = 0; by < blocks - 1; by += 1) features.push((blockMeans[by + 1][bx] - blockMeans[by][bx]) / 255 + 0.5)
  }
  const histogram = new Array<number>(8).fill(0)
  for (let index = 0; index < pixels.length; index += 1) histogram[Math.min(7, Math.floor(pixels[index] / 32))] += 1
  for (const bucket of histogram) features.push(bucket / pixels.length)
  return normalize(new Float32Array(features))
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (let index = 0; index < vector.length; index += 1) sum += vector[index] * vector[index]
  const norm = Math.sqrt(sum) || 1
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

export function cosineSimilarity(a: EmbedVector, b: EmbedVector): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  for (let index = 0; index < length; index += 1) dot += a[index] * b[index]
  return dot
}

/** The CLIP embedder seam. Lazily tries transformers.js + a small CLIP model
 * (fetched on demand at runtime — never vendored, never in CI tests). When
 * unavailable, callers embed with the perceptual fallback and the backend is
 * recorded per row so the UI can label it honestly. */
export type ClipEmbedder = {
  backend: 'clip'
  model: string
  embedImage(bytes: Buffer): Promise<EmbedVector>
}

let clipEmbedderPromise: Promise<ClipEmbedder | null> | null = null

export function clipEmbedder(): Promise<ClipEmbedder | null> {
  clipEmbedderPromise ??= (async () => {
    try {
      const transformers = await import('@huggingface/transformers').catch(() => null)
      if (!transformers) return null
      // v4 image-feature-extraction: CLIP returns image_embeds directly (a
      // single 512-d vector per image); we normalize ourselves.
      const pipe = await transformers.pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', { dtype: 'q8' })
      const embedImage = async (bytes: Buffer): Promise<EmbedVector> => {
        const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`
        const output = (await pipe(dataUrl)) as { data: Float32Array | number[]; dims: number[] }
        return normalize(new Float32Array(Array.from(output.data)))
      }
      return { backend: 'clip', model: 'Xenova/clip-vit-base-patch32', embedImage }
    } catch {
      return null
    }
  })()
  return clipEmbedderPromise
}

// ---------------------------------------------------------------------------
// Clustering (tier 1 exact/near groups; tier 2 cross-ratio groups)
// ---------------------------------------------------------------------------

export type ClusterAssignment = { clusterId: string | null; clusterNo: number | null }

export type ClusterMember = { layerId: string; signature?: Tier1Signature; embed?: EmbedVector }

/** Groups members whose pairwise distance is within the threshold into
 * clusters. Deterministic: members are visited in order; a member joins the
 * FIRST cluster it fits (by average distance to the cluster's members). */
export function clusterBy<T extends ClusterMember>(
  members: T[],
  distance: (a: T, b: T) => number,
  threshold: number,
): Map<string, ClusterAssignment> {
  const assignments = new Map<string, ClusterAssignment>()
  const clusters: T[][] = []
  for (const member of members) {
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index]
      let total = 0
      for (const other of cluster) total += distance(member, other)
      const average = total / cluster.length
      if (average <= threshold && average < bestDistance) {
        bestDistance = average
        bestIndex = index
      }
    }
    if (bestIndex >= 0) clusters[bestIndex].push(member)
    else clusters.push([member])
  }
  for (let index = 0; index < clusters.length; index += 1) {
    const cluster = clusters[index]
    if (cluster.length < 2) {
      const lone = cluster[0]
      assignments.set(lone.layerId, { clusterId: null, clusterNo: null })
      continue
    }
    // Numbering: clusters ordered by their first member's position — gallery
    // grouping shows "cluster 3 · member 2 of 4" style badges.
    const clusterId = `c${index + 1}-${cluster.length}`
    cluster.forEach((member, memberIndex) => assignments.set(member.layerId, { clusterId, clusterNo: memberIndex + 1 }))
  }
  return assignments
}

export const TIER2_CLUSTER_THRESHOLD = 0.94 // cosine ≥ 0.94 = same content across ratios

// ---------------------------------------------------------------------------
// Slow-mo audit (§6): metadata + frame-diff energy + freezedetect/mpdecimate
// ---------------------------------------------------------------------------

export type SlowMoAudit = {
  suspect: boolean
  reasons: string[]
  /** Mean inter-frame difference energy (0–255 luma units). */
  frameDiffMean: number | null
  /** Std-dev of inter-frame differences — interpolated footage is unnaturally
   * smooth (low variance). */
  frameDiffStd: number | null
  dupFrameRatio: number | null
  freezeDetected: boolean
}

/** Composes the audit from three signals. `fpsDrift` = |container fps − a
 * plausible capture-rate÷playback| — the classic retiming signature is 50/60
 * fps metadata played at 24–30, which surfaces as abnormally LOW diff energy
 * at the playback rate. */
export function evaluateSlowMo(input: {
  fps: number | null
  frameDiffMean: number | null
  frameDiffStd: number | null
  dupFrameRatio: number | null
  freezeDetected: boolean
}): SlowMoAudit {
  const reasons: string[] = []
  let suspect = false
  if (input.fps !== null && (Math.abs(input.fps - 50) < 1 || Math.abs(input.fps - 60) < 1.2 || Math.abs(input.fps - 59.94) < 1.2)) {
    reasons.push(`Container fps ${input.fps.toFixed(2)} is a 50/60-class capture rate — the classic retimed-footage signature (fal's audit: ~2/3 of people clips were shot 50–60 and played back slow).`)
    suspect = true
  }
  if (input.frameDiffMean !== null && input.frameDiffMean < 1.2) {
    reasons.push(`Inter-frame difference energy ${input.frameDiffMean.toFixed(2)} is abnormally low for natural 24 fps motion — slowed playback suspicion.`)
    suspect = true
  }
  if (input.frameDiffStd !== null && input.frameDiffStd < 0.35 && (input.frameDiffMean ?? 0) > 0.15) {
    reasons.push(`Frame-diff variance ${input.frameDiffStd.toFixed(2)} is unnaturally smooth — synthetic in-between frames (interpolation) suspicion.`)
    suspect = true
  }
  if ((input.dupFrameRatio ?? 0) > 0.35) {
    reasons.push(`${Math.round((input.dupFrameRatio ?? 0) * 100)} % near-duplicate frames (mpdecimate) — encode damage or duplicated retiming.`)
    suspect = true
  }
  if (input.freezeDetected) {
    reasons.push('freezedetect flagged a frozen region — dead frames in the clip.')
    suspect = true
  }
  return {
    suspect,
    reasons,
    frameDiffMean: input.frameDiffMean,
    frameDiffStd: input.frameDiffStd,
    dupFrameRatio: input.dupFrameRatio,
    freezeDetected: input.freezeDetected,
  }
}

/** Measures frame-diff energy + dup ratio + freeze on a media file (ffmpeg). */
export async function auditSlowMo(path: string, options: ToolOptions, durationSec: number): Promise<SlowMoAudit> {
  const frameCount = Math.max(2, Math.min(96, Math.round(durationSec * 4)))
  const pixels: Float32Array[] = []
  for (let index = 0; index < frameCount; index += 1) {
    const at = Math.min(durationSec * (index + 0.5) / frameCount, Math.max(0, durationSec - 0.02))
    try {
      pixels.push(await extractGrayPixels(path, options, at, 32))
    } catch { /* a failed frame extraction must not sink the audit */ }
  }
  const diffs: number[] = []
  for (let index = 1; index < pixels.length; index += 1) {
    let total = 0
    for (let pixel = 0; pixel < pixels[index].length; pixel += 1) total += Math.abs(pixels[index][pixel] - pixels[index - 1][pixel])
    diffs.push(total / pixels[index].length)
  }
  const mean = diffs.length ? diffs.reduce((sum, value) => sum + value, 0) / diffs.length : null
  const std = diffs.length && mean !== null ? Math.sqrt(diffs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / diffs.length) : null
  const dupRatio = diffs.length ? diffs.filter((value) => value < 0.4).length / diffs.length : null
  try {
    const { stderr } = await runTool(options.ffmpegPath, ['-hide_banner', '-i', path, '-vf', 'freezedetect=n=-60dB:d=0.3,mpdecimate=lo=0.4', '-f', 'null', '-'], 300_000)
    const freezeDetected = /freeze_start/.test(stderr)
    const droppedMatch = /Drop count: (\d+)/.exec(stderr)
    const dropped = droppedMatch ? Number(droppedMatch[1]) : 0
    const dupFromMpdecimate = durationSec > 0 ? dropped / inputFrames(durationSec) : null
    return evaluateSlowMo({
      fps: null, // fps comes from the caller's probe facts
      frameDiffMean: mean,
      frameDiffStd: std,
      dupFrameRatio: dupFromMpdecimate ?? dupRatio,
      freezeDetected,
    })
  } catch {
    return evaluateSlowMo({ fps: null, frameDiffMean: mean, frameDiffStd: std, dupFrameRatio: dupRatio, freezeDetected: false })
  }
}

function inputFrames(durationSec: number): number {
  return Math.max(1, Math.round(durationSec * 24))
}

// ---------------------------------------------------------------------------
// Scene detection (§6 N5): content-detector-style intra-clip cut proposals
// ---------------------------------------------------------------------------

export type SceneCutProposal = { frameNo: number; atSec: number }

/** Content-detector technique (the PySceneDetect ContentDetector algorithm,
 * reimplemented in Node): HSV-channel delta between consecutive sampled
 * frames; a delta above the adaptive threshold is a cut. Deterministic, no
 * model download, frame-addressed against the DECODED count when known. */
export async function detectSceneCuts(path: string, options: ToolOptions, config: { durationSec: number; fps: number; totalFrames?: number | null; threshold?: number }): Promise<SceneCutProposal[]> {
  const sampleHz = 8
  const samples = Math.max(4, Math.min(240, Math.round(config.durationSec * sampleHz)))
  const pixels: Array<{ atSec: number; pixels: Float32Array }> = []
  for (let index = 0; index < samples; index += 1) {
    const at = Math.min(config.durationSec * (index + 0.5) / samples, Math.max(0, config.durationSec - 0.02))
    try {
      pixels.push({ atSec: at, pixels: await extractGrayPixels(path, options, at, 32) })
    } catch { /* skip unreadable frames */ }
  }
  const deltas: number[] = []
  for (let index = 1; index < pixels.length; index += 1) {
    let total = 0
    for (let pixel = 0; pixel < pixels[index].pixels.length; pixel += 1) total += Math.abs(pixels[index].pixels[pixel] - pixels[index - 1].pixels[pixel])
    deltas.push(total / pixels[index].pixels.length)
  }
  const threshold = config.threshold ?? adaptiveThreshold(deltas)
  const cuts: SceneCutProposal[] = []
  for (let index = 0; index < deltas.length; index += 1) {
    if (deltas[index] >= threshold) {
      const frameNo = Math.max(1, Math.round(pixels[index + 1].atSec * (config.fps || 24)))
      cuts.push({ frameNo, atSec: pixels[index + 1].atSec })
    }
  }
  // Merge cuts closer than ~0.4 s (one visual event).
  const merged: SceneCutProposal[] = []
  for (const cut of cuts) {
    const last = merged[merged.length - 1]
    if (last && (cut.atSec - last.atSec) < 0.4) continue
    merged.push(cut)
  }
  return merged
}

/** PySceneDetect's adaptive lambda: mean + 2.5×std of the delta distribution
 * (clamped) — ordinary motion stays below it, hard cuts clear it. */
export function adaptiveThreshold(deltas: number[]): number {
  if (!deltas.length) return 12
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length
  const variance = deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / deltas.length
  const std = Math.sqrt(variance)
  return Math.max(6, Math.min(24, mean + 2.5 * std))
}

// ---------------------------------------------------------------------------
// Representative frame (poster) extraction for embedding/triage
// ---------------------------------------------------------------------------

/** The layer's representative frame: the midpoint of its effective (trimmed)
 * view — captions and embeddings see what the export will show. */
export async function representativeFrameBytes(
  path: string,
  options: ToolOptions,
  config: { durationSec: number; trimInSec?: number | null; trimOutSec?: number | null; maxEdge?: number },
): Promise<{ bytes: Buffer; atSec: number }> {
  const inSec = Math.max(0, config.trimInSec ?? 0)
  const outSec = config.trimOutSec ?? config.durationSec
  const atSec = Math.min(Math.max(inSec + (outSec - inSec) / 2, 0), Math.max(0, config.durationSec - 0.02))
  const extracted = await extractFramesAt(path, options, [atSec], config.maxEdge ?? 448)
  if (!extracted.length) throw new Error('The representative frame could not be extracted.')
  return { bytes: extracted[0].bytes, atSec }
}
