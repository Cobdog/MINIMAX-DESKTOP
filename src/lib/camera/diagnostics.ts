/**
 * Read-only trajectory diagnostics, ported from diagnostics.py of
 * NyckM/3d-Camera-control-H3-Minimax (v19.1 @ 846880d, Apache-2.0).
 * Warnings never modify the trajectory; both language strings ship verbatim
 * (the prompts stay English in every locale — that is upstream policy).
 */
import { pyFixed, pyFormatG } from './parity'
import type { CameraKeyframe, DiagnosticItem } from './types'

const AXES = ['azimuth', 'elevation', 'distance'] as const

/** Warn about static paths, zero-crossing arcs that may be meant as short
 *  arcs, holds, short final tails, and elevations beyond the editor slider. */
export function reviewPath(path: readonly CameraKeyframe[], duration: number, elevationLimit = 30): DiagnosticItem[] {
  const result: DiagnosticItem[] = []
  const moving = path.slice(1).map((b, i) =>
    AXES.some((k) => Math.abs(b[k] - path[i][k]) > 1e-8))
  if (!moving.some(Boolean)) {
    result.push({
      code: 'static',
      pt: 'Trajetória estática: todos os keyframes têm a mesma pose.',
      en: 'Static path: all keyframes have the same pose.',
    })
  }
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]
    const b = path[i]
    const delta = b.azimuth - a.azimuth
    if (a.azimuth >= 0 && a.azimuth < 360 && b.azimuth >= 0 && b.azimuth < 360
      && Math.abs(delta) > 180 && Math.abs(delta) < 360) {
      result.push({
        code: 'crossing',
        pt: `Trecho ${i}: ${pyFormatG(a.azimuth)} → ${pyFormatG(b.azimuth)} pede ${pyFormatG(delta)}°. Se pretendia atravessar zero pelo arco curto, use Desenrolar; não corrigimos automaticamente.`,
        en: `Segment ${i}: ${pyFormatG(a.azimuth)} → ${pyFormatG(b.azimuth)} requests ${pyFormatG(delta)}°. If you intended the short arc across zero, use Unwrap; no automatic correction.`,
        segment: i,
      })
    }
    if (!moving[i - 1]) {
      result.push({
        code: 'hold',
        pt: `Pausa de câmera: ${pyFixed(a.time * duration, 2)}–${pyFixed(b.time * duration, 2)}s. Em Motion, a ação continua.`,
        en: `Camera hold: ${pyFixed(a.time * duration, 2)}–${pyFixed(b.time * duration, 2)}s. In Motion, the action continues.`,
        segment: i,
      })
    }
  }
  if (path[path.length - 1].time < 1) {
    const tail = (1 - path[path.length - 1].time) * duration
    result.push({
      code: 'tail',
      pt: `Pausa final: ${pyFixed(tail, 3)}s${tail < 1 / 24 ? ' (menos de um frame).' : '.'}`,
      en: `Final hold: ${pyFixed(tail, 3)}s${tail < 1 / 24 ? ' (less than one frame).' : '.'}`,
    })
  }
  if (path.some((p) => Math.abs(p.elevation) > elevationLimit)) {
    result.push({
      code: 'slider',
      pt: 'Há elevações além do alcance do slider; os valores salvos foram preservados.',
      en: 'Some elevations exceed the slider range; saved values were preserved.',
    })
  }
  return result
}

/** Flatten diagnostics to text in the requested language. */
export function diagnosticText(items: readonly DiagnosticItem[], english = false): string {
  return items.map((item) => (english ? item.en : item.pt)).join('\n')
}
