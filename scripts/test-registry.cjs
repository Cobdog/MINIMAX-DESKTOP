'use strict'
/** Optimization-registry test suite (VM harness, no engine needed).
 *
 * Five probes, in the Kreatine verifier tradition:
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
 *
 * `node scripts/test-registry.cjs --update-golden` re-snapshots the fixture
 * from the CURRENT builder — only for intentional base-graph changes, and
 * always reviewed as a git diff (the fixture IS the inertness contract). */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadTs } = require('./lib/ts-vm.cjs')
const { GOLDEN_MATRIX } = require('./lib/registry-matrix.cjs')

const FIXTURE = path.resolve(__dirname, 'fixtures/registry-golden.json')

const workflowModule = loadTs('src/lib/workflow.ts')
const { buildMiniMaxWorkflow, OFFICIAL_H3_SAMPLER, OFFICIAL_H3_SCHEDULER } = workflowModule
const graphModule = loadTs('src/lib/graph/index.ts')
const {
  optimizationEntries, findOptimization, registerOptimization, detectOptimizations,
  turboProvenance, classifyTurboFamily, turboLoraPatterns, resolveTurboPlan, larryvrhTurboPackPresent,
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
  ['minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors', 'turbo.drbaph-4', 4],
  ['MiniMax-H3-FL2VA-Acc-8Step.safetensors', 'turbo.pdd-fl2va-8', 8],
  ['MiniMax-H3-Ref2VA-Acc-8Step.safetensors', 'turbo.pdd-ref2va-8', 8],
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
  for (const required of ['turbo.official-fl2v-8', 'turbo.lightx2v-fl2v-4', 'turbo.lightx2v-ref2v-8', 'turbo.pdd-fl2va-8', 'turbo.pdd-ref2va-8', 'turbo.drbaph-4', 'turbo.ref2v-4', 'upscale.ltx2x', 'upscale.lbh2d', 'upscale.lbh3d', 'upscale.rtx', 'preview.h3-override']) {
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
    ok(inferSelections([ref4], '8').ref2vLora === '', 'reference 8-step stays empty without the Ref2VA 8-step LoRA')
    ok(inferSelections([ref4], '4').ref2vLora === ref4.name, 'reference 4-step keeps the official LoRA')
    ok(inferSelections([official8, pddFl], '8', 'turbo.pdd-fl2va-8').fl2vLora === pddFl.name, 'an explicit family choice constrains inference to it')
    ok(inferSelections([official8, pddFl], '8', 'turbo.official-fl2v-8').fl2vLora === official8.name, 'explicit official family still wins with PDD installed')
    // Ranking patterns are registry data: the 4-step list prefers v1.2 first.
    const ranked = turboLoraPatterns('fl2v', '4')
    ok(ranked[0].test('minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors') && !ranked[0].test('minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors'), 'ranking patterns expose the version preference')

    // Workspace normalization: legacy reference+8 resets, an explicit
    // Ref2VA 8-step family pick survives a reload.
    const { normalizeWorkspace } = loadTs('src/lib/workspace.ts')
    ok(normalizeWorkspace({ mode: 'reference', turbo: '8' }).turbo === 'off', 'legacy reference 8-step choices reset on reload')
    ok(normalizeWorkspace({ mode: 'reference', turbo: '8', turboFamily: 'turbo.lightx2v-ref2v-8' }).turbo === '8', 'explicit Ref2VA 8-step family survives reload')
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

  return checks
}

function main() {
  if (process.argv.includes('--update-golden')) {
    const entries = GOLDEN_MATRIX.map(({ name, options, models, uploads }) => ({
      name, options, models, uploads,
      graph: buildMiniMaxWorkflow(options, models, uploads),
    }))
    fs.writeFileSync(FIXTURE, JSON.stringify({ version: 1, generatedFrom: 'buildMiniMaxWorkflow (registry era)', entries }, null, 1) + '\n')
    console.log(`Regenerated ${entries.length} golden graphs at ${path.relative(process.cwd(), FIXTURE)} — review the diff: the fixture is the inertness contract.`)
    return
  }
  const done = run()
  console.log(`PASS: optimization registry (${done} assertions) — inertness vs pre-registry goldens across the ${GOLDEN_MATRIX.length}-config matrix, transform correctness (plain + dedicated larryvrh pairing swap, LBH/LTX/RTX chains, preview override), detection against mock object_info/scans, family pairing contracts (steps/sampler enforced, 8-step keeps res_multistep+simple), family-ranked selection inference (official > lightx2v newest-first, explicit family constraint, Ref2VA 8-step), and painless expansion (a hypothetical 5-step family registered, detected, transformed, paired and proven inert via registry data alone)`)
}

main()
