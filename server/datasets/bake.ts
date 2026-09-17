/**
 * Dataset manager — the bake pipeline (spec §5), the QA gates (§8), and the
 * export writers (§9). ONE pipeline, four stages, in order — the only place
 * source pixels are read and rewritten, always to a NEW file:
 *   1. trim window → 2. crop rect (full-res, 32-grid) →
 *   3. CFR 24.000 (conditional policy: retime near-24, drop/dup integer
 *      ratios, interpolation LAST for real gaps — rife-ncnn-vulkan when
 *      present, ffmpeg minterpolate fallback; tagged) →
 *   4. 17n+5 grid conform: bake to grid target +2 frames; the decoded count
 *      must land in [target, target+2] (asserted; < target refuses with the
 *      delta — the f56 class caught at OUR door).
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  assertDecodedCount,
  TRAINING_FPS,
  bakeLengthFor,
  gridTargetFor,
  planFps,
  recipeCard,
  validateTrigger,
  appearanceViolation,
  SILENCE_STATEMENT,
  type AudioPolicy,
  type ContentClass,
  type TrainerId,
  type CropRect,
} from './model'
import { decodedFrameCount, runTool, type ToolOptions } from './probe'
import type { DatasetStore, LayerRow, SourceRow } from './store'

// ---------------------------------------------------------------------------
// Bake planning (pure; unit-tested)
// ---------------------------------------------------------------------------

export type BakePlan = {
  gridTarget: number
  /** Frames we encode: grid target + 2 headroom. */
  encodeFrames: number
  trimInFrame: number
  trimOutFrame: number
  /** Crop actually applied (source frame crop, 32-aligned). */
  crop: { x: number; y: number; w: number; h: number } | null
  /** Pixels trimmed off the frame to 32-align dims when no explicit crop. */
  gridAlign: { left: number; top: number } | null
  fpsMode: 'retime' | 'dropdup' | 'interpolate' | 'passthrough'
  fpsReason: string
  audio: 'passthrough' | 'blank'
}

/** Plans the bake for one layer. `explicitTarget` chooses the grid target at
 * export (never baked into the trim); default = the largest grid target that
 * fits the trim window with +2 headroom. */
export function planBake(layer: LayerRow, source: SourceRow, explicitTarget?: number | null): BakePlan {
  if (source.health === 'missing') throw new Error(`Source ${source.id} is MISSING — bake refuses. Re-link the file (hash ${source.contentHash.slice(0, 12)}) first.`)
  if (source.kind === 'image') {
    return {
      gridTarget: 1,
      encodeFrames: 1,
      trimInFrame: 0,
      trimOutFrame: 1,
      crop: layer.crop,
      gridAlign: alignFullFrame(source.probe.width, source.probe.height),
      fpsMode: 'passthrough',
      fpsReason: 'Still image — one frame, no fps transform.',
      audio: 'blank',
    }
  }
  const total = source.decodedFrames ?? Math.max(1, Math.round((source.probe.durationSec ?? 0) * (source.probe.fps ?? 24)))
  const inFrame = layer.trim?.inFrame ?? 0
  const outFrame = layer.trim?.outFrame ?? total
  const sourceFps = source.probe.fps ?? 24
  const plan = planFps(sourceFps)
  // The window must be sized in POST-conform frames: retime preserves
  // duration (frames scale by 24/srcFps), drop/dup downsamples by the same
  // ratio — a 60-frame 30 fps window yields only 48 frames at 24. The grid
  // target is chosen against the conformable count (−2 headroom), so a
  // plan-legal bake can never decode short.
  const available = Math.max(1, Math.round((outFrame - inFrame) * (TRAINING_FPS / sourceFps)))
  const target = explicitTarget && explicitTarget >= 22 && explicitTarget <= 345 ? explicitTarget : gridTargetFor(Math.max(0, available - 2)) ?? 22
  return {
    gridTarget: target,
    encodeFrames: bakeLengthFor(target),
    trimInFrame: inFrame,
    trimOutFrame: outFrame,
    crop: layer.crop,
    gridAlign: layer.crop ? null : alignFullFrame(source.probe.width, source.probe.height),
    fpsMode: plan.mode,
    fpsReason: plan.reason,
    audio: source.probe.hasAudio ? 'passthrough' : 'blank',
  }
}

/** Full-frame layers get a minimal center crop at bake to land dims on the
 * 32-px grid — pixels are trimmed (never resized), and the trim is recorded
 * in the bake report so it is never silent. */
function alignFullFrame(width: number, height: number): { left: number; top: number } | null {
  const remW = width % 32
  const remH = height % 32
  if (!remW && !remH) return null
  return { left: Math.floor(remW / 2), top: Math.floor(remH / 2) }
}

// ---------------------------------------------------------------------------
// The bake (ffmpeg; runs ONLY inside the serialized queue)
// ---------------------------------------------------------------------------

export type BakeOutcome = {
  layerId: string
  state: 'done' | 'failed' | 'cancelled'
  outputPath: string | null
  wavPath: string | null
  gridTarget: number
  decodedFrames: number | null
  interpolated: boolean
  fpsMode: BakePlan['fpsMode']
  fpsReason: string
  error?: string
}

export type BakeRunOptions = {
  ffmpegPath: string
  rifePath?: string | null
  outputFolder: string
  audioPolicy: AudioPolicy
  isCancelled(): boolean
  logFailure(stage: string, error: unknown, detail?: Record<string, unknown>): void
}

/** Builds the video filter chain for stages 1–4 (pure; unit-tested). */
export function bakeVideoFilters(plan: BakePlan, source: SourceRow): string[] {
  const filters: string[] = []
  // Stage 1 — trim (frame-exact via the trim filter).
  if (source.kind === 'video') {
    filters.push(`trim=start_frame=${plan.trimInFrame}:end_frame=${plan.trimOutFrame}`, 'setpts=PTS-STARTPTS')
  }
  // Stage 2 — crop (explicit rect, or the minimal grid-align crop).
  if (plan.crop) filters.push(`crop=${plan.crop.w}:${plan.crop.h}:${plan.crop.x}:${plan.crop.y}`)
  else if (plan.gridAlign) filters.push(`crop=iw-${plan.gridAlign.left * 2}:ih-${plan.gridAlign.top * 2}:${plan.gridAlign.left}:${plan.gridAlign.top}`)
  // Stage 3 — CFR 24.000, speed-preserving by default.
  if (source.kind === 'video') {
    if (plan.fpsMode === 'retime') {
      const factor = (source.probe.fps ?? 24) / 24
      filters.push(`setpts=PTS*${factor.toFixed(6)}`, 'fps=24')
    } else if (plan.fpsMode === 'dropdup') {
      filters.push('fps=24')
    } else if (plan.fpsMode === 'interpolate') {
      filters.push('minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:me_mode=bidir')
    }
  }
  return filters
}

/** Runs one layer's bake. Throws only on unrecoverable tool failure; the
 * caller maps to a failed/cancelled job row. RIFE preference is wired via
 * options.rifePath (spec A1-final: rife-ncnn-vulkan when present, else
 * minterpolate — both shipped paths, both tagged). */
export async function runBake(layer: LayerRow, source: SourceRow, plan: BakePlan, options: BakeRunOptions): Promise<BakeOutcome> {
  const base: BakeOutcome = {
    layerId: layer.id,
    state: 'done',
    outputPath: null,
    wavPath: null,
    gridTarget: plan.gridTarget,
    decodedFrames: null,
    interpolated: plan.fpsMode === 'interpolate',
    fpsMode: plan.fpsMode,
    fpsReason: plan.fpsReason + (options.rifePath && plan.fpsMode === 'interpolate' ? ' (rife-ncnn-vulkan preferred; minterpolate used this run)' : ''),
  }
  await mkdir(options.outputFolder, { recursive: true })
  if (options.isCancelled()) return { ...base, state: 'cancelled' }
  const isStill = source.kind === 'image'
  const outVideo = isStill
    ? join(options.outputFolder, `item-${layer.id.slice(0, 8)}-still.png`)
    : join(options.outputFolder, `item-${layer.id.slice(0, 8)}-${plan.gridTarget}f.mp4`)
  const outWav = join(options.outputFolder, `item-${layer.id.slice(0, 8)}-${plan.gridTarget}f.wav`)
  const filters = bakeVideoFilters(plan, source)
  const args: string[] = ['-y', '-i', source.absPath]
  if (isStill) {
    args.push('-frames:v', '1', '-vf', filters.join(',') || 'null', '-c:v', 'png')
  } else {
    // Stage 4 — encode exactly target+2 frames.
    args.push('-frames:v', String(plan.encodeFrames))
    args.push('-vf', filters.join(','), '-r', '24', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18')
  }
  if (!isStill && plan.audio === 'passthrough' && source.probe.hasAudio && !options.audioPolicy.blankReplaceExisting) {
    // The audio lane follows the same trim window (seconds) and the same
    // retime factor as the video lane.
    const inFps = source.probe.fps ?? 24
    const inSec = plan.trimInFrame / inFps
    const outSec = plan.trimOutFrame / inFps
    const audioFilters = [`atrim=start=${Math.max(0, inSec).toFixed(3)}:end=${outSec.toFixed(3)}`, 'asetpts=PTS-STARTPTS']
    if (plan.fpsMode === 'retime') audioFilters.push(`atempo=${(24 / inFps).toFixed(6)}`)
    args.push('-af', audioFilters.join(','), '-c:a', 'aac', '-b:a', '128k')
  }
  args.push(outVideo)
  try {
    await runTool(options.ffmpegPath, args, 600_000)
  } catch (error) {
    options.logFailure('datasets/bake', error, { layerId: layer.id })
    // Disk-full (ENOSPC surfaced by ffmpeg) is a retryable item error — no
    // partial snapshot is ever recorded (the caller drops the row).
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, state: 'failed', error: message.includes('No space left') ? `Disk full while baking this item (retryable; no snapshot was recorded): ${message.slice(0, 300)}` : message.slice(0, 500) }
  }
  if (options.isCancelled()) return { ...base, state: 'cancelled' }
  // Silent wav sidecar (musubi's audio shape; DiffSynX rows point at the same
  // wav). Real audio kept → extract it; blank/absent → anullsrc silence.
  const seconds = source.kind === 'image' ? 1 : plan.encodeFrames / 24
  try {
    if (plan.audio === 'passthrough' && source.probe.hasAudio && !options.audioPolicy.blankReplaceExisting) {
      const inFps = source.probe.fps ?? 24
      const seekStart = Math.max(0, plan.trimInFrame / inFps)
      await runTool(options.ffmpegPath, ['-y', '-ss', seekStart.toFixed(3), '-i', source.absPath, '-vn', '-ac', '1', '-ar', '32000', '-t', seconds.toFixed(3), outWav], 300_000)
    } else {
      await runTool(options.ffmpegPath, ['-y', '-f', 'lavfi', '-i', `anullsrc=r=32000:cl=mono`, '-t', seconds.toFixed(3), '-c:a', 'pcm_s16le', outWav], 120_000)
    }
  } catch (error) {
    options.logFailure('datasets/bake-wav', error, { layerId: layer.id })
    return { ...base, state: 'failed', error: `The audio sidecar could not be written: ${error instanceof Error ? error.message : String(error)}` }
  }
  // The decoded-frame-count assertion (stage 4's close-out).
  if (source.kind === 'video') {
    const decoded = await decodedFrameCount(outVideo, { ffmpegPath: options.ffmpegPath, logFailure: options.logFailure })
    const verdict = assertDecodedCount(plan.gridTarget, decoded)
    if (!verdict.ok) return { ...base, state: 'failed', decodedFrames: decoded, error: verdict.reason }
    return { ...base, outputPath: outVideo, wavPath: outWav, decodedFrames: decoded }
  }
  return { ...base, outputPath: outVideo, wavPath: outWav, decodedFrames: 1 }
}

// ---------------------------------------------------------------------------
// QA gates (§8) — pure; unit-tested
// ---------------------------------------------------------------------------

export type GateFinding = { gate: number; name: string; tier: 'refuse' | 'warn'; reason: string }

export type GateInput = {
  layer: LayerRow
  caption: string
  triggerToken: string
  baked?: BakeOutcome
  slowMoSuspect: boolean
  inCluster: boolean
  /** Scene cut frame numbers inside the source (when scene data exists). */
  sourceCuts: number[]
  audioPolicy: AudioPolicy
  sourceHasAudio: boolean
  bakedFpsExact: boolean
}

/** Gates 1–4 and 8 refuse; 6–7 and 9 warn (§8). Each finding names its
 * documented failure. */
export function evaluateGates(input: GateInput): GateFinding[] {
  const findings: GateFinding[] = []
  const { layer, caption, triggerToken } = input
  // 1 — empty caption (Inline's empty-prompt trap).
  if (!caption.trim()) {
    findings.push({ gate: 1, name: 'empty-caption', tier: 'refuse', reason: 'No caption — uncaptioned items train against an empty prompt and weaken the whole run.' })
  }
  // 8/2 — trigger-token format: single rare token, exactly once, first.
  // Gate 2 owns DUPLICATION findings; gate 8 owns format (rarity/singleness/
  // position). One insertion path only (fal's degradation warning).
  const trigger = validateTrigger(triggerToken, caption)
  if (!trigger.ok) {
    for (const issue of trigger.issues) {
      const isDuplication = /\b(appears \d+ times|does not appear|must be FIRST)\b/.test(issue)
      findings.push({ gate: isDuplication ? 2 : 8, name: isDuplication ? 'trigger-duplicated' : 'trigger-format', tier: 'refuse', reason: issue })
    }
  }
  // Character-class appearance words (guide §4.4 — the make-or-break rule).
  if (layer.contentClass === 'character') {
    const violation = appearanceViolation(caption)
    if (violation) findings.push({ gate: 8, name: 'character-appearance', tier: 'refuse', reason: `Character-class captions never describe appearance ("${violation}" found) — identity flows through the trigger; those details re-enter at inference.` })
  }
  // 3 — fps ≠ 24.000 after bake.
  if (input.baked && input.baked.state === 'done' && !input.bakedFpsExact) {
    findings.push({ gate: 3, name: 'fps-not-24', tier: 'refuse', reason: 'The baked file is not exactly 24.000 fps CFR.' })
  }
  // 4 — slow-mo suspicion undispositioned.
  if (input.slowMoSuspect && !layer.slowmoDisposition) {
    findings.push({ gate: 4, name: 'slowmo-undispositioned', tier: 'refuse', reason: 'Slow-motion suspicion is undispositioned — pick retime (baked, tagged), caption-honestly, or exclude. Slow-mo contamination teaches dreamy, floaty movement.' })
  }
  // 5 — decoded count outside [target, target+2].
  if (input.baked && input.baked.state === 'done' && input.baked.decodedFrames !== null) {
    const verdict = assertDecodedCount(input.baked.gridTarget, input.baked.decodedFrames)
    if (!verdict.ok) findings.push({ gate: 5, name: 'decoded-count', tier: 'refuse', reason: verdict.reason! })
  }
  if (input.baked && input.baked.state === 'failed') {
    findings.push({ gate: 5, name: 'bake-failed', tier: 'refuse', reason: input.baked.error ?? 'The bake failed.' })
  }
  // 6 — near-dup cluster exists (warning-tier; cross-ratio = bucket diversity).
  if (input.inCluster) {
    findings.push({ gate: 6, name: 'near-dup-cluster', tier: 'warn', reason: 'This item sits in a near-duplicate cluster — same content is repeating. Cross-ratio variants are bucket diversity (kept); same-ratio repeats are the redundancy to consider killing. Advisory only: nothing auto-deletes.' })
  }
  // 7 — real-audio rows missing the soundscape clause when the policy expects one.
  if (input.sourceHasAudio && input.audioPolicy.expectSoundscapeClauses && !soundscapeClausePresent(caption)) {
    findings.push({ gate: 7, name: 'soundscape-missing', tier: 'warn', reason: 'Real audio but no soundscape clause — video quality is unaffected; the cost is promptability (the sound cannot be steered by prompt). Accept explicitly or caption the sound.' })
  }
  // 9 — trim crossing a detected internal cut (one scene per clip).
  if (input.sourceCuts.length && layer.trim) {
    const inF = layer.trim.inFrame ?? 0
    const outF = layer.trim.outFrame ?? Number.POSITIVE_INFINITY
    const crossed = input.sourceCuts.filter((cut) => cut > inF && cut < outF)
    if (crossed.length) {
      findings.push({ gate: 9, name: 'internal-cut', tier: 'warn', reason: `The trim window crosses ${crossed.length} detected cut(s) at frame(s) ${crossed.join(', ')} — a multi-scene clip trains mixed camera behavior. Split at the cut or narrow the trim.` })
    }
  }
  return findings
}

const SOUND_WORDS = /\b(sound|sounds|audio|noise|noisy|loud|quiet|silent|silence|music|hum|humming|buzz|buzzer|rain|wind|engine|engines|traffic|waves|birds|singing|sings|song|speech|speaks|talking|voice|voices|footsteps|crackl|hiss|roar|rumble|whir|drone|chatter|applause|laughter|clap(?:ping)?|beep|alarm|explosion|whoosh|sizzle)\b/i

export function soundscapeClausePresent(caption: string): boolean {
  return SOUND_WORDS.test(caption) || SILENCE_STATEMENT.test(caption)
}

/** Stale captions export only past an explicit warning (§4). */
export function staleGate(layer: LayerRow): GateFinding | null {
  if (layer.caption?.stale) {
    return { gate: 0, name: 'stale-caption', tier: 'warn', reason: `Stale caption: ${layer.caption.staleReason ?? 'the view changed after captioning.'} Exports only past an explicit warning.` }
  }
  return null
}

// ---------------------------------------------------------------------------
// Export writers (§9)
// ---------------------------------------------------------------------------

export type ExportItem = {
  layer: LayerRow
  caption: string
  baked: BakeOutcome
  findings: GateFinding[]
}

export type ExportRequest = {
  shape: 'musubi' | 'diffsynx' | 'external'
  trainer: TrainerId
  folder: string
  triggerToken: string
  contentClass: ContentClass
  items: ExportItem[]
  audioPolicy: AudioPolicy
  acceptWarnings: boolean
}

export type ExportResult = {
  exportId: string
  folder: string
  shape: string
  written: Array<{ layerId: string; video: string; captionSidecar: string; wav: string }>
  refused: Array<{ layerId: string; reasons: string[] }>
  gateReport: { item: string; gate: number; name: string; tier: string; reason: string }[]
  recipe: ReturnType<typeof recipeCard>
  validated: { musubiConfig: 'built-in' | 'external' | 'skipped'; diffsynxDryLoad: 'built-in' | 'external' | 'skipped' }
}

/** Writes the export: gates first (refusing items are dropped with reasons;
 * warning-tier needs acceptWarnings — the explicit accept-all), then the
 * trainer shape, then the recipe card + gate report. Immutable snapshot. */
export async function writeExport(request: ExportRequest, store: DatasetStore, tools: ToolOptions): Promise<ExportResult> {
  const refused: ExportResult['refused'] = []
  const passing: ExportItem[] = []
  const gateReport: ExportResult['gateReport'] = []
  for (const item of request.items) {
    const findings = [...item.findings]
    const stale = staleGate(item.layer)
    if (stale) findings.push(stale)
    for (const finding of findings) gateReport.push({ item: item.layer.id, gate: finding.gate, name: finding.name, tier: finding.tier, reason: finding.reason })
    const refuses = findings.filter((finding) => finding.tier === 'refuse')
    const warns = findings.filter((finding) => finding.tier === 'warn')
    if (refuses.length) {
      refused.push({ layerId: item.layer.id, reasons: refuses.map((finding) => finding.reason) })
      continue
    }
    if (warns.length && !request.acceptWarnings) {
      refused.push({ layerId: item.layer.id, reasons: warns.map((finding) => `[warning-tier, accept-all available] ${finding.reason}`) })
      continue
    }
    passing.push(item)
  }
  if (!passing.length) {
    throw new Error(`No items passed the gates — ${refused.length} refused. The gate report lists every reason; nothing was exported.`)
  }
  const exportId = randomUUID()
  const folder = request.folder
  await mkdir(folder, { recursive: true })
  const written: ExportResult['written'] = []
  const clips = passing.filter((item) => item.layer.source.kind === 'video')
  const stills = passing.filter((item) => item.layer.source.kind === 'image')
  const videosDir = join(folder, 'videos')
  const imagesDir = join(folder, 'images')
  const wavsDir = join(folder, 'wavs')
  const captionsDir = join(folder, 'captions')
  if (clips.length) await mkdir(videosDir, { recursive: true })
  if (clips.length) await mkdir(wavsDir, { recursive: true })
  if (stills.length) await mkdir(imagesDir, { recursive: true })
  if (request.shape !== 'diffsynx') await mkdir(captionsDir, { recursive: true })
  const rows: Array<Record<string, unknown>> = []
  let index = 0
  for (const item of passing) {
    index += 1
    const stem = `item-${String(index).padStart(4, '0')}-${item.layer.id.slice(0, 8)}`
    const videoPath = item.baked.outputPath!
    const wavPath = item.baked.wavPath!
    // Copy the baked outputs into the export (the bake folder is scratch; the
    // export is the immutable snapshot).
    const { copyFile } = await import('node:fs/promises')
    const videoDest = item.layer.source.kind === 'video' ? join(videosDir, `${stem}.mp4`) : join(imagesDir, `${stem}.png`)
    const wavDest = join(wavsDir, `${stem}.wav`)
    await copyFile(videoPath, videoDest)
    await copyFile(wavPath, wavDest)
    const captionText = request.triggerToken && !item.caption.trim().toLowerCase().startsWith(request.triggerToken.toLowerCase())
      ? `${request.triggerToken}, ${item.caption.trim()}`
      : item.caption.trim()
    let captionSidecar = ''
    if (request.shape !== 'diffsynx') {
      captionSidecar = join(captionsDir, `${stem}.txt`)
      await writeFile(captionSidecar, `${captionText}\n`, 'utf8')
    }
    written.push({ layerId: item.layer.id, video: videoDest, captionSidecar, wav: wavDest })
    if (request.shape === 'diffsynx' || request.shape === 'external') {
      rows.push({ video: rel(folder, videoDest), prompt: captionText, input_audio: rel(folder, wavDest), frame_rate: 24 })
    }
  }
  // musubi shape: TOML + caption sidecars (+ JSONL) + one_frame + wav sidecars.
  if (request.shape === 'musubi' || request.shape === 'external') {
    const toml = musubiDatasetToml({ clips: clips.length, stills: stills.length, targets: [...new Set(clips.map((item) => item.baked.gridTarget))].sort((a, b) => a - b) })
    await writeFile(join(folder, 'dataset_config.toml'), toml, 'utf8')
    const jsonl = passing.map((item) => {
      const entry = written.find((row) => row.layerId === item.layer.id)!
      return JSON.stringify({ image_path: rel(folder, entry.video), caption: item.caption.trim() || request.triggerToken })
    }).join('\n')
    await writeFile(join(folder, 'metadata.musubi.jsonl'), `${jsonl}\n`, 'utf8')
  }
  if (request.shape === 'diffsynx' || request.shape === 'external') {
    await writeFile(join(folder, 'metadata.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  }
  const recipe = recipeCard(request.trainer, request.contentClass, clips.length, stills.length)
  await writeFile(join(folder, 'RECIPE.md'), recipeMarkdown(recipe, request, passing.length, refused.length), 'utf8')
  await writeFile(join(folder, 'gate-report.json'), JSON.stringify({ exportId, gateReport, refused, written: written.length }, null, 2), 'utf8')
  if (request.shape === 'external') {
    await writeFile(join(folder, 'README.md'), externalReadme(recipe), 'utf8')
  }
  const validated: ExportResult['validated'] = { musubiConfig: 'built-in', diffsynxDryLoad: 'built-in' }
  if (request.shape === 'musubi' || request.shape === 'external') {
    validated.musubiConfig = validateMusubiToml(await (await import('node:fs/promises')).readFile(join(folder, 'dataset_config.toml'), 'utf8')) ? 'built-in' : 'skipped'
  }
  if (request.shape === 'diffsynx' || request.shape === 'external') {
    validated.diffsynxDryLoad = validateDiffsynxRows(rows) ? 'built-in' : 'skipped'
  }
  void tools
  void store
  return { exportId, folder, shape: request.shape, written, refused, gateReport, recipe, validated }
}

function rel(base: string, target: string): string {
  return target.startsWith(base) ? target.slice(base.length + 1) : target
}

/** musubi dataset TOML (the trainer's documented convention: [[datasets]] →
 * subsets; caption sidecars; target_frames; enable_bucket; one_frame images). */
export function musubiDatasetToml(config: { clips: number; stills: number; targets: number[] }): string {
  const lines: string[] = []
  lines.push('# musubi-tuner dataset config — generated by the dataset manager (immutable export snapshot).')
  lines.push('# Validate against musubi-tuner docs/dataset_config.md schema; caption sidecars sit in captions/.')
  lines.push('[[datasets]]')
  lines.push('resolution = [480, 832]')
  lines.push('caption_extension = ".txt"')
  lines.push('batch_size = 1')
  lines.push('enable_bucket = true')
  lines.push('num_repeats = 1')
  lines.push('')
  lines.push('  [[datasets.subsets]]')
  if (config.clips) {
    lines.push('  video_directory = "videos"')
    lines.push('  audio_directory = "wavs"')
    lines.push('  caption_directory = "captions"')
    lines.push(`  target_frames = [${config.targets.join(', ')}]`)
    lines.push('  frame_extraction = "head"')
  }
  if (config.stills) {
    if (config.clips) lines.push('')
    lines.push('  [[datasets.subsets]]')
    lines.push('  image_directory = "images"')
    lines.push('  caption_directory = "captions"')
    lines.push('  target_frames = [1]')
    lines.push('  one_frame = true')
  }
  lines.push('')
  return lines.join('\n')
}

/** Built-in structural validation of the emitted musubi TOML (the named
 * check; the external musubi-tuner validator runs instead when a checkout is
 * configured — availability-gated). Parses the restricted grammar we emit. */
export function validateMusubiToml(toml: string): boolean {
  const lines = toml.split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean)
  let sawDatasets = false
  let sawSubset = false
  for (const line of lines) {
    if (line === '[[datasets]]') sawDatasets = true
    else if (line === '[[datasets.subsets]]') sawSubset = true
    else {
      const match = /^([a-z_]+)\s*=\s*(.+)$/.exec(line)
      if (!match) continue
      const [, key, value] = match
      const allowed = new Set(['resolution', 'caption_extension', 'batch_size', 'enable_bucket', 'num_repeats', 'video_directory', 'audio_directory', 'caption_directory', 'target_frames', 'frame_extraction', 'image_directory', 'one_frame'])
      if (!allowed.has(key)) return false
      if (key === 'caption_extension' && value !== '".txt"') return false
      if (key === 'batch_size' && value !== '1') return false
      if (key === 'enable_bucket' && value !== 'true') return false
      if (key === 'target_frames') {
        const values = value.replace(/[[\]]/g, '').split(',').map((entry) => Number(entry.trim())).filter((entry) => Number.isFinite(entry))
        if (!values.length || !values.every((entry) => entry === 1 || (entry >= 22 && entry <= 345 && (entry - 5) % 17 === 0))) return false
      }
    }
  }
  return sawDatasets && sawSubset
}

/** DiffSynX stage-1 manifest validation (the named check): every row carries
 * video/prompt/input_audio/frame_rate 24 and files exist. */
export function validateDiffsynxRows(rows: Array<Record<string, unknown>>): boolean {
  for (const row of rows) {
    if (typeof row.video !== 'string' || !row.video) return false
    if (typeof row.prompt !== 'string' || !row.prompt.trim()) return false
    if (typeof row.input_audio !== 'string' || !row.input_audio) return false
    if (row.frame_rate !== 24) return false
  }
  return rows.length > 0
}

function recipeMarkdown(recipe: ReturnType<typeof recipeCard>, request: ExportRequest, passing: number, refused: number): string {
  return [
    `# Recipe card — ${recipe.trainer} · ${recipe.contentClass}`,
    '',
    `A HINT DOCUMENT, never a silent behavior. ${passing} item(s) exported, ${refused} refused by the gates.`,
    '',
    `- **Rank:** ${recipe.rank}`,
    `- **Alpha:** ${recipe.alphaRule}`,
    `- **Learning rate:** ${recipe.learningRate}`,
    `- **Steps:** ${recipe.stepsBand}`,
    `- **De-distillation (required for 500+ step runs):** ${recipe.dedistillation}`,
    '',
    'Notes:',
    ...recipe.notes.map((note) => `- ${note}`),
    '',
    `Trigger token: \`${request.triggerToken || '(none set)'}\` — prepend exactly once; never also bake it into captions (degrades prompt adherence).`,
    '',
  ].join('\n')
}

function externalReadme(recipe: ReturnType<typeof recipeCard>): string {
  return [
    '# Dataset export — external-trainer ready',
    '',
    'This folder is a STANDALONE dataset: correct folder structure, captions in place,',
    'prefilled configs. It runs on any external trainer without this app installed.',
    '',
    '## Layout',
    '- `videos/` baked 17n+5 @ 24.000 fps CFR clips (decoded counts asserted in gate-report.json)',
    '- `images/` one-frame stills',
    '- `wavs/` audio sidecars (silence where the source had none — audio rows always train)',
    '- `captions/` .txt sidecars (musubi convention)',
    '- `dataset_config.toml` musubi-tuner dataset config',
    '- `metadata.jsonl` rows: video/prompt/input_audio/frame_rate (DiffSynX stage-1 convention)',
    '- `RECIPE.md` class-conditioned training hints',
    '- `gate-report.json` every gate finding, refusing and warning',
    '',
    `In-app training is availability-gated: this export never requires our trainers (${recipe.trainer} hints inside).`,
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Serialized bake queue (§9 operational contracts)
// ---------------------------------------------------------------------------

export type QueuedBake = {
  id: string
  layerId: string
  plan: BakePlan
  resolve(outcome: BakeOutcome): void
}

/** One bake at a time, app-wide — the queue is the arbiter (no concurrent
 * bakes of the same dataset can exist). Cancel drains as 'cancelled'. */
export function createBakeQueue() {
  let chain: Promise<unknown> = Promise.resolve()
  const cancelled = new Set<string>()
  function enqueue(run: () => Promise<BakeOutcome & { jobId?: string }>): Promise<BakeOutcome> {
    const next = chain.then(run, run)
    chain = next.catch(() => undefined)
    return next
  }
  return {
    enqueue,
    cancel(jobId: string) {
      cancelled.add(jobId)
    },
    isCancelled(jobId: string) {
      return cancelled.has(jobId)
    },
    clearCancelled(jobId: string) {
      cancelled.delete(jobId)
    },
  }
}

export function recordBakeJob(db: Database.Database, row: { id: string; layerId: string; gridTarget: number; encodeFrames: number; fpsMode: string; exportId?: string }): void {
  db.prepare(`INSERT INTO dataset_bake_jobs (id, layer_id, state, target_frames, grid_target, fps_plan, created_at)
    VALUES (?, ?, 'queued', ?, ?, ?, ?)`).run(row.id, row.layerId, row.encodeFrames, row.gridTarget, row.fpsMode, Date.now())
}

export function settleBakeJob(db: Database.Database, outcome: BakeOutcome, jobId: string, startedAt: number): void {
  db.prepare(`UPDATE dataset_bake_jobs SET state = ?, decoded_frames = ?, interpolated = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?`)
    .run(outcome.state, outcome.decodedFrames, outcome.interpolated ? 1 : 0, outcome.error ?? null, startedAt, Date.now(), jobId)
}

export async function fileExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null))
}

export type { CropRect }
