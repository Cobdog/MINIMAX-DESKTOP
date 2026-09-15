/**
 * Widget tables and tuning constants, ported verbatim from camera.py /
 * motion.py of NyckM/3d-Camera-control-H3-Minimax (v19.1 @ 846880d,
 * Apache-2.0). Keys are stable public strings — they appear in saved
 * workflows and in compiled output.
 */

/** Every timing in the compiler derives from this rate; the video node must
 *  use the same one. */
export const FPS = 24.0

export const PROFILES: Record<string, string> = {
  '124 frames (~5.17s)': 'scene coverage | 124-frame camera path',
  '243 frames (~10.13s)': 'scene coverage | 243-frame camera path',
  '362 frames (~15.08s)': 'scene coverage | 362-frame camera path',
}

/** Legacy framing choices, retained only as metadata for saved workflows. */
export const FRAMINGS: Record<string, [number, number]> = {
  'medium shot': [0.28, 0.56],
  'close-up': [0.53, 0.72],
  'wide shot': [0.097, 0.34],
}

export const MINIMAX_FORMATS = ['coordinate only', 'coordinate + H3 sections', 'compact JSON', 'compact JSON (no boxes)']

/** Editor limits for the elevation slider. Past about 20 degrees the horizon
 *  has already left the frame, so the wide range mostly made the control
 *  twitchy without adding shots. Values are degrees. */
export const ELEVATION_RANGES: Record<string, number> = { '+/-15': 15, '+/-30': 30, '+/-60': 60, '+/-89': 89 }

/** The discovered H3 direction-mirroring quirk: H3 tends to mirror the
 *  requested orbit direction, so the DEFAULT flips the sign of the azimuth
 *  sent to the model while the saved HUD trajectory stays untouched. */
export const ORBIT_DIRECTIONS = ['invert H3 orbit', 'same as HUD']

/** The v15 prompt text is known to work, so the added contract blocks are
 *  opt-in: 'v15 baseline' reproduces v15 word for word; 'extended contracts'
 *  adds the blocks written after it. */
export const PROMPT_DETAIL = ['v15 baseline', 'extended contracts']

export const MOTION_MODES = ['Freeze Frame', 'Motion Frame']

/** Vertical field of view assumed when translating orbit degrees into
 *  frame-width crossing counts (the parallax vocabulary). */
export const VERTICAL_FOV = 40.0
export const REFERENCE_ASPECT_FOV = 16 / 9

/** Directed still-image task: upstream times it as frames/fps and settles at
 *  65% of that clip; the decoder picks from the last 5 frames. */
export const DIRECTED_FRAMES = 39
export const DIRECTED_SETTLE = 0.65
export const DIRECTED_TAIL_CANDIDATES = 5

export interface RuntimeTaskSpec {
  mode: string
  prompt_mode: string
  quality_profile: string
  frames: number
}

export const RUNTIME_TASKS: Record<string, RuntimeTaskSpec | null> = {
  'scene coverage | camera path': null,
  'directed | new camera angle': {
    mode: 'directed | new camera angle',
    prompt_mode: 'directed | new camera angle',
    quality_profile: 'directed change | 39-frame settle -> 1 image',
    frames: DIRECTED_FRAMES,
  },
}

/** Baseline framing shares are written for a 16:9 frame. */
export const REFERENCE_ASPECT = 16 / 9
export const COMMON_ASPECTS: ReadonlyArray<readonly [number, string]> = [
  [16 / 9, '16:9'], [9 / 16, '9:16'], [1.0, '1:1'], [4 / 3, '4:3'],
  [3 / 4, '3:4'], [21 / 9, '21:9'], [3 / 2, '3:2'], [2 / 3, '2:3'],
]

/** The default trajectory widget string (upstream DEFAULT_PATH). */
export const DEFAULT_PATH = JSON.stringify([
  { time: 0, azimuth: 0, elevation: 0, distance: 1 },
  { time: 0.5, azimuth: 45, elevation: 10, distance: 1 },
  { time: 1, azimuth: 90, elevation: 0, distance: 0.8 },
])
