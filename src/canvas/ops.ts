/**
 * Canvas Phase 3 — the op-stack model (§5.1 modal editor + op stacks).
 *
 * PURE module: the op kinds the v1 modal editor ships (crop — ImageCrop's
 * non-destructive data as the first op; rotate; brush mask — strokes stored
 * normalized so the stack stays replayable; ctx.filter adjustments — CSS
 * filter as the visual proxy, per the spec's own wording; trim — the
 * VideoReferenceClipper's 2–15 s section; upscale / stabilize / color-grade
 * from the research stack), tolerant settings reads (documents are external
 * data), the live-preview composition (L3 DECIDED: live-update — the tile's
 * preview re-styles as ops change), and the reorder permutation helper.
 *
 * No React, no DOM, no stores — covered by scripts/test-canvas.cjs through
 * the VM harness, the Phase-1/2 precedent.
 */
import type { UpscaleMode } from '../types'

// ---- op kinds ------------------------------------------------------------------

export type OpKind = 'crop' | 'rotate' | 'mask' | 'adjust' | 'trim' | 'upscale' | 'stabilize' | 'color-grade' | 'h3img.tone-lock'

export type OpAppliesTo = 'image' | 'video' | 'both'

export type OpMeta = {
  kind: OpKind
  label: string
  applies: OpAppliesTo
  note: string
}

/** The v1 op registry (§2.1 "crop, mask, trim, adjust, control track,
 *  stabilize" + the §5.1 set). `control track` arrives as its own document
 *  row (canvas_control_track — the pose rig writes those), not an op. */
export const OP_META: OpMeta[] = [
  { kind: 'crop', label: 'crop', applies: 'image', note: 'ImageCrop data — focal point + zoom, never destructive.' },
  { kind: 'rotate', label: 'rotate', applies: 'both', note: 'Arbitrary degrees + 90° steps.' },
  { kind: 'mask', label: 'brush mask', applies: 'both', note: 'Token-styled brush strokes; inpaint/control mask export.' },
  { kind: 'adjust', label: 'adjust', applies: 'both', note: 'brightness / contrast / saturation (ctx.filter proxy).' },
  { kind: 'trim', label: 'trim', applies: 'video', note: 'The VideoReferenceClipper section — 2–15 s.' },
  { kind: 'upscale', label: 'upscale', applies: 'both', note: 'Dual-mode: stack op or fork (chain settings carry the mode at render).' },
  { kind: 'stabilize', label: 'stabilize', applies: 'video', note: 'Research-stack stabilization; strength dial.' },
  { kind: 'color-grade', label: 'color grade', applies: 'both', note: 'Temperature / tint grade (research stack).' },
  // The workbench's app-side frequency blend (k9vu6t0, spec §8): the source
  // stays authoritative for tone/dimensions, the refiner contributes detail.
  // Executes at render/export (the DSP lives in lib/h3imageOps); the tile
  // preview shows the op chip — frequency separation has no honest CSS proxy.
  { kind: 'h3img.tone-lock', label: 'tone-lock', applies: 'image', note: 'Frequency-separated blend: the source keeps low frequencies (tone lock), the refine output supplies detail. Radius/strength dials; runs at export.' },
]

export function opMetaFor(kind: string): OpMeta | null {
  return OP_META.find((meta) => meta.kind === kind) ?? null
}

/** The op kinds offered for one media kind (type-directed, §3 discipline). */
export function opKindsFor(mediaKind: 'image' | 'video' | 'audio' | null): OpKind[] {
  if (mediaKind === 'image') return OP_META.filter((meta) => meta.applies === 'image' || meta.applies === 'both').map((meta) => meta.kind)
  if (mediaKind === 'video') return OP_META.filter((meta) => meta.applies === 'video' || meta.applies === 'both').map((meta) => meta.kind)
  return []
}

// ---- op settings -----------------------------------------------------------------

/** ImageCrop's non-destructive crop data (the FIRST op, per §5.1). */
export type CropSettings = { x: number; y: number; zoom: number; fit: 'crop' | 'contain' }

export type RotateSettings = { degrees: number }

/** Brush strokes in NORMALIZED coordinates (0–1) — replayable, reorder-safe,
 *  and independent of the preview's pixel size. */
export type MaskStroke = { points: number[]; size: number; erase: boolean }
export type MaskSettings = { strokes: MaskStroke[] }

/** ctx.filter adjustments — the CSS filter string is the visual proxy. */
export type AdjustSettings = { brightness: number; contrast: number; saturation: number }

export type TrimSettings = { start: number; end: number }

export type UpscaleSettings = { mode: UpscaleMode }

export type StabilizeSettings = { strength: number }

export type ColorGradeSettings = { temperature: number; tint: number }

/** Tone-lock dials (the research-pinned defaults: tone_lock 0.85,
 * refinement_strength 0.55, detail_radius 32 — astropuzzo's Detail Tone
 * Lock recipe values). */
export type ToneLockSettings = { lockStrength: number; detailStrength: number; radius: number }

export type OpSettings = CropSettings | RotateSettings | MaskSettings | AdjustSettings | TrimSettings | UpscaleSettings | StabilizeSettings | ColorGradeSettings | ToneLockSettings

export const DEFAULT_SETTINGS: Record<OpKind, () => OpSettings> = {
  crop: () => ({ x: 0.5, y: 0.5, zoom: 1, fit: 'crop' }),
  rotate: () => ({ degrees: 0 }),
  mask: () => ({ strokes: [] }),
  adjust: () => ({ brightness: 1, contrast: 1, saturation: 1 }),
  trim: () => ({ start: 0, end: 15 }),
  upscale: () => ({ mode: 'rtx' }),
  stabilize: () => ({ strength: 0.5 }),
  'color-grade': () => ({ temperature: 0, tint: 0 }),
  'h3img.tone-lock': () => ({ lockStrength: 0.85, detailStrength: 0.55, radius: 32 }),
}

const num = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback

/** Tolerant per-kind read (documents are external data): wrong/absent fields
 *  fall back to that field's default, never a crash, never a silent absurd
 *  value — clamps keep the stacks renderable. */
export function readOpSettings(kind: string, raw: Record<string, unknown> | null | undefined): OpSettings {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  switch (kind) {
    case 'crop':
      return {
        x: num(record.x, 0.5, 0, 1),
        y: num(record.y, 0.5, 0, 1),
        zoom: num(record.zoom, 1, 1, 4),
        fit: record.fit === 'contain' ? 'contain' : 'crop',
      }
    case 'rotate':
      return { degrees: num(record.degrees, 0, -360, 360) }
    case 'mask': {
      const strokes: MaskStroke[] = Array.isArray(record.strokes)
        ? record.strokes.filter((stroke): stroke is MaskStroke => {
          if (!stroke || typeof stroke !== 'object' || Array.isArray(stroke)) return false
          const candidate = stroke as Record<string, unknown>
          return Array.isArray(candidate.points) && typeof candidate.size === 'number' && typeof candidate.erase === 'boolean'
        }).map((stroke) => ({ points: stroke.points.filter((point): point is number => typeof point === 'number' && Number.isFinite(point)), size: num(stroke.size, 0.04, 0.002, 0.5), erase: stroke.erase }))
        : []
      return { strokes }
    }
    case 'adjust':
      return { brightness: num(record.brightness, 1, 0, 3), contrast: num(record.contrast, 1, 0, 3), saturation: num(record.saturation, 1, 0, 3) }
    case 'trim': {
      const start = num(record.start, 0, 0, 900)
      // The clipper contract: a section between 2 and 15 s (end alone may
      // exceed the source; the render clamps to the real duration).
      return { start, end: Math.max(start + 2, num(record.end, 15, start + 2, start + 15)) }
    }
    case 'upscale': {
      const mode = record.mode
      // A stored 'ltx' (the removed Phase-0 mode) falls back to 'rtx'.
      return { mode: mode === 'rtx' || mode === 'lbh2d' || mode === 'lbh3d' ? mode : 'rtx' }
    }
    case 'stabilize':
      return { strength: num(record.strength, 0.5, 0, 1) }
    case 'color-grade':
      return { temperature: num(record.temperature, 0, -1, 1), tint: num(record.tint, 0, -1, 1) }
    case 'h3img.tone-lock':
      return { lockStrength: num(record.lockStrength, 0.85, 0, 1), detailStrength: num(record.detailStrength, 0.55, 0, 2), radius: Math.round(num(record.radius, 32, 1, 256)) }
    default:
      return {} as OpSettings
  }
}

// ---- the live preview composition (L3: live-update) -------------------------------

export type OpPreviewStyle = {
  /** Composed CSS filter (adjust + color-grade ops, in stack order). */
  filter: string
  /** Composed transform (crop zoom + rotate ops). */
  transform: string
  /** object-position for the crop focal point (percent). */
  objectPosition: string
  objectFit: 'cover' | 'contain'
  /** Trim window (seconds) — the modal scrubber + playback honor it. */
  trimStart: number
  trimEnd: number
}

/**
 * Composes the stack's visual proxy onto a preview surface. Ops apply in
 * stack order (the render order the stack defines); the composition is
 * pure data — the tile poster and the modal stage apply it as CSS, which is
 * exactly what "the tile's preview LIVE-UPDATES as ops change" means at v1.
 */
export function opPreviewStyle(ops: ReadonlyArray<{ kind: string; settings: Record<string, unknown> | null }>): OpPreviewStyle {
  let filter = ''
  let scale = 1
  let rotate = 0
  let focal = { x: 0.5, y: 0.5 }
  let fit: 'cover' | 'contain' = 'cover'
  let trimStart = 0
  let trimEnd = Number.POSITIVE_INFINITY
  for (const op of ops) {
    const settings = readOpSettings(op.kind, op.settings)
    if (settings && typeof settings === 'object' && 'brightness' in settings) {
      filter += ` brightness(${settings.brightness.toFixed(3)}) contrast(${settings.contrast.toFixed(3)}) saturate(${settings.saturation.toFixed(3)})`
    } else if (settings && typeof settings === 'object' && 'temperature' in settings) {
      // Temperature proxy: warm = sepia + counter hue-rotate, cool = hue-rotate
      // toward blue; tint biases saturation. A proxy by design — the render
      // applies the real grade.
      const warm = Math.max(0, settings.temperature)
      const cool = Math.max(0, -settings.temperature)
      if (warm > 0) filter += ` sepia(${(warm * 0.35).toFixed(3)}) hue-rotate(${(-warm * 18).toFixed(1)}deg)`
      if (cool > 0) filter += ` hue-rotate(${(cool * 22).toFixed(1)}deg)`
      if (settings.tint !== 0) filter += ` saturate(${(1 + Math.abs(settings.tint) * 0.4).toFixed(3)})`
    } else if (settings && typeof settings === 'object' && 'degrees' in settings) {
      rotate += settings.degrees
    } else if (settings && typeof settings === 'object' && 'zoom' in settings) {
      scale *= settings.zoom
      focal = { x: settings.x, y: settings.y }
      fit = settings.fit === 'contain' ? 'contain' : 'cover'
    } else if (settings && typeof settings === 'object' && 'start' in settings) {
      trimStart = settings.start
      trimEnd = settings.end
    }
  }
  const transforms: string[] = []
  if (Math.abs(scale - 1) > 1e-6) transforms.push(`scale(${scale.toFixed(4)})`)
  const normalizedRotate = ((rotate % 360) + 360) % 360
  if (Math.abs(normalizedRotate) > 1e-6 && Math.abs(normalizedRotate - 360) > 1e-6) transforms.push(`rotate(${rotate.toFixed(2)}deg)`)
  return {
    filter: filter.trim() || 'none',
    transform: transforms.join(' ') || 'none',
    objectPosition: `${(focal.x * 100).toFixed(1)}% ${(focal.y * 100).toFixed(1)}%`,
    objectFit: fit,
    trimStart,
    trimEnd,
  }
}

// ---- stack helpers -----------------------------------------------------------------

/** A short chip text per op (the tile's op-chip row + the modal rows). */
export function opSummary(kind: string, raw: Record<string, unknown> | null | undefined): string {
  const settings = readOpSettings(kind, raw)
  if (settings && 'zoom' in settings) return settings.fit === 'contain' ? 'fit' : `${settings.zoom.toFixed(1)}×`
  if (settings && 'degrees' in settings) return `${Math.round(settings.degrees)}°`
  if (settings && 'strokes' in settings) return settings.strokes.length ? `${settings.strokes.length} stroke${settings.strokes.length === 1 ? '' : 's'}` : 'empty'
  if (settings && 'brightness' in settings) {
    const parts = [
      settings.brightness !== 1 ? `b ${settings.brightness.toFixed(1)}` : '',
      settings.contrast !== 1 ? `c ${settings.contrast.toFixed(1)}` : '',
      settings.saturation !== 1 ? `s ${settings.saturation.toFixed(1)}` : '',
    ].filter(Boolean)
    return parts.join(' · ') || 'neutral'
  }
  if (settings && 'start' in settings) return `${settings.start.toFixed(1)}–${settings.end.toFixed(1)}s`
  if (settings && 'mode' in settings) return settings.mode === 'off' ? 'off' : settings.mode
  if (settings && 'strength' in settings) return settings.strength.toFixed(2)
  if (settings && 'temperature' in settings) return settings.temperature === 0 && settings.tint === 0 ? 'neutral' : 'graded'
  if (settings && 'lockStrength' in settings) return `lock ${settings.lockStrength.toFixed(2)} · r${settings.radius}`
  return kind
}

/**
 * The reorder permutation for one move (drag-to-reorder's atomic step):
 * moves `opId` by `delta` (-1 up / +1 down), clamped at the ends. Baked ops
 * are immovable (the trigger freezes them) — a move across a baked op is
 * therefore refused honestly (returns null). Returns the new orderedIds the
 * server permutation endpoint takes, or null when nothing may change.
 */
export function moveOpPermutation(
  ops: ReadonlyArray<{ id: string; bakedAt: number | null }>,
  opId: string,
  delta: -1 | 1,
): string[] | null {
  const index = ops.findIndex((op) => op.id === opId)
  if (index < 0) return null
  if (ops[index]!.bakedAt !== null) return null
  const target = index + delta
  if (target < 0 || target >= ops.length) return null
  if (ops[target]!.bakedAt !== null) return null
  const ids = ops.map((op) => op.id)
  const moved = ids.splice(index, 1)[0]!
  ids.splice(target, 0, moved)
  return ids
}
