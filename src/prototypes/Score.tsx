/** Direction C — "The Score": the project as one parametric document.
 *
 *  Blender's viewport/outliner/node-editor idea applied to an edit: the
 *  document (project → shots → ops) is the source of truth; the TIMELINE is
 *  one projection of it and the NODE GRAPH is another — the same blocks,
 *  the same cache states, two views (flip with the toggle, V). The ruler is
 *  music-first (4/4 bars at the project's 92 BPM); the playhead scrubs via
 *  rAF + direct DOM transform — it NEVER enters React state (the wave-2a
 *  transient discipline). Changing an upstream param (a seed op in the
 *  tree) marks ONLY downstream blocks stale — shots that continue from the
 *  changed shot's ending go stale too, everything upstream stays fresh.
 */
import { useCallback, useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, GitBranch, Pause, Play as PlayIcon } from 'lucide-react'
import {
  BPM, TOTAL_BEATS, takesOfShot, useProtoStore, type Shot, type Take,
} from './protoStore'
import { CacheBadge, Kbd, QueueStrip } from './PrototypeShell'
import { useProtoKeys } from './protoKeys'

const PPB = 44 // pixels per beat — the whole 8-bar document fits the viewport
const RULER_H = 30
const ROW_H = 118

const xForBeat = (beat: number): number => beat * PPB
const widthForBeats = (beats: number): number => beats * PPB

const shotCache = (takes: Take[]): Take['status'] => {
  if (takes.some((take) => take.status === 'rendering')) return 'rendering'
  if (takes.some((take) => take.status === 'stale')) return 'stale'
  return 'fresh'
}

export function Score() {
  const shots = useProtoStore((state) => state.shots)
  const takes = useProtoStore((state) => state.takes)
  const projection = useProtoStore((state) => state.scoreProjection)
  const setScoreProjection = useProtoStore((state) => state.setScoreProjection)
  const setSeed = useProtoStore((state) => state.setSeed)
  const rerunStale = useProtoStore((state) => state.rerunStale)

  useProtoKeys(useCallback((event: KeyboardEvent) => {
    if (event.key === 'v' || event.key === 'V') {
      setScoreProjection(useProtoStore.getState().scoreProjection === 'timeline' ? 'graph' : 'timeline')
    }
  }, [setScoreProjection]))

  return <div className="score">
    {/* LEFT — the document tree (the source of truth these projections render). */}
    <aside className="score-tree" aria-label="Document tree">
      <header>
        <strong>Document</strong>
        <span>Neon Rains · scene 1 · 92 BPM · 4/4</span>
      </header>
      <div className="score-tree-body">
        {shots.map((shot) => (
          <ScoreTreeNode key={shot.id} shot={shot} takes={takesOfShot(takes, shot.id)} onSeed={setSeed} onRerun={rerunStale} />
        ))}
      </div>
      <p className="score-tree-note">Edit a value here and both projections below update — they are the same document.</p>
    </aside>

    {/* CENTER — the projections. */}
    <section className="score-main" aria-label="Timeline projection">
      <header className="score-toolbar">
        <div className="score-toolbar-title">
          <strong>{projection === 'timeline' ? 'Timeline — projection of the document' : 'Node graph — projection of the document'}</strong>
          <span>one document, many projections</span>
        </div>
        <div className="score-toolbar-actions">
          <button type="button" data-score-proj="timeline" className={projection === 'timeline' ? 'active' : ''} onClick={() => setScoreProjection('timeline')}>
            timeline
          </button>
          <span className="score-proj-sep">⇄</span>
          <button type="button" data-score-proj="graph" className={projection === 'graph' ? 'active' : ''} onClick={() => setScoreProjection('graph')}>
            node graph <Kbd>V</Kbd>
          </button>
        </div>
      </header>
      {projection === 'timeline'
        ? <ScoreTimeline shots={shots} takes={takes} />
        : <ScoreGraph shots={shots} takes={takes} />}
    </section>

    {/* BOTTOM — the queue, always visible. */}
    <div className="score-queue">
      <QueueStrip />
    </div>
  </div>
}

// ---------------------------------------------------------------------------

function ScoreTreeNode({
  shot, takes, onSeed, onRerun,
}: {
  shot: Shot
  takes: Take[]
  onSeed(shotId: string, seed: number): void
  onRerun(shotId: string): void
}) {
  const expanded = useProtoStore((state) => state.scoreExpanded[shot.id]) ?? false
  const toggle = useProtoStore((state) => state.toggleScoreNode)
  const seed = Number(/-?\d+/.exec(shot.ops.find((op) => op.kind === 'seed')?.summary ?? '0')?.[0] ?? 0)
  const staleCount = takes.filter((take) => take.status === 'stale').length

  return <div className={`score-node ${expanded ? 'open' : ''}`} data-tree-shot={shot.id}>
    <button type="button" className="score-node-row" onClick={() => toggle(shot.id)} aria-expanded={expanded}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      <span className="score-node-name">{shot.name}</span>
      <em>{takes.length} {takes.length === 1 ? 'take' : 'takes'}</em>
      <i data-cache={shotCache(takes)} title={`cache ${shotCache(takes)}`} />
    </button>
    {expanded && (
      <ul className="score-node-ops">
        {shot.ops.map((op) => (
          <li key={op.id} className={op.enabled ? '' : 'off'}>
            <span className="score-op-kind">{op.kind === 'seed' ? 'seed / LoRA' : op.kind}</span>
            {op.kind === 'seed' ? (
              // The upstream edit the whole direction hangs on: change the
              // seed HERE, watch only downstream blocks go stale below.
              <input
                type="number"
                className="score-seed-input"
                data-score-seed={shot.id}
                value={seed}
                aria-label={`Seed for ${shot.name}`}
                onChange={(event) => onSeed(shot.id, Number(event.target.value) || 0)}
              />
            ) : (
              <small>{op.summary}</small>
            )}
            {!op.enabled && <em>off</em>}
          </li>
        ))}
        <li className="score-node-takes">
          {takes.map((take) => (
            <span key={take.id} className="score-node-take">
              {take.label}{take.pinned ? ' ★' : ''}{take.branchedFrom ? ` ⟵${take.branchedFrom}` : ''}
              <i data-cache={take.status} />
            </span>
          ))}
        </li>
        {staleCount > 0 && (
          <li className="score-node-rerun">
            <span>{staleCount} stale</span>
            <button type="button" onClick={() => onRerun(shot.id)}>re-run</button>
          </li>
        )}
      </ul>
    )}
  </div>
}

// ---------------------------------------------------------------------------

/** The timeline projection. The playhead is rAF + direct DOM transform —
 *  dragging it never touches React state (the wave-2a discipline, shown
 *  where it will matter most: the real timeline). */
function ScoreTimeline({ shots, takes }: { shots: Shot[]; takes: Take[] }) {
  const hoverShot = useProtoStore((state) => state.scoreHoverShot)
  const setHoverShot = useProtoStore((state) => state.setScoreHoverShot)
  const contentRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const readoutRef = useRef<HTMLSpanElement>(null)
  const beatRef = useRef(0)
  const frameRef = useRef(0)
  const playingRef = useRef(false)
  const lastTickRef = useRef(0)

  // The ONE writer of the playhead position: a ref-held beat value painted
  // directly to the DOM inside a rAF — zero React renders per frame.
  const paint = useCallback(() => {
    const beat = beatRef.current
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${xForBeat(beat)}px)`
    if (readoutRef.current) {
      const bar = Math.floor(beat / 4) + 1
      const withinBar = Math.floor(beat % 4) + 1
      readoutRef.current.textContent = `Bar ${bar} · beat ${withinBar} · ${BPM} BPM`
    }
  }, [])

  const beatFromPointer = useCallback((clientX: number): number => {
    const content = contentRef.current
    if (!content) return beatRef.current
    const rect = content.getBoundingClientRect()
    const beat = (clientX - rect.left) / PPB
    return Math.min(TOTAL_BEATS, Math.max(0, beat))
  }, [])

  const onRulerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    beatRef.current = beatFromPointer(event.clientX)
    paint()
  }, [beatFromPointer, paint])

  const onRulerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    // Coalesce pointer moves into one paint per frame.
    const target = beatFromPointer(event.clientX)
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      beatRef.current = target
      paint()
    })
  }, [beatFromPointer, paint])

  // Space plays/pauses: a rAF loop advances the beat at the project tempo.
  const setPlaying = useCallback((next: boolean) => {
    playingRef.current = next
    if (next) {
      lastTickRef.current = performance.now()
      const step = (now: number) => {
        if (!playingRef.current) return
        const dt = (now - lastTickRef.current) / 1_000
        lastTickRef.current = now
        beatRef.current = (beatRef.current + dt * BPM / 60) % TOTAL_BEATS
        paint()
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }
  }, [paint])

  const playButtonRef = useRef<HTMLButtonElement>(null)
  const togglePlay = useCallback(() => {
    const next = !playingRef.current
    setPlaying(next)
    playButtonRef.current?.setAttribute('data-playing', String(next))
  }, [setPlaying])

  useProtoKeys(useCallback((event: KeyboardEvent) => {
    if (event.key === ' ') {
      event.preventDefault()
      togglePlay()
    }
  }, [togglePlay]))

  useEffect(() => () => {
    playingRef.current = false
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
  }, [])

  const depSource = shots.find((shot) => shot.id === 'shot-2')
  const depTarget = shots.find((shot) => shot.id === 'shot-3')
  const showDep = hoverShot === 'shot-3'
  // The continuity edge: out of shot-2's ending, down into shot-3's head.
  const depPath = depSource && depTarget
    ? `M ${xForBeat(depSource.startBeat + depSource.beats) - 64} ${ROW_H * 1 + 46} C ${xForBeat(depSource.startBeat + depSource.beats) + 10} ${ROW_H * 1 + 104}, ${xForBeat(depTarget.startBeat) - 10} ${ROW_H * 2 - 8}, ${xForBeat(depTarget.startBeat) + 64} ${ROW_H * 2 + 8}`
    : ''

  return <div className="score-timeline" data-score-view="timeline">
    <div className="score-transport">
      <button
        type="button"
        className="score-play"
        aria-label="Play or pause the score"
        ref={playButtonRef}
        onClick={togglePlay}
      >
        <PlayIcon size={13} /><Pause size={13} /> <span>play</span> <Kbd>Space</Kbd>
      </button>
      <span ref={readoutRef} className="score-readout" data-score-readout>Bar 1 · beat 1 · {BPM} BPM</span>
      <span className="score-drag-hint">drag the ruler to scrub — the playhead paints via rAF, never React state</span>
    </div>
    <div className="score-scroll">
      <div className="score-content" ref={contentRef} style={{ width: xForBeat(TOTAL_BEATS) + 160 }}>
        {/* The beat ruler — 4/4 bars, music-first. */}
        <div
          className="score-ruler"
          data-score-ruler
          style={{ height: RULER_H, width: '100%' }}
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        >
          {Array.from({ length: TOTAL_BEATS / 4 }, (_, bar) => (
            <div key={bar} className="score-bar" style={{ left: xForBeat(bar * 4), width: widthForBeats(4) }}>
              <span>Bar {bar + 1}</span>
              <i />
              <i />
              <i />
              <i />
            </div>
          ))}
        </div>
        {/* Shots as span-blocks, takes as lanes under their shot. */}
        <div className="score-tracks">
          {shots.map((shot, rowIndex) => {
            const family = takesOfShot(takes, shot.id)
            return <div
              key={shot.id}
              className={`score-row ${hoverShot === shot.id ? 'hot' : ''}`}
              style={{ top: rowIndex * ROW_H, height: ROW_H - 10 }}
            >
              <div
                className={`score-block ${shot.dependsOn.length > 0 ? 'has-dep' : ''}`}
                data-score-block={shot.id}
                style={{ left: xForBeat(shot.startBeat), width: widthForBeats(shot.beats) }}
                onPointerEnter={() => setHoverShot(shot.id)}
                onPointerLeave={() => setHoverShot(null)}
                title={shot.dependsOn.length > 0 ? 'continues from the previous shot\'s ending — hover shows the link' : undefined}
              >
                <header>
                  <strong>{shot.name}</strong>
                  <CacheBadge status={shotCache(family)} />
                </header>
                <ul className="score-lanes">
                  {family.map((take) => (
                    <li key={take.id} className="score-lane" data-score-lane={take.id}>
                      <span>{take.label}{take.pinned ? ' ★' : ''}</span>
                      <i data-cache={take.status} title={`cache ${take.status}`} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          })}
          {/* The continuity edge, drawn on hover: shot 3 continues shot 2's ending. */}
          {showDep && depPath && (
            <svg className="score-dep" data-score-dep aria-hidden width={xForBeat(TOTAL_BEATS) + 160} height={ROW_H * 4}>
              <path d={depPath} />
            </svg>
          )}
          {/* The playhead — transformed directly, never through React. */}
          <div className="score-playhead" data-score-playhead ref={playheadRef} style={{ top: 0 }} />
        </div>
      </div>
    </div>
  </div>
}

// ---------------------------------------------------------------------------

/** The node-graph projection — the same document, drawn as dependencies. */
function ScoreGraph({ shots, takes }: { shots: Shot[]; takes: Take[] }) {
  const hoverShot = useProtoStore((state) => state.scoreHoverShot)
  const setHoverShot = useProtoStore((state) => state.setScoreHoverShot)
  const positions: Record<string, { x: number; y: number }> = {
    'shot-1': { x: 60, y: 170 },
    'shot-2': { x: 430, y: 170 },
    'shot-3': { x: 800, y: 170 },
    'shot-4': { x: 1170, y: 170 },
  }
  const project = { x: 615, y: 30 }

  return <div className="score-graph" data-score-view="graph">
    <p className="score-graph-note">Every edge below is a dependency in the SAME document the timeline shows — hover the alley sprint to light its continuity link.</p>
    <div className="score-graph-canvas">
      <svg className="score-graph-edges" aria-hidden>
        {shots.map((shot) => {
          const position = positions[shot.id]
          return <line key={shot.id} x1={project.x + 80} y1={project.y + 34} x2={position.x + 150} y2={position.y} />
        })}
        {shots.flatMap((shot) => shot.dependsOn.map((parentId) => {
          const from = positions[parentId]
          const to = positions[shot.id]
          const hot = hoverShot === shot.id
          return <path
            key={`${parentId}->${shot.id}`}
            className={hot ? 'hot' : ''}
            data-graph-dep={`${parentId}->${shot.id}`}
            d={`M ${from.x + 300} ${from.y + 26} C ${from.x + 380} ${from.y + 110}, ${to.x - 80} ${to.y + 110}, ${to.x - 8} ${to.y + 34}`}
          />
        }))}
      </svg>
      <div className="score-graph-node project" style={{ left: project.x, top: project.y }}>
        <GitBranch size={13} />
        <strong>Neon Rains</strong>
        <small>document root · 92 BPM</small>
      </div>
      {shots.map((shot) => {
        const family = takesOfShot(takes, shot.id)
        const position = positions[shot.id]
        const seed = Number(/-?\d+/.exec(shot.ops.find((op) => op.kind === 'seed')?.summary ?? '0')?.[0] ?? 0)
        return <div
          key={shot.id}
          className={`score-graph-node shot ${hoverShot === shot.id ? 'hot' : ''}`}
          data-graph-node={shot.id}
          style={{ left: position.x, top: position.y }}
          onPointerEnter={() => setHoverShot(shot.id)}
          onPointerLeave={() => setHoverShot(null)}
        >
          <header>
            <strong>{shot.name}</strong>
            <CacheBadge status={shotCache(family)} />
          </header>
          <div className="score-graph-chips">
            <span>seed {seed}</span>
            <span>{shot.steps} steps</span>
            <span>{shot.beats} beats</span>
          </div>
          <ul className="score-graph-takes">
            {family.map((take) => (
              <li key={take.id}><span>{take.label}{take.pinned ? ' ★' : ''}</span><i data-cache={take.status} /></li>
            ))}
          </ul>
        </div>
      })}
    </div>
  </div>
}
