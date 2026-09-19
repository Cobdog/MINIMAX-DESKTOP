/**
 * Canvas Phase 5 — the Studios dock: the kept surfaces' canvas home (§8).
 *
 * The old shell and its nav model are deleted; these five surfaces survive
 * HERE because their AUTHORING capability has no canvas-native home yet —
 * the canvas already carries their READ side (canvas_asset projection,
 * properties-panel binding, fork-into-project), and their generation flows
 * submit through the SAME extracted cores the canvas uses. Dated decisions:
 *
 * - Characters / Hair / Wardrobe / Accessories / Locations (2026-09-17,
 *   Phase 5 deletion wave) — the global-asset AUTHORING studios (inventory
 *   rows 16–20, REFACTOR-ABSORB): their identity flows (batch → approve →
 *   survey → extract) become canvas macros when the macro/asset-authoring
 *   work lands (Phase 6 candidate); until then they dock here rather than
 *   dying silently.
 * - Movie (MoviePlanner) — RETIRED 2026-09-17 (Phase 5b): the Director Suite
 *   landed as plan documents + the timeline projection (canvas/plan.ts +
 *   TimelineOverlay — the planning surface), so the ancestor's dock tab
 *   died. Parity carried over: brief + segments + per-segment reference
 *   handoffs + the consent-gated seeding (seedSegmentChain writes the
 *   chain_ref back into the plan) + the latent episode render (the
 *   scene-chain successor, submitPlanEpisode). NOT ported — the Ollama
 *   copilot chat (LLM brief→shots revisions): named retirement gap, queued
 *   as Phase 6 plan-copilot work (the LLM surface itself survives app-wide).
 *
 * The pattern is Phase 4's SettingsDock: react-rnd panel fed from the canvas
 * route's session context (one poller), stores shared D1/D2 — the studios
 * read/write the SAME library stores the canvas projects into canvas_asset.
 */
import { Suspense, lazy, useContext, useMemo } from 'react'
import { Rnd } from 'react-rnd'
import { Clapperboard, X } from 'lucide-react'
import { resolveModelOverrides, resolveModels } from '../lib/modelOverrides'
import { inferSelections } from '../lib/modelSelection'
import { submitH3Render } from '../lib/h3Submit'
import { locationWalkthroughRequest } from '../lib/locationWalkthrough'
import { submitCharacterContactSheet } from '../lib/contactSheetSubmit'
import { findH3PreviewOverrideNode } from '../lib/h3Stack'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { useSessionStore } from '../state/sessionStore'
import { useJobsStore } from '../state/jobsStore'
import { CanvasSessionContext } from './sessionContext'
import { engineBridge, useCanvasStore, type StudiosDockTab } from './store'

// Heavy studio surfaces stay lazy chunks (the old shell's discipline — the
// canvas bundle never pays for a studio until its tab opens).
const CharacterStudio = lazy(() => import('../components/CharacterStudio').then((m) => ({ default: m.CharacterStudio })))
const HairStudio = lazy(() => import('../components/HairStudio').then((m) => ({ default: m.HairStudio })))
const WardrobeStudio = lazy(() => import('../components/WardrobeStudio').then((m) => ({ default: m.WardrobeStudio })))
const AccessoryStudio = lazy(() => import('../components/AccessoryStudio').then((m) => ({ default: m.AccessoryStudio })))
const LocationStudio = lazy(() => import('../components/LocationStudio').then((m) => ({ default: m.LocationStudio })))

const TABS: Array<{ id: StudiosDockTab; label: string }> = [
  { id: 'characters', label: 'Characters' },
  { id: 'hair', label: 'Hair' },
  { id: 'wardrobes', label: 'Wardrobe' },
  { id: 'accessories', label: 'Accessories' },
  { id: 'locations', label: 'Locations' },
]

const viewFallback = <div className="canvas-studios-fallback">Loading…</div>

export function StudiosDock() {
  const dock = useCanvasStore((state) => state.studiosDock)
  const setStudiosDock = useCanvasStore((state) => state.setStudiosDock)
  const toast = useCanvasStore((state) => state.toast)
  const context = useContext(CanvasSessionContext)
  const jobs = useJobsStore((state) => state.jobs)

  const notify = (tone: 'error' | 'success' | 'neutral', text: string) => toast(tone, text)
  const setJobs = (update: (current: import('../types').GenerationJob[]) => import('../types').GenerationJob[]) => useJobsStore.getState().setJobs(update)

  const llmDescriptor = useSessionStore((state) => state.llm)
  const ollamaModels = context?.session.ollamaModels ?? []

  const selection = useMemo(
    () => resolveModels('minimax', inferSelections(context?.session.models ?? [], 'off'), context?.session.models ?? [], context?.session.settings?.modelOverrides?.minimax).selection,
    [context?.session.models, context?.session.settings?.modelOverrides?.minimax],
  )

  if (!dock || !context) return null
  const { session } = context
  const { settings, models, status } = session
  if (!settings) return null

  const llmAvailable = llmDescriptor ? llmDescriptor.connected && Boolean(llmDescriptor.model) : ollamaModels.length > 0
  const modelReady = Boolean(status.connected && selection.fl2va && selection.ref2va && selection.textEncoder && selection.videoVae && selection.audioVae)
  // The override resolution rides the facts like the canvas submit path — a
  // wrong-kind pick refuses the walkthrough/contact-sheet submits too.
  const overrideResolution = resolveModelOverrides('minimax', models, settings.modelOverrides?.minimax)
  const facts = { settings, connected: status.connected, modelReady, selection, models, info: session.info, clientId: engineBridge.clientId, h3PreviewOverrideNode: findH3PreviewOverrideNode(session.info) || undefined, modelOverrides: overrideResolution }

  return <Rnd
    className="canvas-settings-dock"
    data-canvas-studios-dock
    default={{ x: 96, y: 84, width: 880, height: Math.min(820, window.innerHeight - 140) }}
    minWidth={520}
    minHeight={320}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <Clapperboard size={13} />
      <strong>Studios — asset authoring</strong>
      <nav className="canvas-studios-tabs" aria-label="Studio surfaces">
        {TABS.map((tab) => (
          <button key={tab.id} type="button" className={`canvas-chip ${dock.tab === tab.id ? 'active' : ''}`} data-canvas-studios-tab={tab.id} onClick={() => setStudiosDock({ tab: tab.id })}>{tab.label}</button>
        ))}
      </nav>
      <button type="button" aria-label="Close studios" data-canvas-studios-close onClick={() => setStudiosDock(null)}><X size={13} /></button>
    </header>
    <div className="canvas-settings-body canvas-studios-body" data-canvas-studios-body>
      {/* Per-tab boundary (keyed by tab — switching tabs remounts fresh, the
          old shell's per-view discipline): one crashing studio never takes
          the canvas or its sibling tabs down. */}
      <ErrorBoundary key={dock.tab} label="studios">
      {dock.tab === 'characters' && <Suspense fallback={viewFallback}><CharacterStudio
        settings={settings}
        info={session.info}
        connected={status.connected}
        ollamaAvailable={llmAvailable}
        automationJob={jobs.find((job) => job.characterProjectId)}
        onNotice={notify}
        // Phase-4 cleanup (6rymbx3 inherited): the ContactSheet nodes +
        // turnaround LoRA are REQUIRED — the transitional LTX survey fallback
        // died with the old shell; absent nodes refuse honestly.
        onCreateTurntable={(project) => submitCharacterContactSheet(project, { settings, connected: status.connected, models, selection, clientId: engineBridge.clientId }, { notify, setJobs })}
      /></Suspense>}
      {dock.tab === 'hair' && <Suspense fallback={viewFallback}><HairStudio settings={settings} info={session.info} connected={status.connected} ollamaAvailable={llmAvailable} onNotice={notify} /></Suspense>}
      {dock.tab === 'wardrobes' && <Suspense fallback={viewFallback}><WardrobeStudio settings={settings} info={session.info} connected={status.connected} onNotice={notify} /></Suspense>}
      {dock.tab === 'accessories' && <Suspense fallback={viewFallback}><AccessoryStudio settings={settings} info={session.info} connected={status.connected} onNotice={notify} /></Suspense>}
      {dock.tab === 'locations' && <Suspense fallback={viewFallback}><LocationStudio
        settings={settings}
        info={session.info}
        connected={status.connected}
        ollamaAvailable={llmAvailable}
        automationJob={jobs.find((job) => job.locationProjectId)}
        onNotice={notify}
        // Phase-4 migration: the walkthrough renders through H3 Ref2V (the
        // approved image rides <Picture 1> via the shared submit core).
        onCreateWalkthrough={(project, options) => {
          if (!project.baseImage) return Promise.resolve('Approve a location image before rendering the walkthrough.')
          const approvedImage = { ...project.baseImage }
          delete approvedImage.preview
          return submitH3Render(
            { ...locationWalkthroughRequest(project, approvedImage, Math.floor(Math.random() * 1_000_000_000), options), locationProjectId: project.id },
            facts,
            { notify, setJobs, cancellationRequests: engineBridge.cancellationRequests ?? { current: new Set<string>() } },
          ).then((result) => result.ok ? null : result.message)
        }}
      /></Suspense>}
      </ErrorBoundary>
    </div>
  </Rnd>
}
