'use strict'
/** Shared golden-matrix definition for scripts/test-registry.cjs.
 *
 * The matrix is the single source of truth for the inertness probe: every
 * entry names a buildMiniMaxWorkflow invocation (options + models + uploads)
 * whose CURRENT output is snapshotted into scripts/fixtures/registry-golden.json
 * by `node scripts/test-registry.cjs --update-golden` (run against pre-registry
 * code when the fixture is first created). The test then rebuilds each config
 * with the registry-era builder and requires deep equality — an optimization
 * entry that is not selected may never perturb the base graph.
 *
 * Configs are deterministic: fixed seeds, fixed filename prefixes, no clocks. */

const MODELS = {
  fl2va: 'fl2va', ref2va: 'ref2va', textEncoder: 'clip', videoVae: 'video', audioVae: 'audio',
  fl2vLora: 'fl-lora', ref2vLora: 'ref-lora',
}

const NO_LORA_MODELS = { ...MODELS, fl2vLora: '', ref2vLora: '' }

const image = (name, subfolder) => (subfolder ? { name, subfolder } : { name })
const noUploads = { images: [], videos: [], audios: [] }
const base = {
  prompt: 'neutral test', width: 352, height: 608, seed: 123, steps: 20,
  sampler: 'heun', scheduler: 'karras', refImageSize: 'match',
}

function config(name, options, models = MODELS, uploads = noUploads) {
  return { name, options: { ...base, filenamePrefix: 'test', ...options }, models, uploads }
}

const matrix = []

// 1. The engine×duration×turbo×ltx surface (mirrors the pre-registry suite).
for (const mode of ['text', 'image', 'frames', 'reference']) {
  for (const duration of [2, 5, 15]) {
    matrix.push(config(`ltx-${mode}-${duration}s`, {
      mode, duration, turbo: '8',
      upscale: { type: 'ltx', model: 'ltx-upscale', vae: 'ltx-vae' },
    }, MODELS, mode === 'image' || mode === 'frames'
      ? { first: image('first.png'), last: mode === 'frames' ? image('last.png') : undefined, images: [], videos: [], audios: [] }
      : mode === 'reference'
        ? { images: [image('ref.png'), image('ref2.png', 'sub\\dir')], videos: [], audios: [] }
        : noUploads))
  }
}

// 2. Full-quality native path.
matrix.push(config('native-quality', { mode: 'text', duration: 5, turbo: 'off', steps: 30, width: 1344, height: 768 }))

// 3. Turbo 4 (FL2V + Ref2V) with and without strength override.
matrix.push(config('turbo4-text', { mode: 'text', duration: 5, turbo: '4' }))
matrix.push(config('turbo4-reference', { mode: 'reference', duration: 5, turbo: '4', refImageSize: 'max' }, MODELS, { images: [image('ref.png')], videos: [image('clip.mp4')], audios: [image('track.flac')] }))
matrix.push(config('turbo8-strength', { mode: 'text', duration: 5, turbo: '8', loraStrength: 0.9 }))

// 4. Turbo requested but no LoRA file present (the loader is skipped).
matrix.push(config('turbo8-no-lora', { mode: 'text', duration: 5, turbo: '8' }, NO_LORA_MODELS))

// 5. Experimental sampling + custom sigma shift + turbo (compat surface).
matrix.push(config('compat-experimental', {
  mode: 'text', duration: 5, turbo: '8', experimentalSampling: true, sampler: 'euler', scheduler: 'beta',
  sigmaShift: { video: 12, audio: 4 }, loraStrength: 0.9,
}))

// 6. H3 preview override (live-preview fast path).
matrix.push(config('preview-override', {
  mode: 'reference', duration: 5, turbo: 'off', steps: 20, sampler: 'res_multistep', scheduler: 'simple',
  previewOverride: { frames: 50, fps: 12, nodeType: 'MiniMaxH3PreviewOverride', vaeName: 'taeh3_decoder.safetensors', jpegQuality: 85 },
}, MODELS, { images: [image('ref.png')], videos: [], audios: [] }))

// 7. Every post-processing branch at both step regimes.
matrix.push(config('rtx-turbo4', { mode: 'text', duration: 2, turbo: '4', width: 608, height: 352, upscale: { type: 'rtx', model: 'RealESRGAN_x2.pth' } }))
matrix.push(config('lbh2d-turbo8', { mode: 'text', duration: 5, turbo: '8', upscale: { type: 'lbh2d', model: 'upscaler_2d.safetensors' } }))
matrix.push(config('lbh3d-quality', { mode: 'text', duration: 5, turbo: 'off', steps: 30, upscale: { type: 'lbh3d', model: 'minimax_h3_latent_upscaler_3d_fp16.safetensors' } }))

// 8. Motion-context chaining: chain start and continuation.
matrix.push(config('chain-start', { mode: 'text', duration: 5, turbo: 'off', chain: { index: 0, folder: 'h3_context/c1/clip' } }))
matrix.push(config('chain-continue', { mode: 'text', duration: 5, turbo: 'off', chain: { index: 2, folder: 'h3_context/c1/clip', contextLength: '22', audioContextLength: 24 } }))

// 9. Timeline guides chained onto reference conditioning.
matrix.push(config('timeline-guides', {
  mode: 'reference', duration: 6, turbo: 'off', timelineGuides: [{ frameIndex: 36 }, { frameIndex: 72 }, { frameIndex: 120 }],
}, MODELS, { images: [image('a.png')], videos: [], audios: [], guides: [image('g1.png'), image('g2.png'), image('g3.png')] }))

// 10. Stacked surface: turbo + guides + chain continuation + LBH + preview.
matrix.push(config('stacked', {
  mode: 'reference', duration: 6, turbo: '4', previewOverride: { frames: 24, fps: 12, nodeType: 'MiniMaxH3PreviewOverride' },
  timelineGuides: [{ frameIndex: 24 }], chain: { index: 1, folder: 'h3_context/c2/clip' },
  upscale: { type: 'lbh2d', model: 'upscaler_2d.safetensors' },
}, MODELS, { images: [image('a.png')], videos: [], audios: [], guides: [image('g.png')] }))

module.exports = { GOLDEN_MATRIX: matrix }
