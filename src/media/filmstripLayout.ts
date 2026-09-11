/**
 * Filmstrip sprite-sheet layout math (wave 2d) — PURE, no DOM or node APIs.
 * The server (sheet generation) and the client (poster rendering) both call
 * filmstripLayout(), so cols/rows/frameCount for a given duration always
 * agree between the two without extra headers or second-guessing.
 */
export const FILMSTRIP_CELL_WIDTH = 160
export const FILMSTRIP_FPS = 24
const MIN_CELLS = 12
const MAX_CELLS = 30
const MIN_DURATION_SECONDS = 0.5

export type FilmstripLayout = { cols: number; rows: number; frameCount: number; fps: string }

/** Samples ≈ clamp(12, duration×2, 30) frames laid out on the nearest-square
 *  grid that fits them with NO blank cells (grid size wins over the sampled
 *  count when the count is not factorizable — e.g. 13 samples tile 4×4).
 *  `fps` is the sampler rate for ffmpeg's fps filter expression. */
export function filmstripLayout(durationSeconds: number): FilmstripLayout {
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.max(MIN_DURATION_SECONDS, durationSeconds) : MIN_DURATION_SECONDS
  const target = Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.round(duration * 2)))
  const cols = Math.ceil(Math.sqrt(target))
  const rows = Math.ceil(target / cols)
  const frameCount = cols * rows
  return { cols, rows, frameCount, fps: (frameCount / duration).toFixed(4) }
}
