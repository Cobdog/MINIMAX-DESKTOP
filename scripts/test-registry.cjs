'use strict'
/** Optimization-registry test suite (VM harness, no engine needed).
 *
 * Six probes, in the Kreatine verifier tradition:
 *  (a) INERTNESS — with every entry unselected, buildMiniMaxWorkflow output
 *      must be deep-equal to the pre-registry golden graphs
 *      (scripts/fixtures/registry-golden.json, snapshotted from the
 *      pre-registry builder over scripts/lib/registry-matrix.cjs). A new
 *      optimization can never perturb the base path.
 *  (b) TRANSFORM CORRECTNESS — entry-on graphs match hand-asserted
 *      expectations (turbo node wiring incl. the larryvrh pairing swap,
 *      LBH/LTX/RTX chains, preview override).
 *  (c) DETECTION — mock object_info + model-scan fixtures resolve each
 *      entry's availability, model file, missing nodes and node packs.
 *  (d) PAIRING CONTRACTS — steps and sampler are enforced per family
 *      (4-step families swap the dedicated sampler when the pack is present;
 *      8-step families keep res_multistep + simple even with the pack).
 *  (e) PAINLESS EXPANSION — a hypothetical turbo family defined HERE, in
 *      test data, registers through the registry alone, detects, transforms,
 *      pairs, and goes inert. Zero factory code changed.
 *  (f) KREA 2 EDIT FAMILIES — the five per-workflow edit graphs
 *      (scripts/lib/krea2edit-matrix.cjs → fixtures/krea2edit-golden.json):
 *      base-t2i inertness, golden equality, research-pinned defaults,
 *      hand-asserted dual-conditioning / AnyPaint wiring, the
 *      encode/transport/LoRA recipe-triple audit (incl. the t=0 carrier
 *      trap, the E-K1 index-pairing rule and the no-composite rule), the
 *      E-K1 honesty-label + scene-style prompt-contract surface strings,
 *      dial validation at the research limits, and availability gating
 *      per family.
 *
 * `node scripts/test-registry.cjs --update-golden` re-snapshots BOTH fixtures
 * from the CURRENT builders — only for intentional base-graph changes, and
 * always reviewed as a git diff (the fixture IS the inertness contract). */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadTs } = require('./lib/ts-vm.cjs')
const { GOLDEN_MATRIX } = require('./lib/registry-matrix.cjs')
const { KREA2_MATRIX, KREA2_BASE, KREA2_MODELS } = require('./lib/krea2edit-matrix.cjs')
const { LTX23_MATRIX, LTX23_MODELS, LTX23_EXPECTED_CENSUS } = require('./lib/ltx23-matrix.cjs')

const FIXTURE = path.resolve(__dirname, 'fixtures/registry-golden.json')
const KREA2_FIXTURE = path.resolve(__dirname, 'fixtures/krea2edit-golden.json')
const LTX23_FIXTURE = path.resolve(__dirname, 'fixtures/ltx23-golden.json')

const workflowModule = loadTs('src/lib/workflow.ts')
const { buildMiniMaxWorkflow, OFFICIAL_H3_SAMPLER, OFFICIAL_H3_SCHEDULER } = workflowModule
const graphModule = loadTs('src/lib/graph/index.ts')
const {
  optimizationEntries, findOptimization, registerOptimization, detectOptimizations,
  turboProvenance, classifyTurboFamily, turboLoraPatterns, resolveTurboPlan, larryvrhTurboPackPresent,
} = graphModule
const {
  buildKrea2Graph, buildKrea2T2iGraph, detectKrea2EditFamilies, findKrea2EditFamily,
  krea2LoraKindOfFilename, krea2RecipeAudit, resolveKrea2EditModels, KREA2_EDIT_FAMILIES, KREA2_RECIPE_PINS,
} = graphModule
const {
  buildLtx23UtilityGraph, buildLtx23UtilityGraphWithAudit, detectLtx23Utilities, findLtx23Utility,
  resolveLtx23Selection, LTX23_UTILITIES, LTX23_PINS, LTX23_PROMPTS,
} = graphModule
const { inferSelections } = loadTs('src/lib/modelSelection.ts')

/** Canonical JSON with sorted keys and undefined-valued keys dropped — the
 * graph's observable (wire) form. Cross-realm deepEqual is unreliable in this
 * harness; canonical strings are exact. */
function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + canon(value[key]))
      .join(',') + '}'
  }
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// Mock engine surfaces (object_info + model scan fixtures)
// ---------------------------------------------------------------------------
const node = (input) => ({ input: { required: input } })
const ltxModelList = [['ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', 'LatentUpscaleModelLoader']]

const FULL_INFO = {
  KSamplerSelect: node({ sampler_name: [['res_multistep', 'euler']] }),
  BasicScheduler: node({ scheduler: [['simple', 'beta']] }),
  VAELoader: node({ vae_name: [['minimax_h3_video_vae_fp16.safetensors', 'ltx-2.5-video-vae-bf16.safetensors']] }),
  VAEEncodeTiled: node({}), LatentUpscaleModelLoader: node({ model_name: ltxModelList }), LTXVLatentUpsampler: node({}),
  VAEDecodeTiled: node({}), ImageFromBatch: node({}), RepeatImageBatch: node({}), ImageBatch: node({}),
  MinimaxH3LatentUpscalerNode2D: node({ model_name: [['minimax_h3_latent_upscaler_2d_fp16.safetensors']] }),
  MinimaxH3LatentUpscaler3D: node({ model_name: [['minimax_h3_latent_upscaler_3d_fp16.safetensors']] }),
  UpscaleModelLoader: node({ model_name: [['RealESRGAN_x2.pth']] }),
  MiniMaxH3PreviewOverrideCS: node({}),
  MiniMaxH3TurboLoRA: node({ lora_name: [['x']] }),
  MiniMaxH3TurboSampler: node({}),
}

const BARE_INFO = { KSamplerSelect: FULL_INFO.KSamplerSelect, BasicScheduler: FULL_INFO.BasicScheduler, VAELoader: FULL_INFO.VAELoader }

const NO_PACK_INFO = { ...FULL_INFO }
delete NO_PACK_INFO.MiniMaxH3TurboSampler

const loraFile = (name) => ({ kind: 'loras', name })

// Real filenames verified against the publishers' HF listings (2026-09-14).
const REAL_TURBO_FILES = [
  ['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 'turbo.official-fl2v-8', 8],
  ['minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors', 'turbo.lightx2v-fl2v-8', 8],
  ['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_resized_avg_rank_21_bf16.safetensors', 'turbo.lightx2v-fl2v-8', 8],
  ['minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors', 'turbo.lightx2v-fl2v-4', 4],
  ['minimax_h3_fl2v_turbo_4step_v1.1_768p_fp8.safetensors', 'turbo.lightx2v-fl2v-4', 4],
  ['minimax_h3_fl2v_turbo_4step_v0.1.safetensors', 'turbo.lightx2v-fl2v-4', 4],
  ['minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_resized_avg_rank_20_bf16.safetensors', 'turbo.lightx2v-fl2v-4', 4],
  ['minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', 'turbo.ref2v-4', 4],
  ['minimax_h3_ref2v_turbo_4step_v0.1_comfyui_resized_avg_rank_21_bf16.safetensors', 'turbo.ref2v-4', 4],
  ['minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors', 'turbo.lightx2v-ref2v-8', 8],
  ['minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors', 'turbo.drbaph-4', 4],
  // v4_step600 is a 6-8-step family (bake-off 2026-09-15, task muwufpp) —
  // split from drbaph-4 into its own 8-step family, not a 4-step one.
  ['minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors', 'turbo.larryvrh-v4-8', 8],
  ['minimax_h3_turbo_v4_step600_pruned_comfyui.safetensors', 'turbo.larryvrh-v4-8', 8],
  ['MiniMax-H3-FL2VA-Acc-8Step.safetensors', 'turbo.pdd-fl2va-8', 8],
  ['MiniMax-H3-Ref2VA-Acc-8Step.safetensors', 'turbo.pdd-ref2va-8', 8],
]

// ---------------------------------------------------------------------------
// Krea 2 edit-family mocks (object_info + scan fixtures) — filenames verified
// against the publishers' HF listings and node INPUT_TYPES (2026-09-14).
// ---------------------------------------------------------------------------
const KREA2_FULL_INFO = {
  Krea2EditModelPatch: node({}),
  Krea2EditGroundedEncode: node({}),
  Krea2AnyPaintPrepare: node({}),
  Krea2AnyPaintEncode: node({}),
  Krea2AnyPaintModelPatch: node({}),
}
const KREA2_BARE_INFO = {}

const krea2File = (kind, name) => ({ kind, name, bytes: 1 })
const KREA2_FULL_SCAN = [
  krea2File('diffusion_models', 'krea2_turbo_int8_convrot.safetensors'),
  krea2File('diffusion_models', 'krea2_raw_int8_convrot.safetensors'),
  krea2File('text_encoders', 'qwen3vl_4b_fp8_scaled.safetensors'),
  krea2File('vae', 'qwen_image_vae.safetensors'),
  krea2File('loras', 'krea2_identity_edit_v1_2.safetensors'),
  krea2File('loras', 'krea2_anypaint_rank32.safetensors'),
]

// ---------------------------------------------------------------------------
// (a) INERTNESS — registry-off graphs deep-equal the pre-registry goldens
// ---------------------------------------------------------------------------
function goldenEntries() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  assert.ok(fixture.entries.length >= 20, 'golden fixture looks wrong — regenerate with --update-golden against reviewed code')
  return fixture.entries
}

function runInertness(entries) {
  let checked = 0
  for (const { name, options, models, uploads, graph } of entries) {
    const rebuilt = buildMiniMaxWorkflow(options, models, uploads)
    assert.equal(canon(rebuilt), canon(graph), `inertness violated by config '${name}' — an unselected entry perturbed the base graph`)
    checked += 1
  }
  return checked
}

// ---------------------------------------------------------------------------
// The matrix configs reused as the transform-correctness base.
// ---------------------------------------------------------------------------
const MATRIX_BY_NAME = {}
for (const { name, options, models, uploads } of GOLDEN_MATRIX) MATRIX_BY_NAME[name] = { options, models, uploads }
const BASE_MODELS = MATRIX_BY_NAME['native-quality'].models

function buildWithLora(loraName, { turbo = '4', info, turboLoader, mode = 'text' } = {}) {
  const models = { ...BASE_MODELS, fl2vLora: loraName, ref2vLora: loraName }
  const options = {
    ...MATRIX_BY_NAME['turbo4-text'].options, turbo, mode,
    ...(turboLoader ? { turboLoader } : {}),
  }
  return buildMiniMaxWorkflow(options, models, { images: [], videos: [], audios: [] }, info)
}

let checks = 0
function ok(condition, message) {
  assert.ok(condition, message)
  checks += 1
}

function run() {
  // ---- (a) inertness ------------------------------------------------------
  const inertCount = runInertness(goldenEntries())
  ok(inertCount === GOLDEN_MATRIX.length, `inertness probe covered the whole matrix (${inertCount}/${GOLDEN_MATRIX.length})`)

  // ---- registry shape ------------------------------------------------------
  const entries = optimizationEntries()
  ok(entries.length >= 12, 'registry carries the migrated + turbo-matrix entries')
  const ids = entries.map((entry) => entry.id)
  ok(new Set(ids).size === ids.length, 'entry ids are unique')
  for (const entry of entries) {
    ok(typeof entry.detect === 'function' && typeof entry.transform === 'function', `${entry.id} has detect+transform`)
    ok(entry.ui.description.length > 0, `${entry.id} has a UI description`)
    ok(entry.appliesTo.includes('minimax'), `${entry.id} applies to the H3 engine`)
  }
  for (const required of ['turbo.official-fl2v-8', 'turbo.lightx2v-fl2v-4', 'turbo.lightx2v-ref2v-8', 'turbo.pdd-fl2va-8', 'turbo.pdd-ref2va-8', 'turbo.drbaph-4', 'turbo.larryvrh-v4-8', 'turbo.ref2v-4', 'upscale.ltx2x', 'upscale.lbh2d', 'upscale.lbh3d', 'upscale.rtx', 'preview.h3-override']) {
    ok(Boolean(findOptimization(required)), `registry contains ${required}`)
  }
  assert.throws(() => registerOptimization(entries[0]), /duplicate id/, 'duplicate registration is rejected')

  // ---- (b) transform correctness ------------------------------------------
  // Plain path: a 4-step family without the pack renders the pre-registry
  // loader topology (LoraLoaderModelOnly at node 5, KSamplerSelect at 13).
  {
    const graph = buildWithLora('minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors', { turbo: '4' })
    ok(graph['5'].class_type === 'LoraLoaderModelOnly', 'plain loader when the pack is absent')
    ok(graph['5'].inputs.lora_name === 'minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors', 'LoRA filename wired')
    ok(graph['5'].inputs.model.join('|') === '1|0', 'loader wraps the UNet')
    ok(graph['12'].inputs.model.join('|') === '5|0' && graph['14'].inputs.model.join('|') === '5|0', 'guider+scheduler consume the wrapped model')
    ok(graph['13'].class_type === 'KSamplerSelect' && graph['13'].inputs.sampler_name === OFFICIAL_H3_SAMPLER, 'plain sampler select kept')
    ok(graph['14'].inputs.steps === 4, '4-step family pairing sets the scheduler steps')
  }
  // Dedicated path: with the larryvrh pack in object_info the SAME family
  // swaps to MiniMaxH3TurboLoRA + MiniMaxH3TurboSampler — MODEL→MODEL and
  // →SAMPLER in the same graph slots.
  {
    const graph = buildWithLora('minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors', { turbo: '4', info: FULL_INFO })
    ok(graph['5'].class_type === 'MiniMaxH3TurboLoRA', 'dedicated loader replaces LoraLoaderModelOnly when the pack is installed')
    ok(graph['5'].inputs.model.join('|') === '1|0', 'dedicated loader still wraps the UNet')
    ok(graph['5'].inputs.strength === 1 && graph['5'].inputs.low_vram === false, 'dedicated loader widget defaults')
    ok(graph['13'].class_type === 'MiniMaxH3TurboSampler', 'the pack sampler replaces KSamplerSelect')
    ok(Object.keys(graph['13'].inputs).length === 0, 'the pack sampler carries no widgets')
    ok(graph['15'].inputs.sampler.join('|') === '13|0', 'SamplerCustomAdvanced still consumes node 13')
    ok(graph['14'].inputs.steps === 4, 'steps still driven by the pairing contract')
    ok(graph['12'].inputs.model.join('|') === '5|0', 'model chain flows through the dedicated loader')
  }
  // Plain-loader opt-in (community quality path) overrides the pack swap.
  {
    const graph = buildWithLora('minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors', { turbo: '4', info: FULL_INFO, turboLoader: 'plain' })
    ok(graph['5'].class_type === 'LoraLoaderModelOnly' && graph['13'].class_type === 'KSamplerSelect', "turboLoader 'plain' forces the stock loader+sampler")
    ok(graph['14'].inputs.steps === 4, 'pairing steps survive the loader override')
  }
  // A pack without its sampler half never half-swaps.
  {
    const graph = buildWithLora('minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors', { turbo: '4', info: NO_PACK_INFO })
    ok(graph['5'].class_type === 'LoraLoaderModelOnly' && graph['13'].class_type === 'KSamplerSelect', 'partial pack presence keeps the plain path')
  }
  // Strength + experimental sampling still respected on the dedicated path.
  {
    const models = { ...BASE_MODELS, fl2vLora: 'minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors' }
    const options = { ...MATRIX_BY_NAME['turbo4-text'].options, turbo: '4', loraStrength: 0.75, experimentalSampling: true, sampler: 'euler', scheduler: 'beta' }
    const graph = buildMiniMaxWorkflow(options, models, { images: [], videos: [], audios: [] }, FULL_INFO)
    ok(graph['5'].inputs.strength === 0.75, 'strength reaches the dedicated loader')
    ok(graph['13'].class_type === 'KSamplerSelect' && graph['13'].inputs.sampler_name === 'euler', 'experimental sampling wins over the pairing sampler node')
    ok(graph['14'].inputs.scheduler === 'beta' && graph['14'].inputs.steps === 4, 'experimental scheduler honored, pairing steps enforced')
  }
  // Upscale entries reproduce their asserted chains (registry-level re-check
  // of the topology test-workflows.cjs pins against the entry seam).
  {
    const lbh = MATRIX_BY_NAME['lbh3d-quality']
    const graph = buildMiniMaxWorkflow(lbh.options, lbh.models, lbh.uploads)
    ok(graph['90'].class_type === 'SplitSigmas' && graph['92'].class_type === 'MinimaxH3LatentUpscaler3D', 'LBH 3D entry inserts its block')
    ok(graph['15'].inputs.sigmas.join('|') === '90|0', 'LBH rewires the stage-1 sampler sigmas')
    ok(graph['99'].class_type === 'SaveVideo', 'LBH save node present')
    const ltx = MATRIX_BY_NAME['ltx-text-5s']
    const ltxGraph = buildMiniMaxWorkflow(ltx.options, ltx.models, ltx.uploads)
    ok(ltxGraph['66'].class_type === 'LTXVLatentUpsampler' && ltxGraph['70'].class_type === 'SaveVideo', 'LTX 2x entry inserts its block')
    const rtx = MATRIX_BY_NAME['rtx-turbo4']
    const rtxGraph = buildMiniMaxWorkflow(rtx.options, rtx.models, rtx.uploads)
    ok(rtxGraph['82'].class_type === 'ImageScale' && rtxGraph['84'].class_type === 'SaveVideo', 'RTX entry inserts its block')
  }
  // Preview entry: same node-7 contract as the golden graph.
  {
    const preview = MATRIX_BY_NAME['preview-override']
    const graph = buildMiniMaxWorkflow(preview.options, preview.models, preview.uploads, FULL_INFO)
    ok(graph['7'].class_type === 'MiniMaxH3PreviewOverride', 'preview entry inserts node 7')
    ok(graph['12'].inputs.model.join('|') === '7|0', 'guider consumes the preview-wrapped model')
    ok(graph['7'].inputs.vae_name === 'taeh3_decoder.safetensors', 'preview VAE passthrough')
  }

  // ---- (c) detection -------------------------------------------------------
  {
    const allFiles = REAL_TURBO_FILES.map(([name]) => loraFile(name))
    const detected = detectOptimizations(FULL_INFO, allFiles)
    const byId = {}
    for (const { entry, detection } of detected) byId[entry.id] = detection
    for (const [filename, expectedFamily] of REAL_TURBO_FILES) {
      ok(byId[expectedFamily] && byId[expectedFamily].available === true, `${expectedFamily} detects its file (${filename})`)
      ok(byId[expectedFamily].packs?.larryvrhTurbo === true, `${expectedFamily} reports the larryvrh pack present`)
    }
    const bare = detectOptimizations(BARE_INFO, [loraFile('minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors')])
    const bareById = {}
    for (const { entry, detection } of bare) bareById[entry.id] = detection
    ok(bareById['turbo.official-fl2v-8'].available === true && bareById['turbo.official-fl2v-8'].packs.larryvrhTurbo === false, 'turbo detection works offline of the pack; pack reported absent')
    ok(bareById['upscale.ltx2x'].available === false && bareById['upscale.ltx2x'].missingNodes.length === 7, 'LTX entry reports its missing nodes on a bare engine')
    ok(bareById['upscale.lbh3d'].available === false && bareById['upscale.lbh3d'].missingNodes.join() === 'MinimaxH3LatentUpscaler3D', 'LBH 3D entry names its missing node')
    ok(bareById['preview.h3-override'].available === false, 'preview entry unavailable on a bare engine')
    ok(bareById['upscale.rtx'].available === false, 'RTX entry needs an upscale model')
    const full = detectOptimizations(FULL_INFO, [])
    const fullById = {}
    for (const { entry, detection } of full) fullById[entry.id] = detection
    ok(fullById['upscale.ltx2x'].available === true && fullById['upscale.ltx2x'].model === 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', 'LTX entry resolves its model from object_info choices')
    ok(fullById['upscale.lbh2d'].available === true && fullById['upscale.rtx'].available === true && fullById['preview.h3-override'].available === true, 'upscale+preview entries available on the full mock')
    ok(fullById['turbo.lightx2v-fl2v-4'].available === false, 'turbo entries need their LoRA file (no false availability)')
    ok(larryvrhTurboPackPresent(FULL_INFO) && !larryvrhTurboPackPresent(BARE_INFO) && !larryvrhTurboPackPresent(undefined), 'pack presence helper')
    ok(!detected.some(({ entry }) => entry.id === 'turbo.generic'), 'the generic fallback is never surfaced as a detectable family')
  }

  // ---- classification + provenance ----------------------------------------
  {
    for (const [filename, expectedFamily, expectedSteps] of REAL_TURBO_FILES) {
      const family = classifyTurboFamily(filename)
      ok(family && family.id === expectedFamily, `${filename} classifies as ${expectedFamily} (got ${family && family.id})`)
      const provenance = turboProvenance(filename)
      ok(provenance && provenance.entryId === expectedFamily && provenance.steps === expectedSteps, `${filename} provenance carries family+steps`)
    }
    ok(classifyTurboFamily('my_custom_lora.safetensors') === undefined, 'unrecognized LoRAs classify as no family')
    ok(turboProvenance('my_custom_lora.safetensors') === undefined, 'unrecognized LoRAs have no provenance')
    // Measured-basis note: the Ref2VA fast-tier default states its basis
    // (bake-off 2026-09-15) and its tier scope; families without a measured
    // claim carry no note.
    const v4Provenance = turboProvenance('minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors')
    ok(v4Provenance && /bake-off 2026-09-15/.test(v4Provenance.note ?? '') && /quality tier/.test(v4Provenance.note ?? ''), 'larryvrh v4 provenance note carries the bake-off date and the quality-tier framing')
    ok(turboProvenance('minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors')?.note === undefined, 'the lightx2v runner-up carries no measured-basis note')
    // Dedicated-sampler pairings are declared only by 4-step families (the
    // official Ref2V 4-step keeps res_multistep — that direction is allowed).
    for (const entry of optimizationEntries()) {
      if (entry.kind !== 'turbo' || !entry.patterns) continue
      const declaresSamplerNode = Boolean(entry.pairing?.samplerNode)
      const isFourStep = entry.pairing?.steps === 4
      ok(!declaresSamplerNode || isFourStep, `${entry.id}: a dedicated-sampler pairing only appears on a 4-step family`)
    }
  }

  // ---- (d) pairing contracts ------------------------------------------------
  {
    for (const [filename, expectedFamily, steps] of REAL_TURBO_FILES) {
      const family = findOptimization(expectedFamily)
      // Dedicated-eligible families swap when the pack is present.
      const withPack = buildWithLora(filename, { turbo: String(steps), info: FULL_INFO })
      ok(withPack['14'].inputs.steps === steps, `${expectedFamily}: scheduler steps enforced at ${steps}`)
      if (family.pairing?.samplerNode) {
        ok(withPack['13'].class_type === family.pairing.samplerNode, `${expectedFamily}: dedicated sampler node enforced with the pack`)
      } else {
        ok(withPack['13'].class_type === 'KSamplerSelect' && withPack['13'].inputs.sampler_name === OFFICIAL_H3_SAMPLER, `${expectedFamily}: 8-step families keep the official sampler even with the pack installed`)
        ok(withPack['14'].inputs.scheduler === OFFICIAL_H3_SCHEDULER, `${expectedFamily}: official scheduler kept`)
      }
      // A family's step pairing wins over a mismatched turbo setting.
      const mismatch = buildWithLora(filename, { turbo: steps === 4 ? '8' : '4' })
      ok(mismatch['14'].inputs.steps === steps, `${expectedFamily}: family steps win over a mismatched turbo setting`)
    }
    // Plan resolution truth table.
    ok(resolveTurboPlan({ turbo: 'off', loraName: 'x' }) === undefined, 'no plan when turbo is off')
    ok(resolveTurboPlan({ turbo: '8', loraName: '' }) === undefined, 'no plan without a LoRA')
    const plan = resolveTurboPlan({ turbo: '4', loraName: 'minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors', info: FULL_INFO })
    ok(plan.entryId === 'turbo.lightx2v-fl2v-4' && plan.loader === 'dedicated' && plan.samplerNode === 'MiniMaxH3TurboSampler', 'plan resolves family/loader/sampler')
    const customPlan = resolveTurboPlan({ turbo: '8', loraName: 'whatever.safetensors' })
    ok(customPlan.entryId === 'turbo.generic' && customPlan.loader === 'plain' && customPlan.steps === 8, 'unknown LoRAs fall to the generic plain-loader entry')
  }

  // ---- selection inference (family-ranked) ----------------------------------
  {
    const official8 = loraFile('minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors')
    const light8 = loraFile('minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors')
    const light412 = loraFile('minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors')
    const light410 = loraFile('minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors')
    const pddFl = loraFile('MiniMax-H3-FL2VA-Acc-8Step.safetensors')
    const ref4 = loraFile('minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors')
    const ref8 = loraFile('minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors')
    ok(inferSelections([light8, official8], '8').fl2vLora === official8.name, 'official 8-step outranks lightx2v 8-step')
    ok(inferSelections([light8], '8').fl2vLora === light8.name, 'lightx2v 8-step selected when official absent')
    ok(inferSelections([light412, light410], '4').fl2vLora === light412.name, '4-step ranking prefers the newest lightx2v version (v1.2 default speed)')
    ok(inferSelections([light412, light8, official8], 'off').fl2vLora === official8.name, 'off keeps the official-first ranking')
    ok(inferSelections([ref8, ref4], '8').ref2vLora === ref8.name, 'reference mode selects the lightx2v Ref2VA 8-step when present')
    // Ref2VA 8-step FAST TIER (bake-off 2026-09-15, task muwufpp): larryvrh
    // v4_step600_ema outranks lightx2v; lightx2v stays the fallback; the
    // promotion is Ref2VA-specific and an explicit pick overrides it.
    const larryV4 = loraFile('minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors')
    ok(inferSelections([larryV4, ref8], '8').ref2vLora === larryV4.name, 'Ref2VA 8-step fast tier ranks larryvrh v4_step600_ema above lightx2v (bake-off 2026-09-15)')
    ok(inferSelections([ref8], '8').ref2vLora === ref8.name, 'lightx2v Ref2VA 8-step stays the fast-tier fallback when the v4 LoRA is absent')
    ok(inferSelections([larryV4, ref8], '8', 'turbo.lightx2v-ref2v-8').ref2vLora === ref8.name, 'an explicit lightx2v family pick overrides the fast-tier default ranking')
    ok(inferSelections([larryV4], '8').fl2vLora === '' && inferSelections([larryV4, official8], '8').fl2vLora === official8.name, 'FL2V ranking unchanged: the v4 file is never auto-selected for FL2V')
    ok(inferSelections([ref4], '8').ref2vLora === '', 'reference 8-step stays empty without a Ref2VA 8-step LoRA')
    ok(inferSelections([ref4], '4').ref2vLora === ref4.name, 'reference 4-step keeps the official LoRA')
    ok(inferSelections([official8, pddFl], '8', 'turbo.pdd-fl2va-8').fl2vLora === pddFl.name, 'an explicit family choice constrains inference to it')
    ok(inferSelections([official8, pddFl], '8', 'turbo.official-fl2v-8').fl2vLora === official8.name, 'explicit official family still wins with PDD installed')
    // Ranking patterns are registry data: the 4-step list prefers v1.2 first.
    const ranked = turboLoraPatterns('fl2v', '4')
    ok(ranked[0].test('minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors') && !ranked[0].test('minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors'), 'ranking patterns expose the version preference')
    // …and the Ref2VA 8-step list puts the measured larryvrh v4 EMA
    // checkpoint above lightx2v (fast-tier default, bake-off 2026-09-15).
    const refRanked = turboLoraPatterns('ref2v', '8')
    ok(refRanked[0].test('minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors') && !refRanked[0].test('minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors'), 'ref2v 8-step ranking puts the measured larryvrh v4 EMA checkpoint first')
    ok(refRanked[1].test('minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors'), 'lightx2v Ref2VA 8-step remains the runner-up ranking pattern')

    // Workspace normalization: legacy reference+8 resets, an explicit
    // Ref2VA 8-step family pick survives a reload.
    const { normalizeWorkspace } = loadTs('src/lib/workspace.ts')
    ok(normalizeWorkspace({ mode: 'reference', turbo: '8' }).turbo === 'off', 'legacy reference 8-step choices reset on reload')
    ok(normalizeWorkspace({ mode: 'reference', turbo: '8', turboFamily: 'turbo.lightx2v-ref2v-8' }).turbo === '8', 'explicit Ref2VA 8-step family survives reload')
    ok(normalizeWorkspace({ mode: 'reference', turbo: '8', turboFamily: 'turbo.larryvrh-v4-8' }).turbo === '8', 'explicit larryvrh v4 fast-tier family survives reload')
    ok(normalizeWorkspace({ mode: 'text', turbo: '8' }).turbo === '8', 'non-reference 8-step untouched')
  }

  // ---- (e) painless expansion: a hypothetical family, registry data only ----
  {
    const HYPOTHETICAL_FILE = 'hypothetical_h3_turbo_5step_v2.0_comfyui_bf16.safetensors'
    const unregister = registerOptimization({
      id: 'turbo.hypothetical-5',
      label: 'Hypothetical 5-step (test fixture)',
      kind: 'turbo',
      appliesTo: ['minimax'],
      wraps: 'modelChain',
      patterns: [/^hypothetical_h3_turbo_5step/i],
      pairing: { sampler: 'res_multistep', scheduler: 'simple', samplerNode: 'HypotheticalTurboSampler', steps: 5 },
      ui: { description: 'Test-only family proving registry-data expansion.' },
      detect(info, files) {
        const match = files.find((file) => file.kind === 'loras' && /^hypothetical_h3_turbo_5step/i.test(file.name))
        return { available: Boolean(match), model: match?.name, packs: { larryvrhTurbo: Boolean(info && info.MiniMaxH3TurboSampler) } }
      },
      transform(graph, ctx, opts) {
        const plan = opts.turboPlan
        if (!plan) return
        ctx.wrapModel('turboLora', '5', plan.loader === 'dedicated'
          ? { class_type: 'HypotheticalTurboLoader', inputs: { lora_name: plan.loraName, strength: plan.strength } }
          : { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: plan.loraName, strength_model: plan.strength } })
      },
    })
    try {
      ok(Boolean(findOptimization('turbo.hypothetical-5')), 'the hypothetical family registered')
      ok(classifyTurboFamily(HYPOTHETICAL_FILE)?.id === 'turbo.hypothetical-5', 'it classifies its filename')
      const detection = findOptimization('turbo.hypothetical-5').detect(undefined, [loraFile(HYPOTHETICAL_FILE)])
      ok(detection.available && detection.model === HYPOTHETICAL_FILE, 'it detects against a mock scan without any engine')
      // Plain build: its LoRA renders through its own transform at 5 steps.
      const graph = buildWithLora(HYPOTHETICAL_FILE, { turbo: '8' })
      ok(graph['5'].class_type === 'LoraLoaderModelOnly' && graph['5'].inputs.lora_name === HYPOTHETICAL_FILE, 'its transform renders the plain loader')
      ok(graph['14'].inputs.steps === 5, 'its pairing contract enforces 5 steps even with turbo set to 8')
      // Dedicated build: its own sampler node swaps in when present.
      const dedicatedInfo = { ...FULL_INFO, HypotheticalTurboSampler: node({}) }
      const dedicated = buildWithLora(HYPOTHETICAL_FILE, { turbo: '8', info: dedicatedInfo })
      ok(dedicated['5'].class_type === 'HypotheticalTurboLoader', 'its dedicated loader swaps in via registry data alone')
      ok(dedicated['13'].class_type === 'HypotheticalTurboSampler', 'its own sampler node replaces KSamplerSelect')
      // Inertness: with it unselected the base graphs are untouched — the
      // registration itself perturbs nothing.
      const inert = runInertness(goldenEntries())
      ok(inert === GOLDEN_MATRIX.length, 'golden matrix still inert with the hypothetical entry registered')
      const turbo4 = MATRIX_BY_NAME['turbo4-text']
      const untouched = buildMiniMaxWorkflow(turbo4.options, turbo4.models, turbo4.uploads)
      ok(untouched['5'].inputs.lora_name === turbo4.models.fl2vLora, 'an unrelated turbo render is untouched by the new entry')
    } finally {
      unregister()
    }
    ok(!findOptimization('turbo.hypothetical-5'), 'unregister restores the registry')
  }

  // ---- (f) Krea 2 edit families -------------------------------------------
  {
    const krea2Fixture = JSON.parse(fs.readFileSync(KREA2_FIXTURE, 'utf8'))
    ok(krea2Fixture.entries.length === KREA2_MATRIX.length, 'krea2 golden fixture covers the whole matrix — regenerate with --update-golden if the matrix changed')
    const goldenByName = {}
    for (const { name, graph } of krea2Fixture.entries) goldenByName[name] = graph
    const matrixByName = {}
    for (const { name, options, models } of KREA2_MATRIX) matrixByName[name] = { options, models }

    // (f1) Registry shape: five families, unique ids, detect + guidance, and
    // zero leakage into the H3 optimization registry.
    ok(KREA2_EDIT_FAMILIES.length === 5, 'five edit families ship')
    const familyIds = KREA2_EDIT_FAMILIES.map((family) => family.id)
    ok(new Set(familyIds).size === familyIds.length, 'family ids are unique')
    for (const family of KREA2_EDIT_FAMILIES) {
      ok(typeof family.detect === 'function', `${family.id} has detect`)
      ok(family.ui.description.length > 0 && (family.ui.installHint ?? '').length > 0, `${family.id} carries description + install guidance`)
      ok(family.recipeTriple.encode.length > 0 && family.recipeTriple.transport.length > 0, `${family.id} declares its recipe triple`)
    }
    ok(!optimizationEntries().some((entry) => entry.id.startsWith('krea2edit.')), 'edit families live in their own registry — the H3 optimization list is untouched')

    // (f1b) E-K1 corrections as surface-string pins (Flux 7ed5ewa, E-K1 on
    // the 8189 testbed, 2026-09-15): the instruct honesty label and the
    // scene-style prompt contract are evidence-backed — their load-bearing
    // content is pinned so it cannot silently drift.
    {
      const byId = {}
      for (const family of KREA2_EDIT_FAMILIES) byId[family.id] = family
      const instructUi = byId['krea2edit.instruct'].ui
      ok(instructUi.description.includes('semantic regeneration of the whole frame'), 'instruct honesty label: the description states whole-frame semantic regeneration')
      ok(instructUi.warning.includes('NOT region-preserving') && instructUi.warning.includes('26.5 dB'), 'instruct honesty label: measured 26.5 dB outside-region drift surfaced, identity- vs region-preservation distinguished')
      ok(instructUi.warning.includes('0.94') && instructUi.warning.includes('Refine'), 'instruct honesty label: the measured identity band (0.94–0.98) and the deterministic mask-path pointer are both there')
      ok((instructUi.promptGuidance ?? '').includes('whole resulting scene'), 'instruct prompt contract: scene-style guidance — describe the whole resulting scene, not just the changed object')
      ok((byId['krea2edit.refine'].ui.promptGuidance ?? '').includes('complete finished image'), 'refine prompt contract: describe the complete finished image, never just the masked object (the measured AnyPaint contract — object-local prompts painted planks, not the bowl)')
      ok((byId['krea2edit.outpaint'].ui.promptGuidance ?? '').length > 0, 'outpaint carries the scene-style prompt guidance too (the grown canvas described as one scene)')
    }

    // (f2) Inertness: stripping `edit` from any config rebuilds the base t2i
    // golden, and the two base entry points agree byte-for-byte.
    for (const { name, options, models } of KREA2_MATRIX) {
      const stripped = buildKrea2Graph({ ...options, edit: undefined }, models)
      assert.equal(canon(stripped), canon(krea2Fixture.base), `krea2 inertness violated by config '${name}' — a family perturbed the base t2i path`)
      checks += 1
    }
    assert.equal(canon(buildKrea2T2iGraph(KREA2_BASE, KREA2_MODELS)), canon(buildKrea2Graph(KREA2_BASE, KREA2_MODELS)), 'buildKrea2Graph without an edit request equals buildKrea2T2iGraph')
    checks += 1

    // (f3) Golden equality + recipe audit over every family config.
    for (const { name, options, models } of KREA2_MATRIX) {
      const graph = buildKrea2Graph(options, models)
      assert.equal(canon(graph), canon(goldenByName[name]), `krea2 golden drift for config '${name}' — regenerate with --update-golden and review the diff`)
      checks += 1
      const violations = krea2RecipeAudit(graph)
      // Cross-realm deepEqual is unreliable in this harness; length + join is exact.
      ok(violations.length === 0, `krea2 recipe audit must pass for '${name}' (got: ${violations.join('; ')})`)
      checks += 1
    }

    // (f4) Research-pinned defaults — the recipes are data, and this is the
    // pin: change a value here only with a research-doc change.
    {
      const pins = KREA2_RECIPE_PINS
      const byId = {}
      for (const family of KREA2_EDIT_FAMILIES) byId[family.id] = family
      ok(pins.turbo.steps === 8 && pins.turbo.cfg === 1.0 && pins.turbo.sampler === 'euler' && pins.turbo.scheduler === 'simple' && pins.turbo.denoise === 1 && pins.turbo.loraStrength === 1.0, 'Turbo pin: 8 steps / CFG 1.0 / euler+simple / denoise 1 / LoRA 1.0')
      ok(pins.removal.steps === 20 && pins.removal.cfg === 3.0 && pins.removal.sampler === 'euler' && pins.removal.scheduler === 'simple', 'Removal pin: RAW / 20 steps / CFG 3.0')
      ok(pins.groundingPx.default === 768 && pins.groundingPx.min === 384 && pins.groundingPx.max === 768, 'grounding_px pin: default 768, trained band 384–768')
      ok(pins.refBoost.default === 1.0 && pins.refBoost.max === 10 && pins.refBoost.uiCap === 6 && pins.refBoost.removalBreakAbove === 10, 'ref_boost pin: default 1.0, >10 breaks removals (UI cap 6)')
      ok(pins.fitMode.default === 'fit' && pins.fitMode.legacy === 'crop (legacy)', 'fit geometry pin: fit default, crop (legacy) for older weights')
      ok(pins.megapixels.instructMax === 2.0 && pins.megapixels.twoRefMax === 1.5, 'megapixel pins: <=2MP instruct, 1–1.5MP two-ref')
      ok(pins.turboStepsBand.min === 8 && pins.turboStepsBand.max === 12, 'Turbo identity step band: 8–12')
      ok(pins.canvasMultiple === 16, 'canvas multiple pin: 16')
      ok(pins.anypaint.steps === 8 && pins.anypaint.cfg === 1.0 && pins.anypaint.referenceMaxEdge === 384 && pins.anypaint.boundaryRedrawPx === 32 && pins.anypaint.vlmReference === true && pins.anypaint.kvCache === true && pins.anypaint.loraStrength === 1.0, 'AnyPaint pin: Turbo 8 / CFG 1.0 (ComfyUI form of the card\'s guidance 0) / 384px ref / 32px band / VLM + K/V on / LoRA 1.0')
      ok(byId['krea2edit.instruct'].recipe.steps === 8 && byId['krea2edit.instruct'].recipe.cfg === 1.0, 'instruct family ships the Turbo pin')
      ok(byId['krea2edit.removal'].recipe.steps === 20 && byId['krea2edit.removal'].recipe.cfg === 3.0 && byId['krea2edit.removal'].checkpoint === 'raw', 'removal family ships the RAW pin')
      ok(byId['krea2edit.refine'].recipe.steps === 8 && byId['krea2edit.refine'].recipe.cfg === 1.0, 'refine family ships the AnyPaint pin')
      ok(byId['krea2edit.outpaint'].checkpoint === 'turbo' && byId['krea2edit.two-ref'].checkpoint === 'turbo', 'refine/outpaint/two-ref ride the resident Turbo checkpoint')
      ok(krea2LoraKindOfFilename('krea2_identity_edit_v1_2_r128.safetensors') === 'identity-edit' && krea2LoraKindOfFilename('krea2_anypaint_rank32.safetensors') === 'anypaint' && krea2LoraKindOfFilename('minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors') === undefined, 'LoRA classification separates the two edit kinds from everything else')
    }

    // (f5) Transform correctness — hand-asserted wiring per family.
    {
      const instruct = buildKrea2Graph(matrixByName['instruct-default'].options, KREA2_MODELS)
      ok(instruct['1'].inputs.unet_name === 'krea2_turbo_int8_convrot.safetensors', 'instruct rides the Turbo checkpoint')
      ok(instruct['30'].class_type === 'LoadImage' && instruct['30'].inputs.image === 'source.png', 'source image loader wired')
      ok(instruct['32'].class_type === 'VAEEncode' && instruct['32'].inputs.pixels.join('|') === '30|0' && instruct['32'].inputs.vae.join('|') === '3|0', 'source VAE-encodes for the in-context latent path')
      ok(instruct['10'].class_type === 'LoraLoaderModelOnly' && instruct['10'].inputs.lora_name === 'krea2_identity_edit_v1_2.safetensors' && instruct['10'].inputs.strength_model === 1, 'Identity Edit LoRA @1.0 wraps the checkpoint')
      ok(instruct['10'].inputs.model.join('|') === '1|0' && instruct['11'].inputs.model.join('|') === '10|0', 'model chain: UNet → LoRA → edit patch')
      ok(instruct['11'].class_type === 'Krea2EditModelPatch', 'the in-context transport patch is inserted')
      ok(instruct['11'].inputs.source_latent.join('|') === '32|0' && instruct['11'].inputs.source_image.join('|') === '30|0' && instruct['11'].inputs.vae.join('|') === '3|0', 'dual conditioning transport: latent + pixel path + vae')
      ok(instruct['11'].inputs.target_latent.join('|') === '6|0', 'target_latent pre-encode wired to the sampler latent (the VRAM-order fix)')
      ok(instruct['11'].inputs.fit_mode === 'fit' && instruct['11'].inputs.ref_boost === 1, 'fit geometry + ref_boost 1.0 defaults')
      ok(instruct['34'].class_type === 'Krea2EditGroundedEncode' && instruct['34'].inputs.image.join('|') === '30|0' && instruct['34'].inputs.grounding_px === 768, 'grounded TE encode sees the source at grounding_px 768')
      ok(instruct['7'].inputs.positive.join('|') === '34|0', 'sampler consumes the grounded positive')
      ok(instruct['5'].class_type === 'CLIPTextEncode' && instruct['5'].inputs.text === '' && instruct['7'].inputs.negative.join('|') === '5|0', 'at CFG 1 the negative is the stock empty encode (grounding is a CFG>1 requirement)')
      ok(instruct['7'].inputs.model.join('|') === '11|0' && instruct['7'].inputs.steps === 8 && instruct['7'].inputs.cfg === 1 && instruct['7'].inputs.sampler_name === 'euler' && instruct['7'].inputs.scheduler === 'simple' && instruct['7'].inputs.denoise === 1, 'instruct sampler: patched model, Turbo operating point')
      ok(instruct['6'].inputs.width === 1024 && instruct['6'].inputs.height === 1024 && instruct['6'].inputs.batch_size === 1, 'empty canvas at the requested size')
      const dials = buildKrea2Graph(matrixByName['instruct-dials'].options, KREA2_MODELS)
      ok(dials['34'].inputs.grounding_px === 512 && dials['11'].inputs.ref_boost === 4 && dials['7'].inputs.steps === 12, 'grounding_px / ref_boost / steps dials reach their nodes')
      const cfg2 = buildKrea2Graph(matrixByName['instruct-cfg2-grounded-negative'].options, KREA2_MODELS)
      ok(cfg2['35'].class_type === 'Krea2EditGroundedEncode' && cfg2['35'].inputs.prompt === '' && cfg2['35'].inputs.image.join('|') === '30|0' && cfg2['35'].inputs.grounding_px === 768, 'CFG>1 grounds the negative: empty prompt + the SAME image (the trained unconditional)')
      ok(cfg2['7'].inputs.negative.join('|') === '35|0' && cfg2['7'].inputs.cfg === 2, 'sampler consumes the grounded negative at the raised CFG')
      const legacy = buildKrea2Graph(matrixByName['instruct-fit-legacy'].options, KREA2_MODELS)
      ok(legacy['11'].inputs.fit_mode === 'crop (legacy)', 'fit geometry dial passes the node\'s literal enum through')

      const removal = buildKrea2Graph(matrixByName['removal-raw-cfg3'].options, KREA2_MODELS)
      ok(removal['1'].inputs.unet_name === 'krea2_raw_int8_convrot.safetensors', 'removal swaps to the RAW checkpoint')
      ok(removal['7'].inputs.steps === 20 && removal['7'].inputs.cfg === 3, 'removal recipe: 20 steps / CFG 3.0')
      ok(removal['35'].class_type === 'Krea2EditGroundedEncode' && removal['7'].inputs.negative.join('|') === '35|0', 'CFG 3 structurally grounds the negative')

      const twoRef = buildKrea2Graph(matrixByName['two-ref-person-into-scene'].options, KREA2_MODELS)
      ok(twoRef['31'].class_type === 'LoadImage' && twoRef['31'].inputs.image === 'person.png', 'the person loads as image 2')
      ok(twoRef['11'].inputs.source_latent_b.join('|') === '33|0' && twoRef['11'].inputs.source_image_b.join('|') === '31|0' && twoRef['11'].inputs.ref_boost_a === 1.5, 'person rides the _b inputs (RoPE frame 2) with the scene-side dial')
      ok(twoRef['34'].inputs.image_b.join('|') === '31|0', 'grounded encode sees both references in training order (scene, person)')
      ok(twoRef['11'].inputs.source_latent.join('|') === '32|0' && twoRef['34'].inputs.image.join('|') === '30|0', 'the SCENE stays on the image-1 inputs — fixed order')

      const refine = buildKrea2Graph(matrixByName['refine-masked-default'].options, KREA2_MODELS)
      ok(refine['40'].class_type === 'LoadImage' && refine['41'].class_type === 'Krea2AnyPaintPrepare', 'AnyPaint prepare wired')
      ok(refine['41'].inputs.left === 0 && refine['41'].inputs.top === 0 && refine['41'].inputs.right === 0 && refine['41'].inputs.bottom === 0, 'refine is zero-padding inpainting')
      ok(refine['41'].inputs.reference_max_edge === 384 && refine['41'].inputs.boundary_redraw_px === 32, '384px semantic reference + 32px boundary band pinned')
      ok(refine['41'].inputs.generated_mask.join('|') === '40|1', 'the Mask-Editor mask rides the LoadImage MASK output (white=generate)')
      ok(refine['42'].class_type === 'Krea2AnyPaintEncode' && refine['42'].inputs.semantic_reference.join('|') === '41|0' && refine['42'].inputs.known_image.join('|') === '41|1' && refine['42'].inputs.keep_mask.join('|') === '41|3', 'encode consumes the prepared canvas trio')
      ok(refine['42'].inputs.vlm_reference === true, 'VLM reference on')
      ok(refine['10'].inputs.lora_name === 'krea2_anypaint_rank32.safetensors' && refine['10'].inputs.strength_model === 1, 'AnyPaint LoRA @1.0')
      ok(refine['43'].class_type === 'Krea2AnyPaintModelPatch' && refine['43'].inputs.kv_cache === true && refine['43'].inputs.model.join('|') === '10|0', 'model patch after the LoRA with the K/V cache on')
      ok(refine['7'].inputs.latent_image.join('|') === '42|1' && refine['7'].inputs.positive.join('|') === '42|0' && refine['7'].inputs.model.join('|') === '43|0', 'sampler: encode latent (known image + token-aligned noise mask), encode conditioning, patched model')
      ok(refine['6'] === undefined, 'no empty-canvas node — the AnyPaint encode owns the latent')
      ok(refine['9'].inputs.images.join('|') === '8|0', 'raw decode saved directly: ZERO post-hoc composite')

      const outpaint = buildKrea2Graph(matrixByName['outpaint-padding-default'].options, KREA2_MODELS)
      ok(outpaint['41'].inputs.left === 256 && outpaint['41'].inputs.top === 256 && outpaint['41'].inputs.right === 256 && outpaint['41'].inputs.bottom === 256, 'outpaint default: symmetric 256px padding (16px grid)')
      ok(outpaint['41'].inputs.generated_mask === undefined, 'padding-only outpaint wires no mask')
      const mixed = buildKrea2Graph(matrixByName['outpaint-mixed-mask-right512'].options, KREA2_MODELS)
      ok(mixed['41'].inputs.right === 512 && mixed['41'].inputs.generated_mask.join('|') === '40|1', 'mask + padding in one request is the mixed form')
    }

    // (f6) Recipe audit — the correctness rules fire on adversarial graphs.
    {
      const instruct = buildKrea2Graph(matrixByName['instruct-default'].options, KREA2_MODELS)
      const withT0 = { ...instruct, '50': { class_type: 'Edit Model Reference Method', inputs: { method: 'index_timestep_zero' } } }
      ok(krea2RecipeAudit(withT0).some((violation) => violation.includes('t=0 carrier')), 'the audit catches the identity LoRA on the t=0 carrier (Kreatine 8.18→50.06; replicated 5.30→40.06 on our int8 stack)')
      const withDanglingRef = { ...instruct, '51': { class_type: 'ReferenceLatent', inputs: {} } }
      ok(krea2RecipeAudit(withDanglingRef).some((violation) => violation.includes('silently dropped')), 'the audit catches ReferenceLatent without its method node (the silent no-op footgun)')
      // The E-K1 index-pairing rule (Flux 7ed5ewa): a ReferenceLatent carrier
      // with the identity LoRA must pin the method to 'index' — measured
      // meanAD 5.30 (index) vs 40.06 (index_timestep_zero) through core nodes
      // on our int8 runtime. The adversarial fixture proves the rule fires;
      // the on-recipe carrier proves it stays quiet.
      const withCarrierT0 = { ...instruct, '51': { class_type: 'ReferenceLatent', inputs: {} }, '50': { class_type: 'Edit Model Reference Method', inputs: { method: 'index_timestep_zero' } } }
      ok(krea2RecipeAudit(withCarrierT0).some((violation) => violation.includes("method 'index'")), 'the E-K1 pairing rule fires: ReferenceLatent + identity LoRA demands Edit Model Reference Method index (measured 5.30 vs 40.06)')
      const withCarrierIndex = { ...instruct, '51': { class_type: 'ReferenceLatent', inputs: {} }, '50': { class_type: 'Edit Model Reference Method', inputs: { method: 'index' } } }
      ok(krea2RecipeAudit(withCarrierIndex).length === 0, 'the on-recipe core carrier (ReferenceLatent + method index) audits clean')
      const wrongLora = buildKrea2Graph(matrixByName['instruct-default'].options, { ...KREA2_MODELS, identityEditLora: 'krea2_anypaint_rank32.safetensors' })
      ok(krea2RecipeAudit(wrongLora).length >= 2, 'the audit rejects a mismatched encode/transport/LoRA triple')
      const withComposite = { ...instruct, '52': { class_type: 'ImageCompositeMasked', inputs: {} } }
      ok(krea2RecipeAudit(withComposite).some((violation) => violation.includes('composite')), 'the audit rejects any post-hoc composite node')
      const withBothPatchers = { ...instruct, '53': { class_type: 'Krea2AnyPaintModelPatch', inputs: { model: ['11', 0], kv_cache: true } } }
      ok(krea2RecipeAudit(withBothPatchers).some((violation) => violation.includes('do not compose')), 'the audit rejects stacked whole-pipeline patchers (the D3 lesson)')
      const loraless = { ...instruct }
      delete loraless['10']
      ok(krea2RecipeAudit(loraless).some((violation) => violation.includes('triple must match')), 'edit transport without its trained LoRA fails the triple check')
    }

    // (f7) Dial validation — the research limits enforced at the boundary.
    {
      const request = (extra) => ({ family: 'krea2edit.instruct', prompt: 'p', source: 's.png', width: 1024, height: 1024, seed: 1, filenamePrefix: 't', ...extra })
      const throwsWith = (fn, needle, label) => {
        // VM-realm Errors do not satisfy host instanceof; match on the message.
        assert.throws(fn, (error) => Boolean(error) && typeof error.message === 'string' && error.message.includes(needle), label)
        checks += 1
      }
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ groundingPx: 383 }) }, KREA2_MODELS), 'trained', 'grounding_px below the 384 band floor is rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ groundingPx: 769 }) }, KREA2_MODELS), 'trained', 'grounding_px above the 768 band ceiling is rejected (duplication territory)')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ groundingPx: 640.5 }) }, KREA2_MODELS), 'integer', 'grounding_px must be an integer')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ refBoost: 0 }) }, KREA2_MODELS), 'refBoost', 'ref_boost 0 is rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ refBoost: 10.5 }) }, KREA2_MODELS), 'breaks removals', 'ref_boost above 10 is rejected — the documented break boundary')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ refBoost: 11 }) }, KREA2_MODELS), 'ref_boost', 'ref_boost 11 is rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ width: 2048, height: 1152 }) }, KREA2_MODELS), '2MP', 'instruct above 2MP is rejected (source bleed / duplication)')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ steps: 7 }) }, KREA2_MODELS), 'band', 'steps below the 8–12 band are rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ steps: 13 }) }, KREA2_MODELS), 'band', 'steps above the 8–12 band are rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ fitMode: 'crop' }) }, KREA2_MODELS), 'fitMode', "fit_mode must use the node's literal enum ('crop (legacy)')")
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ cfg: 0 }) }, KREA2_MODELS), 'cfg', 'cfg 0 is rejected (guidance-0 is CFG 1.0 in ComfyUI terms)')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ width: 1000 }) }, KREA2_MODELS), 'multiples of 16', 'canvas dims must be multiples of 16')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ family: 'krea2edit.removal', steps: 20 }) }, KREA2_MODELS), 'pins 20 steps', 'removal rejects step overrides (the recipe IS the variant)')
      const twoRefRequest = (extra) => ({ family: 'krea2edit.two-ref', prompt: 'p', source: 'scene.png', subject: 'person.png', width: 1216, height: 832, seed: 1, filenamePrefix: 't', ...extra })
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: twoRefRequest({ width: 1536, height: 1024 }) }, KREA2_MODELS), 'blend', 'two-ref above 1.5MP is rejected (identities drift together)')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: { ...twoRefRequest(), subject: undefined } }, KREA2_MODELS), 'subject', 'two-ref without the person reference is rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: twoRefRequest({ refBoostA: 12 }) }, KREA2_MODELS), 'refBoostA', 'ref_boost_a obeys the same cap')
      const refineRequest = (extra) => ({ family: 'krea2edit.refine', prompt: 'p', source: 'masked.png', width: 1024, height: 1024, seed: 1, filenamePrefix: 't', ...extra })
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: refineRequest({ mask: false }) }, KREA2_MODELS), 'mask', 'refine without a mask routes to outpaint')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: refineRequest({ padding: { right: 128 } }) }, KREA2_MODELS), 'zero-padding', 'refine rejects padding (mixed belongs to outpaint)')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: refineRequest({ steps: 12 }) }, KREA2_MODELS), 'Turbo-locked', 'AnyPaint rejects sampler overrides')
      const outpaintRequest = (extra) => ({ family: 'krea2edit.outpaint', prompt: 'p', source: 's.png', width: 1024, height: 1024, seed: 1, filenamePrefix: 't', ...extra })
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: outpaintRequest({ padding: { left: 0, top: 0, right: 0, bottom: 0 } }) }, KREA2_MODELS), 'at least one side', 'outpaint with zero padding everywhere is rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: outpaintRequest({ padding: { right: 100 } }) }, KREA2_MODELS), 'multiple of 16', 'padding moves on the 16px grid')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: outpaintRequest({ padding: { right: -16 } }) }, KREA2_MODELS), 'integer in 0', 'negative padding is rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ family: 'krea2edit.nope' }) }, KREA2_MODELS), 'unknown', 'unknown families are rejected')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request({ family: 'krea2edit.removal' }) }, { ...KREA2_MODELS, raw: '' }), 'cannot build', 'an unresolved RAW checkpoint refuses to build — never a silent empty filename')
      throwsWith(() => buildKrea2Graph({ ...KREA2_BASE, edit: request() }, { ...KREA2_MODELS, identityEditLora: '' }), 'cannot build', 'an unresolved edit LoRA refuses to build')
      throwsWith(() => buildKrea2T2iGraph(KREA2_BASE, { turbo: '', textEncoder: KREA2_MODELS.textEncoder, vae: KREA2_MODELS.vae }), 'missing required files', 'the base builder refuses unresolved files too')
      // And the boundary values that must PASS.
      buildKrea2Graph({ ...KREA2_BASE, edit: request({ groundingPx: 384 }) }, KREA2_MODELS)
      buildKrea2Graph({ ...KREA2_BASE, edit: request({ groundingPx: 768 }) }, KREA2_MODELS)
      buildKrea2Graph({ ...KREA2_BASE, edit: request({ refBoost: 10, steps: 12 }) }, KREA2_MODELS)
      checks += 3
    }

    // (f8) Availability gating per family.
    {
      const detected = detectKrea2EditFamilies(KREA2_FULL_INFO, KREA2_FULL_SCAN)
      const byFamilyId = {}
      for (const { family, detection } of detected) byFamilyId[family.id] = detection
      ok(detected.length === 5, 'five families detected')
      for (const family of KREA2_EDIT_FAMILIES) {
        ok(byFamilyId[family.id].available === true, `${family.id} available on a full stack`)
        ok(byFamilyId[family.id].missingNodes.length === 0 && byFamilyId[family.id].missingModels.length === 0, `${family.id} reports nothing missing on a full stack`)
      }
      ok(byFamilyId['krea2edit.removal'].resolved.diffusion === 'krea2_raw_int8_convrot.safetensors', 'removal resolves the RAW checkpoint')
      ok(byFamilyId['krea2edit.instruct'].resolved.diffusion === 'krea2_turbo_int8_convrot.safetensors', 'instruct resolves the Turbo checkpoint')
      ok(byFamilyId['krea2edit.instruct'].resolved.lora === 'krea2_identity_edit_v1_2.safetensors', 'the full Identity Edit LoRA wins over the reduced cuts')
      ok(byFamilyId['krea2edit.refine'].resolved.lora === 'krea2_anypaint_rank32.safetensors', 'refine resolves the AnyPaint LoRA')

      const bare = detectKrea2EditFamilies(KREA2_BARE_INFO, KREA2_FULL_SCAN)
      const bareById = {}
      for (const { family, detection } of bare) bareById[family.id] = detection
      ok(Object.values(bareById).every((detection) => detection.available === false), 'a bare engine gates every family off')
      ok(bareById['krea2edit.instruct'].missingNodes.join() === 'Krea2EditModelPatch,Krea2EditGroundedEncode', 'identity families name their missing pack nodes')
      ok(bareById['krea2edit.refine'].missingNodes.length === 3, 'AnyPaint families name all three missing nodes')

      const noRaw = KREA2_FULL_SCAN.filter((file) => !file.name.startsWith('krea2_raw'))
      const gated = {}
      for (const { family, detection } of detectKrea2EditFamilies(KREA2_FULL_INFO, noRaw)) gated[family.id] = detection
      ok(gated['krea2edit.removal'].available === false && gated['krea2edit.removal'].missingModels.some((label) => label.includes('RAW')), 'removal is gated on the RAW checkpoint with guidance')
      ok(gated['krea2edit.instruct'].available === true, 'the removal gate does not leak into instruct')

      const reducedOnly = resolveKrea2EditModels([
        ...KREA2_FULL_SCAN.filter((file) => !file.name.startsWith('krea2_identity')),
        krea2File('loras', 'krea2_identity_edit_v1_2_r128.safetensors'),
        krea2File('loras', 'krea2_identity_edit_v1_2_r64.safetensors'),
      ])
      ok(reducedOnly.identityEditLora === 'krea2_identity_edit_v1_2_r128.safetensors', 'low-VRAM fallback order: r128 preferred over r64')
      const r64Only = resolveKrea2EditModels([...KREA2_FULL_SCAN.filter((file) => !file.name.startsWith('krea2_identity')), krea2File('loras', 'krea2_identity_edit_v1_2_r64.safetensors')])
      ok(r64Only.identityEditLora === 'krea2_identity_edit_v1_2_r64.safetensors', 'r64 resolves when it is the only cut present')
      ok(resolveKrea2EditModels([...KREA2_FULL_SCAN, krea2File('diffusion_models', 'krea2_turbo_nvfp4_awq.safetensors')]).turbo === 'krea2_turbo_int8_convrot.safetensors', 'excluded quants (NVFP4/MXFP8) never resolve')
      ok(resolveKrea2EditModels([...KREA2_FULL_SCAN.filter((file) => file.name !== 'krea2_turbo_int8_convrot.safetensors'), krea2File('diffusion_models', 'krea2_turbo_fp8_scaled.safetensors')]).turbo === 'krea2_turbo_fp8_scaled.safetensors', 'fp8_scaled is the second choice when int8-convrot is absent')

      const wrongTe = detectKrea2EditFamilies(KREA2_FULL_INFO, [
        ...KREA2_FULL_SCAN.filter((file) => file.kind !== 'text_encoders'),
        krea2File('text_encoders', 'qwen_3_06b_base.safetensors'),
      ])
      const wrongTeById = {}
      for (const { family, detection } of wrongTe) wrongTeById[family.id] = detection
      ok(wrongTeById['krea2edit.instruct'].available === false && wrongTeById['krea2edit.instruct'].missingModels.some((label) => label.includes('vision tower')), 'a text-only TE gates edit modes off with vision-tower guidance (the obscure-failure gate)')

      const noLoras = detectKrea2EditFamilies(KREA2_FULL_INFO, KREA2_FULL_SCAN.filter((file) => file.kind !== 'loras'))
      const noLorasById = {}
      for (const { family, detection } of noLoras) noLorasById[family.id] = detection
      ok(Object.values(noLorasById).every((detection) => detection.available === false), 'no LoRAs → every edit mode gated with install guidance')
      ok(noLorasById['krea2edit.refine'].missingModels.some((label) => label.includes('AnyPaint')), 'the AnyPaint guidance names its LoRA')
      const instructFamily = findKrea2EditFamily('krea2edit.instruct')
      ok(instructFamily !== undefined && instructFamily.detect(KREA2_FULL_INFO, KREA2_FULL_SCAN).available, 'findKrea2EditFamily resolves for direct calls')
    }
  }

  // ---- (g) LTX-2.3 one-graph utilities ------------------------------------
  {
    const ltx23Fixture = JSON.parse(fs.readFileSync(LTX23_FIXTURE, 'utf8'))
    ok(ltx23Fixture.entries.length === LTX23_MATRIX.length, 'ltx23 golden fixture covers the whole matrix — regenerate with --update-golden if the matrix changed')
    const ltx23GoldenByName = {}
    for (const { name, graph } of ltx23Fixture.entries) ltx23GoldenByName[name] = graph

    // (g1) Registry shape: six tools, unique ids, guidance, and zero leakage
    // into the H3 optimization registry.
    ok(LTX23_UTILITIES.length === 6, 'six LTX-2.3 utilities ship (remove-subtitles, remove-watermark, restore-archival, remove-object, outpaint, ia2v)')
    const utilityIds = LTX23_UTILITIES.map((utility) => utility.id)
    ok(new Set(utilityIds).size === utilityIds.length, 'utility ids are unique')
    for (const utility of LTX23_UTILITIES) {
      ok(typeof utility.detect === 'function', `${utility.id} has detect`)
      ok(utility.ui.description.length > 0 && (utility.ui.installHint ?? '').length > 0, `${utility.id} carries description + install guidance`)
      ok(utility.ui.input.length > 0, `${utility.id} declares its input surface`)
    }
    ok(!optimizationEntries().some((entry) => entry.id.startsWith('ltx23.')), 'LTX-2.3 utilities live in their own registry — the H3 optimization list is untouched')
    const ia2v = findLtx23Utility('ltx23.ia2v')
    ok(ia2v && ia2v.packNodes.length === 0, 'ia2v needs ZERO node packs (the all-core native workflow)')
    ok(findLtx23Utility('ltx23.remove-subtitles').packNodes.includes('LTXICLoRALoaderModelOnly') && findLtx23Utility('ltx23.remove-subtitles').packNodes.includes('GetImageSizeAndCount'), 'the remove family gates on the LTXVideo + KJNodes packs')
    ok(findLtx23Utility('ltx23.outpaint').packNodes.includes('Float32ColorCorrect'), 'outpaint gates on radiance (the load-bearing color-correct node)')

    // (g2) Golden equality + topology audit + template census over every
    // matrix config.
    for (const { name, request, models } of LTX23_MATRIX) {
      const { graph, violations } = buildLtx23UtilityGraphWithAudit(request, models)
      assert.equal(canon(graph), canon(ltx23GoldenByName[name]), `ltx23 golden drift for config '${name}' — regenerate with --update-golden and review the diff`)
      checks += 1
      ok(violations.length === 0, `ltx23 topology audit must pass for '${name}' (got: ${violations.join('; ')})`)
      checks += 1
      const censusKind = request.tool === 'remove-subtitles' || request.tool === 'remove-watermark' || request.tool === 'restore-archival' ? 'remove' : request.tool === 'remove-object' ? 'obscura' : request.tool
      const expected = LTX23_EXPECTED_CENSUS[censusKind].census
      const built = {}
      for (const node of Object.values(graph)) built[node.class_type] = (built[node.class_type] ?? 0) + 1
      const expectedKeys = Object.keys(expected).sort()
      const builtKeys = Object.keys(built).sort()
      assert.equal(builtKeys.join(','), expectedKeys.join(','), `ltx23 census class drift for '${name}' (${LTX23_EXPECTED_CENSUS[censusKind].source}; deltas: ${LTX23_EXPECTED_CENSUS[censusKind].deltas})`)
      for (const key of expectedKeys) assert.equal(built[key], expected[key], `ltx23 census count drift for ${key} in '${name}'`)
      checks += 2
    }

    // (g3) Template-pinned values — the official templates are data, and
    // this is the pin: change a value here only with a template change.
    {
      const pins = LTX23_PINS
      ok(pins.firstStageSigmas === '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0', 'stage-1 sigma ladder pinned to the official LTX-2.3 dev schedule')
      ok(pins.removeRefinerSigmas === '0.909375, 0.725, 0.421875, 0.0', 'remove-family refine ladder pinned')
      ok(pins.ia2vRefinerSigmas === '0.85, 0.7250, 0.4219, 0.0', 'ia2v refine ladder pinned')
      ok(pins.frameCountExpression === '(int((a - 1) / 8)) * 8 + 1', 'latent-safe frame-count expression pinned')
      ok(pins.guide.frameIdx === 0 && pins.guide.strength === 1 && pins.guide.latentDownscaleFactor === 1 && pins.guide.crop === 'disabled', 'IC-LoRA guide attach pins: frame 0 / strength 1 / downscale 1 / crop disabled')
      ok(pins.remove.cfg === 1 && pins.remove.sampler === 'euler' && pins.remove.stage2NoiseSeed === 29, 'remove family pin: CFG 1 / euler / fixed stage-2 noise 29')
      ok(pins.obscura.steps === 8 && pins.obscura.cfg === 1 && pins.obscura.sampler === 'euler_ancestral_cfg_pp' && pins.obscura.scheduler === 'linear_quadratic' && pins.obscura.obscuraStrength === 2.0 && pins.obscura.distilledStrength === 0.4 && pins.obscura.fps === 25, 'Obscura pin: 8 steps / CFG 1 / euler_ancestral_cfg_pp+linear_quadratic / obscura@2.0 wrapping distilled@0.4 / 25 fps')
      ok(pins.outpaint.cfg === 1 && pins.outpaint.sampler === 'euler_ancestral' && pins.outpaint.distilledStrength === 0.5 && pins.outpaint.outpaintStrength === 1.0 && pins.outpaint.guideGamma === 2, 'outpaint pin: CFG 1 / euler_ancestral / distilled@0.5 + outpaint@1.0 / gamma-2 guide')
      ok(pins.ia2v.cfg === 1 && pins.ia2v.distilledStrength === 0.5 && pins.ia2v.stage1ImageStrength === 0.7 && pins.ia2v.stage2ImageStrength === 1 && pins.ia2v.stage2NoiseSeed === 42, 'ia2v pin: CFG 1 / distilled@0.5 / image anchors 0.7→1.0 / fixed stage-2 noise 42')
      ok(LTX23_PROMPTS.subtitles.startsWith('Remove subtitles, captions') && LTX23_PROMPTS.watermark.startsWith('Remove short-video platform watermarks') && LTX23_PROMPTS.archival.startsWith('A modern, high-resolution'), 'per-tool default prompts pinned verbatim from the templates')
      ok(LTX23_PROMPTS.obscura === 'Remove the {object} from the foreground.', 'Obscura prompt form pinned')
    }

    // (g4) Hand-asserted load-bearing wiring per family (template node ids).
    {
      const remove = buildLtx23UtilityGraph(LTX23_MATRIX[0].request, LTX23_MATRIX[0].models)
      ok(remove['5085'].inputs.ckpt_name === 'ltx-2.3-22b-dev.safetensors' && remove['5084'].inputs.text_encoder === 'gemma_3_12B_it.safetensors', 'remove family loads the template-exact checkpoint + Gemma encoder')
      ok(remove['5087'].inputs.lora_name === 'ltx2.3-ic-subtitles-remove-general.safetensors' && remove['5087'].inputs.strength_model === 1.2, 'subtitles IC-LoRA @1.2 (the template pin)')
      ok(remove['5064'].inputs.sigmas === LTX23_PINS.firstStageSigmas && remove['5075'].inputs.sigmas === LTX23_PINS.removeRefinerSigmas, 'the two ManualSigmas ladders carry the pinned schedules')
      ok(remove['5069'].inputs.samples.join('|') === '5082|2' && remove['5069'].inputs.upscale_model.join('|') === '5059|0', 'stage 2 upsamples the CROPPED stage-1 latent with the x2-1.1 model')
      ok(remove['5071'].inputs.image.join('|') === '5068|0' && remove['5094'].inputs.image.join('|') === '5089|0', 'each stage guides with its own resolution-matched resize (half then full)')
      ok(remove['5098'].inputs.audio_latent.join('|') === '5083|0' && remove['5099'].inputs.audio_latent.join('|') === '5070|1', 'audio reference tokens re-bind per stage (source audio, then stage-1 output audio)')
      ok(remove['5062'].inputs.audio.join('|') === '5088|1' && remove['5062'].inputs.fps.join('|') === '5088|2', 'the mux carries the ORIGINAL audio + source fps (audio never regenerates in this family)')
      ok(remove['5090'].inputs.latents.join('|') === '5074|2', 'the decode reads the guide-cropped latent only')
      ok(remove['5058'].inputs.noise_seed === 424242 && remove['5078'].inputs.noise_seed === 29, 'stage-1 seed is the caller\'s, stage-2 noise is the template\'s fixed 29')
      const watermark = buildLtx23UtilityGraph(LTX23_MATRIX[2].request, LTX23_MATRIX[2].models)
      ok(watermark['5087'].inputs.lora_name === 'ltx2.3-ic-watermark-remove-general.safetensors' && watermark['5087'].inputs.strength_model === 1.5, 'watermark IC-LoRA @1.5 — the ONLY delta from the subtitles template')
      const archival = buildLtx23UtilityGraph(LTX23_MATRIX[3].request, LTX23_MATRIX[3].models)
      ok(archival['5087'].inputs.lora_name === 'ltx-2.3-dearchive-lora_weights_step_05000.safetensors' && archival['5087'].inputs.strength_model === 1, 'dearchive IC-LoRA @1.0')
      ok(archival['5091'].inputs.text === LTX23_PROMPTS.archival, 'archival prompt defaults to the template\'s restoration target text')

      const obscura = buildLtx23UtilityGraph(LTX23_MATRIX[4].request, LTX23_MATRIX[4].models)
      ok(obscura['15'].inputs.lora_name === 'ltx23-obscura_remova.safetensors' && obscura['15'].inputs.strength_model === 2 && obscura['15'].inputs.model.join('|') === '5|0', 'obscura @2.0 wraps the transformer')
      ok(obscura['14'].inputs.lora_name === 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors' && obscura['14'].inputs.strength_model === 0.4 && obscura['19'].inputs.model.join('|') === '14|0', 'distilled-384-1.1 @0.4 wraps obscura; KSampler samples the composed chain (template order)')
      ok(obscura['19'].inputs.sampler_name === 'euler_ancestral_cfg_pp' && obscura['19'].inputs.scheduler === 'linear_quadratic' && obscura['19'].inputs.steps === 8 && obscura['19'].inputs.cfg === 1, 'the single-pass KSampler pin')
      ok(obscura['4'].inputs.clip_name1 === 'gemma_3_12B_it_fp4_mixed.safetensors' && obscura['4'].inputs.clip_name2 === 'ltx-2.3_text_projection_bf16.safetensors' && obscura['4'].inputs.type === 'ltxv', 'the split DualCLIPLoader (Gemma fp4 + projection, ltxv type)')
      ok(obscura['36'].inputs.audio.join('|') === '13|0', 'obscura muxes the REGENERATED audio (the decoded sampled latent)')

      const outpaint = buildLtx23UtilityGraph(LTX23_MATRIX[6].request, LTX23_MATRIX[6].models)
      ok(outpaint['5146'].inputs.lora_name === 'ltx-2.3-22b-ic-lora-outpaint.safetensors' && outpaint['5134'].inputs.lora_name === 'ltx-2.3-22b-distilled-lora-384.safetensors' && outpaint['5134'].inputs.strength_model === 0.5, 'outpaint IC-LoRA @1.0 over distilled-384 @0.5 (template pins)')
      ok(outpaint['5144'].inputs.gamma === 2 && outpaint['5144'].inputs.image.join('|') === '5130|0' && outpaint['5142'].inputs.image.join('|') === '5144|0', 'the padded guide is gamma-2 corrected before the IC-LoRA attach (radiance, load-bearing)')
      ok(outpaint['5139'].inputs.target_width.join('|') === '5149|1' && outpaint['5139'].inputs.target_height.join('|') === '5150|1', 'the aspect pad consumes the max()-derived target canvas')
      ok(outpaint['5129'].inputs['resize_type.multiplier'] === 0.5 && outpaint['5130'].inputs['resize_type.multiple'] === 32, 'the half-res + multiple-of-32 grid pipeline')
      ok(outpaint['5159'].inputs.audio.join('|') === '5157|1', 'outpaint muxes the ORIGINAL audio')
      const outpaintSquare = buildLtx23UtilityGraph(LTX23_MATRIX[7].request, LTX23_MATRIX[7].models)
      ok(outpaintSquare['5148'].inputs['values.a'] === 1 && outpaintSquare['5148'].inputs['values.b'] === 1 && outpaintSquare['5138'].inputs.text.includes('sunlit meadow'), 'the square aspect + prompt override flow through')

      const ia2vGraph = buildLtx23UtilityGraph(LTX23_MATRIX[8].request, LTX23_MATRIX[8].models)
      ok(ia2vGraph['325'].inputs.strength === 0.7 && ia2vGraph['296'].inputs.strength === 1, 'image anchors: 0.7 stage 1, 1.0 for the refine')
      ok(ia2vGraph['333'].inputs.value === 0 && ia2vGraph['327'].inputs.mask.join('|') === '333|0', 'the audio latent is fully noised (SolidMask 0) before joint AV sampling')
      ok(ia2vGraph['332'].inputs.duration === 9 && ia2vGraph['329'].inputs['values.a'] === 9 && ia2vGraph['329'].inputs['values.b'] === 24, 'trim duration + a*b+1 frame count at 24 fps')
      ok(ia2vGraph['285'].inputs.noise_seed === 42 && ia2vGraph['286'].inputs.noise_seed === 225158785956033, 'stage-2 noise fixed at 42, stage-1 seed from the caller (template seeds)')
      ok(ia2vGraph['312'].inputs.audio.join('|') === '303|0' && ia2vGraph['303'].inputs.samples.join('|') === '311|1', 'ia2v muxes the GENERATED audio (decoded sampled latent)')
      const ia2vPortrait = buildLtx23UtilityGraph(LTX23_MATRIX[9].request, LTX23_MATRIX[9].models)
      ok(ia2vPortrait['332'].inputs.start_index === 1.5 && ia2vPortrait['332'].inputs.duration === 4 && ia2vPortrait['329'].inputs['values.b'] === 25, 'the portrait config threads audio offset + duration + fps')
    }

    // (g5) Builder validation — the loud-refusal contract.
    {
      const throwsWith = (fn, needle, label) => {
        let threw = ''
        try { fn() } catch (error) { threw = error instanceof Error ? error.message : String(error) }
        ok(threw.includes(needle), `${label} (got: ${threw.slice(0, 90)})`)
      }
      const removeConfig = LTX23_MATRIX[0]
      throwsWith(() => buildLtx23UtilityGraph({ ...removeConfig.request, width: 1000, height: 1000 }, removeConfig.models), 'multiples of 64', 'remove-family canvas must keep stage 1 on the 32 grid')
      throwsWith(() => buildLtx23UtilityGraph({ ...removeConfig.request, video: undefined }, removeConfig.models), 'input video', 'the remove family refuses to build without the video')
      throwsWith(() => buildLtx23UtilityGraph(removeConfig.request, { ...removeConfig.models, checkpoint: '' }), 'cannot build', 'an unresolved checkpoint refuses to build — never a silent empty filename')
      const ia2vConfig = LTX23_MATRIX[8]
      throwsWith(() => buildLtx23UtilityGraph({ ...ia2vConfig.request, audio: undefined }, ia2vConfig.models), 'input audio', 'ia2v refuses to build without audio')
      throwsWith(() => buildLtx23UtilityGraph({ ...ia2vConfig.request, fps: 0 }, ia2vConfig.models), 'fps', 'ia2v validates fps')
      throwsWith(() => buildLtx23UtilityGraph({ ...ia2vConfig.request, durationSeconds: 0 }, ia2vConfig.models), 'duration', 'ia2v validates duration')
      const outpaintConfig = LTX23_MATRIX[6]
      throwsWith(() => buildLtx23UtilityGraph({ ...outpaintConfig.request, aspectW: 0, aspectH: 16 }, outpaintConfig.models), 'aspect ratio', 'outpaint validates the aspect pair')
      throwsWith(() => buildLtx23UtilityGraph({ tool: 'nope', seed: 1, filenamePrefix: 'x' }, outpaintConfig.models), 'unknown', 'the dispatcher refuses unknown tools')
    }

    // (g6) Availability gating per tool (engine combos + scan).
    {
      const ltx23File = (kind, name) => ({ kind, name, bytes: 1 })
      const comboInfo = (entries) => {
        const info = {}
        for (const [node, field, values] of entries) info[node] = { input: { required: { [field]: [values, {}] } } }
        return info
      }
      const FULL_INFO = comboInfo([
        ['CheckpointLoaderSimple', 'ckpt_name', [LTX23_MODELS.checkpoint, LTX23_MODELS.checkpointFp8]],
        ['LatentUpscaleModelLoader', 'model_name', [LTX23_MODELS.latentUpscaler]],
        ['LTXICLoRALoaderModelOnly', 'lora_name', []],
        ['LTXAddVideoICLoRAGuide', 'frame_idx', []],
        ['LTXVSetAudioRefTokens', 'positive', []],
        ['LTXVTiledVAEDecode', 'vae', []],
        ['LTXFloatToInt', 'a', []],
        ['GetImageSizeAndCount', 'image', []],
        ['ImagePadKJ', 'image', []],
        ['VAELoaderKJ', 'vae_name', []],
        ['Float32ColorCorrect', 'image', []],
        ['LoadVideo', 'file', []],
        ['CreateVideo', 'images', []],
      ])
      const FULL_SCAN = [
        ltx23File('text_encoders', LTX23_MODELS.textEncoder),
        ltx23File('text_encoders', LTX23_MODELS.textEncoderFp4),
        ltx23File('loras', LTX23_MODELS.distilled384_1_1),
        ltx23File('loras', LTX23_MODELS.distilled384),
        ltx23File('loras', LTX23_MODELS.distilledRank111),
        ltx23File('loras', LTX23_MODELS.subtitlesLora),
        ltx23File('loras', LTX23_MODELS.watermarkLora),
        ltx23File('loras', LTX23_MODELS.archivalLora),
        ltx23File('loras', LTX23_MODELS.obscuraLora),
        ltx23File('loras', LTX23_MODELS.outpaintLora),
        ltx23File('diffusion_models', LTX23_MODELS.transformer),
        ltx23File('text_encoders', LTX23_MODELS.textProjection),
        ltx23File('vae', LTX23_MODELS.videoVae),
        ltx23File('vae', LTX23_MODELS.audioVae),
      ]
      const detected = detectLtx23Utilities(FULL_INFO, FULL_SCAN)
      const byId = {}
      for (const { utility, detection } of detected) byId[utility.id] = detection
      ok(detected.length === 6, 'six utilities detected')
      for (const utility of LTX23_UTILITIES) {
        ok(byId[utility.id].available === true, `${utility.id} available on a full stack`)
        ok(byId[utility.id].missingNodes.length === 0 && byId[utility.id].missingModels.length === 0, `${utility.id} reports nothing missing on a full stack`)
      }
      ok(byId['ltx23.remove-subtitles'].resolved.checkpoint === LTX23_MODELS.checkpoint, 'the bf16 dev checkpoint resolves first (the remove-family template pin)')

      const bare = detectLtx23Utilities({}, FULL_SCAN)
      const bareById = {}
      for (const { utility, detection } of bare) bareById[utility.id] = detection
      ok(Object.values(bareById).every((detection) => detection.available === false), 'a bare engine gates every utility off')
      ok(bareById['ltx23.remove-subtitles'].missingNodes.join() === 'LTXICLoRALoaderModelOnly,LTXAddVideoICLoRAGuide,LTXVSetAudioRefTokens,LTXVTiledVAEDecode,LTXFloatToInt,GetImageSizeAndCount', 'the remove family names its missing LTXVideo + KJNodes nodes in order')
      ok(bareById['ltx23.ia2v'].missingNodes.length === 0, 'ia2v needs no packs — its gate is models only')
      ok(bareById['ltx23.outpaint'].missingNodes.includes('Float32ColorCorrect'), 'outpaint names the radiance node')

      const noWeights = detectLtx23Utilities(FULL_INFO, [])
      const noWeightsById = {}
      for (const { utility, detection } of noWeights) noWeightsById[utility.id] = detection
      ok(Object.values(noWeightsById).every((detection) => detection.available === false), 'no weights → every utility gated')
      ok(noWeightsById['ltx23.remove-subtitles'].missingModels.some((label) => label.includes('Gemma 3 12B text encoder')), 'the encoder guidance names the file')
      ok(noWeightsById['ltx23.remove-subtitles'].missingModels.some((label) => label.includes('subtitles-remove')), 'the per-tool LoRA guidance names the file')
      ok(noWeightsById['ltx23.remove-object'].missingModels.some((label) => label.includes('transformer-only')), 'obscura guidance names the split transformer')

      // With no engine combos either, the checkpoint + upscaler guidance
      // surfaces (those two slots read the loader combo lists).
      const noEngine = detectLtx23Utilities(comboInfo([['LTXICLoRALoaderModelOnly', 'lora_name', []], ['LTXAddVideoICLoRAGuide', 'frame_idx', []], ['LTXVSetAudioRefTokens', 'positive', []], ['LTXVTiledVAEDecode', 'vae', []], ['LTXFloatToInt', 'a', []], ['GetImageSizeAndCount', 'image', []]]), FULL_SCAN.filter((file) => file.kind !== 'loras'))
      const noEngineById = {}
      for (const { utility, detection } of noEngine) noEngineById[utility.id] = detection
      ok(noEngineById['ltx23.remove-subtitles'].missingModels.some((label) => label.includes('ltx-2.3-22b-dev checkpoint')), 'the checkpoint guidance names the file + folder')
      ok(noEngineById['ltx23.remove-subtitles'].missingModels.some((label) => label.includes('spatial-upscaler')), 'the upscaler guidance names the file')

      const fp8OnlyInfo = comboInfo([
        ['CheckpointLoaderSimple', 'ckpt_name', [LTX23_MODELS.checkpointFp8]],
        ['LatentUpscaleModelLoader', 'model_name', [LTX23_MODELS.latentUpscaler]],
        ['LTXICLoRALoaderModelOnly', 'lora_name', []],
        ['LTXAddVideoICLoRAGuide', 'frame_idx', []],
        ['LTXVSetAudioRefTokens', 'positive', []],
        ['LTXVTiledVAEDecode', 'vae', []],
        ['LTXFloatToInt', 'a', []],
        ['GetImageSizeAndCount', 'image', []],
      ])
      const fp8Selection = resolveLtx23Selection(fp8OnlyInfo, FULL_SCAN)
      ok(fp8Selection.checkpoint === LTX23_MODELS.checkpointFp8, 'the fp8 checkpoint satisfies the slot when bf16 is absent (documented deviation D7)')
      const obscuraGated = detectLtx23Utilities(FULL_INFO, FULL_SCAN.filter((file) => file.kind !== 'vae'))
      const obscuraGatedById = {}
      for (const { utility, detection } of obscuraGated) obscuraGatedById[utility.id] = detection
      ok(obscuraGatedById['ltx23.remove-object'].available === false && obscuraGatedById['ltx23.remove-object'].missingModels.some((label) => label.includes('video VAE')), 'obscura is gated on the split VAEs with guidance')
      ok(obscuraGatedById['ltx23.remove-subtitles'].available === true, 'the obscura VAE gate does not leak into the checkpoint family')
    }
  }

  return checks
}

function main() {
  if (process.argv.includes('--update-golden')) {
    const entries = GOLDEN_MATRIX.map(({ name, options, models, uploads }) => ({
      name, options, models, uploads,
      graph: buildMiniMaxWorkflow(options, models, uploads),
    }))
    fs.writeFileSync(FIXTURE, JSON.stringify({ version: 1, generatedFrom: 'buildMiniMaxWorkflow (registry era)', entries }, null, 1) + '\n')
    const krea2Entries = KREA2_MATRIX.map(({ name, options, models }) => ({
      name, options, models,
      graph: buildKrea2Graph(options, models),
    }))
    const baseEntry = KREA2_MATRIX[0]
    const baseGraph = buildKrea2T2iGraph(baseEntry.options, baseEntry.models)
    fs.writeFileSync(KREA2_FIXTURE, JSON.stringify({ version: 1, generatedFrom: 'buildKrea2Graph + buildKrea2T2iGraph (krea2edit families)', base: baseGraph, entries: krea2Entries }, null, 1) + '\n')
    const ltx23Entries = LTX23_MATRIX.map(({ name, request, models }) => ({
      name, request, models,
      graph: buildLtx23UtilityGraph(request, models),
    }))
    fs.writeFileSync(LTX23_FIXTURE, JSON.stringify({ version: 1, generatedFrom: 'buildLtx23UtilityGraph (LTX-2.3 official-template utilities)', entries: ltx23Entries }, null, 1) + '\n')
    console.log(`Regenerated ${entries.length} golden graphs at ${path.relative(process.cwd(), FIXTURE)}, ${krea2Entries.length} Krea 2 edit graphs at ${path.relative(process.cwd(), KREA2_FIXTURE)}, and ${ltx23Entries.length} LTX-2.3 utility graphs at ${path.relative(process.cwd(), LTX23_FIXTURE)} — review the diff: the fixtures ARE the contract.`)
    return
  }
  const done = run()
  console.log(`PASS: optimization registry (${done} assertions) — inertness vs pre-registry goldens across the ${GOLDEN_MATRIX.length}-config matrix, transform correctness (plain + dedicated larryvrh pairing swap, LBH/LTX/RTX chains, preview override), detection against mock object_info/scans, family pairing contracts (steps/sampler enforced, 8-step keeps res_multistep+simple), family-ranked selection inference (official > lightx2v newest-first, explicit family constraint, Ref2VA 8-step fast tier — larryvrh v4 default per bake-off 2026-09-15), painless expansion (a hypothetical 5-step family registered, detected, transformed, paired and proven inert via registry data alone), the five Krea 2 edit families (base-t2i inertness, per-family goldens, research-pinned recipes, hand-asserted dual-conditioning/AnyPaint wiring, E-K1 honesty-label + scene-style prompt-contract pins, recipe-triple audit incl. the t=0 carrier trap + the E-K1 index-pairing rule + no-composite rule + patcher mutual exclusion, dial validation at the research limits, and per-family availability gating with low-VRAM LoRA fallback), and the six LTX-2.3 one-graph utilities (official-template goldens + class-census fidelity vs the template subgraphs with documented D1–D8 deltas, topology audit, template-pinned sigmas/strengths/samplers/seeds, hand-asserted two-stage + IC-LoRA wiring, loud-refusal validation, and per-tool availability gating through engine combos + scan)`)
}

main()
