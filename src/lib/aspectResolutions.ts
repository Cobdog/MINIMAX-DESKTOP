/**
 * AR-first resolution picking (maintainer ruling 2026-09-26, directive
 * 1e363ec0 item 4): "the list should be tied to an aspect ratio — each
 * aspect ratio has a list of supported or optimal resolutions."
 *
 * The lists are DERIVED from the model's grid constraints, not hand-typed.
 * Source of truth: the inference research library's capture of the stock
 * nodes (docs/library/comfyui-minimax-h3-overview.md; the engine contract
 * fixture carries the same widget schemas):
 *   - width/height ride the 32-px grid (INT widgets, step 32, min 32);
 *   - the native canvas is a 768px short edge — 1344x768 at ~16:9;
 *   - the pixel-area cap is 768x1344 = 1,032,192 px (the resolution
 *     selector's 1.0 MP step, 1376x768, sits ABOVE it and degrades).
 *
 * Derivation (pure, unit-asserted): for a ratio, the long edge is the
 * 32-grid snap of short x ratio; a rung survives only when its area stays
 * at/below the cap. The OPTIMAL pick is the native 768 short edge honoring
 * the area cap — for ultra-wide ratios the cap pulls the short edge down
 * (21:9 → 1504x640), which is the honest pick, not a silent 1792x768 that
 * the model never trained for. 'free' keeps arbitrary on-grid WxH.
 */

/** The stock node's width/height widget grid (step 32, min 32). */
export const H3_GRID = 32
/** The native canvas's short edge (the trained envelope). */
export const H3_SHORT_EDGE_NATIVE = 768
/** The native pixel-area cap: 768x1344. Above it the model degrades. */
export const H3_NATIVE_AREA_CAP = H3_SHORT_EDGE_NATIVE * 1344

export type AspectRatioId = '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9' | 'free'

export type AspectRatio = { id: AspectRatioId; label: string; w: number; h: number }

/** The common ratios the picker offers, in rail order. */
export const ASPECT_RATIOS: AspectRatio[] = [
  { id: '16:9', label: '16:9', w: 16, h: 9 },
  { id: '9:16', label: '9:16', w: 9, h: 16 },
  { id: '4:3', label: '4:3', w: 4, h: 3 },
  { id: '3:4', label: '3:4', w: 3, h: 4 },
  { id: '1:1', label: '1:1', w: 1, h: 1 },
  { id: '21:9', label: '21:9', w: 21, h: 9 },
]

const snapRound = (value: number) => Math.round(value / H3_GRID) * H3_GRID
const snapFloor = (value: number) => Math.floor(value / H3_GRID) * H3_GRID

function resolutionAtShortEdge(ratio: AspectRatio, shortEdge: number): string | null {
  const target = Math.max(ratio.w, ratio.h) / Math.min(ratio.w, ratio.h)
  const landscape = ratio.w >= ratio.h
  // Round-to-nearest first; when that overshoots the area cap, floor —
  // 16:9 at the native short edge lands 1365→1376 (over cap)→1344, the
  // official pick, exactly.
  let long = snapRound(shortEdge * target)
  if (long * shortEdge > H3_NATIVE_AREA_CAP) long = snapFloor(shortEdge * target)
  if (long < H3_GRID || long * shortEdge > H3_NATIVE_AREA_CAP) return null
  return landscape ? `${long}x${shortEdge}` : `${shortEdge}x${long}`
}

/** The OPTIMAL resolution for a ratio: the native 768 short edge honoring
 *  the area cap. Ultra-wide ratios step the short edge down by grid rungs
 *  until the cap holds (21:9 → 640 → 1504x640) — never a silent over-cap
 *  value. Returns null for 'free' (no ratio to optimize). */
export function optimalResolutionFor(ratioId: AspectRatioId): string | null {
  if (ratioId === 'free') return null
  const ratio = ASPECT_RATIOS.find((entry) => entry.id === ratioId)!
  for (let shortEdge = H3_SHORT_EDGE_NATIVE; shortEdge >= H3_GRID; shortEdge -= H3_GRID) {
    const candidate = resolutionAtShortEdge(ratio, shortEdge)
    if (candidate) return candidate
  }
  return null
}

export type ResolutionOption = { value: string; optimal: boolean }

/** The supported list for a ratio: the short-edge ladder (largest area
 *  first), every rung on the 32-grid and at/below the area cap, the
 *  OPTIMAL pick flagged. Empty for 'free'. */
export function resolutionsForRatio(ratioId: AspectRatioId): ResolutionOption[] {
  if (ratioId === 'free') return []
  const ratio = ASPECT_RATIOS.find((entry) => entry.id === ratioId)!
  const optimal = optimalResolutionFor(ratioId)
  const list: ResolutionOption[] = []
  for (let shortEdge = H3_SHORT_EDGE_NATIVE; shortEdge >= 448; shortEdge -= H3_GRID) {
    const candidate = resolutionAtShortEdge(ratio, shortEdge)
    if (candidate) list.push({ value: candidate, optimal: candidate === optimal })
  }
  return list
}

/** Every supported value across the ratios, deduped, ascending by area —
 *  the flat fallback surfaces (Settings defaults, the workbench) source
 *  their options here so no hand-typed list can drift from the derivation. */
export function allSupportedResolutions(): string[] {
  const seen = new Set<string>()
  for (const ratio of ASPECT_RATIOS) for (const option of resolutionsForRatio(ratio.id)) seen.add(option.value)
  return [...seen].sort((a, b) => {
    const [aw, ah] = a.split('x').map(Number)
    const [bw, bh] = b.split('x').map(Number)
    return aw * ah - bw * bh
  })
}

/** Parses a WxH resolution string; null when malformed. */
export function parseResolution(value: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(value.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : null
}

/** Snaps one free-mode dimension onto the grid (the free inputs' commit). */
export function snapResolutionDim(value: number): number {
  if (!Number.isFinite(value)) return H3_GRID
  return Math.min(16384, Math.max(H3_GRID, Math.round(value / H3_GRID) * H3_GRID))
}

/** A renderable resolution for the stock nodes: WxH, both dims on the 32
 *  grid, within the widgets' min/max (32..16384). The area cap is NOT
 *  enforced here — an over-cap pick is the user's explicit free choice
 *  (the picker warns; the sanitizer must not silently rewrite a stored
 *  chain). */
export function isRenderableResolution(value: string): boolean {
  const parsed = parseResolution(value)
  if (!parsed) return false
  return [parsed.width, parsed.height].every((dim) => dim >= H3_GRID && dim <= 16384 && dim % H3_GRID === 0)
}

/** Which ratio's supported list contains this resolution ('free' when none
 *  does — custom or legacy values like the turbo fast presets). */
export function ratioKeyOf(value: string): AspectRatioId {
  for (const ratio of ASPECT_RATIOS) {
    if (resolutionsForRatio(ratio.id).some((option) => option.value === value)) return ratio.id
  }
  return 'free'
}
