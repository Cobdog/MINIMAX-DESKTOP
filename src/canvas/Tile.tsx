/**
 * Canvas Phase 1 — the media tile (§3 tile anatomy).
 *
 * Preview surface (filmstrip poster through the shared media seams), status
 * ring (idle / queued-for-GPU / running / stale / failed-durable — §4
 * on-object state), op chips from the chain's op stack, take strip (canonical
 * starred, priors visible), head/tail endpoint affordances. Semantic zoom is
 * content swap BY BAND (far: thumbnail+ring; mid: +metadata+ops; near:
 * +latent block+take strip) — the band arrives as a prop, so a band crossing
 * is the only reason this component re-renders.
 *
 * Phase-1 boundary: endpoints are VISUAL (menus are Phase 2's typed holes);
 * the latent block is an honest placeholder (L9 zoom-gated, content Phase 2+).
 */
import { memo } from 'react'
import { Film, Lock, Star } from 'lucide-react'
import { FilmstripPoster } from '../components/PooledVideoCard'
import { useFilmstrip } from '../media/useFilmstrip'
import type { ZoomBand } from './camera'
import { STATUS_LABEL, type Tile } from './derive'

function TilePreview({ tile, previewUrl }: { tile: Tile; previewUrl?: string }) {
  const filmstrip = useFilmstrip(tile.previewPath, tile.duration)
  if (previewUrl) {
    return <img className="canvas-tile-poster" src={previewUrl} alt={tile.title} />
  }
  if (tile.kind === 'seed' && !tile.previewPath) {
    return <div className="canvas-tile-poster canvas-tile-poster-seed" aria-label="seed">
      <Film size={20} />
      <p>{tile.prompt || tile.title}</p>
    </div>
  }
  return <FilmstripPoster filmstrip={filmstrip} mode="frame" label={`${tile.title} poster`}>
    <div className="canvas-tile-poster canvas-tile-poster-empty"><Film size={18} /><span>no preview yet</span></div>
  </FilmstripPoster>
}

function TileBase({ tile, band, selected, previewUrl, onSelect, onDismissFailure }: {
  tile: Tile
  band: ZoomBand
  selected: boolean
  previewUrl?: string
  onSelect(tileId: string): void
  onDismissFailure(tileId: string): void
}) {
  return <div
    className={`canvas-tile ${selected ? 'selected' : ''}`}
    data-canvas-tile={tile.id}
    data-tile-kind={tile.kind}
    data-tile-status={tile.status}
    data-tile-band={band}
    style={{ left: tile.x, top: tile.y, width: tile.w, minHeight: tile.h }}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation()
      onSelect(tile.id)
    }}
  >
    {/* head/tail endpoint affordances — visual only; typed menus land Phase 2 */}
    <span className="canvas-tile-endpoint head" data-canvas-endpoint="head" title="Input options — wired in Phase 2" aria-hidden />
    <span className="canvas-tile-endpoint tail" data-canvas-endpoint="tail" title="Extend / produce options — wired in Phase 2" aria-hidden />

    <div className="canvas-tile-media">
      <TilePreview tile={tile} previewUrl={previewUrl} />
      {/* the status ring — on-object state, always visible in every band */}
      <span className="canvas-tile-ring" data-status={tile.status} aria-label={STATUS_LABEL[tile.status]} />
      {tile.status === 'running' && <span className="canvas-tile-progress" aria-hidden />}
      {tile.status === 'failed' && (
        // Contract a: durable on the object until dismissed, reason attached.
        <div className="canvas-tile-failure" role="alert">
          <p>{tile.statusNote ?? 'generation failed'}</p>
          <button type="button" onClick={() => onDismissFailure(tile.id)}>dismiss</button>
        </div>
      )}
      {tile.lockState === 'locked' && <span className="canvas-tile-lock" title="Chain locked — propagation gated"><Lock size={11} /></span>}
    </div>

    {band !== 'far' && (
      <header className="canvas-tile-header">
        <strong>{tile.title}</strong>
        <span className="canvas-tile-meta">
          {tile.kind}
          {tile.duration > 0 ? ` · ${tile.duration.toFixed(1)}s` : ''}
          {tile.substrates.length ? ` · ${tile.substrates.join('+')}` : ''}
        </span>
      </header>
    )}

    {band !== 'far' && (
      <div className="canvas-tile-ops" aria-label="Op stack">
        {tile.ops.map((op) => <span key={op.id} className="canvas-op-chip" data-op-kind={op.kind}>{op.kind}</span>)}
        {!tile.ops.length && <span className="canvas-op-chip canvas-op-chip-empty">no ops</span>}
      </div>
    )}

    {band === 'near' && (
      <>
        <div className="canvas-tile-latent" data-canvas-latent aria-label="Latent blocks (zoom-gated, L9)">
          <span>latents</span>
          <small>{tile.canonical?.latentPath ? 'resident' : 'placeholder — Phase 2'}</small>
        </div>
        <div className="canvas-tile-takes" aria-label="Takes">
          {tile.canonical
            ? <span className="canvas-take-chip canonical" title="Canonical take"><Star size={10} fill="currentColor" /> {tile.canonical.id.slice(0, 8)}</span>
            : <span className="canvas-take-chip canvas-take-chip-empty">no take yet</span>}
          {tile.priors > 0 && <span className="canvas-take-chip prior">+{tile.priors} prior{tile.priors > 1 ? 's' : ''}</span>}
        </div>
      </>
    )}
  </div>
}

export const CanvasTile = memo(TileBase)
