/**
 * Shared media-preview widgets over the wave-2d seams (PreviewSource /
 * videoPool / OPFS blob cache): one implementation instead of three per-view
 * thumbnail mounts. Everything here is STATIC by default — a card, queue
 * row, or bin item renders a filmstrip poster (one small PNG per clip) and
 * only ever mounts a <video> element through the pool, so the app holds at
 * most a handful of video elements no matter how many renders are listed.
 * The hooks live in src/media/ (useFilmstrip / usePooledVideo).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import type { Filmstrip } from '../media/PreviewSource'
import { leaseVideo } from '../media/videoPool'
import { useFilmstrip } from '../media/useFilmstrip'

/** Static filmstrip poster. mode="sheet" shows the whole contact sheet (an
 *  <img>); mode="frame" shows frame 1 via CSS background-position on the
 *  sheet — the classic sprite technique, no second request. Falls back to an
 *  empty placeholder (children, e.g. an icon) while loading or when the
 *  clip has no sheet. */
export function FilmstripPoster({ filmstrip, mode = 'sheet', label, children, className = '' }: { filmstrip: Filmstrip | null; mode?: 'sheet' | 'frame'; label: string; children?: ReactNode; className?: string }) {
  if (mode === 'frame') {
    return <div
      className={`filmstrip-poster filmstrip-poster-frame ${className}`}
      role="img"
      aria-label={label}
      style={filmstrip ? {
        backgroundImage: `url("${filmstrip.url}")`,
        backgroundSize: `${filmstrip.cols * 100}% ${filmstrip.rows * 100}%`,
        backgroundPosition: '0% 0%',
      } : undefined}
    >{!filmstrip && children}</div>
  }
  return filmstrip
    ? <img className={`filmstrip-poster ${className}`} src={filmstrip.url} alt={label} loading="lazy" />
    : <div className={`filmstrip-poster filmstrip-poster-empty ${className}`} aria-label={label}>{children}</div>
}

/** The Library-card media area: static filmstrip sheet + play overlay; a
 *  click leases a pooled <video> (controls, exclusive) into the card.
 *  Release happens on click-away, unmount, or any other lease taking the
 *  element (pool exclusivity) — the poster returns in every case. */
export function PooledVideoCard({ src, path, duration, label }: { src: string | undefined; path: string | null; duration: number; label: string }) {
  const filmstrip = useFilmstrip(path, duration)
  const [playing, setPlaying] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const leaseRef = useRef<{ release(): void } | null>(null)

  const stop = useCallback(() => {
    leaseRef.current?.release()
    leaseRef.current = null
    setPlaying(false)
  }, [])

  const play = useCallback(() => {
    const container = containerRef.current
    if (!container || !src) return
    leaseRef.current?.release()
    const lease = leaseVideo({
      src,
      controls: true,
      autoPlay: true,
      onPreempted: () => {
        leaseRef.current = null
        setPlaying(false)
      },
    })
    if (!lease) return
    leaseRef.current = lease
    container.appendChild(lease.video)
    setPlaying(true)
  }, [src])

  useEffect(() => () => stop(), [stop])

  // Click-away releases: any pointerdown outside this card stops playback.
  useEffect(() => {
    if (!playing) return undefined
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) stop()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [playing, stop])

  return <div className="pooled-video-card" ref={containerRef}>
    {!playing && <FilmstripPoster filmstrip={filmstrip} label={label} />}
    {!playing && <button className="play-overlay" aria-label={`Play ${label}`} onClick={play}><Play size={20} /></button>}
  </div>
}
