/**
 * Canvas Phase 1 — the summonable index (§4): a ⌘K-class overlay over the
 * document FTS + the session's loaded objects + jobs. Selecting navigates to
 * the region (open the owning canvas if needed, fly the camera to the tile).
 *
 * Honest limits: FTS hits that resolve to chains/takes not in a LOADED
 * document render as "not open in this session" rows (no fabrication); job
 * rows navigate to their chain and carry a stop action while the job is
 * live (Phase 2 wiring). Projects navigate by opening the canvas.
 *
 * The trash front door (maintainer ruling 2026-09-26, directive 1e363ec0
 * item 1 — "no way to delete old scenes, the graphs just accumulate"): every
 * scene row carries a trash action (tombstone — undo-able until the trash
 * is emptied), and the overlay's trash view lists what the store holds for
 * restore or the one explicit empty. The datasets manager's trash UX is the
 * pattern: delete → trashed state visible → restore or empty; NO hard
 * deletes from here — the store's GC owns those.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Clapperboard, Search, Trash2 } from 'lucide-react'
import { documentsApi, type SearchHit } from './api'
import { useCanvasStore } from './store'
import { useJobsStore } from '../state/jobsStore'
import { dbg } from '../lib/dbg'
import type { DocumentChain } from './derive'

type Row = {
  key: string
  kind: 'project' | 'object' | 'take' | 'job' | 'unresolved'
  label: string
  note: string
  projectId?: string
  chainId?: string
  disabled?: boolean
  cancellable?: boolean
  /** The scene-row trash action's blast radius (take count) for its confirm. */
  takeCount?: number
}

/** The title a trashed/scene row shows — the chain's prompt head, the same
 *  derivation the live rows use. */
function sceneTitle(chain: DocumentChain): string {
  const prompt = typeof chain.settings.prompt === 'string' ? chain.settings.prompt : ''
  return prompt.split(/[.\n]/).map((part) => part.trim()).find(Boolean) ?? `${chain.kind} ${chain.id.slice(0, 8)}`
}

export function IndexOverlay() {
  const open = useCanvasStore((state) => state.indexOpen)
  const setIndexOpen = useCanvasStore((state) => state.setIndexOpen)
  const projects = useCanvasStore((state) => state.projects)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const chainJobs = useCanvasStore((state) => state.chainJobs)
  const openProject = useCanvasStore((state) => state.openProject)
  const select = useCanvasStore((state) => state.select)
  const requestCamera = useCanvasStore((state) => state.requestCamera)
  const toast = useCanvasStore((state) => state.toast)
  const jobs = useJobsStore((state) => state.jobs)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [ftsHits, setFtsHits] = useState<SearchHit[]>([])
  const [ftsPending, setFtsPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // The trash view: trashed scenes from the STORE's own listing (the
  // undo window the GC owns), fetched on entry, refreshed after acts.
  const [trashMode, setTrashMode] = useState(false)
  const [trashed, setTrashed] = useState<DocumentChain[] | null>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setFtsHits([])
      setTrashMode(false)
      setTrashed(null)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const refreshTrash = () => {
    documentsApi.listTrashedChains().then((chains) => setTrashed(chains)).catch((error) => {
      setTrashed([])
      toast('error', `The trash listing failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Entering the trash view lists the store's own trash (stale responses
  // cancel — two quick toggles never race the earlier listing in).
  useEffect(() => {
    if (!open || !trashMode) return undefined
    let cancelled = false
    documentsApi.listTrashedChains()
      .then((chains) => { if (!cancelled) setTrashed(chains) })
      .catch((error) => {
        if (cancelled) return
        setTrashed([])
        toast('error', `The trash listing failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => { cancelled = true }
  }, [open, trashMode, toast])

  // FTS is debounced — the flat client rows answer instantly, the server
  // search merges in behind them.
  useEffect(() => {
    if (!open || !query.trim()) {
      setFtsHits([])
      return undefined
    }
    setFtsPending(true)
    const timer = window.setTimeout(() => {
      documentsApi.search(query)
        .then((hits) => setFtsHits(hits))
        .catch(() => setFtsHits([]))
        .finally(() => setFtsPending(false))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [open, query])

  const rows = useMemo<Row[]>(() => {
    const needle = query.trim().toLowerCase()
    const list: Row[] = []
    for (const project of projects) {
      if (!needle || project.name.toLowerCase().includes(needle)) {
        list.push({ key: `project:${project.id}`, kind: 'project', label: project.name, note: 'canvas', projectId: project.id })
      }
    }
    for (const document of Object.values(documents)) {
      for (const chain of document.chains) {
        const prompt = typeof chain.settings.prompt === 'string' ? chain.settings.prompt : ''
        const title = sceneTitle(chain)
        if (!needle || title.toLowerCase().includes(needle) || prompt.toLowerCase().includes(needle)) {
          list.push({
            key: `chain:${chain.id}`,
            kind: 'object',
            label: title,
            note: `chain · ${document.project.name}`,
            projectId: document.project.id,
            chainId: chain.id,
            takeCount: chain.outputs.reduce((count, output) => count + output.takes.length, 0),
          })
        }
        for (const output of chain.outputs) {
          for (const take of output.takes) {
            const metrics = take.metrics ? JSON.stringify(take.metrics) : ''
            if (needle && (take.id.includes(needle) || metrics.toLowerCase().includes(needle))) {
              list.push({ key: `take:${take.id}`, kind: 'take', label: `take ${take.id.slice(0, 8)}`, note: `${document.project.name} · ${take.supersededBy ? 'prior' : 'canonical'}`, projectId: document.project.id, chainId: chain.id })
            }
          }
        }
      }
    }
    const linkedJobChains = new Map(Object.entries(chainJobs).map(([chainId, jobId]) => [jobId, chainId]))
    for (const job of jobs) {
      if (needle && !job.prompt.toLowerCase().includes(needle)) continue
      const chainId = linkedJobChains.get(job.id)
      list.push({
        key: `job:${job.id}`,
        kind: 'job',
        label: job.prompt ? `${job.prompt.slice(0, 70)}` : job.id,
        note: `job · ${job.status}${chainId ? '' : ' — not on an open canvas'}`,
        projectId: chainId ? activeProjectId ?? undefined : undefined,
        chainId,
        disabled: !chainId,
        cancellable: chainId ? job.status === 'queued' || job.status === 'running' : false,
      })
    }
    // FTS hits not already covered by a loaded row.
    const known = new Set(list.map((row) => row.key))
    for (const hit of ftsHits) {
      if (hit.source_kind === 'job') continue // job rows above carry the store truth
      if (known.has(`${hit.source_kind === 'chain' ? 'chain' : hit.source_kind}:${hit.source_id}`)) continue
      list.push({ key: `fts:${hit.source_kind}:${hit.source_id}`, kind: 'unresolved', label: `${hit.source_kind} ${hit.source_id.slice(0, 12)}`, note: 'found by search — not open in this session', disabled: true })
    }
    return list.slice(0, 40)
  }, [query, projects, documents, jobs, chainJobs, ftsHits, activeProjectId])

  if (!open) return null

  const activate = async (row: Row) => {
    if (row.disabled) return
    if (row.kind === 'project' && row.projectId) {
      await openProject(row.projectId)
      setIndexOpen(false)
      return
    }
    if (row.chainId) {
      if (row.projectId && row.projectId !== useCanvasStore.getState().activeProjectId) await openProject(row.projectId)
      select(row.chainId)
      requestCamera({ kind: 'fly', tileId: row.chainId })
      setIndexOpen(false)
    }
  }

  // The trash action: tombstone (restorable until the trash is emptied),
  // with the blast radius stated up front — the datasets pattern.
  const trashScene = async (row: Row) => {
    if (!row.chainId || !row.projectId) return
    const takes = row.takeCount ?? 0
    const projectName = projects.find((project) => project.id === row.projectId)?.name ?? 'its canvas'
    if (!window.confirm(`Trash this scene?\n\n“${row.label}” leaves ${projectName} and moves to the trash — restorable until the trash is emptied.${takes ? `\n\nIts ${takes} take${takes === 1 ? '' : 's'} ride it and come back with the restore.` : ''}`)) return
    const deleted = await useCanvasStore.getState().deleteScene(row.chainId)
    if (deleted) toast('success', `Scene trashed — restorable from the trash view until the trash is emptied.`)
    else toast('error', 'Nothing was trashed — the scene was already gone (the list refreshes).')
    if (trashMode) refreshTrash()
  }

  const restoreScene = async (chain: DocumentChain) => {
    const restored = await useCanvasStore.getState().restoreScene(chain.id, chain.projectId)
    if (restored) toast('success', `Scene restored to its canvas whole — takes included.`)
    else toast('error', 'Nothing was restored — the scene was no longer in the trash.')
    refreshTrash()
  }

  const emptyTrash = async () => {
    if (!window.confirm('Empty the trash?\n\nTHIS is the one real delete: every tombstoned canvas, scene and asset goes for good, with their takes. Entries restore no longer.')) return
    const counts = await useCanvasStore.getState().emptyTrash()
    if (counts) {
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
      dbg('trash', { action: 'empty-receipt', counts })
      toast('success', `Trash emptied — ${total} entr${total === 1 ? 'y' : 'ies'} deleted for good.`)
    }
    refreshTrash()
  }

  const trashRows = (trashed ?? []).filter((chain) => {
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    const prompt = typeof chain.settings.prompt === 'string' ? chain.settings.prompt : ''
    return sceneTitle(chain).toLowerCase().includes(needle) || prompt.toLowerCase().includes(needle)
  })

  return <div className="canvas-index-overlay" data-canvas-index role="dialog" aria-label="Canvas index" onClick={() => setIndexOpen(false)}>
    <div className="canvas-index-panel" onClick={(event) => event.stopPropagation()}>
      <div className="canvas-index-input">
        <Search size={15} />
        <input
          ref={inputRef}
          value={query}
          data-canvas-index-input
          placeholder={trashMode ? 'Search the trash…' : 'Search canvases, objects, takes, jobs…'}
          onChange={(event) => { setQuery(event.target.value); setCursor(0) }}
          onKeyDown={(event) => {
            // The trash view's rows are not navigable — the live rows' cursor
            // stays parked while the trash list is displayed.
            if (event.key === 'ArrowDown' && !trashMode) { event.preventDefault(); setCursor((value) => Math.min(value + 1, rows.length - 1)) }
            if (event.key === 'ArrowUp' && !trashMode) { event.preventDefault(); setCursor((value) => Math.max(value - 1, 0)) }
            if (event.key === 'Enter' && !trashMode) { event.preventDefault(); const row = rows[cursor]; if (row) void activate(row) }
            if (event.key === 'Escape') { event.stopPropagation(); setIndexOpen(false) }
          }}
        />
        {ftsPending && !trashMode && <span className="canvas-index-pending">searching…</span>}
        <button
          type="button"
          className={`canvas-chip ${trashMode ? 'active' : ''}`}
          data-canvas-index-trash
          title={trashMode ? 'Back to the session index' : 'Trashed scenes — restorable until the trash is emptied'}
          onClick={() => setTrashMode((value) => !value)}
        >
          <Trash2 size={12} /> trash
        </button>
      </div>
      {trashMode ? (
        <div className="canvas-index-trash" data-canvas-index-trash-view>
          <div className="canvas-index-trash-head">
            <strong>Trash — soft-deleted scenes (restorable)</strong>
            <button type="button" className="canvas-chip danger" data-canvas-index-empty onClick={() => void emptyTrash()} disabled={!trashed?.length}>
              Empty trash (the one real delete)
            </button>
          </div>
          <ul className="canvas-index-rows">
            {trashRows.map((chain) => (
              <li key={chain.id} className="canvas-index-li" data-canvas-index-trash-row={chain.id}>
                <span className="canvas-index-row disabled">
                  <Trash2 size={13} />
                  <span className="canvas-index-row-label">{sceneTitle(chain)}</span>
                  <span className="canvas-index-row-note">{`trashed ${new Date(chain.deletedAt ?? chain.createdAt).toLocaleString()}`}</span>
                </span>
                <button type="button" className="canvas-index-row-cancel" data-canvas-index-restore onClick={() => void restoreScene(chain)}>
                  restore
                </button>
              </li>
            ))}
            {trashed !== null && !trashRows.length && <li className="canvas-index-empty">Trash is empty.</li>}
            {trashed === null && <li className="canvas-index-empty">Listing the trash…</li>}
          </ul>
        </div>
      ) : (
        <ul className="canvas-index-rows" data-canvas-index-rows>
          {rows.map((row, index) => (
            <li key={row.key} className={`canvas-index-li ${index === cursor ? 'cursor' : ''} ${row.disabled ? 'disabled' : ''}`} onMouseEnter={() => setCursor(index)}>
              <button
                type="button"
                className="canvas-index-row"
                data-canvas-index-row={row.kind}
                onClick={() => void activate(row)}
                disabled={row.disabled}
              >
                {row.kind === 'project' && <Clapperboard size={13} />}
                <span className="canvas-index-row-label">{row.label}</span>
                <span className="canvas-index-row-note">{row.note}</span>
              </button>
              {row.cancellable && (
                <button
                  type="button"
                  className="canvas-index-row-cancel"
                  aria-label="Cancel this job"
                  data-canvas-index-cancel
                  onClick={() => { const chainId = row.chainId; if (chainId) void useCanvasStore.getState().cancelChainJob(chainId) }}
                >
                  stop
                </button>
              )}
              {row.kind === 'object' && row.chainId && (
                <button
                  type="button"
                  className="canvas-index-row-cancel"
                  aria-label="Trash this scene (restorable until the trash is emptied)"
                  data-canvas-index-delete
                  title="Trash this scene — restorable from the trash view until the trash is emptied"
                  onClick={() => void trashScene(row)}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </li>
          ))}
          {!rows.length && <li className="canvas-index-empty">{query ? 'Nothing matches — yet.' : 'Type to search across the session.'}</li>}
        </ul>
      )}
    </div>
  </div>
}
