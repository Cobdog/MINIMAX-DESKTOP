/** Direction B — "The Stage": one infinite canvas, everything is an object.
 *
 *  Blender's two paradigms rendered spatially: SELECT-THEN-OPERATE (the
 *  right panel shows THE SELECTED OBJECT's operations — a shot shows
 *  generation params, an image shows transform, audio shows mix; there is
 *  no global mode anywhere) and OPERATE→SETTINGS (every change fires
 *  immediately — a slider nudge re-renders the object with its own progress
 *  bar and the last-used values stay live-editable; never a confirm
 *  dialog). Shots carry their takes STACKED at one position — the audition
 *  idea as a spatial object — cycled by clicking again or J/K.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, Image as ImageIcon, Maximize2, Minus, Music2, Pin, Plus, RefreshCw } from 'lucide-react'
import { takesOfShot, useProtoStore, type Shot, type StageSelection } from './protoStore'
import { CacheBadge, Kbd, QueueStrip, TakePoster } from './PrototypeShell'
import { useProtoKeys } from './protoKeys'

const LAYOUT: Record<string, { x: number; y: number; w: number }> = {
  'shot-1': { x: 120, y: 96, w: 360 },
  'shot-2': { x: 700, y: 400, w: 300 },
  'shot-3': { x: 440, y: 780, w: 300 },
  'shot-4': { x: 1130, y: 210, w: 300 },
  'lib-plate': { x: 1460, y: 560, w: 240 },
  'lib-stems': { x: 150, y: 1080, w: 360 },
}

const MIN_Z = 0.35
const MAX_Z = 2.2

/** The object's own mock render overlay — Operate→Settings made visible. */
function RenderFlash({ stamp }: { stamp: number | undefined }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!stamp) return undefined
    setVisible(true)
    const timer = window.setTimeout(() => setVisible(false), 1_800)
    return () => window.clearTimeout(timer)
  }, [stamp])
  if (!stamp || !visible) return null
  return <div className="stage-obj-render" data-obj-progress aria-hidden>
    <span>re-running with new settings…</span>
    <div className="stage-obj-render-bar"><i /></div>
  </div>
}

export function Stage() {
  const shots = useProtoStore((state) => state.shots)
  const selection = useProtoStore((state) => state.stageSelection)
  const selectStageObject = useProtoStore((state) => state.selectStageObject)
  const view = useProtoStore((state) => state.stageView)
  const setStageView = useProtoStore((state) => state.setStageView)
  const stageRender = useProtoStore((state) => state.stageRender)
  const cycleStageTake = useProtoStore((state) => state.cycleStageTake)
  const branchTake = useProtoStore((state) => state.branchTake)
  const pinTake = useProtoStore((state) => state.pinTake)
  const rerunStale = useProtoStore((state) => state.rerunStale)

  const canvasRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)

  // Wheel zoom must be a NON-passive native listener (React's onWheel is
  // passive; the canvas owns the gesture). Zooms about the cursor.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = useProtoStore.getState().stageView
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      const next = Math.min(MAX_Z, Math.max(MIN_Z, current.z * factor))
      const rect = canvas.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const ratio = next / current.z
      setStageView({
        z: next,
        x: mx - (mx - current.x) * ratio,
        y: my - (my - current.y) * ratio,
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [setStageView])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Only the empty canvas pans — objects stop propagation on their own
    // pointer events.
    panRef.current = { startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan) return
    const dx = event.clientX - pan.startX
    const dy = event.clientY - pan.startY
    if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true
    if (pan.moved) setStageView({ x: pan.originX + dx, y: pan.originY + dy, z: view.z })
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    panRef.current = null
    // A click on empty space (not a drag) deselects — Escape works too.
    if (pan && !pan.moved) selectStageObject(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const selectedShot = selection?.kind === 'shot' ? shots.find((entry) => entry.id === selection.id) : undefined

  const cycleSelected = useCallback((delta: number) => {
    if (selectedShot) cycleStageTake(selectedShot.id, delta)
  }, [cycleStageTake, selectedShot])

  const branchSelected = useCallback(() => {
    if (!selectedShot) return
    const index = useProtoStore.getState().stageTakeIndex[selectedShot.id] ?? 0
    const family = takesOfShot(useProtoStore.getState().takes, selectedShot.id)
    const source = family[index] ?? family[0]
    if (source) branchTake(selectedShot.id, source.id)
  }, [branchTake, selectedShot])

  const pinSelected = useCallback(() => {
    if (!selectedShot) return
    const index = useProtoStore.getState().stageTakeIndex[selectedShot.id] ?? 0
    const family = takesOfShot(useProtoStore.getState().takes, selectedShot.id)
    const source = family[index] ?? family[0]
    if (source) pinTake(selectedShot.id, source.id)
  }, [pinTake, selectedShot])

  useProtoKeys(useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') { selectStageObject(null); return }
    if (!selectedShot) return
    if (event.key === 'j') { cycleSelected(1); return }
    if (event.key === 'k') { cycleSelected(-1); return }
    if (event.key === 'b') { branchSelected(); return }
    if (event.key === 'p') { pinSelected(); return }
    if (event.key === 'r') { rerunStale(selectedShot.id) }
  }, [branchSelected, cycleSelected, pinSelected, rerunStale, selectStageObject, selectedShot]))

  return <div className="stage">
    <div
      className="stage-canvas"
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="stage-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
      >
        {shots.map((shot) => (
          <StageShot
            key={shot.id}
            shot={shot}
            selected={selection?.kind === 'shot' && selection.id === shot.id}
            renderStamp={stageRender[shot.id]}
            onSelect={selectStageObject}
            onCycle={cycleStageTake}
          />
        ))}
        <StagePlate selected={selection?.kind === 'image' && selection.id === 'lib-plate'} renderStamp={stageRender['lib-plate']} onSelect={selectStageObject} />
        <StageStems selected={selection?.kind === 'audio' && selection.id === 'lib-stems'} onSelect={selectStageObject} />
      </div>
      <div className="stage-zoom">
        <button type="button" aria-label="Zoom out" onClick={() => setStageView({ ...view, z: Math.max(MIN_Z, view.z / 1.2) })}><Minus size={13} /></button>
        <span>{Math.round(view.z * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => setStageView({ ...view, z: Math.min(MAX_Z, view.z * 1.2) })}><Plus size={13} /></button>
        <button type="button" aria-label="Reset view" onClick={() => setStageView({ x: 24, y: 18, z: 0.82 })}><Maximize2 size={13} /></button>
      </div>
      <div className="stage-miniqueue">
        <QueueStrip variant="mini" />
      </div>
    </div>
    <StagePanel selection={selection} />
  </div>
}

// ---------------------------------------------------------------------------

function StageShot({
  shot, selected, renderStamp, onSelect, onCycle,
}: {
  shot: Shot
  selected: boolean
  renderStamp: number | undefined
  onSelect(selection: StageSelection | null): void
  onCycle(shotId: string, delta: number): void
}) {
  const takes = useProtoStore((state) => state.takes)
  const family = takesOfShot(takes, shot.id)
  const index = useProtoStore((state) => state.stageTakeIndex[shot.id]) ?? 0
  const current = family[Math.min(index, family.length - 1)]
  const layout = LAYOUT[shot.id]
  const staleCount = family.filter((entry) => entry.status === 'stale').length
  if (!layout || !current) return null

  return <div
    className={`stage-obj stage-shot ${selected ? 'selected' : ''}`}
    data-stage-object={shot.id}
    style={{ left: layout.x, top: layout.y, width: layout.w }}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={() => {
      // Click selects; clicking the ALREADY-selected shot cycles its take
      // stack — the audition, spatially.
      if (selected) onCycle(shot.id, 1)
      else onSelect({ kind: 'shot', id: shot.id })
    }}
  >
    <div className="stage-obj-layer l2" aria-hidden />
    <div className="stage-obj-layer l1" aria-hidden />
    <header>
      <strong>{shot.name}</strong>
      <em>{family.length} {family.length === 1 ? 'take' : 'takes'}</em>
    </header>
    <div className="stage-obj-media">
      <TakePoster take={current} />
      <span className="stage-obj-take" data-stage-take>{current.label}{current.pinned ? ' ★' : ''}</span>
      <RenderFlash stamp={renderStamp} />
    </div>
    <footer>
      <CacheBadge status={current.status} />
      {staleCount > 0 && <span className="stage-obj-stale">{staleCount} stale</span>}
      {selected && (
        <span className="stage-obj-hints">
          <Kbd>J</Kbd><Kbd>K</Kbd> cycle · <Kbd>B</Kbd> branch · <Kbd>P</Kbd> pin · <Kbd>R</Kbd> re-run
        </span>
      )}
    </footer>
  </div>
}

function StagePlate({ selected, renderStamp, onSelect }: { selected: boolean; renderStamp: number | undefined; onSelect(selection: StageSelection | null): void }) {
  const poster = useProtoStore((state) => state.posters['lib-plate'])
  const transform = useProtoStore((state) => state.stageTransforms['lib-plate']) ?? { scale: 1, rotate: 0, opacity: 1 }
  const layout = LAYOUT['lib-plate']
  return <div
    className={`stage-obj stage-plate ${selected ? 'selected' : ''}`}
    data-stage-object="lib-plate"
    style={{ left: layout.x, top: layout.y, width: layout.w }}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={() => onSelect(selected ? null : { kind: 'image', id: 'lib-plate' })}
  >
    <header>
      <strong>Neon alley — plate</strong>
      <em><ImageIcon size={11} /> still</em>
    </header>
    <div className="stage-obj-media">
      {poster
        ? <img
            className="proto-poster"
            src={poster}
            alt="Neon alley plate"
            style={{
              transform: `scale(${transform.scale}) rotate(${transform.rotate}deg)`,
              opacity: transform.opacity,
            }}
          />
        : <div className="proto-poster proto-poster-empty"><ImageIcon size={18} /><span>plate</span></div>}
      <RenderFlash stamp={renderStamp} />
    </div>
    <footer>
      <span className="proto-badge still"><i />library</span>
      {selected && <span className="stage-obj-hints">transform applies live — no re-render</span>}
    </footer>
  </div>
}

function StageStems({ selected, onSelect }: { selected: boolean; onSelect(selection: StageSelection | null): void }) {
  const volume = useProtoStore((state) => (state.stageTransforms['lib-stems']?.scale) ?? 0.8)
  const layout = LAYOUT['lib-stems']
  return <div
    className={`stage-obj stage-stems ${selected ? 'selected' : ''}`}
    data-stage-object="lib-stems"
    style={{ left: layout.x, top: layout.y, width: layout.w }}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={() => onSelect(selected ? null : { kind: 'audio', id: 'lib-stems' })}
  >
    <header>
      <strong>Rains on Glass — stems</strong>
      <em><Music2 size={11} /> 92 BPM</em>
    </header>
    <div className="stage-obj-wave" aria-hidden>
      {Array.from({ length: 42 }, (_, index) => {
        const height = 12 + Math.abs(Math.sin(index * 0.7) * 22 + Math.sin(index * 0.23) * 14) * volume
        return <i key={index} style={{ height: Math.min(46, height) }} />
      })}
    </div>
    <footer>
      <span className="proto-badge still"><i />audio</span>
      <small>vol {Math.round(volume * 100)}%</small>
      {selected && <span className="stage-obj-hints">mix applies live</span>}
    </footer>
  </div>
}

// ---------------------------------------------------------------------------

function StagePanel({ selection }: { selection: StageSelection | null }) {
  const shots = useProtoStore((state) => state.shots)
  const takes = useProtoStore((state) => state.takes)
  const stageTakeIndex = useProtoStore((state) => state.stageTakeIndex)
  const stageTransforms = useProtoStore((state) => state.stageTransforms)
  const setSeed = useProtoStore((state) => state.setSeed)
  const setShotPrompt = useProtoStore((state) => state.setShotPrompt)
  const setShotSteps = useProtoStore((state) => state.setShotSteps)
  const toggleOp = useProtoStore((state) => state.toggleOp)
  const kickStageRender = useProtoStore((state) => state.kickStageRender)
  const enqueue = useProtoStore((state) => state.enqueue)
  const cycleStageTake = useProtoStore((state) => state.cycleStageTake)
  const branchTake = useProtoStore((state) => state.branchTake)
  const pinTake = useProtoStore((state) => state.pinTake)
  const setStageTransform = useProtoStore((state) => state.setStageTransform)
  const rerunStale = useProtoStore((state) => state.rerunStale)
  const debounceRef = useRef(0)

  // The panel IS the selected object's operations — nothing global.
  if (!selection) {
    return <aside className="stage-panel" data-stage-panel="empty" aria-label="Selection tools">
      <header><strong>Tools</strong><span>nothing selected</span></header>
      <p className="stage-panel-empty">
        Click any object on the stage — the panel becomes that object's operations.
        There is no mode to set first; the tools follow your selection.
      </p>
    </aside>
  }

  if (selection.kind === 'shot') {
    const shot = shots.find((entry) => entry.id === selection.id)
    if (!shot) return null
    const family = takesOfShot(takes, shot.id)
    const index = stageTakeIndex[shot.id] ?? 0
    const current = family[Math.min(index, family.length - 1)]
    const seed = Number(/-?\d+/.exec(shot.ops.find((op) => op.kind === 'seed')?.summary ?? '0')?.[0] ?? 0)
    const prompt = shot.ops.find((op) => op.kind === 'prompt')?.summary ?? ''

    // Operate→Settings: the change RUNS. The object shows its own progress,
    // last-used values stay live-editable, and one queued item lands after
    // the slider settles (debounced — dragging is one operation, not thirty).
    const operate = () => {
      kickStageRender(shot.id)
      window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => {
        const fresh = useProtoStore.getState().shots.find((entry) => entry.id === shot.id)
        const seedNow = Number(/-?\d+/.exec(fresh?.ops.find((op) => op.kind === 'seed')?.summary ?? '0')?.[0] ?? 0)
        enqueue(`Render new take · ${shot.name} · seed ${seedNow}`)
      }, 650)
    }

    return <aside className="stage-panel" data-stage-panel="shot" aria-label="Selected shot tools">
      <header>
        <strong>Shot · {shot.name}</strong>
        <span>generation — runs on change</span>
      </header>
      <label className="stage-panel-field">
        <span>prompt</span>
        <textarea
          value={prompt}
          data-stage-prompt
          onChange={(event) => { setShotPrompt(shot.id, event.target.value); operate() }}
        />
      </label>
      <label className="stage-panel-field">
        <span>seed <b data-stage-seed-value>{seed}</b></span>
        <input
          type="range"
          min={1000}
          max={200000}
          step={137}
          value={seed}
          data-stage-slider="seed"
          onChange={(event) => { setSeed(shot.id, Number(event.target.value)); operate() }}
        />
      </label>
      <label className="stage-panel-field">
        <span>steps <b>{shot.steps}</b></span>
        <input
          type="range"
          min={16}
          max={60}
          step={2}
          value={shot.steps}
          data-stage-slider="steps"
          onChange={(event) => { setShotSteps(shot.id, Number(event.target.value)); operate() }}
        />
      </label>
      <div className="stage-panel-take">
        <header>
          <strong>take in slot</strong>
          <span>{current ? `${current.label} of ${family.length}` : '—'}</span>
        </header>
        <div className="stage-panel-take-actions">
          <button type="button" onClick={() => cycleStageTake(shot.id, -1)}><Kbd>K</Kbd> prev</button>
          <button type="button" onClick={() => cycleStageTake(shot.id, 1)}>next <Kbd>J</Kbd></button>
          <button type="button" disabled={!current} onClick={() => current && pinTake(shot.id, current.id)}><Pin size={12} /> {current?.pinned ? 'pinned ★' : 'pin'} <Kbd>P</Kbd></button>
          <button type="button" disabled={!current} onClick={() => current && branchTake(shot.id, current.id)}><GitBranch size={12} /> branch <Kbd>B</Kbd></button>
          {family.some((entry) => entry.status === 'stale') && (
            <button type="button" className="stage-rerun" onClick={() => rerunStale(shot.id)}><RefreshCw size={12} /> re-run stale <Kbd>R</Kbd></button>
          )}
        </div>
        <ul className="stage-panel-ops">
          {shot.ops.filter((op) => op.kind === 'upscale' || op.kind === 'repair').map((op) => (
            <li key={op.id}>
              <label>
                <input
                  type="checkbox"
                  checked={op.enabled}
                  data-stage-op={op.id}
                  onChange={() => { toggleOp(shot.id, op.id); operate() }}
                />
                <span>{op.kind} — {op.summary}</span>
              </label>
            </li>
          ))}
          <li className="stage-panel-op-note"><RefreshCw size={11} /> toggling an op re-runs the take — never a dialog</li>
        </ul>
      </div>
    </aside>
  }

  const transform = stageTransforms[selection.id] ?? { scale: 1, rotate: 0, opacity: 1 }
  if (selection.kind === 'image') {
    return <aside className="stage-panel" data-stage-panel="image" aria-label="Selected image tools">
      <header>
        <strong>Image · Neon alley plate</strong>
        <span>transform — applies live</span>
      </header>
      <label className="stage-panel-field">
        <span>scale <b>{transform.scale.toFixed(2)}×</b></span>
        <input
          type="range" min={0.4} max={2} step={0.02} value={transform.scale} data-stage-slider="scale"
          onChange={(event) => setStageTransform(selection.id, { ...transform, scale: Number(event.target.value) })}
        />
      </label>
      <label className="stage-panel-field">
        <span>rotate <b>{Math.round(transform.rotate)}°</b></span>
        <input
          type="range" min={-180} max={180} step={1} value={transform.rotate} data-stage-slider="rotate"
          onChange={(event) => setStageTransform(selection.id, { ...transform, rotate: Number(event.target.value) })}
        />
      </label>
      <label className="stage-panel-field">
        <span>opacity <b>{Math.round(transform.opacity * 100)}%</b></span>
        <input
          type="range" min={0.2} max={1} step={0.02} value={transform.opacity} data-stage-slider="opacity"
          onChange={(event) => setStageTransform(selection.id, { ...transform, opacity: Number(event.target.value) })}
        />
      </label>
      <p className="stage-panel-note">A different object type, different operations — the panel followed the selection. No mode was switched.</p>
    </aside>
  }

  const volume = transform.scale
  const offset = transform.rotate
  return <aside className="stage-panel" data-stage-panel="audio" aria-label="Selected audio tools">
    <header>
      <strong>Audio · Rains on Glass</strong>
      <span>mix — applies live</span>
    </header>
    <label className="stage-panel-field">
      <span>volume <b>{Math.round(volume * 100)}%</b></span>
      <input
        type="range" min={0} max={1.4} step={0.02} value={volume} data-stage-slider="volume"
        onChange={(event) => setStageTransform(selection.id, { scale: Number(event.target.value), rotate: offset, opacity: 1 })}
      />
    </label>
    <label className="stage-panel-field">
      <span>timeline offset <b>{Math.round(offset)} beats</b></span>
      <input
        type="range" min={-8} max={8} step={1} value={offset} data-stage-slider="offset"
        onChange={(event) => setStageTransform(selection.id, { scale: volume, rotate: Number(event.target.value), opacity: 1 })}
      />
    </label>
    <p className="stage-panel-note">Stems sit on the beat grid — the Score direction shows the same document as a timeline.</p>
  </aside>
}
