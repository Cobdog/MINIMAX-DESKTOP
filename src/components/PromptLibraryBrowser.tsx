/** Community + saved prompt library. The Community tab searches Civitai's
 *  public generation metadata (withMeta) through the server's pinned proxy;
 *  the Saved tab lists from the server's SQLite store (saved_prompts +
 *  FTS5), with the legacy localStorage library as the offline fallback.
 *  Metadata (seed/sampler/steps) is imported for study; only prompt text is
 *  inserted into the composer. */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Bookmark, Check, LoaderCircle, Search, Sparkles, Trash2, X } from 'lucide-react'
import type { PromptLibraryItem } from '../types'
import { PROMPT_LIBRARY_EVENT, deletePromptEntry, loadPromptLibrary, savePromptEntry, type SavedPromptEntry } from '../lib/promptLibraryStorage'
import { deleteServerPromptEntry, saveServerPromptEntries, searchSavedPrompts } from '../lib/serverStorage'

const SORTS = ['Most Reactions', 'Most Comments', 'Newest', 'Oldest']

export function PromptLibraryBrowser({ onClose, onInsert }: { onClose(): void; onInsert(prompt: string, item: PromptLibraryItem): void }) {
  const [tab, setTab] = useState<'community' | 'saved'>('community')
  const [text, setText] = useState('')
  const [nsfw, setNsfw] = useState(false)
  const [scope, setScope] = useState<'h3' | 'all'>('h3')
  const [sort, setSort] = useState(SORTS[0])
  const [items, setItems] = useState<PromptLibraryItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [insertedId, setInsertedId] = useState('')
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set())
  const [library, setLibrary] = useState<SavedPromptEntry[]>(loadPromptLibrary)
  const [savedFilter, setSavedFilter] = useState('')

  // Saved library: server store first (techniques are seeded server-side);
  // the localStorage library keeps the tab working when the API is down.
  const refreshSaved = useCallback(() => {
    void searchSavedPrompts('', 500)
      .then((entries) => {
        setLibrary(entries)
        setSavedIds(new Set(entries.filter((entry) => entry.source?.kind === 'civitai').map((entry) => entry.source!.itemId)))
      })
      .catch(() => {
        const next = loadPromptLibrary()
        setLibrary(next)
        setSavedIds(new Set(next.filter((entry) => entry.source?.kind === 'civitai').map((entry) => entry.source!.itemId)))
      })
  }, [])

  useEffect(() => {
    refreshSaved()
    const onChange = () => refreshSaved()
    window.addEventListener(PROMPT_LIBRARY_EVENT, onChange)
    return () => window.removeEventListener(PROMPT_LIBRARY_EVENT, onChange)
  }, [refreshSaved])

  const run = useCallback(async (nextCursor?: string) => {
    setLoading(true)
    setError('')
    try {
      const result = await window.minimax.listPromptLibrary({ text: text.trim() || undefined, limit: 24, cursor: nextCursor, nsfw, sort, scope })
      setItems((current) => nextCursor ? [...current, ...result.items] : result.items)
      setCursor(result.cursor)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      if (!nextCursor) setItems([])
    } finally {
      setLoading(false)
    }
  }, [nsfw, scope, sort, text])

  useEffect(() => {
    void run()
    // Load on mount only; search is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const flash = (id: string) => {
    setInsertedId(id)
    window.setTimeout(() => setInsertedId(''), 1400)
  }

  const insertCommunity = (item: PromptLibraryItem) => {
    onInsert(item.prompt, item)
    flash(item.id)
  }

  const study = (item: PromptLibraryItem) => {
    const entry: Omit<SavedPromptEntry, 'savedAt'> = {
      id: `civitai.${item.id}`,
      label: item.prompt.slice(0, 60).replace(/\s+/g, ' '),
      prompt: item.prompt,
      negativePrompt: item.negativePrompt,
      seed: item.seed,
      sampler: item.sampler,
      steps: item.steps,
      cfgScale: item.cfgScale,
      source: { kind: 'civitai', itemId: item.id, username: item.username },
    }
    void saveServerPromptEntries([{ ...entry, savedAt: Date.now() }])
      .then(refreshSaved)
      .catch(() => savePromptEntry(entry)) // Offline fallback: the legacy store (and its change event) refresh the list.
    flash(`save-${item.id}`)
  }

  const removeEntry = (entry: SavedPromptEntry) => {
    void deleteServerPromptEntry(entry.id)
      .then(refreshSaved)
      .catch(() => deletePromptEntry(entry.id)) // Offline fallback.
  }

  const filteredLibrary = savedFilter.trim()
    ? library.filter((entry) => `${entry.label} ${entry.prompt}`.toLowerCase().includes(savedFilter.trim().toLowerCase()))
    : library

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="prompt-library-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-library-title">
        <header>
          <div><span><Sparkles size={18} /></span><div><small>PROMPT LIBRARY</small><strong id="prompt-library-title">Community &amp; saved prompts</strong><p>Harvest public Civitai generation metadata through the local server, study its settings, and keep what works. Technique starters included.</p></div></div>
          <button type="button" aria-label="Close prompt library" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="prompt-library-tabs" role="tablist" aria-label="Library source">
          <button type="button" role="tab" aria-selected={tab === 'community'} className={tab === 'community' ? 'selected' : ''} onClick={() => setTab('community')}>Community</button>
          <button type="button" role="tab" aria-selected={tab === 'saved'} className={tab === 'saved' ? 'selected' : ''} onClick={() => setTab('saved')}>Saved ({library.length})</button>
        </div>
        {tab === 'community' ? (
          <>
            <div className="prompt-library-controls">
              <div className="select-wrap grow"><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Search community prompts…" onKeyDown={(event) => { if (event.key === 'Enter') void run() }} aria-label="Search community prompts" /></div>
              <div className="select-wrap"><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort">{SORTS.map((option) => <option key={option} value={option}>{option}</option>)}</select></div>
              <label className="prompt-library-nsfw" title="Restrict results to generations made with MiniMax H3"><input type="checkbox" checked={scope === 'h3'} onChange={(event) => setScope(event.target.checked ? 'h3' : 'all')} />H3 only</label>
              <label className="prompt-library-nsfw" title="Include adult-rated results"><input type="checkbox" checked={nsfw} onChange={(event) => setNsfw(event.target.checked)} />Adult</label>
              <button type="button" className="primary-button" onClick={() => void run()} disabled={loading}>{loading ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}Search</button>
            </div>
            {error && <div className="prompt-library-error" role="alert"><AlertCircle size={15} />{error}</div>}
            <div className="prompt-library-results">
              {items.length === 0 && !loading && !error && <div className="prompt-library-empty"><strong>No prompts matched.</strong><span>Try a different search or sort.</span></div>}
              {items.map((item) => (
                <article className="prompt-library-item" key={item.id}>
                  <p>{item.prompt.length > 420 ? `${item.prompt.slice(0, 420)}…` : item.prompt}</p>
                  <div>
                    {item.username && <span>by {item.username} · civitai #{item.id}</span>}
                    {item.steps !== undefined && <span>{item.steps} steps</span>}
                    {item.sampler && <span>{item.sampler}</span>}
                    {item.cfgScale !== undefined && <span>CFG {item.cfgScale}</span>}
                    {item.width && item.height && <span>{item.width}×{item.height}</span>}
                    {item.stats?.voteCount !== undefined && <span>{item.stats.voteCount} reactions</span>}
                  </div>
                  <div className="prompt-library-item-actions">
                    <button type="button" className="secondary-button" title="Save prompt + settings into the local library for reuse" onClick={() => study(item)} disabled={savedIds.has(item.id)}>{savedIds.has(item.id) ? <><Check size={13} />Saved</> : <><Bookmark size={13} />Study &amp; save</>}</button>
                    <button type="button" className={insertedId === item.id ? 'primary-button inserted' : 'primary-button'} onClick={() => insertCommunity(item)}>{insertedId === item.id ? <><Check size={14} />Inserted</> : 'Insert prompt'}</button>
                  </div>
                </article>
              ))}
            </div>
            {cursor && <button type="button" className="secondary-button prompt-library-more" onClick={() => void run(cursor)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>}
            <footer className="prompt-library-attribution">Community prompts come from Civitai and remain their creators’ content under Civitai’s Terms of Service — credit “{items[0]?.username ? `${items[0].username} on Civitai` : '<creator> on Civitai'}” style attribution when sharing derived work, and check each referenced model’s license before commercial use.</footer>
          </>
        ) : (
          <>
            <div className="prompt-library-controls">
              <div className="select-wrap grow"><input value={savedFilter} onChange={(event) => setSavedFilter(event.target.value)} placeholder="Filter saved prompts and techniques…" aria-label="Filter saved prompts" /></div>
            </div>
            <div className="prompt-library-results">
              {filteredLibrary.length === 0 && <div className="prompt-library-empty"><strong>Nothing saved yet.</strong><span>Use “Study &amp; save” on a community prompt, or start from a technique.</span></div>}
              {filteredLibrary.map((entry) => (
                <article className="prompt-library-item" key={entry.id} data-technique={entry.technique ? 'true' : undefined}>
                  <div className="prompt-library-saved-heading">
                    {entry.technique && <span className="prompt-library-technique-badge" title="Bundled technique starter from fal’s H3 prompting guide (paraphrased)">technique</span>}
                    <strong title={entry.prompt}>{entry.label}</strong>
                    {entry.source?.kind === 'civitai' && <small>{entry.source.username ? `by ${entry.source.username} · ` : ''}civitai #{entry.source.itemId}</small>}
                  </div>
                  <p>{entry.prompt.length > 360 ? `${entry.prompt.slice(0, 360)}…` : entry.prompt}</p>
                  <div>
                    {entry.negativePrompt && <span>negative present</span>}
                    {entry.steps !== undefined && <span>{entry.steps} steps</span>}
                    {entry.sampler && <span>{entry.sampler}</span>}
                    {entry.seed !== undefined && <span>seed {entry.seed}</span>}
                    {entry.cfgScale !== undefined && <span>CFG {entry.cfgScale}</span>}
                  </div>
                  <div className="prompt-library-item-actions">
                    {!entry.technique && <button type="button" className="icon-button" aria-label={`Remove ${entry.label}`} onClick={() => removeEntry(entry)}><Trash2 size={14} /></button>}
                    <button type="button" className={insertedId === entry.id ? 'primary-button inserted' : 'primary-button'} onClick={() => { onInsert(entry.prompt, { id: entry.id, prompt: entry.prompt }); flash(entry.id) }}>{insertedId === entry.id ? <><Check size={14} />Inserted</> : 'Insert prompt'}</button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
