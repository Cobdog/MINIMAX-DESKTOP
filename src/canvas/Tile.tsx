/**
 * Canvas Phase 2 — the media tile (§3 tile anatomy).
 *
 * Preview surface (filmstrip poster through the shared media seams, blob
 * artifact via the documents blob route), status ring (idle / queued-for-GPU
 * / running / stale / failed-durable — §4 on-object state), op chips from the
 * chain's op stack, take strip (canonical starred, priors visible, fork
 * action — the Auditions pattern), head/tail endpoint affordances (Phase 2:
 * clickable typed holes). Semantic zoom is content swap BY BAND — the band
 * arrives as a prop, so a band crossing is the only reason this component
 * re-renders.
 */
import { memo } from 'react'
import { Film, GitFork, Lock, Star } from 'lucide-react'
import { FilmstripPoster } from '../components/PooledVideoCard'
import { useFilmstrip } from '../media/useFilmstrip'
import { documentsApi } from './api'
import type { ZoomBand } from './camera'
import { STATUS_LABEL, type Tile } from './derive'

function TilePreview({ tile, previewUrl }: { tile: Tile; previewUrl?: string }) {
  const filmstrip = useFilmstrip(tile.previewPath, tile.duration)
  if (previewUrl) {
    return <img className="canvas-tile-poster" src={previewUrl} alt={tile.title} />
  }
  // The durable blob artifact (content-addressed) renders directly — images
  // as <img>, video takes as a paused <video> (frame 0 poster).
  if (tile.artifactPath && tile.mediaKind === 'image') {
    return <img className="canvas-tile-poster" data-canvas-poster="blob" src={documentsApi.blobFileUrl(tile.artifactPath)} alt={tile.title} />
  }
  if (tile.artifactPath && tile.mediaKind === 'video') {
    return <video className="canvas-tile-poster" data-canvas-poster="blob" src={documentsApi.blobFileUrl(tile.artifactPath)} muted preload="metadata" aria-label={tile.title} />
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

function TileBase({ tile, band, selected, previewUrl, onSelect, onDismissFailure, onEndpoint, onFork }: {
  tile: Tile
  band: ZoomBand
  selected: boolean
  previewUrl?: string
  onSelect(tileId: string, options?: { toggle?: boolean }): void
  onDismissFailure(tileId: string): void
  onEndpoint(chainId: string, direction: 'consume' | 'produce'): void
  onFork(chainId: string): void
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
      onSelect(tile.id, { toggle: event.shiftKey || event.metaKey || event.ctrlKey })
    }}
  >
    {/* head/tail endpoint affordances — the typed holes (§3): click opens the
        direction-filtered option menu. */}
    <button
      type="button"
      className="canvas-tile-endpoint head"
      data-canvas-endpoint="head"
      aria-label={`Input options for ${tile.title}`}
      title="Consume from — what this object takes in"
      onClick={(event) => { event.stopPropagation(); onEndpoint(tile.id, 'consume') }}
    />
    <button
      type="button"
      className="canvas-tile-endpoint tail"
      data-canvas-endpoint="tail"
      aria-label={`Produce options for ${tile.title}`}
      title="Produce into — what this object can become"
      onClick={(event) => { event.stopPropagation(); onEndpoint(tile.id, 'produce') }}
    />

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
      {tile.stale && tile.status !== 'stale' && <span className="canvas-tile-stale-badge" title="Settings changed upstream — rerun when ready">stale</span>}
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
          <small>{tile.canonical?.latentPath ? 'resident' : 'not retained'}</small>
        </div>
        <div className="canvas-tile-takes" aria-label="Takes">
          {tile.canonical
            ? <span className="canvas-take-chip canonical" title="Canonical take"><Star size={10} fill="currentColor" /> {tile.canonical.id.slice(0, 8)}</span>
            : <span className="canvas-take-chip canvas-take-chip-empty">no take yet</span>}
          {tile.priors > 0 && <span className="canvas-take-chip prior" title="Earlier takes — fork from an early take to keep drift low">+{tile.priors} prior{tile.priors > 1 ? 's' : ''}</span>}
          {tile.canonical && (
            <button type="button" className="canvas-take-fork" data-canvas-fork={tile.id} aria-label={`Fork ${tile.title}`} title="Fork from this object (B)" onClick={(event) => { event.stopPropagation(); onFork(tile.id) }}>
              <GitFork size={10} /> fork
            </button>
          )}
        </div>
      </>
    )}
  </div>
}

export const CanvasTile = memo(TileBase)
