'use strict'
/** Shared golden-matrix definition for the H3 image workbench probes in
 * scripts/test-h3img.cjs — the h3img counterpart of lib/registry-matrix.cjs
 * and lib/krea2edit-matrix.cjs.
 *
 * Every entry names a buildH3ImageGraph invocation whose CURRENT output is
 * snapshotted into scripts/fixtures/h3img-golden.json by
 * `node scripts/test-h3img.cjs --update-golden`. The test rebuilds each
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

// 4. Directed 39 — reference conditioning with the source as Picture 1.
matrix.push({ name: 'generate-directed-39', request: base({ family: 'h3img.generate.packet.directed', tier: 39, source: 'source-anchored.png', refs: [{ name: 'donor.png', role: 'subject', transport: 'native' }] }), models: H3IMG_MODELS, info: 'hybrid' })

// 5. T=1 Fast — the pinned recipe (turbo @0.75 + detail @0.5, er_sde/
//    sgm_uniform 8 steps, shifts 12/3, the Mamad8 VAE — single frame).
matrix.push({ name: 'generate-t1', request: base({ family: 'h3img.generate.t1', tier: 1, source: 'source-anchored.png' }), models: H3IMG_MODELS, info: 'hybrid' })

// 6. Compose — 3 ordered refs with roles (the merge).
matrix.push({ name: 'compose-refs-3', request: base({ family: 'h3img.compose.refs', refs: [
  { name: 'identity.png', role: 'subject', transport: 'native' },
  { name: 'pose.png', role: 'pose', transport: 'semantic' },
  { name: 'lighting.png', role: 'lighting', transport: 'semantic' },
] }), models: H3IMG_MODELS, info: 'hybrid' })

// 7. Edit identity — source anchored as Picture 1 + donor ref (native).
matrix.push({ name: 'edit-identity', request: base({ family: 'h3img.edit.identity', source: 'source-anchored.png', refs: [{ name: 'donor.png', role: 'subject', transport: 'native' }] }), models: H3IMG_MODELS, info: 'hybrid' })

// 8. Edit pose — poserig-render class ref (semantic transport).
matrix.push({ name: 'edit-pose', request: base({ family: 'h3img.edit.pose', source: 'source-anchored.png', refs: [{ name: 'poserig-pose-896x1600.png', role: 'pose', transport: 'semantic' }] }), models: H3IMG_MODELS, info: 'hybrid' })

// 9. klein refine — the official-template port (no H3 nodes at all).
matrix.push({ name: 'refine-klein', request: { family: 'h3img.refine.klein', prompt: 'sharpen the hair and foliage microtexture', width: 1344, height: 768, seed: 90210, refs: [], loras: [], filenamePrefix: 'h3img/test-refine', source: 'frame-2.png', refineInstruction: 'sharpen the hair and foliage microtexture' }, models: H3IMG_MODELS, info: 'klein' })

module.exports = { H3IMG_MATRIX: matrix, H3IMG_MODELS, H3IMG_CONTRACT: CONTRACT }
