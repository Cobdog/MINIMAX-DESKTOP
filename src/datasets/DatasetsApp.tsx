/**
 * Dataset manager — the workbench surface (spec §11): own route ?datasets=1
 * (the poserig lazy-chunk precedent; decided at build 2026-09-17 — the crop
 * editor needs viewport-scale wheel semantics scoped inside it). Gallery of
 * masters with visible children, FTS search + filters + hover-scrub, cluster
 * grouping/numbering, inspector with bucket badges, dashboard, export
 * wizard, trash. The canvas bridge lives here too (send take → source; pin
 * layer → canvas reference) — both explicit user actions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Database, Download, FolderOpen, Layers, LoaderCircle, Pin, Plus, RefreshCw, Search, Sparkles, Trash2, Upload, Video } from 'lucide-react'
import { datasetsApi, mediaUrlFor, type AspectEntry, type DashboardPayload, type DatasetSettings, type ExportResultPayload, type LibraryLayer, type LibrarySource } from './api'
import { CropEditor } from './CropEditor'
import { CaptionPanel } from './CaptionPanel'
import './datasets.css'

type Tab = 'library' | 'dashboard' | 'export' | 'trash'

const CARD_HEIGHT = 168
const CARD_WIDTH = 216

function floorBadge(source: LibrarySource): string {
  if (source.floor.verdict === 'refuse') return 'refused at import'
  if (source.floor.verdict === 'warn') return 'below practical floor'
  return ''
}

export function DatasetsApp() {
  const [tab, setTab] = useState<Tab>('library')
  const [library, setLibrary] = useState<{ sources: LibrarySource[]; trashed: { sources: Array<{ id: string; name: string; ingestPath: string; layers: number }> } } | null>(null)
  const [aspects, setAspects] = useState<AspectEntry[]>([])
  const [settings, setSettings] = useState<DatasetSettings | null>(null)
  const [rifeAvailable, setRifeAvailable] = useState(false)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | 'video' | 'image'>('all')
  const [captionFilter, setCaptionFilter] = useState<'all' | 'missing' | 'stale'>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ source: LibrarySource; layer: LibraryLayer | null } | null>(null)
  const [captioning, setCaptioning] = useState<LibraryLayer | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dedupState, setDedupState] = useState<string | null>(null)
  const [clipConsent, setClipConsent] = useState<{ consented: boolean; model: string; note: string } | null>(null)
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null)
  const [exportResult, setExportResult] = useState<ExportResultPayload | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const galleryRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [payload, bootstrap] = await Promise.all([datasetsApi.library(), datasetsApi.bootstrap()])
      setLibrary(payload)
      setAspects(bootstrap.aspects)
      setSettings(bootstrap.settings)
      setRifeAvailable(bootstrap.rifeAvailable)
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Health check on library open (spec §2.1) — MISSING/CHANGED never silent.
    void datasetsApi.health().then((result) => {
      if (result.missing || result.changed) setNotice(`Health: ${result.missing} source(s) MISSING, ${result.changed} CHANGED — see the inspector.`)
    }).catch(() => undefined)
  }, [refresh])

  // Poll pending decode probes until they land (the async §2.2 probe).
  useEffect(() => {
    const pending = library?.sources.some((source) => source.probeState === 'pending' || source.probeState === 'probing')
    if (!pending) return
    const timer = window.setTimeout(() => void refresh(), 1500)
    return () => window.clearTimeout(timer)
  }, [library, refresh])

  const searchHits = useMemo(() => {
    if (!query.trim() || !library) return null
    const hitLayers = new Set<string>()
    const hitSources = new Set<string>()
    void datasetsApi.search(query).then((hits) => {
      for (const hit of hits) {
        hitSources.add(hit.sourceId)
        if (hit.layerId) hitLayers.add(hit.layerId)
      }
    }).catch(() => undefined)
    return { hitLayers, hitSources }
  }, [query, library])

  const visibleSources = useMemo(() => {
    if (!library) return []
    return library.sources.filter((source) => {
      if (kindFilter !== 'all' && source.kind !== kindFilter) return false
      if (captionFilter !== 'all') {
        const layers = source.layers
        if (captionFilter === 'missing' && layers.some((layer) => !layer.caption?.text?.trim())) return true
        if (captionFilter === 'stale' && layers.some((layer) => layer.caption?.stale)) return true
        if (captionFilter === 'missing' || captionFilter === 'stale') return false
      }
      if (searchHits) {
        if (searchHits.hitSources.has(source.id)) return true
        return source.layers.some((layer) => searchHits.hitLayers.has(layer.id))
      }
      return true
    })
  }, [library, kindFilter, captionFilter, searchHits])

  // Virtualization: render only the cards intersecting the scroll viewport
  // (the 1000-item scale gate, spec AC 12.10). Row of N cards per line.
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(900)
  useEffect(() => {
    const node = galleryRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight))
    observer.observe(node)
    setViewportHeight(node.clientHeight)
    return () => observer.disconnect()
  }, [library])
  const columns = Math.max(1, Math.floor((galleryRef.current?.clientWidth ?? 1200) / CARD_WIDTH))
  const totalRows = Math.ceil(visibleSources.length / columns)
  const firstRow = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - 2)
  const lastRow = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / CARD_HEIGHT) + 2)
  const visibleSlice = visibleSources.slice(firstRow * columns, lastRow * columns)

  const toggleSelect = (layerId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(layerId)) next.delete(layerId)
      else next.add(layerId)
      return next
    })
  }

  const ingestFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setError(null)
    let ingested = 0
    let deduped = 0
    const refusals: string[] = []
    for (const file of Array.from(files).slice(0, 200)) {
      try {
        const dataBase64 = await file.arrayBuffer().then((buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))))
        const result = await datasetsApi.ingestUpload(file.name, dataBase64)
        ingested += 1
        if (result.deduped) deduped += 1
        if (result.refusal?.verdict === 'refuse') refusals.push(`${file.name}: ${result.refusal.reason}`)
      } catch (ingestError) {
        refusals.push(`${file.name}: ${ingestError instanceof Error ? ingestError.message : String(ingestError)}`)
      }
    }
    setBusy(false)
    setNotice(`Upload ingest: ${ingested} imported${deduped ? `, ${deduped} deduped by content hash` : ''}.${refusals.length ? ` Refusals: ${refusals.length}` : ''}`)
    if (refusals.length) setError(refusals.join('\n'))
    await refresh()
  }

  const ingestByPath = async () => {
    const path = window.prompt('Absolute path of the media file to reference (must sit inside the studio home or the output directory — the file stays where it is; anything else: use LAN upload):')
    if (!path) return
    try {
      const result = await datasetsApi.ingestReference(path)
      setNotice(result.deduped ? 'Already in the library — the same content hash resolves to the same source.' : `Imported ${result.source.probe.width}×${result.source.probe.height}${result.refusal ? ` (${result.refusal.verdict}: ${result.refusal.reason})` : ''}`)
      await refresh()
    } catch (ingestError) {
      setError(ingestError instanceof Error ? ingestError.message : String(ingestError))
    }
  }

  const ingestFromCanvas = async () => {
    // Canvas bridge, direction 1: pick a completed take's artifact by path.
    // The canvas exposes takes via the document store; the take's file
    // becomes a referenced source (explicit, consent-shaped).
    const path = window.prompt('Path of the canvas take/media file to send to the dataset manager:')
    if (!path) return
    try {
      const result = await datasetsApi.ingestCanvas(path)
      setNotice(result.deduped ? 'That content is already in the library.' : 'Canvas media imported as a referenced source.')
      await refresh()
    } catch (canvasError) {
      setError(canvasError instanceof Error ? canvasError.message : String(canvasError))
    }
  }

  const runDedup = async () => {
    setBusy(true)
    setDedupState('Analyzing (tier-1 hash + tier-2 embeddings)…')
    try {
      const result = await datasetsApi.runDedup()
      setDedupState(`Clusters: ${result.tier1Clusters} near-dup groups, ${result.tier2Clusters} cross-ratio groups (${result.embedBackend} embeddings). Advisory only — nothing was deleted.`)
      setClipConsent(result.clipConsent ?? null)
      await refresh()
    } catch (dedupError) {
      setDedupState(null)
      setError(dedupError instanceof Error ? dedupError.message : String(dedupError))
    } finally {
      setBusy(false)
    }
  }

  /** Records the CLIP consent (LOW-2): the download happens only after this
   *  explicit action — then the pass re-runs so the backend label is honest. */
  const enableClip = async () => {
    if (!window.confirm('Enable CLIP embeddings? The first use downloads the model weights (Xenova/clip-vit-base-patch32, Apache-2.0) from huggingface.co to this machine. The perceptual fallback stays available otherwise.')) return
    setBusy(true)
    try {
      await datasetsApi.clipConsent(true)
      setClipConsent((current) => (current ? { ...current, consented: true } : current))
      setNotice('CLIP consent recorded — the next dedup pass will use CLIP embeddings when the model loads.')
      await runDedup()
    } catch (consentError) {
      setError(consentError instanceof Error ? consentError.message : String(consentError))
    } finally {
      setBusy(false)
    }
  }

  const pinToCanvas = async (layer: LibraryLayer) => {
    try {
      await datasetsApi.pinToCanvas(layer.id)
      setNotice(`Pinned "${layer.name || layer.id.slice(0, 8)}" as a canvas reference — reopen the canvas to see the reference object.`)
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : String(pinError))
    }
  }

  const batchVlm = async (guard: 'skip' | 'queue') => {
    const layerIds = Array.from(selected)
    if (!layerIds.length) {
      setError('Select layers first (click layer cards to select).')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const instruction = window.prompt('Batch instruction template (empty = the per-class dense→condense default):') ?? ''
      const result = await datasetsApi.vlmBatch(layerIds, { instruction, guard })
      setNotice(`Batch VLM: ${result.captioned.length} captioned, ${result.skipped.length} hand-written skipped, ${result.queuedForReview.length} queued for review${result.errors.length ? `, ${result.errors.length} errors` : ''}.`)
      if (result.errors.length) setError(result.errors.map((entry) => entry.error).join('\n').slice(0, 800))
      await refresh()
    } catch (batchError) {
      setError(batchError instanceof Error ? batchError.message : String(batchError))
    } finally {
      setBusy(false)
    }
  }

  const loadDashboard = useCallback(async () => {
    try {
      setDashboard(await datasetsApi.dashboard())
    } catch (dashboardError) {
      setError(dashboardError instanceof Error ? dashboardError.message : String(dashboardError))
    }
  }, [])

  useEffect(() => {
    if (tab === 'dashboard') void loadDashboard()
  }, [tab, loadDashboard])

  const openExport = async () => {
    if (!selected.size) {
      setError('Select layers to export first.')
      return
    }
    setTab('export')
    setExportResult(null)
  }

  return <div className="ds-app" data-ds-root>
    <header className="ds-titlebar">
      <div className="ds-brand"><Database size={16} /> Dataset manager <a className="ds-back" href="/">← canvas</a></div>
      <nav className="ds-tabs">
        {(['library', 'dashboard', 'export', 'trash'] as Tab[]).map((entry) => (
          <button key={entry} type="button" className={`ds-tab ${tab === entry ? 'active' : ''}`} onClick={() => setTab(entry)}>{entry}</button>
        ))}
      </nav>
      <div className="ds-titlebar-right">
        {settings && <span className="ds-trigger" title="Dataset trigger token">trigger: <code>{settings.triggerToken || '(unset)'}</code></span>}
        <span className={`ds-rife ${rifeAvailable ? 'ok' : ''}`} title={rifeAvailable ? 'rife-ncnn-vulkan detected — preferred interpolator' : 'rife-ncnn-vulkan absent — minterpolate fallback (A1 final)'}>{rifeAvailable ? 'RIFE' : 'minterpolate'}</span>
        <button type="button" className="ds-btn ghost" onClick={() => void refresh()}><RefreshCw size={13} /></button>
      </div>
    </header>

    {notice && <div className="ds-notice" data-ds-notice>{notice}<button type="button" onClick={() => setNotice(null)}>×</button></div>}
    {error && <div className="ds-error-banner" data-ds-error>{error}<button type="button" onClick={() => setError(null)}>×</button></div>}

    {tab === 'library' && <div className="ds-main">
      <aside className="ds-toolbar">
        <div className="ds-toolbar-block">
          <h4>Import</h4>
          <button type="button" className="ds-btn" onClick={() => fileInput.current?.click()}><Upload size={13} /> Upload from LAN</button>
          <input ref={fileInput} type="file" accept="video/*,image/*" multiple hidden onChange={(event) => void ingestFiles(event.target.files)} />
          <button type="button" className="ds-btn" onClick={() => void ingestByPath()}><FolderOpen size={13} /> Reference a file</button>
          <button type="button" className="ds-btn" onClick={() => void ingestFromCanvas()}><Camera size={13} /> From canvas take</button>
        </div>
        <div className="ds-toolbar-block">
          <h4>Search &amp; filter</h4>
          <div className="ds-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="FTS over captions + provenance" data-ds-search /></div>
          <div className="ds-filter-row">
            {(['all', 'video', 'image'] as const).map((entry) => (
              <button key={entry} type="button" className={`ds-chip ${kindFilter === entry ? 'active' : ''}`} onClick={() => setKindFilter(entry)}>{entry}</button>
            ))}
          </div>
          <div className="ds-filter-row">
            {(['all', 'missing', 'stale'] as const).map((entry) => (
              <button key={entry} type="button" className={`ds-chip ${captionFilter === entry ? 'active' : ''}`} onClick={() => setCaptionFilter(entry)}>{entry === 'all' ? 'any caption' : entry}</button>
            ))}
          </div>
        </div>
        <div className="ds-toolbar-block">
          <h4>Curation</h4>
          <button type="button" className="ds-btn" onClick={() => void runDedup()} disabled={busy}><Layers size={13} /> Dedup pass</button>
          {dedupState && <p className="ds-hint">{dedupState}</p>}
          {clipConsent && !clipConsent.consented && (
            <p className="ds-hint">
              CLIP embeddings are off (perceptual fallback).{' '}
              <button type="button" className="ds-btn ghost" onClick={() => void enableClip()} disabled={busy}>
                Enable CLIP
              </button>{' '}
              — downloads its model ({clipConsent.model}, Apache-2.0) from huggingface.co once, behind this explicit consent.
            </p>
          )}
          <button type="button" className="ds-btn" onClick={() => void batchVlm('skip')} disabled={busy}><Sparkles size={13} /> Batch VLM (skip hand)</button>
          <button type="button" className="ds-btn" onClick={() => void batchVlm('queue')} disabled={busy}><Sparkles size={13} /> Batch draft → review queue</button>
        </div>
        <div className="ds-toolbar-block">
          <h4>Selection</h4>
          <p className="ds-hint">{selected.size} layer(s) selected</p>
          <button type="button" className="ds-btn primary" onClick={() => void openExport()}><Download size={13} /> Export…</button>
        </div>
      </aside>

      <div className="ds-gallery-wrap">
        {busy && <div className="ds-busy"><LoaderCircle className="spin" /> working…</div>}
        <div
          ref={galleryRef}
          className="ds-gallery"
          data-ds-gallery
          onScroll={(event) => setScrollTop((event.target as HTMLDivElement).scrollTop)}
        >
          {!library && <p className="ds-hint">Loading library…</p>}
          {library && visibleSources.length === 0 && <div className="ds-empty" data-ds-empty>
            <p>The dataset is empty — import raw footage (by reference or LAN upload), then crop layers.</p>
            <p className="ds-hint">The source is sacred: nothing you do here ever modifies an imported file.</p>
          </div>}
          <div style={{ height: totalRows * CARD_HEIGHT, position: 'relative' }}>
            <div style={{ position: 'absolute', top: firstRow * CARD_HEIGHT, left: 0, right: 0, display: 'flex', flexWrap: 'wrap' }}>
              {visibleSlice.map((source) => (
                <MasterCard
                  key={source.id}
                  source={source}
                  expanded={expanded.has(source.id)}
                  onToggleExpand={() => setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(source.id)) next.delete(source.id)
                    else next.add(source.id)
                    return next
                  })}
                  onEdit={(layer) => setEditing({ source, layer })}
                  onCaption={(layer) => setCaptioning(layer)}
                  onSelect={toggleSelect}
                  selected={selected}
                  onSlowMo={async (layer, disposition) => {
                    try {
                      await datasetsApi.setLayerSlowmo(layer.id, disposition)
                      await refresh()
                    } catch (slowError) {
                      setError(slowError instanceof Error ? slowError.message : String(slowError))
                    }
                  }}
                  onAudit={async () => {
                    try {
                      const audit = await datasetsApi.auditSlowMo(source.id)
                      setNotice(audit.suspect ? `Slow-mo suspicion: ${audit.reasons.join(' ')}` : 'No slow-mo signature detected for this source.')
                    } catch (auditError) {
                      setError(auditError instanceof Error ? auditError.message : String(auditError))
                    }
                  }}
                  onSceneSplit={async () => {
                    try {
                      const proposals = await datasetsApi.proposeScenes(source.id)
                      if (!proposals.length) {
                        setNotice('No internal cuts detected in this source.')
                        return
                      }
                      const frames = proposals.map((proposal) => proposal.frameNo).join(', ')
                      const accept = window.confirm(`PySceneDetect-style proposals at frames ${frames}.\n\nAccept ALL and split into child layers? (Children attach visibly to the master; cut points stay editable until children exist.)`)
                      if (!accept) return
                      await datasetsApi.acceptCuts(source.id, proposals.map((proposal) => proposal.frameNo))
                      const split = await datasetsApi.splitAtCuts(source.id)
                      setNotice(`Split into ${split.children.length} scene children.`)
                      await refresh()
                    } catch (splitError) {
                      setError(splitError instanceof Error ? splitError.message : String(splitError))
                    }
                  }}
                  onTrashSource={async () => {
                    const layers = source.layers.length
                    const captions = source.layers.filter((layer) => layer.caption?.text).length
                    const blast = source.ingestPath === 'upload' ? `Its bytes are app-owned and move to the trash store (restorable).` : `The library entry is removed; your file on disk is never touched.`
                    if (!window.confirm(`Trash this source? Blast radius: ${layers} layer(s), ${captions} caption(s). ${blast}`)) return
                    try {
                      await datasetsApi.trashSource(source.id)
                      await refresh()
                    } catch (trashError) {
                      setError(trashError instanceof Error ? trashError.message : String(trashError))
                    }
                  }}
                  onRelink={async () => {
                    const path = window.prompt(source.healthDetail ? `${source.healthDetail}\n\nNew path for the missing file (must hash-match):` : 'New path for the missing file (must hash-match):')
                    if (!path) return
                    try {
                      const result = await datasetsApi.relink(source.id, path)
                      setNotice(result.relinked ? 'Re-linked by content hash.' : `Re-link refused: ${result.reason}`)
                      await refresh()
                    } catch (relinkError) {
                      setError(relinkError instanceof Error ? relinkError.message : String(relinkError))
                    }
                  }}
                  onPin={pinToCanvas}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>}

    {tab === 'dashboard' && <DashboardTab payload={dashboard} onRefresh={() => void loadDashboard()} />}

    {tab === 'export' && <ExportWizard
      layerIds={Array.from(selected)}
      settings={settings}
      aspects={aspects}
      result={exportResult}
      onResult={setExportResult}
      onError={setError}
      onClearNotice={setNotice}
    />}

    {tab === 'trash' && library && <TrashTab
      trashed={library.trashed.sources}
      onRestore={async (sourceId) => {
        try {
          await datasetsApi.restoreSource(sourceId)
          await refresh()
        } catch (restoreError) {
          setError(restoreError instanceof Error ? restoreError.message : String(restoreError))
        }
      }}
      onEmpty={async () => {
        if (!window.confirm('Empty the trash? THIS is the one real delete — and it only ever touches app-owned (uploaded) bytes; referenced originals are untouched. Entries restore no longer.')) return
        try {
          const result = await datasetsApi.emptyTrash()
          setNotice(`Trash emptied: ${result.dropped} entr(ies), ${(result.bytesDeleted / 1e6).toFixed(1)} MB of app-owned bytes deleted.`)
          await refresh()
        } catch (emptyError) {
          setError(emptyError instanceof Error ? emptyError.message : String(emptyError))
        }
      }}
    />}

    {editing && <CropEditor
      source={editing.source}
      layer={editing.layer}
      aspects={aspects}
      onClose={() => setEditing(null)}
      onSaved={() => {
        setEditing(null)
        void refresh()
      }}
    />}
    {captioning && <div className="ds-caption-overlay">
      <CaptionPanel
        layer={captioning}
        onClose={() => setCaptioning(null)}
        onChanged={() => void refresh()}
      />
    </div>}
  </div>
}

// ---------------------------------------------------------------------------

function MasterCard(props: {
  source: LibrarySource
  expanded: boolean
  onToggleExpand(): void
  onEdit(layer: LibraryLayer | null): void
  onCaption(layer: LibraryLayer): void
  onSelect(layerId: string): void
  selected: Set<string>
  onSlowMo(layer: LibraryLayer, disposition: string | null): void
  onAudit(): void
  onSceneSplit(): void
  onTrashSource(): void
  onRelink(): void
  onPin(layer: LibraryLayer): void
}) {
  const { source } = props
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const floor = floorBadge(source)
  const clusters = new Set(source.layers.map((layer) => layer.clusterId).filter(Boolean))
  return <div
    className={`ds-master ${source.health !== 'healthy' ? `health-${source.health}` : ''}`}
    style={{ width: CARD_WIDTH, minHeight: CARD_HEIGHT }}
    data-ds-master
    data-health={source.health}
  >
    <div
      className="ds-master-poster"
      onMouseEnter={() => videoRef.current?.play().catch(() => undefined)}
      onMouseLeave={() => {
        const video = videoRef.current
        if (!video) return
        video.pause()
        video.currentTime = 0
      }}
    >
      {source.health === 'missing'
        ? <div className="ds-poster-missing" data-ds-missing>MISSING<button type="button" className="ds-btn small" onClick={props.onRelink}>Re-link…</button></div>
        : source.kind === 'video'
          ? <video ref={videoRef} src={mediaUrlFor(source.id)} muted loop playsInline preload="metadata" className="ds-poster-media" />
          : <img src={mediaUrlFor(source.id)} alt="" className="ds-poster-media" />}
      <span className="ds-master-kind"><Video size={11} /> {source.kind}</span>
      {source.health === 'changed' && <span className="ds-master-flag warn">CHANGED</span>}
      {floor && <span className="ds-master-flag warn">{floor}</span>}
      {source.probeState !== 'done' && source.kind === 'video' && <span className="ds-master-flag">{source.probeState === 'failed' ? 'probe failed' : 'probing…'}</span>}
    </div>
    <div className="ds-master-info">
      <button type="button" className="ds-master-name" onClick={props.onToggleExpand} title={source.name}>
        {source.name}
      </button>
      <span className="ds-master-facts">
        {source.probe.width}×{source.probe.height}
        {source.kind === 'video' && source.decodedFrames ? ` · ${source.decodedFrames}f` : ''}
        {source.probe.fps ? ` · ${source.probe.fps.toFixed(3)}fps` : ' · still'}
      </span>
      <div className="ds-master-actions">
        <button type="button" className="ds-btn small" onClick={() => props.onEdit(null)}><Plus size={11} /> layer</button>
        {source.kind === 'video' && <button type="button" className="ds-btn small" onClick={props.onSceneSplit}>split scenes</button>}
        <button type="button" className="ds-btn small" onClick={props.onAudit}>slow-mo audit</button>
        <button type="button" className="ds-btn small danger" onClick={props.onTrashSource}><Trash2 size={11} /></button>
      </div>
      {clusters.size > 0 && <p className="ds-cluster-note" data-ds-cluster-note>{clusters.size} cluster group(s) — same-content items are grouped + numbered in the gallery (cross-ratio = bucket diversity, advisory only)</p>}
    </div>
    {props.expanded && <div className="ds-children" data-ds-children>
      {source.layers.length === 0 && <p className="ds-hint">No layers — add a crop/trim layer.</p>}
      {source.layers.map((layer) => (
        <div key={layer.id} className={`ds-layer ${props.selected.has(layer.id) ? 'selected' : ''}`} data-ds-layer>
          <button type="button" className="ds-layer-select" onClick={() => props.onSelect(layer.id)} title="Select for export/batch" aria-label="select layer" />
          <div className="ds-layer-main">
            <span className="ds-layer-name">{layer.name || layer.id.slice(0, 8)}</span>
            <span className={`ds-bucket-badge wall-${layer.bucket.wall}`} title={`bucket: ${layer.bucket.label} (walls: ok/warn/stop)`}>{layer.bucket.label}</span>
            {layer.clusterId && <span className="ds-cluster-badge" title="near-dup cluster member — advisory">⧉ {layer.clusterId.split('-')[0]}·{layer.clusterNo}</span>}
            {layer.caption?.stale && <span className="ds-stale-badge" title="view changed after captioning">stale</span>}
            {layer.interpolated && <span className="ds-interp-badge" title="bake interpolates (tagged)">interp</span>}
            {layer.caption?.reviewState === 'queued' && <span className="ds-review-badge">review queued</span>}
            <span className="ds-layer-caption">{layer.caption?.text?.slice(0, 120) ?? <em>uncaptioned</em>}</span>
          </div>
          <div className="ds-layer-actions">
            <button type="button" className="ds-btn small" onClick={() => props.onEdit(layer)}>crop/trim</button>
            <button type="button" className="ds-btn small" onClick={() => props.onCaption(layer)}>caption</button>
            <button type="button" className="ds-btn small" onClick={() => props.onPin(layer)} title="Pin onto the canvas as a reference asset"><Pin size={11} /></button>
            {layer.slowmoDisposition
              ? <span className="ds-disposition">{layer.slowmoDisposition}</span>
              : <select className="ds-disposition-select" defaultValue="" onChange={(event) => event.target.value && props.onSlowMo(layer, event.target.value)} title="Slow-mo disposition (gate 4)">
                  <option value="">disposition…</option>
                  <option value="retime">retime</option>
                  <option value="caption">caption-honestly</option>
                  <option value="exclude">exclude</option>
                </select>}
          </div>
        </div>
      ))}
    </div>}
  </div>
}

// ---------------------------------------------------------------------------

function DashboardTab({ payload, onRefresh }: { payload: DashboardPayload | null; onRefresh(): void }) {
  return <div className="ds-dashboard" data-ds-dashboard>
    <header className="ds-section-head">
      <h2>Balance &amp; budget</h2>
      <button type="button" className="ds-btn ghost" onClick={onRefresh}><RefreshCw size={13} /> refresh</button>
    </header>
    {!payload && <p className="ds-hint">Computing…</p>}
    {payload && <>
      <div className="ds-preflight" data-ds-preflight>
        <h3>Per-trainer VRAM preflight (worst-case item binds the dataset)</h3>
        {payload.preflight
          ? <div className={`ds-preflight-card verdict-${payload.preflight.verdict}`} data-ds-preflight-card>
              <span className="ds-preflight-item">{payload.preflight.item} — {payload.preflight.worstLayerId.slice(0, 8)}</span>
              <span>DiffSynX <strong>{payload.preflight.diffsynxGb.toFixed(1)} GB</strong></span>
              <span>musubi <strong>{payload.preflight.musubiGb.toFixed(1)} GB</strong></span>
              <span className="ds-binds">binds: {payload.preflight.binds}</span>
              <span className={`ds-verdict verdict-${payload.preflight.verdict}`}>{payload.preflight.verdict} (wall {payload.preflight.wall} GB)</span>
            </div>
          : <p className="ds-hint">No video items yet — the preflight computes per-item peaks (peak = MAX of buckets) for BOTH trainer profiles.</p>}
        <p className="ds-hint">Honesty note: no canonical target distribution exists — guidance below is shape-based (outliers, holes, over-concentration); targets are yours.</p>
      </div>
      <div className="ds-distributions">
        {(['aspect', 'duration', 'resolution', 'contentClass'] as const).map((key) => (
          <div key={key} className="ds-dist" data-ds-dist={key}>
            <h4>{key === 'contentClass' ? 'content class' : key}</h4>
            {payload.distributions[key].map((bucket) => (
              <div key={bucket.key} className="ds-dist-row">
                <span className="ds-dist-key">{bucket.key}</span>
                <span className="ds-dist-bar" style={{ width: `${Math.max(3, (bucket.count / Math.max(1, payload.distributions[key][0].count)) * 100)}%` }} />
                <span className="ds-dist-count">{bucket.count}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="ds-dist">
          <h4>caption coverage</h4>
          <p>{payload.distributions.captionCoverage.captioned}/{payload.distributions.captionCoverage.total} captioned · {payload.distributions.captionCoverage.stale} stale</p>
        </div>
      </div>
      <ul className="ds-guidance" data-ds-guidance>
        {payload.guidance.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </>}
  </div>
}

// ---------------------------------------------------------------------------

function ExportWizard(props: {
  layerIds: string[]
  settings: DatasetSettings | null
  aspects: AspectEntry[]
  result: ExportResultPayload | null
  onResult(result: ExportResultPayload | null): void
  onError(message: string | null): void
  onClearNotice(message: string | null): void
}) {
  const [shape, setShape] = useState<'musubi' | 'diffsynx' | 'external'>('musubi')
  const [trainer, setTrainer] = useState<'diffsynx' | 'musubi'>('diffsynx')
  const [folder, setFolder] = useState('')
  const [gridTarget, setGridTarget] = useState<string>('')
  const [acceptWarnings, setAcceptWarnings] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!props.layerIds.length) {
      props.onError('No layers selected — pick layers in the Library tab first.')
      return
    }
    setBusy(true)
    props.onError(null)
    try {
      const result = await datasetsApi.export({
        shape,
        trainer,
        folder: folder.trim() || `dataset-export-${new Date().toISOString().slice(0, 10)}`,
        layerIds: props.layerIds,
        gridTarget: gridTarget.trim() ? Number(gridTarget) : null,
        acceptWarnings,
      })
      props.onResult(result)
      props.onClearNotice(null)
    } catch (exportError) {
      props.onError(exportError instanceof Error ? exportError.message : String(exportError))
    } finally {
      setBusy(false)
    }
  }

  return <div className="ds-export" data-ds-export>
    <header className="ds-section-head"><h2>Export wizard — shape → gates → bake → report</h2></header>
    <p className="ds-hint">{props.layerIds.length} layer(s) selected. Exports are immutable snapshots; the gate report travels with the folder.</p>
    <div className="ds-export-form">
      <div className="ds-field">
        <label>Shape</label>
        <div className="ds-filter-row">
          {(['musubi', 'diffsynx', 'external'] as const).map((entry) => (
            <button key={entry} type="button" className={`ds-chip ${shape === entry ? 'active' : ''}`} onClick={() => setShape(entry)}>{entry}</button>
          ))}
        </div>
        <p className="ds-hint">{shape === 'musubi' ? 'musubi TOML + caption sidecars + wav sidecars + one_frame stills' : shape === 'diffsynx' ? 'DiffSynX stage-1 manifest rows (video/prompt/input_audio/frame_rate)' : 'both shapes + README — standalone for any external trainer; in-app training stays availability-gated'}</p>
      </div>
      <div className="ds-field">
        <label>Recipe trainer (the card follows)</label>
        <div className="ds-filter-row">
          {(['diffsynx', 'musubi'] as const).map((entry) => (
            <button key={entry} type="button" className={`ds-chip ${trainer === entry ? 'active' : ''}`} onClick={() => setTrainer(entry)}>{entry}</button>
          ))}
        </div>
      </div>
      <div className="ds-field">
        <label>Destination folder</label>
        <input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="dataset-export-2026-09-17 (relative names land inside the studio output directory; every destination must stay inside it)" />
      </div>
      <div className="ds-field">
        <label>Grid target (optional — default: the largest 17n+5 that fits each trim with +2 headroom)</label>
        <input value={gridTarget} onChange={(event) => setGridTarget(event.target.value)} placeholder="22 / 39 / 56 / 73 / 90 / 107 / 124 …" inputMode="numeric" />
      </div>
      <label className="ds-check">
        <input type="checkbox" checked={acceptWarnings} onChange={(event) => setAcceptWarnings(event.target.checked)} />
        Accept all WARNING-tier gate findings (never the refusing tier) — the explicit accept-all.
      </label>
      <button type="button" className="ds-btn primary" onClick={run} disabled={busy} data-ds-run-export>
        {busy ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />} Run gates → bake → export
      </button>
    </div>
    {props.result && <div className="ds-export-result" data-ds-export-result>
      <h3>{props.result.written.length} item(s) exported · {props.result.refused.length} refused</h3>
      <p className="ds-hint">{props.result.folder} — validation: musubi config {props.result.validated.musubiConfig}, DiffSynX dry-load {props.result.validated.diffsynxDryLoad}</p>
      {props.result.refused.length > 0 && <div className="ds-refusals" data-ds-refusals>
        <h4>Refusals (gate reasons)</h4>
        {props.result.refused.map((entry) => (
          <div key={entry.layerId} className="ds-refusal">
            <code>{entry.layerId.slice(0, 8)}</code>
            <ul>{entry.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </div>
        ))}
      </div>}
      {props.result.gateReport.length > 0 && <div className="ds-gates">
        <h4>Gate report</h4>
        {props.result.gateReport.map((finding, index) => (
          <p key={index} className={`ds-gate tier-${finding.tier}`}><strong>gate {finding.gate} {finding.name}</strong> ({finding.tier}) — {finding.reason}</p>
        ))}
      </div>}
      <div className="ds-recipe">
        <h4>Recipe card</h4>
        {Object.entries(props.result.recipe).filter(([, value]) => typeof value === 'string').map(([key, value]) => (
          <p key={key}><strong>{key}</strong>: {String(value)}</p>
        ))}
      </div>
    </div>}
  </div>
}

// ---------------------------------------------------------------------------

function TrashTab(props: {
  trashed: Array<{ id: string; name: string; ingestPath: string; layers: number }>
  onRestore(sourceId: string): void
  onEmpty(): void
}) {
  return <div className="ds-trash" data-ds-trash>
    <header className="ds-section-head">
      <h2>Trash (soft-deleted — restorable)</h2>
      <button type="button" className="ds-btn danger" onClick={props.onEmpty}>Empty trash (the one real delete — app-owned bytes only)</button>
    </header>
    {props.trashed.length === 0 && <p className="ds-hint">Trash is empty.</p>}
    {props.trashed.map((entry) => (
      <div key={entry.id} className="ds-trash-row">
        <span>{entry.name}</span>
        <span className="ds-hint">{entry.ingestPath === 'upload' ? 'app-owned bytes (restorable from the trash store)' : 'referenced file — entry only; the original was never touched'} · {entry.layers} layer(s)</span>
        <button type="button" className="ds-btn small" onClick={() => props.onRestore(entry.id)}>Restore</button>
      </div>
    ))}
  </div>
}
