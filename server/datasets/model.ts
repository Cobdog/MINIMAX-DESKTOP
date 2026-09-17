/**
 * Dataset manager v1 — the pure model: constants, grid math, refusal floors,
 * the aspect spectrum, trainer VRAM profiles, and the QA gates (spec
 * docs/specs/dataset-manager-v1.md). Nothing in this module touches the
 * filesystem or ffmpeg: every rule here is exercised directly by tests.
 *
 * Grounding (all measured numbers from docs/research/h3-lora-training-envelope.md):
 *  - 17n+5 grid @ exactly 24.000 fps; the container-truncation trap is why we
 *    bake to grid target +2 frames and assert decoded ∈ [target, target+2].
 *  - Video floors: hard refuse < 160×96 (mechanical floor), warn < 320×192
 *    (practical motion floor; below ~224 short-side conditioning rows
 *    dominate). Stills floors are SPEC-inferred (warn < 512², refuse < 256²)
 *    — flagged as such in the spec §2.3 and surfaced in refusal reasons.
 *  - DiffSynX budget rule (envelope §1.2): VRAM[GB] ≈ 5.1 + 2.6 × Mtok where
 *    Mtok = (px × frames) / 1e7 — the decimal-GB fit that reproduces the
 *    envelope's measured table within ≈±8 % (e.g. 480×832×124 f: 17.98 GB
 *    projected vs 17,286 MiB measured). musubi carries its measured offset
 *    (+2,788 MiB at the 480×832×124 f reference geometry — 20,074 vs 17,286).
 */
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Frame grid (17n+5 @ 24.000 fps)
// ---------------------------------------------------------------------------

export const TRAINING_FPS = 24.0

/** All legal 17n+5 frame counts in the released training range (22 f … 345 f). */
export function gridTargets(minFrames = 22, maxFrames = 345): number[] {
  const targets: number[] = []
  for (let n = 1; ; n += 1) {
    const frames = 17 * n + 5
    if (frames > maxFrames) break
    if (frames >= minFrames) targets.push(frames)
  }
  return targets
}

/** The largest grid target ≤ frameCount (the trainer's clamp direction — it
 * walks DOWN, so a clip's effective grid target is the floor on the grid). */
export function gridTargetFor(frameCount: number): number | null {
  if (!Number.isFinite(frameCount) || frameCount < 22) return null
  const n = Math.floor((frameCount - 5) / 17)
  return Math.max(1, n) * 17 + 5
}

/** Trim length (frames) needed to bake `target` safely: target + 2 headroom
 * (the f56 trap antidote — the trainer's clamp walks down from +2 onto the
 * target instead of one rounded frame below it). */
export function bakeLengthFor(target: number): number {
  return target + 2
}

/** The decoded-frame-count assertion (spec §5 stage 4): decoded must land in
 * [target, target+2]. decoded < target is the f56 failure class (refuse with
 * the delta); decoded > target+2 means we baked long (also refused — the
 * trainer would clamp down, but our own conform was wrong). */
export function assertDecodedCount(target: number, decoded: number): { ok: boolean; reason?: string } {
  if (decoded < target) return { ok: false, reason: `Decoded ${decoded} frames is below the grid target ${target} by ${target - decoded} — the 17n+5 clamp would walk DOWN to ${gridTargetFor(decoded) ?? '<22'} frames (the f56 container-truncation class).` }
  if (decoded > target + 2) return { ok: false, reason: `Decoded ${decoded} frames exceeds target+2 (${target + 2}) — the bake conform is wrong.` }
  return { ok: true }
}

export const GRID_PX = 32

/** Snaps a crop edge length to the 32-px grid (min 32), keeping the rect
 * inside [0, limit] and the far edge grid-aligned. */
export function snapToGrid(value: number, limit: number): number {
  const snapped = Math.max(GRID_PX, Math.round(value / GRID_PX) * GRID_PX)
  return Math.min(snapped, Math.floor(limit / GRID_PX) * GRID_PX)
}

export type CropRect = { x: number; y: number; w: number; h: number }

/** Grid-aligns a crop rect inside a frame: edges on the 32-px grid, size at
 * least one grid cell per side, fully inside the frame. */
export function alignCropRect(rect: CropRect, width: number, height: number): CropRect {
  const maxX = Math.floor(width / GRID_PX) * GRID_PX
  const maxY = Math.floor(height / GRID_PX) * GRID_PX
  const w = snapToGrid(rect.w, maxX)
  const h = snapToGrid(rect.h, maxY)
  const x = Math.max(0, Math.min(Math.round(rect.x / GRID_PX) * GRID_PX, maxX - w))
  const y = Math.max(0, Math.min(Math.round(rect.y / GRID_PX) * GRID_PX, maxY - h))
  return { x, y, w, h }
}

/** Largest grid-aligned rect with aspect `ratio` (w/h) inside the frame,
 * anchored at the rect's current center. */
export function cropRectForRatio(anchor: CropRect, ratio: number, width: number, height: number): CropRect {
  const maxW = Math.floor(width / GRID_PX) * GRID_PX
  const maxH = Math.floor(height / GRID_PX) * GRID_PX
  let w = maxW
  let h = Math.round(w / ratio)
  if (h > maxH) {
    h = maxH
    w = Math.round(h * ratio)
  }
  w = snapToGrid(w, maxW)
  h = snapToGrid(h, maxH)
  // Re-derive h from the snapped w so the ratio survives grid snapping as
  // closely as the grid allows (the crop is exact-ratio at full res; the
  // trainer bucket does the mechanical scaling).
  const cx = anchor.x + anchor.w / 2
  const cy = anchor.y + anchor.h / 2
  return alignCropRect({ x: cx - w / 2, y: cy - h / 2, w, h }, width, height)
}

// ---------------------------------------------------------------------------
// Refusal floors (spec §2.3)
// ---------------------------------------------------------------------------

export type FloorVerdict = { verdict: 'ok' | 'warn' | 'refuse'; reason?: string }

export const VIDEO_FLOOR_HARD = { w: 160, h: 96 }
export const VIDEO_FLOOR_WARN = { w: 320, h: 192 }
export const STILL_FLOOR_WARN = 512 * 512
export const STILL_FLOOR_HARD = 256 * 256

/** The floors are frame floors (spec §2.3): hard refuse below the mechanical
 * 160×96 (short < 96 or long < 160); warn below the practical 320×192 motion
 * floor (below ~224 short-side, conditioning rows start dominating —
 * measured). At-or-above 320×192 passes. */
export function videoFloorVerdict(width: number, height: number): FloorVerdict {
  const short = Math.min(width, height)
  const long = Math.max(width, height)
  if (short < VIDEO_FLOOR_HARD.h || long < VIDEO_FLOOR_HARD.w) {
    return { verdict: 'refuse', reason: `Too small for training: ${width}×${height} is below the measured mechanical floor 160×96 (envelope: min viable motion res is 320×192 practical). Upscale-on-refuse is deferred; the source is refused honestly.` }
  }
  if (short < VIDEO_FLOOR_WARN.h || long < VIDEO_FLOOR_WARN.w) {
    return { verdict: 'warn', reason: `${width}×${height} is below the practical motion floor 320×192 (below ~224 short-side, conditioning rows start dominating the sequence — measured). Training works; balance the set accordingly.` }
  }
  return { verdict: 'ok' }
}

/** Stills floors are SPEC-inferred defaults (not measured) — the refusal text
 * says so, per spec §2.3's honesty flag. */
export function stillFloorVerdict(width: number, height: number): FloorVerdict {
  const px = width * height
  const short = Math.min(width, height)
  if (px < STILL_FLOOR_HARD || short < 256) {
    return { verdict: 'refuse', reason: `Too small for training: ${width}×${height} (${px.toLocaleString()} px) is below the stills hard floor 256² (SPEC-inferred default, not measured — the guide's validated character recipe is 512²).` }
  }
  if (px < STILL_FLOOR_WARN || short < 512) {
    return { verdict: 'warn', reason: `${width}×${height} is below 512² — the guide's validated identity-recipe size (stills floors are SPEC-inferred defaults). 512→768 adds nothing when the subject fills the frame.` }
  }
  return { verdict: 'ok' }
}

export function floorVerdict(kind: 'video' | 'image', width: number, height: number): FloorVerdict {
  return kind === 'video' ? videoFloorVerdict(width, height) : stillFloorVerdict(width, height)
}

// ---------------------------------------------------------------------------
// The managed aspect spectrum (spec §3)
// ---------------------------------------------------------------------------

export type AspectEntry = {
  id: string
  /** width/height ratio (21:9 ≈ 2.333). */
  ratio: number
  label: string
  official: boolean
  enabled: boolean
  /** Spectrum order: position in the widest→tallest list. */
  position: number
}

/** The official-range spectrum (the model's 21:9–9:16 output range, guide
 * §3.3). Officials are always present, individually enable/disable-able, and
 * NEVER deletable (blessing amendment 2026-09-17). */
export const OFFICIAL_ASPECTS: Array<{ label: string; ratio: number }> = [
  { label: '21:9', ratio: 21 / 9 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '1:1', ratio: 1 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '9:16', ratio: 9 / 16 },
]

/** The mirror of a ratio, if the mirrored value exists in the enabled list
 * (16:9↔9:16, 4:3↔3:4, 1:1↔itself; a custom 2:1 mirrors to 1:2 only when a
 * 1:2 entry exists — middle-click never invents ratios). */
export function mirrorAspect(ratio: number, enabled: AspectEntry[]): AspectEntry | null {
  const mirrored = 1 / ratio
  const epsilon = 0.004
  return enabled.find((entry) => Math.abs(entry.ratio - mirrored) < epsilon && Math.abs(entry.ratio - ratio) > epsilon) ?? null
}

// ---------------------------------------------------------------------------
// Trainer VRAM profiles (spec §7; envelope §1.2 budget rule)
// ---------------------------------------------------------------------------

export type TrainerId = 'diffsynx' | 'musubi'

export type VramProjection = {
  trainer: TrainerId
  /** Projected per-item peak in decimal GB (the envelope's unit). */
  projectedGb: number
  projectedMiB: number
}

export const VRAM_WALL_GB = 23.5
export const VRAM_WARN_GB = 22.0

/** Mtok for the budget rule: (px × frames) / 1e7 — the fit unit that
 * reproduces the envelope's measured table (see module header). */
export function megaTokens(px: number, frames: number): number {
  return (px * frames) / 1e7
}

/** DiffSynX DiT-LoRA profile: VRAM[GB] ≈ 5.1 + 2.6 × Mtok (envelope §1.2). */
export function diffsynxProjectionGb(px: number, frames: number): number {
  return 5.1 + 2.6 * megaTokens(px, frames)
}

/** musubi profile: the DiffSynX fit + the measured offset at the reference
 * geometry (20,074 − 17,286 MiB at 480×832×124 f — envelope §1.7). The only
 * musubi measurement we have; applied as a constant offset and labeled as
 * such in the dashboard. */
export const MUSUBI_OFFSET_MIB = 20_074 - 17_286

export function trainerProjections(px: number, frames: number): Record<TrainerId, VramProjection> {
  const diffsynxGb = diffsynxProjectionGb(px, frames)
  const musubiGb = diffsynxGb + MUSUBI_OFFSET_MIB / 1000
  return {
    diffsynx: { trainer: 'diffsynx', projectedGb: diffsynxGb, projectedMiB: diffsynxGb * 1000 / 1.048576 },
    musubi: { trainer: 'musubi', projectedGb: musubiGb, projectedMiB: (diffsynxGb * 1000 + MUSUBI_OFFSET_MIB) / 1.048576 },
  }
}

/** Per-item geometry walls (envelope §1.2): warn past the comfort tier,
 * hard-stop at the measured walls. */
export function geometryWall(px: number, frames: number): 'ok' | 'warn' | 'stop' {
  const width = Math.sqrt(px) // callers pass real dims via px only for the
  // budget rule; the walls below are frame-count walls at resolution tiers,
  // expressed directly on (px, frames).
  void width
  if (frames > 345) return 'stop'
  if (frames > 124 && px > 544 * 320) return 'stop'
  if (frames > 124 && px <= 544 * 320) return frames > 345 ? 'stop' : 'ok'
  if (frames > 39 && px > 768 * 1344) return 'stop'
  if (frames > 124) return 'warn' // 124 f tier at untested resolution
  if (px > 768 * 1344) return 'warn'
  return 'ok'
}

// ---------------------------------------------------------------------------
// fps normalization policy (spec §5 stage 3 — the audit-M2 conditional)
// ---------------------------------------------------------------------------

export type FpsPlan =
  | { mode: 'retime'; from: number; factor: number; reason: string }
  | { mode: 'dropdup'; from: number; reason: string }
  | { mode: 'interpolate'; from: number; reason: string }
  | { mode: 'passthrough'; from: number; reason: string }

/** The retime tolerance: 23.976 (−0.1 %) and 25 (+4.17 %) both land inside
 * it — the research's near-24 condition (audit M2). Beyond it, faster-than-24
 * sources drop/dup (speed preserved); slower-than-24 sources are real gaps →
 * interpolation, LAST resort, tagged. */
export const RETIME_TOLERANCE = 0.042

export function planFps(sourceFps: number): FpsPlan {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return { mode: 'interpolate', from: sourceFps, reason: 'No usable source fps — interpolation is the only path to 24.000.' }
  const drift = Math.abs(sourceFps - TRAINING_FPS) / TRAINING_FPS
  if (drift <= RETIME_TOLERANCE) {
    return {
      mode: 'retime',
      from: sourceFps,
      factor: sourceFps / TRAINING_FPS,
      reason: `Source ${sourceFps.toFixed(3)} fps is within ±4.2 % of 24 — speed retime (lossless pixels, no synthetic frames).`,
    }
  }
  const ratio = sourceFps / TRAINING_FPS
  if (sourceFps > TRAINING_FPS) {
    return { mode: 'dropdup', from: sourceFps, reason: `Source ${sourceFps.toFixed(3)} fps is ${ratio.toFixed(2)}× 24 — drop/dup downsampling preserves natural speed (30→24 and 60→24 territory).` }
  }
  return { mode: 'interpolate', from: sourceFps, reason: `Source ${sourceFps.toFixed(3)} fps is a real gap below 24 — motion-compensated interpolation (tagged; retiming up would slow the motion ${ratio.toFixed(2)}×).` }
}

// ---------------------------------------------------------------------------
// Trigger-token validation (spec §4; the gate-8 definition)
// ---------------------------------------------------------------------------

/** A compact English frequency list — the common-dictionary words the gate
 * rejects as triggers (a trigger must be rare: the guide's community practice
 * is obfuscated single tokens like `ph0t0r34l`). This is the top of the
 * general-service list, enough to catch the obvious cases without shipping a
 * corpus. */
export const COMMON_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with', 'about', 'into', 'to', 'from', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall', 'not', 'no', 'yes', 'so', 'as', 'than', 'then', 'that', 'this', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'we', 'us', 'our', 'you', 'your', 'i', 'me', 'my', 'who', 'whom', 'which', 'what', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'now', 'here', 'there', 'also', 'very', 'one', 'two', 'three', 'video', 'clip', 'scene', 'shot', 'frame', 'man', 'woman', 'girl', 'boy', 'person', 'people', 'camera', 'light', 'lighting', 'close', 'up', 'view', 'wide', 'angle', 'slow', 'fast', 'motion', 'moving', 'walking', 'standing', 'sitting', 'talking', 'speaking', 'looking', 'white', 'black', 'red', 'blue', 'green', 'hair', 'eyes', 'face', 'hand', 'hands', 'body', 'room', 'outdoor', 'indoor', 'street', 'city', 'sky', 'water', 'sound', 'audio', 'music', 'silence', 'silent', 'style', 'character', 'real', 'realistic', 'photo', 'film', 'cinematic', 'animation', 'animated', 'quality', 'high', 'low',
])

export type TriggerVerdict = { ok: boolean; issues: string[] }

/** The gate-8 definition: single token, rare (not a common word), used
 * exactly once, and first. Live in the editor; enforced at export. */
export function validateTrigger(token: string, caption: string): TriggerVerdict {
  const issues: string[] = []
  const trimmed = token.trim()
  if (!trimmed) return { ok: false, issues: ['No trigger token is set for this dataset.'] }
  if (/\s/.test(trimmed)) issues.push(`The trigger "${trimmed}" must be a single token (community practice: obfuscated rare tokens like ph0t0r34l — one stable token per repeating concept).`)
  const lowered = trimmed.toLowerCase()
  if (COMMON_WORDS.has(lowered)) issues.push(`The trigger "${trimmed}" is a common word — rare triggers bind identity; common words are already spread across the vocabulary.`)
  if (caption.trim()) {
    const words = caption.trim().split(/\s+/)
    const first = words[0]?.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase()
    if (first !== lowered) issues.push(`The trigger must be FIRST in the caption (found "${words[0]}" first).`)
    const count = words.filter((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase() === lowered).length
    if (count > 1) issues.push(`The trigger appears ${count} times — exactly once, prepended; baking it in AND prepending degrades prompt adherence.`)
    if (count === 0) issues.push('The trigger does not appear in this caption — prepend it exactly once.')
  }
  return { ok: issues.length === 0, issues }
}

// ---------------------------------------------------------------------------
// Per-class caption templates (guide §4.4; character's negative rule is the
// documented make-or-break for identity LoRAs)
// ---------------------------------------------------------------------------

export type ContentClass = 'style' | 'character' | 'motion'

export const CAPTION_TEMPLATES: Record<ContentClass, { template: string; negativeRules?: string[] }> = {
  style: {
    template: '<trigger>, <official style word(s)>, <subject doing action> in <setting>, <lighting>, <camera motion phrase>. Soundscape clause when audio is real.',
  },
  character: {
    template: '<trigger>, <generic subject token> — clips: <trigger>, <person> <action/pose> in <setting>. One flowing paragraph, natural language only.',
    negativeRules: [
      'NEVER describe hair color or length', 'NEVER describe eye color', 'NEVER describe face shape', 'NEVER describe outfit identity',
      'Appearance flows through the trigger; those details re-enter at inference.',
    ],
  },
  motion: {
    template: '<trigger>, <subject> <single repeated movement phrase with official camera verb + amplitude + speed>, <setting>.',
  },
}

/** Character-class appearance words the editor + gates flag (guide §4.4/§4.6:
 * sepiablue's failed→fixed replication — descriptive captions killed identity). */
export const APPEARANCE_MARKERS = [
  /\b(long|short|medium|wavy|straight|curly|blonde|blond|brunette|redhead|ginger|black|white|gray|grey|silver|brown|auburn|dyed)\s+hair\b/i,
  /\b(blue|green|brown|hazel|gray|grey|amber|dark|light)\s+eyes\b/i,
  /\b(pale|fair|dark|tanned|olive)\s+skin\b/i,
  /\b(wearing|dressed in|outfit|costume|clothing|dress|shirt|jacket|hoodie|suit|gown|blouse|skirt|trousers|jeans)\b/i,
  /\b(round|oval|square|sharp|soft|narrow|wide)\s+face\b/i,
]

export function appearanceViolation(caption: string): string | null {
  for (const marker of APPEARANCE_MARKERS) {
    const match = marker.exec(caption)
    if (match) return match[0]
  }
  return null
}

// ---------------------------------------------------------------------------
// Soundscape / audio policy (spec §10)
// ---------------------------------------------------------------------------

export type AudioPolicy = {
  /** Gate 7 fires only when this is set: the dataset's own expectation that
   * real-audio rows carry a soundscape clause. */
  expectSoundscapeClauses: boolean
  /** Optional blank-replace of existing audio (junk audio) at bake. */
  blankReplaceExisting: boolean
}

export const DEFAULT_AUDIO_POLICY: AudioPolicy = { expectSoundscapeClauses: true, blankReplaceExisting: false }

/** The musubi consistency rule: still/one-frame rows and silent rows STATE
 * sound absence ("silence, no audible sound" class phrasing), never imply it. */
export const SILENCE_STATEMENT = /no (?:audible )?(?:sound|audio)|silent|without sound|in silence|soundscape is silence/i

// ---------------------------------------------------------------------------
// Recipe card (spec §9 — class-conditioned, a hint document)
// ---------------------------------------------------------------------------

export type RecipeCard = {
  trainer: TrainerId
  contentClass: ContentClass
  rank: string
  alphaRule: string
  learningRate: string
  stepsBand: string
  dedistillation: string
  notes: string[]
}

export function recipeCard(trainer: TrainerId, contentClass: ContentClass, clipCount: number, stillCount: number): RecipeCard {
  const rank = contentClass === 'motion' ? '16–32 (motion needs slightly more capacity; 16 default, 32 when underfitting)' : '16 (community head-to-head: 16 beat 32 and 64 for style/character)'
  const base: RecipeCard = {
    trainer,
    contentClass,
    rank,
    alphaRule: 'alpha = rank, always (every source pins it; DiffSynX hard-defaults alpha to rank when unset)',
    learningRate: contentClass === 'character' ? '3e-4 + warmup 50 (musubi subject-reference teacher recipe) or 1e-4 on the adapter path' : '1e-4 (slow-cook; 2e-4 converges faster for short runs)',
    stepsBand: stepsBandFor(contentClass, clipCount + stillCount),
    dedistillation: 'REQUIRED for any 500+ step run — plain flow-matching washes out the CFG-distilled base. DiffSynX: --training_cfg_scale 4 or a DeCFG preset adapter (needs a BF16 DiT); musubi: --base_weights adapter or guidance-loss (--h3_guidance_loss_scale 4.0).',
    notes: [
      'Batch size must be 1 (both trainers hard-reject batch ≠ 1); use gradient accumulation for effective batch.',
      'Frames on the 17n+5 grid at exactly 24.000 fps; dims multiples of 32.',
      'adamw8bit on 24 GB (the cheapest big save); bf16; gradient checkpointing MANDATORY (GC-off OOMs at every rung).',
      'Save intermediate checkpoints every 250 steps — the strongest checkpoint is routinely mid-run.',
      contentClass === 'character' ? 'dc_weight 0.3 (stop dataset palette leaking into the identity LoRA); keep 1.0 for style.' : 'dc_weight 1.0 for style (the dataset palette IS the signal).',
    ],
  }
  if (trainer === 'musubi') {
    base.notes.push('musubi caches REAL audio natively (sidecar wav); sub-124 f clips need --allow_experimental_duration (outside the released 5–15 s range).')
  } else {
    base.notes.push('DiffSynX accepts any 17n+5 grid value; --num_frames is validated 17n+5 at launch (hard error otherwise).')
  }
  return base
}

function stepsBandFor(contentClass: ContentClass, items: number): string {
  if (contentClass === 'character') return '≈500 (strongest checkpoints at/just after the teaching-band plateau; save intermediates)'
  if (items <= 60) return '≈1500 steps'
  if (items <= 120) return '1500–3000 steps (scale steps with the dataset; 5000 overfit a ~50-clip set, won after tripling data)'
  return '3000–5000 steps'
}

// ---------------------------------------------------------------------------
// Content hashes — identity tracking (xxhash128 at the store layer; sha256
// here for byte-immortality assertions in tests)
// ---------------------------------------------------------------------------

export function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// Grid bucket badge (spec §11: per-layer res×duration class against §7 walls)
// ---------------------------------------------------------------------------

export type BucketBadge = { label: string; frames: number; px: number; wall: 'ok' | 'warn' | 'stop' }

export function bucketBadge(width: number, height: number, frames: number): BucketBadge {
  const px = width * height
  return { label: `${width}×${height}·${frames}f`, frames, px, wall: geometryWall(px, frames) }
}
