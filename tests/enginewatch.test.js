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

  // GAP-1/GAP-2 closed (06jr4eh): the chain lane's and the LBH upscale
  // lane's classes — load-bearing builder emissions that previously fell to
  // the generic no-registry-row advice — now map to their pack rows.
  const chainGraph = {
    '24': { class_type: 'MiniMaxH3MotionContextLoadLatent', inputs: {} },
    '25': { class_type: 'MiniMaxH3MotionContext', inputs: {} },
    '28': { class_type: 'MiniMaxH3MotionContextSaveLatent', inputs: {} },
    '26': { class_type: 'MiniMaxH3MotionContextTrim', inputs: {} },
    '44': { class_type: 'MinimaxH3LatentUpscaler3D', inputs: {} },
  }
  const gapMissing = preflight.preflightGraph(chainGraph, { UNETLoader: {} })
  eq(gapMissing.filter((item) => item.packId === 'h3-motion-context').length, 4, 'all four Motion-Context chain classes map to the h3-motion-context row')
  eq(gapMissing.find((item) => item.className === 'MinimaxH3LatentUpscaler3D').packId, 'lbh-latent-upscaler', 'the LBH 3D upscaler maps to the lbh-latent-upscaler row')
  ok(preflight.preflightRefusal(gapMissing).includes('ComfyUI-H3-Motion-Context'), 'the refusal names the Motion-Context pack row')

  // (t6vub9k) The preview-decoding path's class maps to its pack row — a
  // render whose preferred preview route finds the pack absent refuses with
  // the FETCH action for the maintainer-endorsed pack, not the unknown-class
  // dead end (the row + fetch entry are the F6 remediation affordance).
  const previewGraph = { '7': { class_type: 'MiniMaxH3PreviewOverride', inputs: {} } }
  const previewMissing = preflight.preflightGraph(previewGraph, { UNETLoader: {} })
  eq(previewMissing.find((item) => item.className === 'MiniMaxH3PreviewOverride').packId, 'h3-preview-override', 'the preview-override class maps to the h3-preview-override row')
  ok(preflight.preflightRefusal(previewMissing).includes('ComfyUI-MiniMaxH3-PreviewOverride'), 'the refusal names the PreviewOverride pack row')

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
    { className: 'MiniMaxH3MotionContext', packId: 'h3-motion-context', stock: false },
    { className: 'MinimaxH3LatentUpscaler3D', packId: 'lbh-latent-upscaler', stock: false },
    { className: 'MiniMaxH3PreviewOverride', packId: 'h3-preview-override', stock: false },
    { className: 'CreateVideo', stock: true },
    { className: 'MysteryNode', stock: false },
  ]
  const rows = remediation.remediationRows(missingMix)
  eq(rows.length, 9, 'one row per missing class')
  const byClass = Object.fromEntries(rows.map((row) => [row.className, row]))
  ok(byClass.MiniMaxH3HybridLoader.action.kind === 'fetch' && byClass.MiniMaxH3HybridLoader.action.licenseSpdx === 'MIT', 'user-fetch pack row → fetch action carrying the license verdict')
  ok(byClass.MiniMaxH3HybridLoader.action.catalogEntryId === 'pack:h3-hybrid-loader', 'the fetch action targets the catalog entry (the Library deep-link)')
  // GAP-1/GAP-2 (06jr4eh): the chain lane's and the LBH upscale lane's
  // classes now map to registry rows — a missing Motion-Context or LBH
  // class refuses with a FETCH action, not the unknown dead end.
  ok(byClass.MiniMaxH3MotionContext.action.kind === 'fetch' && byClass.MiniMaxH3MotionContext.action.packId === 'h3-motion-context' && byClass.MiniMaxH3MotionContext.action.licenseSpdx === 'GPL-3.0-only', 'a missing Motion-Context class maps to its fetch row with the GPL verdict stated')
  ok(byClass.MiniMaxH3MotionContext.action.catalogEntryId === 'pack:h3-motion-context', 'the Motion-Context fetch action deep-links its catalog entry')
  ok(byClass.MinimaxH3LatentUpscaler3D.action.kind === 'fetch' && byClass.MinimaxH3LatentUpscaler3D.action.packId === 'lbh-latent-upscaler' && byClass.MinimaxH3LatentUpscaler3D.action.licenseSpdx === 'MIT', 'a missing LBH upscaler class maps to its fetch row with the MIT verdict stated')
  ok(byClass.MiniMaxH3PreviewOverride.action.kind === 'fetch' && byClass.MiniMaxH3PreviewOverride.action.packId === 'h3-preview-override' && byClass.MiniMaxH3PreviewOverride.action.licenseSpdx === 'MIT', 'a missing PreviewOverride class maps to its fetch row with the MIT verdict stated')
  ok(byClass.MiniMaxH3PreviewOverride.action.catalogEntryId === 'pack:h3-preview-override', 'the PreviewOverride fetch action deep-links its catalog entry (the F6 remediation affordance)')
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

  // (d3) R-29 (Wave 4, audit C F7) — the CORE render-class check that feeds
  // the doctor and the H3 stack report: an instance a version behind passes
  // every file-based check and fails only at render. The check names the
  // missing core classes, stays silent without object_info, and scopes by
  // family (the H3 stack report must not inherit music3's verdict).
  eq(preflight.missingCoreNodeClasses(undefined), [], 'no info → the core check stays silent (connection rung owns that refusal)')
  eq(preflight.missingCoreNodeClasses({}), [], 'empty info → silent too')
  const oldInstance = { KSamplerSelect: {}, SamplerCustomAdvanced: {}, EmptyMiniMaxMusic3LatentAudio: {}, MiniMaxMusic3TextEncode: {} } // no H3 natives
  const coreMissing = preflight.missingCoreNodeClasses(oldInstance)
  eq(coreMissing.map((item) => item.className), ['MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo'], 'the H3 natives are the missing core (an instance older than H3 support)')
  ok(coreMissing.every((item) => item.stock), 'the core classes are stock — the refusal advice says update ComfyUI')
  ok(preflight.preflightRefusal(coreMissing).includes('Update ComfyUI'), 'the core refusal maps to the update advice')
  eq(preflight.missingCoreNodeClasses(oldInstance, 'h3-video').map((item) => item.className), ['MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo'], 'family-scoped: h3-video')
  eq(preflight.missingCoreNodeClasses(oldInstance, 'audio'), [], 'family-scoped: audio is served here')
  eq(preflight.missingCoreNodeClasses(oldInstance).length, 2, 'unscoped asks for every core family')

  // The H3 stack report folds the engine side (R-29): with a full-serving
  // snapshot nothing changes; with the H3 natives absent `ready` is false
  // and the missing classes are named — weights cannot fix a node class.
  const stack = loadTs('src/lib/h3Stack.ts')
  const h3Models = [
    { name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', kind: 'diffusion_models', bytes: 1 },
    { name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', kind: 'text_encoders', bytes: 1 },
    { name: 'minimax_h3_video_vae_fp16.safetensors', kind: 'vae', bytes: 1 },
    { name: 'minimax_h3_audio_vae_fp32.safetensors', kind: 'vae', bytes: 1 },
    { name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', kind: 'loras', bytes: 1 },
  ]
  const servingInfo = { MiniMaxH3ImageToVideo: {}, MiniMaxH3ReferenceToVideo: {}, KSamplerSelect: {}, SamplerCustomAdvanced: {} }
  eq(stack.h3StackReport(h3Models, undefined, servingInfo).ready, true, 'a serving engine keeps the file-only verdict (ready)')
  eq(stack.h3StackReport(h3Models).nodes.missing, [], 'no info → no node verdict (back-compatible)')
  const oldReport = stack.h3StackReport(h3Models, undefined, oldInstance)
  eq(oldReport.ready, false, 'an instance missing the H3 natives is NOT ready even with every file present')
  eq(oldReport.nodes.missing.length, 2, 'the report names the missing core classes')
  eq(oldReport.validated, true, 'the validated (file-exactness) verdict stays untouched by the node check')

  // The fake-engine helper contract the e2e suites reuse: every stock class
  // the factories can emit, served as a bare object (the rq0lsax lean-shape
  // precedent — detection is key-presence only).
  for (const className of preflight.STOCK_GRAPH_CLASSES) {
    ok(typeof className === 'string' && className.length > 0, `stock class listed: ${className}`)
  }
  ok(preflight.STOCK_GRAPH_CLASSES.includes('KSamplerSelect') && preflight.STOCK_GRAPH_CLASSES.includes('SaveVideo'), 'the factory base classes are covered')
})

// (a2) The truth-surface sweep #1 (audit F2 / C3, task 68e9k17): the stack
// report must read the registry the way the pickers do — BASENAME truth. The
// registry lists engine-relative subpaths ("H3/ssd/x.safetensors"); the
// pickers infer by basename (modelSelection.ts); the report's exact +
// anchored-regex compare against the FULL name called the maintainer's
// fully-provisioned engine INCOMPLETE (their FL2VA lives under H3/ssd/).
// The fixture here is the audit's maintainer-instance mirror listing
// (e2e/mirror/profiles/maintainer-instance.json) — every subpath'd official
// file must resolve, validate, and leave the table COMPLETE.
test('(a2) stack report — the subpath\'d mirror registry reports all-present (basename truth, sweep #1)', () => {
  const stack = loadTs('src/lib/h3Stack.ts')
  const mirrorModels = [
    { name: 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', kind: 'diffusion_models', bytes: 0 },
    { name: 'H3/ssd/minimax_h3_ref2va_pruned_int8_convrot.safetensors', kind: 'diffusion_models', bytes: 0 },
    { name: 'music3_dit_int8.safetensors', kind: 'diffusion_models', bytes: 0 },
    { name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', kind: 'text_encoders', bytes: 0 },
    { name: 'qwen3vl_4b_minimax_h3_int8.safetensors', kind: 'text_encoders', bytes: 0 },
    { name: 'h3image/minimax_h3_image_vae_fp16.safetensors', kind: 'vae', bytes: 0 },
    { name: 'h3image/minimax_h3_image_vae_fp8_e4m3.safetensors', kind: 'vae', bytes: 0 },
    { name: 'minimax_h3_video_vae_fp16.safetensors', kind: 'vae', bytes: 0 },
    { name: 'minimax_h3_audio_vae_fp32.safetensors', kind: 'vae', bytes: 0 },
    { name: 'H3/turbo/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', kind: 'loras', bytes: 0 },
  ]
  const servingInfo = { MiniMaxH3ImageToVideo: {}, MiniMaxH3ReferenceToVideo: {}, KSamplerSelect: {}, SamplerCustomAdvanced: {} }
  const report = stack.h3StackReport(mirrorModels, undefined, servingInfo)
  const byLabel = {}
  for (const row of report.rows) byLabel[row.label] = row
  eq(byLabel.FL2VA.selected, 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'FL2VA resolves the subpath\'d registry row (verbatim, graph-legal)')
  eq(byLabel['Text encoder'].selected, 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'the 32B encoder resolves')
  eq(byLabel['Video VAE'].selected, 'minimax_h3_video_vae_fp16.safetensors', 'the video VAE resolves')
  eq(byLabel['Audio VAE'].selected, 'minimax_h3_audio_vae_fp32.safetensors', 'the audio VAE resolves')
  eq(byLabel['Turbo 8'].selected, 'H3/turbo/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 'the subpath\'d turbo LoRA resolves')
  ok(report.rows.every((row) => row.selected), 'every row resolves against the mirror registry')
  eq(report.validated, true, 'the official files under subpaths VALIDATE — the table stops calling a provisioned engine incomplete')
  eq(report.ready, true, 'the mirror inventory leaves the stack COMPLETE and ready')

  // The honest middle state survives: a subpath'd RENAMED quant resolves via
  // the family fallback but does not VALIDATE (it is not the official file).
  const renamed = [
    { name: 'H3/ssd/minimax_h3_fl2va_repack_fp8.safetensors', kind: 'diffusion_models', bytes: 0 },
  ]
  const renamedReport = stack.h3StackReport(renamed)
  eq(renamedReport.rows[0].selected, 'H3/ssd/minimax_h3_fl2va_repack_fp8.safetensors', 'a renamed quant still resolves by basename')
  eq(renamedReport.rows[0].isCanonical, false, 'a renamed quant is not the canonical artifact (honest display hint, never a gate)')
})

// (a4) The parallel-table root cause, reworked (maintainer ruling 2026-09-26:
// "the auto inferred models are there, the H3 Engine Stack reports are
// incorrect"). PR #52's basename fix addressed the COMPARISON; the deeper
// divergence was the parallel expectation table itself — its anchored
// fallback regexes demanded tokens the real inference ladders never require,
// so the maintainer's int8_convrot-shaped TE (no _minimax_h3_ infix) resolved
// in every picker while the report's own regex rejected it: present models
// read MISSING while the UI showed them inferred. The report now DERIVES from
// the same resolution the graphs use (inferSelections + the override seam),
// the canonical names survive as display guidance only, and the empty/refused
// states say WHY — the mirror profile's TE was updated to the maintainer's
// real name shape the same day.
test('(a4) stack report — derived from the resolution the graphs use: the maintainer\'s int8_convrot TE resolves (the parallel-table rework)', () => {
  const stack = loadTs('src/lib/h3Stack.ts')
  const servingInfo = { MiniMaxH3ImageToVideo: {}, MiniMaxH3ReferenceToVideo: {}, KSamplerSelect: {}, SamplerCustomAdvanced: {} }

  // The maintainer's real TE (ruling 2026-09-26): int8_convrot-shaped, NOT
  // the official nvfp4 artifact, no _minimax_h3_ infix. The pickers resolve
  // it (the 'qwen3vl' fallback needle + the 32B dimension class passes the
  // guard); the report must say the same thing.
  const maintainerModels = [
    { name: 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', kind: 'diffusion_models', bytes: 0 },
    { name: 'qwen3vl_32b_int8_convrot.safetensors', kind: 'text_encoders', bytes: 0 },
    { name: 'minimax_h3_video_vae_fp16.safetensors', kind: 'vae', bytes: 0 },
    { name: 'minimax_h3_audio_vae_fp32.safetensors', kind: 'vae', bytes: 0 },
    { name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', kind: 'loras', bytes: 0 },
  ]
  const report = stack.h3StackReport(maintainerModels, undefined, servingInfo)
  const byLabel = {}
  for (const row of report.rows) byLabel[row.label] = row
  eq(byLabel['Text encoder'].selected, 'qwen3vl_32b_int8_convrot.safetensors', 'the int8_convrot TE RESOLVES — the report states what the graph will load')
  eq(byLabel['Text encoder'].present, true, 'presence truth: the resolved name is the registry row verbatim')
  eq(byLabel['Text encoder'].source, 'inferred', 'the source layer is named: the ladder inferred it')
  eq(byLabel['Text encoder'].isCanonical, false, 'the canonical expectation reads as a display hint, not a verdict')
  eq(byLabel['Text encoder'].canonical, 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'the canonical hint names the official artifact (guidance only)')
  eq(byLabel.FL2VA.source, 'inferred', 'the base slots name their layer too')
  eq(report.validated, false, 'the display verdict stays honest: this is not the exact official stack')
  eq(report.ready, true, 'every slot resolves + present, nothing refused, nodes served — READY (generation works)')

  // FOUND BUT REFUSED, distinguished from NOT FOUND: with only a 4B-class TE
  // visible, the ladder's best-available resolves it NON-EMPTY and the TE
  // dimension guard (eyzcev5 — the submit validate rung's own check) refuses
  // with the class error. The row must narrate the refusal, not "missing".
  const fourBOnly = [
    { name: 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', kind: 'diffusion_models', bytes: 0 },
    { name: 'qwen3vl_4b_minimax_h3_int8.safetensors', kind: 'text_encoders', bytes: 0 },
    { name: 'minimax_h3_video_vae_fp16.safetensors', kind: 'vae', bytes: 0 },
    { name: 'minimax_h3_audio_vae_fp32.safetensors', kind: 'vae', bytes: 0 },
    { name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', kind: 'loras', bytes: 0 },
  ]
  const refusedReport = stack.h3StackReport(fourBOnly, undefined, servingInfo)
  const refusedByLabel = {}
  for (const row of refusedReport.rows) refusedByLabel[row.label] = row
  eq(refusedByLabel['Text encoder'].selected, 'qwen3vl_4b_minimax_h3_int8.safetensors', 'best-available resolves the 4B (non-empty — the crash class the old readiness could not see)')
  ok(refusedByLabel['Text encoder'].refusal && refusedByLabel['Text encoder'].refusal.includes('4B'), 'the row narrates the refusal with the dimension-class reason')
  eq(refusedReport.ready, false, 'a found-but-refused slot blocks readiness (the submission would refuse)')

  // THE HONEST EMPTY STATE: a slot with no resolution names WHAT SHAPE OF
  // NAME TO MAKE VISIBLE (inference-shaped guidance), never
  // missing-because-unlisted.
  const noVae = [
    { name: 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', kind: 'diffusion_models', bytes: 0 },
    { name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', kind: 'text_encoders', bytes: 0 },
    { name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', kind: 'loras', bytes: 0 },
  ]
  const emptyReport = stack.h3StackReport(noVae, undefined, servingInfo)
  const emptyByLabel = {}
  for (const row of emptyReport.rows) emptyByLabel[row.label] = row
  eq(emptyByLabel['Video VAE'].selected, '', 'nothing resolves: the honest empty state')
  eq(emptyByLabel['Video VAE'].present, false)
  ok(emptyByLabel['Video VAE'].makeVisible && emptyByLabel['Video VAE'].makeVisible.includes('video_vae'), 'the empty state carries inference-shaped guidance (what naming to make visible)')
  eq(emptyReport.ready, false, 'an unresolved slot blocks readiness — the wording is guidance, not the gate')
})

// (a3) The truth-surface sweep #2 decisions (audit M1 / C1, task 68e9k17):
// the recovery re-sync carries REFRESH semantics, inventory drift is a pure
// compare, and the notices tell the truth (a resync that never landed is
// never claimed). The empirical root (2026-09-26 sweep): the observed
// down→up transition already re-pulls; the LIE lives in (i) refreshless
// re-pulls, (ii) toasts that fire before/outside the inventory outcome, and
// (iii) fast engine restarts that fall between probes — no transition, no
// re-pull — which the drift check catches on the very next connected tick.
test('(a3) engineWatch — resync refresh options, inventory drift, honest notices (sweep #2)', () => {
  // Refresh semantics: the recovery/drift re-sync is a RE-SYNC, not a re-read
  // — the engine's own folder caches must be asked to re-scan (POST /refresh
  // through the server) so a restart-watch never serves yesterday's listing.
  eq(engineWatch.RECOVERY_RESYNC_OPTIONS, { refresh: true }, 'the recovery resync options demand refresh')

  // Drift: per served kind, name-set equality against the live listing.
  // servedKinds carries the kinds the engine's /models route ANSWERS — kinds
  // it does not serve cannot be judged (older instances fall back to
  // object_info enums the light pull never sees).
  const current = [
    { name: 'a.safetensors', kind: 'diffusion_models', bytes: 0 },
    { name: 'v.safetensors', kind: 'vae', bytes: 0 },
    { name: 'keep.safetensors', kind: 'loras', bytes: 0 },
  ]
  eq(engineWatch.inventoryDrifted(current, { models: current, servedKinds: ['diffusion_models', 'vae', 'loras'] }), false, 'an identical light listing is NOT drift')
  eq(engineWatch.inventoryDrifted(current, { models: current, servedKinds: ['vae'] }), false, 'comparing only served kinds ignores the rest')
  eq(engineWatch.inventoryDrifted(current, { models: current, servedKinds: [] }), false, 'no served kinds → nothing judgeable → no drift')
  eq(engineWatch.inventoryDrifted(current, { models: [{ name: 'b.safetensors', kind: 'diffusion_models', bytes: 0 }, { name: 'v.safetensors', kind: 'vae', bytes: 0 }], servedKinds: ['diffusion_models', 'vae'] }), true, 'a changed diffusion listing IS drift')
  eq(engineWatch.inventoryDrifted(current, { models: [{ name: 'a.safetensors', kind: 'diffusion_models', bytes: 0 }], servedKinds: ['diffusion_models', 'vae'] }), true, 'a kind that EMPTIED is drift (current had files, light serves the kind with none)')
  eq(engineWatch.inventoryDrifted([], { models: [{ name: 'new.safetensors', kind: 'vae', bytes: 0 }], servedKinds: ['vae'] }), true, 'a file APPEARING is drift')
  eq(engineWatch.inventoryDrifted(current, { models: [{ name: 'v.safetensors', kind: 'vae', bytes: 0 }, { name: 'extra.safetensors', kind: 'clip_vision', bytes: 0 }], servedKinds: ['vae', 'clip_vision'] }), true, 'an unserved-before kind appearing counts (the kind list itself drifted)')
  eq(engineWatch.inventoryDrifted(current, null), false, 'a null light answer (engine/route unavailable) never drifts')

  // Notices: the words the surfaces put on a resync. A success names the
  // file count; a failure NEVER claims the inventory re-synced; drift gets
  // its own wording (the engine was never seen down — an invisible restart
  // or a folder change, not a recovery arc).
  ok(engineWatch.engineResyncedNotice(15).includes('Engine connected') && engineWatch.engineResyncedNotice(15).includes('15'), 'the recovery success notice says connected and carries the count')
  ok(!engineWatch.engineResyncFailedNotice().includes('inventory re-synced'), 'the failure notice never claims the inventory landed')
  ok(engineWatch.inventoryDriftNotice(15).includes('15'), 'the drift notice carries the count')
})

// (a4) The recovery flow itself (sweep #2): runEngineCheck moved out of the
// hook into a dependency-injected module (src/lib/engineRecovery.ts) so the
// transition matrix — what gets pulled, with what options, and when the
// resync bookkeeping lands — is provable without React or an engine.
test('(a4) engineRecovery — the probe flow: recovery resync, drift resync, honest bookkeeping (sweep #2)', async () => {
  const recovery = loadTs('src/lib/engineRecovery.ts')

  // A recording harness: every bridge call and store write is captured; the
  // store keeps enough live state for consecutive probes to see their own
  // setStatus/markEngine* writes.
  function makeHarness(models) {
    const calls = { getComfyStatus: [], getObjectInfo: [], scanModels: [], lightInventory: [] }
    const writes = { setModels: [], markEngineLost: [], markEngineRecovered: [], markInventoryResync: [], setInfo: [], bumpInfoEpoch: [] }
    const state = { connected: false, models, settings: { comfyUrl: 'http://engine.local' } }
    let scanResult = null
    let scanError = null
    let lightAnswer = null
    const harness = {
      calls, writes,
      engineUp: true,
      setInventory(next, light) { scanResult = next; lightAnswer = light },
      failScan(error) { scanError = error },
      deps: {
        bridge: {
          getComfyStatus: async (url) => { calls.getComfyStatus.push(url); return { connected: harness.engineUp, latencyMs: 1 } },
          getObjectInfo: async (url) => { calls.getObjectInfo.push(url); return { KSamplerSelect: {} } },
          scanModels: async (settings, options) => { calls.scanModels.push(options); if (scanError) throw scanError; return scanResult ?? [] },
          lightInventory: async () => { calls.lightInventory.push(1); return lightAnswer },
        },
        store: {
          status: () => ({ connected: state.connected }),
          settings: () => state.settings,
          models: () => state.models,
          setStatus: (next) => { state.connected = next.connected },
          setInfo: (info) => { writes.setInfo.push(info) },
          bumpInfoEpoch: () => { writes.bumpInfoEpoch.push(1) },
          setModels: (next) => { state.models = next; writes.setModels.push(next) },
          markEngineLost: (at) => { writes.markEngineLost.push(at) },
          markEngineRecovered: (at) => { writes.markEngineRecovered.push(at) },
          markInventoryResync: (record) => { writes.markInventoryResync.push(record) },
        },
      },
    }
    return harness
  }
  const url = 'http://engine.local'

  // Boot: steady, connected — no resync bookkeeping, no inventory pull (the
  // boot scan is the mount effect's job; a fresh boot must not double-pull).
  {
    const h = makeHarness([])
    await recovery.runEngineCheck(h.deps, url, 'boot')
    eq(h.calls.scanModels.length, 0, 'boot does not scan (the mount effect owns the boot inventory)')
    eq(h.writes.markInventoryResync.length, 0, 'boot claims no resync')
    ok(h.calls.getObjectInfo.length === 1 && h.writes.bumpInfoEpoch.length === 1, 'boot still pulls object_info (the node registry)')
  }

  // Steady connected loop tick, light listing matches → no resync.
  {
    const models = [{ name: 'a.safetensors', kind: 'vae', bytes: 0 }]
    const h = makeHarness(models)
    h.engineUp = true
    await recovery.runEngineCheck(h.deps, url, 'boot') // establish connected
    h.setInventory(models, { models, servedKinds: ['vae'] })
    await recovery.runEngineCheck(h.deps, url, 'loop')
    eq(h.calls.scanModels.length, 0, 'a matching light listing triggers no rescan')
    eq(h.calls.lightInventory.length, 1, 'the connected loop tick consulted the light listing')
    eq(h.writes.markInventoryResync.length, 0, 'no resync claimed')
  }

  // THE SUB-TICK RESTART: steady tick, light listing DIFFERS (the engine
  // restarted between probes — no down was ever seen) → full resync WITH
  // refresh, store updated, drift-cause record lands.
  {
    const models = [{ name: 'a.safetensors', kind: 'vae', bytes: 0 }]
    const next = [{ name: 'b.safetensors', kind: 'vae', bytes: 0 }]
    const h = makeHarness(models)
    await recovery.runEngineCheck(h.deps, url, 'boot')
    h.setInventory(next, { models: next, servedKinds: ['vae'] })
    await recovery.runEngineCheck(h.deps, url, 'loop')
    eq(h.calls.scanModels.length, 1, 'drift triggered exactly one full re-pull')
    eq(h.calls.scanModels[0], { refresh: true }, 'the drift re-pull carries refresh semantics')
    eq(h.writes.setModels.length, 1, 'the fresh listing landed in the store')
    eq(h.writes.markInventoryResync.length, 1, 'the resync record landed')
    eq(h.writes.markInventoryResync[0].cause, 'drift', 'the record names the drift cause')
    eq(h.writes.markInventoryResync[0].ok, true, 'the record says ok')
    eq(h.writes.markInventoryResync[0].files, 1, 'the record carries the file count')
  }

  // The OBSERVED recovery: down tick then up tick → object_info re-pulled,
  // inventory resynced WITH refresh, recovered marked, record cause recovery.
  {
    const h = makeHarness([])
    await recovery.runEngineCheck(h.deps, url, 'boot')
    h.engineUp = false
    await recovery.runEngineCheck(h.deps, url, 'loop')
    eq(h.writes.markEngineLost.length, 1, 'the down edge marked lost')
    h.engineUp = true
    h.setInventory([{ name: 'back.safetensors', kind: 'vae', bytes: 0 }], null)
    await recovery.runEngineCheck(h.deps, url, 'loop')
    eq(h.writes.markEngineRecovered.length, 1, 'the up edge marked recovered')
    eq(h.calls.scanModels.length, 1, 'the recovery resync pulled the inventory exactly once')
    eq(h.calls.scanModels[0], { refresh: true }, 'the recovery re-pull carries refresh semantics')
    eq(h.writes.markInventoryResync.length, 1, 'the recovery resync recorded')
    eq(h.writes.markInventoryResync[0].cause, 'recovery', 'the record names the recovery cause')
  }

  // A resync that FAILS never claims success and never wipes the store.
  {
    const models = [{ name: 'a.safetensors', kind: 'vae', bytes: 0 }]
    const h = makeHarness(models)
    await recovery.runEngineCheck(h.deps, url, 'boot')
    await recovery.runEngineCheck(h.deps, url, 'manual') // manual pulls info; drift applies too
    h.failScan(new Error('engine flapped'))
    h.setInventory([{ name: 'b.safetensors', kind: 'vae', bytes: 0 }], { models: [{ name: 'b.safetensors', kind: 'vae', bytes: 0 }], servedKinds: ['vae'] })
    await recovery.runEngineCheck(h.deps, url, 'loop')
    eq(h.writes.setModels.length, 0, 'a failed resync never replaces the inventory')
    eq(h.writes.markInventoryResync.length, 1, 'the failure recorded')
    eq(h.writes.markInventoryResync[0].ok, false, 'the record says not-ok')
  }

  // A null light answer (route absent / engine flapped) is not drift.
  {
    const h = makeHarness([{ name: 'a.safetensors', kind: 'vae', bytes: 0 }])
    await recovery.runEngineCheck(h.deps, url, 'boot')
    h.setInventory(null, null)
    await recovery.runEngineCheck(h.deps, url, 'loop')
    eq(h.calls.scanModels.length, 0, 'a null light listing triggers nothing')
    eq(h.writes.markInventoryResync.length, 0, 'and claims nothing')
  }

  // Lost: info cleared, loss marked — unchanged contract from R-01.
  {
    const h = makeHarness([])
    await recovery.runEngineCheck(h.deps, url, 'boot')
    h.engineUp = false
    await recovery.runEngineCheck(h.deps, url, 'loop')
    eq(JSON.stringify(h.writes.setInfo[h.writes.setInfo.length - 1]), '{}', 'loss clears object_info (the last setInfo write empties it)')
    eq(h.writes.markEngineLost.length, 1, 'loss is marked')
  }
})

function referralIncludes(text, fragment) {
  return typeof text === 'string' && text.includes(fragment)
}

test('suite summary', () => {
  console.log(`  enginewatch: ${passed} assertions passed`)
})
