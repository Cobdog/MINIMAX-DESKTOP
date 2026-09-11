/**
 * PreviewSource — the media-preview seam (wave 2d).
 *
 * Every view that shows "what did we render" goes through this interface.
 * The seam exists so frame-accurate editing can arrive later WITHOUT
 * touching view code again:
 *
 *   v1 (built now)  — createHttpPreviewSource() in ./httpPreview.ts:
 *                     server-generated filmstrip sprite sheets for static
 *                     thumbnails (one small PNG per clip, content-derived
 *                     ETag, OPFS blob cache) + pooled <video> elements for
 *                     interactive playback (see ./videoPool.ts — playback is
 *                     EXCLUSIVE, which is exactly what the HTTP/1.1
 *                     6-connections-per-origin ceiling wants).
 *
 *   v2 (NOT built)  — mediabunny + WebCodecs decode-to-canvas in a worker:
 *                     frame-accurate getFrame(index) backed by real demuxed
 *                     frame indexes (no <video> element at all for
 *                     scrubbing; the pool then only serves audible
 *                     playback). Filmstrip's frame↔time mapping already
 *                     follows the frame-indexed discipline (fps/frame_count
 *                     columns landed in the wave-1 assets schema), so v2
 *                     swaps in underneath the same interface.
 *
 * The layout math Filmstrip is built on lives in ./filmstripLayout.ts — the
 * ONE file the server also imports (kept free of DOM types on purpose).
 */
import { FILMSTRIP_FPS, type FilmstripLayout } from './filmstripLayout'

export { FILMSTRIP_CELL_WIDTH, FILMSTRIP_FPS, filmstripLayout, type FilmstripLayout } from './filmstripLayout'

/** A filmstrip sprite sheet: `cols × rows` frames of one clip in one PNG,
 *  scaled so each cell is FILMSTRIP_CELL_WIDTH px wide (height keeps the
 *  source aspect ratio, rounded to even pixels). `frameIndexAtTime` is the
 *  frame↔time mapping — THE frame-indexed discipline lives here, not in the
 *  views. v1 maps time to a sheet cell (sampled, approximate); v2 will map
 *  time to an exact demuxed frame index with the same signature. */
export type Filmstrip = {
  url: string
  cols: number
  rows: number
  frameCount: number
  /** Source-clip metadata the mapping closes over (informational for views). */
  duration: number
  fps: number
  frameIndexAtTime(seconds: number): number
}

export type VideoLease = {
  video: HTMLVideoElement
  /** Pause + drop the element's src (releases its HTTP connection) and
   *  return it to the pool. Idempotent. */
  release(): void
}

/** The seam. A preview source can answer thumbnails (filmstrip), interactive
 *  playback (a pooled element), and — from v2 on — exact frame bitmaps. */
export type PreviewSource = {
  kind: 'filmstrip' | 'video' | 'webcodecs'
  /** The sprite sheet for this source, or null when none can be produced
   *  (non-video media, missing ffmpeg, generation failure). Never throws. */
  getFilmstrip(): Promise<Filmstrip | null>
  /** Interactive playback. At most a handful of leases exist app-wide; a
   *  play lease is exclusive (leasing pauses + releases other play leases).
   *  Returns null when no element can be leased. */
  requestPlayback(): Promise<VideoLease | null>
  /** Exact frame bitmap by source-frame index. v1 filmstrip sheets cannot
   *  answer this precisely — returns null. v2 (WebCodecs) fulfills it. */
  getFrame(_index: number): Promise<ImageBitmap | null>
}

/** Builds a Filmstrip whose frame↔time mapping matches `layout`. */
export function createFilmstrip(layout: FilmstripLayout, url: string, duration: number, fps = FILMSTRIP_FPS): Filmstrip {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  return {
    url,
    cols: layout.cols,
    rows: layout.rows,
    frameCount: layout.frameCount,
    duration: safeDuration,
    fps,
    frameIndexAtTime(seconds: number) {
      if (!(seconds > 0) || safeDuration <= 0) return 0
      const clamped = Math.min(Math.max(seconds, 0), safeDuration)
      return Math.min(layout.frameCount - 1, Math.floor((clamped / safeDuration) * layout.frameCount))
    },
  }
}
