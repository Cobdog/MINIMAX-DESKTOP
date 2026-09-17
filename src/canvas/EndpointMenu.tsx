/**
 * Canvas Phase 2 — the typed-hole menu (§3 option menus).
 *
 * Opens on a tile's head (consume-from) or tail (produce-into) endpoint. The
 * rows come from the pure options module — type-directed over the source
 * media kinds, availability-aware (registry/LSX-2.3 detection + install
 * guidance), with the parameter hints in-menu. L19: category visible, the
 * type-natural generation routes lead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useCanvasStore } from './store'
import { endpointOptions, type SourceKind } from './options'
import type { DocumentChain } from './derive'

/** The source media kinds an output tile carries (its canonical take). */
function sourceKindsOf(chain: DocumentChain | undefined): SourceKind[] {
  const take = chain?.outputs.flatMap((output) => output.takes).find((entry) => entry.supersededBy === null) ?? null
  const kind = take?.metrics?.kind
  if (kind === 'image' || kind === 'video' || kind === 'audio') return [kind]
  return chain?.kind === 'media' ? ['image'] : []
}

export function EndpointMenu() {
  const menu = useCanvasStore((state) => state.endpointMenu)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const selection = useCanvasStore((state) => state.selection)
  const tiles = useCanvasStore((state) => state.tiles)
  const setEndpointMenu = useCanvasStore((state) => state.setEndpointMenu)
  const runEndpointAction = useCanvasStore((state) => state.runEndpointAction)
  const optionAvailability = useCanvasStore((state) => state.optionAvailability)
  const ref = useRef<HTMLDivElement>(null)
  const [clampedTop, setClampedTop] = useState<number | null>(null)

  useEffect(() => {
    if (menu && ref.current) ref.current.focus()
  }, [menu])

  const context = useMemo(() => {
    if (!menu) return null
    const doc = activeProjectId ? documents[activeProjectId] : null
    const chain = doc?.chains.find((entry) => entry.id === menu.chainId)
    const tile = tiles.find((entry) => entry.id === menu.chainId)
    // The consume direction acts on the SELECTED source (another tile); the
    // produce direction acts on THIS tile's output.
    const sourceChainId = selection.tileIds.find((id) => id !== menu.chainId) ?? null
    const kinds = menu.direction === 'produce' ? sourceKindsOf(chain) : sourceKindsOf(doc?.chains.find((entry) => entry.id === sourceChainId))
    return { chain, tile, sourceChainId, kinds }
  }, [activeProjectId, documents, menu, selection.tileIds, tiles])

  // F8 (judge-confirmed twice, cleanup wave twmpu4m): menus opened on a tile
  // near the viewport bottom extended below the fold — rows and the footer
  // were unreachable. After the menu renders, measure its REAL height and
  // clamp the top so the whole menu sits inside the viewport (the body's
  // internal scroll covers a menu taller than the viewport). Runs before
  // paint, so the clamped position is what the user sees on open.
  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setClampedTop(null)
      return
    }
    const margin = 12
    const rect = ref.current.getBoundingClientRect()
    const overflow = rect.bottom - (window.innerHeight - margin)
    setClampedTop(overflow > 0 ? Math.max(margin, rect.top - overflow) : null)
  }, [menu, context, optionAvailability])

  if (!menu || !context) return null
  const options = endpointOptions(menu.direction, context.kinds, optionAvailability())
  const hasOutput = Boolean(context.chain?.outputs.length)
  const naturalLeft = Math.min(Math.max(16, (context.tile?.x ?? 0) + (menu.direction === 'consume' ? -180 : (context.tile?.w ?? 0) - 40)), window.innerWidth - 300)
  const naturalTop = Math.max(64, (context.tile?.y ?? 0) + 24)

  return <div className="canvas-menu-backdrop" onClick={() => setEndpointMenu(null)}>
    <div
      ref={ref}
      className="canvas-endpoint-menu"
      data-canvas-endpoint-menu={menu.direction}
      tabIndex={-1}
      role="dialog"
      aria-label={menu.direction === 'consume' ? 'Consume-from options' : 'Produce-into options'}
      style={{ left: naturalLeft, top: clampedTop ?? naturalTop }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === 'Escape') setEndpointMenu(null) }}
    >
      <header>
        <strong>{context.tile?.title ?? menu.chainId.slice(0, 8)}</strong>
        <span>{menu.direction === 'consume' ? 'consume from — inputs' : 'produce into — extensions'}</span>
      </header>
      <div className="canvas-menu-groups">
        {['generate', 'input', 'control', 'utility', 'fork'].map((group) => {
          const rows = options.filter((option) => option.group === group)
          if (!rows.length) return null
          return <div key={group} className="canvas-menu-group" data-canvas-menu-group={group}>
            <span className="canvas-menu-group-label">{group === 'generate' ? 'generate' : group === 'input' ? 'inputs' : group === 'control' ? 'control inputs' : group === 'utility' ? 'utilities' : 'fork'}</span>
            {rows.map((option) => (
              <button
                type="button"
                key={option.id}
                className={`canvas-menu-row ${option.available ? '' : 'unavailable'}`}
                data-canvas-menu-row={option.id}
                disabled={!option.available}
                title={[option.reason, option.available && menu.direction === 'consume' && !context.sourceChainId ? 'Select the object to consume from first.' : '', option.hint].filter(Boolean).join('\n')}
                onClick={() => void runEndpointAction(menu.chainId, menu.direction, option, context.sourceChainId ?? undefined)}
              >
                <span className="canvas-menu-row-label">{option.label}</span>
                <span className="canvas-menu-row-note">{option.available ? option.description : option.reason}</span>
                {option.hint && option.available && <span className="canvas-menu-row-hint">{option.hint}</span>}
              </button>
            ))}
          </div>
        })}
      </div>
      <footer>
        {menu.direction === 'produce' && !hasOutput && 'This object has no output yet — generate or drop media first.'}
        {menu.direction === 'consume' && !context.sourceChainId && 'Select the object to consume from, then open this menu.'}
        {((menu.direction === 'produce' && hasOutput) || (menu.direction === 'consume' && context.sourceChainId)) && 'Esc closes · hints show the parameter contracts'}
      </footer>
    </div>
  </div>
}
