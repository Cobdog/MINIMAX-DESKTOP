/**
 * The engine-family registry (remediation A-3 / Wave 3 rung 1, directive
 * c250ab36) — every RENDERABLE engine family as data, on the proven
 * OptimizationEntry discipline.
 *
 * THE PROBLEM THIS REPLACES: engines were if-branches across the shared
 * surfaces (the properties panel's mediaType/engine ternaries for the label,
 * the model-override family, and which sections render; stillIntent's
 * hardcoded queued-slot refusal; generation.ts's own IMAGE_ENGINES table) —
 * each engine arrival/removal was a cross-file excision and the modularity
 * contract ("pulling out a tool as easy as buying a new one") was
 * unenforceable in that shape.
 *
 * THE CONTRACT (mirrors registry.ts's optimization entries):
 *
 *  1. INSERT-ONLY — `registerEngineFamily(entry)` appends one engine; the
 *     selector, the panel's section gating, the image-engine choices, and
 *     the queued-slot refusals all read the live registry with zero
 *     component changes. Duplicate ids are rejected. Returns an unregister
 *     function so test scopes stay isolated.
 *
 *  2. INERTNESS — an entry that is absent (or removed) changes NOTHING for
 *     every other chain shape: the selector's answers for other settings
 *     are deep-equal to the baseline, and no surface grows a row for it.
 *     tests/engine-families.test.js proves both directions against a
 *     canonical-JSON snapshot.
 *
 * The per-node model dials (c250ab36 PART 1) become DATA here: each entry
 * states its model-override family and which panel sections exist, so the
 * chain-level dial surface is rendered from the entry — not from ternaries
 * that grow a branch per engine. What Settings declares stays the global
 * fallback layer; the chain (node) dial beats it, which beats auto — the
 * precedence is unchanged, only its surface became data-driven.
 */
import type { ModelFamilyId } from '../modelOverrides'

/** The chain-settings slice the selector reads — structural on purpose so
 *  the registry stays canvas-agnostic (canvas/generation.ts's full settings
 *  satisfy it; tests pass minimal objects). */
export type EngineChainSettingsLike = {
  mediaType: 'video' | 'image' | 'audio'
  /** The video engine discriminator (the documented 'h3' seam). */
  engine?: string
  /** The image engine discriminator (the two-slot typed hole). */
  imageEngine?: string
  /** The audio engine discriminator. */
  audio?: { engine?: string }
}

/** Which panel sections an engine's chains expose — data, not component
 *  ternaries. A false flag REMOVES controls the engine's render path never
 *  reads (the dead-control class the UX audit counted into the
 *  60-controls-before-the-fold problem): the tier/turbo/duration rows are
 *  video-contract dials, the audio dock owns the audio engine's real
 *  request settings, and image chains render through the workbench's own
 *  session settings (the global h3image override layer governs models
 *  there — chain-level model slots would be dead controls on that path). */
export type EnginePanelSections = {
  /** The speed-tier radio (quality / fast 4 / fast 8). */
  tier: boolean
  /** The registry-ranked turbo-family select. */
  turboFamily: boolean
  /** The per-node model dials (the c250ab36 rows). */
  models: boolean
  /** The duration field (the video clip length). */
  duration: boolean
  /** The output resolution select. */
  resolution: boolean
  /** The render seed. */
  seed: boolean
  /** The temporal LoRA timeline rail (video only). */
  loraTimeline: boolean
  /** The "edit in the audio dock…" handoff row. */
  audioDock: boolean
}

export type EngineFamilyEntry = {
  /** Stable id: '<mediaType>.<engineKey>'. */
  id: string
  /** Human label (the panel header + engine pickers). */
  label: string
  mediaType: 'video' | 'image' | 'audio'
  /** The engine-key value this entry binds to within its mediaType. */
  engineKey: string
  /** The model-override family the node-level dials resolve through. */
  modelFamilyId: ModelFamilyId
  /** One-line note the panel renders under the engine label. */
  note?: string
  /** A TYPED HOLE that refuses honestly instead of rendering (the krea2
   *  precedent — the switch case exists, the engine does not yet). */
  queuedRefusal?: string
  /** Which panel sections this engine's chains expose. */
  panel: EnginePanelSections
}

/** The video engine's full dial surface. */
const VIDEO_PANEL: EnginePanelSections = { tier: true, turboFamily: true, models: true, duration: true, resolution: true, seed: true, loraTimeline: true, audioDock: false }
/** Image chains render through the workbench session (its own settings own
 *  tier/LoRAs/duration); resolution + seed ride the chain settings through
 *  to the workbench request. */
const IMAGE_PANEL: EnginePanelSections = { tier: false, turboFamily: false, models: false, duration: false, resolution: true, seed: true, loraTimeline: false, audioDock: false }
/** Audio engines dial their real request settings in the audio dock; the
 *  model dials stay (the checkpoint/TE/VAE picks are family-level). */
const AUDIO_PANEL: EnginePanelSections = { tier: false, turboFamily: false, models: true, duration: false, resolution: false, seed: false, loraTimeline: false, audioDock: true }

const entries: EngineFamilyEntry[] = []

function register(entry: EngineFamilyEntry): void {
  if (entries.some((existing) => existing.id === entry.id)) throw new Error(`engine-family registry duplicate id '${entry.id}'`)
  entries.push(entry)
}

const STOCK_ENTRIES: EngineFamilyEntry[] = [
  {
    id: 'video.h3',
    label: 'MiniMax H3',
    mediaType: 'video',
    engineKey: 'h3',
    modelFamilyId: 'minimax',
    panel: VIDEO_PANEL,
  },
  {
    id: 'image.h3-1f',
    label: 'H3 1F (T=1 Fast)',
    mediaType: 'image',
    engineKey: 'h3-1f',
    modelFamilyId: 'h3image',
    note: 'One latent frame through the Mamad8 T=1 image VAE on the hybrid stack — seconds-class stills.',
    panel: IMAGE_PANEL,
  },
  {
    id: 'image.krea2',
    label: 'Krea 2 (still images)',
    mediaType: 'image',
    engineKey: 'krea2',
    modelFamilyId: 'h3image',
    note: 'Queued (mf3wfq6) — the stills-only Krea 2 path; not wired yet.',
    // The typed hole's honest refusal (the dated 34afx79 copy, now data —
    // docking the engine is one entry edit, not a stillIntent change).
    queuedRefusal: 'The Krea 2 stills engine is queued (mf3wfq6) and not wired yet — switch the image engine to H3 1F in the panel, or open the Image workbench for Krea 2 refine passes.',
    panel: IMAGE_PANEL,
  },
  {
    id: 'audio.music3',
    label: 'MiniMax Music 3',
    mediaType: 'audio',
    engineKey: 'music3',
    modelFamilyId: 'music3',
    panel: AUDIO_PANEL,
  },
  {
    id: 'audio.acestep',
    label: 'ACE-Step XL 1.5',
    mediaType: 'audio',
    engineKey: 'acestep',
    modelFamilyId: 'acestep',
    panel: AUDIO_PANEL,
  },
]

for (const entry of STOCK_ENTRIES) register(entry)

/** Snapshot of the registry at call time. */
export function engineFamilies(): readonly EngineFamilyEntry[] {
  return entries.slice()
}

/** Runtime registration for NEW entries (the painless-expansion path —
 *  proven in tests with a hypothetical engine). Returns an unregister
 *  function so scopes stay isolated. */
export function registerEngineFamily(entry: EngineFamilyEntry): () => void {
  register(entry)
  return () => {
    const index = entries.indexOf(entry)
    if (index >= 0) entries.splice(index, 1)
  }
}

/** The engine-key value a settings object selects, per mediaType — the
 *  tolerant defaults mirror readChainSettings (a missing discriminator
 *  falls back to the mediaType's first engine, never a crash). */
function engineKeyOf(settings: EngineChainSettingsLike): string {
  if (settings.mediaType === 'image') return settings.imageEngine ?? 'h3-1f'
  if (settings.mediaType === 'audio') return settings.audio?.engine ?? 'music3'
  return settings.engine ?? 'h3'
}

/** THE SELECTOR: the engine family a chain renders through. Replaces the
 *  per-surface mediaType/engine ternaries — every consumer (panel label,
 *  model-override family, section gating, queued-slot refusals) reads this
 *  one function. Unknown combinations return undefined (the caller's honest
 *  handling), never a silent fallback to another engine. */
export function engineFamilyForChain(settings: EngineChainSettingsLike | undefined | null): EngineFamilyEntry | undefined {
  if (!settings || typeof settings !== 'object' || typeof settings.mediaType !== 'string') return undefined
  const key = engineKeyOf(settings)
  return entries.find((entry) => entry.mediaType === settings.mediaType && entry.engineKey === key)
}

/** The image-engine choices the chain settings' imageEngine union renders —
 *  derived from the registry so the two-slot table and the registry cannot
 *  drift (generation.ts's IMAGE_ENGINES is this, cast to its literal-union
 *  settings type). */
export function imageEngineChoices(): Array<{ id: string; label: string; note: string }> {
  return entries
    .filter((entry) => entry.mediaType === 'image')
    .map((entry) => ({ id: entry.engineKey, label: entry.label, note: entry.note ?? '' }))
}
