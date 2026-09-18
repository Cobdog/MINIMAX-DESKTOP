/**
 * The surface registry (QOL wave, rrxlw2r, 2026-09-18) — the single place a
 * top-level SURFACE of the studio declares itself. A surface is a route the
 * user switches between from the shared titlebar chrome (SurfaceSwitcher);
 * dev/companion routes (?mobile=1, ?proto=, ?poserig=1) are NOT surfaces and
 * stay in main.tsx.
 *
 * Registering a surface = appending ONE entry here. The switcher renders it,
 * Alt+<its position> jumps to it, and main.tsx resolves it — no nav edits
 * anywhere else, so surfaces land independently without nav conflicts.
 *
 * APPEND POINT — the images workbench (?images=1, spec docs/specs/) appends
 * here when it lands, e.g.:
 *
 *   {
 *     id: 'images', label: 'Images', short: 'images', href: '/?images=1',
 *     icon: ImagePlus, default: false,
 *     matches: (params) => params.get('images') === '1',
 *     component: lazy(() => import('../images/ImagesApp').then((m) => ({ default: m.ImagesApp }))),
 *   },
 */
import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import { Database, Frame } from 'lucide-react'

export type Surface = {
  /** Stable id (also the switcher's data-surface value). */
  id: string
  /** Switcher label (title attribute carries the Alt accelerator). */
  label: string
  /** Compact label rendered in the titlebar. */
  short: string
  /** URL that boots this surface (query params preserved nowhere — a switch
   * is a fresh surface, the house's full-navigation precedent). */
  href: string
  icon: ComponentType<{ size?: number }>
  /** The default surface: matched only when nothing else is. */
  default?: boolean
  /** True when the current URL is this surface. */
  matches: (params: URLSearchParams) => boolean
  /** The route's lazy component (own chunk — the poserig precedent). */
  component: LazyExoticComponent<ComponentType>
}

// The dataset manager (sv14rt0): own surface at ?datasets=1.
const DatasetsApp = lazy(() => import('../datasets/DatasetsApp').then((m) => ({ default: m.DatasetsApp })))

// Canvas Phase 5 (7mcp11b): the canvas IS the app — the default route.
// ?canvas=1 stays a harmless alias (matches() never requires it).
const CanvasApp = lazy(() => import('../canvas/CanvasApp').then((m) => ({ default: m.CanvasApp })))

/** Registered surfaces, switcher order. The default surface sits LAST so
 * explicit matches win; the switcher renders them in array order regardless. */
export const SURFACES: Surface[] = [
  { id: 'canvas', label: 'Canvas', short: 'canvas', href: '/', icon: Frame, default: true, matches: () => true, component: CanvasApp },
  { id: 'datasets', label: 'Dataset manager', short: 'datasets', href: '/?datasets=1', icon: Database, matches: (params) => params.get('datasets') === '1', component: DatasetsApp },
  // ← APPEND new surfaces above this line (see the header's append-point note).
]

/** The surface the current URL selects — first explicit match wins, else the
 * default. Non-surface routes (?mobile/?proto/?poserig) are resolved by
 * main.tsx BEFORE this and never reach it. */
export function resolveSurface(params: URLSearchParams): Surface {
  const explicit = SURFACES.find((surface) => !surface.default && surface.matches(params))
  return explicit ?? SURFACES.find((surface) => surface.default) ?? SURFACES[0]
}

/** The surface for a switcher position (Alt+1..9). */
export function surfaceAt(index: number): Surface | null {
  return SURFACES[index] ?? null
}
