/**
 * The camera-path editor's pure model (y93rk61) — the FIRST consumer of the
 * camera compiler port (src/lib/camera/, task ving89w). The compiler stays
 * frozen and UI-free; this module owns the authoring document, the
 * profile/duration mapping, the compile invocation, and the Camera-box text
 * contract:
 *
 *  - CameraPathDoc is the authored state (keyframes + the compiler's own
 *    widget options, defaulted from its constants). It persists on the
 *    structured draft (chain settings) — the exact round-trip needs no
 *    prompt pollution.
 *  - cameraBoxText projects the COMPILED plan into the box: the compiler's
 *    own choreography/completion/reversals/final bytes, prefixed by a
 *    parseable header. NOT the full six-section compiledPrompt — its labeled
 *    sections would collide with the outer integrated_multimodal_description
 *    structure composeStructuredPrompt emits (dated decision, task comment
 *    nhxsrxw). Prose direction stays in the OTHER boxes; the camera box
 *    carries only compiled camera language.
 *  - parseCameraBoxText is the best-effort deterministic round-trip over that
 *    grammar (review-gated upstream of any apply); applyCameraBoxText
 *    replaces exactly the recognized compiled block and never drops foreign
 *    text — the structured editor's no-loss precedent at box granularity.
 *
 * PURE module (types-only React-free) so the VM test harness loads it
 * directly, like structuredPrompt.ts and camera/.
 */
import {
  DEFAULT_PATH, ELEVATION_RANGES, FPS, ORBIT_DIRECTIONS, PROFILES,
  compileCamera, reviewPath, validatePath,
  type CameraKeyframe, type CameraStoryboard, type CompileResult, type DiagnosticItem, type ImageShape, type Interpolation,
} from './camera'
import { pyFixed } from './camera/parity'

// ---------------------------------------------------------------------------
// The authoring document
// ---------------------------------------------------------------------------

/** The editor's authored state. Every field maps 1:1 onto a compileCamera
 *  widget; defaults come from the compiler's own constants. */
export type CameraPathDoc = {
  keyframes: CameraKeyframe[]
  /** PROFILES key ('124 frames (~5.17s)' | '243…' | '362…'). */
  profile: string
  interpolation: Interpolation
  /** ELEVATION_RANGES key — the soft slider range ('+/-15' | … | '+/-89'). */
  elevationRange: string
  /** ORBIT_DIRECTIONS value — the H3 direction-mirror calibration. */
  orbitDirection: string
  /** Literal '[L=…, T=…, W=…, H=…]' or '' (the full image boundary). */
  subjectBox: string
}

export function profileFrames(profile: string): number {
  return Number.parseInt(profile.trim().split(/\s+/)[0] ?? '0', 10) || 0
}

/** The compiler's timing convention: the last VISIBLE frame, (frames-1)/24. */
export function planEndOf(profile: string): number {
  return (profileFrames(profile) - 1) / FPS
}

/** The compiler ships three proven profiles (all ≡5 mod 17 — the same grid
 *  workflow.frameCount quantizes to); the editor picks the nearest to the
 *  chain duration and SURFACES the difference instead of hiding it. */
export function nearestProfile(durationSeconds: number): string {
  const target = Math.max(0, durationSeconds) * FPS
  let best: string | null = null
  let bestDiff = Infinity
  for (const key of Object.keys(PROFILES)) {
    const diff = Math.abs(profileFrames(key) - target)
    if (diff < bestDiff) {
      best = key
      bestDiff = diff
    }
  }
  return best ?? Object.keys(PROFILES)[0]
}

/** The default document: the upstream DEFAULT_PATH trajectory + compiler
 *  defaults, profile chosen for the chain duration. */
export function defaultCameraPathDoc(durationSeconds: number): CameraPathDoc {
  return {
    keyframes: validatePath(DEFAULT_PATH),
    profile: nearestProfile(durationSeconds),
    interpolation: 'smooth',
    elevationRange: '+/-30',
    orbitDirection: 'invert H3 orbit',
    subjectBox: '',
  }
}

/** Tolerant read of a persisted doc (chain settings are untrusted JSON).
 *  Malformed anywhere → null (the editor falls back to the box-text parse or
 *  the default; nothing crashes). */
export function readCameraPathDoc(raw: unknown): CameraPathDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.keyframes)) return null
  const num = (entry: unknown) => (typeof entry === 'number' && Number.isFinite(entry) ? entry : null)
  const keyframes: CameraKeyframe[] = []
  for (const item of value.keyframes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    const time = num(record.time)
    const azimuth = num(record.azimuth)
    const elevation = num(record.elevation)
    const distance = num(record.distance)
    if (time === null || azimuth === null || elevation === null || distance === null) return null
    keyframes.push({ time, azimuth, elevation, distance })
  }
  try {
    validatePath(JSON.stringify(keyframes))
  } catch {
    return null
  }
  // Widget strings: absent keys take the compiler defaults; a present-but-
  // unknown string is VERSION SKEW — dropping the whole doc (the editor
  // re-derives from the box text, review-gated) beats silently compiling
  // with different semantics.
  const widget = (entry: unknown, allowed: readonly string[], fallback: string): string | null => {
    if (entry === undefined || entry === null) return fallback
    if (typeof entry !== 'string' || !allowed.includes(entry)) return null
    return entry
  }
  const profile = widget(value.profile, Object.keys(PROFILES), nearestProfile(6))
  const elevationRange = widget(value.elevationRange, Object.keys(ELEVATION_RANGES), '+/-30')
  const orbitDirection = widget(value.orbitDirection, ORBIT_DIRECTIONS, 'invert H3 orbit')
  const interpolation: Interpolation | null = value.interpolation === 'linear'
    ? 'linear'
    : (value.interpolation === undefined || value.interpolation === null || value.interpolation === 'smooth') ? 'smooth' : null
  if (profile === null || elevationRange === null || orbitDirection === null || interpolation === null) return null
  return { keyframes, profile, interpolation, elevationRange, orbitDirection, subjectBox: typeof value.subjectBox === 'string' ? value.subjectBox : '' }
}

// ---------------------------------------------------------------------------
// The compile step (the product)
// ---------------------------------------------------------------------------

export type CameraDocCompile = {
  result: CompileResult
  /** The storyboard document (plan + editor facts) parsed back from the
   *  compiler's serialized output — camera_choreography, completion,
   *  reversals, final and the coordinate anchor live here. */
  plan: CameraStoryboard
  /** Read-only trajectory warnings (upstream diagnostics.review_path, EN). */
  warnings: DiagnosticItem[]
}

/** Compile the doc through the port's public API. Throws the compiler's own
 *  error taxonomy (validatePath / choice / coordinateAnchor) — callers
 *  surface it and gate Apply. */
export function compileCameraDoc(doc: CameraPathDoc, options: { referenceImage?: ImageShape | null } = {}): CameraDocCompile {
  const hudPath = validatePath(JSON.stringify(doc.keyframes))
  const result = compileCamera({
    cameraTrajectory: JSON.stringify(doc.keyframes),
    profile: doc.profile,
    interpolation: doc.interpolation,
    instruction: '',
    elevationRange: doc.elevationRange,
    orbitDirection: doc.orbitDirection,
    subjectBox: doc.subjectBox || null,
    referenceImage: options.referenceImage ?? null,
  })
  const plan = JSON.parse(result.storyboardJson) as CameraStoryboard
  const warnings = reviewPath(hudPath, planEndOf(doc.profile), ELEVATION_RANGES[doc.elevationRange] ?? 30)
  return { result, plan, warnings }
}

// ---------------------------------------------------------------------------
// The Camera-box text contract
// ---------------------------------------------------------------------------

/** The compiled block's header — the parse anchor (frames + plan end). */
export function cameraBoxHeader(doc: CameraPathDoc): string {
  const end = planEndOf(doc.profile)
  return `Compiled camera path — ${profileFrames(doc.profile)} frames at ${pyFixed(FPS, 0)} fps (${pyFixed(end, 3)}s):`
}

/** Project the compiled plan into the Camera-box text. Grammar (closed —
 *  parseCameraBoxText reads exactly this):
 *
 *    Compiled camera path — N frames at 24 fps (E.EEEs):
 *    {camera_choreography}
 *    [{completion}] [{reversals}] [{anchor instruction, subject box only}]
 *    {final}
 *
 *  The final sentence terminates the block: everything a user adds after it
 *  (chips, prose) survives every future apply. */
export function cameraBoxText(doc: CameraPathDoc, options: { referenceImage?: ImageShape | null } = {}): string {
  const { plan } = compileCameraDoc(doc, options)
  const lines = [cameraBoxHeader(doc), plan.camera_choreography]
  if (plan.completion) lines.push(plan.completion)
  if (plan.reversals) lines.push(plan.reversals)
  if (doc.subjectBox.trim() && plan.coordinate_anchor) lines.push(plan.coordinate_anchor.instruction)
  lines.push(plan.final)
  return lines.join('\n')
}

/** The final sentence's closed grammar — the block terminator. */
const FINAL_SENTENCE = /^Reach the final pose(?: on the final visible frame)? at \d+(?:\.\d+)?s(?: and hold it through \d+(?:\.\d+)?s)?; (?:there is no additional hold|there is no separate visible hold)\./m

export type ParsedCameraBox = {
  /** Best-effort reconstruction (approximate unless the exact doc was
   *  persisted — times round-trip at 3 decimals, interpolation/instruction
   *  are unrecoverable). Review-gated upstream of any apply. */
  doc: CameraPathDoc
  approximate: boolean
  /** The recognized compiled block's span in the source text (null when no
   *  header was found — the text is foreign, apply must APPEND). */
  block: { start: number; end: number } | null
}

const HEADER_RE = /^Compiled camera path — (\d+) frames at (?:\d+(?:\.\d+)?) fps \((\d+(?:\.\d+)?)s\):/m
const SEGMENT_TIME_RE = /From (\d+(?:\.\d+)?)s to (\d+(?:\.\d+)?)s:/g
const AZIMUTH_RE = /physically move the CAMERA (\d+(?:\.\d+)?) degrees around the fixed target toward the camera's (RIGHT|LEFT)/
const HOLD_RE = /hold the camera viewpoint, elevation and radius unchanged/
const ELEVATION_TO_RE = /(?:increase|decrease) elevation offset from (-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?) degrees/
const ELEVATION_MAINTAIN_RE = /maintain elevation offset (-?\d+(?:\.\d+)?) degrees/
const ELEVATION_RETURN_RE = /return to the reference elevation offset of 0 degrees/
const DISTANCE_TO_RE = /(?:pull back|move closer) from radius (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?) times the reference radius/
const DISTANCE_MAINTAIN_RE = /maintain radius (\d+(?:\.\d+)?) times the reference radius/

/** Deterministic best-effort parse of cameraBoxText's grammar. When the text
 *  carries no header the doc is the default (the caller decides what to do —
 *  applying APPENDS, never replaces foreign text). */
export function parseCameraBoxText(text: string, durationSeconds = 6): ParsedCameraBox {
  const fallback: ParsedCameraBox = { doc: defaultCameraPathDoc(durationSeconds), approximate: true, block: null }
  const source = text ?? ''
  const header = HEADER_RE.exec(source)
  if (!header) return fallback
  const frames = Number.parseInt(header[1] ?? '0', 10)
  const profile = Object.keys(PROFILES).find((key) => profileFrames(key) === frames)
  if (!profile) return fallback
  const planEnd = Number.parseFloat(header[2] ?? '0') || planEndOf(profile)

  // The block runs from the header line to the final sentence's period;
  // when hand edits destroyed the terminator, fall back to the header's
  // contiguous non-empty line run (still never past an empty line).
  const headerStart = source.lastIndexOf('\n', header.index) + 1
  const afterHeader = source.slice(header.index + header[0].length)
  const finalMatch = FINAL_SENTENCE.exec(afterHeader)
  let blockEnd: number
  if (finalMatch) {
    blockEnd = header.index + header[0].length + finalMatch.index + finalMatch[0].length
  } else {
    // Walk the header's contiguous non-empty line run (hand-destroyed
    // terminator: still never past the blank line that ends our block).
    // afterHeader opens with the newline that ended the header line.
    let runLen = 0
    for (const line of afterHeader.replace(/^\n/, '').split('\n')) {
      if (!line.trim()) break
      runLen += line.length + 1
    }
    blockEnd = header.index + header[0].length + Math.min(runLen, afterHeader.length)
  }
  const blockText = source.slice(headerStart, blockEnd)

  // Reconstruct keyframes: the anchor plus each segment's END pose, times
  // normalized against the plan end (the last lands exactly on 1).
  const keyframes: CameraKeyframe[] = [{ time: 0, azimuth: 0, elevation: 0, distance: 1 }]
  const timeMatches: Array<{ start: number; end: number; start_s: number; end_s: number }> = []
  SEGMENT_TIME_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SEGMENT_TIME_RE.exec(blockText)) !== null) {
    timeMatches.push({ start: match.index, end: match.index + match[0].length, start_s: Number.parseFloat(match[1] ?? '0'), end_s: Number.parseFloat(match[2] ?? '0') })
  }
  const segments: Array<{ start_s: number; end_s: number; body: string }> = timeMatches.map((entry, index) => ({
    start_s: entry.start_s,
    end_s: entry.end_s,
    body: blockText.slice(entry.end, index + 1 < timeMatches.length ? timeMatches[index + 1].start : blockText.length),
  }))
  let azimuth = 0
  let elevation = 0
  let distance = 1
  segments.forEach((segment, index) => {
    const azimuthMatch = AZIMUTH_RE.exec(segment.body)
    if (azimuthMatch) {
      const degrees = Number.parseFloat(azimuthMatch[1] ?? '0')
      azimuth += (azimuthMatch[2] === 'RIGHT' ? 1 : -1) * degrees
    } else if (!HOLD_RE.test(segment.body)) {
      // Hand-edited beyond recognition: carry the previous pose (approximate).
    }
    const elevationTo = ELEVATION_TO_RE.exec(segment.body)
    const elevationMaintain = ELEVATION_MAINTAIN_RE.exec(segment.body)
    if (elevationTo) elevation = Number.parseFloat(elevationTo[2] ?? '0')
    else if (ELEVATION_RETURN_RE.test(segment.body)) elevation = 0
    else if (elevationMaintain) elevation = Number.parseFloat(elevationMaintain[1] ?? '0')
    const distanceTo = DISTANCE_TO_RE.exec(segment.body)
    const distanceMaintain = DISTANCE_MAINTAIN_RE.exec(segment.body)
    if (distanceTo) distance = Number.parseFloat(distanceTo[2] ?? '1')
    else if (distanceMaintain) distance = Number.parseFloat(distanceMaintain[1] ?? '1')
    const isLast = index === segments.length - 1
    const time = isLast || segment.end_s >= planEnd - 1e-9 ? 1 : Math.min(0.999, Math.max(0.001, segment.end_s / planEnd))
    keyframes.push({ time, azimuth, elevation, distance })
  })

  if (keyframes.length < 2) return { doc: defaultCameraPathDoc(durationSeconds), approximate: true, block: { start: headerStart, end: blockEnd } }

  // Reconstruct in the SIGNED frame the text speaks ('same as HUD') so a
  // re-compile reproduces the same text — no direction drift on round-trip.
  // The user re-picks 'invert H3 orbit' as a deliberate calibration choice.
  const doc: CameraPathDoc = {
    keyframes,
    profile,
    interpolation: 'smooth',
    elevationRange: (() => {
      const peak = keyframes.reduce((max, point) => Math.max(max, Math.abs(point.elevation)), 0)
      const ordered = ['+/-15', '+/-30', '+/-60', '+/-89']
      return ordered.find((key) => peak <= ELEVATION_RANGES[key]) ?? '+/-89'
    })(),
    orbitDirection: 'same as HUD',
    subjectBox: '',
  }
  return { doc, approximate: true, block: { start: headerStart, end: blockEnd } }
}

/** The never-lossy splice: replace exactly the recognized compiled block,
 *  preserve all foreign text around it; APPEND when no block is recognized.
 *  Chip text glued after the final sentence (appendChipText joins ', ')
 *  survives because the block ends at the sentence's period. */
export function applyCameraBoxText(current: string, nextBlock: string): string {
  const parsed = parseCameraBoxText(current)
  if (!parsed.block) {
    const base = (current ?? '').trim()
    return base ? `${base}\n${nextBlock}` : nextBlock
  }
  const head = (current ?? '').slice(0, parsed.block.start).replace(/[ \t]+$/, '')
  const tail = (current ?? '').slice(parsed.block.end)
  return `${head}${nextBlock}${tail}`.replace(/^\n+/, '').replace(/\s+$/, '')
}

// ---------------------------------------------------------------------------
// One-click move presets (AC gxldt9z: orbit / rise / fall / closer / away /
// static) — the COMPILER's vocabulary (azimuth/elevation/radius semantics),
// not pan/tilt/zoom names that would fight the compiled language.
// ---------------------------------------------------------------------------

export type CameraMovePreset = {
  id: 'orbit' | 'rise' | 'fall' | 'closer' | 'away' | 'static'
  label: string
  hint: string
  /** The end pose for the move, from the pose the path currently ends on. */
  apply(end: CameraKeyframe, doc: CameraPathDoc): { azimuth: number; elevation: number; distance: number }
}

export const CAMERA_MOVE_PRESETS: readonly CameraMovePreset[] = [
  {
    id: 'orbit', label: 'orbit +90°', hint: 'a quarter orbit toward the camera\'s right',
    apply: (end) => ({ azimuth: end.azimuth + 90, elevation: end.elevation, distance: end.distance }),
  },
  {
    id: 'rise', label: 'rise +15°', hint: 'raise the viewpoint along the vertical arc',
    apply: (end, doc) => ({ azimuth: end.azimuth, elevation: Math.min(end.elevation + 15, Math.min(89, ELEVATION_RANGES[doc.elevationRange] ?? 30)), distance: end.distance }),
  },
  {
    id: 'fall', label: 'fall −15°', hint: 'lower the viewpoint along the vertical arc',
    apply: (end, doc) => ({ azimuth: end.azimuth, elevation: Math.max(end.elevation - 15, Math.max(-89, -(ELEVATION_RANGES[doc.elevationRange] ?? 30))), distance: end.distance }),
  },
  {
    id: 'closer', label: 'closer ×0.7', hint: 'move in to 70% of the current radius',
    apply: (end) => ({ azimuth: end.azimuth, elevation: end.elevation, distance: Math.max(0.1, end.distance * 0.7) }),
  },
  {
    id: 'away', label: 'away ×1.4', hint: 'pull back to 140% of the current radius',
    apply: (end) => ({ azimuth: end.azimuth, elevation: end.elevation, distance: Math.min(4, end.distance * 1.4) }),
  },
  {
    id: 'static', label: 'static hold', hint: 'hold the viewpoint unchanged to the end',
    apply: (end) => ({ azimuth: end.azimuth, elevation: end.elevation, distance: end.distance }),
  },
]

/** Append a preset move as a new keyframe (at the clip's end, or halfway
 * through the remaining tail); when the path already ends at time 1 the last
 * keyframe's pose becomes the move. Returns null when the result would be
 * invalid (2..24 keyframes, anchor untouched). */
export function applyCameraMovePreset(doc: CameraPathDoc, presetId: string): CameraPathDoc | null {
  const preset = CAMERA_MOVE_PRESETS.find((entry) => entry.id === presetId)
  if (!preset) return null
  const keyframes = doc.keyframes.map((point) => ({ ...point }))
  const last = keyframes[keyframes.length - 1]
  const pose = preset.apply(last, doc)
  if (last.time >= 1) {
    if (keyframes.length === 1) return null
    keyframes[keyframes.length - 1] = { ...last, ...pose }
  } else if (keyframes.length >= 24) {
    if (keyframes.length === 1) return null
    keyframes[keyframes.length - 1] = { ...last, ...pose }
  } else {
    const time = Math.min(1, last.time + Math.max(0.1, (1 - last.time) / 2))
    keyframes.push({ time, ...pose })
  }
  try {
    validatePath(JSON.stringify(keyframes))
  } catch {
    return null
  }
  return { ...doc, keyframes }
}
