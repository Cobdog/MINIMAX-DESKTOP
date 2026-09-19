/**
 * The LoRA timeline's pure layer (7twfk6o, layer 1 — segment granularity):
 * the authored range document, the 17n+5 grid conformance, and the compiler
 * that turns painted LoRA ranges into Director Suite plan segments.
 *
 * The product contract (maintainer, 2026-09-19): "paint LoRA ranges over a
 * clip; the compiler auto-generates per-LoRA segment chains joined by
 * measured transitions." Each painted range becomes ONE segment whose
 * duration is grid-conformed (frames = 17n+5, the same rule
 * lib/workflow.frameCount quantizes to); uncovered spans become base-look
 * segments (no stack — the honest reading of partial painting, never a
 * silent gap); interior boundaries join per the gap menu's measured
 * transitions with user-settable window widths defaulted from the tranche-1
 * verdicts (docs/research/h3-transitions-and-latent-continuity.md).
 *
 * PURE module: no React, no DOM, no stores — covered by
 * scripts/test-canvas.cjs through the VM harness (ES3 discipline: no
 * iterator spreads, Array.from over iterables).
 */
import { GAP_KINDS, type PlanDocumentData, type PlanGapKind, type PlanSegment } from './plan'

// ---- the 17n+5 grid -----------------------------------------------------------

/** The H3 temporal VAE grid: legal frame counts are f = 17n + 5 (5, 22, 39,
 * 56, …). Pinned to lib/workflow.frameCount's rule — test-canvas cross-checks
 * every conformed duration against frameCount so the two never drift. */
export const GRID_STEP = 17
export const GRID_OFFSET = 5
export const TIMELINE_FPS = 24

/** The app's own duration contract (the chain clamp, 2–15 s) expressed in
 * grid frames: the smallest legal segment is 56 f (2.33 s — 22 f would be
 * sub-2 s), the largest is 345 f (14.375 s — the next rung 362 f would
 * exceed 15 s). */
export const MIN_SEGMENT_FRAMES = 56
export const MAX_SEGMENT_FRAMES = 345
export const MIN_PAINTED_SECONDS = 2
export const MAX_PAINTED_SECONDS = 15

/** Nearest legal grid frame count (17n+5) inside the segment band. Ties snap
 * UP, matching frameCount's ceiling direction. */
export function conformFrames(rawFrames: number): number {
  const clamped = Math.min(MAX_SEGMENT_FRAMES, Math.max(MIN_SEGMENT_FRAMES, Math.round(rawFrames)))
  const remainder = (((clamped - GRID_OFFSET) % GRID_STEP) + GRID_STEP) % GRID_STEP
  const down = clamped - remainder
  const up = down + GRID_STEP
  const candidates = [down, up].filter((frames) => frames >= MIN_SEGMENT_FRAMES && frames <= MAX_SEGMENT_FRAMES)
  if (!candidates.length) return MIN_SEGMENT_FRAMES
  candidates.sort((a, b) => (Math.abs(a - clamped) - Math.abs(b - clamped)) || (a - b))
  return candidates[0]
}

/** Conform a painted duration to the grid: the seconds of the nearest legal
 * frame count. */
export function conformDurationSeconds(seconds: number): number {
  return conformFrames(seconds * TIMELINE_FPS) / TIMELINE_FPS
}

/** Legal boundary positions for the rail's snapping: `from + d` for every
 * legal duration d that keeps the result within [from, through]. */
export function legalBoundarySeconds(from: number, through: number): number[] {
  const positions: number[] = []
  for (let frames = MIN_SEGMENT_FRAMES; frames <= MAX_SEGMENT_FRAMES; frames += GRID_STEP) {
    const position = from + frames / TIMELINE_FPS
    if (position > through + 1e-9) break
    positions.push(position)
  }
  return positions
}

/** The nearest snap for a dragged boundary (the rail gesture): nearest legal
 * position, floored at `from + min`, ceiled at `through`. */
export function snapBoundarySeconds(seconds: number, from: number, through: number): number {
  const legal = legalBoundarySeconds(from, through)
  if (!legal.length) return through
  let best = legal[0]
  for (const position of legal) {
    if (Math.abs(position - seconds) < Math.abs(best - seconds) - 1e-12) best = position
  }
  return best
}

/** The rail's boundary-drag snap: the nearest legal position that keeps BOTH
 *  neighbors paintable — the left span ≥ the paint floor measured from
 *  `leftStart`, the right span ≥ it measured back from `rightEnd`. Returns
 *  null when no legal position exists (the drag is refused, never clamped to
 *  a degenerate split). */
export function snapRangeBoundary(seconds: number, leftStart: number, rightEnd: number): number | null {
  const floor = leftStart + MIN_PAINTED_SECONDS
  const ceiling = rightEnd - MIN_PAINTED_SECONDS
  const legal = legalBoundarySeconds(leftStart, rightEnd).filter((position) => position >= floor - 1e-9 && position <= ceiling + 1e-9)
  if (!legal.length) return null
  let best = legal[0]
  for (const position of legal) {
    if (Math.abs(position - seconds) < Math.abs(best - seconds) - 1e-12) best = position
  }
  return best
}

// ---- the LoRA set (the workbench's research-pinned slots) ---------------------

export type LoraStackEntry = { name: string; strength: number }

/** Per-range stack cap + combined-strength guidance, mirroring the H3 image
 * workbench's recipe pins (spec §6 — GUIDANCE, not enforcement: the compiler
 * warns, never silently rewrites a strength). */
export const LORA_SLOTS = 2
export const LORA_COMBINED_HEALTHY_MAX = 0.9
export const LORA_COMBINED_COLLAPSE_RISK = 1.05
export const LORA_STRENGTH_MIN = 0
export const LORA_STRENGTH_MAX = 2

// ---- transition windows (defaults from the measured verdicts) -----------------

/**
 * The default transition window per gap kind — the projected span where the
 * join lands, in seconds. Every number is grounded in the transitions
 * research (tranche 1 + §4): the hard cut is instantaneous (the measured
 * default, 9.8 dB seam, zero GPU); FLF's window is the Motion-Context
 * default continuation context (22 frames — the pinned default in
 * lib/workflow's Motion-Context wiring); the dip-to-black is the measured
 * structural dip (15–18 frame windows, 18 f taken); the NLE crossfade is a
 * post convention (no in-model number exists — post is deterministic); the
 * diegetic bridge carries the FLF-class window while its render stays
 * engine work. User-settable per boundary at the surface.
 */
export const DEFAULT_TRANSITION_WINDOW: Record<PlanGapKind, number> = {
  cut: 0,
  flf: 22 / TIMELINE_FPS,
  black: 18 / TIMELINE_FPS,
  nle: 0.5,
  bridge: 22 / TIMELINE_FPS,
}

// ---- the authored document (persisted on chain.settings.loraTimeline) ---------

export type LoraRange = {
  id: string
  /** Painted span over the clip, seconds ([start, end)). */
  start: number
  end: number
  /** The range's LoRA set (1–2 entries; the strength dial is per entry). */
  loras: LoraStackEntry[]
}

/** A boundary transition the user set explicitly (absent = the measured
 * default hard cut with its kind's default window). */
export type LoraBoundaryTransition = { afterRangeId: string; kind: PlanGapKind; widthSeconds: number }

export type LoraTimelineDoc = {
  ranges: LoraRange[]
  transitions: LoraBoundaryTransition[]
}

export function newLoraTimelineDoc(): LoraTimelineDoc {
  return { ranges: [], transitions: [] }
}

export function newLoraRange(index: number, start: number, end: number): LoraRange {
  return { id: `lora-range-${Date.now().toString(36)}-${index}-${Math.floor(Math.random() * 1e6).toString(36)}`, start, end, loras: [] }
}

const strengthOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(LORA_STRENGTH_MAX, Math.max(LORA_STRENGTH_MIN, value)) : null

const stackOf = (raw: unknown, issues: string[]): LoraStackEntry[] => {
  if (!Array.isArray(raw)) return []
  const entries: LoraStackEntry[] = []
  raw.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const candidate = item as Record<string, unknown>
    const name = typeof candidate.name === 'string' ? candidate.name : ''
    const strength = strengthOf(candidate.strength)
    if (!name && strength === null) return
    entries.push({ name, strength: strength ?? 1 })
  })
  if (entries.length > LORA_SLOTS) issues.push(`a range carries ${entries.length} LoRAs — only the first ${LORA_SLOTS} survive the read (the timeline supports ${LORA_SLOTS} slots per range)`)
  return entries.slice(0, LORA_SLOTS)
}

/** Tolerant read of a persisted loraTimeline doc (external data — absent keys
 *  fall back, wrong shapes never crash; range ids that duplicate get
 *  suffixed so the compiler's boundary keys stay unique). */
export function readLoraTimelineDoc(raw: unknown): LoraTimelineDoc {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const issues: string[] = []
  const ranges: LoraRange[] = Array.isArray(record.ranges)
    ? record.ranges
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item, index) => ({
          id: typeof item.id === 'string' && item.id ? item.id : `lora-range-${index}`,
          start: typeof item.start === 'number' && Number.isFinite(item.start) ? item.start : 0,
          end: typeof item.end === 'number' && Number.isFinite(item.end) ? item.end : 0,
          loras: stackOf(item.loras, issues),
        }))
    : []
  const seen = new Set<string>()
  for (const range of ranges) {
    let id = range.id
    let suffix = 2
    while (seen.has(id)) id = `${range.id}-${suffix++}`
    seen.add(id)
    range.id = id
  }
  const kinds = new Set(GAP_KINDS)
  const rangeIds = new Set(ranges.map((range) => range.id))
  const transitions: LoraBoundaryTransition[] = Array.isArray(record.transitions)
    ? record.transitions
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .filter((item) => typeof item.afterRangeId === 'string' && rangeIds.has(item.afterRangeId))
        .filter((item) => typeof item.kind === 'string' && kinds.has(item.kind as PlanGapKind))
        .map((item) => ({
          afterRangeId: item.afterRangeId as string,
          kind: item.kind as PlanGapKind,
          widthSeconds: typeof item.widthSeconds === 'number' && Number.isFinite(item.widthSeconds) && item.widthSeconds >= 0 ? item.widthSeconds : DEFAULT_TRANSITION_WINDOW[item.kind as PlanGapKind],
        }))
    : []
  if (issues.length && typeof globalThis.console !== 'undefined') {
    // A malformed stack is read honestly (truncated) and reported — never a
    // silent drop, never a crash on foreign data.
    globalThis.console.warn(`loraTimeline read: ${issues.join('; ')}`)
  }
  return { ranges, transitions }
}

// ---- the compiler: ranges → segments -------------------------------------------

export type CompiledLoraSegment = {
  id: string
  /** The painted range this compiles from (synthesized base segments carry
   *  their own span id — provenance is verbatim either way). */
  rangeId: string
  title: string
  /** Grid-conformed duration (frames = 17n+5). */
  durationSeconds: number
  frames: number
  /** The active LoRA set (empty = the base look). */
  loras: LoraStackEntry[]
  /** The PAINTED span (verbatim provenance — may differ from the conformed
   *  cumulative layout, which the surface shows beside it). */
  range: { start: number; end: number }
  /** Conformed cumulative layout. */
  startSeconds: number
  endSeconds: number
  /** The join to the NEXT segment (null after the last). */
  gapAfter: { kind: PlanGapKind; widthSeconds: number } | null
}

export type LoraTimelineCompile =
  | { ok: true; segments: CompiledLoraSegment[]; totalSeconds: number; warnings: string[] }
  | { ok: false; reasons: string[] }

const rangeTitle = (loras: LoraStackEntry[]): string => {
  if (!loras.length) return 'base look'
  const base = (name: string) => name.split('/').pop()?.replace(/\.safetensors$/i, '') ?? name
  return loras.map((lora) => base(lora.name)).join(' + ')
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

/**
 * Compiles painted LoRA ranges into segment specs. Validation refuses
 * degenerate input WITH REASONS (every reason is user-facing); conformance
 * warnings ride the success arm. The conformed layout is cumulative from 0 —
 * each segment snaps to the grid independently, so the planned total may
 * stretch past the painted clip duration (the projection shows both).
 */
export function compileLoraTimeline(doc: LoraTimelineDoc, clipDurationSeconds: number): LoraTimelineCompile {
  const reasons: string[] = []
  const warnings: string[] = []
  const clip = Math.max(MIN_PAINTED_SECONDS, Math.min(MAX_PAINTED_SECONDS, clipDurationSeconds))

  if (!doc.ranges.length) return { ok: false, reasons: ['Paint at least one LoRA range before compiling.'] }

  const sorted = doc.ranges.slice().sort((a, b) => a.start - b.start)
  sorted.forEach((range, index) => {
    const label = `Range ${index + 1}${rangeTitle(range.loras) !== 'base look' ? ` (${rangeTitle(range.loras)})` : ''}`
    if (!(range.end > range.start)) reasons.push(`${label} ends at or before its start (${range.start.toFixed(2)}s–${range.end.toFixed(2)}s) — paint a span, not a point.`)
    const painted = range.end - range.start
    if (range.end > range.start && painted < MIN_PAINTED_SECONDS) reasons.push(`${label} paints ${painted.toFixed(2)}s — segments run ${MIN_PAINTED_SECONDS}–${MAX_PAINTED_SECONDS}s and the 17n+5 grid conforms the shortest legal segment to ${(MIN_SEGMENT_FRAMES / TIMELINE_FPS).toFixed(2)}s. Paint it at least ${MIN_PAINTED_SECONDS}s.`)
    if (painted > MAX_PAINTED_SECONDS + 1e-9) reasons.push(`${label} paints ${painted.toFixed(2)}s — the clip ceiling is ${MAX_PAINTED_SECONDS}s per segment.`)
    if (range.start < -1e-9 || range.end > clip + 1e-9) reasons.push(`${label} extends past the clip's 0–${clip.toFixed(2)}s.`)
    if (range.loras.length > LORA_SLOTS) reasons.push(`${label} carries ${range.loras.length} LoRAs — the timeline supports ${LORA_SLOTS} slots per range (the workbench's combined-strength band).`)
    range.loras.forEach((lora, slot) => {
      if (!lora.name.trim()) reasons.push(`${label} slot ${slot + 1} has no LoRA file picked.`)
      if (lora.strength < LORA_STRENGTH_MIN - 1e-9 || lora.strength > LORA_STRENGTH_MAX + 1e-9) reasons.push(`${label} slot ${slot + 1} strength ${lora.strength} is outside 0–2.`)
    })
    const combined = range.loras.reduce((sum, lora) => sum + lora.strength, 0)
    if (range.loras.length === LORA_SLOTS && combined >= LORA_COMBINED_COLLAPSE_RISK) warnings.push(`${label}: combined strength ${combined.toFixed(2)} is in the collapse-risk band (≥${LORA_COMBINED_COLLAPSE_RISK}) — expect cooked output.`)
    else if (range.loras.length === LORA_SLOTS && combined > LORA_COMBINED_HEALTHY_MAX) warnings.push(`${label}: combined strength ${combined.toFixed(2)} exceeds the healthy band (≤${LORA_COMBINED_HEALTHY_MAX}).`)
  })
  for (let index = 1; index < sorted.length; index += 1) {
    const left = sorted[index - 1]
    const right = sorted[index]
    if (right.start < left.end - 1e-9) reasons.push(`Ranges overlap at ${right.start.toFixed(2)}s — paint non-overlapping ranges (left ends ${left.end.toFixed(2)}s).`)
  }
  if (reasons.length) return { ok: false, reasons }

  // Base spans: uncovered stretches compile to base-look segments. A span
  // shorter than the paint floor cannot be its own segment — it joins the
  // LEFT neighbor's stack (reported, never silent).
  type Walk = { rangeId: string; loras: LoraStackEntry[]; start: number; end: number; painted: boolean }
  const spans: Walk[] = []
  let cursor = 0
  sorted.forEach((range) => {
    if (range.start > cursor + 1e-9) {
      const gap = range.start - cursor
      if (gap < MIN_PAINTED_SECONDS && spans.length) {
        warnings.push(`The ${gap.toFixed(2)}s uncovered span at ${cursor.toFixed(2)}s is shorter than the grid's minimum — it joins the previous range.`)
        spans[spans.length - 1].end = range.start
      } else {
        spans.push({ rangeId: `lora-base-${spans.length}`, loras: [], start: cursor, end: range.start, painted: false })
      }
    }
    spans.push({ rangeId: range.id, loras: range.loras.map((lora) => ({ ...lora })), start: range.start, end: range.end, painted: true })
    cursor = Math.max(cursor, range.end)
  })
  if (cursor < clip - 1e-9) {
    const tail = clip - cursor
    if (tail < MIN_PAINTED_SECONDS && spans.length) {
      warnings.push(`The ${tail.toFixed(2)}s uncovered tail is shorter than the grid's minimum — it joins the previous range.`)
      spans[spans.length - 1].end = clip
    } else {
      spans.push({ rangeId: `lora-base-${spans.length}`, loras: [], start: cursor, end: clip, painted: false })
    }
  }

  const transitionFor = (afterRangeId: string): { kind: PlanGapKind; widthSeconds: number } => {
    const record = doc.transitions.find((entry) => entry.afterRangeId === afterRangeId)
    if (!record) return { kind: 'cut', widthSeconds: DEFAULT_TRANSITION_WINDOW.cut }
    return { kind: record.kind, widthSeconds: record.widthSeconds }
  }

  const segments: CompiledLoraSegment[] = []
  let cumulative = 0
  spans.forEach((span) => {
    const frames = conformFrames((span.end - span.start) * TIMELINE_FPS)
    const durationSeconds = frames / TIMELINE_FPS
    if (!near(durationSeconds, span.end - span.start)) {
      warnings.push(`${rangeTitle(span.loras)} at ${span.start.toFixed(2)}s: painted ${(span.end - span.start).toFixed(2)}s conforms to ${durationSeconds.toFixed(3)}s (${frames} frames, 17n+5).`)
    }
    const id = span.painted ? `seg-lora-${span.rangeId}` : `seg-${span.rangeId}`
    segments.push({
      id,
      rangeId: span.rangeId,
      title: rangeTitle(span.loras),
      durationSeconds,
      frames,
      loras: span.loras,
      range: { start: span.start, end: span.end },
      startSeconds: cumulative,
      endSeconds: cumulative + durationSeconds,
      gapAfter: null,
    })
    cumulative += durationSeconds
  })
  for (let index = 0; index + 1 < segments.length; index += 1) segments[index].gapAfter = transitionFor(segments[index].rangeId)
  return { ok: true, segments, totalSeconds: cumulative, warnings }
}

// ---- take-metrics provenance (AC4) --------------------------------------------

/**
 * The LoRAs active on one take, read from its job manifest: the turbo LoRA
 * the manifest's models record names (at loraStrength; the quality tier
 * carries none) + the temporal stack recorded at submit. Returns an empty
 * object when none — the metric stays absent rather than an empty array
 * pretending to be provenance. Pure; take-landing spreads it into metrics.
 */
export function activeLorasOf(manifest: Record<string, unknown> | null): Record<string, unknown> {
  if (!manifest) return {}
  const models = manifest.models && typeof manifest.models === 'object' ? manifest.models as Record<string, unknown> : null
  const turbo = models && models.turboLora && typeof models.turboLora === 'object' ? models.turboLora as Record<string, unknown> : null
  const stack = Array.isArray(manifest.loraStack) ? manifest.loraStack : []
  const active: LoraStackEntry[] = []
  if (turbo && typeof turbo.name === 'string' && turbo.name) {
    active.push({ name: turbo.name, strength: typeof manifest.loraStrength === 'number' ? manifest.loraStrength : 1 })
  }
  for (const entry of stack) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.name === 'string' && candidate.name) {
      active.push({ name: candidate.name, strength: typeof candidate.strength === 'number' ? candidate.strength : 1 })
    }
  }
  return active.length ? { loras: active } : {}
}

// ---- the compiled result → a Director Suite plan document ----------------------

/**
 * A successful compile becomes a plan document: every segment carries its
 * prompt + reference handoffs (inherited from the source chain), its LoRA
 * range + stack (the §1 schema's provenance extension), and the measured gap
 * kinds join them (only non-cut gaps are recorded — a missing gap IS the
 * default, per plan.ts's read contract).
 */
export function loraTimelineToPlanDocument(
  compile: Extract<LoraTimelineCompile, { ok: true }>,
  source: { prompt: string; referenceCharacterIds: string[]; referenceLocationIds: string[] },
): PlanDocumentData {
  const segments: PlanSegment[] = compile.segments.map((segment) => ({
    id: segment.id,
    title: segment.title,
    prompt: source.prompt,
    duration: Number(segment.durationSeconds.toFixed(4)),
    chainId: null,
    referenceCharacterIds: source.referenceCharacterIds.slice(),
    referenceLocationIds: source.referenceLocationIds.slice(),
    loraRange: { start: Number(segment.range.start.toFixed(4)), end: Number(segment.range.end.toFixed(4)) },
    loraStack: segment.loras.map((lora) => ({ name: lora.name, strength: lora.strength })),
  }))
  const gaps = compile.segments
    .filter((segment) => segment.gapAfter && segment.gapAfter.kind !== 'cut')
    .map((segment) => ({ afterSegmentId: segment.id, kind: segment.gapAfter!.kind }))
  return { brief: `LoRA timeline — ${compile.segments.length} segment${compile.segments.length === 1 ? '' : 's'} (${compile.totalSeconds.toFixed(2)}s planned, 17n+5 grid)`, segments, gaps }
}
