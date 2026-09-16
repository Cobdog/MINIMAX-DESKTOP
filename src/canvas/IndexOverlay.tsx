/**
 * Canvas Phase 1 — the summonable index (§4): a ⌘K-class overlay over the
 * document FTS + the session's loaded objects + jobs. Selecting navigates to
 * the region (open the owning canvas if needed, fly the camera to the tile).
 *
 * Honest limits: FTS hits that resolve to chains/takes not in a LOADED
 * document render as "not open in this session" rows (no fabrication); job
 * rows navigate to their chain and carry a stop action while the job is
 * live (Phase 2 wiring). Projects navigate by opening the canvas.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Clapperboard, Search } from 'lucide-react'
import { documentsApi, type SearchHit } from './api'
import { useCanvasStore } from './store'
import { useJobsStore } from '../state/jobsStore'

type Row = {
  key: string
  kind: 'project' | 'object' | 'take' | 'job' | 'unresolved'
  label: string
  note: string
  projectId?: string
  chainId?: string
  disabled?: boolean
  cancellable?: boolean
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
  const jobs = useJobsStore((state) => state.jobs)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [ftsHits, setFtsHits] = useState<SearchHit[]>([])
  const [ftsPending, setFtsPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setFtsHits([])
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

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
        const title = prompt.split(/[.\n]/).map((part) => part.trim()).find(Boolean) ?? `${chain.kind} ${chain.id.slice(0, 8)}`
        if (!needle || title.toLowerCase().includes(needle) || prompt.toLowerCase().includes(needle)) {
          list.push({ key: `chain:${chain.id}`, kind: 'object', label: title, note: `chain · ${document.project.name}`, projectId: document.project.id, chainId: chain.id })
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

  return <div className="canvas-index-overlay" data-canvas-index role="dialog" aria-label="Canvas index" onClick={() => setIndexOpen(false)}>
    <div className="canvas-index-panel" onClick={(event) => event.stopPropagation()}>
      <div className="canvas-index-input">
        <Search size={15} />
        <input
          ref={inputRef}
          value={query}
          data-canvas-index-input
          placeholder="Search canvases, objects, takes, jobs…"
          onChange={(event) => { setQuery(event.target.value); setCursor(0) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((value) => Math.min(value + 1, rows.length - 1)) }
            if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((value) => Math.max(value - 1, 0)) }
            if (event.key === 'Enter') { event.preventDefault(); const row = rows[cursor]; if (row) void activate(row) }
            if (event.key === 'Escape') setIndexOpen(false)
          }}
        />
        {ftsPending && <span className="canvas-index-pending">searching…</span>}
      </div>
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
          </li>
        ))}
        {!rows.length && <li className="canvas-index-empty">{query ? 'Nothing matches — yet.' : 'Type to search across the session.'}</li>}
      </ul>
    </div>
  </div>
}
