/** Community prompt library: searches Civitai's public generation metadata
 *  (withMeta) through the server's pinned proxy route and inserts harvested
 *  prompts into the composer. Metadata (seed/sampler/steps) is shown for
 *  study; only the prompt text is inserted. */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, LoaderCircle, Search, Sparkles, X } from 'lucide-react'
import type { PromptLibraryItem } from '../types'

const SORTS = ['Most Reactions', 'Most Comments', 'Newest', 'Oldest']

export function PromptLibraryBrowser({ onClose, onInsert }: { onClose(): void; onInsert(prompt: string, item: PromptLibraryItem): void }) {
  const [text, setText] = useState('')
  const [nsfw, setNsfw] = useState(false)
  const [scope, setScope] = useState<'h3' | 'all'>('h3')
  const [sort, setSort] = useState(SORTS[0])
  const [items, setItems] = useState<PromptLibraryItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [insertedId, setInsertedId] = useState('')

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

  const insert = (item: PromptLibraryItem) => {
    onInsert(item.prompt, item)
    setInsertedId(item.id)
    window.setTimeout(() => setInsertedId(''), 1400)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="prompt-library-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-library-title">
        <header>
          <div><span><Sparkles size={18} /></span><div><small>COMMUNITY</small><strong id="prompt-library-title">Prompt library</strong><p>Harvested from public Civitai generation metadata through the local server. Study the settings, insert the prompt, then adapt it to your shot.</p></div></div>
          <button type="button" aria-label="Close prompt library" onClick={onClose}><X size={18} /></button>
        </header>
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
                {item.username && <span>by {item.username}</span>}
                {item.steps !== undefined && <span>{item.steps} steps</span>}
                {item.sampler && <span>{item.sampler}</span>}
                {item.cfgScale !== undefined && <span>CFG {item.cfgScale}</span>}
                {item.width && item.height && <span>{item.width}×{item.height}</span>}
                {item.stats?.voteCount !== undefined && <span>{item.stats.voteCount} reactions</span>}
              </div>
              <button type="button" className={insertedId === item.id ? 'primary-button inserted' : 'primary-button'} onClick={() => insert(item)}>{insertedId === item.id ? <><Check size={14} />Inserted</> : 'Insert prompt'}</button>
            </article>
          ))}
        </div>
        {cursor && <button type="button" className="secondary-button prompt-library-more" onClick={() => void run(cursor)} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button>}
      </section>
    </div>
  )
}
