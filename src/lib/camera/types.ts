/**
 * Public types for the camera compiler port (task ving89w) — a pure,
 * UI-free TypeScript port of the bruxosdovfx "Camera H3" compiler
 * (NyckM/3d-Camera-control-H3-Minimax, v19.1 @ 846880d, Apache-2.0).
 *
 * The widget-string unions stay STRINGS at the compile boundary on purpose:
 * the upstream `_choice` fallback machinery (old saved workflows deserialize
 * new widgets as '' or None) is part of the ported behavior and its error
 * taxonomy is only reachable when arbitrary strings can flow in. Consumers
 * get the union types for construction and the compiler validates at runtime.
 */

/** One camera pose keyframe. `time` is normalized 0..1, azimuth/elevation are
 *  degrees (unwrapped — 0 -> 360 is a full turn), `distance` is a multiple of
 *  the starting radius. The first keyframe is the source image itself
 *  (time=0, azimuth=0, elevation=0, distance=1), enforced by validatePath. */
export interface CameraKeyframe {
  time: number
  azimuth: number
  elevation: number
  distance: number
}

/** The three axes that move — everything a sampled pose carries. */
export interface Pose {
  azimuth: number
  elevation: number
  distance: number
}

export type Interpolation = 'smooth' | 'linear'
export type PromptDetail = 'v15 baseline' | 'extended contracts'
export type MinimaxFormat =
  | 'coordinate only'
  | 'coordinate + H3 sections'
  | 'compact JSON'
  | 'compact JSON (no boxes)'
export type OrbitDirection = 'invert H3 orbit' | 'same as HUD'
export type DurationProfile = '124 frames (~5.17s)' | '243 frames (~10.13s)' | '362 frames (~15.08s)'
export type SubjectFraming = 'medium shot' | 'close-up' | 'wide shot'
export type ElevationRangeKey = '+/-15' | '+/-30' | '+/-60' | '+/-89'
export type RuntimeTask = 'scene coverage | camera path' | 'directed | new camera angle'
export type FrameMode = 'Freeze Frame' | 'Motion Frame'
export type UiLanguage = 'Português' | 'English'
export type LoopClosureChoice = 'auto' | 'off'

/** ComfyUI IMAGE-batch shape carrier: [B, H, W, C]. The pure port cannot
 *  take tensors, so callers hand over just the shape — the only thing the
 *  upstream compiler reads (image_aspect + batch bounds). */
export interface ImageShape {
  shape: number[]
}

/** The subject_box anchor block (upstream coordinate_anchor). */
export interface CoordinateAnchor {
  kind: 'reference_image' | 'user_subject'
  box: string
  instruction: string
}

/** One plan segment (upstream build_plan segments entry). Extended-contract
 *  fields are present only when promptDetail is 'extended contracts'. */
export interface CameraSegment {
  id: string
  start_s: number
  end_s: number
  camera_mode: string
  camera_travel: 'right' | 'left' | 'none'
  signed_orbit_degrees: number
  speed_curve: string
  rotation_deg_per_s?: number
  background_travel?: string
  start: Pose
  end: Pose
}

/** The compiled plan (upstream build_plan dict; key order is load-bearing —
 *  it is the serialization order of the compact-JSON prompt and storyboard). */
export interface CameraPlan {
  schema: string
  camera_choreography: string
  total_orbit_travel_degrees: number
  net_orbit_degrees: number
  frame: string
  duration_s: number
  fps: number
  reference: string
  coordinate_convention: string
  preserve: string
  motion: string
  parallax: string
  axis_separation?: string
  rotation_direction?: string
  completion?: string
  reversals?: string
  segments: CameraSegment[]
  final: string
  forbid: string
  instruction: string
  sound: string
  coordinate_anchor?: CoordinateAnchor
}

/** The 13-key H3 Edit options dictionary (compiled output #2). */
export interface H3EditOptions {
  mode: string
  show_overrides: boolean
  prompt_mode: string
  quality_profile: string
  primary_image_role: string
  reference_mode: string
  source_fit: string
  semantic_resolution: number
  native_reference_size: string
  coverage_views: number
  coverage_arc_degrees: number
  coverage_direction: string
  coverage_hold_frames: number
  coverage_loop_closure: boolean
  [key: string]: unknown
}

/** Motion-Frame override emitted instead of H3 Edit options (the upstream
 *  marker that a frozen scene-coverage encoder must not take over). */
export interface MotionOptionsOverride {
  coverage_loop_closure: boolean
  bruxosdovfx_requires_ref2va: boolean
}

/** The seven outputs of the upstream node, as a named record. */
export interface CompileResult {
  /** Full prompt in the six-section H3 format. */
  compiledPrompt: string
  /** H3 Edit options (or the Motion Frame override object). */
  options: H3EditOptions | MotionOptionsOverride
  /** Storyboard JSON — json.dumps(plan, indent=2) equivalent. */
  storyboardJson: string
  /** Human-readable diagnostics banner. */
  info: string
  /** Same trajectory in the requested minimax_format. */
  minimaxPrompt: string
  /** Frame count the plan was timed against (wire into generation length). */
  frames: number
  /** 24 — wire into the video node's fps. */
  fps: number
}

/** compileCamera input — mirrors the upstream compile_camera() signature. */
export interface CompileCameraParams {
  /** Camera trajectory as a JSON string (as saved by the upstream HUD panel). */
  cameraTrajectory: string
  profile: string
  interpolation: string
  instruction: string
  subjectFraming?: string | null
  minimaxFormat?: string | null
  referenceImage?: ImageShape | null
  elevationRange?: string | null
  orbitDirection?: string | null
  subjectBox?: string | null
  runtimeTask?: string | null
  promptDetail?: string | null
  allowClosure?: boolean
}

/** compileMotion input — mirrors the upstream motion.H3CameraEditor.run()
 * widget set (frame_mode / source_fps / freeze_index / ui_language /
 * loop_closure) on top of the compile_camera parameters. */
export interface CompileMotionParams extends CompileCameraParams {
  frameMode?: string | null
  sourceFps?: number
  freezeIndex?: number
  uiLanguage?: string | null
  loopClosure?: string | null
}

/** The `source` block compileMotion appends to the storyboard. */
export interface StoryboardSource {
  input_frames: number
  source_fps: number
  reference_frames: number
  freeze_index: number | null
}

/** The storyboard document (upstream `dict(plan, …)`, plus the frame-mode
 *  keys the motion pipeline appends). Key order is serialization order. */
export interface CameraStoryboard extends CameraPlan {
  interpolation: string
  prompt_detail: string
  runtime_task: string
  output_duration_s: number
  last_frame_s: number
  path: CameraKeyframe[]
  model_path: CameraKeyframe[]
  orbit_direction: string
  subject_framing: string
  framing_note: string
  prompt_control: string
  frame_mode?: string
  loop_closure_request?: string
  loop_closure_enabled?: boolean
  user_instruction?: string
  source?: StoryboardSource
  diagnostics?: DiagnosticItem[]
}

/** Read-only trajectory warnings (upstream diagnostics.review_path items). */
export interface DiagnosticItem {
  code: 'static' | 'crossing' | 'hold' | 'tail' | 'slider'
  pt: string
  en: string
  segment?: number
}

/** The Motion Frame reference-resampling decision (upstream prepare_frames):
 *  pick `indices` frames at the source rate, then truncate to the 17k+5 grid. */
export interface MotionResample {
  /** Resampled length before grid truncation (round(count·24/sourceFps)). */
  target: number
  /** Length after the native-H3 17k+5 truncation. */
  aligned: number
  /** Source frame index for each of the `aligned` output frames. */
  indices: number[]
}

/** compileMotion return: the seven node outputs plus the pure-port extras
 *  (diagnostics list and the resampling plan the caller applies to real
 *  frames — tensors never cross this library's boundary). */
export interface CompileMotionResult extends CompileResult {
  diagnostics: DiagnosticItem[]
  resample: MotionResample | null
}
