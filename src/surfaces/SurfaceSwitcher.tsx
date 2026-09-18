/**
 * SurfaceSwitcher (QOL wave, rrxlw2r, 2026-09-18) — the shared titlebar
 * chrome that lists every REGISTERED surface (src/surfaces/registry.ts).
 * Rendered by each surface's own titlebar (canvas Radar, datasets ds-titlebar)
 * so the switcher is present wherever the user is — one registry, no per-
 * surface nav lists to drift apart.
 *
 * Keyboard: real links (Tab + Enter), plus Alt+1..9 per switcher position.
 * The accelerator never fires while typing, and the canvas's own key
 * handler ignores Alt-modified keys (CanvasApp's dated guard) — no fights.
 */
import { useEffect } from 'react'
import { SURFACES, resolveSurface, surfaceAt } from './registry'
import './surfaces.css'

export function SurfaceSwitcher() {
  const active = resolveSurface(new URLSearchParams(window.location.search))

  // Alt+1..9 → the surface at that switcher position. Registered on window
  // next to the canvas's own keys; both sides gate on typing + Alt.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return
      if (!/^[1-9]$/.test(event.key)) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const surface = surfaceAt(Number(event.key) - 1)
      if (!surface || surface.id === active.id) return
      event.preventDefault()
      window.location.assign(surface.href)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active.id])

  return <nav className="surface-switcher" aria-label="Surfaces" data-surface-switcher>
    {SURFACES.map((surface, index) => {
      const Icon = surface.icon
      const current = surface.id === active.id
      return <a
        key={surface.id}
        className={`surface-switch ${current ? 'active' : ''}`}
        data-surface={surface.id}
        href={surface.href}
        aria-current={current ? 'page' : undefined}
        title={`${surface.label} (Alt+${index + 1})`}
      >
        <Icon size={12} />
        <span>{surface.short}</span>
      </a>
    })}
  </nav>
}
