/** ENGINE-CONTRACT test suite (task 8dga2dy — the T=1 lesson, structural).
 *
 * The engine-contract layer, in the pack-author discipline adopted from
 * astropuzzo/ComfyUI-MiniMax-H3-Image-Studio @ 47dea30 (adopt the
 * philosophy — test against the REAL contract, commit the measurements,
 * publish the negatives; adapt the mechanics — we mirror the engine's
 * validation gate over its real served schemas instead of executing tensor
 * math):
 *
 *  (a) FIXTURE INTEGRITY — the committed object_info capture
 *      (scripts/fixtures/engine-object-info.json) is provenance-recorded,
 *      covers every class our builders emit (lockstep with preflight's
 *      STOCK_GRAPH_CLASSES + the pack constants), and honestly records its
 *      absences.
 *  (b) VALIDATOR NEGATIVE PROOFS — planted violations against the REAL
 *      schemas, each carrying the engine's own error vocabulary. THE T=1
 *      LESSON: `length: 1` FAILS here from now on (value_smaller_than_min).
 *  (c) EVERY BUILDER VALIDATES — the full builder corpus (h3img matrix,
 *      Krea 2 matrix, the video factory across modes/tiers/chain/stack, the
 *      music3 audio core) validated against the real schemas:
 *      violations must match the known-divergence ledger EXACTLY — no new
 *      divergence lands silently, and every ledger entry still fires (a fix
 *      must retire its entry, visibly).
 *  (d) SEMANTIC RULES — the reinterpretation ledger: the 17k+5 grid, the
 *      6-21→22 slice window, the max(5,·) promotion mirror; our emitted
 *      lengths are grid-honored or ledgered; the silent-drop proof for
 *      unknown inputs.
 *  (e) THE FAKE ENGINE GRADUATES — e2e/fakeEngineInfo.ts serves the real
 *      captured schemas for stock classes (extras still win), so e2e
 *      inherits contract truth.
 *
 * VM harness (no engine, no python, no GPU — runs on every PR leg). */
import { test } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadTs } = require('../scripts/lib/ts-vm.cjs')
const { H3IMG_MATRIX } = require('../scripts/lib/h3img-matrix.cjs')
const { KREA2_MATRIX } = require('../scripts/lib/krea2edit-matrix.cjs')
const captureScript = require('../scripts/capture-engine-schemas.cjs')

const FIXTURE = path.resolve(__dirname, '..', 'scripts', 'fixtures', 'engine-object-info.json')

const contract = loadTs('src/lib/engineContract.ts')
const semantics = loadTs('src/lib/engineSemantics.ts')
const preflightModule = loadTs('src/lib/preflight.ts')
const h3image = loadTs('src/lib/graph/h3image.ts')
const workflow = loadTs('src/lib/workflow.ts')
const music3 = loadTs('src/lib/music3Workflow.ts')

const FIXTURE_DATA = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const REAL_INFO = FIXTURE_DATA.nodes

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}

// ---------------------------------------------------------------------------
// (a) fixture integrity
// ---------------------------------------------------------------------------
test('(a) fixture integrity: provenance, coverage lockstep, honest absences', () => {
  const prov = FIXTURE_DATA.__provenance
  ok(prov && prov.comfyuiRevision === 'a87667f72f5fad094b74b10dc9c9f82faea728ef', 'provenance pins the verified revision a87667f')
  ok(typeof prov.captureDate === 'string' && prov.captureDate.length === 10, 'provenance carries the capture date')
  ok(typeof prov.rawClassCount === 'number' && prov.rawClassCount > 1000, `provenance records the raw capture size (${prov.rawClassCount} classes)`)
  ok(Array.isArray(prov.normalizations) && prov.normalizations.length >= 3, 'provenance records the normalization rules')

  // Coverage lockstep: the capture script's stock list IS preflight's live
  // constant (drift narrows contract coverage silently otherwise).
  const stockLive = preflightModule.STOCK_GRAPH_CLASSES
  assert.deepEqual(
    JSON.parse(JSON.stringify(captureScript.STOCK_CLASSES.slice().sort())),
    JSON.parse(JSON.stringify(stockLive.slice().sort())),
    'capture-script STOCK_CLASSES matches preflight.STOCK_GRAPH_CLASSES exactly',
  )
  passed += 1
  console.log('  ok - capture-script STOCK_CLASSES matches preflight.STOCK_GRAPH_CLASSES exactly')

  for (const className of stockLive) {
    ok(REAL_INFO[className] !== undefined, `fixture serves stock class ${className}`)
  }
  for (const className of captureScript.PACK_CLASSES) {
    const served = REAL_INFO[className] !== undefined
    const recordedAbsent = FIXTURE_DATA.absent.some((entry) => entry.class === className)
    ok(served || recordedAbsent, `pack class ${className} is served or honestly recorded absent`)
  }
  for (const entry of FIXTURE_DATA.absent) {
    ok(typeof entry.reason === 'string' && entry.reason.length > 10, `absent class ${entry.class} carries a reason`)
  }

  // The real contract is IN the fixture — the T=1 seam, verbatim.
  const length = REAL_INFO.MiniMaxH3ImageToVideo.input.required.length
  ok(length[0] === 'INT' && length[1].min === 5 && length[1].max === 3600 && length[1].step === 17,
    'MiniMaxH3ImageToVideo.length is the real served schema (INT, min 5, max 3600, step 17)')
  assert.deepEqual(REAL_INFO.MiniMaxH3ReferenceToVideo.input.required.length[1].min, 5, 'ReferenceToVideo length floor is 5 too')
  passed += 1
  console.log('  ok - ReferenceToVideo length floor is 5 too')

  // First-party form-adapter entry stays in lockstep with its source shape.
  const formAdapter = REAL_INFO.MiniMaxH3LoraFormLoader
  assert.deepEqual(
    JSON.parse(JSON.stringify(Object.keys(formAdapter.input.required))),
    JSON.parse(JSON.stringify(['model', 'lora_name', 'strength', 'mode', 'egrid_path', 'low_vram'])),
    'the source-derived form-adapter entry declares every required field (incl. low_vram)',
  )
  passed += 1
  console.log('  ok - the source-derived form-adapter entry declares every required field (incl. low_vram)')

  // File-listing combos normalized to empty = environment-enumerated.
  ok(Array.isArray(REAL_INFO.VAELoader.input.required.vae_name[0]) && REAL_INFO.VAELoader.input.required.vae_name[0].length === 0,
    'file-listing combos are emptied (environment-enumerated — not this box\'s filenames)')
  const samplerOptions = REAL_INFO.KSamplerSelect.input.required.sampler_name[1].options
  ok(samplerOptions.includes('res_multistep') && samplerOptions.includes('er_sde') && samplerOptions.includes('euler'),
    'real enums survive normalization (KSamplerSelect serves res_multistep/er_sde/euler)')

  // The H3 Image Studio pack's captured schemas (afvlbk4): the five
  // load-bearing classes, served REAL from the shared install with the pack
  // cloned at 47dea30 — provenance-recorded in the fixture. The frame-preset
  // enum and decode modes are the pack's own truth, and the T=1 legality is
  // visible in the schema: no length-style min floor exists on the Prepare
  // classes at all (the stock floor is what made length:1 illegal).
  ok(Array.isArray(FIXTURE_DATA.__provenance.h3ImageStudioPackCapture) === false && typeof FIXTURE_DATA.__provenance.h3ImageStudioPackCapture === 'string' && FIXTURE_DATA.__provenance.h3ImageStudioPackCapture.includes('47dea30'),
    'provenance records the pack capture (repo @ 47dea30, cloned into the shared install)')
  const presets = REAL_INFO.H3TextToImagePrepare.input.required.quality_profile[0]
  assert.deepEqual(
    JSON.parse(JSON.stringify(presets)),
    JSON.parse(JSON.stringify(['single image | 1 frame (image VAE)', 'recommended | 5 frames', 'extended quality | 9 frames', 'high quality | 13 frames', 'maximum quality | 20 frames (slow)'])),
    'the pack\'s frame_preset enum is the real captured ladder (1/5/9/13/20 — no 17n+5 snap anywhere)',
  )
  passed += 1
  console.log('  ok - the pack\'s frame_preset enum is the real captured ladder (1/5/9/13/20 — no 17n+5 snap anywhere)')
  assert.deepEqual(
    JSON.parse(JSON.stringify(REAL_INFO.H3ImageDecode.input.optional.decode_mode[0])),
    JSON.parse(JSON.stringify(['temporal', 'single_latent_slice'])),
    'H3ImageDecode serves the real decode-mode enum (temporal + single_latent_slice)',
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(REAL_INFO.H3ImageToImagePrepare.output)),
    JSON.parse(JSON.stringify(['CONDITIONING', 'LATENT', 'IMAGE', 'INT', 'STRING', 'STRING'])),
    'the Prepare wrappers return (conditioning, latent) at slots 0/1 — the sampler wiring contract',
  )
  passed += 1
  console.log('  ok - the Prepare wrappers return (conditioning, latent) at slots 0/1 — the sampler wiring contract')
})

test('(c-affvlbk4) the pack-conditioned lanes: real-capability proofs against the captured pack schemas', () => {
  // THE FLIP: with the pack served, the T=1 family BUILDS — a pack-form
  // graph that validates CLEAN against the real schemas (the thing the
  // stock path could never do), carrying the legal single-frame preset.
  const t1Graph = h3image.buildH3ImageGraph(
    { family: 'h3img.generate.t1', prompt: 'a finished still', width: 1344, height: 768, seed: 1, tier: 1, refs: [], loras: [], filenamePrefix: 'contract/t1' },
    { fl2va: 'fl2va.safetensors', ref2va: 'ref2va.safetensors', textEncoder: 'qwen.safetensors', videoVae: 'video-vae.safetensors', audioVae: 'audio-vae.safetensors', t1ImageVae: 't1-image-vae.safetensors', turboLora: 'turbo.safetensors', detailAdapterLora: 'detail.safetensors', krea2: null, klein: { unet: '', textEncoder: '', vae: '' } },
    REAL_INFO,
  )
  ok(contract.validateGraphAgainstSchemas(t1Graph, REAL_INFO).length === 0, 'the T=1 pack-form graph validates CLEAN against the real schemas (execution-truth-shaped, not just graph-shaped)')
  const t1Prepare = Object.values(t1Graph).find((node) => node.class_type === 'H3TextToImagePrepare')
  ok(t1Prepare !== undefined && t1Prepare.inputs.quality_profile === 'single image | 1 frame (image VAE)', 'pure-text T=1 rides H3TextToImagePrepare at the one-frame preset')

  // The fast-sharp slice decode against the real decode schema.
  const sharpGraph = h3image.buildH3ImageGraph(
    { family: 'h3img.generate.sharp', prompt: 'a finished still', width: 1344, height: 768, seed: 1, tier: 9, refs: [], loras: [], filenamePrefix: 'contract/sharp' },
    { fl2va: 'fl2va.safetensors', ref2va: 'ref2va.safetensors', textEncoder: 'qwen.safetensors', videoVae: 'video-vae.safetensors', audioVae: 'audio-vae.safetensors', t1ImageVae: 't1-image-vae.safetensors', turboLora: 'turbo.safetensors', detailAdapterLora: 'detail.safetensors', krea2: null, klein: { unet: '', textEncoder: '', vae: '' } },
    REAL_INFO,
  )
  ok(contract.validateGraphAgainstSchemas(sharpGraph, REAL_INFO).length === 0, 'the fast-sharp graph validates CLEAN (9-frame context, single_latent_slice decode through the T1 VAE)')
  const sharpDecode = Object.values(sharpGraph).find((node) => node.class_type === 'H3ImageDecode')
  ok(sharpDecode.inputs.decode_mode === 'single_latent_slice' && sharpDecode.inputs.latent_index === 0, 'fast-sharp: single_latent_slice at the pinned head slice')

  // The exact 9/13 ladder: pack-form packets carry NO stock conditioning
  // node at all — the tier economy is the pack's own latent construction.
  const packet9 = h3image.buildH3ImageGraph(
    { family: 'h3img.generate.packet', prompt: 'a finished still', width: 1344, height: 768, seed: 1, tier: 9, refs: [], loras: [], filenamePrefix: 'contract/p9' },
    { fl2va: 'fl2va.safetensors', ref2va: 'ref2va.safetensors', textEncoder: 'qwen.safetensors', videoVae: 'video-vae.safetensors', audioVae: 'audio-vae.safetensors', t1ImageVae: '', turboLora: '', detailAdapterLora: '', krea2: null, klein: { unet: '', textEncoder: '', vae: '' } },
    REAL_INFO,
  )
  ok(contract.validateGraphAgainstSchemas(packet9, REAL_INFO).length === 0, 'the exact-9 pack-form packet validates CLEAN')
  ok(!Object.values(packet9).some((node) => node.class_type === 'MiniMaxH3ImageToVideo' || node.class_type === 'MiniMaxH3ReferenceToVideo'), 'pack-form packet 9: no stock conditioning node — the snap-to-22 path is not taken')
  const packetPreset = Object.values(packet9).find((node) => node.class_type === 'H3TextToImagePrepare' || node.class_type === 'H3ImageToImagePrepare' || node.class_type === 'H3ReferenceEditPrepare')
  ok(packetPreset !== undefined && packetPreset.inputs.quality_profile === 'extended quality | 9 frames', 'pack-form packet 9 rides the exact 9-frame preset (no pictures → the T2I wrapper)')

  // Pack ABSENT: the studio-conditioned lanes refuse at BUILD — the stock
  // length:1 submission is dead in both directions.
  const STOCK_ONLY_INFO = { ...REAL_INFO }
  for (const classType of ['H3ImagePrepare', 'H3TextToImagePrepare', 'H3ImageToImagePrepare', 'H3ReferenceEditPrepare', 'H3ImageDecode']) delete STOCK_ONLY_INFO[classType]
  assert.throws(
    () => h3image.buildH3ImageGraph({ family: 'h3img.generate.t1', prompt: 'x', width: 1344, height: 768, seed: 1, tier: 1, refs: [], loras: [], filenamePrefix: 'x' },
      { fl2va: 'f', ref2va: 'r', textEncoder: 't', videoVae: 'v', audioVae: 'a', t1ImageVae: 't1', turboLora: 'tb', detailAdapterLora: '', krea2: null, klein: { unet: '', textEncoder: '', vae: '' } }, STOCK_ONLY_INFO),
    /#15644|Image Studio/,
    'T=1 without the pack: build refuses (never a stock length:1 submit)',
  )
  passed += 1
  console.log('  ok - T=1 without the pack: build refuses (never a stock length:1 submit)')
})

// ---------------------------------------------------------------------------
// (b) validator negative proofs — planted violations against REAL schemas
// ---------------------------------------------------------------------------
test('(b) validator negative proofs: the engine\'s error vocabulary, on real schemas', () => {
  const baseGraph = () => ({
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'fl2va.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['9', 0], vae: ['3', 0], prompt: 'p', width: 768, height: 768, length: 5 } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'video-vae.safetensors' } },
    '9': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors', type: 'minimax', device: 'default' } },
  })

  // THE NAMESAKE: length:1 is refused exactly the way execution.py refuses it.
  const t1 = baseGraph()
  t1['2'].inputs.length = 1
  const t1Violations = contract.validateGraphAgainstSchemas(t1, REAL_INFO)
  ok(t1Violations.length === 1 && t1Violations[0].type === 'value_smaller_than_min' && t1Violations[0].inputName === 'length',
    'THE T=1 LESSON: length:1 → value_smaller_than_min on the real schema (the failure no fake-engine test can catch)')

  const over = baseGraph()
  over['2'].inputs.length = 3601
  ok(contract.validateGraphAgainstSchemas(over, REAL_INFO).some((v) => v.type === 'value_bigger_than_max'),
    'length:3601 → value_bigger_than_max')

  ok(contract.validateGraphAgainstSchemas(baseGraph(), REAL_INFO).length === 0, 'the clean base graph validates (no false positives)')

  const badSampler = {
    '1': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'definitely_not_a_sampler' } },
  }
  ok(contract.validateGraphAgainstSchemas(badSampler, REAL_INFO)[0].type === 'value_not_in_list',
    'a sampler name outside the real enum → value_not_in_list')

  const missingRequired = baseGraph()
  delete missingRequired['2'].inputs.vae
  ok(contract.validateGraphAgainstSchemas(missingRequired, REAL_INFO).some((v) => v.type === 'required_input_missing' && v.inputName === 'vae'),
    'dropping a required input → required_input_missing')

  const unknownNode = { '1': { class_type: 'NoSuchNodeClass', inputs: {} } }
  ok(contract.validateGraphAgainstSchemas(unknownNode, REAL_INFO)[0].type === 'missing_node_type',
    'an unserved class → missing_node_type')

  const badLink = baseGraph()
  badLink['2'].inputs.clip = ['99', 0]
  ok(contract.validateGraphAgainstSchemas(badLink, REAL_INFO).some((v) => v.type === 'unknown_linked_node'),
    'a link to a nonexistent node → unknown_linked_node')

  const shortLink = baseGraph()
  shortLink['2'].inputs.clip = ['9']
  ok(contract.validateGraphAgainstSchemas(shortLink, REAL_INFO).some((v) => v.type === 'bad_linked_input'),
    'a length-1 link → bad_linked_input (must be [node_id, slot])')

  const badSlot = baseGraph()
  badSlot['2'].inputs.clip = ['9', 5]
  ok(contract.validateGraphAgainstSchemas(badSlot, REAL_INFO).some((v) => v.type === 'bad_linked_slot'),
    'an out-of-range slot → bad_linked_slot')

  const typeMismatch = baseGraph()
  typeMismatch['2'].inputs.vae = ['9', 0] // CLIPLoader emits CLIP, not VAE
  ok(contract.validateGraphAgainstSchemas(typeMismatch, REAL_INFO).some((v) => v.type === 'return_type_mismatch' && v.inputName === 'vae'),
    'CLIP wired into a VAE socket → return_type_mismatch')

  const badInt = baseGraph()
  badInt['2'].inputs.width = { nope: true }
  ok(contract.validateGraphAgainstSchemas(badInt, REAL_INFO).some((v) => v.type === 'invalid_input_type'),
    'an object where an INT is required → invalid_input_type')

  const cycle = {
    '1': { class_type: 'VAELoader', inputs: { vae_name: 'v.safetensors' } },
    '2': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['3', 0], guider: ['3', 0], sampler: ['3', 0], sigmas: ['3', 0], latent_image: ['3', 0] } },
    '3': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['2', 0], guider: ['2', 0], sampler: ['2', 0], sigmas: ['2', 0], latent_image: ['2', 0] } },
  }
  ok(contract.validateGraphAgainstSchemas(cycle, REAL_INFO).some((v) => v.type === 'dependency_cycle'),
    'a dependency cycle → dependency_cycle')

  // socket-type compatibility semantics (validation.py): exact / '*' / union.
  ok(contract.socketTypeCompatible('LATENT', 'LATENT') === true, 'socket types: exact match')
  ok(contract.socketTypeCompatible('IMAGE', '*') === true, 'socket types: Any accepts everything')
  ok(contract.socketTypeCompatible('STRING,BOOLEAN', 'STRING,INT') === true, 'socket types: union overlap (non-strict)')
  ok(contract.socketTypeCompatible('CLIP', 'VAE') === false, 'socket types: disjoint unions reject')
})

// ---------------------------------------------------------------------------
// (c) every builder validates against the real schemas — the corpus
// ---------------------------------------------------------------------------
/** The builder corpus: [label, graph] pairs from every graph-emitting lane. */
function buildCorpus() {
  const corpus = []
  // H3 image workbench matrix — against the REAL fixture (full-availability
  // engine: hybrid loader + form adapter + klein nodes + the H3 Image
  // Studio pack all served — the pack-conditioned lanes' native habitat).
  for (const entry of H3IMG_MATRIX) {
    corpus.push([`h3img:${entry.name}`, h3image.buildH3ImageGraph(entry.request, entry.models, REAL_INFO)])
  }
  // The PACK-ABSENT stock fallback (afvlbk4): the same matrix against the
  // fixture MINUS the Image Studio classes — packets keep the stock
  // conditioning (5/39 native, 9/13 the ledgered snap), and the T=1 /
  // fast-sharp lanes THROW instead of building (asserted separately below —
  // the stock length:1 emission is dead).
  const STOCK_ONLY_INFO = { ...REAL_INFO }
  for (const classType of ['H3ImagePrepare', 'H3TextToImagePrepare', 'H3ImageToImagePrepare', 'H3ReferenceEditPrepare', 'H3ImageDecode']) delete STOCK_ONLY_INFO[classType]
  for (const entry of H3IMG_MATRIX) {
    if (entry.request.family === 'h3img.generate.t1' || entry.request.family === 'h3img.generate.sharp') continue
    corpus.push([`h3img-stock:${entry.name}`, h3image.buildH3ImageGraph(entry.request, entry.models, STOCK_ONLY_INFO)])
  }
  // Krea 2 edit matrix.
  const krea2 = loadTs('src/lib/graph/krea2edit.ts')
  for (const entry of KREA2_MATRIX) {
    corpus.push([`krea2:${entry.name}`, krea2.buildKrea2Graph(entry.options, entry.models)])
  }
  // The video factory across the mode/tier/chain/stack surface.
  const models = { fl2va: 'fl2va.safetensors', ref2va: 'ref2va.safetensors', textEncoder: 'qwen.safetensors', videoVae: 'video-vae.safetensors', audioVae: 'audio-vae.safetensors', fl2vLora: 'fl-turbo.safetensors', ref2vLora: 'ref-turbo.safetensors' }
  const wf = (label, options, uploads) => corpus.push([`video:${label}`, workflow.buildMiniMaxWorkflow(options, models, uploads)])
  wf('text-base', { mode: 'text', width: 1344, height: 768, prompt: 'p', duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match' }, { images: [], videos: [], audios: [] })
  wf('image-frames-turbo8', { mode: 'image', width: 352, height: 608, prompt: 'p', duration: 3, seed: 2, steps: 20, turbo: '8', sampler: 'heun', scheduler: 'karras', filenamePrefix: 't', refImageSize: 'match' }, { first: { name: 'first.png' }, last: { name: 'last.png' }, images: [], videos: [], audios: [] })
  wf('reference-full', { mode: 'reference', width: 768, height: 768, prompt: 'p', duration: 8, seed: 3, steps: 20, turbo: '4', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'max', sigmaShift: { video: 12, audio: 3 }, timelineGuides: [{ file: { name: 'guide.png' }, seconds: 1.5, frameIndex: 36 }] }, { images: [{ name: 'ref.png' }], videos: [{ name: 'ref.mp4' }], audios: [{ name: 'ref.flac' }], guides: [{ name: 'guide.png' }] })
  wf('experimental-sampling', { mode: 'text', width: 1344, height: 768, prompt: 'p', duration: 5, seed: 4, steps: 20, turbo: '8', experimentalSampling: true, sampler: 'er_sde', scheduler: 'sgm_uniform', filenamePrefix: 't', refImageSize: 'match', sigmaShift: { video: 12, audio: 3 } }, { images: [], videos: [], audios: [] })
  wf('chain-start', { mode: 'text', width: 1344, height: 768, prompt: 'p', duration: 5, seed: 5, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match', chain: { index: 0, folder: 'chain/a' } }, { images: [], videos: [], audios: [] })
  wf('chain-continuation', { mode: 'reference', width: 1344, height: 768, prompt: 'p', duration: 5, seed: 6, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match', chain: { index: 2, folder: 'chain/a', contextLength: '39', audioContextLength: 24, loadFrom: { folder: 'chain/a', clipIndex: 1 } } }, { images: [{ name: 'ref.png' }], videos: [], audios: [] })
  wf('lora-stack', { mode: 'text', width: 1344, height: 768, prompt: 'p', duration: 5, seed: 7, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match', loraStack: [{ name: 'style.safetensors', strength: 0.7 }, { name: 'motion.safetensors', strength: 1 }] }, { images: [], videos: [], audios: [] })
  // The audio cores.
  const music3Models = { diffusion: 'm3.safetensors', textEncoder: 'm3-te.safetensors', vae: 'm3-dav.safetensors' }
  corpus.push(['music3:tiled', music3.buildMusic3Workflow({ caption: 'Global Metadata: lo-fi', lyrics: '', duration: 90, seed: 42, tiledDecode: true, filenamePrefix: 'a' }, music3Models)])
  corpus.push(['music3:full', music3.buildMusic3Workflow({ caption: 'x', lyrics: '', duration: 60, seed: 1, tiledDecode: false, filenamePrefix: 'a' }, music3Models)])
  // (The acestep corpus arms were removed with the engine, 2026-09-21 —
  // nn5ld47; lib/aceStepWorkflow.ts deleted, git history is the archive.)
  return corpus
}

/** divergence-id signatures — how each ledger entry manifests as a validator
 *  violation (semantic-class entries manifest in section (d) instead).
 *  EMPTY since afvlbk4: h3img.t1-length-1 — the ledger's namesake — RETIRED
 *  when the T=1 Fast family stopped submitting stock length:1 (the pack's
 *  conditioning is the only path; the builder throws when the pack is
 *  absent). The whole corpus must now validate CLEAN against the real
 *  schemas; any new violation is a new divergence to ledger or fix. */
const SIGNATURES = {}

test('(c) every builder validates: violations match the known-divergence ledger EXACTLY', () => {
  const corpus = buildCorpus()
  ok(corpus.length >= 20, `the corpus covers every builder lane (${corpus.length} graphs)`)

  const fired = new Set()
  const unexplained = []
  for (const [label, graph] of corpus) {
    const violations = contract.validateGraphAgainstSchemas(graph, REAL_INFO)
    for (const violation of violations) {
      const id = Object.keys(SIGNATURES).find((divergenceId) => SIGNATURES[divergenceId](violation))
      if (id) fired.add(id)
      else unexplained.push(`${label}: ${violation.type} ${violation.classType}.${violation.inputName ?? ''} — ${violation.message}`)
    }
  }
  ok(unexplained.length === 0, `no UNKNOWN violations across the corpus (a new divergence must be ledgered or fixed):\n${unexplained.join('\n')}`)

  // THE RETIREMENT PROOF (afvlbk4): no graph in the corpus carries a stock
  // conditioning length the engine would refuse — the stock length:1 path
  // is dead. The pack-conditioned lanes emit the pack's Prepare classes
  // instead, and even the pack-absent fallback never builds them.
  for (const [label, graph] of corpus) {
    for (const node of Object.values(graph)) {
      if (node.class_type !== 'MiniMaxH3ImageToVideo' && node.class_type !== 'MiniMaxH3ReferenceToVideo') continue
      ok(node.inputs.length >= 5, `${label}: stock conditioning length ${node.inputs.length} ≥ 5 (the length:1 emission is dead)`)
    }
  }

  // Ledger freshness: every schema-class divergence the ledger records still
  // fires somewhere, and the signature table covers exactly the ledger's
  // schema-refused entries (plus the silent-drop entry proven in (d)).
  const schemaClassLedger = semantics.KNOWN_DIVERGENCES.filter((entry) => entry.violationType === 'schema-refused').map((entry) => entry.id)
  assert.deepEqual(
    JSON.parse(JSON.stringify(Object.keys(SIGNATURES).sort())),
    JSON.parse(JSON.stringify(schemaClassLedger.sort())),
    'the signature table and the ledger\'s schema-refused entries are the same set (both empty since the t1-length-1 retirement)',
  )
  passed += 1
  console.log('  ok - the signature table and the ledger\'s schema-refused entries are the same set (both empty since the t1-length-1 retirement)')
  for (const id of schemaClassLedger) {
    ok(fired.has(id), `ledger entry still fires (retire it when fixed): ${id}`)
  }
})

// ---------------------------------------------------------------------------
// (d) semantic rules — the reinterpretation ledger
// ---------------------------------------------------------------------------
test('(d) semantic rules: the grid, the promotion, the slice window, emitted lengths honored-or-ledgered', () => {
  // The engine's own math, mirrored and swept.
  for (let n = 1; n <= 200; n += 1) {
    const aligned = semantics.h3AlignFrameCount(n)
    ok(aligned >= 5 && (aligned - 5) % 17 === 0 && aligned >= n, `align(${n}) = ${aligned} lands on the 17k+5 grid at or above the request`)
    if (n >= 6 && n <= 21) assert.equal(aligned, 22, `the 7-slice window: every length ${n} renders as 22`)
    if (n >= 23 && n <= 38) assert.equal(aligned, 39, `every length ${n} in 23..38 renders as 39`)
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(semantics.h3NativeFrameCounts(100))),
    JSON.parse(JSON.stringify([5, 22, 39, 56, 73, 90])),
    'native grid points: 5/22/39/56/...',
  )
  passed += 1
  console.log('  ok - native grid points: 5/22/39/56/...')
  ok(semantics.h3TemporalSlices(9) === 7 && semantics.h3TemporalSlices(13) === 7 && semantics.h3TemporalSlices(5) === 2 && semantics.h3TemporalSlices(22) === 7 && semantics.h3TemporalSlices(39) === 12,
    "slice counts (video_latent_t mirrored): 9 and 13 both carry the 22-frame packet's 7 slices; 5→2, 22→7, 39→12")

  // The video factory's duration ladder is grid-true (the already-correct lane).
  for (const seconds of [2, 3, 5, 8, 15]) {
    ok(semantics.isH3NativeFrameCount(workflow.frameCount(seconds)), `frameCount(${seconds}) = ${workflow.frameCount(seconds)} is a grid point the engine honors as requested`)
  }

  // Emitted H3 conditioning lengths across the corpus: honored, or exactly
  // the ledgered semantic divergences — the PACK-ABSENT stock fallback's
  // tiers 9/13 (they snap to 22 there; the pack-served corpus arms carry no
  // stock length at all, and T=1 never submits stock nodes in either
  // direction — it throws without the pack).
  const semanticDivergences = []
  for (const [label, graph] of buildCorpus()) {
    for (const node of Object.values(graph)) {
      if (node.class_type !== 'MiniMaxH3ImageToVideo' && node.class_type !== 'MiniMaxH3ReferenceToVideo') continue
      const length = node.inputs.length
      if (semantics.isH3NativeFrameCount(length)) continue
      semanticDivergences.push(`${label}: length ${length}`)
    }
  }
  const expectedSemantic = []
  for (const entry of H3IMG_MATRIX) {
    if (entry.request.family === 'h3img.generate.t1' || entry.request.family === 'h3img.generate.sharp') continue
    if (entry.request.tier === 9) expectedSemantic.push(`h3img-stock:${entry.name}: length 9`)
    if (entry.request.tier === 13) expectedSemantic.push(`h3img-stock:${entry.name}: length 13`)
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(semanticDivergences.sort())),
    JSON.parse(JSON.stringify(expectedSemantic.sort())),
    'emitted off-grid lengths are EXACTLY the ledgered stock-fallback set (pack arms emit no stock length; 9/13 snap only on the fallback; T=1 never submits stock)',
  )
  passed += 1
  console.log('  ok - emitted off-grid lengths are EXACTLY the ledgered stock-fallback set')

  // The silent-drop proof, retired (music3.bitrate-unknown-input): music3
  // once emitted bitrate: 'V0' — a key SaveAudioAdvanced never declared, so
  // the engine dropped it silently and the mp3 default landed by luck. The
  // builder now emits the mp3 key's REAL sub-input; the dead key must never
  // return.
  const music3Graph = music3.buildMusic3Workflow({ caption: 'x', lyrics: '', duration: 60, seed: 1, tiledDecode: true, filenamePrefix: 'a' }, { diffusion: 'm3.safetensors', textEncoder: 'm3-te.safetensors', vae: 'm3-dav.safetensors' })
  ok(!('bitrate' in music3Graph['9'].inputs) && music3Graph['9'].inputs.quality === 'V0', 'music3 emits the mp3 key\'s real sub-input quality (the dead bitrate key is retired)')
  ok(!('bitrate' in REAL_INFO.SaveAudioAdvanced.input.required) && !('bitrate' in (REAL_INFO.SaveAudioAdvanced.input.optional ?? {})),
    'SaveAudioAdvanced declares no bitrate input — the engine fact that made the old key a silent drop')

  // The chain machinery's context lengths are the served enum exactly.
  const contextEnum = REAL_INFO.MiniMaxH3MotionContext.input.required.context_length[0]
  assert.deepEqual(JSON.parse(JSON.stringify(contextEnum)), JSON.parse(JSON.stringify(['22', '5', '39', '56'])), 'MotionContext serves the grid points as its context_length enum')
  passed += 1
  console.log('  ok - MotionContext serves the grid points as its context_length enum')

  // Ledger hygiene: unique ids, provenance pinned.
  const ids = semantics.KNOWN_DIVERGENCES.map((entry) => entry.id)
  ok(new Set(ids).size === ids.length, 'divergence ids are unique')
  ok(semantics.ENGINE_SEMANTICS_PROVENANCE.engineRevision === 'a87667f72f5fad094b74b10dc9c9f82faea728ef', 'the semantic ledger pins its evidence revision')
})

// ---------------------------------------------------------------------------
// (e) the fake engine graduates
// ---------------------------------------------------------------------------
test('(e) e2e/fakeEngineInfo serves the REAL captured schemas for stock classes', () => {
  const fakeEngine = loadTs('e2e/fakeEngineInfo.ts')
  const info = fakeEngine.stockObjectInfo()
  for (const className of preflightModule.STOCK_GRAPH_CLASSES) {
    ok(info[className] !== undefined, `fake engine serves stock class ${className}`)
  }
  const served = info.MiniMaxH3ImageToVideo
  ok(served && served.input && served.input.required && served.input.required.length && served.input.required.length[1].min === 5,
    'the fake engine serves the REAL length schema (min 5) — e2e inherits contract truth')
  ok(Array.isArray(info.KSamplerSelect.input.required.sampler_name[1].options) && info.KSamplerSelect.input.required.sampler_name[1].options.includes('res_multistep'),
    'the fake engine serves real sampler enums')
  // Extras still win (the Wave-1 contract), including bare-object overrides.
  const withExtras = fakeEngine.stockObjectInfo({ MiniMaxH3HybridLoader: {}, KSamplerSelect: { custom: 'shape' } })
  ok(JSON.stringify(withExtras.MiniMaxH3HybridLoader) === '{}', 'pack extras still ride the bare-object shape')
  ok(withExtras.KSamplerSelect.custom === 'shape', 'later extras still WIN over the real schemas')

  // The graduated fake stays preflight-clean AND contract-clean for a stock graph.
  const graph = workflow.buildMiniMaxWorkflow(
    { mode: 'text', width: 1344, height: 768, prompt: 'p', duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 't', refImageSize: 'match' },
    { fl2va: 'fl2va.safetensors', ref2va: 'ref2va.safetensors', textEncoder: 'qwen.safetensors', videoVae: 'video-vae.safetensors', audioVae: 'audio-vae.safetensors', fl2vLora: 'fl.safetensors', ref2vLora: 'ref.safetensors' },
    { images: [], videos: [], audios: [] },
  )
  ok(preflightModule.preflightGraph(graph, info).length === 0, 'a stock graph preflights clean against the graduated fake')
  ok(contract.validateGraphAgainstSchemas(graph, info).length === 0, 'a stock graph is contract-clean against the graduated fake')
})

test('suite tally', () => {
  console.log(`\nengine-contract: ${passed} assertions passed`)
  ok(passed > 200, `the contract layer asserts substantively (${passed} assertions)`)
})
