/** Direction A — "Shot Bench": the audition-stack workbench.
 *
 *  The FCPX-Auditions pattern as the product's spine: one slot per shot,
 *  takes stacked in it, cycled IN PLACE (the picture never leaves the
 *  monitor). Left: the project outliner (datablocks with reference counts).
 *  Center: the current shot's take family + the param-diff gutter (exactly
 *  what changed between adjacent takes — the A1111 X/Y/Z plot, first-class).
 *  Right: the shot's modifier stack (ordered ops, each togglable; a flip
 *  marks the takes it feeds STALE — deferred commit, never a dialog). The
 *  queue strip is always live at the bottom.
 */
import { useCallback, useRef } from 'react'
import { ChevronDown, ChevronUp, GitBranch, Image as ImageIcon, Music2, Pin, RefreshCw } from 'lucide-react'
import {
  diffTakes, libraryAssets, takesOfShot, useProtoStore,
} from './protoStore'
import { CacheBadge, Kbd, ProtoPlayer, QueueStrip, TakePoster, type ProtoPlayerHandle } from './PrototypeShell'
import { useProtoKeys } from './protoKeys'

export function ShotBench() {
  const shots = useProtoStore((state) => state.shots)
  const takes = useProtoStore((state) => state.takes)
  const queue = useProtoStore((state) => state.queue)
  const selectedShotId = useProtoStore((state) => state.selectedShotId)
  const benchTakeIndex = useProtoStore((state) => state.benchTakeIndex)
  const selectShot = useProtoStore((state) => state.selectShot)
  const cycleTake = useProtoStore((state) => state.cycleTake)
  const setBenchTakeIndex = useProtoStore((state) => state.setBenchTakeIndex)
  const toggleOp = useProtoStore((state) => state.toggleOp)
  const rerunStale = useProtoStore((state) => state.rerunStale)
  const branchTake = useProtoStore((state) => state.branchTake)
  const pinTake = useProtoStore((state) => state.pinTake)
  const playerRef = useRef<ProtoPlayerHandle | null>(null)

  const shot = shots.find((entry) => entry.id === selectedShotId) ?? shots[0]
  const shotTakes = takesOfShot(takes, shot.id)
  const current = shotTakes[Math.min(benchTakeIndex, shotTakes.length - 1)]
  const previous = benchTakeIndex > 0 ? shotTakes[benchTakeIndex - 1] : null
  const diff = previous && current ? diffTakes(previous, current) : []
  const staleCount = shotTakes.filter((entry) => entry.status === 'stale').length

  const branch = useCallback(() => {
    if (!current) return
    branchTake(shot.id, current.id)
    // The branch becomes the slot's newest take — show it immediately.
    setBenchTakeIndex(takesOfShot(useProtoStore.getState().takes, shot.id).length - 1)
  }, [branchTake, current, setBenchTakeIndex, shot.id])

  useProtoKeys(useCallback((event: KeyboardEvent) => {
    if (event.key === 'j') { cycleTake(1); return }
    if (event.key === 'k') { cycleTake(-1); return }
    if (event.key === 'ArrowRight') { playerRef.current?.seekBy(0.5); return }
    if (event.key === 'ArrowLeft') { playerRef.current?.seekBy(-0.5); return }
    if (event.key === 'p' && current) { pinTake(shot.id, current.id); return }
    if (event.key === 'b') { branch(); return }
    if (event.key === 'r') { rerunStale(shot.id); return }
    const digit = Number.parseInt(event.key, 10)
    if (Number.isFinite(digit) && digit >= 1 && digit <= shotTakes.length) setBenchTakeIndex(digit - 1)
  }, [branch, cycleTake, current, pinTake, rerunStale, setBenchTakeIndex, shot.id, shotTakes.length]))

  return <div className="bench">
    {/* LEFT — the project outliner: datablocks with reference counts. */}
    <aside className="bench-outliner" aria-label="Project outliner">
      <header>
        <strong>Neon Rains</strong>
        <span>project · 4 shots · 92 BPM</span>
      </header>
      <div className="bench-outline-shots">
        {shots.map((entry) => {
          const count = takesOfShot(takes, entry.id).length
          const selected = entry.id === shot.id
          return <div key={entry.id} className="bench-outline-shot">
            <button
              type="button"
              className={selected ? 'selected' : ''}
              onClick={() => selectShot(entry.id)}
              aria-current={selected ? 'true' : undefined}
            >
              {selected ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="bench-outline-name">{entry.name}</span>
              <em title={`${count} takes reference this shot`}>{count}×</em>
            </button>
            {selected && (
              <ul className="bench-outline-takes">
                {takesOfShot(takes, entry.id).map((take, index) => (
                  <li key={take.id}>
                    <button
                      type="button"
                      className={index === benchTakeIndex ? 'selected' : ''}
                      onClick={() => setBenchTakeIndex(index)}
                    >
                      <span>{take.label}{take.branchedFrom ? ` ⟵ ${take.branchedFrom}` : ''}</span>
                      {take.pinned && <Pin size={11} className="proto-pin-icon" />}
                      <i data-cache={take.status} title={`cache ${take.status}`} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        })}
      </div>
      <div className="bench-outline-library">
        <span className="bench-outline-label">Library</span>
        {libraryAssets.map((asset) => (
          <div key={asset.id} className="bench-outline-asset">
            <span>{asset.kind === 'image' ? <ImageIcon size={12} /> : <Music2 size={12} />} {asset.name}</span>
            <small>{asset.meta}</small>
          </div>
        ))}
      </div>
    </aside>

    {/* CENTER — the take-family canvas + param-diff gutter. */}
    <section className="bench-center" aria-label="Take family canvas">
      <header className="bench-toolbar">
        <div className="bench-toolbar-title">
          <strong>{shot.name}</strong>
          <span>{shotTakes.length} {shotTakes.length === 1 ? 'take' : 'takes'} in this slot</span>
        </div>
        <div className="bench-toolbar-actions">
          <button type="button" onClick={() => cycleTake(-1)} title="Previous take">
            <ChevronUp size={14} /> prev <Kbd>K</Kbd>
          </button>
          <span className="bench-take-label" data-bench-take={current?.id}>{current?.label}</span>
          <button type="button" onClick={() => cycleTake(1)} title="Next take">
            next <Kbd>J</Kbd> <ChevronDown size={14} />
          </button>
          <CacheBadge status={current?.status ?? 'fresh'} />
          <button type="button" onClick={() => current && pinTake(shot.id, current.id)} title="Pin this take as the pick (best of the family)">
            <Pin size={13} /> {current?.pinned ? 'pinned ★' : 'pin'} <Kbd>P</Kbd>
          </button>
          <button type="button" onClick={branch} title="Branch: duplicate this take as a new one to explore">
            <GitBranch size={13} /> branch <Kbd>B</Kbd>
          </button>
        </div>
      </header>
      <div className="bench-stage">
        <div className="bench-canvas">
          {current && <ProtoPlayer take={current} ariaLabel={`${shot.name} take`} ref={playerRef} />}
          <div className="bench-scrub-note">◀ ▶ <Kbd>←</Kbd><Kbd>→</Kbd> scrub 0.5s</div>
        </div>
        {/* The param-diff gutter — what changed vs the previous take. */}
        <aside className="bench-diff" data-bench-diff aria-label="Param diff versus previous take">
          <header>
            <strong>param diff</strong>
            <span>{current ? (previous ? `${current.label} vs ${previous.label}` : `${current.label} — first take`) : ''}</span>
          </header>
          {previous && current
            ? (diff.length === 0
              ? <p className="bench-diff-empty">identical params — same seed, different curation</p>
              : <ul>
                {diff.map((row) => (
                  <li key={row.field}>
                    <span>{row.field}</span>
                    <b>{row.from} <i aria-hidden>→</i> {row.to}</b>
                  </li>
                ))}
              </ul>)
            : <p className="bench-diff-empty">first take in the family — nothing upstream to compare</p>}
          {current && (
            <dl className="bench-diff-params">
              <div><dt>prompt</dt><dd>{shot.ops.find((op) => op.kind === 'prompt')?.summary}</dd></div>
              <div><dt>seed</dt><dd data-bench-seed>{current.params.seed}</dd></div>
              <div><dt>steps</dt><dd>{current.params.steps}</dd></div>
              <div><dt>turbo</dt><dd>{current.params.turbo === 'off' ? 'off' : `×${current.params.turbo}`}</dd></div>
            </dl>
          )}
        </aside>
      </div>
      {/* The take strip — the audition stack, laid out flat. */}
      <div className="bench-strip" role="listbox" aria-label="Takes in this slot">
        {shotTakes.map((take, index) => (
          <button
            key={take.id}
            type="button"
            role="option"
            aria-selected={index === benchTakeIndex}
            className={`bench-take-chip ${index === benchTakeIndex ? 'selected' : ''} ${take.status !== 'fresh' ? 'is-stale' : ''}`}
            onClick={() => setBenchTakeIndex(index)}
            data-take-chip={take.id}
          >
            <TakePoster take={take} />
            <span className="bench-take-chip-copy">
              <b>{take.label}{take.pinned ? ' ★' : ''}{take.branchedFrom ? ` ⟵${take.branchedFrom}` : ''}</b>
              <CacheBadge status={take.status} />
            </span>
            <Kbd>{index + 1}</Kbd>
          </button>
        ))}
      </div>
    </section>

    {/* RIGHT — the modifier stack (ordered, toggleable ops). */}
    <aside className="bench-stack" aria-label="Shot modifier stack">
      <header>
        <strong>Modifier stack</strong>
        <span>ordered · re-runs downstream takes</span>
      </header>
      <ol>
        {shot.ops.map((op, index) => (
          <li key={op.id} className={op.enabled ? 'enabled' : ''}>
            <span className="bench-stack-order">{index + 1}</span>
            <div className="bench-stack-copy">
              <strong>{op.kind === 'seed' ? 'seed / LoRA' : op.kind}</strong>
              <small>{op.summary}</small>
            </div>
            <label className="bench-stack-toggle" title="Toggle this op — affected takes go stale until re-run">
              <input
                type="checkbox"
                checked={op.enabled}
                data-op-toggle={`${shot.id}:${op.id}`}
                onChange={() => toggleOp(shot.id, op.id)}
              />
              <span aria-hidden>{op.enabled ? 'on' : 'off'}</span>
            </label>
            <em className="bench-stack-reruns" title="Takes this op feeds">{shotTakes.length} re-runs</em>
          </li>
        ))}
      </ol>
      <div className={`bench-stack-stale ${staleCount > 0 ? 'active' : ''}`}>
        {staleCount > 0
          ? <><span><b>{staleCount} take{staleCount > 1 ? 's' : ''} stale</b> — params changed underneath them</span>
            <button type="button" onClick={() => rerunStale(shot.id)}><RefreshCw size={13} /> re-run <Kbd>R</Kbd></button></>
          : <span>all takes fresh — flip an op above to see deferred commit</span>}
      </div>
      <p className="bench-stack-note">Flipping a toggle never blocks: takes are marked stale and re-run on your word — no dialogs anywhere.</p>
    </aside>

    {/* BOTTOM — the always-live queue. */}
    <div className="bench-queue" data-queue-count={queue.length}>
      <QueueStrip />
    </div>
  </div>
}

function ChevronRight({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
}
