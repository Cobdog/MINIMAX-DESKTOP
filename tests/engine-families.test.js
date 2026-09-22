/** Engine-family registry suite (remediation A-3, Wave 3 rung 1 — VM
 * harness, no engine). Probes the two contracts the registry exists to make
 * enforceable (the OptimizationEntry discipline carried to engines):
 *
 *  (a) SHAPE — the stock entries as a pinned table (label / model-override
 *      family / queued refusal / panel sections). The data IS the contract:
 *      a deliberate change edits the entry AND this table together.
 *  (b) SELECTOR — engineFamilyForChain across the chain-settings matrix,
 *      tolerant discriminator defaults, honest undefined for unknown keys
 *      (never a silent fallback to another engine).
 *  (c) INSERT-ONLY — a hypothetical engine registers, is selected by its
 *      discriminator alone, changes NOTHING else (deep-equal selector
 *      matrix + image choices before/after), and unregisters back to the
 *      exact baseline. Duplicate ids reject.
 *  (d) INERTNESS — an ABSENT entry changes nothing: unknown engine keys
 *      answer undefined while every other answer is unchanged; the
 *      removed-hypothetical state equals the pre-registration baseline
 *      byte-for-byte (canonical JSON).
 *  (e) CONSUMERS — the registry drives the real seams: the queued-slot
 *      refusal copy (stillIntent) and the derived IMAGE_ENGINES table
 *      (generation.ts) match the entries, so docking an engine is one
 *      entry edit with zero consumer changes.
 */
import { test } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const assert = require('node:assert/strict')
const { loadTs } = require('../scripts/lib/ts-vm.cjs')

const registry = loadTs('src/lib/graph/engineFamilies.ts')
const still = loadTs('src/canvas/stillIntent.ts', { window: { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } } })

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}
function eq(actual, expected, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), label)
  passed += 1
  console.log(`  ok - ${label}`)
}
function canon(value) {
  return JSON.stringify(value)
}

/** The pinned stock table — labels, model families, queued refusals, panel
 *  sections. Panel flags are ENGINE TRUTH (which dials the render path
 *  reads), not layout: tier/turbo/duration are the video contract's dials,
 *  the audio dock owns the audio engines' request settings, and image
 *  chains dial resolution+seed only (the workbench session owns the rest). */
const STOCK_TABLE = [
  { id: 'video.h3', label: 'MiniMax H3', mediaType: 'video', engineKey: 'h3', modelFamilyId: 'minimax', note: null, queuedRefusal: null,
    panel: { tier: true, turboFamily: true, models: true, duration: true, resolution: true, seed: true, loraTimeline: true, audioDock: false } },
  { id: 'image.h3-1f', label: 'H3 1F (T=1 Fast)', mediaType: 'image', engineKey: 'h3-1f', modelFamilyId: 'h3image', queuedRefusal: null,
    note: 'One latent frame through the Mamad8 T=1 image VAE on the hybrid stack — seconds-class stills.',
    panel: { tier: false, turboFamily: false, models: false, duration: false, resolution: true, seed: true, loraTimeline: false, audioDock: false } },
  { id: 'image.krea2', label: 'Krea 2 (still images)', mediaType: 'image', engineKey: 'krea2', modelFamilyId: 'h3image', note: 'Queued (mf3wfq6) — the stills-only Krea 2 path; not wired yet.',
    queuedRefusal: 'The Krea 2 stills engine is queued (mf3wfq6) and not wired yet — switch the image engine to H3 1F in the panel, or open the Image workbench for Krea 2 refine passes.',
    panel: { tier: false, turboFamily: false, models: false, duration: false, resolution: true, seed: true, loraTimeline: false, audioDock: false } },
  { id: 'audio.music3', label: 'MiniMax Music 3', mediaType: 'audio', engineKey: 'music3', modelFamilyId: 'music3', note: null, queuedRefusal: null,
    panel: { tier: false, turboFamily: false, models: true, duration: false, resolution: false, seed: false, loraTimeline: false, audioDock: true } },
  // (audio.acestep was removed with the engine, 2026-09-21 — nn5ld47; the
  // selector arm below now proves a stored acestep chain selects NOTHING,
  // same honest shape as the removed ltx.)
]

/** The selector matrix every inertness direction re-runs: one settings
 *  object per real shape + the tolerant/unknown edges. */
const SETTINGS_MATRIX = () => ([
  { settings: { mediaType: 'video' }, expected: 'video.h3' },
  { settings: { mediaType: 'video', engine: 'h3' }, expected: 'video.h3' },
  { settings: { mediaType: 'image' }, expected: 'image.h3-1f' },
  { settings: { mediaType: 'image', imageEngine: 'h3-1f' }, expected: 'image.h3-1f' },
  { settings: { mediaType: 'image', imageEngine: 'krea2' }, expected: 'image.krea2' },
  { settings: { mediaType: 'audio' }, expected: 'audio.music3' },
  { settings: { mediaType: 'audio', audio: {} }, expected: 'audio.music3' },
  { settings: { mediaType: 'audio', audio: { engine: 'music3' } }, expected: 'audio.music3' },
  { settings: { mediaType: 'audio', audio: { engine: 'acestep' } }, expected: null }, // removed 2026-09-21 — the honest undefined, like ltx
  { settings: { mediaType: 'video', engine: 'ltx' }, expected: null },
  { settings: { mediaType: 'image', imageEngine: 'zzz' }, expected: null },
  { settings: null, expected: null },
  { settings: 'garbage', expected: null },
])

function selectorSnapshot() {
  return SETTINGS_MATRIX().map(({ settings, expected }) => {
    const entry = registry.engineFamilyForChain(settings)
    assert.ok((entry?.id ?? null) === expected, `selector matrix: ${canon(settings)} → ${expected}`)
    return entry ? entry.id : null
  })
}

test('(a) registry shape — the pinned stock table', () => {
  const entries = registry.engineFamilies()
  eq(entries.map((entry) => ({
    id: entry.id, label: entry.label, mediaType: entry.mediaType, engineKey: entry.engineKey,
    modelFamilyId: entry.modelFamilyId, note: entry.note ?? null, queuedRefusal: entry.queuedRefusal ?? null, panel: entry.panel,
  })), STOCK_TABLE, 'the stock entries match the pinned table (labels, families, refusals, panel sections)')
  ok(entries.every((entry) => entry.id === `${entry.mediaType}.${entry.engineKey}`), 'id discipline: <mediaType>.<engineKey>')
})

test('(b) the selector across the settings matrix', () => {
  selectorSnapshot()
  passed += 1
  console.log('  ok - selector answers the full matrix (real shapes, tolerant defaults, honest undefined)')
})

test('(c) insert-only — a hypothetical engine registers and perturbs nothing else', () => {
  const baselineSelector = canon(selectorSnapshot())
  const baselineImageChoices = canon(registry.imageEngineChoices())
  const baselineIds = registry.engineFamilies().map((entry) => entry.id).join('|')
  const unregister = registry.registerEngineFamily({
    id: 'audio.newengine',
    label: 'New Audio Engine',
    mediaType: 'audio',
    engineKey: 'newengine',
    modelFamilyId: 'music3',
    panel: { tier: false, turboFamily: false, models: true, duration: false, resolution: false, seed: false, loraTimeline: false, audioDock: true },
  })
  const withHypothetical = registry.engineFamilyForChain({ mediaType: 'audio', audio: { engine: 'newengine' } })
  ok(withHypothetical?.id === 'audio.newengine' && withHypothetical.label === 'New Audio Engine', 'the hypothetical engine is selected by its discriminator alone (zero consumer changes)')
  eq(canon(selectorSnapshot()), baselineSelector, 'every OTHER selector answer is unchanged by the insertion')
  eq(canon(registry.imageEngineChoices()), baselineImageChoices, 'the image-engine choices are unchanged (the entry is audio)')
  ok(registry.engineFamilies().map((entry) => entry.id).join('|').startsWith(baselineIds), 'the stock entries keep their order ahead of the appended one (append, never reorder)')
  assert.throws(() => registry.registerEngineFamily(registry.engineFamilies()[0]), /duplicate id/, 'duplicate registration is rejected')
  unregister()
  eq(canon(selectorSnapshot()), baselineSelector, 'after unregister the selector matrix is the exact baseline')
  eq(canon(registry.imageEngineChoices()), baselineImageChoices, 'after unregister the image choices are the exact baseline')
  ok(registry.engineFamilyForChain({ mediaType: 'audio', audio: { engine: 'newengine' } }) === undefined, 'the unregistered engine answers undefined — removal is as easy as insertion (the modularity contract)')
})

test('(d) inertness — an absent entry changes nothing', () => {
  // Unknown engine keys (the absent-entry case at selection time): the
  // honest undefined, with every OTHER answer identical to the baseline.
  const baseline = canon(selectorSnapshot())
  ok(registry.engineFamilyForChain({ mediaType: 'video', engine: 'removed-engine' }) === undefined, 'an engine key no entry serves answers undefined (never a silent fallback to another engine)')
  ok(registry.engineFamilyForChain({ mediaType: 'audio', audio: { engine: 'removed-engine' } }) === undefined, 'the audio lane refuses unknown keys the same way')
  eq(canon(selectorSnapshot()), baseline, 'the unknown keys changed nothing else')
  // A registered-then-removed entry leaves the registry byte-identical to
  // the never-registered baseline (the insert-only closure is exact).
  const before = canon(registry.engineFamilies())
  const unregister = registry.registerEngineFamily({
    id: 'video.removed', label: 'Removed', mediaType: 'video', engineKey: 'removed', modelFamilyId: 'minimax',
    panel: { tier: true, turboFamily: true, models: true, duration: true, resolution: true, seed: true, loraTimeline: true, audioDock: false },
  })
  unregister()
  eq(canon(registry.engineFamilies()), before, 'register→unregister restores the exact registry snapshot')
})

test('(e) the consumers — the refusal seam and the derived image-engine table', () => {
  const queued = still.queuedImageEngineRefusal('krea2')
  ok(typeof queued === 'string' && queued.includes('mf3wfq6'), 'the queued krea2 slot refuses from the ENTRY copy (stillIntent reads the registry)')
  ok(still.queuedImageEngineRefusal('h3-1f') === null, 'the wired h3-1f slot imposes no refusal (entry has none)')
  eq(registry.imageEngineChoices(), [
    { id: 'h3-1f', label: 'H3 1F (T=1 Fast)', note: 'One latent frame through the Mamad8 T=1 image VAE on the hybrid stack — seconds-class stills.' },
    { id: 'krea2', label: 'Krea 2 (still images)', note: 'Queued (mf3wfq6) — the stills-only Krea 2 path; not wired yet.' },
  ], 'the derived IMAGE_ENGINES table matches the registry entries (one source, no drift)')
  console.log(`\ntest-engine-families: ${passed} assertions passed`)
})
