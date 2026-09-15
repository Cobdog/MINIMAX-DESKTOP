/**
 * The camera compiler, ported from compile_camera() (+ _choice) in camera.py
 * of NyckM/3d-Camera-control-H3-Minimax (bruxosdovfx "Camera H3", v19.1 @
 * 846880de859959e801b2c506dc424bd5c8b5c6c4, Apache-2.0). Faithful port for
 * task ving89w — quirks preserved as quirks:
 *
 *  - 'invert H3 orbit' (the DEFAULT) negates the azimuth sent to the model
 *    because H3 tends to mirror the requested direction; the saved HUD
 *    trajectory is untouched (storyboard carries both `path` and
 *    `model_path`).
 *  - Loop closure engages ONLY at exactly ±360° net azimuth AND elevation +
 *    distance returning, with a reference image connected — anything else
 *    produces the Portuguese motivos note quantifying how close it was.
 *  - Timing is (frames-1)/24 — the last-visible-frame convention — except
 *    the directed still-image task, which settles at 65% of its clip.
 *  - The v16 info banner and PT diagnostics strings are ported verbatim.
 */
import {
  DIRECTED_SETTLE, DIRECTED_TAIL_CANDIDATES, ELEVATION_RANGES, FRAMINGS, FPS,
  MINIMAX_FORMATS, ORBIT_DIRECTIONS, PROFILES, PROMPT_DETAIL, RUNTIME_TASKS,
} from './constants'
import { imageAspect } from './cameraText'
import { coordinateAnchor } from './coordinateAnchor'
import { buildPlan } from './planBuilder'
import { pyFixed, pyFormatG, pyJsonStringify, pyRepr } from './parity'
import { planText } from './promptText'
import type {
  CameraKeyframe, CameraStoryboard, CompileCameraParams, CompileResult, H3EditOptions, PromptDetail,
} from './types'
import { validatePath } from './validatePath'

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

/** Older saved workflows deserialize new widgets as '' or None; use the
 *  default. Unknown values raise with the allowed list (taxonomy ported). */
function choice<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return fallback
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unknown option ${pyRepr(value)}. Allowed: ${allowed.join(', ')}.`)
  }
  return value as T
}

function isCloseAbs(a: number, b: number, absTol: number): boolean {
  return Math.abs(a - b) <= absTol
}

/** Compile a trajectory into prompts + options + storyboard. Throws Error
 *  with the upstream message taxonomy for invalid paths or options. */
export function compileCamera(params: CompileCameraParams): CompileResult {
  const {
    cameraTrajectory: raw, profile, interpolation, instruction,
    referenceImage, subjectBox,
  } = params
  if (!(profile in PROFILES) || (interpolation !== 'smooth' && interpolation !== 'linear')) {
    throw new Error('Unknown duration profile or interpolation.')
  }
  const framing = choice(params.subjectFraming, Object.keys(FRAMINGS) as Array<keyof typeof FRAMINGS>, 'medium shot')
  const minimaxFormat = choice(params.minimaxFormat, MINIMAX_FORMATS, 'coordinate only')
  const elevationRange = choice(params.elevationRange, Object.keys(ELEVATION_RANGES) as Array<keyof typeof ELEVATION_RANGES>, '+/-30')
  const orbitDirection = choice(params.orbitDirection, ORBIT_DIRECTIONS, 'invert H3 orbit')
  const runtimeTask = choice(params.runtimeTask, Object.keys(RUNTIME_TASKS), 'scene coverage | camera path')
  const promptDetail = choice(params.promptDetail, PROMPT_DETAIL, 'v15 baseline')
  const task = RUNTIME_TASKS[runtimeTask]
  const allowClosure = params.allowClosure ?? true
  const hudPath = validatePath(raw)
  const sign = orbitDirection === 'invert H3 orbit' ? -1 : 1
  // Calibrate prompt-side orbit; leave the saved HUD trajectory untouched.
  const path: CameraKeyframe[] = hudPath.map((p) => ({ ...p, azimuth: p.azimuth * sign }))
  let frames: number
  let end: number
  if (task) {
    // Upstream times this profile as frames / fps and settles at 65 percent of that.
    frames = task.frames
    const clip = frames / FPS
    end = clip * DIRECTED_SETTLE
  } else {
    frames = Number.parseInt(profile.trim().split(/\s+/)[0], 10)
    end = (frames - 1) / FPS
  }
  const aspect = referenceImage != null ? imageAspect(referenceImage) : null
  const net = path[path.length - 1].azimuth - path[0].azimuth
  const turn = Math.abs(net) % 360
  const arc = turn < 1e-6 && Math.abs(net) > 1e-6 ? 360.0 : clamp(turn, 15.0, 360.0)
  // Upstream only engages loop closure at exactly 360 degrees with the frame anchor.
  // The upstream encoder can anchor the final frame to the source; this constrains
  // the endpoint, but does not prove a full orbit or constrain the intervening path.
  // Require the height and the radius to return too, or the final frame would not match.
  const closes = Boolean(
    allowClosure && referenceImage != null && !task
    && isCloseAbs(Math.abs(net), 360, 1e-6)
    && isCloseAbs(path[0].elevation, path[path.length - 1].elevation, 1e-6)
    && isCloseAbs(path[0].distance, path[path.length - 1].distance, 1e-6),
  )
  let userInstruction = instruction
  if (task) {
    userInstruction = (`Settled tail: complete the whole camera move by ${pyFixed(end, 3)}s and then hold the new framing `
      + `perfectly still, with no drift, through ${pyFixed(frames / FPS, 3)}s. The still tail is what the final `
      + `image is taken from, so the last ${DIRECTED_TAIL_CANDIDATES} frames must be identical and `
      + `sharp. ${userInstruction || ''}`).trim()
  }
  if (closes) {
    userInstruction = (`Reference alignment: <Picture 1> is the frame at 0.000s. <Picture 2> is the same image `
      + `again and is the frame at ${pyFixed(end, 3)}s. The camera travels the whole way round and returns `
      + `precisely to the <Picture 2> viewpoint, so the last frame matches the first exactly. `
      + `Passing through only part of the circle and stopping short leaves the final frame wrong. `
      + `${userInstruction || ''}`).trim()
  }
  const plan = buildPlan(path, end, interpolation, userInstruction, aspect, promptDetail as PromptDetail)
  plan.coordinate_anchor = coordinateAnchor(subjectBox)
  const compiled = planText(plan, true)
  const minimax = minimaxFormat === 'compact JSON' || minimaxFormat === 'compact JSON (no boxes)'
    ? pyJsonStringify(plan)
    : planText(plan, minimaxFormat === 'coordinate + H3 sections')
  const options: H3EditOptions = {
    mode: task ? task.mode : 'scene coverage | canonical camera path',
    show_overrides: true,
    prompt_mode: task ? task.prompt_mode : 'directed | frozen scene coverage',
    quality_profile: task ? task.quality_profile : PROFILES[profile],
    primary_image_role: 'edit | strong scene anchor (FL2VA)',
    reference_mode: 'none (source only)',
    source_fit: 'crop center',
    semantic_resolution: 1024,
    native_reference_size: 'match output area',
    coverage_views: path.length,
    coverage_arc_degrees: arc,
    coverage_direction: net >= 0 ? 'clockwise / camera right' : 'counterclockwise / camera left',
    coverage_hold_frames: 1,
    coverage_loop_closure: closes,
  }
  // Metadata only. Generic H3 Edit coverage windows cannot describe an arbitrary path.
  const storyboard: CameraStoryboard = {
    ...plan,
    interpolation,
    prompt_detail: promptDetail,
    runtime_task: runtimeTask,
    output_duration_s: frames / FPS,
    last_frame_s: (frames - 1) / FPS,
    path: hudPath,
    model_path: path,
    orbit_direction: orbitDirection,
    subject_framing: framing,
    framing_note: 'Legacy preset retained as metadata only; no measured subject box is available.',
    prompt_control: 'semantic instructions, not geometric conditioning',
  }
  const notes: string[] = []
  const tail = (1 - path[path.length - 1].time) * end
  if (1e-9 < tail && tail < 1 / FPS - 1e-9) {
    notes.push('Final hold is shorter than one frame; no separate visible hold is requested. The saved path is unchanged.')
  }
  if (path.some((p) => Math.abs(p.elevation) > ELEVATION_RANGES[elevationRange])) {
    notes.push('Some keyframes exceed the selected editor slider range; their saved values are preserved.')
  }
  const percorrido = path.slice(1).reduce((sum, b, i) => sum + Math.abs(b.azimuth - path[i].azimuth), 0)
  // Sempre visivel: 'o 360 nao esta saindo' costuma ser 'o 360 nao esta entrando',
  // e sem este numero nao da para saber qual dos dois e.
  notes.push(`Giro: ${pyFormatG(percorrido)} graus percorridos, ${pyFormatG(net)} graus liquidos, `
    + `${path.length - 1} trecho${path.length > 2 ? 's' : ''}.`)
  if (!closes && Math.abs(net) > 180) {
    // Quantifica o quanto falta: a closure do upstream exige 360 exatos, e a diferenca
    // costuma ser de poucos graus que ninguem ve so olhando a trajetoria.
    const falta = Math.min(Math.abs(Math.abs(net) % 360), 360 - Math.abs(Math.abs(net) % 360))
    const motivos: string[] = []
    if (!allowClosure) motivos.push('Motion Frame: ação continua / action continues')
    if (referenceImage == null) motivos.push('sem imagem conectada / no connected image')
    if (task) motivos.push('tarefa de imagem / still-image task')
    if (Math.abs(net) > 360 + 1e-6) motivos.push('exige uma volta de 360 / requires one 360-degree turn')
    if (falta > 1e-3) motivos.push(`faltam ${pyFixed(falta, 2)} graus de giro`)
    if (Math.abs(path[0].elevation - path[path.length - 1].elevation) > 1e-6) {
      motivos.push(`a elevacao termina em ${pyFormatG(path[path.length - 1].elevation)} em vez de ${pyFormatG(path[0].elevation)}`)
    }
    if (Math.abs(path[0].distance - path[path.length - 1].distance) > 1e-6) {
      motivos.push(`a distancia termina em ${pyFormatG(path[path.length - 1].distance)} em vez de ${pyFormatG(path[0].distance)}`)
    }
    if (motivos.length > 0) {
      notes.push('Loop closure OFF: ' + motivos.join(', ') + '. Use o botao Fechar volta no painel.')
    }
  }
  if (closes) {
    notes.push('Loop closure ON: PT: solicita ancorar o último frame no H3 Edit com options e imagem conectados. Isso não garante que o percurso foi seguido. EN: requests final-frame anchoring in H3 Edit when options and source image are connected; does not prove the full orbit was followed. Native H3 requires separate end-frame wiring.')
  }
  if (task) {
    notes.push(`Directed task: the profile widget is ignored, the move completes by ${pyFixed(end, 3)}s and the `
      + `decoder picks one image from the last ${DIRECTED_TAIL_CANDIDATES} frames.`)
  }
  const info = `v16 | ${promptDetail} | ${runtimeTask} | ${orbitDirection} | ${frames} frames at ${pyFormatG(FPS)} fps (${pyFixed(frames / FPS, 3)}s). `
    + 'Native H3: connect minimax_prompt, length and fps. H3 Edit: connect compiled_prompt AND options. '
    + 'Decode the full video with the video VAE, not the calibrated scene-coverage decoder. '
    + 'Literal [L,T,W,H] anchors are included. Empty subject_box uses the full image boundary only; enter a measured subject box to identify the orbit target. '
    + 'Legacy compact JSON (no boxes) is retained as a name; all formats now include the coordinate anchor. '
    + 'Prompt guidance only; angular accuracy still depends on the model. ' + notes.join(' ')
  return {
    compiledPrompt: compiled,
    options,
    storyboardJson: pyJsonStringify(storyboard),
    info,
    minimaxPrompt: minimax,
    frames,
    fps: FPS,
  }
}

export { choice }
