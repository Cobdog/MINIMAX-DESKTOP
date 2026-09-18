/**
 * Canvas Phase 3 — the media tile (§3 tile anatomy).
 *
 * Preview surface (filmstrip poster through the shared media seams, blob
 * artifact via the documents blob route) with the op stack composed LIVE
 * onto it (L3 decided: live-update — opPreviewStyle applies the same
 * filter/transform/focal composition the modal shows), status ring (idle /
 * queued-for-GPU / running / stale / failed-durable — §4 on-object state),
 * op chips from the chain's op stack (Phase 3: a chip click opens the modal
 * editor — L8 decided: modal-only v1, no inline chip controls), take strip
 * (canonical starred; Phase 3: clicking a prior take switches the canonical
 * pointer — F5/takes; fork action — the Auditions pattern), head/tail
 * endpoint affordances (clickable typed holes). Semantic zoom is content
 * swap BY BAND — the band arrives as a prop, so a band crossing is the only
 * reason this component re-renders (op edits re-derive the tile too, which
 * is the live-update contract).
 */
import { memo, useEffect, useRef } from 'react'
import { Database, Film, GitFork, Lock, Star } from 'lucide-react'
import { FilmstripPoster } from '../components/PooledVideoCard'
import { useFilmstrip } from '../media/useFilmstrip'
import type { PreviewMime } from '../types'
import { onPreviewFrame } from '../lib/useRealtime'
import { useJobsStore } from '../state/jobsStore'
import { documentsApi } from './api'
import { opPreviewStyle } from './ops'
import type { ZoomBand } from './camera'
import { STATUS_LABEL, type Tile } from './derive'
import { useCanvasStore } from './store'

/** Canvas bridge, direction 1 (dataset-manager spec §11): send this object's
 *  canonical take to the dataset manager as a referenced source. Explicit,
 *  consent-shaped (confirm), and the file stays where it is. */
function sendToDatasets(tile: Tile) {
  if (!tile.artifactPath) return
  const store = useCanvasStore.getState()
  if (!window.confirm(`Send "${tile.title}" to the dataset manager as a training source?\n\nThe file stays where it is — the dataset manager references it by content hash.`)) return
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  void fetch('/api/lan/datasets/ingest/canvas', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-minimax-token': token },
    body: JSON.stringify({ path: tile.artifactPath }),
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error ?? `ingest failed (${response.status})`)
    store.toast(body.deduped ? 'neutral' : 'success', body.deduped ? 'Already in the dataset library (same content hash).' : `Sent to the dataset manager: ${body.source?.probe?.width ?? '?'}×${body.source?.probe?.height ?? '?'} — open ?datasets=1`)
  }).catch((error: unknown) => {
    store.toast('error', `Dataset send failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function TilePreview({ tile, previewUrl }: { tile: Tile; previewUrl?: string }) {
  const filmstrip = useFilmstrip(tile.previewPath, tile.duration)
  // L3 (decided): the tile preview LIVE-UPDATES as ops change — the stack's
  // visual proxy composes right here (the modal shows the same composition).
  const opStyle = opPreviewStyle(tile.ops)
  const liveStyle = {
    filter: opStyle.filter !== 'none' ? opStyle.filter : undefined,
    transform: opStyle.transform !== 'none' ? opStyle.transform : undefined,
    objectPosition: opStyle.objectPosition !== '50% 50%' ? opStyle.objectPosition : undefined,
    objectFit: opStyle.objectFit !== 'cover' ? opStyle.objectFit : undefined,
  } as const
  if (previewUrl) {
    return <img className="canvas-tile-poster" src={previewUrl} alt={tile.title} style={liveStyle} />
  }
  // The durable blob artifact (content-addressed) renders directly — images
  // as <img>, video takes as a paused <video> (frame 0 poster).
  if (tile.artifactPath && tile.mediaKind === 'image') {
    return <img className="canvas-tile-poster" data-canvas-poster="blob" src={documentsApi.blobFileUrl(tile.artifactPath)} alt={tile.title} style={liveStyle} />
  }
  if (tile.artifactPath && tile.mediaKind === 'video') {
    return <video className="canvas-tile-poster" data-canvas-poster="blob" src={documentsApi.blobFileUrl(tile.artifactPath)} muted preload="metadata" aria-label={tile.title} style={liveStyle} />
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

/** The live sampler-preview painter (F6): binary frames for one prompt key,
 *  painted straight into an <img> — newest frame per animation frame, bytes
 *  never entering React state and never persisted (frames are transient; the
 *  landed take remains the only durable artifact). rAF coalescing IS the
 *  bound: an off-screen or hidden tab simply stops painting. */
function LiveFrame({ promptKey }: { promptKey: string }) {
  const imageRef = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    let stopped = false
    let raf = 0
    let pending: { bytes: ArrayBuffer; mime: PreviewMime } | null = null
    let url = ''
    const stop = onPreviewFrame(promptKey, (bytes, mime) => {
      if (stopped) return
      // Last-frame-wins: a newer frame replaces any pending one outright.
      pending = { bytes, mime }
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          const next = pending
          pending = null
          if (!next || stopped) return
          const previous = url
          url = URL.createObjectURL(new Blob([next.bytes], { type: next.mime }))
          if (imageRef.current) imageRef.current.src = url
          if (previous) URL.revokeObjectURL(previous)
        })
      }
    })
    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
      stop()
      if (url) URL.revokeObjectURL(url)
    }
  }, [promptKey])
  return <img ref={imageRef} className="canvas-tile-live-frame" data-canvas-live-preview="" alt="" aria-hidden />
}

/** The generating tile's live readout: the linked job's progress percent +
 *  label (job events through the realtime fabric) and the painter above.
 *  Subscribes to the ONE job, so progress ticks re-render this component,
 *  not the tile tree. */
function TileLiveProgress({ jobId }: { jobId: string }) {
  const job = useJobsStore((state) => state.jobs.find((item) => item.id === jobId && (item.status === 'running' || item.status === 'queued')) ?? null)
  if (!job) return null
  return <div className="canvas-tile-live" data-canvas-live={job.status}>
    {job.promptId ? <LiveFrame promptKey={job.promptId} /> : null}
    <div className="canvas-tile-live-readout" data-canvas-live-readout>
      {job.progress > 0 ? <span className="canvas-tile-live-pct">{Math.round(job.progress)}%</span> : null}
      {job.progressLabel ? <span className="canvas-tile-live-label">{job.progressLabel}</span> : null}
    </div>
  </div>
}

function TileBase({ tile, band, selected, previewUrl, onSelect, onDismissFailure, onEndpoint, onFork, onOpenOps, onSwitchTake }: {
  tile: Tile
  band: ZoomBand
  selected: boolean
  previewUrl?: string
  onSelect(tileId: string, options?: { toggle?: boolean }): void
  onDismissFailure(tileId: string): void
  onEndpoint(chainId: string, direction: 'consume' | 'produce'): void
  onFork(chainId: string): void
  onOpenOps(chainId: string): void
  onSwitchTake(chainId: string, takeId: string): void
}) {
  const priorTakes = tile.takes.filter((take) => take.supersededBy !== null)
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
      {/* F6 live progress: percent + label + in-progress sampler frames on
          the generating tile (nothing when the linked job is terminal). */}
      {tile.jobId && (tile.status === 'running' || tile.status === 'queued-gpu') ? <TileLiveProgress jobId={tile.jobId} /> : null}
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
      <div className="canvas-tile-ops" aria-label="Op stack" title="Open the op stack editor (Enter)">
        {tile.ops.map((op) => (
          <span
            key={op.id}
            className={`canvas-op-chip ${op.bakedAt !== null ? 'baked' : ''}`}
            data-op-kind={op.kind}
            data-canvas-op-chip={op.id}
            role="button"
            tabIndex={0}
            onClick={(event) => { event.stopPropagation(); onOpenOps(tile.id) }}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenOps(tile.id) } }}
          >
            {op.kind}{op.bakedAt !== null ? ' ·baked' : ''}
          </span>
        ))}
        {!tile.ops.length && (
          <button type="button" className="canvas-op-chip canvas-op-chip-empty" data-canvas-op-chip-empty onClick={(event) => { event.stopPropagation(); onOpenOps(tile.id) }}>no ops</button>
        )}
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
            ? <span className="canvas-take-chip canonical" title="Canonical take — click a prior to switch the pointer"><Star size={10} fill="currentColor" /> {tile.canonical.id.slice(0, 8)}</span>
            : <span className="canvas-take-chip canvas-take-chip-empty">no take yet</span>}
          {tile.artifactPath && (
            <button
              type="button"
              className="canvas-take-chip prior"
              data-canvas-take-to-datasets
              title="Send this take to the dataset manager (training-set prep) — the file stays in place"
              onClick={(event) => { event.stopPropagation(); sendToDatasets(tile) }}
            >
              <Database size={10} /> ds
            </button>
          )}
          {priorTakes.slice(0, 3).map((take) => (
            <button
              key={take.id}
              type="button"
              className="canvas-take-chip prior"
              data-canvas-take-switch={take.id}
              title="Make this take canonical — nothing is deleted; downstream forks go stale"
              onClick={(event) => { event.stopPropagation(); onSwitchTake(tile.id, take.id) }}
            >
              {take.id.slice(0, 8)}
            </button>
          ))}
          {tile.priors > 3 && <span className="canvas-take-chip prior" title={`${tile.priors - 3} more earlier takes — the properties panel lists them`}>+{tile.priors - 3}</span>}
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
