/** PrototypeShell — the wave-3 decision artifact's frame.
 *
 *  Mounted ONLY under ?proto=bench|stage|score (main.tsx lazily loads this
 *  module exactly like MobileApp; every normal app route never imports it).
 *  The shell pins the A/B/C switcher so the artist flips between the three
 *  directions LIVE — one shared mock project, so the comparison is honest.
 *
 *  All three directions demonstrate the same design rules from the UX
 *  report: no modal dialogs anywhere (deferred commit is the only path),
 *  the queue always visible with honest failure rows, param-diff between
 *  takes, keyboard shortcuts printed ON the affordances, and curation
 *  (pick-best, branch) as the celebrated gesture.
 */
import { Suspense, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Film, Play, X } from 'lucide-react'
import { ensureQueueAlive, useProtoStore, type ProtoDirection, type QueueItem, type Take } from './protoStore'
import { clipUrl, startPosterGeneration } from './posters'
import { leaseVideo } from '../media/videoPool'
import { ShotBench } from './ShotBench'
import { Stage } from './Stage'
import { Score } from './Score'
import './proto.css'

const DIRECTIONS: Array<{ id: ProtoDirection; letter: string; name: string; hint: string }> = [
  {
    id: 'bench', letter: 'A', name: 'Shot Bench',
    hint: 'J / K cycle takes in place · ←/→ scrub · 1–4 jump to take · B branch · P pin — flip a modifier on the right, the takes go stale, re-run them',
  },
  {
    id: 'stage', letter: 'B', name: 'The Stage',
    hint: 'drag empty space to pan · wheel to zoom · click an object — the panel follows the selection · change a slider: it renders immediately, no dialog · click again / J K to cycle a shot\'s takes',
  },
  {
    id: 'score', letter: 'C', name: 'The Score',
    hint: 'the project is one parametric document · timeline ⇄ node graph are two projections of it · change shot 2\'s seed in the tree — only its downstream goes stale · drag the ruler to scrub (Space plays)',
  },
]

export function PrototypeShell() {
  const direction = useProtoStore((state) => state.direction)
  const setDirection = useProtoStore((state) => state.setDirection)

  useEffect(() => {
    startPosterGeneration()
    ensureQueueAlive()
  }, [])

  const active = DIRECTIONS.find((entry) => entry.id === direction) ?? DIRECTIONS[0]

  return <div className="proto-root" data-proto={direction}>
    <header className="proto-switcher">
      <div className="proto-switcher-brand">
        <strong>MiniMax Studio</strong>
        <span className="proto-flag">PROTOTYPE — static mock data</span>
      </div>
      <nav className="proto-switcher-tabs" aria-label="UI direction">
        {DIRECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-proto-switch={entry.id}
            className={entry.id === direction ? 'active' : ''}
            onClick={() => setDirection(entry.id)}
          >
            <em>{entry.letter}</em>
            <span>{entry.name}</span>
          </button>
        ))}
      </nav>
      <div className="proto-switcher-note">one shared mock project — flips keep your pins &amp; queue</div>
    </header>
    <div className="proto-hint" data-proto-hint={active.id}>{active.hint}</div>
    <main className="proto-body">
      <Suspense fallback={<div className="proto-loading">loading direction…</div>}>
        {direction === 'stage' ? <Stage /> : direction === 'score' ? <Score /> : <ShotBench />}
      </Suspense>
    </main>
  </div>
}

// ---------------------------------------------------------------------------
// Shared primitives — tokens-only styling, kbd printed on every affordance.

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="proto-kbd">{children}</kbd>
}

export function CacheBadge({ status }: { status: Take['status'] }) {
  return <span className="proto-badge" data-cache={status}>
    <i />{status}
  </span>
}

export function QueueStatusDot({ status }: { status: QueueItem['status'] }) {
  return <i className={`proto-qdot ${status}`} data-qstatus={status} />
}

/** A take's static poster (canvas-generated at boot) with labeled fallback. */
export function TakePoster({ take, className = '' }: { take: Take; className?: string }) {
  const poster = useProtoStore((state) => state.posters[take.id])
  if (poster) {
    return <img className={`proto-poster ${className}`} src={poster} alt={`${take.label} poster`} loading="lazy" />
  }
  return <div className={`proto-poster proto-poster-empty ${className}`} aria-label={`${take.label} poster`}>
    <Film size={18} />
    <span>{take.label}</span>
  </div>
}

/** The pooled take player: static poster until played; playback rides the
 *  app-wide video pool (one live element at most), filtered + rate-shifted
 *  per take so the shared sample clip reads as different takes. Exposes an
 *  imperative seek for the ←/→ scrub keys — the transport stays outside
 *  React state. */
export type ProtoPlayerHandle = { seekBy(seconds: number): void }

export const ProtoPlayer = forwardRef<ProtoPlayerHandle, { take: Take; ariaLabel: string }>(
  function ProtoPlayer({ take, ariaLabel }, ref) {
    const poster = useProtoStore((state) => state.posters[take.id])
    const [playing, setPlaying] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const leaseRef = useRef<{ video: HTMLVideoElement; release(): void } | null>(null)
    const takeRef = useRef(take)
    takeRef.current = take

    const stop = useCallback(() => {
      leaseRef.current?.release()
      leaseRef.current = null
      setPlaying(false)
    }, [])

    const play = useCallback(() => {
      const container = containerRef.current
      if (!container) return
      leaseRef.current?.release()
      const lease = leaseVideo({
        src: clipUrl,
        controls: true,
        autoPlay: true,
        loop: true,
        onPreempted: () => {
          leaseRef.current = null
          setPlaying(false)
        },
      })
      if (!lease) return
      const current = takeRef.current
      lease.video.style.filter = current.filter === 'none' ? '' : current.filter
      lease.video.playbackRate = current.rate
      leaseRef.current = lease
      container.appendChild(lease.video)
      setPlaying(true)
    }, [])

    useImperativeHandle(ref, () => ({
      seekBy(seconds: number) {
        const video = leaseRef.current?.video
        if (!video || !Number.isFinite(video.duration)) return
        video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration)
      },
    }), [])

    // Cycling takes while playing swaps the lease's look in place — the
    // audition idea: the picture never leaves the slot.
    useEffect(() => {
      const lease = leaseRef.current
      if (!lease) return
      lease.video.style.filter = take.filter === 'none' ? '' : take.filter
      lease.video.playbackRate = take.rate
    }, [take])

    useEffect(() => () => stop(), [stop])

    return <div className="proto-player" ref={containerRef} aria-label={ariaLabel}>
      {!playing && (poster
        ? <img className="proto-player-poster" src={poster} alt="" />
        : <div className="proto-player-poster proto-poster-empty"><Film size={22} /><span>{take.label}</span></div>)}
      {!playing && (
        <button type="button" className="proto-player-play" onClick={play} aria-label={`Play ${ariaLabel} ${take.label}`}>
          <Play size={18} />
          <span>play</span>
        </button>
      )}
    </div>
  },
)

/** The always-visible queue. `variant="mini"` is the Stage's bottom edge. */
export function QueueStrip({ variant = 'strip' }: { variant?: 'strip' | 'mini' }) {
  const queue = useProtoStore((state) => state.queue)
  const retry = useProtoStore((state) => state.retryQueueItem)
  const dismiss = useProtoStore((state) => state.dismissQueueItem)
  const running = queue.filter((item) => item.status === 'running' || item.status === 'queued').length

  return <section className={`proto-queue ${variant}`} aria-label="Render queue">
    <header>
      <strong>Queue</strong>
      <span>{running === 0 ? 'idle' : `${running} active`}</span>
    </header>
    <div className="proto-queue-items">
      {queue.map((item) => (
        <article key={item.id} className="proto-queue-item" data-qstate={item.status}>
          <div className="proto-queue-line">
            <QueueStatusDot status={item.status} />
            <span className="proto-queue-label">{item.label}</span>
            <span className="proto-queue-state">{item.status}{item.status === 'running' ? ` · ${Math.round(item.progress)}%` : ''}</span>
            {item.status === 'failed' && (
              <button type="button" className="proto-queue-retry" onClick={() => retry(item.id)}>retry</button>
            )}
            {(item.status === 'done' || item.status === 'failed') && (
              <button type="button" className="proto-queue-dismiss" aria-label={`Dismiss ${item.label}`} onClick={() => dismiss(item.id)}><X size={12} /></button>
            )}
          </div>
          {item.status === 'running' && (
            <div className="proto-queue-progress"><i style={{ width: `${item.progress}%` }} /></div>
          )}
          {item.status === 'failed' && item.error && (
            // The honest failure row — the error is shown in full, in place.
            <p className="proto-queue-error" role="alert">{item.error}</p>
          )}
        </article>
      ))}
    </div>
  </section>
}

export default PrototypeShell
