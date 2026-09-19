/**
 * Canvas Phase 4 — the library projection (§7 V: projection flip; §4
 * "projections inherit the contracts").
 *
 * Library-as-projection: completed outputs ARE canvas objects already; this
 * overlay is the summonable LIST view over them — every take with renderable
 * media across the session's loaded canvases, searchable through the
 * documents FTS (take/job metadata) plus the in-session prompt filter, each
 * row navigating to its owning canvas + object (F7: navigate via the same
 * camera machinery as the radar). Audio/video/image all surface — the audio
 * engines' outputs are first-class takes.
 */
import { useEffect, useMemo, useState } from 'react'
import { Film, Image as ImageIcon, Music2, Search, X } from 'lucide-react'
import { documentsApi } from './api'
import { mediaForOutput, buildOutputIndex } from './generation'
import { useCanvasStore } from './store'
import { useWindowedList } from './useWindowedList'

type LibraryRow = {
  key: string
  kind: 'video' | 'image' | 'audio'
  label: string
  note: string
  projectId: string
  chainId: string
  sourcePath: string | null
}

export function LibraryOverlay() {
  const open = useCanvasStore((state) => state.libraryOpen)
  const setLibraryOpen = useCanvasStore((state) => state.setLibraryOpen)
  const documents = useCanvasStore((state) => state.documents)
  const openProject = useCanvasStore((state) => state.openProject)
  const select = useCanvasStore((state) => state.select)
  const requestCamera = useCanvasStore((state) => state.requestCamera)

  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all')

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  // The projection itself: every take that resolves to renderable media,
  // across every LOADED canvas (canonical + priors — priors are the library's
  // history, superseded but never deleted).
  const rows = useMemo<LibraryRow[]>(() => {
    const list: Array<LibraryRow & { createdAt: number }> = []
    for (const document of Object.values(documents)) {
      const outputs = buildOutputIndex(document)
      for (const chain of document.chains) {
        for (const output of chain.outputs) {
          for (const take of output.takes) {
            const resolved = mediaForOutput(outputs.get(output.id), take.id)
            if (!resolved) continue
            const prompt = typeof chain.settings.prompt === 'string' ? chain.settings.prompt : ''
            list.push({
              key: take.id,
              createdAt: take.createdAt,
              kind: resolved.media.kind,
              label: prompt ? prompt.slice(0, 70) : `${chain.kind} ${chain.id.slice(0, 8)}`,
              note: `${document.project.name} · ${take.supersededBy ? 'prior' : 'canonical'} · ${new Date(take.createdAt).toLocaleDateString()}`,
              projectId: document.project.id,
              chainId: chain.id,
              sourcePath: resolved.media.path,
            })
          }
        }
      }
    }
    return list.sort((a, b) => b.createdAt - a.createdAt)
  }, [documents])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => (kindFilter === 'all' || row.kind === kindFilter) && (!needle || row.label.toLowerCase().includes(needle) || (row.sourcePath ?? '').toLowerCase().includes(needle)))
  }, [rows, query, kindFilter])

  // FTS widens the match beyond loaded documents' prompts (take metadata,
  // artifacts, hashes): hits that resolve to a loaded chain navigate; others
  // report honestly as not-open (same discipline as the index overlay).
  const [ftsMatches, setFtsMatches] = useState<string[]>([])
  useEffect(() => {
    if (!open || !query.trim()) {
      setFtsMatches([])
      return undefined
    }
    const timer = window.setTimeout(() => {
      void documentsApi.search(query, 12, 'take').then((hits) => {
        const chainIds = new Set<string>()
        for (const document of Object.values(documents)) {
          for (const chain of document.chains) {
            if (chain.outputs.some((output) => output.takes.some((take) => hits.some((hit) => hit.source_id === take.id)))) chainIds.add(chain.id)
          }
        }
        setFtsMatches([...chainIds])
      }).catch(() => setFtsMatches([]))
    }, 200)
    return () => window.clearTimeout(timer)
  }, [open, query, documents])

  // The FTS fallback widens beyond the loaded documents, but it must RESPECT
  // the active kind filter — an image row must never surface under the audio
  // filter (the fallback used to bypass it; a latent race the deterministic
  // kind-filtered search exposed).
  const visible = filtered.length ? filtered : rows.filter((row) => ftsMatches.includes(row.chainId) && (kindFilter === 'all' || row.kind === kindFilter))

  // Perf wave 1: windowed mounting (profile rec 2) — 300 rows in one commit
  // cost a 228 ms open; only the scroll window (+overscan) mounts now, with
  // spacer <li>s carrying the unmounted extent so the scrollbar is exact.
  // Lives ABOVE the closed-overlay early return like every other hook.
  const rowsWindow = useWindowedList({ count: visible.length, axis: 'y' })

  if (!open) return null

  const activate = async (row: LibraryRow) => {
    if (row.projectId !== useCanvasStore.getState().activeProjectId) await openProject(row.projectId)
    select(row.chainId)
    requestCamera({ kind: 'fly', tileId: row.chainId })
    setLibraryOpen(false)
  }

  return <div className="canvas-index-overlay" data-canvas-library role="dialog" aria-label="Library" onClick={() => setLibraryOpen(false)}>
    <div className="canvas-index-panel canvas-library-panel" onClick={(event) => event.stopPropagation()}>
      <div className="canvas-index-input">
        <Search size={15} />
        <input
          value={query}
          data-canvas-library-input
          placeholder="Search completed outputs across the session…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setLibraryOpen(false) } }}
        />
        <div className="canvas-library-filters" role="group" aria-label="Filter by kind">
          {(['all', 'video', 'image', 'audio'] as const).map((kind) => (
            <button key={kind} type="button" className={`canvas-chip ${kindFilter === kind ? 'active' : ''}`} data-canvas-library-filter={kind} onClick={() => setKindFilter(kind)}>{kind}</button>
          ))}
        </div>
        <button type="button" className="icon-button" aria-label="Close library" data-canvas-library-close onClick={() => setLibraryOpen(false)}><X size={14} /></button>
      </div>
      <ul className="canvas-index-rows" data-canvas-library-rows ref={rowsWindow.containerRef} onScroll={rowsWindow.onScroll}>
        {rowsWindow.range.padStartPx > 0 && <li aria-hidden="true" style={{ height: rowsWindow.range.padStartPx }} />}
        <div style={{ display: 'contents' }} ref={rowsWindow.itemsRef}>
          {visible.slice(rowsWindow.range.start, rowsWindow.range.end).map((row) => (
            <li key={row.key} className="canvas-index-li">
              <button type="button" className="canvas-index-row" data-canvas-library-row={row.kind} onClick={() => void activate(row)}>
                {row.kind === 'video' ? <Film size={13} /> : row.kind === 'audio' ? <Music2 size={13} /> : <ImageIcon size={13} />}
                <span className="canvas-index-row-label">{row.label}</span>
                <span className="canvas-index-row-note">{row.note}</span>
              </button>
            </li>
          ))}
        </div>
        {rowsWindow.range.padEndPx > 0 && <li aria-hidden="true" style={{ height: rowsWindow.range.padEndPx }} />}
        {!visible.length && <li className="canvas-index-empty">{rows.length ? 'Nothing matches these filters.' : 'Completed outputs appear here — every take is a canvas object.'}</li>}
      </ul>
      <footer className="canvas-library-footer">
        <span>{visible.length} of {rows.length} outputs</span>
        <span>V cycles · timeline → library → canvas · projections inherit the no-silent-failure contract</span>
      </footer>
    </div>
  </div>
}
