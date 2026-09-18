/** Workbench app-side image ops (task k9vu6t0, spec §7/§8): the burst-fuse
 * robust frequency merge and the tone-lock frequency blend — deterministic
 * pixel DSP over RGBA arrays, no weights, no nodes, no engine.
 *
 * Both ops share one mechanism (the tone-lock kinship, burst research §4.1):
 * a box-blur band split where the TARGET keeps low frequencies and the
 * contributor supplies only its high-frequency band. The fuse adds the drift
 * gate — a neighbor contributes a tile only where its best integer-shift
 * match stays under the residual gate — and the never-worse-than-target
 * fallback: when no neighbor passes anywhere (or coverage is too low), the
 * output IS the target, unchanged, and the report says so.
 *
 * Pure: identical inputs produce identical outputs on every machine (fixed
 * iteration order, integer math at the boundaries). Covered by
 * scripts/test-h3img.cjs against crafted frames.
 */

export type Rgba = { width: number; height: number; data: Uint8ClampedArray | Uint8Array | number[] }

/** The tone-lock pins (astropuzzo's Detail Tone Lock recipe values, the
 * refine lane's documented operating point): the source stays authoritative
 * for lighting/color/dimensions; the refiner contributes detail. */
export const TONE_LOCK_PINS = {
  lockStrength: 0.85,
  detailStrength: 0.55,
  detailRadius: 32,
} as const

/** The burst-fuse pins (HDR+-lineage tile fusion, drift-gated). */
export const BURST_FUSE_PINS = {
  tileSize: 32,
  /** Integer-shift search radius (±px) for per-tile neighbor matching. */
  searchRadius: 4,
  /** Mean-abs-diff gate: a neighbor tile contributes only under this. */
  gateThreshold: 12,
  /** High-frequency contribution strength. */
  detailStrength: 0.5,
  /** Minimum contributing-tile fraction before the fallback fires. */
  minCoverage: 0.2,
} as const

/** Separable box blur of one channel plane at an integer radius. */
function boxBlur(plane: Float64Array, width: number, height: number, radius: number): Float64Array {
  if (radius < 1) return plane.slice()
  const window = radius * 2 + 1
  const horizontal = new Float64Array(plane.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let acc = 0
    for (let x = -radius; x <= radius; x += 1) acc += plane[row + Math.min(width - 1, Math.max(0, x))]
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = acc / window
      const leaving = Math.min(width - 1, Math.max(0, x - radius))
      const entering = Math.min(width - 1, Math.max(0, x + radius + 1))
      acc += plane[row + entering] - plane[row + leaving]
    }
  }
  const blurred = new Float64Array(plane.length)
  for (let x = 0; x < width; x += 1) {
    let acc = 0
    for (let y = -radius; y <= radius; y += 1) acc += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x]
    for (let y = 0; y < height; y += 1) {
      blurred[y * width + x] = acc / window
      const leaving = Math.min(height - 1, Math.max(0, y - radius))
      const entering = Math.min(height - 1, Math.max(0, y + radius + 1))
      acc += horizontal[entering * width + x] - horizontal[leaving * width + x]
    }
  }
  return blurred
}

function luma(image: Rgba): Float64Array {
  const plane = new Float64Array(image.width * image.height)
  for (let i = 0, p = 0; i < plane.length; i += 1, p += 4) {
    plane[i] = 0.299 * image.data[p] + 0.587 * image.data[p + 1] + 0.114 * image.data[p + 2]
  }
  return plane
}

/** One channel plane of an RGBA image. */
function channel(image: Rgba, offset: number): Float64Array {
  const plane = new Float64Array(image.width * image.height)
  for (let i = 0, p = offset; i < plane.length; i += 1, p += 4) plane[i] = image.data[p]
  return plane
}

function writeChannel(image: Rgba, offset: number, plane: Float64Array): void {
  for (let i = 0, p = offset; i < plane.length; i += 1, p += 4) {
    image.data[p] = Math.max(0, Math.min(255, Math.round(plane[i])))
  }
}

export type ToneLockResult = { image: Rgba; report: { lockStrength: number; detailStrength: number; radius: number } }

/**
 * The tone-lock frequency blend: `target` (the authoritative source — H3
 * output or the original frame) keeps its low frequencies, `refined` (any
 * refiner's output, including a manual re-upscaled one) supplies only the
 * high-frequency band, at `strength` proportions. Works with ANY refiner —
 * even a "wrong" refiner contributes only its detail band (the research's
 * de-risking argument for owning this op app-side).
 */
export function toneLockBlend(target: Rgba, refined: Rgba, settings: { lockStrength?: number; detailStrength?: number; radius?: number } = {}): ToneLockResult {
  const lockStrength = settings.lockStrength ?? TONE_LOCK_PINS.lockStrength
  const detailStrength = settings.detailStrength ?? TONE_LOCK_PINS.detailStrength
  const radius = Math.max(1, Math.round(settings.radius ?? TONE_LOCK_PINS.detailRadius))
  if (target.width !== refined.width || target.height !== refined.height) {
    throw new Error(`tone-lock needs same-sized images (target ${target.width}x${target.height}, refined ${refined.width}x${refined.height}) — align first.`)
  }
  const out: Rgba = { width: target.width, height: target.height, data: new Uint8ClampedArray(target.width * target.height * 4) }
  for (let offset = 0; offset < 4; offset += 1) {
    const targetPlane = channel(target, offset)
    const refinedPlane = channel(refined, offset)
    const targetLow = boxBlur(targetPlane, target.width, target.height, radius)
    const refinedLow = boxBlur(refinedPlane, target.width, target.height, radius)
    const merged = new Float64Array(targetPlane.length)
    for (let i = 0; i < merged.length; i += 1) {
      const low = targetLow[i] * lockStrength + refinedLow[i] * (1 - lockStrength)
      const high = (refinedPlane[i] - refinedLow[i]) * detailStrength
      merged[i] = low + high
    }
    writeChannel(out, offset, merged)
  }
  return { image: out, report: { lockStrength, detailStrength, radius } }
}

export type BurstFuseResult = {
  image: Rgba
  report: {
    /** Fraction of tiles where at least one neighbor passed the gate. */
    coverage: number
    /** Per-neighbor acceptance counts. */
    accepted: number[]
    /** True when the fallback fired: the output IS the target. */
    fallback: boolean
    gateThreshold: number
    tileSize: number
  }
}

function tileResidual(targetLuma: Float64Array, neighborLuma: Float64Array, width: number, height: number, tile: { x: number; y: number }, shift: { dx: number; dy: number }, size: number): number {
  let acc = 0
  let count = 0
  for (let y = 0; y < size; y += 1) {
    const ty = tile.y + y
    const ny = ty + shift.dy
    if (ty < 0 || ty >= height || ny < 0 || ny >= height) continue
    for (let x = 0; x < size; x += 1) {
      const tx = tile.x + x
      const nx = tx + shift.dx
      if (tx < 0 || tx >= width || nx < 0 || nx >= width) continue
      acc += Math.abs(targetLuma[ty * width + tx] - neighborLuma[ny * width + nx])
      count += 1
    }
  }
  return count ? acc / count : Number.POSITIVE_INFINITY
}

/**
 * Burst-fuse: sharpen the target from its packet neighbors. Per tile (with
 * an integer-shift alignment search), a neighbor whose best residual stays
 * under the drift gate contributes its high-frequency band; the target keeps
 * low frequencies everywhere. NEVER-WORSE fallback: when total coverage is
 * under the minimum, the output is the target unchanged and the report says
 * so — the only refine arm with no hallucination channel cannot invent
 * content, and with nothing to fuse it must not pretend.
 */
export function burstFuse(target: Rgba, neighbors: Rgba[], settings: { gateThreshold?: number; tileSize?: number; detailStrength?: number; minCoverage?: number } = {}): BurstFuseResult {
  const pins = BURST_FUSE_PINS
  const tileSize = Math.max(8, Math.round(settings.tileSize ?? pins.tileSize))
  const gateThreshold = settings.gateThreshold ?? pins.gateThreshold
  const detailStrength = settings.detailStrength ?? pins.detailStrength
  const minCoverage = settings.minCoverage ?? pins.minCoverage
  if (!neighbors.length) {
    return { image: target, report: { coverage: 0, accepted: [], fallback: true, gateThreshold, tileSize } }
  }
  const width = target.width
  const height = target.height
  const targetLuma = luma(target)
  const neighborLumas = neighbors.map((neighbor) => {
    if (neighbor.width !== width || neighbor.height !== height) throw new Error(`burst-fuse needs same-sized frames (neighbor ${neighbor.width}x${neighbor.height} vs target ${width}x${height}).`)
    return luma(neighbor)
  })

  const tilesX = Math.ceil(width / tileSize)
  const tilesY = Math.ceil(height / tileSize)
  const totalTiles = tilesX * tilesY
  const accepted = new Array<number>(neighbors.length).fill(0)
  const contributions: Array<{ tile: number; neighbor: number; dx: number; dy: number }> = []

  for (let tileY = 0; tileY < tilesY; tileY += 1) {
    for (let tileX = 0; tileX < tilesX; tileX += 1) {
      const tile = { x: tileX * tileSize, y: tileY * tileSize }
      let best: { neighbor: number; residual: number; dx: number; dy: number } | null = null
      for (let n = 0; n < neighborLumas.length; n += 1) {
        for (let dy = -pins.searchRadius; dy <= pins.searchRadius; dy += 1) {
          for (let dx = -pins.searchRadius; dx <= pins.searchRadius; dx += 1) {
            const residual = tileResidual(targetLuma, neighborLumas[n], width, height, tile, { dx, dy }, tileSize)
            if (!best || residual < best.residual) best = { neighbor: n, residual, dx, dy }
          }
        }
      }
      if (best && best.residual <= gateThreshold) {
        accepted[best.neighbor] += 1
        contributions.push({ tile: tileY * tilesX + tileX, neighbor: best.neighbor, dx: best.dx, dy: best.dy })
      }
    }
  }

  const coverage = contributions.length / totalTiles
  if (coverage < minCoverage) {
    return { image: target, report: { coverage, accepted, fallback: true, gateThreshold, tileSize } }
  }

  // Compose: target low frequencies everywhere; contributing tiles get the
  // winning neighbor's high-frequency band (spatially shifted by its
  // alignment) at detailStrength.
  const out: Rgba = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  const tileMap = new Map<number, { neighbor: number; dx: number; dy: number }>()
  for (const contribution of contributions) tileMap.set(contribution.tile, contribution)
  for (let offset = 0; offset < 4; offset += 1) {
    const targetPlane = channel(target, offset)
    const targetLow = boxBlur(targetPlane, width, height, 3)
    const merged = targetLow.slice()
    for (let tileY = 0; tileY < tilesY; tileY += 1) {
      for (let tileX = 0; tileX < tilesX; tileX += 1) {
        const match = tileMap.get(tileY * tilesX + tileX)
        if (!match) continue
        const neighborPlane = channel(neighbors[match.neighbor], offset)
        const neighborLow = boxBlur(neighborPlane, width, height, 3)
        for (let y = 0; y < tileSize; y += 1) {
          const ty = tileY * tileSize + y
          if (ty >= height) break
          const ny = ty + match.dy
          if (ny < 0 || ny >= height) continue
          for (let x = 0; x < tileSize; x += 1) {
            const tx = tileX * tileSize + x
            if (tx >= width) break
            const nx = tx + match.dx
            if (nx < 0 || nx >= width) continue
            const high = neighborPlane[ny * width + nx] - neighborLow[ny * width + nx]
            merged[ty * width + tx] = targetLow[ty * width + tx] + high * detailStrength
          }
        }
      }
    }
    writeChannel(out, offset, merged)
  }
  return { image: out, report: { coverage, accepted, fallback: false, gateThreshold, tileSize } }
}
