/**
 * Canvas Phase 2 — the fork gesture menu (§2 fork substrates, L28 drift
 * guidance).
 *
 * Offers the substrates the selected take can actually fork on (decoded /
 * extracted frame / latents on disk — availability-honest) AND the
 * fork-from-early-take preference: an earlier take has hopped fewer windows,
 * so drifting identities should re-anchor there (the drift guidance
 * surfaced as a first-class choice, not a footnote).
 */
import { useCanvasStore } from './store'
import { SUBSTRATE_LABEL, substratesForTake, type ForkSubstrate } from './generation'
import type { MediaFile } from '../types'

export function ForkMenu() {
  const menu = useCanvasStore((state) => state.forkMenu)
  const tiles = useCanvasStore((state) => state.tiles)
  const setForkMenu = useCanvasStore((state) => state.setForkMenu)
  const fork = useCanvasStore((state) => state.fork)
  if (!menu) return null

  const tile = tiles.find((entry) => entry.id === menu.chainId)
  if (!tile || !tile.canonical) return null
  const substrates = substratesForTake(tile.canonical, tile.mediaKind as MediaFile['kind'] | null)
  // Earlier takes = priors, oldest-first. Forking one records the pinned
  // takeId — the pre-drift anchor.
  const earlier = [...tile.takes].filter((take) => take.id !== tile.canonical!.id).sort((a, b) => a.createdAt - b.createdAt)
  // The output id is the chain's first output (one output per chain in v1).
  const chainOutputId = (() => {
    const state = useCanvasStore.getState()
    const doc = state.activeProjectId ? state.documents[state.activeProjectId] : null
    return doc?.chains.find((chain) => chain.id === tile.id)?.outputs[0]?.id ?? null
  })()

  return <div className="canvas-menu-backdrop" onClick={() => setForkMenu(null)}>
    <div
      className="canvas-endpoint-menu canvas-fork-menu"
      data-canvas-fork-menu
      role="dialog"
      aria-label="Fork"
      style={{ left: Math.min(Math.max(16, tile.x + tile.w - 60), window.innerWidth - 300), top: Math.max(64, tile.y + 48) }}
      onClick={(event) => event.stopPropagation()}
    >
      <header>
        <strong>Fork “{tile.title}”</strong>
        <span>the source is never altered</span>
      </header>
      <div className="canvas-menu-group" data-canvas-menu-group="substrate">
        <span className="canvas-menu-group-label">substrate</span>
        {(substrates as ForkSubstrate[]).map((substrate) => (
          <button
            type="button"
            key={substrate}
            className="canvas-menu-row"
            data-canvas-fork-substrate={substrate}
            onClick={() => chainOutputId && void fork({ chainId: tile.id, outputId: chainOutputId, substrate })}
          >
            <span className="canvas-menu-row-label">{SUBSTRATE_LABEL[substrate]}</span>
            <span className="canvas-menu-row-note">
              {substrate === 'decoded' ? 'A new chain consuming this take’s artifact.' : substrate === 'extracted-frame' ? 'Extract frame 0 server-side; continue from the still.' : 'Motion-Context continuation — the saved clip pins never-denoised conditioning, no re-encode.'}
            </span>
          </button>
        ))}
        {/* Upscale dual-mode (§5.1): the FORK side. The stack side is the
            upscale op in the op modal — one capability, two placements. */}
        <button
          type="button"
          className="canvas-menu-row"
          data-canvas-fork-upscale
          onClick={() => chainOutputId && void fork({ chainId: tile.id, outputId: chainOutputId, substrate: 'decoded', withUpscale: true })}
        >
          <span className="canvas-menu-row-label">Fork — upscaled</span>
          <span className="canvas-menu-row-note">A new chain with the LTX 2× engine upscale preset (switchable in its properties).</span>
        </button>
      </div>
      {earlier.length > 0 && (
        <div className="canvas-menu-group" data-canvas-menu-group="early-take">
          <span className="canvas-menu-group-label">fork from an earlier take — lower drift</span>
          {earlier.slice(0, 4).map((take, index) => (
            <button
              type="button"
              key={take.id}
              className="canvas-menu-row"
              data-canvas-fork-take={take.id}
              title="Fewer hops from the anchor — re-anchoring a drifting identity forks better from an early take (L28)."
              onClick={() => chainOutputId && void fork({ chainId: tile.id, outputId: chainOutputId, takeId: take.id, substrate: 'decoded' })}
            >
              <span className="canvas-menu-row-label">take {earlier.length - index} · {take.id.slice(0, 8)}</span>
              <span className="canvas-menu-row-note">{new Date(take.createdAt).toLocaleTimeString()} — pre-drift anchor</span>
            </button>
          ))}
        </div>
      )}
      <footer>Esc closes · B reopens from any selection</footer>
    </div>
  </div>
}
