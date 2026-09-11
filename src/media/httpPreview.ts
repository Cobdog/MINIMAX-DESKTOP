/**
 * The v1 PreviewSource implementation (wave 2d): filmstrip sprite sheets
 * fetched from the app's own server (cache-first through the OPFS blob
 * cache) + pooled <video> elements for playback. See PreviewSource.ts for
 * the seam and the v2 (mediabunny + WebCodecs) plan.
 */
import { authToken } from '../lib/apiClient'
import { getCachedBlob, putBlob } from './blobCache'
import { createFilmstrip, filmstripLayout, type Filmstrip, type PreviewSource } from './PreviewSource'
import { leaseVideo } from './videoPool'

/** Extracts the server-side output path from a /api/lan/media URL (the form
 *  every output-contained media reference takes). Non-output sources
 *  (ComfyUI proxy references, uploads) have no local path — null. */
export function outputPathFromMediaUrl(value?: string): string | null {
  if (!value || !value.includes('/api/lan/media')) return null
  try {
    const url = new URL(value, 'http://minimax.local')
    if (url.pathname !== '/api/lan/media' || url.searchParams.get('source') !== 'output') return null
    const path = url.searchParams.get('path') ?? ''
    return path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

/** The filmstrip route URL for an output-contained path. Token rides the
 *  query (img/fetch parity with the media route). */
export function filmstripUrl(path: string, duration?: number): string {
  const query = new URLSearchParams({ path })
  if (Number.isFinite(duration) && (duration ?? 0) > 0) query.set('duration', String(duration))
  const token = authToken()
  if (token) query.set('token', token)
  return `/api/lan/assets/filmstrip?${query}`
}

const filmstripCacheKey = (path: string, duration: number) => `filmstrip:${duration.toFixed(3)}:${path}`

/**
 * Fetches (or restores from OPFS) the sprite sheet for an output-contained
 * video path and returns it as a Filmstrip. Layout math runs client-side on
 * the SAME shared function the server used, so cols/rows/frameCount agree
 * without extra headers. The URL is an object URL over the blob — callers
 * own revoking it when the Filmstrip is discarded.
 *
 * Resolves null on any failure (missing sheet, non-video, network) — a
 * thumbnail is never worth an error path.
 */
export async function fetchFilmstrip(path: string, duration: number): Promise<Filmstrip | null> {
  if (!path || !(duration > 0)) return null
  const key = filmstripCacheKey(path, duration)
  const layout = filmstripLayout(duration)
  const fromCache = await getCachedBlob(key)
  if (fromCache) return createFilmstrip(layout, URL.createObjectURL(fromCache), duration)
  try {
    const response = await fetch(filmstripUrl(path, duration))
    if (!response.ok) return null
    const blob = await response.blob()
    if (!blob.size) return null
    void putBlob(key, blob)
    return createFilmstrip(layout, URL.createObjectURL(blob), duration)
  } catch {
    return null
  }
}

/** Output-attribution hook (wave 2d): registers a finished video in the
 *  server's assets table (fps 24 / frame_count = duration × 24 — an
 *  approximation until real probing lands) and warm-starts its filmstrip.
 *  Fire-and-forget by design: attribution must never block or fail a
 *  completed render's UI path. */
export function registerOutputAsset(spec: { path: string; width?: number; height?: number; duration?: number }): void {
  if (!spec.path) return
  const headers = new Headers({ 'content-type': 'application/json' })
  const token = authToken()
  if (token) headers.set('x-minimax-token', token)
  void fetch('/api/lan/assets/filmstrip', {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: spec.path, width: spec.width, height: spec.height, duration: spec.duration }),
  }).catch(() => undefined)
}

/** v1 PreviewSource over the app's own HTTP routes. */
export function createHttpPreviewSource(spec: { path: string; duration: number; src: string }): PreviewSource {
  return {
    kind: 'filmstrip',
    async getFilmstrip() {
      return fetchFilmstrip(spec.path, spec.duration)
    },
    async requestPlayback() {
      return leaseVideo({ src: spec.src, controls: true, autoPlay: true })
    },
    async getFrame() {
      // Filmstrip sheets are sampled, not frame-indexed — exact frames are
      // the v2 WebCodecs implementation.
      return null
    },
  }
}
