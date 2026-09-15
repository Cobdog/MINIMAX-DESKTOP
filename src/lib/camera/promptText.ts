/**
 * Plan → prompt text, ported from plan_text() in camera.py of
 * NyckM/3d-Camera-control-H3-Minimax (v19.1 @ 846880d, Apache-2.0).
 * Byte parity with the Python output is asserted against committed goldens
 * (scripts/test-camera.cjs).
 */
import { FPS } from './constants'
import { pyFixed, pyFormatG } from './parity'
import type { CameraPlan } from './types'

/** Render the plan as prompt text. `sections=true` wraps it in the six-section
 *  H3 format (subject_definitions … non_diegetic_music); plain text otherwise
 *  (with a trailing 'Silence.' line). */
export function planText(plan: CameraPlan, sections = false): string {
  const lines: string[] = [
    plan.camera_choreography,
    plan.reference,
    plan.coordinate_anchor!.instruction,
    plan.coordinate_convention,
  ]
  for (const key of ['axis_separation', 'rotation_direction', 'completion', 'reversals'] as const) {
    if (plan[key]) lines.push(plan[key])
  }
  lines.push(plan.preserve, plan.motion, plan.parallax)
  for (const s of plan.segments) {
    let row = `[${pyFixed(s.start_s, 6)}s-${pyFixed(s.end_s, 6)}s] ${s.camera_mode}`
    if ('rotation_deg_per_s' in s) {
      if (s.rotation_deg_per_s! > 0.5) {
        row += `; average segment rotation rate ${pyFixed(s.rotation_deg_per_s!, 1)} degrees per second`
      }
      if (s.background_travel) {
        row += `; ${s.background_travel}`
      }
      row += `; speed curve ${s.speed_curve}`
    }
    lines.push(row + '.')
  }
  lines.push(plan.final, plan.forbid, 'Additional direction: ' + plan.instruction)
  const text = lines.join('\n')
  if (!sections) return text + '\nSilence.'
  return 'subject_definitions:\n<Picture 1> is the exact reference first frame.\n\n'
    + `summary:\nOne continuous camera move over ${pyFixed(plan.duration_s, 6)}s at ${pyFormatG(FPS)} fps.\n\n`
    + 'retention_analysis:\n<Picture 1>: preserve the subjects and scene in world space.\n\n'
    + 'detailed_description:\n' + text + '\n\n'
    + 'overall_soundscape:\nSilence.\n\n'
    + 'non_diegetic_music:\nN/A'
}
