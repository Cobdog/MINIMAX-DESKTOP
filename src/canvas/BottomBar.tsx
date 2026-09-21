/**
 * Canvas Phase 3 — the contextual bottom bar (§4: 100% contextual —
 * contexts, not modes).
 *
 *   nothing selected → the generation surface (mode readout from the
 *     selection roles + prompt entry + honest engine state);
 *   media selected   → transport + op entry (the modal, L8: modal-only v1)
 *     + properties;
 *   chain selected   → identity payload + drift readout + takes + fork
 *     history + lock (P) + per-chain rerun;
 *   multi-select     → batch gestures (multi-generate to queue selections,
 *     multi-lock; Phase 3 lands the ops the Phase-2 stub promised).
 */
import { useState } from 'react'
import { ChevronUp, CircleDot, GitFork, Layers, Lock, LockOpen, Pause, Play, Plus } from 'lucide-react'
import { collectOutputRefs, STATUS_LABEL } from './derive'
import { effectiveMode, MODE_LABEL, readChainSettings } from './generation'
import { opKindsFor } from './ops'
import { useCanvasStore } from './store'

export function BottomBar() {
  const selection = useCanvasStore((state) => state.selection)
  const tiles = useCanvasStore((state) => state.tiles)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const engine = useCanvasStore((state) => state.engine)
  const select = useCanvasStore((state) => state.select)
  const submitPrompt = useCanvasStore((state) => state.submitPrompt)
  const setForkMenu = useCanvasStore((state) => state.setForkMenu)
  const requestCamera = useCanvasStore((state) => state.requestCamera)
  const toast = useCanvasStore((state) => state.toast)
  const [prompt, setPrompt] = useState('')
  const [opMenuOpen, setOpMenuOpen] = useState(false)

  const doc = activeProjectId ? documents[activeProjectId] : null
  const selectedTiles = selection.tileIds.map((id) => tiles.find((tile) => tile.id === id)).filter(Boolean)
  const primary = selectedTiles.length === 1 ? selectedTiles[0]! : null
  const primaryChain = primary && doc ? doc.chains.find((chain) => chain.id === primary.id) ?? null : null
  const context: 'empty' | 'media' | 'chain' | 'multi' = selectedTiles.length === 0 ? 'empty' : selectedTiles.length === 1 ? (primary?.kind === 'media' && primary.canonical ? 'media' : 'chain') : 'multi'

  const submit = async () => {
    const text = prompt.trim()
    if (!text) return
    setPrompt('')
    await submitPrompt(text, 'video')
  }

  // Transport (media context): the tile's own preview element is the player —
  // playing is temporary tile state (L1's lean), the bar toggles it.
  const toggleTransport = () => {
    const element = globalThis.document.querySelector<HTMLVideoElement>(`[data-canvas-tile="${primary?.id}"] video`)
    if (!element) {
      toast('neutral', 'This object has no playable surface yet.')
      return
    }
    if (element.paused) void element.play()
    else element.pause()
  }

  // Op entry (media context): the modal is the ONLY editor (L8) — the menu
  // adds the first op and opens the editor on it.
  const addOp = async (kind: string) => {
    setOpMenuOpen(false)
    if (!primary) return
    const store = useCanvasStore.getState()
    const id = await store.addStackOp(primary.id, kind as never)
    if (id) store.setOpEditor({ chainId: primary.id })
  }

  // Batch gestures (multi context): queue every selected chain, or lock them
  // all (P for one, the gesture for many).
  const multiGenerate = async () => {
    const store = useCanvasStore.getState()
    let queued = 0
    for (const tile of selectedTiles) {
      const result = await store.submitChain(tile!.id)
      if (result.ok) queued += 1
    }
    toast(queued ? 'success' : 'error', queued
      ? `${queued} of ${selectedTiles.length} selection${selectedTiles.length === 1 ? '' : 's'} queued — L26: generations serialize by default.`
      : 'Nothing queued — the engine refused every selection (the reasons are on the objects).')
  }

  const multiLock = async () => {
    const store = useCanvasStore.getState()
    const lock = !selectedTiles.every((tile) => tile!.lockState === 'locked')
    for (const tile of selectedTiles) await store.setChainLock(tile!.id, lock)
  }

  // Fork history: parents = chains whose outputs this chain consumes; forks =
  // chains consuming this chain's outputs (both via the §2.1 outputRef walk).
  const forkHistory = (() => {
    if (!primary || !doc) return { parents: [] as string[], forks: [] as string[] }
    const owned = new Set((primaryChain?.outputs ?? []).map((output) => output.id))
    const parents = doc.chains.filter((chain) => chain.id !== primary.id && chain.outputs.some((output) => primary.refOutputs.includes(output.id))).map((chain) => chain.id)
    const forks: string[] = []
    for (const chain of doc.chains) {
      if (chain.id === primary.id) continue
      const refs = new Set<string>()
      collectOutputRefs(chain.inputSpec, refs)
      if ([...refs].some((outputId) => owned.has(outputId))) forks.push(chain.id)
    }
    return { parents, forks }
  })()

  // Type-directed op offering (§3): the same kind list the modal's add menu
  // derives for the tile's media kind.
  const offeredOpKinds = primary ? opKindsFor(primary.mediaKind) : []

  return <footer className="canvas-bottombar" data-canvas-bottombar data-canvas-bar-context={context}>
    {context === 'empty' && (
      <>
        <span className="canvas-bar-title">generate</span>
        <input
          className="canvas-bar-prompt"
          data-canvas-bar-prompt
          value={prompt}
          placeholder="Describe a shot — Enter spawns it at the bar"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }}
        />
        {/* §5.4 (Phase 4): the audio engines as typed-hole selections from the
            nothing-selected context (the launcher carries the same rows). */}
        <button type="button" className="canvas-chip" data-canvas-bar-music3 onClick={() => useCanvasStore.getState().setAudioDock({ engine: 'music3' })}>Music 3</button>
        <button type="button" className="canvas-chip" data-canvas-bar-acestep onClick={() => useCanvasStore.getState().setAudioDock({ engine: 'acestep' })}>ACE-Step</button>
        <button type="button" className="canvas-chip" data-canvas-bar-library title="The library projection (V)" onClick={() => useCanvasStore.getState().setLibraryOpen(true)}>library <kbd>V</kbd></button>
        <button
          type="button"
          className={`canvas-bar-engine ${engine.connected ? (engine.modelReady ? 'online' : 'degraded') : ''}`}
          data-canvas-bar-engine
          title={engine.connected ? (engine.modelReady ? 'Local engine connected — MiniMax H3 ready' : 'Engine connected but H3 model components are missing') : 'Engine offline — click to open Settings at the engine section'}
          onClick={() => useCanvasStore.getState().setSettingsDock(true)}
        >
          <span className="status-dot" /> {engine.connected ? (engine.modelReady ? 'H3 ready' : 'models missing') : 'engine offline'}
        </button>
      </>
    )}

    {context === 'chain' && primary && (
      <>
        <span className="canvas-bar-title" title={primary.prompt}>{primary.title}</span>
        <span className="canvas-bar-mode" data-canvas-bar-mode>{MODE_LABEL[effectiveMode(readChainSettings(primaryChain?.settings ?? {}))]}</span>
        <span className="canvas-bar-state"><span className="canvas-tile-ring" data-status={primary.status} /> {STATUS_LABEL[primary.status]}</span>
        <span className="canvas-bar-identity" data-canvas-bar-identity>
          <CircleDot size={11} />
          {primary.identity?.subjectText ? `identity “${primary.identity.subjectText.slice(0, 24)}” · ${primary.identity.strength.toFixed(2)}` : 'no identity payload'}
        </span>
        <span className="canvas-bar-drift" data-canvas-bar-drift title="Hop count + per-hop drift metrics (L28)">
          drift · {primary.hopCount} hop{primary.hopCount === 1 ? '' : 's'}
          {primary.driftMetrics ? ` · ${Object.entries(primary.driftMetrics).map(([key, value]) => `${key} ${String(value)}`).join(' ')}` : ''}
        </span>
        <span className="canvas-bar-takes" data-canvas-bar-takes>{primary.canonical ? `take ${primary.canonical.id.slice(0, 8)}` : 'no takes'}{primary.priors ? ` +${primary.priors}` : ''}</span>
        <span className="canvas-bar-fork-history" data-canvas-bar-fork-history>
          {forkHistory.parents.length ? `${forkHistory.parents.length} source${forkHistory.parents.length === 1 ? '' : 's'} ↑` : ''}
          {forkHistory.parents.length && forkHistory.forks.length ? ' · ' : ''}
          {forkHistory.forks.length ? `${forkHistory.forks.length} fork${forkHistory.forks.length === 1 ? '' : 's'} ↓` : ''}
          {!forkHistory.parents.length && !forkHistory.forks.length ? 'no forks yet' : ''}
        </span>
        <button
          type="button"
          className="canvas-chip"
          data-canvas-bar-lock={primary.lockState}
          title={primary.lockState === 'locked' ? 'Unlock — upstream changes mark this chain stale again' : 'Lock — propagation is gated; every take stays resident'}
          onClick={() => void useCanvasStore.getState().setChainLock(primary.id, primary.lockState !== 'locked')}
        >
          {primary.lockState === 'locked' ? <Lock size={11} /> : <LockOpen size={11} />} {primary.lockState === 'locked' ? 'locked' : 'unlocked'} <kbd>P</kbd>
        </button>
        <button type="button" className="canvas-chip" data-canvas-bar-fork disabled={!primary.canonical} onClick={() => setForkMenu({ chainId: primary.id })}><GitFork size={11} /> fork <kbd>B</kbd></button>
        {primary.stale && <button type="button" className="canvas-chip" data-canvas-bar-rerun title="Rerun this chain — one gesture (principle 5)" onClick={() => void useCanvasStore.getState().rerunChain(primary.id)}>rerun <kbd>R</kbd></button>}
      </>
    )}

    {context === 'media' && primary && (
      <>
        <span className="canvas-bar-title">{primary.title}</span>
        <button type="button" className="canvas-chip" data-canvas-bar-transport onClick={toggleTransport} disabled={primary.mediaKind !== 'video'}><Play size={11} /> / <Pause size={11} /> play</button>
        <div className="canvas-bar-opmenu">
          <button type="button" className="canvas-chip" data-canvas-bar-ops onClick={() => setOpMenuOpen((value) => !value)}><Plus size={11} /> op <ChevronUp size={10} /></button>
          {opMenuOpen && (
            <div className="canvas-bar-opmenu-pop" data-canvas-bar-opmenu role="menu">
              {offeredOpKinds.map((kind) => (
                <button type="button" key={kind} role="menuitem" data-canvas-bar-op={kind} onClick={() => void addOp(kind)}>{kind}</button>
              ))}
              <span className="canvas-bar-opmenu-note">Non-destructive stack · per-op undo + reorder + bake in the editor.</span>
            </div>
          )}
        </div>
        <button type="button" className="canvas-chip" data-canvas-bar-opedit onClick={() => useCanvasStore.getState().setOpEditor({ chainId: primary.id })}>ops <kbd>↵</kbd></button>
        <button type="button" className="canvas-chip" data-canvas-bar-properties onClick={() => useCanvasStore.getState().setInspectorOpen(true)}>properties</button>
        <button type="button" className="canvas-chip" data-canvas-bar-fork onClick={() => setForkMenu({ chainId: primary.id })}><GitFork size={11} /> fork</button>
      </>
    )}

    {context === 'multi' && (
      <>
        <span className="canvas-bar-title"><Layers size={12} /> {selectedTiles.length} objects</span>
        {selectedTiles.slice(0, 4).map((tile) => (
          <button type="button" key={tile!.id} className="canvas-bar-chip-tile" data-canvas-bar-multitile={tile!.id} onClick={() => { select(tile!.id); requestCamera({ kind: 'fly', tileId: tile!.id }) }}>{tile!.title}</button>
        ))}
        <button type="button" className="canvas-chip" data-canvas-bar-generate-all onClick={() => void multiGenerate()}>
          <Play size={11} /> generate all
        </button>
        <button type="button" className="canvas-chip" data-canvas-bar-lock-all onClick={() => void multiLock()}>
          {selectedTiles.every((tile) => tile!.lockState === 'locked') ? <LockOpen size={11} /> : <Lock size={11} />}
          {selectedTiles.every((tile) => tile!.lockState === 'locked') ? 'unlock all' : 'lock all'}
        </button>
        <button type="button" className="canvas-chip" onClick={() => select(null)}>clear</button>
      </>
    )}
  </footer>
}
