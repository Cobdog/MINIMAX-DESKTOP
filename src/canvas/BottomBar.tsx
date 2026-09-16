/**
 * Canvas Phase 2 — the contextual bottom bar (§4: 100% contextual —
 * contexts, not modes).
 *
 *   nothing selected → the generation surface (mode readout from the
 *     selection roles + prompt entry + honest engine state);
 *   media selected   → transport + op entry + properties;
 *   chain selected   → identity payload + drift readout + takes + fork
 *     history;
 *   multi-select     → batch gestures (honest stubs — Phase 3 lands the ops).
 */
import { useState } from 'react'
import { ChevronUp, CircleDot, GitFork, Layers, Pause, Play, Plus } from 'lucide-react'
import { collectOutputRefs, STATUS_LABEL } from './derive'
import { effectiveMode, MODE_LABEL, readChainSettings } from './generation'
import { useCanvasStore } from './store'

const OP_KINDS = ['crop', 'mask', 'trim', 'adjust', 'stabilize'] as const

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

  const addOp = async (kind: string) => {
    setOpMenuOpen(false)
    if (!primary) return
    try {
      const { documentsApi } = await import('./api')
      await documentsApi.addOp(primary.id, kind, {})
      useCanvasStore.getState().recompute()
      toast('success', `${kind} op added to the stack — editing lands with Phase 3.`)
    } catch (error) {
      toast('error', `The op could not be added: ${error instanceof Error ? error.message : String(error)}`)
    }
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
        <span className={`canvas-bar-engine ${engine.connected ? (engine.modelReady ? 'online' : 'degraded') : ''}`} data-canvas-bar-engine>
          <span className="status-dot" /> {engine.connected ? (engine.modelReady ? 'H3 ready' : 'models missing') : 'engine offline'}
        </span>
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
        <button type="button" className="canvas-chip" data-canvas-bar-fork disabled={!primary.canonical} onClick={() => setForkMenu({ chainId: primary.id })}><GitFork size={11} /> fork <kbd>B</kbd></button>
        {primary.stale && <button type="button" className="canvas-chip" data-canvas-bar-rerun onClick={() => void useCanvasStore.getState().rerunStale()}>rerun <kbd>R</kbd></button>}
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
              {OP_KINDS.map((kind) => (
                <button type="button" key={kind} role="menuitem" data-canvas-bar-op={kind} onClick={() => void addOp(kind)}>{kind}</button>
              ))}
              <span className="canvas-bar-opmenu-note">Non-destructive stack; per-op undo + bake land in Phase 3.</span>
            </div>
          )}
        </div>
        <button type="button" className="canvas-chip" data-canvas-bar-properties onClick={() => useCanvasStore.getState().setInspectorOpen(true)}>properties <kbd>↵</kbd></button>
        <button type="button" className="canvas-chip" data-canvas-bar-fork onClick={() => setForkMenu({ chainId: primary.id })}><GitFork size={11} /> fork</button>
      </>
    )}

    {context === 'multi' && (
      <>
        <span className="canvas-bar-title"><Layers size={12} /> {selectedTiles.length} objects</span>
        {selectedTiles.slice(0, 4).map((tile) => (
          <button type="button" key={tile!.id} className="canvas-bar-chip-tile" data-canvas-bar-multitile={tile!.id} onClick={() => { select(tile!.id); requestCamera({ kind: 'fly', tileId: tile!.id }) }}>{tile!.title}</button>
        ))}
        <span className="canvas-bar-stub" data-canvas-bar-batch title="Batch gestures (rerun all, fork all, group) land with Phase 3 ops">
          batch gestures — Phase 3
        </span>
        <button type="button" className="canvas-chip" onClick={() => select(null)}>clear</button>
      </>
    )}
  </footer>
}
