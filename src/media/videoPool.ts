/**
 * The video element pool (wave 2d) — the HTTP/1.1 connection-ceiling fix.
 *
 * The app previously mounted one <video> per Library card / Queue row /
 * ClipEditor item. Against a browser's 6-connections-per-origin limit each
 * element with preload="metadata" opened a Range request it then held, so
 * ~100 cards starved actual playback. The pool keeps at most POOL_SIZE
 * elements alive app-wide; a leased element gets its src only while leased,
 * and release() pauses + clears + load()s it, which drops the connection.
 *
 * Playback is exclusive by design: against the 6-stream ceiling ONE actively
 * playing video is correct and any second one is pure waste, so an exclusive
 * lease (the default) pauses and releases every other lease first. Elements
 * are created detached from the DOM — lessees append them into their own
 * containers and release() removes them again.
 */

import type { VideoLease } from './PreviewSource'

export const VIDEO_POOL_SIZE = 4
/** A lease whose element stays paused this long is auto-released (its
 *  connection is dropped). Playing or seeking again takes a fresh lease,
 *  which the pool serves instantly from the same elements. */
export const VIDEO_LEASE_IDLE_MS = 30_000

export type LeaseOptions = {
  src: string
  controls?: boolean
  muted?: boolean
  loop?: boolean
  autoPlay?: boolean
  /** Exclusive (default): pause + release every other lease before this one
   *  plays. Pass false only for coexisting inspectors that must not evict
   *  the playing lease. */
  exclusive?: boolean
  /** Idle-pause auto-release window (defaults to VIDEO_LEASE_IDLE_MS). */
  idleTimeoutMs?: number
  /** Invoked when THIS lease is released by someone else (preemption, idle
   *  timeout, or pool pressure) — not on a plain release(). The UI uses it
   *  to fall back to its static poster. Errors here are swallowed. */
  onPreempted?(): void
}

type PoolEntry = {
  video: HTMLVideoElement
  lease: VideoLease | null
  /** Monotonic lease counter — pool pressure preempts the OLDEST lease. */
  leaseTakenAt: number
  idleTimer: number
  listeners: Array<[string, () => void]>
  onPreempted?: () => void
}

const entries: PoolEntry[] = []
let leaseCounter = 0

function createEntry(): PoolEntry {
  const video = document.createElement('video')
  video.preload = 'none'
  video.playsInline = true
  return { video, lease: null, leaseTakenAt: 0, idleTimer: 0, listeners: [] }
}

function clearIdleTimer(entry: PoolEntry) {
  if (entry.idleTimer) {
    window.clearTimeout(entry.idleTimer)
    entry.idleTimer = 0
  }
}

function detachListeners(entry: PoolEntry) {
  for (const [type, listener] of entry.listeners.splice(0)) entry.video.removeEventListener(type, listener)
}

function releaseEntry(entry: PoolEntry, preempted: boolean) {
  if (!entry.lease) return
  entry.lease = null
  clearIdleTimer(entry)
  detachListeners(entry)
  const video = entry.video
  try {
    video.pause()
    // The canonical connection drop: no src + load() aborts any in-flight
    // range request the element still holds.
    video.removeAttribute('src')
    video.removeAttribute('controls')
    video.muted = false
    video.loop = false
    video.autoplay = false
    video.preload = 'none'
    video.remove()
    video.load()
  } catch {
    /* A half-disposed element must never wedge the pool. */
  }
  const callback = entry.onPreempted
  entry.onPreempted = undefined
  if (preempted && callback) {
    try {
      callback()
    } catch {
      /* Consumer UI state is not the pool's responsibility to guarantee. */
    }
  }
}

function configureListeners(entry: PoolEntry, options: LeaseOptions) {
  const { video } = entry
  const timeoutMs = options.idleTimeoutMs ?? VIDEO_LEASE_IDLE_MS
  const arm = () => {
    clearIdleTimer(entry)
    entry.idleTimer = window.setTimeout(() => releaseEntry(entry, true), timeoutMs)
  }
  const disarm = () => clearIdleTimer(entry)
  for (const [type, listener] of [
    ['pause', arm],
    ['play', disarm],
    ['seeking', disarm],
    ['ended', arm],
  ] as Array<[string, () => void]>) {
    video.addEventListener(type, listener)
    entry.listeners.push([type, listener])
  }
  // Armed from the start: a lease whose autoplay was rejected never fires
  // 'pause' (it simply never plays), and would otherwise hold its connection
  // forever. A successful 'play' disarms it immediately.
  arm()
}

/** Number of elements the pool currently has leased (diagnostics/tests). */
export function activeVideoLeaseCount(): number {
  return entries.filter((entry) => entry.lease !== null).length
}

/** Leases a pooled <video> for `options.src`. The element is returned
 *  DETACHED — append it into your own container (release() removes it
 *  again). Returns null only when there is no DOM; under pressure the oldest
 *  active lease is preempted rather than the request failing. */
export function leaseVideo(options: LeaseOptions): VideoLease | null {
  if (typeof document === 'undefined') return null
  while (entries.length < VIDEO_POOL_SIZE) entries.push(createEntry())

  let entry: PoolEntry | undefined = entries.find((candidate) => candidate.lease === null)
  if (!entry) {
    let oldest: PoolEntry | null = null
    for (const candidate of entries) {
      if (candidate.lease && (!oldest || candidate.leaseTakenAt < oldest.leaseTakenAt)) oldest = candidate
    }
    if (!oldest) return null
    releaseEntry(oldest, true)
    entry = oldest
  }
  if (options.exclusive !== false) {
    for (const other of entries) {
      if (other !== entry && other.lease) releaseEntry(other, true)
    }
  }

  const video = entry.video
  entry.leaseTakenAt = ++leaseCounter
  entry.onPreempted = options.onPreempted
  video.preload = 'auto'
  video.controls = Boolean(options.controls)
  video.muted = Boolean(options.muted)
  video.loop = Boolean(options.loop)
  video.src = options.src
  configureListeners(entry, options)
  if (options.autoPlay) void video.play().catch(() => undefined)
  // release() checks identity: after a preemption re-leased this entry to
  // someone else, a stale closure must not release the NEW owner's lease.
  const lease: VideoLease = { video, release: () => { if (entry.lease === lease) releaseEntry(entry, false) } }
  entry.lease = lease
  return lease
}
