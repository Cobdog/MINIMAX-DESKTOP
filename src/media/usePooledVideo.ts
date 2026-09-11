/**
 * React glue for leasing a pooled <video> imperatively (program monitors,
 * dialogs, cards): the element is appended into `containerRef`'s div while
 * the lease lives and removed on release. `active: false` releases the lease
 * (the caller renders its own placeholder then). Callbacks are stored in
 * refs — identity changes never re-lease. (Outside the component file for
 * React fast refresh, same as useFilmstrip.)
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { leaseVideo } from './videoPool'

export type PooledVideoCallbacks = {
  onLoadedMetadata?(video: HTMLVideoElement): void
  onTimeUpdate?(video: HTMLVideoElement): void
  onPlay?(video: HTMLVideoElement): void
  onError?(video: HTMLVideoElement): void
  onPreempted?(): void
}

export function usePooledVideo(options: {
  src: string
  active?: boolean
  controls?: boolean
  muted?: boolean
  loop?: boolean
  autoPlay?: boolean
  idleTimeoutMs?: number
} & PooledVideoCallbacks): { containerRef: RefObject<HTMLDivElement | null>; live: boolean; resume(): void } {
  const { src, active = true } = options
  const [live, setLive] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!active) return undefined
    const container = containerRef.current
    if (!container) return undefined
    const callbacks = optionsRef.current
    const lease = leaseVideo({
      src,
      controls: callbacks.controls,
      muted: callbacks.muted,
      loop: callbacks.loop,
      autoPlay: callbacks.autoPlay ?? true,
      idleTimeoutMs: callbacks.idleTimeoutMs,
      onPreempted: () => {
        setLive(false)
        optionsRef.current.onPreempted?.()
      },
    })
    if (!lease) return undefined
    const listeners: Array<[string, (event: Event) => void]> = []
    const wire = (key: keyof PooledVideoCallbacks, event: string) => {
      const listener = (domEvent: Event) => (optionsRef.current[key] as ((video: HTMLVideoElement) => void) | undefined)?.(domEvent.currentTarget as HTMLVideoElement)
      lease.video.addEventListener(event, listener)
      listeners.push([event, listener])
    }
    wire('onLoadedMetadata', 'loadedmetadata')
    wire('onTimeUpdate', 'timeupdate')
    wire('onPlay', 'play')
    wire('onError', 'error')
    container.appendChild(lease.video)
    setLive(true)
    return () => {
      for (const [event, listener] of listeners) lease.video.removeEventListener(event, listener)
      lease.release()
      setLive(false)
    }
  }, [src, active, epoch])

  const resume = useCallback(() => setEpoch((value) => value + 1), [])
  return { containerRef, live, resume }
}
