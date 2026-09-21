// Wave 1 suite (task jpc96dp) — the pure decision modules the wave added:
//   (a) engineWatch  — R-01: the re-check cadence, the transition map, the
//                      offline job-fail grace, and the two honest failure
//                      messages (both classify engine-unreachable)
//   (b) fabricWatch  — R-07/R-08: WS re-probe cadence while demoted, the
//                      reopen-resync channel list
//   (c) dbg          — A-DBG: a true no-op when off, a tagged console line
//                      when on, the runtime flip
//   (d) preflight    — R-02: the graph-vs-object_info diff, the pack-row
//                      refusal mapping, core-vs-pack advice, and the
//                      full-coverage object_info stub the e2e fakes reuse
// VM harness (scripts/lib/ts-vm.cjs) — pure modules, no ports, no engine.
import { test } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const { loadTs } = require('../scripts/lib/ts-vm.cjs')

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

const engineWatch = loadTs('src/lib/engineWatch.ts')
const fabricWatch = loadTs('src/lib/fabricWatch.ts')
const dbgModule = loadTs('src/lib/dbg.ts')
const preflight = loadTs('src/lib/preflight.ts')

test('(a) engineWatch — cadence, transitions, the offline grace, honest failure text', () => {
  // Cadence: FAST while down (the app notices a starting engine), SLOW while
  // up (liveness only). The stale-flag regression (audit B P0-1c): a stale
  // false flag is corrected within ONE down-cadence probe — 5 s, not never.
  eq(engineWatch.nextRecheckDelayMs(false), engineWatch.RECHECK_DOWN_MS, 'down cadence')
  eq(engineWatch.nextRecheckDelayMs(true), engineWatch.RECHECK_UP_MS, 'up cadence')
  ok(engineWatch.RECHECK_DOWN_MS <= 10_000, 'down cadence is seconds-scale')
  ok(engineWatch.RECHECK_UP_MS >= 15_000 && engineWatch.RECHECK_UP_MS <= 60_000, 'up cadence is liveness-scale')

  // The transition map: boot is 'steady' (a fresh boot that finds the engine
  // up must not fire the recovered re-pull/toast), loop/manual flips are
  // 'recovered'/'lost' exactly on the edges.
  eq(engineWatch.engineTransition(undefined, true), 'steady', 'boot-connected is steady')
  eq(engineWatch.engineTransition(undefined, false), 'steady', 'boot-offline is steady')
  eq(engineWatch.engineTransition(false, true), 'recovered', 'down→up is recovered')
  eq(engineWatch.engineTransition(true, false), 'lost', 'up→down is lost')
  eq(engineWatch.engineTransition(true, true), 'steady')
  eq(engineWatch.engineTransition(false, false), 'steady')

  // The grace: seconds-to-minutes, never the 60-min deadline; null (never
  // connected this session) never fails jobs.
  ok(engineWatch.ENGINE_LOST_JOB_GRACE_MS >= 15_000 && engineWatch.ENGINE_LOST_JOB_GRACE_MS <= 120_000, 'grace is inside seconds-to-minutes')
  eq(engineWatch.shouldFailActiveJobs(null, Date.now()), false, 'never-connected never fails jobs')
  const lostAt = Date.now() - engineWatch.ENGINE_LOST_JOB_GRACE_MS - 1
  eq(engineWatch.shouldFailActiveJobs(lostAt, Date.now()), true, 'grace elapsed → fail honestly')
  eq(engineWatch.shouldFailActiveJobs(Date.now(), Date.now()), false, 'grace not elapsed → keep waiting')

  // Both failure messages classify engine-unreachable (the taxonomy's own
  // bucket — the honest terminal state, not "Unclassified").
  const taxonomy = loadTs('src/lib/failureTaxonomy.ts')
  eq(taxonomy.classifyFailure(engineWatch.engineUnreachableFailure()).id, 'engine-unreachable', 'the loss message classifies')
  eq(taxonomy.classifyFailure(engineWatch.engineRestartFailure()).id, 'engine-unreachable', 'the restart message classifies')
})

test('(b) fabricWatch — the SSE demotion re-probe + the reopen resync list', () => {
  // R-07: demotion is a fallback, not a sentence. The probe is due
  // immediately after demotion (lastProbeAt null) and again each 60 s —
  // never while NOT demoted (a healthy WS session probes nothing).
  eq(fabricWatch.wsReprobeDue(false, null, Date.now()), false, 'no probes while not demoted')
  eq(fabricWatch.wsReprobeDue(true, null, Date.now()), true, 'first probe is immediate')
  eq(fabricWatch.wsReprobeDue(true, Date.now(), Date.now()), false, 'within the window → wait')
  eq(fabricWatch.wsReprobeDue(true, Date.now() - fabricWatch.WS_REPROBE_MS - 1, Date.now()), true, 'window elapsed → probe due')

  // R-08: a reopen resyncs EVERY subscribed JSON channel (the server's
  // per-client seq restarts at 1, so the seq-gap detector is blind over the
  // reconnect window — the resync is the only coverage).
  const channels = new Set(['job', 'telemetry', 'engine'])
  eq(fabricWatch.channelsToResyncOnReopen(channels).sort(), ['engine', 'job', 'telemetry'], 'all subscribed channels resync')
  eq(fabricWatch.channelsToResyncOnReopen(new Set()), [], 'no subscriptions → no resyncs')
})

test('(c) dbg — the junction logger seam (A-DBG)', () => {
  const originalLog = console.log
  const lines = []
  console.log = (...args) => { lines.push(args.join(' ')) }
  try {
    // OFF by default in this harness (no window/localStorage): a true no-op.
    dbgModule.dbg('route', { picked: 'video' })
    eq(lines.length, 0, 'off → nothing logs (the no-op contract)')

    // ON: one tagged line per junction event, JSON payload.
    dbgModule.setDbgEnabled(true)
    dbgModule.dbg('route', { picked: 'video', because: { mediaType: 'video' } })
    dbgModule.dbg('preflight.h3video', { verdict: 'pass', classes: 24 })
    ok(lines.some((line) => line.includes('[dbg:route]') && line.includes('"picked":"video"')), `tagged route line (got: ${lines.join(' | ')})`)
    ok(lines.some((line) => line.includes('[dbg:preflight.h3video]') && line.includes('"verdict":"pass"')), 'tagged preflight line')

    // A bad tag never throws; unserializable payloads degrade honestly.
    dbgModule.dbg('NOT A TAG', {})
    dbgModule.dbg('route', { circular: undefined })
    ok(lines.length >= 4, 'every call produced a line')

    // Back off → no-op again.
    dbgModule.setDbgEnabled(false)
    const before = lines.length
    dbgModule.dbg('route', { picked: 'video' })
    eq(lines.length, before, 'disabled again → silent')
  } finally {
    console.log = originalLog
  }
})

test('(d) preflight — the graph-vs-object_info diff and the pack-row refusal (R-02)', () => {
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: {} },
    '3': { class_type: 'VAELoader', inputs: {} },
    '15': { class_type: 'MiniMaxH3SamplerStandalone', inputs: {} },
    '16': { class_type: 'KSamplerSelect', inputs: {} },
    '17': { class_type: 'MiniMaxH3TurboSampler', inputs: {} },
  }

  // Full coverage → pass, no refusal.
  const fullInfo = { UNETLoader: {}, VAELoader: {}, KSamplerSelect: {}, MiniMaxH3SamplerStandalone: {}, MiniMaxH3TurboSampler: {} }
  eq(preflight.preflightGraph(graph, fullInfo), [], 'nothing missing against a serving engine')
  eq(preflight.preflightOrFail(graph, fullInfo), null, 'the seam returns null on pass')

  // An engine missing a class: named, mapped to its pack row when the
  // registry knows the class, marked stock when it is a factory class.
  const leanInfo = { UNETLoader: {}, VAELoader: {}, KSamplerSelect: {} }
  const missing = preflight.preflightGraph(graph, leanInfo)
  eq(missing.map((item) => item.className).sort(), ['MiniMaxH3SamplerStandalone', 'MiniMaxH3TurboSampler'], 'both missing classes listed (deduped)')
  const turbo = missing.find((item) => item.className === 'MiniMaxH3TurboSampler')
  eq(turbo.packId, 'minimax-h3-turbo', 'the turbo sampler maps to its pack row')
  eq(turbo.stock, false, 'a pack class is not stock')
  eq(missing.find((item) => item.className === 'MiniMaxH3SamplerStandalone').stock, false, 'an unknown class is not stock (generic advice)')

  // The refusal: readable, action-mapped, names the class AND the pack.
  const refusal = preflight.preflightRefusal(missing)
  ok(refusal.includes('MiniMaxH3SamplerStandalone'), 'the refusal names the class')
  ok(refusal.includes('ComfyUI-MiniMax-H3-Turbo'), 'the refusal names the pack row')
  ok(referralIncludes(refusal, 'Settings → Node packs'), 'the refusal maps to the action')
  ok(preflight.preflightRefusal([]) === null, 'empty missing list → no refusal')

  // A missing STOCK class says UPDATE COMFYUI, not install a pack.
  const stockMissing = preflight.preflightGraph({ '1': { class_type: 'UNETLoader', inputs: {} }, '9': { class_type: 'SaveVideo', inputs: {} } }, { UNETLoader: {} })
  eq(stockMissing.length, 1)
  ok(stockMissing[0].stock, 'SaveVideo is a stock class')
  ok(preflight.preflightRefusal(stockMissing).includes('Update ComfyUI'), 'stock advice says update ComfyUI')

  // No object_info at all (engine never served it) → preflight stays silent
  // (the honest refusal is the connection check's job, not this seam's).
  eq(preflight.preflightGraph(graph, undefined), [], 'no info → no false positives')

  // (d2) R-17 remediation rows — the refusal's missing list as ONE ACTION
  // PER ROW over the same registries the Settings board renders.
  const remediation = loadTs('src/lib/preflightRemediation.ts')
  const missingMix = [
    { className: 'MiniMaxH3HybridLoader', packId: 'h3-hybrid-loader', stock: false },
    { className: 'ApplyVDNH3', packId: 'vdn-h3', stock: false },
    { className: 'MiniMaxH3LoraFormLoader', packId: 'lora-form-adapter', stock: false },
    { className: 'H3ImagePrepare', packId: 'h3-image-studio', stock: false },
    { className: 'CreateVideo', stock: true },
    { className: 'MysteryNode', stock: false },
  ]
  const rows = remediation.remediationRows(missingMix)
  eq(rows.length, 6, 'one row per missing class')
  const byClass = Object.fromEntries(rows.map((row) => [row.className, row]))
  ok(byClass.MiniMaxH3HybridLoader.action.kind === 'fetch' && byClass.MiniMaxH3HybridLoader.action.licenseSpdx === 'MIT', 'user-fetch pack row → fetch action carrying the license verdict')
  ok(byClass.MiniMaxH3HybridLoader.action.catalogEntryId === 'pack:h3-hybrid-loader', 'the fetch action targets the catalog entry (the Library deep-link)')
  ok(byClass.H3ImagePrepare.action.kind === 'fetch' && byClass.H3ImagePrepare.action.licenseSpdx === 'Unlicense', 'the h3-image-studio gate pack rows as a fetch with its Unlicense verdict')
  ok(byClass.ApplyVDNH3.action.kind === 'install' && byClass.ApplyVDNH3.action.packId === 'vdn-h3', 'vendored pack row → install action (no network)')
  ok(byClass.MiniMaxH3LoraFormLoader.action.kind === 'install' && byClass.MiniMaxH3LoraFormLoader.label.includes('no network'), 'first-party pack row → install action stating no network')
  ok(byClass.CreateVideo.action.kind === 'stock' && byClass.CreateVideo.label.includes('update ComfyUI'), 'stock class row → the update-ComfyUI advice (nothing to fetch)')
  ok(byClass.MysteryNode.action.kind === 'unknown' && byClass.MysteryNode.label.includes('restart'), 'unknown class row → the honest dead end with the restart note')
  // The refusal event fires from the seam — window-guarded, so in the plain
  // node harness (no DOM) the seam stays SILENT (the skip path is itself the
  // contract: a missing window never blocks the refusal). Where a DOM exists
  // the e2e proves the payload reaches the dock.
  {
    const hasWindow = typeof globalThis.window !== 'undefined' && typeof globalThis.window.addEventListener === 'function'
    console.log(`  NOTE - refusal-event dispatch: ${hasWindow ? 'asserted here' : 'no window in this harness — the silent-skip path runs; the e2e carries the payload proof'}`)
    if (hasWindow) {
      let refusalEvent = null
      const listener = (event) => { refusalEvent = event.detail }
      globalThis.window.addEventListener('minimax:preflight-refusal', listener)
      const refusal = preflight.preflightOrFail({ '1': { class_type: 'MiniMaxH3HybridLoader', inputs: {} } }, { UNETLoader: {} }, 'preflight.test')
      ok(refusal && refusal.includes('MiniMaxH3HybridLoader'), 'the seam still refuses (the event never replaces the refusal)')
      ok(refusalEvent && refusalEvent.missing.length === 1 && refusalEvent.missing[0].packId === 'h3-hybrid-loader', 'the refusal event carries the missing payload (the RemediationDock opens from it)')
      globalThis.window.removeEventListener('minimax:preflight-refusal', listener)
    } else {
      // The no-window path: the refusal still returns, nothing dispatches,
      // nothing throws.
      const refusal = preflight.preflightOrFail({ '1': { class_type: 'MiniMaxH3HybridLoader', inputs: {} } }, { UNETLoader: {} }, 'preflight.test')
      ok(typeof refusal === 'string' && refusal.includes('MiniMaxH3HybridLoader'), 'no-window harness: the refusal still refuses (the event skip never blocks it)')
    }
  }

  // The fake-engine helper contract the e2e suites reuse: every stock class
  // the factories can emit, served as a bare object (the rq0lsax lean-shape
  // precedent — detection is key-presence only).
  for (const className of preflight.STOCK_GRAPH_CLASSES) {
    ok(typeof className === 'string' && className.length > 0, `stock class listed: ${className}`)
  }
  ok(preflight.STOCK_GRAPH_CLASSES.includes('KSamplerSelect') && preflight.STOCK_GRAPH_CLASSES.includes('SaveVideo'), 'the factory base classes are covered')
})

function referralIncludes(text, fragment) {
  return typeof text === 'string' && text.includes(fragment)
}

test('suite summary', () => {
  console.log(`  enginewatch: ${passed} assertions passed`)
})
