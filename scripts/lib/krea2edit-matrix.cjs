'use strict'
/** Shared golden-matrix definition for the Krea 2 edit-family probes in
 * scripts/test-registry.cjs — the krea2edit counterpart of
 * lib/registry-matrix.cjs.
 *
 * Every entry names a buildKrea2Graph invocation whose CURRENT output is
 * snapshotted into scripts/fixtures/krea2edit-golden.json by
 * `node scripts/test-registry.cjs --update-golden`. The test then rebuilds
 * each config and requires canonical equality — a family change is a golden
 * diff, reviewed like any contract change.
 *
 * Two extra invariants ride on this matrix:
 *  - INERTNESS: stripping `edit` from any config must rebuild the ONE base
 *    t2i golden (all configs share base prompt/canvas/seed), so family
 *    registration can never perturb the base path;
 *  - RECIPE AUDIT: every built graph must pass krea2RecipeAudit (the
 *    encode/transport/LoRA triple, no t=0 carrier, no stacked patchers, no
 *    post-hoc composite).
 *
 * Configs are deterministic: fixed seeds, fixed prefixes, no clocks. Model
 * filenames are the verified publishers' names (HF/GitHub, 2026-09-14). */

const BASE = {
  prompt: 'a ceramic bowl of lemons on an oak table, morning light',
  width: 1024,
  height: 1024,
  seed: 424242,
  filenamePrefix: 'krea2/test',
}

const MODELS = {
  turbo: 'krea2_turbo_int8_convrot.safetensors',
  raw: 'krea2_raw_int8_convrot.safetensors',
  textEncoder: 'qwen3vl_4b_fp8_scaled.safetensors',
  vae: 'qwen_image_vae.safetensors',
  identityEditLora: 'krea2_identity_edit_v1_2.safetensors',
  anypaintLora: 'krea2_anypaint_rank32.safetensors',
}

const edit = (family, extra, editBase = {}) => ({ ...BASE, edit: { family, prompt: 'recolor the car to matte black', source: 'source.png', width: BASE.width, height: BASE.height, seed: BASE.seed, filenamePrefix: BASE.filenamePrefix, ...editBase, ...extra } })

const matrix = []

// 0. The base t2i graph — the inertness reference every family strips back to.
matrix.push({ name: 't2i-turbo-base', options: { ...BASE }, models: MODELS })

// 1. Instruct family: defaults, dials, the CFG>1 negative-grounding flip,
//    and the legacy fit geometry.
matrix.push({ name: 'instruct-default', options: edit('krea2edit.instruct'), models: MODELS })
matrix.push({ name: 'instruct-dials', options: edit('krea2edit.instruct', { groundingPx: 512, refBoost: 4, steps: 12 }), models: MODELS })
matrix.push({ name: 'instruct-cfg2-grounded-negative', options: edit('krea2edit.instruct', { cfg: 2.0, refBoost: 2 }), models: MODELS })
matrix.push({ name: 'instruct-fit-legacy', options: edit('krea2edit.instruct', { fitMode: 'crop (legacy)' }), models: MODELS })

// 2. Removal: the RAW/CFG-3/20-step variant (grounded negative is structural
//    here — CFG is pinned above 1 by the recipe itself).
matrix.push({ name: 'removal-raw-cfg3', options: edit('krea2edit.removal', { prompt: 'remove the fork and reconstruct the hand behind it' }), models: MODELS })

// 3. Two-reference person-into-scene: fixed order, 1–1.5MP canvas.
matrix.push({ name: 'two-ref-person-into-scene', options: edit('krea2edit.two-ref', { subject: 'person.png', width: 1216, height: 832, refBoostA: 1.5, prompt: 'create a photo of this man next to the tractor' }), models: MODELS })

// 4. AnyPaint masked refine (zero padding + Mask-Editor mask).
matrix.push({ name: 'refine-masked-default', options: edit('krea2edit.refine', { source: 'masked_source.png', prompt: 'a sunlit modern kitchen with a handmade ceramic bowl of lemons on the center island' }), models: MODELS })

// 5. AnyPaint outpaint: default symmetric padding; and the mixed
//    mask+padding form on the same family.
matrix.push({ name: 'outpaint-padding-default', options: edit('krea2edit.outpaint', { prompt: 'the path and flowering plants continuing naturally downward' }), models: MODELS })
matrix.push({ name: 'outpaint-mixed-mask-right512', options: edit('krea2edit.outpaint', { padding: { right: 512 }, mask: true, prompt: 'an original watercolor greenhouse, the garden continuing to the right' }), models: MODELS })

// 6. Low-VRAM fallback: the SVD-reduced _r64 cut resolved by the scan drives
//    the same instruct graph with a different lora_name.
matrix.push({
  name: 'instruct-lowvram-r64',
  options: edit('krea2edit.instruct'),
  models: { ...MODELS, identityEditLora: 'krea2_identity_edit_v1_2_r64.safetensors' },
})

module.exports = { KREA2_MATRIX: matrix, KREA2_BASE: BASE, KREA2_MODELS: MODELS }
