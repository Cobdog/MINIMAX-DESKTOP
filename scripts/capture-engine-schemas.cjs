#!/usr/bin/env node
'use strict'

/**
 * ENGINE-SCHEMA CAPTURE NORMALIZER (task 8dga2dy — the engine-contract layer).
 *
 * Turns a RAW `GET /object_info` capture from the canonical shared install
 * into the committed contract fixture `scripts/fixtures/engine-object-info.json`
 * (provenance-recorded, machine-independent). The fixture is the data the
 * contract tests validate our emitted graphs against — testing against the
 * engine's REAL served schemas instead of synthetic stubs is the entire point
 * (the T=1 lesson: `length: 1` passes every fake-engine wiring test and is
 * refused by execution.py's schema-min enforcement).
 *
 * REGENERATION (the capture half is human-driven per docs/agent/runbook.md —
 * CPU-only boot, no prompt submissions, teardown verified):
 *
 *   1. cd /home/agent/comfyui && nohup ./.venv/bin/python main.py \
 *        --port 8189 --listen 127.0.0.1 --cpu > /tmp/capture.log 2>&1 &
 *      (record the PID; --cpu keeps the GPU untouched for a schema capture)
 *   2. curl -s http://127.0.0.1:8189/object_info -o /tmp/object-info-raw.json
 *   3. POST /free {"unload_models":true,"free_memory":true}; SIGINT the PID;
 *      verify with nvidia-smi that the GPU is back at its baseline.
 *   4. node scripts/capture-engine-schemas.cjs /tmp/object-info-raw.json
 *   5. Review the fixture diff like any contract change (it IS one).
 *
 * NORMALIZATIONS (machine-independence; each rule is recorded in the
 * fixture's __provenance.normalizations):
 *   - TRIM to the classes our builders can emit (EMITTED_CLASSES below +
 *     everything in src/lib/preflight.ts STOCK_GRAPH_CLASSES). A class not
 *     emittable by us is out of contract scope.
 *   - FILE-LISTING COMBOS (model folders, input dirs) are emptied: their
 *     options are THIS box's filesystem, not engine truth. Empty options =
 *     "environment-enumerated" — the contract validator skips membership for
 *     them (the engine's own check there is file existence, a runtime
 *     concern). Every non-file enum keeps its real captured options.
 *   - The first-party form adapter (MiniMaxH3LoraFormLoader) is not
 *     installed on the shared install; its entry is SOURCE-DERIVED from this
 *     repo's own pack (custom-nodes/minimax-lora-form-adapter) and merged in
 *     with `--form-adapter-source <repo-commit>` provenance.
 *   - Classes our builders can emit but the install does not serve are
 *     recorded in `absent` with reasons (inert-by-design lanes).
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const OUT = path.join(REPO, 'scripts', 'fixtures', 'engine-object-info.json')

/** Stock classes (kept in lockstep with src/lib/preflight.ts
 * STOCK_GRAPH_CLASSES — the fixture-integrity test cross-checks this against
 * the live constant, so drift fails loudly rather than silently narrowing
 * contract coverage). */
const STOCK_CLASSES = [
  'UNETLoader', 'CLIPLoader', 'DualCLIPLoader', 'VAELoader', 'LoraLoaderModelOnly',
  'LoadImage', 'LoadVideo', 'LoadAudio', 'GetVideoComponents',
  'MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo', 'MiniMaxH3AddGuide', 'MiniMaxH3SigmaShift',
  'RandomNoise', 'BasicGuider', 'CFGGuider', 'KSamplerSelect', 'BasicScheduler', 'SamplerCustomAdvanced',
  'VAEDecode', 'VAEDecodeTiled', 'VAEDecodeAudio', 'VAEDecodeAudioTiled', 'VAEEncode',
  'CreateVideo', 'SaveVideo', 'SaveImage', 'SaveAudioAdvanced', 'ImageFromBatch', 'PreviewImage',
  'UpscaleModelLoader', 'ImageUpscaleWithModel', 'ImageScale', 'ImageScaleToTotalPixels',
  'SplitSigmas', 'ManualSigmas', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent',
  'ReferenceLatent', 'ConditioningZeroOut', 'CLIPTextEncode', 'KSampler',
  'GetImageSize', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'ModelSamplingAuraFlow', 'EmptySD3LatentImage',
  'EmptyMiniMaxMusic3LatentAudio', 'MiniMaxMusic3TextEncode',
]

/** Family + pack classes beyond stock that our builders/registry can emit. */
const PACK_CLASSES = [
  'EmptyMiniMaxH3LatentAV',
  'MiniMaxH3HybridLoader',                       // scottmudge hybrid loader pack
  'MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler', // larryvrh turbo pack
  'MiniMaxH3PreviewOverride', 'MiniMaxH3PreviewOverrideCS', // preview override (engine-version dependent)
  'MiniMaxH3MotionContext', 'MiniMaxH3MotionContextTrim', 'MiniMaxH3MotionContextSaveLatent',
  'MiniMaxH3MotionContextLoadLatent', 'MiniMaxH3MotionContextChain', 'MiniMaxH3MotionContextSeamProbe',
  'MinimaxH3LatentUpscalerNode2D', 'MinimaxH3LatentUpscaler3D', // LBH hires-fix pack
  'MiniMaxH3LoraFormLoader',                   // first-party form adapter (source-derived entry below)
  'Krea2EditModelPatch', 'Krea2EditGroundedEncode',
  'Krea2AnyPaintPrepare', 'Krea2AnyPaintEncode', 'Krea2AnyPaintModelPatch',
  'TextEncodeAceStepAudio', 'EmptyAceStepLatentAudio',
  'TextEncodeAceStepAudio1.5', 'EmptyAceStep1.5LatentAudio',
  'SeedVR2VideoUpscaler', 'seedvr2_videoupscaler', // E-IW2 gated, never vendored yet
]

/** File-listing combos (engine folder / input-dir enumerations): emptied for
 * machine independence — see the header. Field paths are class.field. */
const FILE_LISTING_FIELDS = new Set([
  'UNETLoader.unet_name', 'CLIPLoader.clip_name', 'DualCLIPLoader.clip_name1', 'DualCLIPLoader.clip_name2',
  'VAELoader.vae_name', 'LoraLoaderModelOnly.lora_name', 'UpscaleModelLoader.model_name',
  'MiniMaxH3HybridLoader.base_model', 'MiniMaxH3HybridLoader.overlay_model',
  'MiniMaxH3TurboLoRA.lora_name', 'MiniMaxH3LoraFormLoader.lora_name',
  'LoadImage.image', 'LoadAudio.audio', 'LoadVideo.file',
  'MinimaxH3LatentUpscalerNode2D.model_name', 'MinimaxH3LatentUpscaler3D.model_name',
])

/** Why an expected class may be absent from a given install. */
const ABSENT_REASONS = {
  MiniMaxH3LoraFormLoader: 'first-party pack (custom-nodes/minimax-lora-form-adapter) is not installed on the shared install; its entry is source-derived below',
  MiniMaxH3PreviewOverride: 'preview-override node ships in newer ComfyUI cores than the pinned revision; the registry entry stays inert without it',
  MiniMaxH3PreviewOverrideCS: 'preview-override node ships in newer ComfyUI cores than the pinned revision; the registry entry stays inert without it',
  MinimaxH3LatentUpscalerNode2D: 'LBH hires-fix pack not installed on the shared install; the upscale entry stays inert without it',
  MinimaxH3LatentUpscaler3D: 'LBH hires-fix pack not installed on the shared install; the upscale entry stays inert without it',
  SeedVR2VideoUpscaler: 'E-IW2 gated: the SeedVR2 pack is deliberately not vendored or installed in v1',
  seedvr2_videoupscaler: 'E-IW2 gated: the SeedVR2 pack is deliberately not vendored or installed in v1',
}

/** Source-derived schema for the first-party form adapter, transcribed from
 * custom-nodes/minimax-lora-form-adapter/minimax_lora_form_adapter/nodes.py
 * (INPUT_TYPES + RETURN_TYPES) in the object_info serving shape. Update it
 * only alongside that source; the lora-form suite owns the pack's behavior. */
function formAdapterEntry() {
  return {
    input: {
      required: {
        model: ['MODEL', {}],
        // lora_name enumerates the engine's loras folder at serve time —
        // environment-enumerated, emptied like the captured file listings.
        lora_name: [[], {}],
        strength: ['FLOAT', { default: 1.0, min: -10.0, max: 10.0, step: 0.01 }],
        mode: [['projected (default)', 'exact (runtime injection)', 'adaln-dropped (warn)'], { default: 'projected (default)' }],
        egrid_path: ['STRING', { default: '', placeholder: "auto: cached grid, else larryvrh's bundle" }],
        low_vram: ['BOOLEAN', { default: false, label_on: 'merge (low VRAM, softer on quantized bases)', label_off: 'bypass (sharp; int8-fused fc2 auto-merged)' }],
      },
    },
    input_order: { required: ['model', 'lora_name', 'strength', 'mode', 'egrid_path', 'low_vram'] },
    output: ['MODEL'],
    output_name: ['MODEL'],
    output_is_list: [false],
    name: 'MiniMaxH3LoraFormLoader',
    display_name: 'MiniMax H3 LoRA Form Adapter',
    category: 'MiniMaxH3/FormAdapter',
    output_node: false,
    __sourceDerived: 'custom-nodes/minimax-lora-form-adapter/minimax_lora_form_adapter/nodes.py',
  }
}

/** Empty one combo's options in place, preserving the serving shape. */
function emptyCombo(classType, fieldName, spec) {
  if (Array.isArray(spec) && Array.isArray(spec[0])) return [ [], spec[1] ?? {} ]
  if (Array.isArray(spec) && spec[1] && Array.isArray(spec[1].options)) {
    const extra = { ...spec[1] }
    delete extra.options
    return [spec[0], extra]
  }
  return spec // not a combo in a shape we normalize — leave untouched
}

function normalizeInputs(classType, section) {
  if (!section || typeof section !== 'object') return section
  const out = {}
  for (const [field, spec] of Object.entries(section)) {
    out[field] = FILE_LISTING_FIELDS.has(`${classType}.${field}`) ? emptyCombo(classType, field, spec) : spec
  }
  return out
}

function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const formAdapterSource = (process.argv.find((a) => a.startsWith('--form-adapter-source=')) ?? '').split('=')[1] || 'uncommitted working tree'
  if (argv.length !== 1) {
    console.error('usage: node scripts/capture-engine-schemas.cjs <raw-object-info.json> [--form-adapter-source <repo-commit>]')
    process.exit(2)
  }
  const rawPath = path.resolve(argv[0])
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'))
  const wanted = [...new Set([...STOCK_CLASSES, ...PACK_CLASSES])]

  const nodes = {}
  const absent = []
  for (const classType of wanted) {
    if (raw[classType]) {
      const entry = JSON.parse(JSON.stringify(raw[classType]))
      if (entry.input) {
        entry.input.required = normalizeInputs(classType, entry.input.required)
        if (entry.input.optional) entry.input.optional = normalizeInputs(classType, entry.input.optional)
      }
      nodes[classType] = entry
    } else if (classType === 'MiniMaxH3LoraFormLoader') {
      nodes[classType] = formAdapterEntry()
    } else {
      absent.push({ class: classType, reason: ABSENT_REASONS[classType] ?? 'not served by this install' })
    }
  }

  const fixture = {
    __provenance: {
      description: 'REAL ComfyUI node schemas (object_info) for every class our graph builders emit — the engine-contract fixture. Validate emitted graphs against these, never against synthetic stubs (the T=1 lesson, 2026-09-21).',
      capturedFrom: 'GET /object_info, canonical shared install (/home/agent/comfyui) on 127.0.0.1:8189, schema-only --cpu boot, zero prompt submissions, teardown verified',
      comfyuiRevision: 'a87667f72f5fad094b74b10dc9c9f82faea728ef',
      comfyuiVersion: '0.34.0',
      captureDate: '2026-09-21',
      rawClassCount: Object.keys(raw).length,
      keptClassCount: Object.keys(nodes).length,
      formAdapterSource,
      normalizations: [
        'trimmed to STOCK_GRAPH_CLASSES (src/lib/preflight.ts, lockstep-checked by tests) + the pack/family classes builders can emit',
        'file-listing combos (model folders, input dirs) EMPTIED: options are this box\'s filesystem, not engine truth — the contract validator treats empty options as environment-enumerated and skips membership; non-file enums keep their real captured options',
        'MiniMaxH3LoraFormLoader source-derived from this repo\'s first-party pack (not installed on the shared install); see __sourceDerived on the entry',
        'absent classes recorded with reasons (inert-by-design lanes)',
      ],
      regenerate: 'per the header of scripts/capture-engine-schemas.cjs (runbook-governed CPU-only capture, then this script over the raw JSON)',
    },
    nodes,
    absent,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
  console.log(`wrote ${path.relative(REPO, OUT)}: ${Object.keys(nodes).length} classes kept, ${absent.length} recorded absent (raw had ${Object.keys(raw).length})`)
}

if (require.main === module) main()
module.exports = { STOCK_CLASSES, PACK_CLASSES, FILE_LISTING_FIELDS, formAdapterEntry }
