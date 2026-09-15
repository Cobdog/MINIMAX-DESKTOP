/**
 * Temporal-reference routing, ported from motion.py of
 * NyckM/3d-Camera-control-H3-Minimax (bruxosdovfx "Camera H3", v19.1 @
 * 846880d, Apache-2.0): the Freeze Frame / Motion Frame pipeline that wraps
 * compileCamera. The pure port swaps tensors for shape carriers — the
 * resampling DECISION (indices + 17k+5 truncation) is computed here and the
 * caller applies it to real frames.
 *
 * Motion Frame semantics (<Video 1>): the reference is a VIDEO whose action
 * continues; loop-closure anchoring is disabled (the end no longer matches
 * the start); H3 Edit options are replaced by the Ref2VA requirement marker;
 * the plan prose is rewritten to preserve/forbid/reference contracts.
 */
import { ELEVATION_RANGES, MOTION_MODES } from './constants'
import { compileCamera, choice } from './compileCamera'
import { diagnosticText, reviewPath } from './diagnostics'
import { pyFormatG, pyJsonStringify, pyRound, replaceAll } from './parity'
import { planText } from './promptText'
import type {
  CameraStoryboard, CompileMotionParams, CompileMotionResult, ImageShape, MotionResample,
} from './types'

interface FramesPlan {
  referenceShape: ImageShape | null
  referenceFrameCount: number
  inputCount: number
  resample: MotionResample | null
}

/** Pure form of upstream prepare_frames: validates the sequence, picks the
 *  freeze frame or computes the 24 fps resample, and truncates to the
 *  native-H3 17k+5 grid. Same error taxonomy as upstream. */
export function motionFrameResample(frameCount: number, sourceFps: number): MotionResample {
  if (!Number.isFinite(frameCount) || !Number.isFinite(sourceFps) || sourceFps <= 0) {
    throw new Error('PT: source_fps deve ser positivo. EN: source_fps must be positive.')
  }
  const target = pyRound(frameCount * 24 / sourceFps)
  if (frameCount < 2 || !(48 <= target && target <= 360)) {
    throw new Error('PT: Motion Frame aceita 2 a 15 segundos; recorte o vídeo antes. EN: Motion Frame accepts 2–15 seconds; trim the source first.')
  }
  const indices: number[] = []
  for (let i = 0; i < target; i += 1) indices.push(Math.min(frameCount - 1, Math.trunc(i * sourceFps / 24)))
  // Native H3 video references truncate to 17k+5; make that visible in our own output.
  const aligned = 5 + 17 * Math.floor((target - 5) / 17)
  return { target, aligned, indices: indices.slice(0, aligned) }
}

function prepareFramesPlan(images: ImageShape | null | undefined, mode: string, sourceFps: number, freezeIndex: number): FramesPlan {
  if (!images) {
    if (mode === 'Motion Frame') throw new Error('PT: Conecte uma sequência IMAGE. EN: Connect an IMAGE sequence.')
    return { referenceShape: null, referenceFrameCount: 0, inputCount: 0, resample: null }
  }
  const shape = images.shape
  if (shape.length !== 4 || shape[0] < 1 || shape[shape.length - 1] !== 3) {
    throw new Error('PT: Use frames RGB [N,H,W,3]. EN: Use RGB frames [N,H,W,3].')
  }
  const count = Math.trunc(shape[0])
  if (mode === 'Freeze Frame') {
    if (!(freezeIndex >= 0 && freezeIndex < count)) {
      throw new Error('PT: freeze_index fora do lote. EN: freeze_index outside the batch.')
    }
    return {
      referenceShape: { shape: [1, shape[1], shape[2], shape[3]] },
      referenceFrameCount: 1,
      inputCount: count,
      resample: null,
    }
  }
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
    throw new Error('PT: source_fps deve ser positivo. EN: source_fps must be positive.')
  }
  const resample = motionFrameResample(count, sourceFps)
  return {
    referenceShape: { shape: [resample.aligned, shape[1], shape[2], shape[3]] },
    referenceFrameCount: resample.aligned,
    inputCount: count,
    resample,
  }
}

/** Rewrite the plan for Motion Frame (<Video 1> semantics) — mutates and
 *  returns the same storyboard, exactly like upstream motion_plan(). */
export function motionPlan(plan: CameraStoryboard): CameraStoryboard {
  plan.frame_mode = 'Motion Frame'
  plan.reference = 'Use <Video 1> as the temporal reference. Begin at its initial scene state and viewing angle. Preserve the sequence and timing of its actions while generating the requested new camera path.'
  plan.preserve = 'Preserve identities, objects, scene structure and the action progression of <Video 1>. People, fire, smoke, water and other moving elements continue their source actions. Do not freeze time, replay a single frame, or replace the action with an orbiting still.'
  plan.forbid = 'No cuts, temporal freezing, reversed playback, unrelated new actions, digital zoom or visible planning annotations. Do not rotate the subject as a substitute for moving the camera; preserve subject motion present in <Video 1>.'
  plan.final += ' Any camera hold holds only the viewpoint; the source action continues.'
  const anchor = plan.coordinate_anchor!
  anchor.instruction = replaceAll(replaceAll(replaceAll(
    anchor.instruction,
    'reference first frame', 'first frame of <Video 1>'),
    'reference image', 'first frame of <Video 1>'),
    'fixed orbit target', 'initial orbit target; track the same subject as its action progresses')
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return replaceAll(replaceAll(replaceAll(
        value,
        'the subject itself stays stationary', 'the subject continues its source action'),
        'fixed target', 'tracked subject target'),
        'fixed orbit target', 'tracked subject target')
    }
    if (Array.isArray(value)) return value.map(rewrite)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = rewrite(v)
      return out
    }
    return value
  }
  return rewrite(plan) as CameraStoryboard
}

/** planText with the <Picture 1> lines swapped for <Video 1> semantics. */
export function motionText(plan: CameraStoryboard, sections = false): string {
  const text = planText(plan, sections)
  return replaceAll(replaceAll(
    text,
    '<Picture 1> is the exact reference first frame.', '<Video 1> is the temporal action reference.'),
    '<Picture 1>: preserve the subjects and scene in world space.',
    '<Video 1>: preserve identity and action progression while changing the camera viewpoint.')
}

/** The full editor pipeline (motion.H3CameraEditor.run): compile, then apply
 *  the frame-mode semantics, banner, and diagnostics. Freeze Frame routes to
 *  the same image (FL2VA); Motion Frame rewrites the plan for Ref2VA. */
export function compileMotion(params: CompileMotionParams): CompileMotionResult {
  const loopClosure = choice(params.loopClosure, ['auto', 'off'], 'auto')
  const frameMode = choice(params.frameMode, MOTION_MODES, 'Freeze Frame')
  const runtimeTaskRaw = params.runtimeTask
  if (frameMode === 'Motion Frame' && runtimeTaskRaw && runtimeTaskRaw !== 'scene coverage | camera path') {
    throw new Error('PT: Motion Frame exige runtime_task camera path. EN: Motion Frame requires camera path runtime_task.')
  }
  const sourceFps = params.sourceFps ?? 24
  const freezeIndex = params.freezeIndex ?? 0
  const prep = prepareFramesPlan(params.referenceImage ?? null, frameMode, sourceFps, freezeIndex)
  const result = compileCamera({
    cameraTrajectory: params.cameraTrajectory,
    profile: params.profile,
    interpolation: params.interpolation,
    instruction: params.instruction,
    subjectFraming: params.subjectFraming,
    minimaxFormat: params.minimaxFormat,
    referenceImage: prep.referenceShape,
    elevationRange: params.elevationRange,
    orbitDirection: params.orbitDirection,
    subjectBox: params.subjectBox,
    runtimeTask: params.runtimeTask,
    promptDetail: params.promptDetail,
    allowClosure: frameMode === 'Freeze Frame' && loopClosure === 'auto',
  })
  let plan = JSON.parse(result.storyboardJson) as CameraStoryboard
  plan.frame_mode = frameMode
  plan.loop_closure_request = loopClosure
  plan.loop_closure_enabled = Boolean((result.options as Record<string, unknown>).coverage_loop_closure)
  plan.user_instruction = params.instruction || ''
  plan.source = {
    input_frames: prep.inputCount,
    source_fps: sourceFps,
    reference_frames: prep.referenceShape ? prep.referenceFrameCount : 0,
    freeze_index: frameMode === 'Freeze Frame' ? freezeIndex : null,
  }
  if (frameMode === 'Motion Frame') {
    // Python reassigns plan = motion_plan(plan): the deep rewrite returns a
    // rebuilt tree, so every later read/serialization must use the result.
    plan = motionPlan(plan)
    result.compiledPrompt = motionText(plan, true)
    result.minimaxPrompt = params.minimaxFormat === 'compact JSON' || params.minimaxFormat === 'compact JSON (no boxes)'
      ? pyJsonStringify(plan)
      : motionText(plan, params.minimaxFormat === 'coordinate + H3 sections')
    // Prevent a frozen scene-coverage encoder from silently taking over a motion request.
    result.options = { coverage_loop_closure: false, bruxosdovfx_requires_ref2va: true }
  }
  const en = params.uiLanguage === 'English'
  const sourceCount = prep.referenceShape ? prep.referenceFrameCount : 0
  const closure = Boolean((result.options as Record<string, unknown>).coverage_loop_closure)
  const route = frameMode === 'Motion Frame'
    ? (en
      ? 'Motion: feed your frame sequence and this minimax_prompt and length to bruxosdovfx H3 Motion Reference; use H3 Ref2VA. Do not use H3 Edit options.'
      : 'Motion: leve a sua sequência de frames junto com este minimax_prompt e length ao bruxosdovfx H3 Motion Reference; use H3 Ref2VA. Não use options do H3 Edit.')
    : (en
      ? 'Freeze: feed the same image you connected here as the source image. Loop closure requires H3 Edit options and source wiring; native H3 needs separate end-frame wiring.'
      : 'Freeze: use a mesma imagem que você ligou aqui como imagem de origem. Loop closure exige options e imagem no H3 Edit; H3 nativo precisa de ligação separada do último frame.')
  const rawPath = plan.path
  const net = Math.abs(rawPath[rawPath.length - 1].azimuth - rawPath[0].azimuth)
  const reasons: string[] = []
  if (loopClosure === 'off') reasons.push(en ? 'disabled by user' : 'desativado pelo usuário')
  if (frameMode === 'Motion Frame') reasons.push(en ? 'action continues' : 'a ação continua')
  if (!prep.referenceShape) reasons.push(en ? 'no reference image' : 'sem imagem de referência')
  if (Math.abs(net - 360) > 1e-6) {
    reasons.push(en ? `orbit ${pyFormatG(net)}°; requires 360°` : `giro ${pyFormatG(net)}°; exige 360°`)
  }
  for (const [key, pt] of [['elevation', 'elevação'], ['distance', 'distância']] as const) {
    if (Math.abs(rawPath[rawPath.length - 1][key] - rawPath[0][key]) > 1e-6) {
      reasons.push(`${en ? key : pt}: ${pyFormatG(rawPath[rawPath.length - 1][key])} → ${pyFormatG(rawPath[0][key])}`)
    }
  }
  if (runtimeTaskRaw && runtimeTaskRaw !== 'scene coverage | camera path') {
    reasons.push(en ? 'still-image task' : 'tarefa de imagem')
  }
  result.info = `bruxosdovfx v19.1 | ${frameMode} | ${result.frames} frames / 24 fps\n` + route
    + '\nLoop closure ' + (closure ? 'ON' : 'OFF') + (reasons.length > 0 ? ': ' + reasons.join(', ') : '')
    + `\n${en ? 'Source / reference frames' : 'Frames da fonte / referência'}: ${prep.inputCount} / ${sourceCount}. `
    + (en
      ? 'Reference is resampled to 24 fps and trimmed to 17k+5; up to 16 trailing frames may be omitted. Camera following remains prompt-based.'
      : 'Referência reamostrada para 24 fps e cortada para 17k+5; até 16 frames finais podem ser omitidos. A câmera continua guiada por prompt.')
  const warnings = reviewPath(plan.path, plan.duration_s, ELEVATION_RANGES[params.elevationRange ?? ''] ?? 30)
  plan.diagnostics = warnings
  result.storyboardJson = pyJsonStringify(plan)
  result.info += '\n' + diagnosticText(warnings, en)
  if (frameMode === 'Freeze Frame') {
    result.info += '\n' + (en
      ? 'Frame batch resampling applies only to Motion Frame; Freeze uses just the selected frame.'
      : 'A reamostragem do lote só se aplica a Motion Frame; Freeze usa apenas o frame selecionado.')
  }
  return { ...result, diagnostics: warnings, resample: prep.resample }
}
