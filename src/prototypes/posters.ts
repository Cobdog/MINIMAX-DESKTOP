/** Wave 3 — take posters from the one bundled sample clip.
 *
 *  The prototypes run with NO server and no engine, so there are no
 *  ffmpeg filmstrip routes to lean on. Instead: ONE transient off-DOM
 *  <video> element loads the bundled clip once, seeks to a per-take frame,
 *  and paints it through the take's CSS filter onto a small canvas — a
 *  data-URL poster per take (plus the library plate). The element is then
 *  disposed exactly like the pool disposes its leases (src removed + load()
 *  so the connection drops), leaving ZERO live video elements until the
 *  artist actually plays something — the wave-2d discipline, kept.
 */
import { libraryAssets, useProtoStore } from './protoStore'
import sampleClip from './assets/sample-clip.mp4'

const POSTER_WIDTH = 480
const POSTER_HEIGHT = 270

let started = false

const waitOnce = (element: HTMLElement, event: string, timeoutMs = 6_000): Promise<void> =>
  new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      element.removeEventListener(event, done)
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(done, timeoutMs)
    element.addEventListener(event, done)
  })

/** Frame offsets across the clip so each take's poster is a distinct frame. */
const posterTimeFor = (index: number, count: number, duration: number): number => {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const slot = (index + 0.5) / count
  return Math.min(duration - 0.05, Math.max(0.05, slot * duration))
}

/** Runs once per session (guarded — StrictMode double-invocation included). */
export function startPosterGeneration(): void {
  if (started || typeof document === 'undefined') return
  started = true

  const state = useProtoStore.getState()
  const takes = state.takes
  const total = takes.length + libraryAssets.filter((asset) => asset.kind === 'image').length

  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = sampleClip

  const dispose = () => {
    try {
      video.pause()
      video.removeAttribute('src')
      video.load()
    } catch {
      /* A half-disposed element must never wedge poster generation. */
    }
  }

  const run = async () => {
    await waitOnce(video, 'loadeddata')
    const duration = video.duration
    const canvas = document.createElement('canvas')
    canvas.width = POSTER_WIDTH
    canvas.height = POSTER_HEIGHT
    const context = canvas.getContext('2d')
    if (!context) {
      dispose()
      return
    }

    let index = 0
    for (const entry of takes) {
      video.currentTime = posterTimeFor(index, total, duration)
      await waitOnce(video, 'seeked', 2_000)
      try {
        context.filter = entry.filter === 'none' ? 'none' : entry.filter
        context.drawImage(video, 0, 0, POSTER_WIDTH, POSTER_HEIGHT)
        useProtoStore.getState().setPoster(entry.id, canvas.toDataURL('image/jpeg', 0.72))
      } catch {
        /* Posters are cosmetic — a failed grab falls back to the labeled
           placeholder every TakePoster already renders. */
      }
      index += 1
    }

    for (const asset of libraryAssets) {
      if (asset.kind !== 'image') continue
      video.currentTime = posterTimeFor(index, total, duration)
      await waitOnce(video, 'seeked', 2_000)
      try {
        context.filter = 'saturate(.9) brightness(1.05)'
        context.drawImage(video, 0, 0, POSTER_WIDTH, POSTER_HEIGHT)
        useProtoStore.getState().setPoster(asset.id, canvas.toDataURL('image/jpeg', 0.72))
      } catch {
        /* Same honest placeholder fallback. */
      }
      index += 1
    }
    dispose()
  }

  video.addEventListener('error', dispose, { once: true })
  void run()
}

export const clipUrl = sampleClip
