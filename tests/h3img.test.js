/** H3 Image Workbench test suite (task k9vu6t0, VM harness — no engine).
 *
 * Probes, in the house verifier tradition:
 *  (a) GOLDEN SNAPSHOTS — every matrix config in lib/h3img-matrix.cjs
 *      rebuilds canonically equal to fixtures/h3img-golden.json
 *      (`MINIMAX_UPDATE_GOLDEN=1 vitest run h3img` re-snapshots; review the
 *      diff — the fixture IS the contract).
 *  (b) RECIPE PINS — the pinned defaults table (T=1 recipe verbatim, hybrid
 *      window, tiers, directed tail, keep band, LoRA ceilings, SeedVR2
 *      trims, klein operating point, scorer weights).
 *  (c) THE MAMAD8 FACTORY GUARD (AC8, with the failing-without-it proof):
 *      the video factory THROWS when the T=1 VAE would decode frames > 1;
 *      the audit flags a built multi-frame graph carrying it; every packet
 *      golden decodes through the stock video VAE; the T=1 build is the
 *      only legal carrier (single frame).
 *  (d) TRANSPORTS + CONTRACTS — the completed auto-per-role table; the
 *      generated ownership contract (roles, keep wording bands, per-picture
 *      overrides, directed settle line, the closing clause) — generated,
 *      never hand-written.
 *  (e) SCORER — deterministic; crafted frames (sharp beats blurred,
 *      exposure extremes penalized, drift penalized, directed tail
 *      restriction, tie → earlier frame).
 *  (f) BURST-FUSE + TONE-LOCK — never-worse fallback fires under the gate;
 *      an aligned sharp neighbor sharpens the target (variance up,
 *      low-frequency structure intact); tone-lock keeps the target's tones.
 *  (g) VRAM STAGING — the stage plan frees between stages; SeedVR2 loads
 *      only into a freed state; the executor seam is injectable.
 *  (h) SESSION MODEL — tolerant settings reads, take frame projections,
 *      canonical frame pointer (manual pick beats the scorer's auto-pick),
 *      the session contract.
 *  (i) VALIDATION + DETECTION — beyond-9 refusal, LoRA slot cap, the
 *      32-px grid, availability gating with install guidance.
 *  (j) PACKET ATTRIBUTION — extractAllOutputFiles collects EVERY frame
 *      output in order (never just the first).
 *
 * Vitest port (task z7ogmig, 2026-09-20) of scripts/test-h3img.cjs:
 * assertion bodies carry over verbatim; the linear probes became one test
 * each (sequential within the file). */
import { test } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadTs } = require('../scripts/lib/ts-vm.cjs')
const { H3IMG_MATRIX, H3IMG_MODELS, H3IMG_CONTRACT } = require('../scripts/lib/h3img-matrix.cjs')

const FIXTURE = path.resolve(__dirname, '..', 'scripts', 'fixtures', 'h3img-golden.json')

// Golden regeneration: `MINIMAX_UPDATE_GOLDEN=1 pnpm test:h3img` (vitest
// swallows forwarded CLI flags, so the env var is the cross-platform form).
const UPDATE_GOLDEN = process.argv.includes('--update-golden') || process.env.MINIMAX_UPDATE_GOLDEN === '1'
const maybe = UPDATE_GOLDEN ? test.skip : test
const updateMaybe = UPDATE_GOLDEN ? test : test.skip

const h3image = loadTs('src/lib/graph/h3image.ts')
const workflow = loadTs('src/lib/workflow.ts')
const contractModule = loadTs('src/lib/h3imageContract.ts')
const scorerModule = loadTs('src/lib/h3imageScorer.ts')
const opsModule = loadTs('src/lib/h3imageOps.ts')
const stagingModule = loadTs('src/lib/h3imageStaging.ts')
const sessionModule = loadTs('src/images/session.ts')

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

/** Canonical JSON (sorted keys, no undefined) — the graph's observable form. */
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
// Mock engine surfaces
// ---------------------------------------------------------------------------
const node = (input) => ({ input: { required: input } })
const STOCK_INFO = {
  KSamplerSelect: node({ sampler_name: [['res_multistep', 'er_sde', 'euler']] }),
  BasicScheduler: node({ scheduler: [['simple', 'sgm_uniform']] }),
  VAELoader: node({ vae_name: [[H3IMG_MODELS.videoVae, H3IMG_MODELS.t1ImageVae]] }),
}
const HYBRID_INFO = {
  ...STOCK_INFO,
  MiniMaxH3HybridLoader: node({}),
  MiniMaxH3LoraFormLoader: node({}),
}
// The H3 Image Studio pack served (afvlbk4): hybrid + the five load-bearing
// classes — the studio-conditioned lanes (T=1, fast-sharp, exact 9/13
// packets) key on this.
const STUDIO_INFO = {
  ...HYBRID_INFO,
  H3ImagePrepare: node({}),
  H3TextToImagePrepare: node({}),
  H3ImageToImagePrepare: node({}),
  H3ReferenceEditPrepare: node({}),
  H3ImageDecode: node({}),
}
const KLEIN_INFO = {
  ...STOCK_INFO,
  EmptyFlux2LatentImage: node({}),
  Flux2Scheduler: node({}),
  ReferenceLatent: node({}),
  GetImageSize: node({}),
  ImageScaleToTotalPixels: node({}),
  ConditioningZeroOut: node({}),
}
const INFO_FOR = { stock: STOCK_INFO, hybrid: HYBRID_INFO, studio: STUDIO_INFO, klein: KLEIN_INFO }

const model = (name, kind) => ({ name, kind, bytes: 1000 })
const MODEL_FILES = [
  model(H3IMG_MODELS.fl2va, 'diffusion_models'),
  model(H3IMG_MODELS.ref2va, 'diffusion_models'),
  model(H3IMG_MODELS.textEncoder, 'text_encoders'),
  model(H3IMG_MODELS.videoVae, 'vae'),
  model(H3IMG_MODELS.audioVae, 'vae'),
  model(H3IMG_MODELS.t1ImageVae, 'vae'),
  model(H3IMG_MODELS.turboLora, 'loras'),
  model(H3IMG_MODELS.detailAdapterLora, 'loras'),
  model('flux-2-klein-9b-fp8.safetensors', 'diffusion_models'),
  model('qwen_3_8b_fp8mixed.safetensors', 'text_encoders'),
  model('full_encoder_small_decoder.safetensors', 'vae'),
  model('civitai_h3_style.safetensors', 'loras'),
]

const buildFor = (entry) => h3image.buildH3ImageGraph(entry.request, entry.models, INFO_FOR[entry.info ?? 'stock'])

updateMaybe('--update-golden: re-snapshot the h3img fixture from the CURRENT builder', () => {
  const snapshot = {}
  for (const entry of H3IMG_MATRIX) {
    const graph = buildFor(entry)
    const violations = h3image.h3imgGraphAudit(graph)
    eq(violations, [], `audit clean: ${entry.name}`)
    snapshot[entry.name] = canon(graph)
  }
  fs.writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n')
  console.log(`  golden fixture written: ${FIXTURE} (${Object.keys(snapshot).length} graphs) — review the git diff`)
})

maybe('(a) golden snapshots — the build contract', () => {
  const goldens = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  const snapshot = {}
  for (const entry of H3IMG_MATRIX) {
    const graph = buildFor(entry)
    const violations = h3image.h3imgGraphAudit(graph)
    eq(violations, [], `audit clean: ${entry.name}`)
    snapshot[entry.name] = canon(graph)
    eq(snapshot[entry.name], goldens[entry.name], `golden equality: ${entry.name}`)
  }
})

maybe('(b) recipe pins — the pinned-defaults table', () => {
  eq(h3image.H3IMG_RECIPE_PINS.packetTiers, [5, 9, 13, 39], 'packet tiers 5/9/13 + directed 39')
  // The packet-economy truth (d4er4ati): on stock nodes align_frame_count
  // snaps 9 and 13 onto the 17n+5 grid's 22 — only 5 and 39 are native
  // points. The labels at the choice point carry these true costs.
  eq(h3image.STOCK_SAMPLED_FRAMES, { 5: 5, 9: 22, 13: 22, 39: 39 }, 'stock sampled frames: 5/22/22/39 (9 and 13 snap to 22)')
  eq(h3image.packetTierLabel(5), '5 frames', 'tier 5 label: native grid point, no qualifier')
  eq(h3image.packetTierLabel(9), '9 frames · samples 22 on stock nodes', 'tier 9 label carries the true sampled count')
  eq(h3image.packetTierLabel(13), '13 frames · samples 22 on stock nodes', 'tier 13 label carries the true sampled count')
  eq(h3image.packetTierLabel(39), '39 frames', 'tier 39 label: native grid point, no qualifier')
  // The pack-aware labels (afvlbk4): with the Image Studio pack served the
  // tiers ride its EXACT latent ladder — the honest cost note becomes the
  // exactness note.
  eq(h3image.packetTierLabel(9, true), '9 frames · exact through the Image Studio ladder', 'tier 9 label, pack served: exact')
  eq(h3image.packetTierLabel(13, true), '13 frames · exact through the Image Studio ladder', 'tier 13 label, pack served: exact')
  eq(h3image.packetTierLabel(5, true), '5 frames', 'tier 5 label, pack served: native on both paths')
  // The pack's frame presets — verbatim members of the served enum (the
  // engine-contract fixture carries the real captured options).
  eq(h3image.H3_IMAGE_STUDIO_FRAME_PRESETS, { 1: 'single image | 1 frame (image VAE)', 5: 'recommended | 5 frames', 9: 'extended quality | 9 frames', 13: 'high quality | 13 frames' }, 'the pack frame presets, verbatim (1/5/9/13; 39 has no preset — directed stays stock)')
  eq(h3image.H3IMG_RECIPE_PINS.sharp.contextTiers, [5, 9, 13], 'fast-sharp context tiers 5/9/13')
  eq(h3image.H3IMG_RECIPE_PINS.sharp.latentIndex, 0, 'fast-sharp pinned head slice')
  eq(h3image.H3IMG_RECIPE_PINS.sharp.spatialDecode, 'native', 'fast-sharp native spatial decode')
  eq(h3image.H3IMG_RECIPE_PINS.directedTail, { first: 34, last: 38 }, 'directed tail frames 34-38')
  eq(h3image.H3IMG_RECIPE_PINS.t1.steps, 8, 'T=1 steps 8')
  eq(h3image.H3IMG_RECIPE_PINS.t1.sampler, 'er_sde', 'T=1 sampler er_sde')
  eq(h3image.H3IMG_RECIPE_PINS.t1.scheduler, 'sgm_uniform', 'T=1 scheduler sgm_uniform')
  eq(h3image.H3IMG_RECIPE_PINS.t1.turboStrength, 0.75, 'T=1 turbo @0.75')
  eq(h3image.H3IMG_RECIPE_PINS.t1.detailAdapterStrength, 0.5, 'T=1 detail adapter @0.5')
  eq(h3image.H3IMG_RECIPE_PINS.t1.shiftVideo, 12, 'T=1 shift video 12')
  eq(h3image.H3IMG_RECIPE_PINS.t1.shiftAudio, 3, 'T=1 shift audio 3')
  eq(h3image.H3IMG_RECIPE_PINS.hybrid, { preset: 'block_range_adaln', blockStart: 25, blockEnd: 49 }, 'hybrid b25-49 runtime merge')
  eq(h3image.H3IMG_RECIPE_PINS.keepDial.largeMoveBand, [0.5, 0.6], 'keep dial large-move band 0.50-0.60')
  eq(h3image.H3IMG_RECIPE_PINS.lora, { slots: 2, healthyCombinedMax: 0.9, collapseRisk: 1.05 }, 'LoRA slots + combined-strength guidance bands')
  eq(h3image.H3IMG_RECIPE_PINS.seedvr2.trims, { 20: 17, 39: 37 }, 'SeedVR2 head-side trims 20→17, 39→37')
  eq(h3image.H3IMG_RECIPE_PINS.klein, { steps: 4, cfg: 1, sampler: 'euler', megapixels: 1, upscaleMethod: 'lanczos' }, 'klein official-template operating point')
  eq(h3image.seedvr2BatchCount(5), 5, 'SeedVR2 batch: 5 rides as-is')
  eq(h3image.seedvr2BatchCount(39), 37, 'SeedVR2 batch: 39 trims to 37 (tail preserved)')
  eq(h3image.H3IMG_RECIPE_PINS.scorer.sharpness, 0.5, 'scorer: sharpness dominates')
})

maybe('(b2) the merged checkpoint lane (rq0lsax) — one pre-merged file, plain loader', () => {
  // The merged override pick feeds the hybrid-loader LINE as ONE plain
  // UNETLoader: the weights already carry the b25-49 merge, so re-running the
  // runtime-merge machinery would mmap the same file twice for nothing.
  // Failing-without-it: on the pre-split builder no merged selection field
  // existed — this graph would carry MiniMaxH3HybridLoader with the merged
  // file as BOTH base and overlay instead of the single plain loader.
  {
    const mergedName = 'TenStrip_10Eros-Max_beta5_int8.safetensors'
    const request = { family: 'h3img.generate.packet', prompt: H3IMG_CONTRACT, width: 1344, height: 768, seed: 90210, tier: 5, refs: [], loras: [], filenamePrefix: 'h3img/merged' }
    const graph = h3image.buildH3ImageGraph(request, { ...H3IMG_MODELS, merged: mergedName }, HYBRID_INFO)
    const modelNodes = Object.values(graph).filter((n) => n.class_type === 'UNETLoader' || n.class_type === 'MiniMaxH3HybridLoader')
    ok(modelNodes.length === 1 && modelNodes[0].class_type === 'UNETLoader', 'the merged pick loads through ONE plain UNETLoader — no runtime merge over an already-merged file')
    eq(modelNodes[0].inputs.unet_name, mergedName, 'the loader carries the merged file')
    eq(h3image.h3imgGraphAudit(graph), [], 'the merged-lane graph passes the audit')
    // Control: with the merged field UNSET the hybrid loader still runs — the
    // merged slot changes nothing until set ("unused unless needed").
    const hybridGraph = h3image.buildH3ImageGraph(request, H3IMG_MODELS, HYBRID_INFO)
    ok(Object.values(hybridGraph).some((n) => n.class_type === 'MiniMaxH3HybridLoader'), 'unset merged keeps the runtime-merge hybrid loader (stock behavior unchanged)')
    const hybridNode = Object.values(hybridGraph).find((n) => n.class_type === 'MiniMaxH3HybridLoader')
    eq(hybridNode.inputs.base_model, H3IMG_MODELS.fl2va, 'hybrid base stays the FL2VA pick')
    eq(hybridNode.inputs.overlay_model, H3IMG_MODELS.ref2va, 'hybrid overlay stays the Ref2VA pick')
  }
})

maybe('(c) the Mamad8 factory guard (AC8) — enforced, not documented', () => {
  // c.1 THE FAILING-WITHOUT-IT PROOF: the VIDEO factory must throw when the
  // T=1 VAE would decode a multi-frame render. Without the guard this build
  // succeeds and ships patch-grid ghosting as quality — the test fails.
  {
    const selection = { fl2va: H3IMG_MODELS.fl2va, ref2va: H3IMG_MODELS.ref2va, textEncoder: H3IMG_MODELS.textEncoder, videoVae: H3IMG_MODELS.t1ImageVae, audioVae: H3IMG_MODELS.audioVae, previewVae: '', fl2vLora: '', ref2vLora: '' }
    assert.throws(
      () => workflow.buildMiniMaxWorkflow({ mode: 'text', prompt: 'x', width: 1344, height: 768, duration: 6, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 'guard', referenceImages: [], referenceVideos: [], referenceAudios: [] }, selection, { images: [], videos: [], audios: [] }),
      /T=1 image VAE/,
      'the video factory THROWS on the T=1 VAE (frames > 1)',
    )
    passed += 1
    console.log('  ok - the video factory THROWS on the T=1 VAE (frames > 1)')
    // …and the same selection with the STOCK video VAE builds fine.
    const stockGraph = workflow.buildMiniMaxWorkflow({ mode: 'text', prompt: 'x', width: 1344, height: 768, duration: 6, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 'guard', referenceImages: [], referenceVideos: [], referenceAudios: [] }, { ...selection, videoVae: H3IMG_MODELS.videoVae }, { images: [], videos: [], audios: [] })
    ok(Boolean(stockGraph['19']), 'the same video selection with the stock VAE builds (guard is name-specific, not blanket)')
  }
  // c.2 The guard primitive itself: frames 1 legal, frames > 1 refused.
  assert.throws(() => h3image.assertNoT1ImageVaeInVideoGraph(H3IMG_MODELS.t1ImageVae, 5), /never decode multi-frame/, 'guard throws at 5 frames')
  passed += 1
  console.log('  ok - guard throws at 5 frames')
  h3image.assertNoT1ImageVaeInVideoGraph(H3IMG_MODELS.t1ImageVae, 1)
  h3image.assertNoT1ImageVaeInVideoGraph(H3IMG_MODELS.videoVae, 39)
  passed += 2
  console.log('  ok - guard allows the single-frame profile + the stock VAE at any count')
  // c.3 The AUDIT re-checks built graphs: a hand-assembled multi-frame graph
  // carrying the T=1 loader is flagged.
  {
    const badGraph = {
      '1': { class_type: 'VAELoader', inputs: { vae_name: H3IMG_MODELS.t1ImageVae } },
      '700': { class_type: 'ImageFromBatch', inputs: { batch_index: 0 } },
      '701': { class_type: 'ImageFromBatch', inputs: { batch_index: 1 } },
    }
    const violations = h3image.h3imgGraphAudit(badGraph)
    ok(violations.some((line) => line.includes('T=1 image VAE')), 'audit flags the T=1 VAE in a 2-frame graph')
  }
  // c.4 Every PACKET golden decodes through the STOCK video VAE — no VAELoader
  // anywhere in a multi-frame-pUBLISH graph names the T=1 file. The T=1 and
  // fast-sharp lanes are the legal carriers (they publish exactly one frame:
  // the T=1 latent, or ONE decoded slice of the sharp context); klein is a
  // different engine entirely.
  for (const entry of H3IMG_MATRIX) {
    if (entry.name === 'generate-t1' || entry.name === 'generate-sharp-5' || entry.name === 'refine-klein') continue
    const graph = buildFor(entry)
    const loaders = Object.entries(graph).filter(([, value]) => value.class_type === 'VAELoader').map(([, value]) => value.inputs.vae_name)
    ok(loaders.every((name) => !h3image.T1_IMAGE_VAE_PATTERN.test(name)), `no T=1 VAE in ${entry.name} (video VAE only)`)
  }
  // c.5 The T=1 build IS the carrier: exactly one VAELoader, naming the T=1
  // VAE (the pack path never loads the audio VAE — its latent carries zero
  // audio rows), publishing exactly ONE frame through H3ImageDecode.
  {
    const graph = buildFor(H3IMG_MATRIX.find((entry) => entry.name === 'generate-t1'))
    const loaders = Object.values(graph).filter((value) => value.class_type === 'VAELoader')
    eq(loaders.filter((loader) => h3image.T1_IMAGE_VAE_PATTERN.test(String(loader.inputs.vae_name))).length, 1, 'T=1 graph: exactly one loader names the Mamad8 VAE')
    eq(loaders.length, 1, 'T=1 graph: the T1 decoder is the ONLY VAE loader (no audio VAE on the pack path)')
    const saves = Object.values(graph).filter((value) => value.class_type === 'SaveImage')
    eq(saves.length, 1, 'T=1 graph: exactly one frame published')
    const decode = Object.values(graph).find((value) => value.class_type === 'H3ImageDecode')
    ok(decode !== undefined && decode.inputs.decode_mode === undefined, 'T=1 graph: the pack decode in temporal mode (one frame, no slice switch)')
  }
  // c.6 The fast-sharp build: the T=1 VAE decodes exactly ONE slice — two
  // loaders total (video VAE encodes the Prepare's references, T1 VAE decodes
  // the slice), one published frame, decode_mode single_latent_slice.
  {
    const graph = buildFor(H3IMG_MATRIX.find((entry) => entry.name === 'generate-sharp-5'))
    const loaders = Object.values(graph).filter((value) => value.class_type === 'VAELoader')
    eq(loaders.length, 2, 'fast-sharp graph: exactly two VAE loaders (video encode + T1 slice decode)')
    eq(loaders.filter((loader) => h3image.T1_IMAGE_VAE_PATTERN.test(String(loader.inputs.vae_name))).length, 1, 'fast-sharp graph: exactly one loader names the Mamad8 VAE')
    const decode = Object.values(graph).find((value) => value.class_type === 'H3ImageDecode')
    eq(decode.inputs.decode_mode, 'single_latent_slice', 'fast-sharp graph: single_latent_slice decode mode')
    eq(decode.inputs.latent_index, 0, 'fast-sharp graph: the pinned head slice')
    eq(decode.inputs.spatial_decode, 'native', 'fast-sharp graph: native spatial decode')
    eq(Object.values(graph).filter((value) => value.class_type === 'SaveImage').length, 1, 'fast-sharp graph: exactly one frame published')
    const violations = h3image.h3imgGraphAudit(graph)
    eq(violations, [], 'fast-sharp graph: audit clean (the T1 VAE decodes one slice — the publish count is 1)')
  }
})

maybe('(d) transports + the generated contract', () => {
  eq(h3image.TRANSPORT_FOR_ROLE, { subject: 'native', pose: 'semantic', style: 'semantic', lighting: 'semantic', background: 'semantic', freeform: 'native' }, 'the completed auto-per-role transport table (audit m2: outfit-class refs ride subject/native)')
  {
    const composed = contractModule.composeWorkbenchPrompt({
      familyId: 'h3img.edit.pose',
      instruction: 'Repose the climber with arms raised in triumph.',
      refs: [{ role: 'pose', note: 'arms raised' }],
      sourceAnchored: true,
      keepDial: 0.55,
      keepOverrides: { 2: 0.2 },
      tier: 39,
    })
    ok(composed.includes('Repose the climber'), 'contract carries the intent')
    ok(composed.includes('<Picture 1> — the source image'), 'contract anchors the source as Picture 1')
    ok(composed.includes('pose reference'), 'contract scopes the pose slot')
    ok(composed.includes('Lock from <Picture 1>: identity, wardrobe, scene, lighting, lens, and framing'), 'pose family lock template')
    ok(composed.includes('documented band for large moves'), 'keep-dial band wording at 0.55')
    ok(composed.includes('<Picture 2>: Loose preservation'), 'per-picture override wording rides')
    ok(composed.includes('change completes by 65% of the sequence'), 'directed settle line at tier 39')
    ok(composed.trim().endsWith('Change nothing else.'), 'the closing change-nothing-else clause')
    const outfit = contractModule.composeWorkbenchPrompt({ familyId: 'h3img.edit.outfit', instruction: 'Swap the jacket.', refs: [{ role: 'subject' }], sourceAnchored: true, keepDial: 0.8 })
    ok(outfit.includes('wardrobe reference'), 'outfit family scopes subject-transport refs to the garment')
    ok(outfit.includes('only the named garment'), 'outfit family change template')
    ok(contractModule.keepWording(0.9).includes('exactly as in <Picture 1>'), 'high keep = full lock wording')
    ok(contractModule.BEYOND_NINE_GUIDANCE.includes('9 native references'), 'the honest beyond-9 statement exists for the surface')
  }
})

// Shared crafted-frame builders for (e) and (f).
const frame = (width, height, paint) => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}
const checker = (width, height, size, offset = 0) => frame(width, height, (x, y) => {
  const cell = (Math.floor((x + offset) / size) + Math.floor(y / size)) % 2
  return cell ? [230, 230, 230] : [25, 25, 25]
})

maybe('(e) the first-party scorer — deterministic, crafted frames', () => {
  {
    const W = 128
    const H = 128
    const sharp = checker(W, H, 4)
    const soft = frame(W, H, () => [128, 128, 128])
    const dark = frame(W, H, () => [4, 4, 4])
    const verdict = scorerModule.scoreFrames([soft, sharp, dark])
    eq(verdict.bestIndex, 1, 'crafted: the sharp checkerboard beats flat and crushed frames')
    ok(verdict.reason.includes('sharpest'), 'the verdict names its reason')
    eq(verdict.scores.length, 3, 'every frame scored (provenance complete)')
    const again = scorerModule.scoreFrames([soft, sharp, dark])
    eq(verdict.scores.map((score) => score.total).join('|'), again.scores.map((score) => score.total).join('|'), 'deterministic: identical verdict on re-run')
    // Temporal stability within one packet: frames 0-1 are a still pair,
    // frame 2 drifts hard — normalized stability ranks the still pair at 1
    // and the drifter at 0.
    const still = frame(W, H, (x, y) => [128 + (x % 16), 128, 128 - (y % 16)])
    const drifted = frame(W, H, (x, y) => [128 + ((x + 40) % 16), 128, 128 - ((y + 48) % 16)])
    const stabilityVerdict = scorerModule.scoreFrames([still, still, still, drifted])
    ok(stabilityVerdict.scores[0].stability === 1 && stabilityVerdict.scores[1].stability === 1, 'the still interior ranks fully stable')
    ok(stabilityVerdict.scores[3].stability === 0, 'the end drifter ranks fully unstable')
    // Directed tail: 39 frames, the winner must come from 34-38.
    const frames39 = []
    for (let i = 0; i < 39; i += 1) frames39.push(i === 3 ? checker(W, H, 4) : frame(W, H, () => [128, 128, 128]))
    const tail = scorerModule.scoreFrames(frames39, { directedTail: true })
    ok(tail.bestIndex >= 34 && tail.bestIndex <= 38, 'directed tail restriction: the sharpest frame at index 3 is NOT picked from a 39-frame packet')
    ok(tail.scores.length === 39, 'directed tail still scores every frame')
    // Tie → earlier frame.
    const tied = scorerModule.scoreFrames([frame(W, H, () => [100, 100, 100]), frame(W, H, () => [100, 100, 100])])
    eq(tied.bestIndex, 0, 'ties break toward the earlier frame')
    // Reference affinity: the frame matching the reference's color space wins.
    const reference = frame(32, 32, () => [200, 40, 40])
    const reddish = frame(W, H, () => [190, 50, 50])
    const blueish = frame(W, H, () => [40, 40, 200])
    const affinity = scorerModule.scoreFrames([blueish, reddish], { referenceFrames: [reference] })
    eq(affinity.bestIndex, 1, 'color-space affinity to the subject reference contributes')
  }
})

maybe('(f) burst-fuse + tone-lock — the app-side DSP', () => {
  {
    const W = 96
    const H = 96
    const varianceOf = (image) => {
      const lumas = []
      for (let i = 0; i < image.data.length; i += 4) lumas.push(image.data[i])
      const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length
      return lumas.reduce((acc, value) => acc + (value - mean) * (value - mean), 0) / lumas.length
    }
    // A realistic packet pair: the same smooth scene (a gradient), the target
    // carrying soft detail (amplitude ~3) and the neighbor a sharper
    // high-frequency band (amplitude ~12) at the SAME alignment — tiles agree
    // under the drift gate, so the fuse borrows the neighbor's detail band.
    const gradient = (x, y) => 110 + Math.floor(((x + y) % 48) * 0.8)
    const softTarget = frame(W, H, (x, y) => { const base = gradient(x, y); return [base + ((x % 2 < 1) ? 3 : -3), base, base] })
    const sharperNeighbor = frame(W, H, (x, y) => { const base = gradient(x, y); return [base + ((x % 2 < 1) ? 12 : -12), base, base] })
    const fused = opsModule.burstFuse(softTarget, [sharperNeighbor])
    ok(!fused.report.fallback, 'an aligned, gate-passing neighbor fuses (no fallback)')
    ok(varianceOf(fused.image) > varianceOf(softTarget), 'the fused frame is sharper than the soft target')
    // Misaligned neighbors: the gate rejects everywhere; the output IS the
    // target (never-worse), byte-identical.
    const target = frame(W, H, (x) => (x % 8 < 4 ? [140, 140, 140] : [110, 110, 110]))
    const misaligned = checker(W, H, 4, 64)
    const fallback = opsModule.burstFuse(target, [misaligned, checker(W, H, 16, 128)])
    ok(fallback.report.fallback, 'never-worse fallback fires when coverage is under the gate')
    eq(canon(Array.from(fallback.image.data)), canon(Array.from(target.data)), 'fallback output IS the target, byte-identical')
    // Tone-lock: the target's tones stay authoritative.
    // A refiner that shifted the tonal center (a warm push) AND added
    // detail — tone-lock must keep the target's center.
    const refined = frame(W, H, (x) => (x % 8 < 4 ? [170, 170, 170] : [100, 100, 100]))
    const locked = opsModule.toneLockBlend(target, refined)
    const meanOf = (image) => {
      let sum = 0
      let count = 0
      for (let i = 0; i < image.data.length; i += 4) {
        sum += image.data[i]
        count += 1
      }
      return sum / count
    }
    ok(Math.abs(meanOf(locked.image) - meanOf(target)) < Math.abs(meanOf(refined) - meanOf(target)), 'tone-lock keeps the target\'s tonal center')
    eq(opsModule.TONE_LOCK_PINS, { lockStrength: 0.85, detailStrength: 0.55, detailRadius: 32 }, 'tone-lock pins (the astropuzzo recipe values)')
  }
})

maybe('(g) VRAM staging — the 24 GB discipline', () => {
  {
    const plan = stagingModule.stagePlan([
      { familyId: 'h3img.generate.packet' },
      { familyId: 'h3img.refine.krea2' },
      { familyId: 'h3img.burst.fuse' },
      { familyId: 'h3img.exit.anchor' },
    ])
    eq(plan.map((step) => step.freeBefore), [false, true, false, true], 'Generate → free → Refine → (app op needs no free) → free → Exit')
    ok(plan[1].reason.includes('engine change'), 'the engine-change reason names the transition')
    const seedvr2Plan = stagingModule.stagePlan([{ familyId: 'h3img.generate.packet' }, { familyId: 'h3img.burst.seedvr2' }])
    ok(seedvr2Plan[1].freeBefore && seedvr2Plan[1].reason.includes('freed state'), 'SeedVR2 loads only into a freed state')
  }
})

maybe('(h) the session model', () => {
  {
    const defaults = sessionModule.readSessionSettings(null)
    eq(defaults.family, 'h3img.generate.packet', 'default family: the packet')
    ok(typeof defaults.seed === 'number' && defaults.seed >= 0, 'default seed is a number')
    const tolerant = sessionModule.readSessionSettings({ family: 'h3img.edit.pose', intent: 'repose', tier: 9, keepDial: 0.55, loras: [{ name: 'a.safetensors', strength: 1.2 }, { name: 'b.safetensors', strength: 0.4 }, { name: 'c.safetensors', strength: 1 }], refs: [{ id: 'r1', role: 'pose', transport: 'semantic', keepOverride: 0.2, note: '', source: { kind: 'file', path: '/tmp/pose.png', name: 'pose.png' } }], framePicks: { take1: 3 } })
    eq(tolerant.loras.length, 2, 'LoRA slots capped at 2 on read')
    eq(tolerant.refs[0].role, 'pose', 'ref role read')
    ok(tolerant.refs[0].transportOverride === true || tolerant.refs[0].transport === 'semantic', 'expert transport override survives the read')
    const take = {
      id: 'take1',
      outputId: 'out1',
      jobId: null,
      artifacts: ['/outputs/frame0.png', '/outputs/frame1.png', '/outputs/frame2.png'],
      latentPath: null,
      metrics: { kind: 'image', h3img: { family: 'h3img.generate.packet', profile: 'packet', tier: 5, frames: 3, prompt: 'p', refs: [], loras: [], seed: 1, resolution: '1344x768', hybrid: true, scorer: { bestIndex: 2, reason: 'sharpest', metricBasis: 'pixel metrics' }, canonicalFrameIndex: 2 } },
      createdAt: 1,
      supersededBy: null,
      evicted: false,
      contentHash: null,
    }
    eq(sessionModule.takeFrames(take).length, 3, 'take frames project all artifacts')
    eq(sessionModule.canonicalFrameIndex(take, {}), 2, "canonical pointer: the scorer's auto-pick")
    eq(sessionModule.canonicalFrameIndex(take, { take1: 0 }), 0, 'manual pick beats the scorer (always overridable)')
    ok(sessionModule.sessionContract(tolerant).includes('repose'), 'the session contract composes from settings')
    ok(sessionModule.isWorkbenchChain({ kind: sessionModule.H3IMG_CHAIN_KIND }), 'chain kind check')
  }
})

maybe('(i) validation + detection', () => {
  {
    const info = HYBRID_INFO
    const over = { family: 'h3img.compose.refs', prompt: H3IMG_CONTRACT, width: 1344, height: 768, seed: 1, tier: 5, refs: [], loras: [], filenamePrefix: 'x' }
    assert.throws(() => h3image.buildH3ImageGraph({ ...over, refs: Array.from({ length: 10 }, (_unused, index) => ({ name: `r${index}.png`, role: 'subject', transport: 'native' })) }, H3IMG_MODELS, info), /Beyond 9 references/, 'beyond-9 is a hard refusal at build')
    passed += 1
    console.log('  ok - beyond-9 is a hard refusal at build')
    assert.throws(() => h3image.buildH3ImageGraph({ ...over, loras: [{ name: 'a', strength: 1 }, { name: 'b', strength: 1 }, { name: 'c', strength: 1 }] }, H3IMG_MODELS, info), /2 LoRA slots|At most 2/, 'LoRA slot cap enforced at build')
    passed += 1
    console.log('  ok - LoRA slot cap enforced at build')
    assert.throws(() => h3image.buildH3ImageGraph({ ...over, width: 1345 }, H3IMG_MODELS, info), /32-px grid/, 'canvas must sit on the 32-px grid')
    passed += 1
    console.log('  ok - canvas must sit on the 32-px grid')
    assert.throws(() => h3image.buildH3ImageGraph({ family: 'h3img.burst.seedvr2', prompt: 'x', width: 1344, height: 768, seed: 1, refs: [], loras: [], filenamePrefix: 'x' }, H3IMG_MODELS, info), /E-IW2/, 'the SeedVR2 arm refuses honestly behind its gate')
    passed += 1
    console.log('  ok - the SeedVR2 arm refuses honestly behind its gate')
    // Detection: hybrid present → packet available + hybrid; stock info (no
    // loader) with hybrid weights present → node in missingNodes.
    const detections = h3image.detectH3ImgFamilies(HYBRID_INFO, MODEL_FILES)
    const packet = detections.find((entry) => entry.family.id === 'h3img.generate.packet')
    ok(packet.detection.available && packet.detection.hybrid, 'packet: available + hybrid on the full stack')
    // THE ENGINE-TRUTH GATE, FLIPPED TO CAPABILITY (d4er4ati → afvlbk4):
    // pack ABSENT → the honest refusal (pack class + row + #15644 + the
    // fetch affordance) and the BUILDER ITSELF throws — the stock length:1
    // submission is dead, never emitted; pack PRESENT → the family is
    // AVAILABLE and renders through the pack's conditioning.
    const t1 = detections.find((entry) => entry.family.id === 'h3img.generate.t1')
    ok(!t1.detection.available, 'T=1: gated on stock-only engines (the pack is the legal path, issue #15644)')
    const t1Missing = t1.detection.missingNodes.join('\n')
    ok(t1Missing.includes('H3ImagePrepare') && t1Missing.includes('MiniMax H3 Image Studio') && t1Missing.includes('#15644'), 'T=1 refusal names the pack class, the pack row, and the stock-floor reason')
    ok(t1Missing.includes('Fetch') || t1Missing.includes('Node packs'), 'T=1 refusal carries the fetch/install affordance')
    // The stock length:1 path is DEAD: building T=1 against a pack-absent
    // engine refuses at build — no code path submits the illegal graph.
    assert.throws(() => h3image.buildH3ImageGraph({ family: 'h3img.generate.t1', prompt: 'x', width: 1344, height: 768, seed: 1, tier: 1, refs: [], loras: [], filenamePrefix: 'x' }, H3IMG_MODELS, HYBRID_INFO), /H3 Image Studio pack's conditioning|#15644/, 'T=1 build refuses without the pack — the stock length:1 emission is dead')
    passed += 1
    console.log('  ok - T=1 build refuses without the pack — the stock length:1 emission is dead')
    assert.throws(() => h3image.buildH3ImageGraph({ family: 'h3img.generate.sharp', prompt: 'x', width: 1344, height: 768, seed: 1, tier: 5, refs: [], loras: [], filenamePrefix: 'x' }, H3IMG_MODELS, HYBRID_INFO), /H3 Image Studio pack's conditioning|#15644/, 'fast-sharp build refuses without the pack too')
    passed += 1
    console.log('  ok - fast-sharp build refuses without the pack too')
    const t1WithPack = h3image.detectH3ImgFamilies(STUDIO_INFO, MODEL_FILES).find((entry) => entry.family.id === 'h3img.generate.t1')
    ok(t1WithPack.detection.available, 'T=1 with the pack served: AVAILABLE (afvlbk4 — the gate flipped to capability)')
    ok(t1WithPack.detection.notes.some((note) => note.includes('H3 Image Studio pack detected')), 'T=1 pack-present detection carries the renders-through-its-conditioning note')
    const sharpWithPack = h3image.detectH3ImgFamilies(STUDIO_INFO, MODEL_FILES).find((entry) => entry.family.id === 'h3img.generate.sharp')
    ok(sharpWithPack.detection.available, 'fast-sharp with the pack served: available (same needs as T=1)')
    const sharpNoPack = h3image.detectH3ImgFamilies(HYBRID_INFO, MODEL_FILES).find((entry) => entry.family.id === 'h3img.generate.sharp')
    ok(!sharpNoPack.detection.available && sharpNoPack.detection.missingNodes.join('\n').includes('H3ImagePrepare'), 'fast-sharp without the pack: the honest pack refusal')
    const klein = detections.find((entry) => entry.family.id === 'h3img.refine.klein')
    ok(!klein.detection.available, 'klein on the H3-only info: Flux2 nodes absent → unavailable with guidance')
    const kleinFull = h3image.detectH3ImgFamilies(KLEIN_INFO, MODEL_FILES).find((entry) => entry.family.id === 'h3img.refine.klein')
    ok(kleinFull.detection.available, 'klein: available when the trio + Flux2 nodes resolve (own engine, no H3 stack needed)')
    const stockDetections = h3image.detectH3ImgFamilies(STOCK_INFO, MODEL_FILES)
    const stockPacket = stockDetections.find((entry) => entry.family.id === 'h3img.generate.packet')
    ok(!stockPacket.detection.hybrid && stockPacket.detection.notes.some((note) => note.includes('Hybrid profile upgrade')), 'stock: the hybrid upgrade is named in the guidance notes (never a gate)')
    ok(stockPacket.detection.available, 'stock: the packet still runs (stock fallback) — availability is not hybrid-gated')
    const noT1 = h3image.detectH3ImgFamilies(HYBRID_INFO, MODEL_FILES.filter((file) => !file.name.includes('t1_image_vae')))
    ok(!noT1.find((entry) => entry.family.id === 'h3img.generate.t1').detection.available, 'T=1 unavailable without the Mamad8 VAE (honest gating)')
    // T=1 build refuses without the VAE (with the pack present, so the VAE
    // refusal is the one that fires — the pack refusal is proven above).
    assert.throws(() => h3image.buildH3ImageGraph({ family: 'h3img.generate.t1', prompt: 'x', width: 1344, height: 768, seed: 1, tier: 1, refs: [], loras: [], filenamePrefix: 'x' }, { ...H3IMG_MODELS, t1ImageVae: '' }, STUDIO_INFO), /T=1 image VAE/, 'T=1 build refuses without the Mamad8 VAE')
    passed += 1
    console.log('  ok - T=1 build refuses without the Mamad8 VAE')
    // Krea 2 refine resolves through the shared family machinery.
    const krea2Selection = loadTs('src/lib/graph/krea2edit.ts')
    const krea2Models = krea2Selection.resolveKrea2EditModels(MODEL_FILES.concat([
      model('krea2_turbo_int8_convrot.safetensors', 'diffusion_models'),
      model('qwen3vl_4b_fp8_scaled.safetensors', 'text_encoders'),
      model('qwen_image_vae.safetensors', 'vae'),
      model('krea2_identity_edit_v1_2.safetensors', 'loras'),
    ]))
    const krea2Graph = h3image.buildH3ImageGraph({ family: 'h3img.refine.krea2', prompt: 'sharpen the hair', width: 1024, height: 1024, seed: 5, refs: [], loras: [], filenamePrefix: 'refine', source: 'frame.png', refineInstruction: 'sharpen the hair' }, { ...H3IMG_MODELS, krea2: krea2Models }, HYBRID_INFO)
    ok(Object.values(krea2Graph).some((value) => value.class_type === 'Krea2EditModelPatch'), 'Krea 2 refine composes over the measured instruct family')
  }
})

maybe('(j) packet attribution + the stage executor seam — every frame, in order; one free per engine change', async () => {
  {
    const history = {
      prompt1: {
        outputs: {
          '700': { images: [{ filename: 'h3img_test_00001_.png', subfolder: '', type: 'output' }] },
          '701': { images: [{ filename: 'h3img_test_00002_.png', subfolder: '', type: 'output' }] },
          '702': { images: [{ filename: 'h3img_test_00003_.png', subfolder: '', type: 'output' }] },
        },
      },
    }
    const files = workflow.extractAllOutputFiles(history, 'prompt1', 'image')
    eq(files.map((file) => file.filename), ['h3img_test_00001_.png', 'h3img_test_00002_.png', 'h3img_test_00003_.png'], 'extractAllOutputFiles collects every frame in node order')
    eq(workflow.extractAllOutputFiles({}, 'missing', 'image'), [], 'missing history is an empty list, never a throw')
  }

  const frees = []
  const executor = stagingModule.createStageExecutor(async () => {
    frees.push(Date.now())
  })
  const ran = []
  await executor.run([{ familyId: 'h3img.generate.packet' }, { familyId: 'h3img.refine.klein' }], async (stage) => {
    ran.push(stage.familyId)
    return null
  })
  eq(frees.length, 1, 'the executor issued exactly one free (before the engine change)')
  eq(ran, ['h3img.generate.packet', 'h3img.refine.klein'], 'the executor ran both stages')
  const stopped = await executor.run([{ familyId: 'h3img.generate.packet' }, { familyId: 'h3img.refine.krea2' }, { familyId: 'h3img.exit.anchor' }], async (stage) => {
    if (stage.familyId === 'h3img.refine.krea2') throw new Error('engine refused')
    return null
  })
  eq(stopped.filter((result) => result && typeof result === 'object' && 'stagedError' in result).length, 1, 'a failing stage is reported, the sequence stops')
  console.log(`\nh3img: ${passed} checks passed`)
})
