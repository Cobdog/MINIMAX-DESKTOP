// Vitest port (task z7ogmig, 2026-09-20) of scripts/test-workflows.cjs —
// the suite the `pnpm test` alias runs. Assertion bodies carry over
// verbatim with ONE dated body edit: the sanitizer stack-frame regex pinned
// the calling file's name (test-workflows.cjs) and now pins this port's
// (workflows.test.js) — same assertion (first stack frame extracted as
// file:line), new caller filename. The linear sections became one test
// each, in file order; cross-section consts stay at module scope.
import { test } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const REPO = require('node:path').resolve(__dirname, '..')

const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { loadTs } = require('../scripts/lib/ts-vm.cjs')
function load(path) {
  return loadTs(path)
}
const workflowModule = load('src/lib/workflow.ts')
const { frameCount, buildMiniMaxWorkflow, extractOutputUrl, extractOutputFile, outputFileFromUrl, OFFICIAL_H3_SAMPLER, OFFICIAL_H3_SCHEDULER } = workflowModule
const { inferSelections } = load('src/lib/modelSelection.ts')
const { cropRect, fitWholeCharacter } = load('src/lib/imageCrop.ts')
const { promptPresets, searchPromptPresets } = load('src/lib/promptPresets.ts')

test('graph-building basics: crop fit, prompt presets, frameCount ladder, cropRect containment', () => {
  assert.equal(fitWholeCharacter({ path: 'character.png', name: 'Character', kind: 'image' }).crop.fit, 'contain')
  assert.equal(fitWholeCharacter({ path: 'character.png', name: 'Character', kind: 'image', crop: { x: .5, y: .5, zoom: 1, fit: 'crop' } }).crop.fit, 'crop')
  assert.ok(promptPresets.length >= 190)
  assert.ok(searchPromptPresets('dolly zoom').some((item) => item.id === 'camera.vertigo'))
  for (let seconds = 2; seconds <= 15; seconds += 0.5) {
    const frames = frameCount(seconds)
    assert.equal((frames - 5) % 17, 0)
    assert.ok(frames >= Math.round(seconds * 24))
    assert.ok(frames < Math.round(seconds * 24) + 17)
  }
  for (const [width, height] of [[608, 352], [352, 608], [768, 768]]) {
    for (const x of [0, 0.5, 1]) for (const y of [0, 0.5, 1]) for (const zoom of [1, 2, 4]) {
      const r = cropRect(1000, 500, width, height, { x, y, zoom, fit: 'crop' })
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1000.0001 && r.y + r.h <= 500.0001)
      assert.ok(Math.abs(r.w / r.h - width / height) < 0.0001)
    }
  }
})

const models = { fl2va: 'fl2va', ref2va: 'ref2va', textEncoder: 'clip', videoVae: 'video', audioVae: 'audio', fl2vLora: 'fl-lora', ref2vLora: 'ref-lora' }

test('the official H3 graph across modes/durations incl. the RTX upscale chain + linked-node integrity', () => {
  for (const mode of ['text', 'image', 'frames', 'reference']) for (const duration of [2, 3, 5, 15]) {
    const g = buildMiniMaxWorkflow({ mode, width: 352, height: 608, prompt: 'neutral test', duration, seed: 123, steps: 20, turbo: '8', sampler: 'heun', scheduler: 'karras', filenamePrefix: 'test', refImageSize: 'match', upscale: { type: 'rtx', model: 'rtx-upscale.pth' } }, models, { first: { name: 'first.png' }, last: { name: 'last.png' }, images: [{ name: 'ref.png' }], videos: [], audios: [] })
    assert.equal(g['13'].inputs.sampler_name, OFFICIAL_H3_SAMPLER)
    assert.equal(g['14'].inputs.scheduler, OFFICIAL_H3_SCHEDULER)
    assert.equal(g['14'].inputs.steps, 8)
    assert.equal(g['2'].inputs.type, 'minimax')
    assert.equal(g['18'].inputs.fps, 24)
    assert.equal(g['18'].inputs.bit_depth, 8)
    assert.equal(g['10'].inputs.width, 352)
    assert.equal(g['10'].inputs.length, frameCount(duration))
    assert.equal(g['80'].class_type, 'UpscaleModelLoader')
    assert.equal(g['80'].inputs.model_name, 'rtx-upscale.pth')
    assert.equal(g['81'].class_type, 'ImageUpscaleWithModel')
    assert.equal(g['81'].inputs.image[0], '16')
    assert.equal(g['82'].class_type, 'ImageScale')
    assert.equal(g['82'].inputs.width, 352 * 2)
    assert.equal(g['82'].inputs.height, 608 * 2)
    assert.equal(g['83'].inputs.audio[0], '17')
    assert.equal(g['83'].inputs.fps, 24)
    assert.ok(g['84'].inputs.filename_prefix.endsWith('_RTX_AI_2x'))
    assert.ok(g['19'] && g['84'])
    assert.equal(g['71'].class_type, 'ImageFromBatch')
    assert.equal(g['72'].class_type, 'PreviewImage')
    for (const node of Object.values(g)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(g[value[0]], `Missing linked node ${value[0]}`)
  }
})

test('full-quality + preview-override + compatibility-turbo graphs', () => {
  const fullQuality = buildMiniMaxWorkflow({ mode: 'text', width: 1344, height: 768, prompt: 'test', duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'heun', scheduler: 'karras', filenamePrefix: 'test', refImageSize: 'match' }, models, { images: [], videos: [], audios: [] })
  assert.equal(fullQuality['13'].inputs.sampler_name, OFFICIAL_H3_SAMPLER)
  assert.equal(fullQuality['14'].inputs.scheduler, OFFICIAL_H3_SCHEDULER)
  assert.equal(fullQuality['14'].inputs.steps, 20)

  const previewGraph = buildMiniMaxWorkflow({ mode: 'reference', width: 1344, height: 768, prompt: 'test', duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', previewOverride: { frames: 50, fps: 12, nodeType: 'MiniMaxH3PreviewOverride', vaeName: 'taeh3_decoder.safetensors', jpegQuality: 85 } }, models, { images: [{ name: 'ref.png' }], videos: [], audios: [] })
  assert.equal(previewGraph['7'].class_type, 'MiniMaxH3PreviewOverride')
  assert.equal(previewGraph['7'].inputs.vae_name, 'taeh3_decoder.safetensors')
  assert.equal(previewGraph['7'].inputs.jpeg_quality, 85)
  assert.equal(previewGraph['12'].inputs.model[0], '7')

  const compatibilityTurbo = buildMiniMaxWorkflow({ mode: 'text', width: 1344, height: 768, prompt: 'test', duration: 5, seed: 1, steps: 20, turbo: '8', experimentalSampling: true, loraStrength: 0.9, sampler: 'euler', scheduler: 'beta', sigmaShift: { video: 12, audio: 4 }, filenamePrefix: 'test', refImageSize: 'match' }, models, { images: [], videos: [], audios: [] })
  assert.equal(compatibilityTurbo['5'].inputs.strength_model, 0.9)
  assert.equal(compatibilityTurbo['6'].class_type, 'MiniMaxH3SigmaShift')
  assert.equal(compatibilityTurbo['6'].inputs.shift_video, 12)
  assert.equal(compatibilityTurbo['6'].inputs.shift_audio, 4)
  assert.equal(compatibilityTurbo['12'].inputs.model[0], '6')
  assert.equal(compatibilityTurbo['14'].inputs.model[0], '6')
  assert.equal(compatibilityTurbo['13'].inputs.sampler_name, 'euler')
  assert.equal(compatibilityTurbo['14'].inputs.scheduler, 'beta')
  assert.equal(compatibilityTurbo['14'].inputs.steps, 8)

  const officialModels = inferSelections([
    { kind: 'diffusion_models', name: 'minimax_h3_fl2va_other.safetensors' },
    { kind: 'diffusion_models', name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors' },
    { kind: 'diffusion_models', name: 'minimax_h3_fl2va_unsupported.gguf' },
    { kind: 'diffusion_models', name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors' },
    { kind: 'text_encoders', name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' },
    { kind: 'vae', name: 'minimax_h3_video_vae_fp16.safetensors' },
    { kind: 'vae', name: 'minimax_h3_audio_vae_fp32.safetensors' },
    { kind: 'loras', name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' },
    { kind: 'loras', name: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors' },
  ], '8')
  assert.equal(officialModels.fl2va, 'minimax_h3_fl2va_pruned_int8_convrot.safetensors')
  assert.equal(officialModels.ref2vLora, '')
  const refFour = inferSelections([{ kind: 'loras', name: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors' }], '4')
  assert.equal(refFour.ref2vLora, 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors')
})

// (The LTX-2.5 workflow matrix + Z-Image graph tests were removed with LTX
// and Z-Image — Phase 0, 2026-09-20; git history is the archive.)

// ---------------------------------------------------------------------------
// Model overrides (task euxwdva) — the explicit-pick layer over the
// inference ladder. Failing-without-it: every assertion below that names the
// community merge or a refusal/degradation outcome fails on the pre-override
// ladder (inference returns '' or the pattern-matched official file, and no
// refusal vocabulary exists).
// ---------------------------------------------------------------------------
const overridesModule = load('src/lib/modelOverrides.ts')
const { mergeModelOverrides, resolveModelOverrides, resolveModels, inferredOverrideSlotFile, overridePickOutcome, MODEL_FAMILIES } = overridesModule
const h3StackModule = load('src/lib/h3Stack.ts')
const manifestModule = load('src/lib/manifest.ts')
const mergeName = 'TenStrip_10Eros-Max_beta5_int8.safetensors'
// (Wave 2 R-12) The fixture IS an instance-registry listing: plain
// {name, kind, bytes: 0} rows, engine-relative names, no h3Form and no
// source tags — the scan that once produced the form/source half is gone.
const overrideScan = [
  { kind: 'diffusion_models', name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', bytes: 0 },
  { kind: 'diffusion_models', name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', bytes: 0 },
  // The maintainer's community merge: matching NO selection pattern — the
  // override layer's whole reason to exist.
  { kind: 'diffusion_models', name: mergeName, bytes: 0 },
  // A diffusion file the old form gate would have refused — under
  // registry-only the engine is the arbiter, so a pick of it applies.
  { kind: 'diffusion_models', name: 'community_noform_transformer.safetensors', bytes: 0 },
  { kind: 'text_encoders', name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', bytes: 0 },
  { kind: 'vae', name: 'minimax_h3_video_vae_fp16.safetensors', bytes: 0 },
  { kind: 'vae', name: 'minimax_h3_audio_vae_fp32.safetensors', bytes: 0 },
  { kind: 'vae', name: 'minimax_h3_t1_image_vae_step1597.safetensors', bytes: 0 },
  { kind: 'diffusion_models', name: 'music3_dit_int8.safetensors', bytes: 0 },
  { kind: 'text_encoders', name: 'music3_text_encoder_bf16.safetensors', bytes: 0 },
  { kind: 'vae', name: 'music3_dav.safetensors', bytes: 0 },
]
const inferredH3 = () => inferSelections(overrideScan, 'off')

test('model overrides take 1 (euxwdva): consulted picks, auto-unchanged, precedence, refusals, degradation, case canonicalization, family mapping, graph+manifest, stack report', () => {
  // 1. The override is CONSULTED: a scanned file no pattern matches becomes the
  //    resolved pick — both H3 checkpoint lanes (the legacy single-checkpoint
  //    pick migrates onto fl2va+ref2va; only the mode's slot loads).
  assert.equal(inferredH3().fl2va, 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'sanity: inference finds the official file, never the merge')
  const mergeResolved = resolveModels('minimax', inferredH3(), overrideScan, { checkpoint: mergeName })
  assert.equal(mergeResolved.selection.fl2va, mergeName, 'the community merge becomes FL2VA via override')
  assert.equal(mergeResolved.selection.ref2va, mergeName, 'the community merge becomes Ref2VA via override')
  assert.equal(mergeResolved.resolution.applied.fl2va, mergeName, 'the legacy pick applies on the migrated lanes')
  assert.equal(mergeResolved.resolution.refusals.length, 0)
  assert.equal(mergeResolved.resolution.warnings.length, 0)

  // 2. AUTO UNCHANGED when unset — empty overrides, no key, blank strings: the
  //    selection is byte-identical to inference and every slot reports auto.
  for (const emptyOverrides of [undefined, {}, { checkpoint: '' }, { checkpoint: '   ' }]) {
    const auto = resolveModels('minimax', inferredH3(), overrideScan, emptyOverrides)
    assert.equal([auto.selection.fl2va, auto.selection.ref2va, auto.selection.textEncoder, auto.selection.videoVae, auto.selection.audioVae].join('|'),
      [inferredH3().fl2va, inferredH3().ref2va, inferredH3().textEncoder, inferredH3().videoVae, inferredH3().audioVae].join('|'),
      `auto selection is inference exactly (${JSON.stringify(emptyOverrides)})`)
    assert.equal(auto.resolution.slots.checkpoint.state, 'auto')
    assert.equal(auto.resolution.slots.textEncoder.state, 'auto')
    assert.equal(auto.resolution.slots.vae.state, 'auto')
    assert.equal(Object.keys(auto.resolution.applied).length, 0)
  }

  // 3. PRECEDENCE: chain > global > auto, per slot.
  const chainOverGlobal = mergeModelOverrides({ checkpoint: 'chain-pick.safetensors' }, { checkpoint: 'global-pick.safetensors', textEncoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' })
  assert.equal(chainOverGlobal.checkpoint, 'chain-pick.safetensors', 'chain beats global')
  assert.equal(chainOverGlobal.textEncoder, 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'unset chain slot falls to global')
  const globalOnly = mergeModelOverrides(undefined, { vae: 'minimax_h3_video_vae_fp16.safetensors' })
  assert.equal(globalOnly.vae, 'minimax_h3_video_vae_fp16.safetensors')
  const layered = resolveModels('minimax', inferredH3(), overrideScan, mergeModelOverrides({ textEncoder: 'music3_text_encoder_bf16.safetensors' }, { checkpoint: mergeName }))
  assert.equal(layered.selection.fl2va, mergeName, 'global checkpoint applies under a chain TE pick')
  assert.equal(layered.selection.textEncoder, 'music3_text_encoder_bf16.safetensors', 'chain text-encoder beats global absence')

  // 4. WRONG-KIND REFUSALS — the pick exists in the scan but the family
  //    contract rejects it; the submission refuses, the selection stays auto.
  //    (Wave 1 R-06/D3 update: a LEGACY checkpoint pick refusing on its
  //    MIGRATED lane now AUTO-CLEARS with a warning instead of refusing —
  //    the user never chose it at that lane slot; a conscious post-split
  //    pick in the same slot still refuses, asserted after these.)
  const wrongKind = resolveModelOverrides('minimax', overrideScan, { checkpoint: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' })
  assert.equal(wrongKind.slots.fl2va.state, 'cleared', 'D3: the migrated legacy wrong-kind pick auto-clears')
  assert.equal(wrongKind.refusals.length, 0, 'D3: nothing refuses — the render proceeds')
  assert.ok(wrongKind.warnings.some((warning) => warning.includes('legacy model pick')), 'D3: the clear warns visibly')
  assert.equal(wrongKind.applied.fl2va, undefined)
  const wrongKindResolved = resolveModels('minimax', inferredH3(), overrideScan, { checkpoint: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' })
  assert.equal(wrongKindResolved.selection.fl2va, inferredH3().fl2va, 'the cleared pick never reaches the selection')
  // (Wave 2 R-12) The h3Form gate died with the local scan — the registry
  // lists filenames only, so nothing app-side clears or clears a file by
  // its internals: the legacy pick of the no-form file now simply APPLIES
  // and the engine decides at load.
  const noForm = resolveModelOverrides('minimax', overrideScan, { checkpoint: 'community_noform_transformer.safetensors' })
  assert.equal(noForm.slots.fl2va.state, 'applied', 'registry-only: no app-side form gate exists — the engine is the arbiter')
  assert.equal(noForm.slots.fl2va.file, 'community_noform_transformer.safetensors')
  assert.equal(noForm.refusals.length, 0)
  // The T=1 image VAE refuses for the video family via the decoder-split
  // videoVae key directly (an explicit POST-split pick). The legacy 'vae' key
  // no longer lands there at all (tmz8vh7 decoder-class routing — see take 3
  // for the full matrix); the maintainer's first-session wedge was exactly
  // that legacy landing refusing every video render.
  const t1VaeDirect = resolveModelOverrides('minimax', overrideScan, { videoVae: 'minimax_h3_t1_image_vae_step1597.safetensors' })
  assert.equal(t1VaeDirect.slots.videoVae.state, 'refused', 'the T=1 image VAE refuses on the videoVae slot directly')
  const unexposedSlot = resolveModelOverrides('music3', overrideScan, { imageVae: 'minimax_h3_t1_image_vae_step1597.safetensors' })
  assert.equal(unexposedSlot.slots.imageVae.state, 'refused', 'a slot the family does not expose refuses, never silently drops')

  // 5. MISSING-FILE DEGRADATION: the file vanished since it was set — auto with
  //    a visible warning, not a refusal.
  const degraded = resolveModelOverrides('minimax', overrideScan, { checkpoint: 'deleted_merge_v2.safetensors' })
  assert.equal(degraded.slots.fl2va.state, 'degraded')
  assert.equal(degraded.warnings.length, 2, 'both migrated lanes warn')
  assert.ok(degraded.warnings[0].includes('engine\'s model registry'), 'warning states the registry fallback: ' + degraded.warnings[0])
  assert.equal(degraded.applied.fl2va, undefined)
  const degradedResolved = resolveModels('minimax', inferredH3(), overrideScan, { checkpoint: 'deleted_merge_v2.safetensors' })
  assert.equal(degradedResolved.selection.fl2va, inferredH3().fl2va, 'degradation falls back to inference')

  // 6. CASE CANONICALIZATION: the pick resolves to the SCANNED file's real
  //    name, so a case-drifted pick never outlives its file.
  const caseDrift = resolveModelOverrides('minimax', overrideScan, { checkpoint: 'tenstrip_10eros-max_BETA5_int8.safetensors' })
  assert.equal(caseDrift.slots.fl2va.state, 'applied')
  assert.equal(caseDrift.slots.fl2va.file, mergeName)

  // 7. PER-FAMILY FIELD MAPPING (one seam, every family).
  const music3Module = load('src/lib/music3Workflow.ts')
  const music3FromScan = music3Module.inferMusic3Selection(overrideScan)
  const music3Override = resolveModels('music3', music3FromScan, overrideScan, { checkpoint: 'music3_dit_int8.safetensors', vae: 'music3_dav.safetensors' })
  assert.equal(music3Override.selection.diffusion, 'music3_dit_int8.safetensors')
  assert.equal(music3Override.selection.vae, 'music3_dav.safetensors')

  // 8. THE GRAPH carries the override (both render modes' checkpoint slot) and
  //    leaves the auto slots on inference; the manifest records the chosen
  //    files plus which slots were picks. (mergeResolved from point 1 above.)
  for (const mode of ['text', 'reference']) {
    const graph = buildMiniMaxWorkflow({ mode, width: 352, height: 608, prompt: 'override probe', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', ...(mode === 'reference' ? { referenceImages: ['ref.png'] } : {}) }, mergeResolved.selection, mode === 'reference' ? { images: [{ name: 'ref.png' }], videos: [], audios: [] } : { images: [], videos: [], audios: [] })
    assert.equal(graph['1'].inputs.unet_name, mergeName, `${mode} mode loads the merge`)
    assert.equal(graph['2'].inputs.clip_name, 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', `${mode} mode keeps the auto text encoder`)
    assert.equal(graph['3'].inputs.vae_name, 'minimax_h3_video_vae_fp16.safetensors', `${mode} mode keeps the auto video VAE`)
  }
  const overrideManifest = manifestModule.buildRenderManifest({ mode: 'text', prompt: 'p', width: 352, height: 608, duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [] }, mergeResolved.selection, overrideScan, 'http://engine', buildMiniMaxWorkflow({ mode: 'text', width: 352, height: 608, prompt: 'p', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match', referenceImages: [], referenceVideos: [], referenceAudios: [] }, mergeResolved.selection, { images: [], videos: [], audios: [] }))
  assert.equal(overrideManifest.models.diffusion.name, mergeName, 'the manifest carries the chosen checkpoint')
  assert.equal(overrideManifest.models.textEncoder.name, 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'the manifest carries the auto slots too')

  // 9. The STACK REPORT validates the resolved pick: the override row shows the
  //    user's file, flagged; rows without picks are untouched.
  const plainReport = h3StackModule.h3StackReport(overrideScan)
  assert.equal(plainReport.rows[0].selected, 'minimax_h3_fl2va_pruned_int8_convrot.safetensors')
  assert.equal(plainReport.rows[0].override, false)
  const overrideReport = h3StackModule.h3StackReport(overrideScan, { checkpoint: mergeName })
  assert.equal(overrideReport.rows[0].selected, mergeName, 'the FL2VA row shows the user pick')
  assert.equal(overrideReport.rows[0].override, true)
  assert.equal(overrideReport.rows[0].validated, false, 'a community merge reads Custom, honestly')
  assert.equal(overrideReport.validated, false)
  assert.equal(overrideReport.rows[1].override, false, 'the text-encoder row is untouched by a checkpoint pick')

  // 10. The single-pick outcome helper agrees with resolution (one validation
  //     path for the pickers and the ladder) and the auto label helper reports
  //     what auto resolves to.
  assert.equal(overridePickOutcome('minimax', 'fl2va', mergeName, overrideScan).state, 'applied')
  assert.equal(overridePickOutcome('minimax', 'fl2va', 'gone.safetensors', overrideScan).state, 'degraded')
  assert.equal(inferredOverrideSlotFile('minimax', 'fl2va', overrideScan), 'minimax_h3_fl2va_pruned_int8_convrot.safetensors')
  assert.equal(inferredOverrideSlotFile('minimax', 'textEncoder', overrideScan), 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors')
  // 4 → 3 with the ACE-Step family's removal, 2026-09-21 (nn5ld47).
  assert.equal(MODEL_FAMILIES.length, 3)
})

// ---------------------------------------------------------------------------
// Model overrides, take 2 (task rq0lsax, 2026-09-20; rewritten Wave 2 R-12)
// — the per-lane checkpoint split (fl2va / ref2va / merged) over a
// SUBPATH-RICH registry. Failing-without-it: on the pre-split layer the
// fl2va/ref2va/merged slot keys did not exist, and the pre-Wave-2 anchors
// never matched subpathed rows (^-anchored against the full name).
// ---------------------------------------------------------------------------
const instanceScan = overrideScan.concat([
  // Engine-relative subpathed names — exactly what the instance /models
  // contract lists and what the graph loaders accept (the maintainer's
  // rq0lsax case, now the ONLY shape there is).
  { kind: 'diffusion_models', name: 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', bytes: 0 },
  { kind: 'diffusion_models', name: 'H3/ssd/minimax_h3_ref2va_pruned_int8_convrot.safetensors', bytes: 0 },
  { kind: 'diffusion_models', name: 'H3/ssd/community_merged_full.safetensors', bytes: 0 },
])

test('model overrides take 2 (rq0lsax, R-12): subpathed registry rows resolve everywhere, per-lane resolution, the merged lane, legacy migration', () => {
  // 11. REGISTRY-ONLY (R-12): every row IS the instance's listing — a pick
  //     of a subpathed row applies cleanly (no form vocabulary exists, no
  //     source tags exist), and the INFERENCE finds subpathed rows by their
  //     basename while returning the full registry name.
  const instanceFl2va = resolveModelOverrides('minimax', instanceScan, { fl2va: 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors' })
  assert.equal(instanceFl2va.slots.fl2va.state, 'applied', 'a subpathed registry pick applies')
  assert.equal(instanceFl2va.slots.fl2va.warning, undefined, 'no warning vocabulary for registry rows — the engine is the arbiter')
  assert.equal(instanceFl2va.refusals.length, 0)
  assert.equal(instanceFl2va.applied.fl2va, 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors')
  const instanceBoth = resolveModelOverrides('minimax', instanceScan, { merged: 'H3/ssd/community_merged_full.safetensors' })
  assert.equal(instanceBoth.slots.merged.state, 'applied', 'the subpathed community merge applies on the merged lane')
  // The loosened anchors (Wave 2): the ladder matches the BASENAME and
  // returns the full registry subpath. When flat and subpathed twins are
  // both listed, either registry row is a legal resolution (both load);
  // when ONLY the subpathed row exists, it resolves by basename.
  const subpathInferred = inferSelections(instanceScan, 'off')
  assert.ok(['minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'H3/ssd/minimax_h3_ref2va_pruned_int8_convrot.safetensors'].includes(subpathInferred.ref2va), 'a registry row resolves for the ref2va slot either way: ' + subpathInferred.ref2va)
  const onlySubpathed = instanceScan.filter((file) => !(file.kind === 'diffusion_models' && file.name.startsWith('minimax_h3_')))
  const subpathOnly = inferSelections(onlySubpathed, 'off')
  assert.equal(subpathOnly.fl2va, 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'a subpath-only listing resolves by basename and returns the FULL registry name (what the loader accepts)')
  // The maintainer's exact report shape: the legacy single-checkpoint pick
  // of a subpathed registry file resolves onto both lanes, verbatim.
  const maintainerCase = resolveModels('minimax', inferSelections(instanceScan, 'off'), instanceScan, { checkpoint: 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors' })
  assert.equal(maintainerCase.selection.fl2va, 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'the legacy pick of the subpathed file reaches the FL2VA lane')
  assert.equal(maintainerCase.resolution.refusals.length, 0, 'the H3/ssd refusal is gone')

  // 12. PER-MODE RESOLUTION (AC-2): each lane pick owns ITS lane; the other
  //     lane stays on inference — the split is real, not a rename.
  const fl2vaLane = resolveModels('minimax', inferredH3(), overrideScan, { fl2va: mergeName })
  assert.equal(fl2vaLane.selection.fl2va, mergeName, 'the fl2va pick owns the FL2VA lane')
  assert.equal(fl2vaLane.selection.ref2va, inferredH3().ref2va, 'the Ref2VA lane stays on inference under an fl2va-only pick')
  assert.equal(fl2vaLane.selection.merged, undefined, 'no merged field unless the merged pick applies')
  const ref2vaLane = resolveModels('minimax', inferredH3(), overrideScan, { ref2va: mergeName })
  assert.equal(ref2vaLane.selection.ref2va, mergeName, 'the ref2va pick owns the Ref2VA lane')
  assert.equal(ref2vaLane.selection.fl2va, inferredH3().fl2va, 'the FL2VA lane stays on inference under a ref2va-only pick')
  for (const [mode, expected] of [['text', mergeName], ['reference', 'minimax_h3_ref2va_pruned_int8_convrot.safetensors']]) {
    const graph = buildMiniMaxWorkflow({ mode, width: 352, height: 608, prompt: 'lane probe', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', ...(mode === 'reference' ? { referenceImages: ['ref.png'] } : {}) }, fl2vaLane.selection, mode === 'reference' ? { images: [{ name: 'ref.png' }], videos: [], audios: [] } : { images: [], videos: [], audios: [] })
    assert.equal(graph['1'].inputs.unet_name, expected, `${mode} mode loads its OWN lane's resolution (the fl2va pick never leaks into the reference graph)`)
  }
  for (const [mode, expected] of [['text', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'], ['reference', mergeName]]) {
    const graph = buildMiniMaxWorkflow({ mode, width: 352, height: 608, prompt: 'lane probe', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', ...(mode === 'reference' ? { referenceImages: ['ref.png'] } : {}) }, ref2vaLane.selection, mode === 'reference' ? { images: [{ name: 'ref.png' }], videos: [], audios: [] } : { images: [], videos: [], audios: [] })
    assert.equal(graph['1'].inputs.unet_name, expected, `${mode} mode loads its OWN lane's resolution (the ref2va pick never leaks into the text graph)`)
  }

  // 13. THE MERGED LANE (AC-2): a merged pick is ONE checkpoint for both lanes
  //     — it fills fl2va, ref2va AND merged, so both render modes load it and
  //     the readiness gates see a complete stack with zero extra plumbing.
  const mergedResolved = resolveModels('minimax', inferredH3(), overrideScan, { merged: mergeName })
  assert.equal(mergedResolved.selection.merged, mergeName)
  assert.equal(mergedResolved.selection.fl2va, mergeName, 'the merged pick fills the FL2VA lane')
  assert.equal(mergedResolved.selection.ref2va, mergeName, 'the merged pick fills the Ref2VA lane')
  assert.equal(mergedResolved.resolution.applied.merged, mergeName)
  assert.equal(mergedResolved.resolution.warnings.length, 0, 'a lone merged pick warns about nothing')
  for (const mode of ['text', 'reference']) {
    const graph = buildMiniMaxWorkflow({ mode, width: 352, height: 608, prompt: 'merged probe', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', ...(mode === 'reference' ? { referenceImages: ['ref.png'] } : {}) }, mergedResolved.selection, mode === 'reference' ? { images: [{ name: 'ref.png' }], videos: [], audios: [] } : { images: [], videos: [], audios: [] })
    assert.equal(graph['1'].inputs.unet_name, mergeName, `${mode} mode loads the merged checkpoint`)
  }
  const mergedManifest = manifestModule.buildRenderManifest({ mode: 'text', prompt: 'p', width: 352, height: 608, duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [] }, mergedResolved.selection, overrideScan, 'http://engine', buildMiniMaxWorkflow({ mode: 'text', width: 352, height: 608, prompt: 'p', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [] }, mergedResolved.selection, { images: [], videos: [], audios: [] }))
  assert.equal(mergedManifest.models.diffusion.name, mergeName, 'the manifest carries the merged checkpoint')
  // Simultaneously-set lane picks are SUPERSEDED, loudly — never a silent drop.
  const superseded = resolveModelOverrides('minimax', overrideScan, { merged: mergeName, fl2va: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors' })
  assert.ok(superseded.warnings.some((warning) => warning.includes('superseded')), 'a lane pick under a merged pick gets the superseded warning')
  assert.equal(superseded.refusals.length, 0)
  const supersededSelection = resolveModels('minimax', inferredH3(), overrideScan, { merged: mergeName, fl2va: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors' }).selection
  assert.equal(supersededSelection.fl2va, mergeName, 'the merged pick wins its lane when both are set')

  // 14. LEGACY MIGRATION (AC-5): the pre-split single-checkpoint pick drives
  //     BOTH lanes exactly as it did before the split (dated decision
  //     2026-09-20: fl2va+ref2va, behavior-preserving — fl2va-only would have
  //     silently re-inferred the reference lane); fill-if-unset lets a new
  //     lane pick win its own lane over the legacy value.
  const migrated = overridesModule.migrateLegacyModelOverrideSlots('minimax', { checkpoint: mergeName })
  assert.equal(migrated.fl2va, mergeName, 'the legacy pick lands on the FL2VA lane')
  assert.equal(migrated.ref2va, mergeName, 'the legacy pick lands on the Ref2VA lane too — behavior preserved')
  assert.equal('checkpoint' in migrated, false, 'the legacy key is consumed, never re-refused as an unexposed slot')
  const migratedPartial = overridesModule.migrateLegacyModelOverrideSlots('minimax', { checkpoint: mergeName, fl2va: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors' })
  assert.equal(migratedPartial.fl2va, 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'an explicit new-lane pick wins its lane over the legacy value')
  assert.equal(migratedPartial.ref2va, mergeName, 'the unset lane inherits the legacy pick')
  assert.equal('checkpoint' in overridesModule.migrateLegacyModelOverrideSlots('music3', { checkpoint: 'x.safetensors' }), true, 'non-H3 families keep the generic checkpoint slot untouched')
  const legacyResolution = resolveModelOverrides('minimax', overrideScan, { checkpoint: mergeName })
  assert.equal(legacyResolution.slots.fl2va.state, 'applied', 'the resolution seam migrates a legacy pick at consult time')
  assert.equal(legacyResolution.slots.ref2va.state, 'applied')
  assert.equal(legacyResolution.refusals.length, 0, 'the consumed legacy key never trips the unexposed-slot refusal')

  // 15. The per-lane slots ride the layering and pickers like the old one did.
  const laneLayered = mergeModelOverrides({ fl2va: 'chain-lane.safetensors' }, { fl2va: 'global-lane.safetensors', ref2va: 'global-ref.safetensors', merged: 'global-merge.safetensors' })
  assert.equal(laneLayered.fl2va, 'chain-lane.safetensors', 'chain beats global per lane')
  assert.equal(laneLayered.ref2va, 'global-ref.safetensors')
  assert.equal(laneLayered.merged, 'global-merge.safetensors')
  assert.equal(overridePickOutcome('minimax', 'fl2va', mergeName, overrideScan).state, 'applied')
  assert.equal(overridePickOutcome('minimax', 'ref2va', 'gone.safetensors', overrideScan).state, 'degraded')
  assert.equal(inferredOverrideSlotFile('minimax', 'fl2va', overrideScan), 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'the fl2va auto label shows the FL2VA inference')
  assert.equal(inferredOverrideSlotFile('minimax', 'ref2va', overrideScan), 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'the ref2va auto label shows the Ref2VA inference')
  assert.equal(inferredOverrideSlotFile('minimax', 'merged', overrideScan), '', 'the merged slot never infers — community merges are name-invisible by design')
})

// ---------------------------------------------------------------------------
// Model overrides, take 3 (task epdvxd4, 2026-09-20) — the VAE slots split
// by DECODER CLASS: videoVae / audioVae / imageVae (the Mamad8 T=1 decoder).
// Failing-without-it: on the pre-split layer the three slot keys did not
// exist (every family refused them as unexposed), the audio VAE was
// unreachable by pick on EVERY family (the old 'vae' slot drove only the
// video decoder where one existed), and the T=1 legality map was implicit.
// ---------------------------------------------------------------------------
const h3imageGraphModule = load('src/lib/graph/h3image.ts')
const music3Module = load('src/lib/music3Workflow.ts')
const OVERRIDE_SLOT_KEYS = overridesModule.OVERRIDE_SLOTS
// The H3 Image Studio pack served (afvlbk4): the T=1 family is
// studio-conditioned — these walk/audit arms pass the pack-present stub so
// the graph builds (a pack-absent engine refuses T=1 at build; the refusal
// itself is covered in tests/h3img.test.js (i) and tests/canvas.test.js).
const STUDIO_PACK_INFO = { H3ImagePrepare: {} }
const t1Alt = 'minimax_h3_t1_image_vae_step2048.safetensors'
const vaeSplitScan = overrideScan.concat([
  // A newer-step Mamad8 decoder: matches the T1 pattern (the image class)
  // but NO inference pattern — only a pick can select it.
  { kind: 'vae', name: t1Alt },
  // The unmarked-class file: no video/audio/dav/T1 marker — the documented
  // heuristic limit (applies, engine stays arbiter).
  { kind: 'vae', name: 'ace_1.5_vae.safetensors' },
  // The FL2VA turbo LoRA — the T=1 Fast profile's pinned recipe LoRA.
  { kind: 'loras', name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' },
])

test('model overrides take 3 (epdvxd4): the decoder-split VAE trio — resolution, per-family legality, marker refusals, legacy migration', () => {
  // 16. THE TRIO RESOLVES (AC-1): each slot independently overrides its own
  //     decoder; unset slots stay on inference.
  const split = resolveModels('minimax', inferSelections(vaeSplitScan, 'off'), vaeSplitScan, {
    videoVae: 'minimax_h3_audio_vae_fp32.safetensors', // refused below — proves independence
  })
  assert.equal(split.resolution.slots.videoVae.state, 'refused', 'a cross-class pick refuses instead of landing')
  const videoOnly = resolveModels('minimax', inferSelections(vaeSplitScan, 'off'), vaeSplitScan, { videoVae: 'minimax_h3_video_vae_fp16.safetensors' })
  assert.equal(videoOnly.selection.audioVae, 'minimax_h3_audio_vae_fp32.safetensors', 'the audio lane stays on inference under a video-only pick')
  const audioPicked = resolveModels('minimax', inferSelections(vaeSplitScan, 'off'), vaeSplitScan, { audioVae: 'minimax_h3_audio_vae_fp32.safetensors' })
  assert.equal(audioPicked.resolution.slots.audioVae.state, 'applied')
  assert.equal(audioPicked.selection.audioVae, 'minimax_h3_audio_vae_fp32.safetensors')
  // THE GRAPH: the two picks feed the graph's TWO VAELoader nodes (3/4).
  for (const [mode, uploads] of [['text', { images: [], videos: [], audios: [] }], ['reference', { images: [{ name: 'ref.png' }], videos: [], audios: [] }]]) {
    const graph = buildMiniMaxWorkflow({ mode, width: 352, height: 608, prompt: 'vae trio', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', ...(mode === 'reference' ? { referenceImages: ['ref.png'] } : {}) }, videoOnly.selection, uploads)
    assert.equal(graph['3'].inputs.vae_name, 'minimax_h3_video_vae_fp16.safetensors', `${mode}: node 3 loads the video VAE`)
    assert.equal(graph['4'].inputs.vae_name, 'minimax_h3_audio_vae_fp32.safetensors', `${mode}: node 4 loads the audio VAE`)
  }

  // 17. THE WORKBENCH TRIO (AC-1): video/audio at nodes 3/4 on the packet
  //     profile; the image VAE pick is the T=1 profile's decoder (node 3,
  //     the profile's own decode override) and ONLY exists on h3image.
  const h3imgInferred = h3imageGraphModule.inferH3ImgSelection(vaeSplitScan)
  const h3imgResolved = resolveModels('h3image', h3imgInferred, vaeSplitScan, {
    videoVae: 'minimax_h3_video_vae_fp16.safetensors',
    audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
    imageVae: t1Alt,
  })
  assert.equal(h3imgResolved.resolution.slots.imageVae.state, 'applied', 'the imageVae pick applies on the workbench family')
  assert.equal(h3imgResolved.selection.t1ImageVae, t1Alt, 'the pick drives the t1ImageVae field (the T=1 profile decoder)')
  const packetGraph = h3imageGraphModule.buildH3ImageGraph({ family: 'h3img.generate.packet', prompt: 'audit', width: 768, height: 768, seed: 1, tier: 5, refs: [], loras: [], filenamePrefix: 't' }, h3imgResolved.selection)
  assert.equal(packetGraph['3'].inputs.vae_name, 'minimax_h3_video_vae_fp16.safetensors', 'the packet profile decodes through the video VAE node')
  assert.equal(packetGraph['4'].inputs.vae_name, 'minimax_h3_audio_vae_fp32.safetensors', 'the audio VAE pick reaches node 4')
  const t1Graph = h3imageGraphModule.buildH3ImageGraph({ family: 'h3img.generate.t1', prompt: 'audit', width: 768, height: 768, seed: 1, tier: 1, refs: [], loras: [], filenamePrefix: 't' }, h3imgResolved.selection, STUDIO_PACK_INFO)
  assert.equal(t1Graph['3'].inputs.vae_name, t1Alt, 'the T=1 profile decodes through the PICKED image VAE at node 3')
  assert.equal(h3imageGraphModule.h3imgGraphAudit(t1Graph, { frames: 1 }).length, 0, 'the picked T=1 decoder stays legal in its single-frame graph')

  // 18. LEGALITY (AC-2/AC-4): the marker gate — cross-class picks refuse,
  //     the legality map caps the imageVae slot to the workbench, and the
  //     unmarked-class limit applies (documented: no VAE header-shape
  //     detection exists; the engine stays arbiter).
  assert.deepEqual([...overridesModule.IMAGE_VAE_FAMILIES].sort(), ['h3image'], 'the T=1 legality map: only the workbench accepts an imageVae pick')
  const videoFamilyImagePick = resolveModelOverrides('minimax', vaeSplitScan, { imageVae: t1Alt })
  assert.equal(videoFamilyImagePick.slots.imageVae.state, 'refused', 'the video family refuses the imageVae slot outright — every video graph is multi-frame (the factory ban)')
  const videoIntoImage = resolveModelOverrides('h3image', vaeSplitScan, { imageVae: 'minimax_h3_video_vae_fp16.safetensors' })
  assert.equal(videoIntoImage.slots.imageVae.state, 'refused', 'a video-class pick refuses on the imageVae slot')
  assert.ok(videoIntoImage.refusals[0].reason.includes('Mamad8'), 'the reason names the decoder class: ' + videoIntoImage.refusals[0].reason)
  const audioIntoVideo = resolveModelOverrides('minimax', vaeSplitScan, { videoVae: 'minimax_h3_audio_vae_fp32.safetensors' })
  assert.equal(audioIntoVideo.slots.videoVae.state, 'refused', 'an audio-class pick refuses on the videoVae slot')
  assert.ok(audioIntoVideo.refusals[0].reason.includes('audio'))
  const videoIntoAudio = resolveModelOverrides('minimax', vaeSplitScan, { audioVae: 'minimax_h3_video_vae_fp16.safetensors' })
  assert.equal(videoIntoAudio.slots.audioVae.state, 'refused', 'a video-class pick refuses on the audioVae slot')
  assert.ok(videoIntoAudio.refusals[0].reason.includes('video'))
  const davIntoVideo = resolveModelOverrides('music3', vaeSplitScan, { videoVae: 'music3_dav.safetensors' })
  assert.equal(davIntoVideo.slots.videoVae.state, 'refused', 'music3 exposes no videoVae slot — its one decoder is audio-class')
  const unmarked = resolveModelOverrides('minimax', vaeSplitScan, { audioVae: 'ace_1.5_vae.safetensors' })
  assert.equal(unmarked.slots.audioVae.state, 'applied', 'an unmarked-class VAE applies (the documented heuristic limit — the engine decides)')

  // 19. LEGACY MIGRATION (AC-5): the pre-split 'vae' pick lands on the slot
  //     that preserves its meaning PER FAMILY — videoVae on the video-bearing
  //     families, audioVae on the audio-only ones — never dropped.
  for (const family of ['minimax', 'h3image']) {
    const migrated = overridesModule.migrateLegacyModelOverrideSlots(family, { vae: 'legacy-decoder.safetensors' })
    assert.equal(migrated.videoVae, 'legacy-decoder.safetensors', `${family}: the legacy vae pick lands on videoVae (the old slot's meaning)`)
    assert.equal('vae' in migrated, false, `${family}: the consumed key never re-refuses`)
  }
  // (The acestep arm was removed with the family, 2026-09-21 — nn5ld47.)
  for (const family of ['music3']) {
    const migrated = overridesModule.migrateLegacyModelOverrideSlots(family, { vae: 'legacy-dav.safetensors' })
    assert.equal(migrated.audioVae, 'legacy-dav.safetensors', `${family}: the legacy vae pick lands on audioVae — the family's one decoder IS audio-class`)
    assert.equal('vae' in migrated, false)
  }
  const explicitWins = overridesModule.migrateLegacyModelOverrideSlots('minimax', { vae: 'legacy.safetensors', videoVae: 'new.safetensors' })
  assert.equal(explicitWins.videoVae, 'new.safetensors', 'an explicit split pick wins its slot over the legacy value')
  // 19b. DECODER-CLASS ROUTING (tmz8vh7, dated 2026-09-20): the pre-split
  //      slot's dropdown listed EVERY scanned VAE, so the pick's NAME routes
  //      it — a marked name never migrates onto a slot its class refuses
  //      (the maintainer's first-session wedge: a legacy T=1 pick on
  //      videoVae refusing every video render with the T=1 message).
  //      Failing-without-it: on the pre-routing migration each of these
  //      lands on the family-meaning slot and REFUSES at the gate.
  const t1File = 'minimax_h3_t1_image_vae_step1597.safetensors'
  // (The ltx25/ltx23 arms of this loop were removed with LTX — Phase 0,
  // 2026-09-20; the minimax arm carries the routing contract.)
  const videoFamilyInferred = {
    minimax: () => inferSelections(vaeSplitScan, 'off'),
  }
  for (const family of ['minimax']) {
    const dropped = overridesModule.migrateLegacyModelOverrideSlots(family, { vae: t1File })
    assert.equal('vae' in dropped, false, `${family}: the T=1-named legacy pick is consumed`)
    assert.equal(dropped.videoVae, undefined, `${family}: a T=1-named legacy pick never lands on videoVae`)
    assert.equal(dropped.imageVae, undefined, `${family}: no imageVae slot exists to catch it`)
    const throughSeam = resolveModels(family, videoFamilyInferred[family](), vaeSplitScan, { vae: t1File })
    assert.equal(throughSeam.resolution.refusals.length, 0, `${family}: the T=1 legacy pick no longer refuses anything (the maintainer's video render proceeds)`)
    assert.notEqual(throughSeam.selection.videoVae, t1File, `${family}: the T=1 file never reaches the video decoder field`)
    if (family === 'minimax') assert.equal(throughSeam.selection.videoVae, 'minimax_h3_video_vae_fp16.safetensors', 'minimax: video decode falls back to the inferred pick')
  }
  const t1ToImageSlot = overridesModule.migrateLegacyModelOverrideSlots('h3image', { vae: t1File })
  assert.equal(t1ToImageSlot.imageVae, t1File, 'h3image: a T=1-named legacy pick routes to imageVae — the one slot where that decoder is legal')
  assert.equal(t1ToImageSlot.videoVae, undefined, 'h3image: it never touches videoVae')
  const t1ToImageSeam = resolveModels('h3image', h3imageGraphModule.inferH3ImgSelection(vaeSplitScan), vaeSplitScan, { vae: t1File })
  assert.equal(t1ToImageSeam.selection.t1ImageVae, t1File, 'h3image: the routed legacy pick drives the T=1 profile decoder through the seam')
  assert.equal(t1ToImageSeam.resolution.refusals.length, 0)
  const audioNamed = overridesModule.migrateLegacyModelOverrideSlots('minimax', { vae: 'minimax_h3_audio_vae_fp32.safetensors' })
  assert.equal(audioNamed.audioVae, 'minimax_h3_audio_vae_fp32.safetensors', 'an audio-named legacy pick routes to audioVae on the video family (its real decoder class)')
  assert.equal(audioNamed.videoVae, undefined, 'it never lands on videoVae where the marker gate would refuse it')
  const videoNamedOnAudio = overridesModule.migrateLegacyModelOverrideSlots('music3', { vae: 'minimax_h3_video_vae_fp16.safetensors' })
  assert.equal(videoNamedOnAudio.audioVae, undefined, 'a video-named legacy pick on an audio family has no legal slot — dropped, not wedged onto audioVae')
  assert.equal('vae' in videoNamedOnAudio, false)
  const legacyThroughSeam = resolveModels('music3', music3Module.inferMusic3Selection(vaeSplitScan), vaeSplitScan, { vae: 'music3_dav.safetensors' })
  assert.equal(legacyThroughSeam.selection.vae, 'music3_dav.safetensors', 'a legacy music3 vae pick still reaches the DAV field through the seam')
  assert.equal(legacyThroughSeam.resolution.refusals.length, 0)
  // The layering seam carries the legacy key to the migration (never drops
  // it ahead of it) — the same contract that keeps legacy 'checkpoint' alive.
  const layeredLegacy = mergeModelOverrides({}, { vae: 'kept.safetensors' })
  assert.equal(layeredLegacy.vae, 'kept.safetensors', 'mergeModelOverrides carries the legacy key to the resolution seam')
  assert.equal(mergeModelOverrides({ videoVae: 'chain.safetensors' }, { vae: 'global-legacy.safetensors' }).videoVae, 'chain.safetensors', 'a chain-level split pick beats the legacy global')

  // 20. The auto labels name each decoder's own inference.
  assert.equal(inferredOverrideSlotFile('minimax', 'videoVae', vaeSplitScan), 'minimax_h3_video_vae_fp16.safetensors')
  assert.equal(inferredOverrideSlotFile('minimax', 'audioVae', vaeSplitScan), 'minimax_h3_audio_vae_fp32.safetensors')
  assert.equal(inferredOverrideSlotFile('h3image', 'imageVae', vaeSplitScan), 'minimax_h3_t1_image_vae_step1597.safetensors', 'the imageVae auto label shows the inferred Mamad8 file')
  assert.equal(inferredOverrideSlotFile('music3', 'audioVae', vaeSplitScan), 'music3_dav.safetensors', "the audio-only family's audioVae label reads its DAV inference")
  assert.equal(inferredOverrideSlotFile('minimax', 'imageVae', vaeSplitScan), '', 'a slot the family does not expose has no auto label')
})

// ---------------------------------------------------------------------------
// Model overrides, take 4 (task epdvxd4, AC-3) — THE WORKFLOW-POPULATION
// AUDIT as a test: every family's every EXPOSED slot traced pick →
// resolveModels → the graph factory → the concrete node input. Each pick is
// a file NO inference pattern matches, so a green row proves the OVERRIDE
// reached the node — not the ladder. Failing-without-it: on the pre-split
// layer the audioVae rows were unresolvable (no such slot existed) and the
// h3image imageVae row could never leave the inference pin.
// ---------------------------------------------------------------------------
const auditScan = vaeSplitScan.concat([
  { kind: 'diffusion_models', name: 'community_noform_transformer.safetensors', bytes: 0 },
  { kind: 'text_encoders', name: 'gemma_3_12B_it.safetensors', bytes: 0 },
  { kind: 'loras', name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', bytes: 0 },
  // The audit's own picks — community-style files NO inference pattern
  // matches (registry-only: no form gate exists, the engine decides).
  { kind: 'diffusion_models', name: 'community-merge-audit.safetensors', bytes: 0 },
  { kind: 'text_encoders', name: 'community-encoder-audit.safetensors' },
  { kind: 'vae', name: 'h3-community-video-decoder.safetensors' },
  { kind: 'vae', name: 'h3-community-audio-decoder.safetensors' },
  { kind: 'diffusion_models', name: 'music3-community-dit.safetensors' },
  { kind: 'vae', name: 'music3-community-dav.safetensors' },
])
// The audit's picks: community-style names the inference ladder is blind to.
const auditPicks = {
  checkpoint: 'community-merge-audit.safetensors',
  textEncoder: 'community-encoder-audit.safetensors',
  videoVae: 'h3-community-video-decoder.safetensors',
  audioVae: 'h3-community-audio-decoder.safetensors',
  imageVae: t1Alt,
}

test('the workflow-population audit (epdvxd4, AC-3): every family × every slot lands its resolved pick at the graph node', () => {
  // The audit picks are scanned files no pattern matches (the override
  // layer's whole reason to exist) — plus the T=1 alt, pattern-class legal.
  for (const name of [auditPicks.checkpoint, auditPicks.textEncoder, auditPicks.videoVae, auditPicks.audioVae]) {
    assert.ok(auditScan.some((file) => file.name === name), `the audit pick '${name}' is a scanned file`)
  }
  const at = (graph, id, input) => graph[String(id)].inputs[input]
  const assertAt = (label, graph, id, input, expected) => assert.equal(at(graph, id, input), expected, `${label}: node ${id}.${input}`)

  // --- minimax (H3 video): fl2va/ref2va/merged → UNETLoader 1 per mode
  //     (take 2 §12-13 proves the per-mode routing; here the merged pick +
  //     the shared slots land in one text-mode graph), TE → 2, VAEs → 3/4.
  const minimaxResolved = resolveModels('minimax', inferSelections(auditScan, 'off'), auditScan, {
    merged: mergeName,
    textEncoder: auditPicks.textEncoder,
    videoVae: auditPicks.videoVae,
    audioVae: auditPicks.audioVae,
  })
  assert.equal(minimaxResolved.resolution.refusals.length, 0, 'minimax audit picks all apply: ' + JSON.stringify(minimaxResolved.resolution.refusals))
  const minimaxGraph = buildMiniMaxWorkflow({ mode: 'text', width: 352, height: 608, prompt: 'audit', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match' }, minimaxResolved.selection, { images: [], videos: [], audios: [] })
  assertAt('minimax merged', minimaxGraph, 1, 'unet_name', mergeName)
  assertAt('minimax textEncoder', minimaxGraph, 2, 'clip_name', auditPicks.textEncoder)
  assertAt('minimax videoVae', minimaxGraph, 3, 'vae_name', auditPicks.videoVae)
  assertAt('minimax audioVae', minimaxGraph, 4, 'vae_name', auditPicks.audioVae)

  // --- h3image (the workbench): the merged pick is the hybrid line's plain
  //     loader; TE → 2; video/audio VAEs → 3/4 (packet profile); the
  //     imageVae pick → node 3 on the T=1 profile (its only legal graph).
  const h3imgAudit = resolveModels('h3image', h3imageGraphModule.inferH3ImgSelection(auditScan), auditScan, {
    merged: mergeName,
    textEncoder: auditPicks.textEncoder,
    videoVae: auditPicks.videoVae,
    audioVae: auditPicks.audioVae,
    imageVae: auditPicks.imageVae,
  })
  assert.equal(h3imgAudit.resolution.refusals.length, 0, 'h3image audit picks all apply')
  const workbenchPacket = h3imageGraphModule.buildH3ImageGraph({ family: 'h3img.generate.packet', prompt: 'audit', width: 768, height: 768, seed: 1, tier: 5, refs: [], loras: [], filenamePrefix: 't' }, h3imgAudit.selection)
  assertAt('h3image merged', workbenchPacket, 1, 'unet_name', mergeName)
  assertAt('h3image textEncoder', workbenchPacket, 2, 'clip_name', auditPicks.textEncoder)
  assertAt('h3image videoVae', workbenchPacket, 3, 'vae_name', auditPicks.videoVae)
  assertAt('h3image audioVae', workbenchPacket, 4, 'vae_name', auditPicks.audioVae)
  const workbenchT1 = h3imageGraphModule.buildH3ImageGraph({ family: 'h3img.generate.t1', prompt: 'audit', width: 768, height: 768, seed: 1, tier: 1, refs: [], loras: [], filenamePrefix: 't' }, h3imgAudit.selection, STUDIO_PACK_INFO)
  assertAt('h3image imageVae (T=1 profile)', workbenchT1, 3, 'vae_name', auditPicks.imageVae)

  // (The ltx25/ltx23 audit arms were removed with LTX — Phase 0, 2026-09-20.)

  // --- music3: checkpoint → 1, TE → 2, the audioVae pick (the family's one
  //     decoder, the DAV) → 3 — through both decode arms.
  const music3Audit = resolveModels('music3', music3Module.inferMusic3Selection(auditScan), auditScan, {
    checkpoint: 'music3-community-dit.safetensors',
    textEncoder: auditPicks.textEncoder,
    audioVae: 'music3-community-dav.safetensors',
  })
  assert.equal(music3Audit.resolution.refusals.length, 0, 'music3 audit picks all apply')
  for (const tiled of [true, false]) {
    const music3Graph = music3Module.buildMusic3Workflow({ caption: 'audit', lyrics: '', duration: 30, seed: 7, tiledDecode: tiled, filenamePrefix: 't' }, music3Audit.selection)
    assertAt(`music3 checkpoint (tiled=${tiled})`, music3Graph, 1, 'unet_name', 'music3-community-dit.safetensors')
    assertAt(`music3 textEncoder (tiled=${tiled})`, music3Graph, 2, 'clip_name', auditPicks.textEncoder)
    assertAt(`music3 audioVae (tiled=${tiled})`, music3Graph, 3, 'vae_name', 'music3-community-dav.safetensors')
  }

  // (The acestep audit arm was removed with the family, 2026-09-21 —
  // nn5ld47; git history is the archive. PR #44's enum-mapping assertions
  // rode this arm and went moot with the lane — the builder they tested is
  // deleted.)

  // --- THE AUDIT'S COMPLETENESS CONTRACT: every slot every family EXPOSES
  //     appears above; every slot NOT exposed refuses (nothing silently
  //     no-ops).
  const expectedSlots = {
    minimax: ['fl2va', 'ref2va', 'merged', 'textEncoder', 'videoVae', 'audioVae'],
    h3image: ['fl2va', 'ref2va', 'merged', 'textEncoder', 'videoVae', 'audioVae', 'imageVae'],
    music3: ['checkpoint', 'textEncoder', 'audioVae'],
  }
  for (const family of MODEL_FAMILIES) {
    assert.deepEqual([...family.slots].sort(), [...expectedSlots[family.id]].sort(), `${family.id}: the exposed slot set matches the audit table`)
    // Legacy keys ('vae' everywhere; 'checkpoint' on the lane families) are
    // CONSUMED by migration — they migrate, never re-refuse — so the honest
    // unexposed-set is the live keys the family does not list.
    const legacyHere = (slot) => slot === 'vae' || (slot === 'checkpoint' && (family.id === 'minimax' || family.id === 'h3image'))
    const unexposed = OVERRIDE_SLOT_KEYS.filter((slot) => !family.slots.includes(slot) && !legacyHere(slot))
    for (const slot of unexposed) {
      const refused = resolveModelOverrides(family.id, auditScan, { [slot]: auditScan[0].name })
      assert.equal(refused.slots[slot].state, 'refused', `${family.id}: the unexposed ${slot} slot refuses, never silently drops`)
    }
  }
  // The audit picks that only some families consume still had to be scanned
  // files for their rows to be honest (scan-anchored picks, not strings).
  assert.ok(auditScan.some((file) => file.name === 'h3-community-video-decoder.safetensors' && file.kind === 'vae'))
})

// ---------------------------------------------------------------------------
// The loosened anchors (Wave 2 R-12 — A-B3(c) folded here): substring
// fallback + size-class ranking. Failing-without-it: on the pre-Wave-2 exact
// regexes a renamed quant, a community repack, or a subpathed file NEVER
// auto-resolved (the maintainer's "auto detection doesn't seem to really
// work").
// ---------------------------------------------------------------------------
test('the loosened inference anchors (R-12 / A-B3(c)): substring fallback + size-class ranking over registry rows', () => {
  // A renamed quant + a community repack + a subpathed file: NONE match the
  // official tiers, ALL resolve through the substring fallback.
  const renamed = [
    { kind: 'diffusion_models', name: 'h3_fl2va_repack_q4.safetensors', bytes: 0 },
    { kind: 'text_encoders', name: 'qwen3vl_32b_repack_for_h3.safetensors', bytes: 0 },
    { kind: 'vae', name: 'h3_video_vae_community.safetensors', bytes: 0 },
  ]
  const resolved = inferSelections(renamed, 'off')
  assert.equal(resolved.fl2va, 'h3_fl2va_repack_q4.safetensors', 'a renamed FL2VA quant resolves through the substring fallback')
  assert.equal(resolved.textEncoder, 'qwen3vl_32b_repack_for_h3.safetensors', 'a repackaged encoder resolves')
  assert.equal(resolved.videoVae, 'h3_video_vae_community.safetensors', 'a community-renamed video VAE resolves')
  // Nothing resembling the family resolves to nothing: an EMPTY registry
  // yields all-empty selections (readiness gates own the refusal).
  const none = inferSelections([{ kind: 'loras', name: 'unrelated.safetensors', bytes: 0 }], 'off')
  assert.equal([none.fl2va, none.ref2va, none.textEncoder, none.videoVae, none.audioVae, none.previewVae].join('|'), '|||||', 'no registry rows of a kind → empty selection, never a guess')
  // SIZE-CLASS ranking within one tier: the official int8/convrot/pruned cut
  // beats a bigger fp16 sibling when both match the loose tier.
  const quantLadder = [
    { kind: 'diffusion_models', name: 'minimax_h3_fl2va_fp16.safetensors', bytes: 0 },
    { kind: 'diffusion_models', name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', bytes: 0 },
  ]
  assert.equal(inferSelections(quantLadder, 'off').fl2va, 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'the smaller-quant official cut outranks the fp16 sibling (size-class tokens)')
  // Tier order still dominates ranking: an exact official name beats a
  // fallback match even when the fallback candidate has more prefer tokens.
  assert.equal(inferSelections(overrideScan, 'off').fl2va, 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'the exact official tier still wins the slot')
})

// ---------------------------------------------------------------------------
// THE TE DIMENSION-CLASS GUARD (task eyzcev5 — the 2026-09-22 crash class).
// The loosened anchors above take "best available", and on the maintainer's
// real instance the 'qwen3vl' substring fallback resolved the 4B-class
// encoder when the 32B was not visible — the H3 token refiner demands the
// 32B-class (5120-dim hidden) and the render died 27 s in at
// preprocess_text_embeds: "mat1 and mat2 shapes cannot be multiplied
// (171x2560 and 5120x5376)" (the session log; 2560 = the 4B's hidden width,
// 5120 = the 32B's — the log is its own dim evidence). Failing-without-it:
// every wrong-class assertion below — the pick resolved, no class-refusal
// vocabulary existed, and the doomed graph submitted. The fixture is the
// environment mirror (e2e/mirror/profiles/maintainer-instance.json): the
// maintainer's instance shape, BOTH TEs visible — the exact trap.
// ---------------------------------------------------------------------------
const mirrorProfile = require('../e2e/mirror/profiles/maintainer-instance.json')
const mirrorFiles = []
for (const mirrorKind of Object.keys(mirrorProfile.modelListings)) {
  for (const mirrorName of mirrorProfile.modelListings[mirrorKind]) mirrorFiles.push({ kind: mirrorKind, name: mirrorName, bytes: 0 })
}
const TE_32B = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
const TE_4B = 'qwen3vl_4b_minimax_h3_int8.safetensors'
const selectionGuardModule = load('src/lib/modelSelection.ts')
const { teDimClassOf, teDimClassRefusal } = selectionGuardModule
const h3SubmitModule = load('src/lib/h3Submit.ts')

test('the TE dimension-class guard (eyzcev5): the wrong-family encoder refuses at validate with the named reason; the right one proceeds; klein keeps the small class', () => {
  // (1) AUTO, both visible (the mirror shape): the ladder's official tier
  //     picks the 32B and the guard passes it — correct picks resolve
  //     EXACTLY as before (a guard, not a reroute).
  const bothVisible = inferSelections(mirrorFiles, 'off')
  assert.equal(bothVisible.textEncoder, TE_32B, 'sanity: with both TEs visible the official tier picks the 32B')
  assert.equal(teDimClassRefusal('minimax', bothVisible.textEncoder), null, 'the 32B-class pick passes the guard')
  // (2) AUTO, only the 4B visible (the crash environment): the loosened
  //     anchor resolves the 4B — the root cause, kept on record — and the
  //     guard REFUSES it, naming both classes and the artifact to make
  //     visible instead of what was picked.
  const fourBOnlyFiles = mirrorFiles.filter((file) => file.name !== TE_32B)
  const trapped = inferSelections(fourBOnlyFiles, 'off')
  assert.equal(trapped.textEncoder, TE_4B, 'root cause on record: the substring fallback resolves the 4B when the 32B is invisible')
  const refusal = teDimClassRefusal('minimax', trapped.textEncoder)
  assert.ok(refusal, 'the guard refuses the wrong-family pick')
  assert.ok(refusal.includes('4B-class') && refusal.includes('32B-class'), `the refusal names both classes (got: ${refusal})`)
  assert.ok(refusal.includes(TE_32B), 'the refusal names the artifact to make visible')
  // (3) THE VALIDATE RUNG — the crash class dies at validate, never at the
  //     engine: the shared submit ladder refuses the 4B selection with the
  //     reason; the 32B selection passes the same ladder untouched.
  const guardRequest = { mode: 'text', prompt: 'a lone drummer', upscale: { mode: 'off' }, livePreview: { enabled: false, mode: 'standard' }, firstFrame: null, referenceImages: [], referenceVideos: [], referenceAudios: [], timelineGuides: [] }
  const guardFacts = (textEncoder) => ({ connected: true, modelReady: true, selection: { textEncoder, previewVae: '' }, h3PreviewOverrideNode: undefined })
  const ladderRefusal = h3SubmitModule.validateH3Render(guardRequest, guardFacts(TE_4B))
  assert.ok(ladderRefusal && ladderRefusal.includes('32B-class'), `the ladder refuses the 4B-class TE at validate (got: ${ladderRefusal})`)
  assert.equal(h3SubmitModule.validateH3Render(guardRequest, guardFacts(TE_32B)), null, 'the 32B-class TE passes the same ladder')
  // (4) THE OVERRIDE SEAM — a conscious pick of the 4B refuses with the same
  //     reason (the submission refuses; the selection stays on auto); the
  //     32B pick applies; a name with NO class token applies too (the
  //     classifier refuses only what the filename itself classifies — the
  //     engine stays the arbiter for community renames).
  const seamFourB = resolveModelOverrides('minimax', mirrorFiles, { textEncoder: TE_4B })
  assert.equal(seamFourB.slots.textEncoder.state, 'refused', 'the conscious 4B pick refuses at the seam')
  assert.ok(seamFourB.refusals[0].reason.includes('32B-class'), 'the seam refusal carries the class reason')
  const seam32B = resolveModelOverrides('minimax', mirrorFiles, { textEncoder: TE_32B })
  assert.equal(seam32B.slots.textEncoder.state, 'applied', 'the 32B pick applies')
  const unclassifiedFiles = mirrorFiles.concat([{ kind: 'text_encoders', name: 'qwen3vl_community_repack.safetensors', bytes: 0 }])
  const seamUnclassified = resolveModelOverrides('minimax', unclassifiedFiles, { textEncoder: 'qwen3vl_community_repack.safetensors' })
  assert.equal(seamUnclassified.slots.textEncoder.state, 'applied', 'no class token in the name → no refusal (the engine stays the arbiter)')
  const workbenchSeam = resolveModelOverrides('h3image', mirrorFiles, { textEncoder: TE_4B })
  assert.equal(workbenchSeam.slots.textEncoder.state, 'refused', 'the workbench family shares the 32B-class expectation')
  // (5) THE KLEIN LANE — the same FILE, a different family, the opposite
  //     verdict: klein runs on the small Qwen3 companion class (its official
  //     templates pair 9B↔qwen_3_8b_fp8mixed (4096-dim; this repo's port)
  //     and 4B↔qwen_3_4b (2560-dim)), so the 4B-class is LEGAL there and the
  //     32B-class is the wrong-family pick in the reverse direction.
  assert.equal(teDimClassRefusal('klein', TE_4B), null, 'klein accepts the 4B-class TE')
  assert.equal(teDimClassRefusal('klein', 'qwen_3_8b_fp8mixed.safetensors'), null, 'klein accepts its own 8B companion')
  assert.ok(teDimClassRefusal('klein', TE_32B), 'the reverse trap: the 32B-class into klein refuses too')
  // music3 carries NO expectation row (its TE ladder is fully anchored — the
  // loosened-anchor crash class cannot fire there); absence = inert.
  assert.equal(teDimClassRefusal('music3', TE_4B), null, 'no expectation row → no check (music3 inert by data absence)')
  // (6) THE CLASSIFIER — the filename's own size token, basename truth:
  //      subpaths classify, quant tokens (int8/fp8) do not false-match.
  assert.equal(teDimClassOf(`TE/sub/${TE_32B}`), '32b', 'subpathed rows classify by basename')
  assert.equal(teDimClassOf(TE_4B), '4b')
  assert.equal(teDimClassOf('qwen_3_8b_fp8mixed.safetensors'), '8b')
  assert.equal(teDimClassOf('qwen_3_4b.safetensors'), '4b')
  assert.equal(teDimClassOf('music3_text_encoder_bf16.safetensors'), null, 'no size token → unclassified')
  assert.equal(teDimClassOf('qwen3vl_community_repack.safetensors'), null, 'community renames stay unclassified')
  assert.equal(teDimClassOf('minimax_h3_fl2va_pruned_int8_convrot.safetensors'), null, 'quant int8 is not a size-class token')
  // (7) THE A-DBG JUNCTION — the refusal path is named at decision time
  //     (one tagged line when enabled, silence when not), so a session log
  //     answers "why didn't this render start" without guessing.
  const dbgModule = load('src/lib/dbg.ts')
  const junctionLines = []
  const originalLog = console.log
  console.log = (...args) => { junctionLines.push(args.join(' ')) }
  try {
    dbgModule.setDbgEnabled(true)
    teDimClassRefusal('minimax', TE_4B)
    teDimClassRefusal('minimax', TE_32B)
    dbgModule.setDbgEnabled(false)
    teDimClassRefusal('minimax', TE_4B)
  } finally {
    console.log = originalLog
  }
  const junction = junctionLines.find((line) => line.includes('[dbg:teclass]'))
  assert.ok(junction && junction.includes('"verdict":"refuse"') && junction.includes('"class":"4b"'), `the refusal junction is logged with its class (got: ${junctionLines.join(' | ')})`)
  assert.equal(junctionLines.filter((line) => line.includes('[dbg:teclass]')).length, 1, 'exactly one junction line per refusal, none for the pass or the disabled re-check')
})

// ---------------------------------------------------------------------------
// THE REGISTRY-ONLY INVARIANT (Wave 2 R-12 — the wave's named deliverable):
// NO GRAPH EVER REFERENCES A MODEL ABSENT FROM THE INSTANCE REGISTRY.
// Asserted across the workflow-population surface — every family's infer →
// resolve (auto, every override layer, out-of-registry picks) → graph build,
// with every model-name input checked against the registry listing for its
// kind. The epdvxd4 pick→node audit above is the precedent; this is its
// general form: ANY name that leaves the population surface must be a
// registry row, or the seam refused/degraded it first.
// ---------------------------------------------------------------------------
const INVARIANT_REGISTRY = [
  // The full official H3 stack, some rows subpathed (the registry shape).
  { kind: 'diffusion_models', name: 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', bytes: 0 },
  { kind: 'diffusion_models', name: 'H3/ssd/minimax_h3_ref2va_pruned_int8_convrot.safetensors', bytes: 0 },
  { kind: 'diffusion_models', name: 'community_merged_full.safetensors', bytes: 0 },
  { kind: 'diffusion_models', name: 'music3_dit_int8.safetensors', bytes: 0 },
  { kind: 'text_encoders', name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', bytes: 0 },
  { kind: 'text_encoders', name: 'TE/qwen3vl_community_repack.safetensors', bytes: 0 },
  { kind: 'text_encoders', name: 'music3_text_encoder_bf16.safetensors', bytes: 0 },
  { kind: 'vae', name: 'minimax_h3_video_vae_fp16.safetensors', bytes: 0 },
  { kind: 'vae', name: 'minimax_h3_audio_vae_fp32.safetensors', bytes: 0 },
  { kind: 'vae', name: 'minimax_h3_t1_image_vae_step1597.safetensors', bytes: 0 },
  { kind: 'vae', name: 'music3_dav.safetensors', bytes: 0 },
  { kind: 'vae', name: 'ace_1.5_vae.safetensors', bytes: 0 },
  { kind: 'loras', name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', bytes: 0 },
  { kind: 'loras', name: 'community_style_adapter.safetensors', bytes: 0 },
  { kind: 'vae_approx', name: 'taeh3_decoder.safetensors', bytes: 0 },
]
const registryNamesByKind = {}
for (const file of INVARIANT_REGISTRY) (registryNamesByKind[file.kind] ??= []).push(file.name)
// Graph input field → registry kind (the loader-node contract; the same
// mapping the server's object_info probes use). model_name (upscalers) maps
// to NO tracked kind — the upscale model is engine-resolved separately.
const MODEL_INPUT_KINDS = { unet_name: 'diffusion_models', clip_name: 'text_encoders', clip_name1: 'text_encoders', clip_name2: 'text_encoders', vae_name: 'vae', lora_name: 'loras' }

test('THE R-12 INVARIANT: no graph ever references a model absent from the instance registry — across the workflow-population surface', () => {
  const walkGraphModelInputs = (label, graph) => {
    for (const [id, node] of Object.entries(graph)) {
      for (const [field, value] of Object.entries(node.inputs ?? {})) {
        const kind = MODEL_INPUT_KINDS[field]
        if (!kind || typeof value !== 'string' || value === '') continue
        assert.ok((registryNamesByKind[kind] ?? []).includes(value),
          `${label}: node ${id} (${node.class_type}).${field} references '${value}' which the instance registry does not list under ${kind}`)
      }
    }
  }

  // --- AUTO (inference only): every family, every variant graph.
  for (const turbo of ['off', '8']) {
    for (const mode of ['text', 'reference']) {
      const selection = resolveModels('minimax', inferSelections(INVARIANT_REGISTRY, turbo), INVARIANT_REGISTRY).selection
      const graph = buildMiniMaxWorkflow(
        { mode, width: 352, height: 608, prompt: 'invariant', duration: 5, seed: 7, steps: 20, turbo, sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match', ...(mode === 'reference' ? { referenceImages: ['ref.png'] } : {}) },
        selection,
        mode === 'reference' ? { images: [{ name: 'ref.png' }], videos: [], audios: [] } : { images: [], videos: [], audios: [] },
      )
      walkGraphModelInputs(`minimax auto ${mode} turbo=${turbo}`, graph)
    }
  }
  // The LoRA stack (user picks from the registry) rides the graph's stack
  // loaders — those names must be registry rows too.
  const stackSelection = resolveModels('minimax', inferSelections(INVARIANT_REGISTRY, 'off'), INVARIANT_REGISTRY).selection
  const stackGraph = buildMiniMaxWorkflow(
    { mode: 'text', width: 352, height: 608, prompt: 'invariant', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match', loraStack: [{ name: 'community_style_adapter.safetensors', strength: 1 }] },
    stackSelection,
    { images: [], videos: [], audios: [] },
  )
  walkGraphModelInputs('minimax lora stack', stackGraph)

  // --- OVERRIDE LAYERS: picks that EXIST in the registry land; a pick the
  //     registry does NOT list degrades to auto and its name never reaches
  //     the graph.
  const picked = resolveModels('minimax', inferSelections(INVARIANT_REGISTRY, 'off'), INVARIANT_REGISTRY, { fl2va: 'community_merged_full.safetensors', textEncoder: 'TE/qwen3vl_community_repack.safetensors' }).selection
  walkGraphModelInputs('minimax overrides', buildMiniMaxWorkflow({ mode: 'text', width: 352, height: 608, prompt: 'invariant', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match' }, picked, { images: [], videos: [], audios: [] }))
  assert.equal(picked.fl2va, 'community_merged_full.safetensors', 'sanity: the registry-listed pick applied')
  const ghost = resolveModels('minimax', inferSelections(INVARIANT_REGISTRY, 'off'), INVARIANT_REGISTRY, { fl2va: 'ghost/not-in-registry.safetensors' })
  assert.equal(ghost.resolution.slots.fl2va.state, 'degraded', 'an out-of-registry pick degrades, never applies')
  const ghostGraph = buildMiniMaxWorkflow({ mode: 'text', width: 352, height: 608, prompt: 'invariant', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match' }, ghost.selection, { images: [], videos: [], audios: [] })
  assert.equal(ghostGraph['1'].inputs.unet_name, 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'the degraded pick fell back to the registry inference')
  walkGraphModelInputs('minimax ghost pick', ghostGraph)
  // A bare BASENAME pick never resolves to a subpathed row implicitly —
  // instance-invisible means the exact listed name or nothing.
  const bare = resolveModelOverrides('minimax', INVARIANT_REGISTRY, { fl2va: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors' })
  assert.equal(bare.slots.fl2va.state, 'degraded', 'the bare basename of a subpathed row is NOT in the registry — exact-name anchoring')

  // --- h3image (the workbench): both profile families through the seam.
  const h3imgSelection = resolveModels('h3image', h3imageGraphModule.inferH3ImgSelection(INVARIANT_REGISTRY), INVARIANT_REGISTRY, { textEncoder: 'TE/qwen3vl_community_repack.safetensors' }).selection
  for (const [family, tier] of [['h3img.generate.packet', 5], ['h3img.generate.t1', 1]]) {
    const graph = h3imageGraphModule.buildH3ImageGraph({ family, prompt: 'invariant', width: 768, height: 768, seed: 1, tier, refs: [], loras: [], filenamePrefix: 't' }, h3imgSelection, STUDIO_PACK_INFO)
    walkGraphModelInputs(`h3image ${family}`, graph)
  }

  // --- music3 (the audio engine), both decode arms. (The acestep walk arm
  //     was removed with the engine, 2026-09-21 — nn5ld47.)
  const music3Selection = resolveModels('music3', music3Module.inferMusic3Selection(INVARIANT_REGISTRY), INVARIANT_REGISTRY).selection
  for (const tiled of [true, false]) walkGraphModelInputs(`music3 tiled=${tiled}`, music3Module.buildMusic3Workflow({ caption: 'invariant', lyrics: '', duration: 30, seed: 7, tiledDecode: tiled, filenamePrefix: 't' }, music3Selection))

  // --- THE EMPTY REGISTRY (engine offline / serves nothing): inference
  //     yields no names at all — the population surface emits EMPTY model
  //     inputs and readiness gates own the refusal. No name ever invents
  //     itself.
  const emptyRegistry = []
  const emptySelection = inferSelections(emptyRegistry, 'off')
  assert.equal([emptySelection.fl2va, emptySelection.ref2va, emptySelection.textEncoder, emptySelection.videoVae, emptySelection.audioVae, emptySelection.fl2vLora, emptySelection.ref2vLora].every((value) => value === ''), true, 'an empty registry yields an all-empty selection')
  const emptyGraph = buildMiniMaxWorkflow({ mode: 'text', width: 352, height: 608, prompt: 'invariant', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match' }, emptySelection, { images: [], videos: [], audios: [] })
  for (const node of Object.values(emptyGraph)) {
    for (const [field, value] of Object.entries(node.inputs ?? {})) {
      if (MODEL_INPUT_KINDS[field]) assert.equal(value, '', `an empty registry leaves ${field} empty — never a fabricated name (got '${value}')`)
    }
  }
})

// (The LTX-2.3 utility inference test was removed with LTX — Phase 0,
// 2026-09-20; git history is the archive.)

test('RTX upscale + output selection (exact-filename attribution, P0-1)', () => {
  const rtx = buildMiniMaxWorkflow({ mode: 'text', width: 608, height: 352, prompt: 'test', duration: 2, seed: 1, steps: 20, turbo: '4', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', upscale: { type: 'rtx', model: 'RealESRGAN_x2.pth' } }, models, { images: [], videos: [], audios: [] })
  {
    assert.equal(rtx['80'].class_type, 'UpscaleModelLoader')
    assert.equal(rtx['82'].inputs.width, 1216)
    assert.equal(rtx['82'].inputs.height, 704)
    assert.equal(rtx['83'].inputs.audio[0], '17')
    assert.ok(rtx['19'] && rtx['84'])
  }
  const url = extractOutputUrl({ job: { outputs: { 19: { images: [{ filename: 'original.mp4' }] }, 84: { images: [{ filename: 'upscaled.mp4' }] } } } }, 'job', 'http://localhost:8188')
  assert.ok(decodeURIComponent(url).includes('upscaled.mp4'))

  const historyA = { promptA: { outputs: { 19: { images: [{ filename: 'A_video_00001_.mp4', subfolder: 'video', type: 'output' }] } } } }
  const historyB = { promptB: { outputs: { 19: { images: [{ filename: 'B_video_00001_.mp4', subfolder: 'video', type: 'output' }] } } } }
  const fileA = extractOutputFile(historyA, 'promptA')
  assert.equal(fileA.filename, 'A_video_00001_.mp4')
  assert.equal(fileA.subfolder, 'video')
  assert.equal(fileA.type, 'output')
  assert.equal(extractOutputFile(historyB, 'promptB').filename, 'B_video_00001_.mp4')
  // Audio jobs pick the audio extension over stray images.
  const audioFile = extractOutputFile({ promptC: { outputs: { 19: { images: [{ filename: 'still.png' }], audio: [{ filename: 'track.flac' }] } } } }, 'promptC', 'audio')
  assert.equal(audioFile.filename, 'track.flac')
  // The descriptor round-trips through the persisted output URL, so a stored
  // job can re-resolve its exact file without ComfyUI.
  const recovered = outputFileFromUrl(extractOutputUrl(historyA, 'promptA', 'http://127.0.0.1:8188'))
  assert.equal(recovered.filename, fileA.filename)
  assert.equal(recovered.subfolder, fileA.subfolder)
  assert.equal(recovered.type, fileA.type)
  assert.equal(outputFileFromUrl('minimax-media://local?path=C%3A%5Cout%5Cx.mp4'), undefined)
  assert.equal(outputFileFromUrl('http://127.0.0.1:8188/view?filename=x.mp4'), undefined)
})

test('job poll reduction (P1 family): completion, stale polls, tolerance, structural execution-error capture, spin cap, deadline', () => {
  const { reduceJobPoll, isPastRunningDeadline, isTerminalStatus, NO_OUTPUT_POLL_CAP, extractExecutionError } = load('src/lib/jobReducer.ts')
  const baseJob = { id: 'j1', promptId: 'p1', mode: 'text', prompt: 'test', createdAt: Date.now() - 1000, status: 'running', progress: 40, width: 608, height: 352, duration: 5 }
  {
    // Happy path: completed observation with a localized output file.
    const done = reduceJobPoll(baseJob, { kind: 'completed', outputUrl: 'http://127.0.0.1:8188/view?filename=out.mp4', localOutputPath: 'C:/out/out.mp4' }, Date.now())
    assert.equal(done.transitionedTo, 'completed')
    assert.equal(done.job.status, 'completed')
    assert.equal(done.job.progress, 100)
    assert.equal(done.job.localOutputPath, 'C:/out/out.mp4')

    // P1-5: a stale poll response must not resurrect a terminal job.
    const stale = reduceJobPoll(done.job, { kind: 'incomplete' }, Date.now())
    assert.equal(stale.transitionedTo, undefined)
    assert.equal(stale.job.status, 'completed')
    const staleError = reduceJobPoll(done.job, { kind: 'executionError', reason: '' }, Date.now())
    assert.equal(staleError.transitionedTo, undefined)
    assert.equal(staleError.job.status, 'completed')

    // P1-5 (side-effect gate): incomplete on a running job keeps identity for
    // already-running jobs so idle ticks do not churn React state.
    const running = { ...baseJob, status: 'running' }
    const idle = reduceJobPoll(running, { kind: 'incomplete' }, Date.now())
    assert.equal(idle.job, running)
    const queued = reduceJobPoll({ ...baseJob, status: 'queued' }, { kind: 'incomplete' }, Date.now())
    assert.equal(queued.job.status, 'running')

    // pollFailed must not fail a live job — tolerance, not brittleness.
    const tolerant = reduceJobPoll(baseJob, { kind: 'pollFailed' }, Date.now())
    assert.equal(tolerant.transitionedTo, undefined)
    assert.equal(tolerant.job.status, 'running')

    // Execution errors surface with the original wording.
    const errored = reduceJobPoll(baseJob, { kind: 'executionError', reason: '' }, Date.now())
    assert.equal(errored.transitionedTo, 'failed')
    assert.ok(errored.job.error?.includes('execution error'))

    // Structural failure capture (diagnostics doctrine): the observation now
    // carries WHICH node failed (id + class) plus an already-sanitized reason,
    // and a known cause class appends the taxonomy's human label.
    const { sanitizeErrorMessage: sanitizeForReducer } = load('src/lib/logSanitize.ts')
    const oomReason = sanitizeForReducer('torch.OutOfMemoryError: CUDA out of memory while rendering moonlit qzxveldra umbrella merchants waltzing')
    assert.ok(oomReason.includes('CUDA out of memory'), 'sanitized reason keeps the cause')
    assert.ok(!oomReason.includes('qzxveldra') && !oomReason.includes('umbrella') && !oomReason.includes('waltzing'), 'sanitized reason drops prompt echoes')
    const oom = reduceJobPoll(baseJob, { kind: 'executionError', node: '84', nodeType: 'VAEDecodeTiled', reason: oomReason }, Date.now())
    assert.equal(oom.transitionedTo, 'failed')
    assert.ok(oom.job.error?.includes('node 84'), `error names the node id (got: ${oom.job.error})`)
    assert.ok(oom.job.error?.includes('VAEDecodeTiled'), 'error names the node class')
    assert.ok(oom.job.error?.includes('GPU memory exhausted'), 'known class appends the taxonomy label')
    assert.ok(!oom.job.error?.includes('qzxveldra'), 'no prompt echo in the job error')
    const unclassified = reduceJobPoll(baseJob, { kind: 'executionError', node: '7', nodeType: 'SomethingBespoke', reason: 'a very specific engine complaint 12' }, Date.now())
    assert.ok(unclassified.job.error?.includes('node 7') && !unclassified.job.error?.includes('Likely cause'), 'unknown class leaves the taxonomy out of the line')

    // extractExecutionError: pulls node id/class + sanitized reason out of a
    // ComfyUI history entry's execution_error message tuple; absent/malformed
    // shapes return null instead of guessing.
    const historyWithError = {
      p1: { status: { status_str: 'error', completed: false, messages: [
        ['execution_start', { prompt_id: 'p1' }],
        ['execution_error', { prompt_id: 'p1', node_id: '84', node_type: 'VAEDecodeTiled', exception_type: 'torch.OutOfMemoryError', exception_message: 'CUDA out of memory while rendering moonlit qzxveldra umbrella merchants waltzing' }],
      ] } },
    }
    const extracted = extractExecutionError(historyWithError, 'p1')
    assert.ok(extracted, 'execution_error message extracted')
    assert.equal(extracted.node, '84')
    assert.equal(extracted.nodeType, 'VAEDecodeTiled')
    assert.ok(extracted.reason.includes('CUDA out of memory'), 'reason keeps the cause')
    assert.ok(extracted.reason.includes('[redacted]'), 'reason shows redaction engaged')
    assert.ok(!extracted.reason.includes('qzxveldra') && !extracted.reason.includes('umbrella'), 'prompt echo cannot survive extraction')
    assert.equal(extractExecutionError(historyWithError, 'missing'), null, 'unknown prompt id → null')
    assert.equal(extractExecutionError({}, 'p1'), null, 'empty history → null')
    assert.equal(extractExecutionError({ p1: { status: { messages: [['execution_success', {}]] } } }, 'p1'), null, 'no execution_error message → null')
    assert.equal(extractExecutionError({ p1: { status: { messages: ['not-a-tuple'] } } }, 'p1'), null, 'malformed message → null')

    // P1-6: completed-but-no-output spins at 98% for a bounded count, then fails.
    let spinning = baseJob
    for (let i = 1; i < NO_OUTPUT_POLL_CAP; i++) {
      spinning = reduceJobPoll(spinning, { kind: 'completedNoLocalOutput' }, Date.now()).job
      assert.equal(spinning.status, 'running')
      assert.equal(spinning.progress, 98)
      assert.equal(spinning.noOutputPolls, i)
    }
    const gaveUp = reduceJobPoll(spinning, { kind: 'completedNoLocalOutput' }, Date.now())
    assert.equal(gaveUp.transitionedTo, 'failed')
    assert.ok(gaveUp.job.error?.includes('output file never appeared'))

    // P1-1: any observation past the running deadline fails the job instead of
    // leaving it "running" forever against a dead server.
    const old = { ...baseJob, createdAt: Date.now() - 61 * 60 * 1000 }
    assert.ok(isPastRunningDeadline(old, Date.now()))
    const timedOut = reduceJobPoll(old, { kind: 'pollFailed' }, Date.now())
    assert.equal(timedOut.transitionedTo, 'failed')
    assert.ok(timedOut.job.error?.includes('no completion'))
    // Terminal jobs are exempt from the deadline.
    assert.ok(!isPastRunningDeadline({ ...old, status: 'completed' }, Date.now()))
    assert.ok(isTerminalStatus('cancelled') && !isTerminalStatus('queued'))
  }
})

// R-26 (Wave 4, audit B P2-2): dead-engine jobs must fail honestly in
// seconds-to-minutes, not at the 60-minute deadline. A CONSECUTIVE
// poll-failure streak accumulates on the job; at the limit the job fails
// with engine-unreachable wording (classifyFailure lands its taxonomy
// bucket); any successful observation resets the streak. The deadline sweep
// stays as the independent backstop.
test('job poll reduction (R-26): the consecutive-failure streak fails honestly long before the deadline', () => {
  const { reduceJobPoll, POLL_FAILURE_STREAK_LIMIT, RUNNING_DEADLINE_MS } = load('src/lib/jobReducer.ts')
  const { classifyFailure } = load('src/lib/failureTaxonomy.ts')
  assert.ok(POLL_FAILURE_STREAK_LIMIT >= 5 && POLL_FAILURE_STREAK_LIMIT * 1000 < 120_000, `the streak limit sits in the seconds-to-minutes band (got ${POLL_FAILURE_STREAK_LIMIT})`)
  assert.ok(POLL_FAILURE_STREAK_LIMIT * 1000 < RUNNING_DEADLINE_MS, 'the streak fires long before the 60-min deadline')
  const baseJob = { id: 'j1', promptId: 'p1', mode: 'text', prompt: 'test', createdAt: Date.now() - 1000, status: 'running', progress: 40, width: 608, height: 352, duration: 5 }

  // Below the limit: each failure only counts — the job stays running.
  let job = baseJob
  for (let i = 1; i < POLL_FAILURE_STREAK_LIMIT; i++) {
    const step = reduceJobPoll(job, { kind: 'pollFailed' }, Date.now())
    assert.equal(step.transitionedTo, undefined, `failure ${i} does not fail the job`)
    assert.equal(step.job.status, 'running')
    assert.equal(step.job.pollFailureStreak, i)
    job = step.job
  }

  // At the limit: honest engine-unreachable failure (taxonomy-classified).
  const failed = reduceJobPoll(job, { kind: 'pollFailed' }, Date.now())
  assert.equal(failed.transitionedTo, 'failed')
  assert.equal(failed.job.status, 'failed')
  assert.equal(classifyFailure(failed.job.error ?? '').id, 'engine-unreachable', `the streak failure classifies engine-unreachable (got: ${failed.job.error})`)

  // A single successful observation resets the streak: fail (limit-1) times,
  // succeed once, then (limit-1) more failures must still be tolerated.
  let mixed = baseJob
  for (let i = 1; i < POLL_FAILURE_STREAK_LIMIT; i++) mixed = reduceJobPoll(mixed, { kind: 'pollFailed' }, Date.now()).job
  const recovered = reduceJobPoll(mixed, { kind: 'incomplete' }, Date.now())
  assert.equal(recovered.job.pollFailureStreak ?? 0, 0, 'a successful poll resets the streak')
  let after = recovered.job
  for (let i = 1; i < POLL_FAILURE_STREAK_LIMIT; i++) {
    after = reduceJobPoll(after, { kind: 'pollFailed' }, Date.now()).job
    assert.equal(after.status, 'running', `post-reset failure ${i} stays running`)
  }

  // The identity-stability contract survives: an idle tick on a clean running
  // job (no streak) still returns the SAME object reference.
  const clean = { ...baseJob, status: 'running' }
  const idle = reduceJobPoll(clean, { kind: 'incomplete' }, Date.now())
  assert.equal(idle.job, clean, 'idle tick keeps the identity guard when no streak is in play')
})

test('library persistence survives localStorage quota exhaustion (P0-2)', () => {
  const events = []
  let quotaFailures = 0
  const storage = {
    store: new Map(),
    setItem(key, value) { if (quotaFailures-- > 0) throw new Error('The quota has been exceeded'); this.store.set(key, value) },
    getItem(key) { return this.store.get(key) ?? null },
  }
  const context = {
    exports: {},
    require,
    URLSearchParams,
    localStorage: storage,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    window: { dispatchEvent: (event) => events.push(event) },
  }
  const code = ts.transpileModule(fs.readFileSync(require('node:path').join(REPO, 'src/lib/libraryStorage.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code, context)
  const { persistToLocalStorage, STORAGE_ERROR_EVENT } = context.exports

  quotaFailures = 0
  assert.equal(persistToLocalStorage('k1', { a: 1 }), true)
  assert.equal(storage.getItem('k1'), '{"a":1}')
  assert.equal(events.length, 0)

  quotaFailures = 1
  const mediaUrlFile = { path: 'x.png', preview: 'minimax-media://selected?path=x.png' }
  const dataUrlFile = { path: 'y.png', preview: 'data:image/png;base64,AAAA' }
  assert.equal(persistToLocalStorage('k2', [mediaUrlFile, dataUrlFile]), true)
  const stored = JSON.parse(storage.getItem('k2'))
  assert.equal(stored[0].preview, 'minimax-media://selected?path=x.png')
  assert.equal(stored[1].preview, undefined)
  assert.equal(stored[1].path, 'y.png')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, STORAGE_ERROR_EVENT)

  quotaFailures = 5
  assert.equal(persistToLocalStorage('k3', { b: 2 }), false)
  assert.equal(events.length, 2)
  assert.equal(events[1].detail.key, 'k3')
})

test('official MiniMax prompt contracts: sections, cut times, ordering, reference discipline', () => {
  const { BASE_CONTRACT_SECTIONS, REFERENCE_CONTRACT_SECTIONS, buildBaseContractDraft, buildReferenceContractDraft, validateContract, referenceOrderWarnings, formatCutTime, suggestCutTimes, keyframeAlignmentInstruction } = load('src/lib/promptContracts.ts')
  assert.equal(BASE_CONTRACT_SECTIONS.map((section) => section.key).join('|'), 'integrated_multimodal_description|overall_soundscape|non_diegetic_music')
  assert.equal(REFERENCE_CONTRACT_SECTIONS.map((section) => section.key).join('|'), 'subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music')
  assert.equal(formatCutTime(3.5), '00:03.500')
  assert.equal(formatCutTime(65.25), '01:05.250')
  assert.equal(suggestCutTimes(10, 2).join('|'), '00:03.333|00:06.667')
  assert.equal(suggestCutTimes(5, 0).length, 0)
  assert.equal(keyframeAlignmentInstruction('image', 5), 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.')
  assert.ok(keyframeAlignmentInstruction('frames', 8).includes('8.00 seconds'))
  assert.equal(keyframeAlignmentInstruction('text', 5), '')

  const baseDraft = buildBaseContractDraft({ mode: 'image', duration: 8, prompt: 'A baker shapes dough.' })
  for (const section of BASE_CONTRACT_SECTIONS) assert.ok(baseDraft.includes(`${section.key}:`), `base draft missing ${section.key}`)
  assert.ok(baseDraft.includes('fully referenced'), 'I2VA alignment line missing from base draft')
  assert.ok(baseDraft.includes('[Shot 1] A baker shapes dough.'))
  assert.equal(validateContract(baseDraft, { duration: 8, referenceMode: false }).warnings.length, 0, 'base draft should validate clean')

  const bindings = [
    { label: 'Character: Ada / identity', purpose: 'character', file: { path: '/a.png', name: 'ada.png', kind: 'image' } },
    { label: 'Wardrobe: Red coat for Ada', purpose: 'wardrobe', file: { path: '/coat.png', name: 'coat.png', kind: 'image' } },
  ]
  const refDraft = buildReferenceContractDraft({ bindings, referenceVideos: [{ path: '/v.mp4', name: 'walk.mp4', kind: 'video' }], referenceAudios: [], duration: 6, prompt: 'Ada crosses the square.' })
  for (const section of REFERENCE_CONTRACT_SECTIONS) assert.ok(refDraft.includes(`${section.key}:`), `ref draft missing ${section.key}`)
  assert.ok(refDraft.includes('<Subject 1> is the identity of Ada'))
  assert.ok(refDraft.includes('<Video 1> is walk.mp4'))
  assert.ok(refDraft.includes('[reference generation]'))
  const refCheck = validateContract(refDraft, { duration: 6, referenceMode: true, definedSubjects: ['Subject 1', 'Subject 2'] })
  assert.equal(refCheck.warnings.length, 0, 'ref draft should validate clean')

  assert.ok(validateContract('integrated_multimodal_description: x', { duration: 5, referenceMode: false }).warnings.some((warning) => warning.includes('overall_soundscape')), 'missing-section warning expected')
  const badCuts = 'integrated_multimodal_description: [Shot 1] x\n[Shot 2] At 00:06.000, y\n[Shot 3] At 00:04.000, z\noverall_soundscape: a\nnon_diegetic_music: N/A'
  const cutWarnings = validateContract(badCuts, { duration: 5, referenceMode: false }).warnings
  assert.ok(cutWarnings.some((warning) => warning.includes('not strictly increasing')), 'non-increasing cut expected')
  assert.ok(cutWarnings.some((warning) => warning.includes('beyond the 5s duration')), 'cut beyond duration expected')
  assert.ok(validateContract('subject_definitions: <Subject 1> is Ada.\nsummary: [reference generation] x\nretention_analysis: <Subject 1>: fully_preserved\ndetailed_description: <Subject 2> appears.\noverall_soundscape: a\nnon_diegetic_music: N/A', { duration: 5, referenceMode: true, definedSubjects: ['Subject 1'] }).warnings.some((warning) => warning.includes('<Subject 2> is used but not defined')), 'unresolved subject expected')

  assert.equal(referenceOrderWarnings('Uses <Picture 1> then <Picture 2>.', { images: 2, videos: 0, audios: 0 }).length, 0)
  assert.ok(referenceOrderWarnings('Uses <Picture 2> before <Picture 1>.', { images: 2, videos: 0, audios: 0 }).some((warning) => warning.includes('mentioned before')), 'slot-order mismatch expected')
  assert.ok(referenceOrderWarnings('Uses <Picture 5>.', { images: 2, videos: 0, audios: 0 }).some((warning) => warning.includes('only 2 pictures are loaded')), 'unloaded reference expected')
  assert.ok(referenceOrderWarnings('No tags here.', { images: 3, videos: 0, audios: 0 }).some((warning) => warning.includes('none mentioned')), 'unmentioned pictures expected')
  assert.ok(referenceOrderWarnings('Uses <Audio 2> first, then <Audio 1>.', { images: 0, videos: 0, audios: 2 }).some((warning) => warning.includes('<Audio 2> is mentioned before')), 'audio order mismatch expected')
})

test('segmented-inference prompt discipline (temporal exclusivity): timeline-only scoping, single-shot contexts untouched', () => {
  const { TEMPORAL_EXCLUSIVITY_GUIDANCE, buildPromptAssistantContext } = load('src/lib/promptComposer.ts')
  assert.equal(typeof TEMPORAL_EXCLUSIVITY_GUIDANCE, 'string', 'the temporal-exclusivity guidance constant exists')
  assert.ok(TEMPORAL_EXCLUSIVITY_GUIDANCE.length > 400, 'the guidance is substantive (both principles + worked examples)')
  assert.ok(TEMPORAL_EXCLUSIVITY_GUIDANCE.includes('temporal exclusivity'), 'guidance names core principle 1')
  assert.ok(TEMPORAL_EXCLUSIVITY_GUIDANCE.includes('anchor frames'), 'guidance states the relay/anchor mechanism')
  assert.ok(TEMPORAL_EXCLUSIVITY_GUIDANCE.includes('finally stops at B') && TEMPORAL_EXCLUSIVITY_GUIDANCE.includes('having settled'), 'guidance carries the worked wrong/right pair (closed action loop, new action after the result)')
  assert.ok(TEMPORAL_EXCLUSIVITY_GUIDANCE.includes('Per-segment reference declaration') && TEMPORAL_EXCLUSIVITY_GUIDANCE.includes('Not written means not passed'), 'guidance carries core principle 2 (no reference inheritance)')
  assert.ok(buildPromptAssistantContext('timeline', { duration: 10, mode: 'text' }).includes(TEMPORAL_EXCLUSIVITY_GUIDANCE), 'the timeline (multi-segment) context advises the discipline')
  for (const tool of ['enhance', 'audio']) {
    const singleShot = buildPromptAssistantContext(tool, { duration: 6, mode: 'reference', referenceMap: ['<Picture 1> = Ada'], noDialogue: true })
    assert.equal(singleShot.includes(TEMPORAL_EXCLUSIVITY_GUIDANCE), false, `the single-shot ${tool} context never carries the multi-segment discipline`)
    assert.equal(singleShot.includes('Multi-segment discipline'), false, `the single-shot ${tool} context stays free of any exclusivity wording`)
  }
})

test('H3 no-dialogue emission: ambience bed + silent score + OFF-state inertness', () => {
  const { composeH3Prompt } = load('src/lib/promptPolicies.ts')
  const { applyDialoguePolicy, applyH3DialoguePolicy, noDialogueDirection, h3AmbienceDirection } = load('src/lib/dialogPolicy.ts')
  const h3PolicyInput = (overrides) => Object.assign({ prompt: 'A lighthouse in a storm.', mode: 'text', bindings: [], clothingPolicy: 'wardrobe', noDialogue: true, naturalMovement: false }, overrides)

  assert.equal(composeH3Prompt(h3PolicyInput({ noDialogue: false })), 'A lighthouse in a storm.', 'noDialogue OFF must not alter the prompt')
  assert.ok(composeH3Prompt(h3PolicyInput({ noDialogue: false, naturalMovement: true })).startsWith('A lighthouse in a storm. Motion direction:'), 'OFF keeps the movement direction emission unchanged')

  const h3NoDialoguePrompt = composeH3Prompt(h3PolicyInput({}))
  assert.ok(h3NoDialoguePrompt.includes(noDialogueDirection), 'ON keeps the no-dialogue negation as belt-and-braces')
  assert.ok(h3NoDialoguePrompt.includes(h3AmbienceDirection), 'ON spends the audio budget with the ambience bed')
  assert.ok(h3NoDialoguePrompt.endsWith('non_diegetic_music:\nN/A'), 'ON ends with the official silent-score field')

  const h3NoDialogueWithMovement = composeH3Prompt(h3PolicyInput({ naturalMovement: true }))
  assert.ok(h3NoDialogueWithMovement.includes('Motion direction:') && h3NoDialogueWithMovement.includes(h3AmbienceDirection), 'movement and no-dialogue policies compose')
  assert.ok(h3NoDialogueWithMovement.endsWith('non_diegetic_music:\nN/A'), 'silent-score field stays last when movement is on')

  // A prompt that already declares the music field (assistant-composed contract)
  // must not gain a contradicting second value; the ambience bed still lands.
  const declaredMusic = composeH3Prompt(h3PolicyInput({ prompt: 'integrated_multimodal_description: x\noverall_soundscape: rain\nnon_diegetic_music: soft piano' }))
  assert.equal(declaredMusic.split('non_diegetic_music:').length - 1, 1, 'declared music field must not be duplicated')
  assert.ok(declaredMusic.includes(h3AmbienceDirection), 'ambience bed still emitted for contract prompts')

  // Non-H3 engines keep the bare negation; the labeled field is H3's contract.
  assert.equal(applyDialoguePolicy('Quiet scene.', true), `Quiet scene. ${noDialogueDirection}`, 'plain policy stays negation-only')
  assert.ok(!applyDialoguePolicy('Quiet scene.', true).includes('non_diegetic_music'), 'plain policy must not leak the H3 field')
  assert.equal(applyDialoguePolicy('  Quiet scene.  ', false), 'Quiet scene.', 'plain policy only trims when off')
  const h3Direct = applyH3DialoguePolicy('Quiet scene.', true)
  assert.ok(h3Direct.includes(h3AmbienceDirection) && h3Direct.endsWith('non_diegetic_music:\nN/A'), 'H3 helper (mobile path) emits the full block')
  assert.equal(applyH3DialoguePolicy('Quiet scene.', false), 'Quiet scene.', 'H3 helper inert when off')
})

test('local prompt library storage: technique corpus + save/delete round-trip', () => {
  const store = new Map()
  const localStorageStub = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  }
  // Multi-file loader: promptLibraryStorage imports ./libraryStorage and
  // ./promptCorpus, so the VM context needs a require that resolves and
  // transpiles those dependencies.
  const cache = {}
  const transpileFile = (file) => ts.transpileModule(fs.readFileSync(require('node:path').join(REPO, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const libRequire = (name) => {
    if (name === './libraryStorage') {
      if (!cache.libraryStorage) {
        cache.libraryStorage = {}
        vm.runInNewContext(transpileFile('src/lib/libraryStorage.ts'), { exports: cache.libraryStorage, require, console, localStorage: localStorageStub, window: { dispatchEvent: () => undefined, CustomEvent: class {}, addEventListener: () => undefined } })
      }
      return cache.libraryStorage
    }
    if (name === './promptCorpus') {
      if (!cache.promptCorpus) {
        cache.promptCorpus = {}
        vm.runInNewContext(transpileFile('src/lib/promptCorpus.ts'), { exports: cache.promptCorpus, require, console })
      }
      return cache.promptCorpus
    }
    return require(name)
  }
  const exports2 = {}
  const CustomEventStub = class { constructor(type, init) { this.type = type; this.detail = init?.detail } }
  vm.runInNewContext(transpileFile('src/lib/promptLibraryStorage.ts'), { exports: exports2, require: libRequire, console, CustomEvent: CustomEventStub, window: { dispatchEvent: () => undefined, CustomEvent: CustomEventStub }, localStorage: localStorageStub })
  const storage = exports2
  const initial = storage.loadPromptLibrary()
  assert.equal(initial.length, 8, 'bundled technique corpus expected')
  assert.ok(initial.every((entry) => entry.technique), 'starter entries are techniques')
  assert.ok(initial.some((entry) => entry.id === 'technique.timed-beats'))
  storage.savePromptEntry({ id: 'civitai.42', label: 'City run', prompt: 'A courier sprints through neon rain, timed beats throughout.', steps: 30, sampler: 'res_multistep', source: { kind: 'civitai', itemId: '42', username: 'ada' } })
  const saved = storage.loadPromptLibrary()
  assert.equal(saved.length, 9)
  const entry = saved.find((item) => item.id === 'civitai.42')
  assert.ok(entry && entry.source.username === 'ada' && entry.steps === 30, 'saved entry round-trips metadata')
  storage.deletePromptEntry('civitai.42')
  assert.equal(storage.loadPromptLibrary().length, 8, 'delete restores corpus-only state')
})

test('multiframe timeline guides (MiniMaxH3AddGuide): topology, frame indices, classic-graph invariance', () => {
  const guidesGraph = buildMiniMaxWorkflow({ mode: 'reference', prompt: 'p', width: 1344, height: 768, duration: 6, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: ['a.png'], referenceVideos: [], referenceAudios: [], timelineGuides: [{ frameIndex: 36 }, { frameIndex: 72 }, { frameIndex: 120 }] }, models, { images: [{ name: 'a.png' }], videos: [], audios: [], guides: [{ name: 'g1.png' }, { name: 'g2.png' }, { name: 'g3.png' }] })
  assert.equal(guidesGraph['650'].class_type, 'MiniMaxH3AddGuide')
  assert.equal(guidesGraph['651'].class_type, 'MiniMaxH3AddGuide')
  assert.equal(guidesGraph['652'].class_type, 'MiniMaxH3AddGuide')
  // Chain: R2V -> AG1 -> AG2 -> AG3 -> BasicGuider, shared latent, both VAEs.
  assert.equal(guidesGraph['650'].inputs.positive.join('|'), '10|0')
  assert.equal(guidesGraph['651'].inputs.positive.join('|'), '650|0')
  assert.equal(guidesGraph['652'].inputs.positive.join('|'), '651|0')
  assert.equal(guidesGraph['12'].inputs.conditioning.join('|'), '652|0')
  for (const id of ['650', '651', '652']) {
    assert.equal(guidesGraph[id].inputs.latent.join('|'), '10|1', id + ' latent')
    assert.equal(guidesGraph[id].inputs.vae.join('|'), '3|0', id + ' vae')
    assert.equal(guidesGraph[id].inputs.audio_vae.join('|'), '4|0', id + ' audio_vae')
  }
  assert.equal(guidesGraph['650'].inputs.frame_idx, 36)
  assert.equal(guidesGraph['652'].inputs.frame_idx, 120)
  assert.equal(guidesGraph['600'].class_type, 'LoadImage')
  assert.equal(guidesGraph['600'].inputs.image, 'g1.png')
  // Without guides the classic graph is unchanged.
  const classicGraph = buildMiniMaxWorkflow({ mode: 'reference', prompt: 'p', width: 1344, height: 768, duration: 6, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: ['a.png'], referenceVideos: [], referenceAudios: [] }, models, { images: [{ name: 'a.png' }], videos: [], audios: [] })
  assert.equal(classicGraph['12'].inputs.conditioning.join('|'), '10|0')
  assert.equal(classicGraph['650'], undefined)
  // Frame helpers follow the official round(seconds*24) convention.
  const { frameIndexForSeconds, guideFrameWarning } = workflowModule
  assert.equal(frameIndexForSeconds(1.5), 36)
  assert.equal(frameIndexForSeconds(3), 72)
  assert.equal(frameIndexForSeconds(-2), -48)
  assert.equal(guideFrameWarning(1.5, 6), null)
  assert.equal(guideFrameWarning(5.5, 5) !== null, true, 'beyond duration warns')
  assert.equal(guideFrameWarning(-6, 5) !== null, true, 'before start warns')
})

test('trust layer: manifest fields, topology-sensitive graph hash, tiled-VAE fallback', () => {
  const manifestModule = load('src/lib/manifest.ts')
  const graph = buildMiniMaxWorkflow({ mode: 'text', prompt: 'repro test', width: 1344, height: 768, duration: 5, seed: 424242, steps: 30, turbo: '8', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', loraStrength: 0.9, filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [] }, models, { images: [], videos: [], audios: [] })
  const manifest = manifestModule.buildRenderManifest({ mode: 'text', prompt: 'repro test', width: 1344, height: 768, duration: 5, seed: 424242, steps: 30, turbo: '8', loraStrength: 0.9, sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [] }, models, [{ name: 'fl2va', kind: 'diffusion_models', bytes: 12345 }], 'http://127.0.0.1:8188', graph)
  assert.equal(manifest.seed, 424242)
  assert.equal(manifest.models.diffusion.name, 'fl2va')
  assert.equal(manifest.models.diffusion.bytes, 12345)
  assert.equal(manifest.sampler, 'res_multistep')
  assert.equal(manifest.upscale, 'off')
  assert.ok(manifest.graphVersion.startsWith('fnv1a-'))
  // Graph version is topology-sensitive but prompt/seed-insensitive.
  const otherSeed = buildMiniMaxWorkflow({ mode: 'text', prompt: 'repro test', width: 1344, height: 768, duration: 5, seed: 999, steps: 30, turbo: '8', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [] }, models, { images: [], videos: [], audios: [] })
  assert.equal(manifestModule.graphVersionHash(otherSeed), manifest.graphVersion, 'same topology must hash identically')
  const guideGraph = buildMiniMaxWorkflow({ mode: 'reference', prompt: 'p', width: 1344, height: 768, duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: ['a.png'], referenceVideos: [], referenceAudios: [], timelineGuides: [{ frameIndex: 36 }] }, models, { images: [{ name: 'a.png' }], videos: [], audios: [], guides: [{ name: 'g.png' }] })
  assert.notEqual(manifestModule.graphVersionHash(guideGraph), manifest.graphVersion, 'topology change must change the hash')
  // Tiled fallback swaps only the video decode node.
  const tiled = workflowModule.withTiledVideoDecode(graph)
  assert.equal(tiled['16'].class_type, 'VAEDecodeTiled')
  assert.equal(tiled['16'].inputs.tile_size, 1024)
  assert.equal(tiled['16'].inputs.samples.join('|'), graph['16'].inputs.samples.join('|'), 'decode input preserved')
  assert.equal(tiled['17'].class_type, 'VAEDecodeAudio', 'audio decode untouched')
  assert.equal(tiled['13'].class_type, graph['13'].class_type, 'sampler untouched')
})

test('LBH latent upscaler presets (two-stage hires-fix): topology, sigma split, audio bypass, output attribution', () => {
  const lbhGraph = buildMiniMaxWorkflow({ mode: 'text', prompt: 'p', width: 1344, height: 768, duration: 5, seed: 1, steps: 30, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [], upscale: { type: 'lbh3d', model: 'minimax_h3_latent_upscaler_3d_fp16.safetensors' } }, models, { images: [], videos: [], audios: [] })
  assert.equal(lbhGraph['90'].class_type, 'SplitSigmas')
  assert.equal(lbhGraph['90'].inputs.split_index, 15, 'quality preset splits at half of 30 steps')
  assert.equal(lbhGraph['15'].inputs.sigmas.join('|'), '90|0', 'stage-1 sampler takes the split schedule')
  assert.equal(lbhGraph['91'].class_type, 'LTXVSeparateAVLatent')
  assert.equal(lbhGraph['92'].class_type, 'MinimaxH3LatentUpscaler3D')
  assert.equal(lbhGraph['92'].inputs.model_name, 'minimax_h3_latent_upscaler_3d_fp16.safetensors')
  assert.equal(lbhGraph['92'].inputs.width, 2688)
  assert.equal(lbhGraph['92'].inputs.height, 1536)
  assert.equal(lbhGraph['93'].class_type, 'LTXVConcatAVLatent')
  assert.equal(lbhGraph['93'].inputs.video_latent.join('|'), '92|0')
  assert.equal(lbhGraph['93'].inputs.audio_latent.join('|'), '91|1', 'audio latent bypasses the upscaler')
  assert.equal(lbhGraph['94'].class_type, 'ManualSigmas')
  assert.ok(String(lbhGraph['94'].inputs.sigmas).startsWith('0.9035'))
  assert.equal(lbhGraph['95'].inputs.latent_image.join('|'), '93|0')
  assert.equal(lbhGraph['96'].class_type, 'VAEDecodeTiled')
  assert.equal(lbhGraph['99'].class_type, 'SaveVideo')
  assert.ok(String(lbhGraph['99'].inputs.filename_prefix).endsWith('_LBH_2x'))
  // 2D variant uses the classic node with scale.
  const lbh2dGraph = buildMiniMaxWorkflow({ mode: 'text', prompt: 'p', width: 1344, height: 768, duration: 5, seed: 1, steps: 30, turbo: '8', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [], upscale: { type: 'lbh2d', model: 'upscaler_2d.safetensors' } }, models, { images: [], videos: [], audios: [] })
  assert.equal(lbh2dGraph['92'].class_type, 'MinimaxH3LatentUpscalerNode2D')
  assert.equal(lbh2dGraph['92'].inputs.scale, 2)
  assert.equal(lbh2dGraph['90'].inputs.split_index, 4, 'turbo 8 splits at 4 per the example workflow')
  // Output attribution prefers the LBH branch output.
  const history = { pid: { outputs: { 99: [{ filename: 'lbh.mp4', subfolder: 'video', type: 'output' }], 19: [{ filename: 'base.mp4', subfolder: 'video', type: 'output' }] } } }
  assert.equal(extractOutputFile(history, 'pid', 'video')?.filename, 'lbh.mp4')
})

test('Motion-Context latent chaining: save/load indices, conditioning wrap, trim', () => {
  const startGraph = buildMiniMaxWorkflow({ mode: 'text', prompt: 'p', width: 1344, height: 768, duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [], chain: { index: 0, folder: 'h3_context/c1/clip' } }, models, { images: [], videos: [], audios: [] })
  assert.equal(startGraph['28'].class_type, 'MiniMaxH3MotionContextSaveLatent')
  // Pack indices are 1-based: the chain START saves its latent in slot 1
  // (slot 0 never loads — an auto-numbered save is invisible to Load).
  assert.equal(startGraph['28'].inputs.clip_index, 1)
  assert.equal(startGraph['28'].inputs.filename_prefix, 'h3_context/c1/clip')
  assert.equal(startGraph['24'], undefined, 'chain start loads nothing')
  assert.equal(startGraph['25'], undefined)
  assert.equal(startGraph['19'].inputs.video.join('|'), '18|0', 'start delivers the full clip')
  const contGraph = buildMiniMaxWorkflow({ mode: 'text', prompt: 'p', width: 1344, height: 768, duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [], chain: { index: 2, folder: 'h3_context/c1/clip' } }, models, { images: [], videos: [], audios: [] })
  assert.equal(contGraph['24'].class_type, 'MiniMaxH3MotionContextLoadLatent')
  assert.equal(contGraph['24'].inputs.clip_index, 2, 'segment 3 (app index 2) continues from pack clip 2 = app clip 1')
  assert.equal(contGraph['24'].inputs.latent_path, 'h3_context/c1')
  assert.equal(contGraph['25'].class_type, 'MiniMaxH3MotionContext')
  assert.equal(contGraph['25'].inputs.context_length, '22')
  assert.equal(contGraph['25'].inputs.conditioning.join('|'), '10|0', 'MotionContext wraps the R2V conditioning')
  assert.equal(contGraph['12'].inputs.conditioning.join('|'), '25|0', 'guider takes the motion-context conditioning')
  assert.equal(contGraph['26'].class_type, 'MiniMaxH3MotionContextTrim')
  assert.equal(contGraph['26'].inputs.trim_frames.join('|'), '25|1')
  assert.equal(contGraph['27'].inputs.images.join('|'), '26|0')
  assert.equal(contGraph['19'].inputs.video.join('|'), '27|0', 'continuation saves the trimmed clip')
  assert.equal(contGraph['28'].inputs.clip_index, 3)
})

test('MiniMax Music 3: official graph, seconds passthrough, tiled decode, caption assembly, INT8 preference', () => {
  const m3 = load('src/lib/music3Workflow.ts')
  const models3 = { diffusion: 'minimax_music3_dit_int8_convrot.safetensors', textEncoder: 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors', vae: 'minimax_music3_dav.safetensors' }
  const g = m3.buildMusic3Workflow({ caption: 'Global Metadata: lo-fi. 78 BPM.', lyrics: '[Verse]\nhello', duration: 90, seed: 42, tiledDecode: true, filenamePrefix: 'audio/m3' }, models3)
  assert.equal(g['4'].class_type, 'MiniMaxMusic3TextEncode')
  assert.equal(g['4'].inputs.caption, 'Global Metadata: lo-fi. 78 BPM.')
  assert.equal(g['4'].inputs.lyrics.includes('[Verse]'), true)
  assert.equal(g['4'].inputs.max_duration, 90)
  assert.equal(g['4'].inputs.cfg_scale, 1.7)
  assert.equal(g['6'].inputs.seconds.join('|'), '4|1', 'empty latent is sized by the encoder seconds output')
  assert.equal(g['7'].class_type, 'KSampler')
  assert.equal(g['7'].inputs.sampler_name, 'euler')
  assert.equal(g['7'].inputs.positive.join('|'), '4|0')
  assert.equal(g['7'].inputs.negative.join('|'), '5|0', 'negative is the zeroed-out conditioning')
  assert.equal(g['8'].class_type, 'VAEDecodeAudioTiled')
  assert.equal(g['8'].inputs.tile_size, 1536)
  assert.equal(g['9'].class_type, 'SaveAudioAdvanced')
  assert.equal(g['9'].inputs.format, 'mp3')
  // The mp3 key's REAL sub-input (retired music3.bitrate-unknown-input):
  // the old bitrate key was never declared and the engine dropped it
  // silently — quality is what actually reaches the encoder.
  assert.equal(g['9'].inputs.quality, 'V0')
  assert.equal('bitrate' in g['9'].inputs, false)
  const full = m3.buildMusic3Workflow({ caption: 'x', lyrics: '', duration: 60, seed: 1, tiledDecode: false, filenamePrefix: 'a' }, models3)
  assert.equal(full['8'].class_type, 'VAEDecodeAudio', 'tiled decode is optional')
  // Duration clamped to the 5-minute ceiling; caption sections omitted when blank.
  assert.equal(m3.buildMusic3Workflow({ caption: 'x', lyrics: '', duration: 999, seed: 1, tiledDecode: true, filenamePrefix: 'a' }, models3)['4'].inputs.max_duration, 300)
  assert.equal(m3.buildMusic3Caption({ globalMetadata: 'lofi', vocalDetails: '', arrangement: 'keys' }).includes('Vocal Details'), false)
  assert.ok(m3.buildMusic3Caption({ globalMetadata: 'lofi', vocalDetails: 'female', arrangement: '' }).startsWith('Global Metadata:'))
  // Model inference prefers INT8 and matches the official filenames.
  const files = [
    { name: 'minimax_music3_dit_fp16.safetensors', kind: 'diffusion_models', bytes: 1 },
    { name: 'minimax_music3_dit_int8_convrot.safetensors', kind: 'diffusion_models', bytes: 1 },
    { name: 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors', kind: 'text_encoders', bytes: 1 },
    { name: 'minimax_music3_dav.safetensors', kind: 'vae', bytes: 1 },
  ]
  const inferred = m3.inferMusic3Selection(files)
  assert.equal(inferred.diffusion, 'minimax_music3_dit_int8_convrot.safetensors')
  assert.equal(inferred.vae, 'minimax_music3_dav.safetensors')
})

test('ContactSheet character sheets: topology, LoRA inference, size clamps, views-first attribution', () => {
  const cs = load('src/lib/contactSheet.ts')
  const sel = { ref2va: 'ref2va', textEncoder: 'qwen', videoVae: 'vvae', turnaroundLora: 'minimax_h3_five_view_512_s1500.safetensors' }
  const g = cs.buildContactSheetWorkflow({ prompt: 'orbit ninety degrees', size: 1000, steps: 28, seed: 7, referenceName: 'ref.png', filenamePrefix: 'cs' }, sel)
  assert.equal(g['10'].class_type, 'H3ContactSheet')
  assert.equal(g['10'].inputs.ref_image.join('|'), '4|0')
  assert.equal(g['10'].inputs.size, 992, 'size snaps to the 32 grid')
  assert.equal(g['12'].inputs.conditioning.join('|'), '10|0', 'guider uses the sheet conditioning')
  assert.equal(g['15'].inputs.latent_image.join('|'), '10|1', 'sampler uses the sheet latent')
  assert.equal(g['5'].class_type, 'LoraLoaderModelOnly')
  assert.equal(g['5'].inputs.lora_name, 'minimax_h3_five_view_512_s1500.safetensors')
  assert.equal(g['16'].class_type, 'H3ContactSheetDecode')
  assert.equal(g['18'].inputs.images.join('|'), '16|0', 'views batch saved first for attribution')
  assert.ok(String(g['18'].inputs.filename_prefix).endsWith('_views'))
  const clamped = cs.buildContactSheetWorkflow({ prompt: 'p', size: 4096, seed: 1, referenceName: 'r', filenamePrefix: 'x' }, sel)
  assert.equal(clamped['10'].inputs.size, 2048, 'per-view size caps at 2048')
  // LoRA inference matches training-run naming variants.
  const files = [
    { name: 'minimax_h3_fl2v_turbo_8step_v1.0.safetensors', kind: 'loras', bytes: 1 },
    { name: 'minimax_h3_five_view_512_s1500.safetensors', kind: 'loras', bytes: 1 },
  ]
  assert.equal(cs.inferContactSheetSelection(files, 'r2v', 'qwen', 'vvae').turnaroundLora, 'minimax_h3_five_view_512_s1500.safetensors')
  assert.equal(cs.inferContactSheetSelection([{ name: 'other.safetensors', kind: 'loras', bytes: 1 }], 'r2v', 'qwen', 'vvae').turnaroundLora, '')
})

test('graph-family versioning + looseness presets', () => {
  const manifestModule2 = load('src/lib/manifest.ts')
  const graph = buildMiniMaxWorkflow({ mode: 'text', prompt: 'p', width: 1344, height: 768, duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [] }, models, { images: [], videos: [], audios: [] })
  const manifest = manifestModule2.buildRenderManifest({ mode: 'text', prompt: 'p', width: 1344, height: 768, duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: [], referenceVideos: [], referenceAudios: [] }, models, [], 'http://x', graph)
  assert.equal(manifest.graphFamily, 'studio-2026-09')
  assert.ok(promptPresets.some((item) => item.id === 'looseness.loose-performance'))
  assert.ok(searchPromptPresets('improvised').some((item) => item.id === 'looseness.improvised-feel'))
  const loose = promptPresets.find((item) => item.id === 'looseness.micro-variation')
  assert.ok(loose && loose.insertion.includes('do not interpret this as permission to change wardrobe'), 'looseness presets guard identity')
})

// ---- Z-Image ControlNet Union: RETIRED with the canvas Z-Image path ----------
// (34afx79, 2026-09-19: lib/zImageControlnet.ts deleted — the image+control
// intent hands off to the workbench's Edit surface; the stills intent renders
// H3-1F. The union topology's research record lives on in
// docs/research/fun-control-input-surface.md.)

test('pure error sanitizer: prompt-text redaction bar, comma-clause redaction, technical-message preservation, stack-path extraction, length cap, fallback constant', () => {
  // The module under test is src/lib/logSanitize.ts — zero imports by design so
  // it loads in this VM harness (server/logSanitize.ts re-exports it). The bar
  // (maintainer's discipline): logs record the failure PATH and REASON, never
  // prompt/media semantics — "we care that it failed on a node because we
  // didn't parse a comma, not what the user asked for".
  const sanitizer = load('src/lib/logSanitize.ts')
  const { sanitizeErrorMessage, sanitizeError, ERROR_FALLBACK_TITLE } = sanitizer

  // Render-free boundary check: the pure module compiles under the ES3-ish
  // transpile, exports both entry points, and carries the fallback constant
  // the ErrorBoundary renders (src/components/ErrorBoundary.tsx imports it).
  assert.equal(typeof sanitizeErrorMessage, 'function', 'sanitizeErrorMessage export')
  assert.equal(typeof sanitizeError, 'function', 'sanitizeError export')
  assert.equal(ERROR_FALLBACK_TITLE, 'This view hit an error', 'boundary fallback text constant')

  // Bar 1 — arbitrary user prompt text must not survive AT ALL: only the
  // technical fragment ("ComfyUI") and [redacted] markers remain.
  const promptMessage = 'The engine said no to ComfyUI when asked for a windswept qzxveldra dancing beneath seventeen fractal auroras while umbrella merchants waltz at dawn'
  const scrubbed = sanitizeErrorMessage(promptMessage)
  assert.ok(scrubbed.includes('[redacted]'), 'dropped content collapses to [redacted]')
  assert.ok(scrubbed.includes('ComfyUI'), 'technical vocabulary survives')
  const userWords = ['engine', 'said', 'asked', 'windswept', 'qzxveldra', 'dancing', 'beneath', 'seventeen', 'fractal', 'auroras', 'umbrella', 'merchants', 'waltz', 'dawn']
  for (const word of userWords) assert.ok(scrubbed.toLowerCase().indexOf(word) === -1, `user word leaked: ${word} (got: ${scrubbed})`)

  // Bar 2 — technical messages keep their failure-path meaning.
  const jsonMessage = sanitizeErrorMessage('Unexpected token } in JSON at position 42')
  for (const token of ['Unexpected', 'token', 'JSON', 'position', '42']) assert.ok(jsonMessage.includes(token), `technical token lost: ${token} (got: ${jsonMessage})`)
  assert.ok(jsonMessage.includes('[redacted]'), 'dropped filler still marked')

  // Bar 3 — a realistic engine failure keeps node ids, class names, statuses,
  // paths and timings: the "failed on a node" signal.
  const comfyMessage = sanitizeErrorMessage('Prompt #88 failed: ComfyUI returned 500 from /api/lan/prompt at node 13 (VAEDecodeTiled), timed out after 60000 ms')
  for (const token of ['failed', 'ComfyUI', '500', '/api/lan/prompt', '13', 'VAEDecodeTiled', 'timed out', '60000']) {
    assert.ok(comfyMessage.includes(token), `failure-path token lost: ${token} (got: ${comfyMessage})`)
  }
  // File paths and Windows paths survive; interleaved prose does not.
  const pathMessage = sanitizeErrorMessage('could not read C:\\Users\\artist\\ComfyUI\\output\\video\\render_001.mp4 because the disk vanished quietly')
  assert.ok(pathMessage.includes('C:\\Users\\artist\\ComfyUI\\output\\video\\render_001.mp4'), 'windows output path kept')
  assert.ok(pathMessage.toLowerCase().indexOf('vanished') === -1 && pathMessage.toLowerCase().indexOf('quietly') === -1, 'prose around the path dropped')

  // sanitizeError: name/reason from a HOST-realm Error (duck-typed — instanceof
  // must not be relied on across realms), path from the first stack frame.
  // DATED (z7ogmig, 2026-09-20): the regex pinned the ORIGINAL caller file
  // (test-workflows.cjs); it pins this port's filename instead — the same
  // first-stack-frame extraction, new caller name.
  const boom = new Error('bad thing happened to node 84 in VAEDecodeTiled')
  const detail = sanitizeError(boom)
  assert.equal(detail.name, 'Error', 'error name kept')
  assert.ok(detail.reason.includes('node'), 'sanitized reason keeps technical signal')
  assert.ok(/workflows\.test\.js:\d+/.test(detail.path), `first stack frame extracted as file:line (got: ${detail.path})`)

  // Non-Error input (a thrown string is a real pattern in this codebase).
  const thrown = sanitizeError('a plain string about moonlit qzxveldra umbrellas')
  assert.equal(thrown.name, 'string', 'plain string classified')
  assert.ok(thrown.reason.includes('[redacted]') && !thrown.reason.includes('umbrellas'), 'thrown string sanitized')
  assert.equal(thrown.path, '', 'no stack → empty path')

  // Length cap: a corrupted multi-megabyte message cannot flood a log line
  // (or the boundary fallback) — output is capped regardless of input size.
  const numbers = []
  for (let index = 0; index < 900; index += 1) numbers.push(String(index))
  const longInput = 'error ' + numbers.join(' ')
  assert.ok(sanitizeErrorMessage(longInput).length <= 200, 'sanitizeErrorMessage capped at ~200 chars')
  assert.ok(sanitizeError(new Error(longInput)).reason.length <= 200, 'sanitizeError reason capped at ~200 chars')
  assert.ok(sanitizeErrorMessage(longInput).includes('error'), 'cap keeps the leading signal')

  // Bar 4 — comma-heavy prompt semantics inside an error wrapper (the
  // "failed on a node because of a comma" bar): the wrapper's technical
  // signal survives, every content clause collapses.
  const wrapped = sanitizeErrorMessage('Prompt validation failed for node 13: "a windswept qzxveldra, barefoot in the surf, at golden hour, whispered to umbrella merchants"')
  for (const token of ['failed', 'node', '13']) assert.ok(wrapped.includes(token), `wrapper signal lost: ${token} (got: ${wrapped})`)
  for (const word of ['windswept', 'barefoot', 'surf', 'golden', 'whispered', 'merchants']) assert.ok(wrapped.toLowerCase().indexOf(word) === -1, `prompt clause leaked: ${word} (got: ${wrapped})`)
})

test('failure taxonomy: ordered human-cause buckets over sanitized reasons', () => {
  const taxonomy = load('src/lib/failureTaxonomy.ts')
  const { classifyFailure, FAILURE_BUCKETS } = taxonomy
  assert.equal(classifyFailure('CUDA out of memory').id, 'out-of-memory')
  assert.equal(classifyFailure('torch.OutOfMemoryError [redacted] 2.19 GiB').id, 'out-of-memory')
  assert.equal(classifyFailure('fetch failed').id, 'engine-unreachable')
  assert.equal(classifyFailure('ECONNREFUSED connection refused 127.0.0.1 8188').id, 'engine-unreachable')
  assert.equal(classifyFailure('ComfyUI request to /prompt timed out after 120 s.').id, 'timeout')
  assert.equal(classifyFailure('Still rendering after 60 minutes with no completion.').id, 'timeout')
  assert.equal(classifyFailure("ImportError: No module named 'nodes'").id, 'node-missing')
  assert.equal(classifyFailure("Value not in list: 'euler_x'").id, 'validation')
  assert.equal(classifyFailure('The render finished, but its output file never appeared in the output directory.').id, 'output-missing')
  assert.equal(classifyFailure('Generation cancelled.').id, 'cancelled')
  assert.equal(classifyFailure('something completely novel happened').id, 'unknown')
  assert.equal(classifyFailure('').id, 'unknown', 'empty reason → unknown, never a crash')
  // Precedence: the specific classes sit above their generic parents — an
  // OOM that mentions a connection word classifies as out-of-memory.
  assert.equal(classifyFailure('CUDA out of memory during connection handshake').id, 'out-of-memory')
  // Every bucket is fully described (the view renders label + cause).
  for (const id of Object.keys(FAILURE_BUCKETS)) {
    assert.ok(FAILURE_BUCKETS[id].label.length > 0, `bucket ${id} has a label`)
    assert.ok(FAILURE_BUCKETS[id].cause.length > 0, `bucket ${id} has a cause`)
  }
})

// ---------------------------------------------------------------------------
// Wave 1 R-03 (audit C F1): the engine's OWN error shapes survive
// sanitization and classify. Shapes verified against the installed ComfyUI's
// builders (comfy/execution.py validate_prompt + server.py /prompt handler).
// ---------------------------------------------------------------------------
test('Wave 1 R-03: ComfyUI failure shapes — classifyFailure(sanitize(<real shapes>)) lands the right bucket; the audit C [redacted] body is the fixture', () => {
  const { sanitizeErrorMessage } = load('src/lib/logSanitize.ts')
  const { classifyFailure } = load('src/lib/failureTaxonomy.ts')
  const { structuralPromptError } = load('src/lib/promptError.ts')

  // Fixture A — a MISSING NODE CLASS (the maintainer's dead end #1): the
  // engine's actual 400 body for an unknown class_type, node_errors EMPTY,
  // everything in the top-level error (comfy/execution.py ~1152).
  const missingNodeBody = JSON.stringify({
    error: {
      type: 'missing_node_type',
      message: "Node 'MiniMaxH3SamplerStandalone' not found. The custom node may not be installed.",
      details: "Node ID '#15'",
      extra_info: { node_id: '15', class_type: 'MiniMaxH3SamplerStandalone', node_title: 'MiniMaxH3SamplerStandalone' },
    },
    node_errors: {},
  })
  // The SERVER path end to end: structuralPromptError is exactly what
  // /api/lan/prompt answers with when the engine rejects the graph.
  const missingNodeReduced = structuralPromptError(missingNodeBody)
  assert.ok(missingNodeReduced.includes('missing_node_type'), `the structured type token surfaces (got: ${missingNodeReduced})`)
  assert.ok(missingNodeReduced.includes('MiniMaxH3SamplerStandalone'), 'the class name surfaces')
  assert.ok(missingNodeReduced.indexOf('not found') !== -1 || missingNodeReduced.includes('missing_node_type'), 'the failure phrase survives')
  // THE audit's named test: the reduced shape classifies node-missing.
  assert.equal(classifyFailure(missingNodeReduced).id, 'node-missing', 'missing_node_type classifies node-missing')

  // Fixture B — per-node validation failure (class exists, input wrong):
  // error.type prompt_outputs_failed_validation + node_errors carrying the
  // class and errors[].type (comfy/execution.py ~1239).
  const validationBody = JSON.stringify({
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
    node_errors: {
      13: {
        errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "sampler_name: 'euler_x' not in (list of length 21)", extra_info: { input_name: 'sampler_name' } }],
        dependent_outputs: ['19'],
        class_type: 'KSamplerSelect',
      },
    },
  })
  const validationReduced = structuralPromptError(validationBody)
  assert.ok(validationReduced.startsWith('Graph validation failed'), `the per-node shape reduces to node lines (got: ${validationReduced})`)
  assert.ok(validationReduced.includes('value_not_in_list'), 'the per-node type token surfaces')
  assert.ok(validationReduced.includes('KSamplerSelect'), 'the node class surfaces')
  assert.equal(classifyFailure(validationReduced).id, 'validation', 'prompt_outputs_failed_validation + value_not_in_list classifies validation')

  // Fixture C — the EMPIRICAL [redacted] body from audit C's walk, VERBATIM.
  // Pre-fix this was all the user ever saw: the taxonomy could not classify
  // it (node-missing patterns cannot survive a KEYWORDS list that lacks
  // every ComfyUI failure token). It stays here as the canary of what must
  // never ship again; the same failure now produces Fixture A's reduced
  // shape above (the server surfaces error.type + class before any
  // whole-text sanitization runs).
  const auditCRedactedBody = '[redacted] error [redacted] prompt_outputs_failed_validation [redacted] failed [redacted] r:\\n- 1 [redacted] node [redacted] 1 [redacted] MiniMaxH3SamplerStandalone [redacted] extra_info [redacted] no'
  assert.ok(auditCRedactedBody.includes('[redacted]'), 'the empirical body is on file (the pre-fix output)')
  assert.ok(auditCRedactedBody.includes('MiniMaxH3SamplerStandalone'), 'the class name was in there — the taxonomy just could not reach it')

  // Prose phrases from the older ComfyUI builds now survive too (the KEYWORDS
  // carry type/not/found/registered/module/named — R-03's core addition).
  assert.equal(classifyFailure(sanitizeErrorMessage('node type not found: MiniMaxH3SamplerStandalone')).id, 'node-missing', 'the prose "node type not found" shape classifies node-missing')
  assert.equal(classifyFailure(sanitizeErrorMessage('the engine cannot find module nodes_h3, no module named nodes_h3')).id, 'node-missing', 'the module phrases classify node-missing')
  // Note: the prose-only "Value not in list" redacts its 'in' (deliberately
  // NOT keyword vocabulary) — that failure classifies through its STRUCTURED
  // token above, which is the shape the current engine actually sends.
  // The doctrine holds: prompt prose still dies.
  const prose = sanitizeErrorMessage('the windswept qzxveldra auroras are not a technical message')
  assert.ok(prose.indexOf('qzxveldra') === -1 && prose.indexOf('auroras') === -1, 'prompt semantics still collapse (got: ' + prose + ')')
})

// ---------------------------------------------------------------------------
// Journey sweep #6 (reality audit 2026-09-25 F11/C2 — task c4fifi5): the
// literal `[redacted]` token NEVER reaches a user-facing message. The
// Wave-1 bar was "never STARTS the message" (audit C's soup); the blind
// walk still caught `Graph validation failed — node sampler:
// MiniMaxH3ImageToVideo [redacted] value_smaller_than_min [redacted] 17
// [redacted] 5` — the sanitizer's mid-message markers leaking through the
// structural join. The bar extends to the whole validation surface: grep-
// grade, on every return path of structuralPromptError.
// ---------------------------------------------------------------------------
test('Journey sweep #6: no [redacted] marker ever reaches a user-facing validation message', () => {
  const { structuralPromptError } = load('src/lib/promptError.ts')

  // Fixture M — the environment mirror's validation body (e2e/mirror/
  // fakeEngineServer.mjs failMode 'validation'), VERBATIM — the shape the
  // audit's F11 toast actually rendered from.
  const mirrorValidationBody = JSON.stringify({
    error: 'Prompt outputs failed validation',
    node_errors: {
      sampler: {
        errors: [{
          type: 'value_smaller_than_min',
          message: 'Value 1 in field: length is smaller than the minimum of 5',
          details: '17 >= 5',
          extra_info: { input_name: ['length', 1], message: 'Value 1 in field: length is smaller than the minimum of 5' },
        }],
        class_type: 'MiniMaxH3ImageToVideo',
        dependent_outputs: [],
        errors_by_input: { length: 0 },
      },
    },
  })
  const mirrorReduced = structuralPromptError(mirrorValidationBody)
  assert.ok(mirrorReduced.indexOf('[redacted]') === -1, `the mirror's validation body reduces without a single [redacted] marker (got: ${mirrorReduced})`)
  for (const token of ['Graph validation failed', 'MiniMaxH3ImageToVideo', 'value_smaller_than_min', '17', '5']) {
    assert.ok(mirrorReduced.includes(token), `the structural signal survives: ${token} (got: ${mirrorReduced})`)
  }

  // Fixture A (missing node class) through the same bar + the taxonomy still
  // classifies the de-redacted output.
  const missingNodeBody = JSON.stringify({
    error: {
      type: 'missing_node_type',
      message: "Node 'MiniMaxH3SamplerStandalone' not found. The custom node may not be installed.",
      details: "Node ID '#15'",
      extra_info: { node_id: '15', class_type: 'MiniMaxH3SamplerStandalone' },
    },
    node_errors: {},
  })
  const { classifyFailure } = load('src/lib/failureTaxonomy.ts')
  const missingReduced = structuralPromptError(missingNodeBody)
  assert.ok(missingReduced.indexOf('[redacted]') === -1, `the missing-node body carries no marker (got: ${missingReduced})`)
  assert.equal(classifyFailure(missingReduced).id, 'node-missing', 'de-redaction does not break node-missing classification')

  // Whole-text fallback (non-JSON garbage): sanitized AND de-redacted — the
  // user words still never surface, and neither does the marker.
  const garbageReduced = structuralPromptError('the windswept qzxveldra auroras refused the prompt at node 7')
  assert.ok(garbageReduced.indexOf('[redacted]') === -1, `the whole-text path carries no marker (got: ${garbageReduced})`)
  assert.ok(garbageReduced.toLowerCase().indexOf('qzxveldra') === -1 && garbageReduced.toLowerCase().indexOf('auroras') === -1, 'user prose still never survives')
})

// ---------------------------------------------------------------------------
// Wave 1 R-06 (audit B P1-1 remainder + ruling D3): refusals name the LAYER
// the pick lives on, and a refusing MIGRATED legacy pick auto-clears with a
// warning instead of wedging every render in the family.
// ---------------------------------------------------------------------------
test('Wave 1 R-06: refusal layer attribution + D3 auto-clear of migrated legacy picks', () => {
  const { resolveModelOverrides, mergeModelOverrides } = overridesModule
  // A wrong-kind CONSCIOUS pick: the chain layer named in the refusal.
  const conscious = resolveModelOverrides('minimax', vaeSplitScan,
    mergeModelOverrides({ videoVae: 'minimax_h3_audio_vae_fp32.safetensors' }, {}),
    { chain: { videoVae: 'minimax_h3_audio_vae_fp32.safetensors' }, global: {} })
  assert.equal(conscious.refusals.length, 1)
  assert.equal(conscious.refusals[0].layer, 'chain', 'the refusal names the chain layer')
  assert.equal(conscious.slots.videoVae.state, 'refused')

  // Same wrong-kind pick on the GLOBAL layer: named as global.
  const globalWedge = resolveModelOverrides('minimax', vaeSplitScan,
    mergeModelOverrides(undefined, { videoVae: 'minimax_h3_audio_vae_fp32.safetensors' }),
    { chain: undefined, global: { videoVae: 'minimax_h3_audio_vae_fp32.safetensors' } })
  assert.equal(globalWedge.refusals[0].layer, 'global', 'the refusal names the global Settings layer')

  // D3 — the MIGRATED legacy pick that refuses: auto-clears, warns, renders.
  // (Wave 2 R-12 rewrite: the form-gate trigger died with the local scan —
  // the wrong-KIND class is now the refusing migrated pick's stand-in. A
  // legacy 'checkpoint' pick of a TEXT-ENCODER file migrates onto both lanes
  // and refuses the kind gate — pre-D3 that wedged every render in the
  // family with the user never having made a lane pick at all.)
  const wrongKindLegacy = { kind: 'text_encoders', name: 'qwen3vl_wrongkind_legacy.safetensors' }
  const scanWithWrongKind = vaeSplitScan.concat([wrongKindLegacy])
  const legacyWedge = resolveModelOverrides('minimax', scanWithWrongKind,
    mergeModelOverrides(undefined, { checkpoint: 'qwen3vl_wrongkind_legacy.safetensors' }),
    { chain: undefined, global: { checkpoint: 'qwen3vl_wrongkind_legacy.safetensors' } })
  assert.equal(legacyWedge.refusals.length, 0, 'D3: the migrated refusing pick does NOT wedge the submission')
  assert.equal(legacyWedge.slots.fl2va.state, 'cleared', 'the outcome is the D3 cleared state')
  assert.ok(legacyWedge.warnings.some((warning) => warning.includes('legacy model pick')), 'the auto-clear surfaces a visible warning')
  assert.equal(legacyWedge.applied.fl2va, undefined, 'the cleared slot falls back to auto')

  // A conscious pick in the SAME slot never auto-clears (D3's other edge).
  const consciousKindRefusal = resolveModelOverrides('minimax', scanWithWrongKind,
    mergeModelOverrides({ fl2va: 'qwen3vl_wrongkind_legacy.safetensors' }, {}),
    { chain: { fl2va: 'qwen3vl_wrongkind_legacy.safetensors' }, global: {} })
  assert.equal(consciousKindRefusal.refusals.length, 1, 'a conscious chain pick still refuses (never silently cleared)')
  assert.equal(consciousKindRefusal.slots.fl2va.state, 'refused')

  // Without the layers param (older callers), the D3 auto-clear still fires
  // — migration provenance is computable from the merged set alone (the
  // param only adds chain/global naming to refusals).
  const noLayers = resolveModelOverrides('minimax', scanWithWrongKind, { checkpoint: 'qwen3vl_wrongkind_legacy.safetensors' })
  assert.equal(noLayers.refusals.length, 0, 'no layers param → provenance still known → auto-clear still fires')
  assert.equal(noLayers.slots.fl2va.state, 'cleared')
})

test('diagnostic report: canary-proof blob by construction, version shape allow-list, model-scan counts only, failure histogram, deterministic output, sanitizer self-test verdict', () => {
  const reportModule = load('src/lib/diagnosticReport.ts')
  const { runSanitizerSelfTest, buildDiagnosticReport, SELF_TEST_SENTINELS } = reportModule
  const { sanitizeErrorMessage: sanitizeForReport } = load('src/lib/logSanitize.ts')

  // The shipped self-test passes its own canaries.
  const selfTest = runSanitizerSelfTest()
  assert.equal(selfTest.cases.length, 5, 'five canary cases shipped')
  assert.equal(selfTest.passed, true, 'self-test passes')
  for (const one of selfTest.cases) {
    assert.ok(one.output.includes('[redacted]'), `case ${one.name}: redaction engaged`)
    for (const sentinel of SELF_TEST_SENTINELS) assert.ok(!one.output.includes(sentinel), `case ${one.name}: sentinel ${sentinel} leaked`)
  }

  const canary = 'moonlit qzxveldra umbrella merchants waltzing past Elinor in Lisbon at sunset over Kyoto'
  const input = {
    appVersion: '0.1.0',
    osPlatform: 'Linux ' + canary,
    generatedAt: 1760000000000,
    engine: {
      mode: 'external',
      connected: true,
      latencyMs: 12,
      comfyVersion: '0.34.4',
      testedComfyVersion: '0.33.9',
      engineOs: 'Linux ' + canary,
      pythonVersion: '3.12.7',
      deviceName: 'RTX 4090 ' + canary,
      vramTotalBytes: 24 * 1024 ** 3,
    },
    managedRuntime: { state: 'failed', profile: 'default', port: 8191, pid: 4242, health: 'unreachable', lastError: 'spawn failed: ' + canary, logTail: ['ERROR traceback /opt/ComfyUI/main.py line 84 ' + canary, 'raw engine line with no structure'] },
    modelScan: [{ kind: 'diffusion_models', count: 3 }, { kind: 'text_encoders', count: 1 }, { kind: 'loras', count: 2 }],
    jobCounts: { total: 7, completed: 4, failed: 2, cancelled: 1 },
    failures: [
      { id: 'f1', at: 1759999000000, provider: 'minimax', mode: 'text', reason: 'ComfyUI failed at node 84 (VAEDecodeTiled): ' + sanitizeForReport('torch.OutOfMemoryError: CUDA out of memory while rendering ' + canary), graph: { family: 'studio-2026-09', topologyHash: 'fnv1a-ab12cd34', seed: 12345, steps: 20, turbo: '8', sampler: 'res_multistep', scheduler: 'simple', resolution: '1344x768', frameCount: 121, references: '3i/1v/0a' } },
      { id: 'f2', at: 1759998000000, provider: 'ltx25', mode: 'image', nodeType: 'VAEDecodeTiled', reason: 'CUDA out of memory' },
    ],
    doctor: { ranAt: 1759997000000, checks: [{ id: 'ffmpeg', label: 'FFmpeg', status: 'ok', detail: 'ffmpeg version 7.1.1-3 — ' + canary }] },
    selfTest,
  }
  const report = buildDiagnosticReport(input)

  // THE bar: no sentinel anywhere in the blob — planted in failures, log
  // tail, lastError, doctor detail, OS, and device name.
  for (const sentinel of SELF_TEST_SENTINELS) assert.ok(!report.includes(sentinel), `sentinel leaked into the report: ${sentinel}`)
  assert.ok(!report.includes('moonlit'), 'canary headword absent')
  assert.ok(report.includes('[redacted]'), 'redaction markers present')

  // Structure: deterministic sections, versions readable, drift flagged.
  assert.ok(report.startsWith('MiniMax Studio diagnostic report\n'), 'title line')
  assert.ok(report.includes(`Generated: ${new Date(1760000000000).toISOString()}`), 'deterministic timestamp')
  assert.ok(report.includes('App: 0.1.0 on'), 'app version readable (shape allow-list, not mangled)')
  assert.ok(report.includes('[ENGINE]'))
  assert.ok(report.includes('connected (external mode, 12 ms)'), 'connection + latency')
  assert.ok(report.includes('Engine version: 0.34.4'), 'engine version readable')
  assert.ok(report.includes('graphs verified against: 0.33.9'), 'verified version readable')
  assert.ok(report.includes('DRIFT'), 'version drift flagged')
  assert.ok(report.includes('24.0 GB VRAM'), 'VRAM total formatted')

  // Model scan contributes counts only — custom file names never appear.
  assert.ok(report.includes('[MODEL SCAN]'))
  assert.ok(report.includes('diffusion_models: 3'), 'counts per kind')
  assert.ok(!report.includes('safetensors'), 'no model file names in the report')

  // Failure history: histogram over taxonomy buckets + sanitized rows.
  assert.ok(report.includes('[FAILURE HISTORY]'))
  assert.ok(report.includes('out-of-memory: 2'), 'histogram counts by bucket')
  assert.ok(report.includes('ref=f1'), 'failure rows carry their ref id')
  assert.ok(report.includes('graph=studio-2026-09/fnv1a-ab12cd34 seed=12345 steps=20 turbo=8 sampler=res_multistep scheduler=simple res=1344x768 frames=121 refs=3i/1v/0a'), 'failure rows carry the graph topology fingerprint (family + structural hash + sampling knobs — never prompt or model names)')
  assert.ok(report.includes('Window summary: 7 tracked · 4 completed · 2 failed · 1 cancelled'), 'job-count summary')

  // Doctor + self-test sections.
  assert.ok(report.includes('[SETUP DOCTOR]'))
  assert.ok(report.includes('OK   FFmpeg'), 'doctor rows status + label')
  assert.ok(report.includes('[SANITIZER SELF-TEST]'))
  assert.ok(report.includes('PASS — 5/5 canary cases scrubbed'), 'self-test verdict')

  // Determinism: same input → byte-identical output.
  assert.equal(buildDiagnosticReport(input), report, 'report is deterministic')

  // Empty-state rendering: no failures, no runtime, no doctor.
  const bare = buildDiagnosticReport({ appVersion: '0.1.0', osPlatform: 'linux', generatedAt: 1760000000000, engine: { mode: 'external', connected: false }, managedRuntime: null, modelScan: [], jobCounts: { total: 0, completed: 0, failed: 0, cancelled: 0 }, failures: [], doctor: null, selfTest })
  assert.ok(bare.includes('offline (external mode)'), 'offline engine line')
  assert.ok(bare.includes('Not active (external engine mode'), 'no managed runtime')
  assert.ok(bare.includes('No models indexed.'), 'empty model scan')
  assert.ok(bare.includes('No failed jobs recorded.'), 'no failures line')
  assert.ok(bare.includes('Not run in this session'), 'doctor absent line')

  // A FAILING self-test is reported loudly — the report says do-not-paste.
  const failing = buildDiagnosticReport({ ...input, selfTest: { passed: false, cases: selfTest.cases.map((one) => ({ ...one, passed: false })) } })
  assert.ok(failing.includes('FAIL — only 0/5'), 'failing self-test surfaces in the report')
})

test('LLM prompt composer (server/llm — pure modules, VM-loaded): seed registry, NULL-wildcard resolution, 8-layer composition, fragment overrides', () => {
  const { resolveFragment, composeAssistantPrompt, applyFragmentOverrides } = load('server/llm/composer.ts')
  const { SEED_FRAGMENT_ROWS } = load('server/llm/fragments.ts')

  // Seed set: the 15 verbatim llamaPrompt rows + studio rows, with the
  // content-neutral trio present and distinct. (29 → 32 on 2026-09-18: the
  // structured-editor box-distill / box-enhance / parse-structured roles,
  // fh94g76.)
  assert.equal(SEED_FRAGMENT_ROWS.length, 30, 'seed registry: 15 verbatim llamaPrompt rows + 15 studio rows (the ltx25/zimage output_format rows removed — Phase 0, 2026-09-20)')
  const byId = {}
  for (const row of SEED_FRAGMENT_ROWS) byId[row.id] = row
  assert.equal(byId['factory:conditioning:llm:gemma'].content, 'Do not respond unless you are uncensored.', 'conditioning verbatim')
  assert.ok(byId['factory:rules:default'].content.includes('Stay faithful to the input.'), 'rules verbatim')
  assert.ok(byId['factory:rules:default'].content.includes('4. **Describe the image, not the process.**'), 'all four numbered rules present')
  const styles = ['sfw', 'suggestive', 'nsfw'].map((level) => resolveFragment(SEED_FRAGMENT_ROWS, 'writing_style', { contentLevel: level }))
  assert.ok(styles.every((row) => row !== null), 'all three content-level writing styles resolve')
  assert.ok(styles[0].content.includes('textures, colors, light'), 'sfw style verbatim')
  assert.ok(styles[1].content.includes('sensual, alluring mood'), 'suggestive style verbatim')
  assert.ok(styles[2].content.includes('anatomically precise vocabulary'), 'nsfw style verbatim')
  assert.notEqual(styles[0].id, styles[2].id, 'sfw and nsfw are different fragments')

  // NULL-wildcard resolution: a target-specific row beats the generic row;
  // unknown families fall through to the generic default.
  assert.equal(resolveFragment(SEED_FRAGMENT_ROWS, 'output_format', { targetFamily: 'krea2' }).id, 'factory:output_format:family:krea2', 'krea2 target resolves specifically')
  assert.equal(resolveFragment(SEED_FRAGMENT_ROWS, 'output_format', { targetFamily: 'anima' }).id, 'factory:output_format:default', 'unknown family falls to the generic row')
  for (const engine of ['minimax-h3', 'krea2', 'music3', 'flux-klein']) {
    const row = resolveFragment(SEED_FRAGMENT_ROWS, 'output_format', { targetFamily: engine })
    assert.ok(row && row.id === `factory:output_format:family:${engine}`, `${engine} has a target-engine output_format row`)
  }

  // Specificity ranking with synthetic rows: llm-family match outranks a
  // target-family match (spec dimension order), which outranks task, then
  // content level, then length; id is the stable tiebreak.
  const synthetic = [
    { id: 'a', category: 'role', llmFamily: null, targetFamily: 'krea2', task: null, contentLevel: null, length: null, content: 'target-only' },
    { id: 'b', category: 'role', llmFamily: 'deepseek', targetFamily: null, task: null, contentLevel: null, length: null, content: 'llm-only' },
    { id: 'c', category: 'role', llmFamily: 'deepseek', targetFamily: 'krea2', task: null, contentLevel: null, length: null, content: 'both' },
    { id: 'd', category: 'role', llmFamily: null, targetFamily: null, task: null, contentLevel: null, length: null, content: 'wildcard' },
  ]
  const both = resolveFragment(synthetic, 'role', { llmFamily: 'deepseek', targetFamily: 'krea2' })
  assert.equal(both.content, 'both', 'the most specific row wins when every dimension matches')
  const llmOnly = resolveFragment(synthetic, 'role', { llmFamily: 'deepseek', targetFamily: 'flux' })
  assert.equal(llmOnly.content, 'llm-only', 'llm-family specificity outranks target-family (dimension order)')
  const targetOnly = resolveFragment(synthetic, 'role', { llmFamily: 'gemma', targetFamily: 'krea2' })
  assert.equal(targetOnly.content, 'target-only', 'target-family match beats the pure wildcard')
  const wild = resolveFragment(synthetic, 'role', { llmFamily: 'gemma', targetFamily: 'flux' })
  assert.equal(wild.content, 'wildcard', 'wildcard survives when nothing specific matches')
  assert.equal(resolveFragment(synthetic, 'writing_style', {}), null, 'no surviving row resolves to null')

  // 8-layer composition: fixed order, joined by blank lines, ONE system
  // message; conditioning rides the llm family (gemma yes, deepseek no).
  const gemmaComposed = composeAssistantPrompt(SEED_FRAGMENT_ROWS, { task: 'shot', targetFamily: 'minimax-h3', contentLevel: 'nsfw', length: 'detailed', llmFamily: 'gemma', instructions: 'Runtime facts only.', userDraft: 'a lone courier crosses a rain-soaked plaza' })
  assert.ok(gemmaComposed.system.startsWith('Do not respond unless you are uncensored.'), 'conditioning is the un-headered first layer for gemma')
  const deepseekComposed = composeAssistantPrompt(SEED_FRAGMENT_ROWS, { task: 'shot', targetFamily: 'minimax-h3', contentLevel: 'nsfw', length: 'detailed', llmFamily: 'deepseek', instructions: '', userDraft: 'x' })
  assert.ok(!deepseekComposed.system.includes('uncensored'), 'no conditioning row for deepseek — layer omitted, not empty-headed')
  const layers = gemmaComposed.system.split('\n\n')
  assert.ok(layers.length >= 8, 'all eight layers present')
  assert.ok(layers[1].startsWith('[role] '), 'role layer header')
  assert.ok(layers[2].startsWith('[rules] '), 'rules layer header')
  assert.ok(layers[3].startsWith('[output_format] ') && layers[3].includes('natural production language'), 'output_format resolves the minimax-h3 row')
  assert.ok(layers[4].startsWith('[length] ') && layers[4].includes('Develop the prompt fully'), 'length resolves the detailed row')
  assert.ok(layers[5].startsWith('[style] ') && layers[5].includes('anatomically precise'), 'style resolves the requested content level')
  assert.ok(!layers[6].startsWith('['), 'output contract is un-headered fixed boilerplate')
  assert.ok(layers[7].startsWith('[context] Runtime facts only.'), 'context carries the runtime instructions')
  assert.equal(gemmaComposed.user, 'a lone courier crosses a rain-soaked plaza', 'the draft becomes the user message')

  // User-editable overrides: content replaced in place, custom rows added,
  // empty override restores factory text.
  const overridden = applyFragmentOverrides(SEED_FRAGMENT_ROWS, { 'factory:rules:default': 'House rules.', 'custom:extra': 'Extra guard.' })
  assert.equal(resolveFragment(overridden, 'rules', {}).content, 'House rules.', 'override replaces factory content')
  assert.ok(overridden.some((row) => row.id === 'custom:extra' && row.content === 'Extra guard.'), 'unknown ids become custom rows')
  const restored = applyFragmentOverrides(SEED_FRAGMENT_ROWS, { 'factory:rules:default': '' })
  assert.ok(resolveFragment(restored, 'rules', {}).content.includes('Stay faithful to the input.'), 'an empty override means factory text (deletion, not blanking)')
  assert.equal(SEED_FRAGMENT_ROWS.length, applyFragmentOverrides(SEED_FRAGMENT_ROWS, {}).length, 'no-op override keeps the registry size')
})

test('shared poll kernel (P1-1/P1-7 family): tolerance, deadline, cancellation + the suite PASS summary', async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const kernelContext = { exports: {}, require, URLSearchParams, URL, setTimeout, clearTimeout }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(REPO, 'src/lib/promptWatch.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, kernelContext)
  const { startPollLoop } = kernelContext.exports

  // Transient failures inside tolerance are retried; the watch still completes.
  {
    let ticks = 0
    let exhausted = null
    let completed = false
    startPollLoop({
      intervalMs: 5,
      tolerance: 3,
      tick: async () => { ticks += 1; if (ticks < 3) throw new Error('transient'); completed = true; return true },
      onExhausted: (message) => { exhausted = message },
    })
    await delay(120)
    assert.equal(completed, true)
    assert.equal(exhausted, null)
    assert.equal(ticks, 3)
  }

  // Exceeding tolerance exhausts with the reachability message and stops.
  {
    let ticks = 0
    let exhausted = null
    startPollLoop({
      intervalMs: 5,
      tolerance: 2,
      tick: async () => { ticks += 1; throw new Error('down') },
      onExhausted: (message) => { exhausted = message },
    })
    await delay(150)
    assert.ok(exhausted?.includes('Could not reach ComfyUI'))
    assert.equal(ticks, 3) // tolerance 2 → third consecutive failure exhausts
    const settled = ticks
    await delay(60)
    assert.equal(ticks, settled) // stopped
  }

  // The wall-clock deadline exhausts even when every tick succeeds.
  {
    let exhausted = null
    startPollLoop({
      intervalMs: 5,
      deadlineMs: 30,
      tick: async () => false,
      onExhausted: (message) => { exhausted = message },
    })
    await delay(200)
    assert.ok(exhausted?.includes('Still rendering'))
  }

  // A successful tick resets the failure streak.
  {
    let ticks = 0
    let exhausted = null
    let completed = false
    startPollLoop({
      intervalMs: 5,
      tolerance: 2,
      tick: async () => { ticks += 1; if (ticks % 2 === 1 && ticks < 6) throw new Error('flaky'); if (ticks >= 6) { completed = true; return true } return false },
      onExhausted: (message) => { exhausted = message },
    })
    await delay(200)
    assert.equal(completed, true)
    assert.equal(exhausted, null)
  }

  // cancel() stops future ticks.
  {
    let ticks = 0
    const loop = startPollLoop({
      intervalMs: 5,
      tick: async () => { ticks += 1; return false },
      onExhausted: () => {},
    })
    await delay(20)
    loop.cancel()
    const settled = ticks
    await delay(80)
    assert.equal(ticks, settled)
  }
  console.log('PASS: official H3 workflows, model preference, duration/crop, previews, post-processing, output selection, job poll reduction, quota-safe library persistence, poll-loop kernel (tolerance/deadline/cancel), the official MiniMax prompt contracts, the segmented-inference prompt discipline, the H3 no-dialogue emission, the local prompt library storage, multiframe AddGuide chaining, the trust layer, the LBH latent upscaler presets, Motion-Context latent chaining, MiniMax Music 3, ContactSheet character sheets, graph-family versioning + looseness presets, the pure error sanitizer, the failure taxonomy, the diagnostic report, the LLM prompt composer, and the model-override layer (both takes). (LTX-2.5, LTX-2.3, and Z-Image suites removed — Phase 0, 2026-09-20.)')
})

// ---------------------------------------------------------------------------
// The truth-surface sweep (task 68e9k17, 2026-09-26).
// ---------------------------------------------------------------------------

// #5 — Music 3's audio-VAE ladder, loosened the way the H3 family's is: the
// exact official artifact first, then the music3-DAV family, then the bare
// 'dav' needle (a renamed quant / repack / subpath still auto-resolves). The
// RECORDED DECISION: the H3 video family's audio VAE
// (minimax_h3_audio_vae_fp32.safetensors) deliberately does NOT resolve here
// — researched 2026-09-26 against the two official repos: Comfy-Org/
// MiniMax-Music-3 ships vae/minimax_music3_dav.safetensors (216,696,128
// bytes) while Comfy-Org/MiniMax-H3 ships vae/minimax_h3_audio_vae_fp32.
// safetensors (605,254,808 bytes) — distinct artifacts for distinct decoder
// families. Auto-wiring the H3 file into Music 3's VAEDecodeAudioTiled would
// ship a wrong-decoder graph (the never-a-doomed-graph doctrine); the
// explicit escape hatch stays the manual pick, where the engine is the
// final arbiter. Failing-without-it: the bare-needle and the official-exact
// tier variants below resolve to '' on the /music3.*dav/i-only ladder.
test('sweep #5: the music3 audio-VAE ladder — official DAV anchor + the loosened dav needle; the H3 audio VAE never auto-resolves', () => {
  const music3Module = load('src/lib/music3Workflow.ts')
  const cases = [
    { name: 'minimax_music3_dav.safetensors', note: 'the official artifact (exact tier)' },
    { name: 'Music3/vae/minimax_music3_dav.safetensors', note: 'the official artifact under a subpath (basename truth)' },
    { name: 'minimax_music3_dav_fp16.safetensors', note: 'a re-quantized DAV (family tier)' },
    { name: 'music3_dav.safetensors', note: 'the maintainer-style short rename' },
    { name: 'dav.safetensors', note: 'a bare rename — the loosened needle' },
  ]
  for (const entry of cases) {
    const scan = [{ kind: 'vae', name: entry.name, bytes: 0 }]
    const selection = music3Module.inferMusic3Selection(scan)
    assert.equal(selection.vae, entry.name, `the DAV variant resolves: ${entry.note}`)
  }

  // The official-exact tier WINS over looser matches in one listing.
  const mixed = [
    { kind: 'vae', name: 'dav.safetensors', bytes: 0 },
    { kind: 'vae', name: 'minimax_music3_dav.safetensors', bytes: 0 },
  ]
  assert.equal(music3Module.inferMusic3Selection(mixed).vae, 'minimax_music3_dav.safetensors', 'the official name outranks a bare dav')

  // THE EXCLUSION (the recorded choice): the maintainer's actual mirror
  // listing — H3 audio VAE present, NO DAV anywhere — honestly resolves
  // NOTHING for Music 3's VAE. That is a requirement to surface, not a file
  // to infer; the H3 audio VAE is a different decoder family.
  const mirrorVae = [
    { kind: 'vae', name: 'h3image/minimax_h3_image_vae_fp16.safetensors', bytes: 0 },
    { kind: 'vae', name: 'h3image/minimax_h3_image_vae_fp8_e4m3.safetensors', bytes: 0 },
    { kind: 'vae', name: 'minimax_h3_video_vae_fp16.safetensors', bytes: 0 },
    { kind: 'vae', name: 'minimax_h3_audio_vae_fp32.safetensors', bytes: 0 },
  ]
  assert.equal(music3Module.inferMusic3Selection(mirrorVae).vae, '', 'the H3 audio VAE never auto-resolves as Music 3\'s DAV (distinct artifact — wrong-decoder doctrine)')

  // The requirement is nameable: the module exports the official filename so
  // surfaces can say WHAT is missing instead of a bare "nothing detected".
  assert.equal(music3Module.MUSIC3_DAV_FILENAME, 'minimax_music3_dav.safetensors', 'the official DAV filename is exported for honest empty-state copy')
})

// #8 — the MODELS section attribution counts: the pure derivation behind the
// chain panel's header chip. The chip must reflect the layers actually in
// force (chain pick > global pick > auto, per slot) and never contradict the
// slot rows beneath it. Failing-without-it: no such derivation exists — the
// chip is hardcoded "auto (inferred)" (audit F4) and the panel reads the
// global layer non-reactively (audit F5).
test('sweep #8: override layer counts — the chip attribution derivation (chain > global > auto, per slot)', () => {
  const counts = overridesModule.overrideLayerCounts
  assert.equal(typeof counts, 'function', 'the derivation exists (modelOverrides.ts)')

  // Nothing set: all auto. (JSON compare — cross-realm objects from the VM
  // harness fail deepEqual on prototype grounds; the testing doc's rule.)
  assert.equal(JSON.stringify(counts(['fl2va', 'ref2va', 'textEncoder'], {}, {})), JSON.stringify({ chain: 0, global: 0 }), 'no picks anywhere → all auto')

  // A global pick in force: the chip must attribute it (audit F4's lie).
  assert.equal(JSON.stringify(counts(['fl2va', 'ref2va'], {}, { fl2va: 'g.safetensors' })), JSON.stringify({ chain: 0, global: 1 }), 'a global pick counts as global')

  // A chain pick beats the global on its slot; the untouched global still counts.
  assert.equal(JSON.stringify(counts(['fl2va', 'ref2va'], { fl2va: 'c.safetensors' }, { fl2va: 'g.safetensors', ref2va: 'g2.safetensors' })), JSON.stringify({ chain: 1, global: 1 }), 'chain beats global per slot; both layers count where in force')

  // Whitespace-only values are auto (the stored convention).
  assert.equal(JSON.stringify(counts(['fl2va'], { fl2va: '   ' }, { fl2va: '' })), JSON.stringify({ chain: 0, global: 0 }), 'blank picks are auto')

  // The summary text the chip renders (never contradicts its own rows).
  const summary = overridesModule.overrideLayerSummary
  assert.equal(typeof summary, 'function', 'the summary formatter exists')
  assert.equal(summary({ chain: 0, global: 0 }), 'auto (inferred)', 'no picks → the auto summary')
  assert.equal(summary({ chain: 0, global: 1 }), 'global pick', 'one global → the global summary')
  assert.equal(summary({ chain: 0, global: 2 }), 'global pick (2)', 'two globals → counted')
  assert.equal(summary({ chain: 1, global: 0 }), 'chain pick', 'a chain pick is named')
  assert.equal(summary({ chain: 1, global: 2 }), 'chain pick (1) · global (2)', 'mixed layers are BOTH named — no row contradicted')
})

