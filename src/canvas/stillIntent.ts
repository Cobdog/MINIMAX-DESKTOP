/** The canvas image intent as engine ops (task 34afx79, 2026-09-19) — the
 * pure seam between chain settings and the image engines. Z-Image is
 * RETIRED here (lib/zImageSubmit.ts deleted): the stills intent renders
 * through the H3 image workbench's own machinery — the h3image Generate-T=1
 * family (one latent frame, the Mamad8 T=1 VAE, the pinned Fast recipe)
 * submitted through the SHARED workbench core (src/images/submit.ts), so a
 * canvas still lands takes exactly like any chain (the packet-aware landing
 * branch). Nothing here touches a store or the DOM's render tree — every
 * fact arrives as data, which is what makes the seam VM-harness testable.
 *
 * Two dated decisions live in this file:
 *
 *  1. THE TWO-SLOT ENGINE SEAM — the intent's engine is chain state
 *     (`imageEngine`): 'h3-1f' wired today; 'krea2' is the typed hole for
 *     the Krea 2 stills engine (mf3wfq6, queued) — it docks into
 *     submitChain's switch without another rewire. Until it lands the hole
 *     refuses HONESTLY (never silently falls back).
 *  2. THE EDIT HANDOFF — image-with-reference work (the old control/canny
 *     surface, 2026-09-19) is the workbench Edit surface's job, not a
 *     canvas graph: the canvas stashes the bound image + intent and routes
 *     to ?images=1 where it lands anchored as the Edit source (Picture 1).
 *     The dead ControlNet-Union-on-Z-Image path is gone with Z-Image.
 */
import type { MediaFile } from '../types'
import { engineFamilyForChain } from '../lib/graph/engineFamilies'
import type { CanvasChainSettings } from './generation'
import type { WorkbenchGenerationRequest } from '../images/submit'

/** The h3image family the H3-1F engine renders (the Generate-T=1 Fast
 * profile — H3IMG_RECIPE_PINS.t1 is the pinned recipe). */
export const H3_ONE_FRAME_FAMILY = 'h3img.generate.t1'

/** The localStorage key carrying the canvas→workbench Edit handoff (the
 * poserig inbox precedent — a convenience key, full-navigation handoff). */
export const CANVAS_EDIT_HANDOFF_KEY = 'h3img-canvas-handoff'

/** What the canvas hands to the workbench's Edit surface. */
export type CanvasEditHandoff = {
  /** The bound image's servable path (an output-contained artifact or a
   *  canvas-blobs/ relative — the same shapes mediaForOutput yields). */
  path: string
  name: string
  /** The chain's prompt becomes the Edit intent. */
  intent: string
}

/** The honest refusal for a queued engine slot (the typed hole's other half
 *  — the switch case exists, the engine does not yet). Registry-driven
 *  (A-3): the refusal copy lives on the engine-family ENTRY, so docking the
 *  engine is one entry edit, not a stillIntent change. */
export function queuedImageEngineRefusal(engine: 'h3-1f' | 'krea2'): string | null {
  return engineFamilyForChain({ mediaType: 'image', imageEngine: engine })?.queuedRefusal ?? null
}

/** The canvas chain settings as one H3-1F workbench generation — the same
 * request shape the workbench surface builds, so validation, the graph, the
 * manifest, and the landing are ONE code path. The tier is PROFILE-DERIVED
 * (the submit core pins T=1 to its single frame); seed and resolution ride
 * the chain settings exactly like an H3 video render. */
export function canvasH3OneFrameRequest(chainId: string, settings: Pick<CanvasChainSettings, 'prompt' | 'seed' | 'resolution'>): WorkbenchGenerationRequest {
  return {
    chainId,
    settings: {
      family: H3_ONE_FRAME_FAMILY,
      intent: settings.prompt,
      tier: 5,
      keepDial: 0.55,
      seed: settings.seed,
      resolution: settings.resolution,
      loras: [],
      refs: [],
      semanticOverflow: false,
      framePicks: {},
      refineEngine: '',
      poserigInbox: null,
    },
    refs: [],
    source: null,
  }
}

/** The handoff payload for the image+control intent (a bound image on an
 *  image chain). The preview is NOT serialized — a data-URL preview would
 *  blow the localStorage budget; the workbench derives a servable URL. */
export function canvasEditHandoff(intent: string, source: MediaFile): CanvasEditHandoff {
  return { path: source.path, name: source.name, intent }
}

/** Stashes the handoff (full-navigation payload — the surface-switcher
 *  precedent carries it across the page load). */
export function stashCanvasEditHandoff(handoff: CanvasEditHandoff): void {
  try {
    window.localStorage.setItem(CANVAS_EDIT_HANDOFF_KEY, JSON.stringify(handoff))
  } catch {
    /* a full localStorage is the user's bigger problem; the handoff is a
     * convenience key and the Edit surface remains reachable by hand */
  }
}

/** The servable URL of a handoff path (the landing loop's frameUrl rule:
 *  blob route for content-addressed artifacts, output media route else). */
export function handoffPreviewUrl(path: string): string {
  if (path.startsWith('canvas-blobs/')) return `/api/lan/documents/blobs/file?path=${encodeURIComponent(path)}`
  return `/api/lan/media?source=output&path=${encodeURIComponent(path)}`
}
