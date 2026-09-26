'use strict'
/** Shared golden-matrix definition for the H3 image workbench probes in
 * tests/h3img.test.js — the h3img counterpart of lib/registry-matrix.cjs
 * and lib/krea2edit-matrix.cjs.
 *
 * Every entry names a buildH3ImageGraph invocation whose CURRENT output is
 * snapshotted into scripts/fixtures/h3img-golden.json by
 * `pnpm test:h3img:update`. The test rebuilds each
 * config and requires canonical equality — a family change is a golden
 * diff, reviewed like any contract change.
 *
 * Extra invariants riding this matrix:
 *  - THE MAMAD8 FACTORY GUARD: every multi-frame golden decodes through the
 *    STOCK video VAE (no VAELoader naming the T=1 file); the T=1 golden is
 *    the only one carrying it;
 *  - AUDIT CLEAN: every built graph passes h3imgGraphAudit (no video-only
 *    nodes in still graphs, ≤9 ref slots, ≤2 LoRA loaders, the per-frame
 *    publish set matches the tier).
 *
 * Configs are deterministic: fixed seeds/prefixes, no clocks. Filenames are
 * the verified engine-side names. */

const H3IMG_MODELS = {
  fl2va: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  ref2va: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  textEncoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
  t1ImageVae: 'minimax_h3_t1_image_vae_step1597.safetensors',
  turboLora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  detailAdapterLora: 'MaxiMin-HHH-R2V-ThisIsFine.safetensors',
  krea2: null,
  klein: {
    unet: 'flux-2-klein-9b-fp8.safetensors',
    textEncoder: 'qwen_3_8b_fp8mixed.safetensors',
    vae: 'full_encoder_small_decoder.safetensors',
  },
}

const CONTRACT = [
  'A lone hiker on a granite ridge at dawn, layered mist below.',
  '',
  'subject_definitions:',
  '<Picture 1> — the identity anchor: face, proportions, skin, hairline, distinguishing marks (native transport).',
  '<Picture 2> — the pose reference — arms raised in triumph (semantic transport).',
  '',
  'Ownership contract:',
  'Keep the identity and pose from <Picture 1>. Use the body pose and limb positions from <Picture 2>.',
  '',
  'Preservation of unspecified traits: Preserve all unspecified traits from <Picture 1>: identity, wardrobe, environment, camera framing, and lighting stay; only the requested change lands.',
  '',
  'A short, nearly still 5-frame sequence depicting this single scene; one frame will be selected as the final image.',
  '',
  'Change nothing else.',
].join('\n')

const base = (overrides) => ({
  family: 'h3img.generate.packet',
  prompt: CONTRACT,
  width: 1344,
  height: 768,
  seed: 90210,
  tier: 5,
  refs: [],
  loras: [],
  filenamePrefix: 'h3img/test',
  ...overrides,
})

const matrix = []

// 0. Generate packet — stock profile (no hybrid loader in info): anchored
//    source as first_frame on FL2VA, 5-frame publish set.
matrix.push({ name: 'generate-packet-5-stock', request: base({ source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'stock' })

// 1. Generate packet — hybrid profile (the runtime-merge loader present).
matrix.push({ name: 'generate-packet-5-hybrid', request: base({ source: 'source-anchored.png', loras: [{ name: 'civitai_h3_style.safetensors', strength: 0.6 }] }), models: H3IMG_MODELS, info: 'hybrid' })

// 2-3. Tiers 9 and 13.
matrix.push({ name: 'generate-packet-9-hybrid', request: base({ tier: 9, source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'hybrid' })
matrix.push({ name: 'generate-packet-13-hybrid', request: base({ tier: 13, source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'hybrid' })

// 2s-3s. The SAME tiers with the H3 Image Studio pack served (afvlbk4): the
// conditioning + decode route through the pack's Prepare/H3ImageDecode —
// the EXACT 9/13 latent ladder (t=3/t=4), no stock length on any node, no
// audio-VAE loader (the pack latent carries zero audio rows).
matrix.push({ name: 'generate-packet-9-studio', request: base({ tier: 9, source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'studio' })
matrix.push({ name: 'generate-packet-13-studio', request: base({ tier: 13, source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'studio' })

// 4. Directed 39 — reference conditioning with the source as Picture 1.
matrix.push({ name: 'generate-directed-39', request: base({ family: 'h3img.generate.packet.directed', tier: 39, source: 'source-anchored.png', refs: [{ name: 'donor.png', role: 'subject', transport: 'native' }] }), models: H3IMG_MODELS, info: 'hybrid' })

// 5. T=1 Fast — the pinned recipe (turbo @0.75 + detail @0.5, er_sde/
//    sgm_uniform 8 steps, shifts 12/3, the Mamad8 VAE — single frame),
//    STUDIO-conditioned since afvlbk4: the pack's Prepare builds the legal
//    t=1 latent (their I2I_SINGLE wiring — the one-frame preset switches
//    I2I to Picture-1 reference conditioning inside the node) and
//    H3ImageDecode decodes the single frame through the Mamad8 VAE.
matrix.push({ name: 'generate-t1', request: base({ family: 'h3img.generate.t1', tier: 1, source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'studio' })

// 5s. Fast-sharp — the pack's single_latent_slice decode: a 5-frame sampling
//    context (the video VAE encodes the Prepare's references) with ONE
//    latent slice decoded through the Mamad8 image VAE; one published frame.
matrix.push({ name: 'generate-sharp-5', request: base({ family: 'h3img.generate.sharp', tier: 5, source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'studio' })

// 5f-5fs. THE E-FS1 FIZGIG ARMS (task 464xfvd — the Fizgig-H3-Still
//    challenge, docs/research/fizgig-h3-still-assessment.md): flag-ON
//    builds only (the flag defaults to 'image-studio', so every entry above
//    is byte-identical — the zero-default-drift proof). The 'fizgig' info
//    serves the two Fizgig classes WITHOUT the Image Studio pack: the lane
//    must not depend on it (stock conditioning kept legal at length 5, the
//    latent from FizgigH3StillLatent, the decode through
//    FizgigH3StillDecode + the VIDEO VAE — no Mamad8 loader anywhere).
//    5f is their T2I example's shape (I2V conditioning); 5fs is the
//    source-anchored form (REF conditioning + the audio VAE the stock REF
//    node requires).
matrix.push({ name: 'generate-t1-fizgig', request: base({ family: 'h3img.generate.t1', tier: 1 }), models: H3IMG_MODELS, info: 'fizgig', options: { t1Latent: 'fizgig', t1Decode: 'fizgig' } })
matrix.push({ name: 'generate-t1-fizgig-source', request: base({ family: 'h3img.generate.t1', tier: 1, source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'fizgig', options: { t1Latent: 'fizgig', t1Decode: 'fizgig' } })

// 6. Compose — 3 ordered refs with roles (the merge).
matrix.push({ name: 'compose-refs-3', request: base({ family: 'h3img.compose.refs', refs: [
  { name: 'identity.png', role: 'subject', transport: 'native' },
  { name: 'pose.png', role: 'pose', transport: 'semantic' },
  { name: 'lighting.png', role: 'lighting', transport: 'semantic' },
] }), models: H3IMG_MODELS, info: 'hybrid' })

// 7. Edit identity — source anchored as Picture 1 + donor ref (native).
matrix.push({ name: 'edit-identity', request: base({ family: 'h3img.edit.identity', source: 'source-anchored.png', refs: [{ name: 'donor.png', role: 'subject', transport: 'native' }] }), models: H3IMG_MODELS, info: 'hybrid' })

// 7s. The SAME edit with the pack served — H3ReferenceEditPrepare wiring
//     (source → source_image = Picture 1, donor → reference_image_2,
//     native transport, max-identity reference detail).
matrix.push({ name: 'edit-identity-studio', request: base({ family: 'h3img.edit.identity', source: 'source-anchored.png', refs: [{ name: 'donor.png', role: 'subject', transport: 'native' }] }), models: H3IMG_MODELS, info: 'studio' })

// 8. Edit pose — poserig-render class ref (semantic transport).
matrix.push({ name: 'edit-pose', request: base({ family: 'h3img.edit.pose', source: 'source-anchored.png', refs: [{ name: 'poserig-pose-896x1600.png', role: 'pose', transport: 'semantic' }] }), models: H3IMG_MODELS, info: 'hybrid' })

// 9. klein refine — the official-template port (no H3 nodes at all).
matrix.push({ name: 'refine-klein', request: { family: 'h3img.refine.klein', prompt: 'sharpen the hair and foliage microtexture', width: 1344, height: 768, seed: 90210, refs: [], loras: [], filenamePrefix: 'h3img/test-refine', source: 'frame-2.png', refineInstruction: 'sharpen the hair and foliage microtexture' }, models: H3IMG_MODELS, info: 'klein' })

// 10. The CANVAS INLINE H3-1F still (34afx79) — the image intent's text→still
//     as the offline plan probe builds it: the store's CANVAS_T1_TEST_SELECTION
//     (TEST names mirror this exactly), the generated no-refs T=1 contract,
//     tier pinned to the profile's single frame, stock info (the probe builds
//     against the live engine's object-info; offline = stock).
const CANVAS_T1_MODELS = {
  fl2va: 'TEST-fl2va.safetensors',
  ref2va: 'TEST-ref2va.safetensors',
  textEncoder: 'TEST-qwen3vl.safetensors',
  videoVae: 'TEST-video-vae.safetensors',
  audioVae: 'TEST-audio-vae.safetensors',
  t1ImageVae: 'TEST-minimax_h3_t1_image_vae.safetensors',
  turboLora: 'TEST-fl2v-turbo-8step.safetensors',
  detailAdapterLora: 'TEST-detail-adapter.safetensors',
  krea2: null,
  klein: { unet: '', textEncoder: '', vae: '' },
}
const CANVAS_T1_CONTRACT = [
  'a lighthouse over a black sea, still',
  '',
  'Preservation of unspecified traits: Preserve the subject\'s identity and the overall scene; the requested change is a large pose/composition move, so framing may reshape around it (keep-dial 0.55 — the documented band for large moves).',
  '',
  'A single still image.',
  '',
  'Change nothing else.',
].join('\n')
// Since afvlbk4 the T=1 lane is pack-conditioned: the plan-probe arm builds
// against a pack-served engine (the live engine the canvas probe targets
// has the pack; a pack-absent engine makes the lane REFUSE, which the
// suite's detection section asserts separately).
matrix.push({ name: 'canvas-t1-inline', request: { family: 'h3img.generate.t1', prompt: CANVAS_T1_CONTRACT, width: 1344, height: 768, seed: 4242, tier: 1, refs: [], loras: [], filenamePrefix: 'images/H3IMG_plan' }, models: CANVAS_T1_MODELS, info: 'studio' })

module.exports = { H3IMG_MATRIX: matrix, H3IMG_MODELS, H3IMG_CONTRACT: CONTRACT }
