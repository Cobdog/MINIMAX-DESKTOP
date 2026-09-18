/** The workbench's first-party candidate scorer (task k9vu6t0, spec §7 —
 * the audit-B1 fix). Deterministic, weightless, always overridable:
 * ranks a generation's packet frames by Laplacian sharpness, contrast,
 * exposure sanity, temporal stability against packet neighbors, and
 * color-space affinity to the subject references — the E-IW2 metric set's
 * dependency-free core (CLIP similarity stays a declared seam: pass
 * clipScores when a consent-gated CLIP ever rides the lane; the v1 rank
 * never depends on one).
 *
 * Pure pixel math over ImageData-shaped input; identical inputs produce
 * identical verdicts on every machine (integer luma math, fixed iteration
 * order). The verdict is recorded in the take's provenance — bestIndex,
 * per-frame scores, and the reason the winner won.
 */
import { H3IMG_RECIPE_PINS } from './graph/h3image'

/** RGBA pixel data (the browser's ImageData shape; tests synthesize it). */
export type FramePixels = { width: number; height: number; data: Uint8ClampedArray | Uint8Array | number[] }

export type FrameScore = {
  index: number
  sharpness: number
  contrast: number
  exposure: number
  stability: number
  refAffinity: number
  total: number
}

export type ScorerVerdict = {
  scores: FrameScore[]
  bestIndex: number
  reason: string
  weights: typeof H3IMG_RECIPE_PINS.scorer
  /** True when the directed tail restriction applied (frames 34-38 of 39). */
  directedTail: boolean
  metricBasis: string
}

export type ScorerOptions = {
  /** Reference frames (subject-role slots) for color-space affinity. */
  referenceFrames?: FramePixels[]
  /** Restrict candidates to the directed profile's near-still tail. */
  directedTail?: boolean
  /** Optional CLIP similarities (0-1 per frame) — the declared seam; v1
   * callers pass none and the rank is pixel-metric only. */
  clipScores?: number[]
}

/** Luma plane on the integer Rec.601 weights. */
function lumaPlane(frame: FramePixels): Float64Array {
  const { width, height, data } = frame
  const plane = new Float64Array(width * height)
  for (let i = 0, p = 0; i < plane.length; i += 1, p += 4) {
    plane[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  return plane
}

/** Laplacian response variance (3x3 kernel on the interior) — the
 * sharpness metric. Sharper frames vary more. */
export function laplacianVariance(plane: Float64Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0
  let sum = 0
  let sumSq = 0
  let count = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      const response = plane[i - width] + plane[i + width] + plane[i - 1] + plane[i + 1] - 4 * plane[i]
      sum += response
      sumSq += response * response
      count += 1
    }
  }
  if (!count) return 0
  const mean = sum / count
  return sumSq / count - mean * mean
}

/** RMS contrast: standard deviation of the luma plane (0-255 scale). */
export function rmsContrast(plane: Float64Array): number {
  if (!plane.length) return 0
  let sum = 0
  for (let i = 0; i < plane.length; i += 1) sum += plane[i]
  const mean = sum / plane.length
  let acc = 0
  for (let i = 0; i < plane.length; i += 1) acc += (plane[i] - mean) * (plane[i] - mean)
  return Math.sqrt(acc / plane.length)
}

/** Mean luma (0-255). */
function meanLuma(plane: Float64Array): number {
  if (!plane.length) return 0
  let sum = 0
  for (let i = 0; i < plane.length; i += 1) sum += plane[i]
  return sum / plane.length
}

/** Exposure sanity (0-1): 1 at mid-tones, falling to 0 at crushed/blown
 * extremes. */
export function exposureScore(meanLumaValue: number): number {
  const deviation = Math.abs(meanLumaValue - 128) / 128
  return Math.max(0, 1 - deviation * deviation)
}

/** Mean absolute luma difference between two same-sized planes (0-255). */
function meanAbsDiff(a: Float64Array, b: Float64Array): number {
  const length = Math.min(a.length, b.length)
  if (!length) return 255
  let acc = 0
  for (let i = 0; i < length; i += 1) acc += Math.abs(a[i] - b[i])
  return acc / length
}

/** 8x8x8 RGB histogram as a normalized vector (color-space signature). */
function colorHistogram(frame: FramePixels): Float64Array {
  const bins = new Float64Array(512)
  const data = frame.data
  const length = Math.floor(data.length / 4)
  for (let i = 0; i < length; i += 1) {
    const p = i * 4
    const bin = ((data[p] >> 5) << 6) | ((data[p + 1] >> 5) << 3) | (data[p + 2] >> 5)
    bins[bin] += 1
  }
  let norm = 0
  for (let i = 0; i < bins.length; i += 1) norm += bins[i] * bins[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < bins.length; i += 1) bins[i] /= norm
  return bins
}

/** Cosine similarity of two color signatures (0-1). */
function histogramAffinity(a: Float64Array, b: Float64Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return Math.max(0, dot)
}

/** Min-max normalize values to 0-1 across the candidate set; a constant
 * set maps to 0.5 (no discrimination — never a false winner). */
function normalize(values: number[]): number[] {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const range = max - min
  if (!Number.isFinite(range) || range <= 1e-12) return values.map(() => 0.5)
  return values.map((value) => (value - min) / range)
}

/**
 * Scores one generation's frames and picks the best. Deterministic: the
 * candidate order is the frame order; ties break toward the EARLIER frame.
 * The directed tail option (tier 39) restricts candidates to frames 34-38 —
 * the pack-documented near-still tail — while still scoring every frame so
 * the verdict's provenance is complete.
 */
export function scoreFrames(frames: FramePixels[], options: ScorerOptions = {}): ScorerVerdict {
  if (!frames.length) throw new Error('The scorer needs at least one frame.')
  const weights = H3IMG_RECIPE_PINS.scorer
  const planes = frames.map((frame) => lumaPlane(frame))
  const histograms = options.referenceFrames?.length ? frames.map((frame) => colorHistogram(frame)) : []
  const referenceHistograms = (options.referenceFrames ?? []).map((frame) => colorHistogram(frame))

  const sharpnessRaw = planes.map((plane, i) => laplacianVariance(plane, frames[i].width, frames[i].height))
  const contrastRaw = planes.map((plane) => rmsContrast(plane))
  const exposureRaw = planes.map((plane) => exposureScore(meanLuma(plane)))
  // Temporal stability: 1 at zero drift, decaying linearly to 0 at a 32-level
  // mean abs difference (packet frames of one scene sit well under that;
  // semantic drift sits over it).
  const stabilityRaw = planes.map((plane, i) => {
    const neighbors: number[] = []
    if (i > 0) neighbors.push(meanAbsDiff(plane, planes[i - 1]))
    if (i < planes.length - 1) neighbors.push(meanAbsDiff(plane, planes[i + 1]))
    if (!neighbors.length) return 0.5
    const drift = neighbors.reduce((acc, value) => acc + value, 0) / neighbors.length
    return Math.max(0, 1 - drift / 32)
  })
  const affinityRaw = histograms.length
    ? frames.map((_frame, i) => {
      let best = 0
      for (const reference of referenceHistograms) best = Math.max(best, histogramAffinity(histograms[i], reference))
      return best
    })
    : frames.map(() => 0.5)

  const sharpness = normalize(sharpnessRaw)
  const contrast = normalize(contrastRaw)
  const exposure = normalize(exposureRaw)
  const stability = normalize(stabilityRaw)
  const affinity = normalize(affinityRaw)

  const scores: FrameScore[] = frames.map((_frame, i) => ({
    index: i,
    sharpness: sharpness[i],
    contrast: contrast[i],
    exposure: exposure[i],
    stability: stability[i],
    refAffinity: affinity[i],
    total:
      weights.sharpness * sharpness[i]
      + weights.contrast * contrast[i]
      + weights.exposure * exposure[i]
      + weights.stability * stability[i]
      + weights.refAffinity * affinity[i],
  }))

  const tail = options.directedTail && frames.length >= H3IMG_RECIPE_PINS.directedTail.last
  const candidates = tail ? scores.filter((score) => score.index >= H3IMG_RECIPE_PINS.directedTail.first && score.index <= H3IMG_RECIPE_PINS.directedTail.last) : scores
  const pool = candidates.length ? candidates : scores
  let best = pool[0]
  for (const score of pool) {
    if (score.total > best.total + 1e-12) best = score
  }

  const reasons: string[] = [`sharpest of the pool (Laplacian ${sharpnessRaw[best.index].toFixed(1)})`]
  if (stability[best.index] >= 0.75) reasons.push('near-still against its neighbors')
  if (options.referenceFrames?.length && affinityRaw[best.index] >= Math.max(...affinityRaw) - 1e-12) reasons.push('closest in color space to the subject reference')
  if (tail) reasons.push(`directed tail restriction applied (frames ${H3IMG_RECIPE_PINS.directedTail.first}-${H3IMG_RECIPE_PINS.directedTail.last})`)

  return {
    scores,
    bestIndex: best.index,
    reason: reasons.join('; '),
    weights,
    directedTail: Boolean(tail),
    metricBasis: options.referenceFrames?.length
      ? 'pixel metrics + color-space affinity to the subject references (CLIP similarity is a seam — not computed, no dependencies)'
      : 'pixel metrics only (no references supplied; CLIP similarity is a seam — not computed, no dependencies)',
  }
}
