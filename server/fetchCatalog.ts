/**
 * Fetch catalog — the DATA half of the local-first fetcher (task hgjbea2).
 *
 * The doctrine (docs/architecture.md §Third-party components): optional
 * models/components are fetched ONLY on explicit user action; everything
 * fetchable has a consent flow with the license surfaced at consent time;
 * the user-fetch wrapper pattern covers anything unshippable. This module
 * is the registry of WHAT can be fetched — sources, pins, sizes, licenses
 * (reusing docs/LICENSES.md verdicts), and install destinations. It holds
 * no transport and performs no I/O: the fetch engine (server/fetcher.ts)
 * consumes it, the Settings surface renders it, and the integrity tests
 * police it (schema, license presence, destination validity).
 *
 * Seed policy — every entry is something our own research committed to:
 *  - the ENGINE_NODE_PACKS user-fetch list (facok NO-LICENSE, T8mars
 *    GPL-3.0, Larryvrh turbo Apache-2.0, krea2edit Apache-2.0, anypaint
 *    MIT), single-sourced from that registry (license verdicts live
 *    THERE, not duplicated here);
 *  - the Krea 2 edit-mode weights (task t8u00uu): the Identity Edit v1.2
 *    LoRA line + the AnyPaint rank-32 adapter that docs/research/
 *    krea2-edit-mode.md committed the edit families to;
 *  - experiment prerequisites from the committed research docs (Fun
 *    Control union checkpoint, DWPose/DA3/HED/MLSD preprocessor weights,
 *    OpenVDN stage files — docs/research/fun-control-input-surface.md,
 *    docs/research/speed-quality-and-imagegen-paths.md);
 *  - OPTIONAL items a preferred alternative exists for (smhfacct hybrid
 *    checkpoints — runtime merge via the HybridLoader is preferred over
 *    pre-merged checkpoints);
 *  - the reference ComfyUI revision for the managed runtime's
 *    clone-on-demand seam (task 3ay7wbz).
 *
 * Pin discipline (LICENSES.md §9.1): entries pin `sha | tag | branch`.
 * Branch pins are moving — the fetch engine resolves them to the HEAD SHA
 * at fetch time and stamps that SHA into the install record and the node
 * pack marker, never the branch string.
 *
 * Integrity pins below were verified against the Hugging Face / GitHub
 * APIs on 2026-09-14 (sizes + x-linked-etag sha256 for LFS files;
 * repository HEAD shas at catalog-authoring time).
 */
import { join, resolve } from 'node:path'
import type { AppSettings, FetchCatalogEntry, FetchDestination, FetchModelRoot, ModelKind } from '../src/types'
import { ENGINE_NODE_PACKS, findNodePack } from './engineNodes'

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** The six scanner kinds resolve through settings.paths; anything else is a
 *  ComfyUI folder name resolved under the configured model root. */
const SCANNER_KINDS = new Set<string>(['diffusion_models', 'text_encoders', 'vae', 'loras', 'vae_approx', 'clip_vision'])

/** Resolves a fetch model root to an absolute directory against the current
 *  settings. Scanner kinds use the user's configured root; extra roots
 *  (model_patches, vdn, geometry_estimation, …) sit under settings.modelRoot. */
export function fetchModelRootPath(root: FetchModelRoot, settings: AppSettings): string {
  if (SCANNER_KINDS.has(root)) return resolve((settings.paths as Record<string, string>)[root] ?? join(settings.modelRoot, root))
  return resolve(join(settings.modelRoot, root as Exclude<FetchModelRoot, ModelKind>))
}

/** Node-pack entries are assembled from ENGINE_NODE_PACKS so the license
 *  verdict + pin stay single-sourced (a drift between the two registries is
 *  a catalog integrity failure, tested). */
function nodePackEntry(packId: string): FetchCatalogEntry {
  const pack = findNodePack(packId)
  if (!pack) throw new Error(`fetch catalog: node-pack entry references unknown ENGINE_NODE_PACKS id "${packId}"`)
  return {
    id: `pack:${pack.id}`,
    name: pack.name,
    group: 'node-packs',
    description: pack.description,
    licenseSpdx: pack.licenseSpdx,
    licenseNote: pack.licenseNote,
    licenseUrl: pack.repoUrl,
    source: { kind: 'git', url: pack.repoUrl, revision: shaLike(pack.pinnedRevision) ? { kind: 'sha', value: pack.pinnedRevision } : { kind: 'branch', value: pack.pinnedRevision } },
    destination: { kind: 'node-pack', packId: pack.id },
    sizeClass: 'small',
    homepage: pack.homepage,
    packId: pack.id,
  }
}

/** A 40-hex string is a commit SHA; anything else (a branch or tag name) is
 *  treated as a branch by the fetch engine and resolved-and-stamped. */
function shaLike(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value)
}

export const FETCH_CATALOG: FetchCatalogEntry[] = [
  nodePackEntry('minimax-h3-turbo'),
  nodePackEntry('krea2-controlnet'),
  nodePackEntry('h3-audio-t8'),
  nodePackEntry('krea2edit'),
  nodePackEntry('krea2-anypaint'),
  nodePackEntry('ltxvideo'),
  nodePackEntry('kjnodes'),
  nodePackEntry('radiance'),
  // First-party pack (task k271ykk): installs from the studio's own
  // custom-nodes/ payload — the fetch engine short-circuits to a local
  // install and never touches the transport. License + repo stay
  // single-sourced from ENGINE_NODE_PACKS (the integrity test's invariant).
  {
    id: 'pack:lora-form-adapter',
    name: 'minimax-lora-form-adapter (first-party)',
    group: 'node-packs',
    description: 'The studio\'s own form-adaptive LoRA loader for MiniMax-H3 (MIT, our code): full-width→pruned adaln projection at load time. Installs from the studio\'s own payload — no download; the network is never touched for this entry (the source pin is provenance only). Also installable directly from the managed-engine node-packs settings.',
    licenseSpdx: 'MIT',
    licenseNote: 'Original work of this repo (custom-nodes/minimax-lora-form-adapter/LICENSE). Not a third-party fetch: localInstall.',
    licenseUrl: 'https://github.com/Cobdog/MINIMAX-DESKTOP/blob/main/custom-nodes/minimax-lora-form-adapter/LICENSE',
    source: { kind: 'git', url: 'https://github.com/Cobdog/MINIMAX-DESKTOP', revision: { kind: 'tag', value: 'v1.0.0' } },
    destination: { kind: 'node-pack', packId: 'lora-form-adapter' },
    sizeBytes: 80_000,
    sizeClass: 'small',
    homepage: 'https://github.com/Cobdog/MINIMAX-DESKTOP/tree/main/custom-nodes/minimax-lora-form-adapter',
    packId: 'lora-form-adapter',
    localInstall: true,
  },

  // ---- Krea 2 edit mode (task t8u00uu — Identity Edit as a feature) -----
  // Weights first: the two edit LoRA lines the research committed to
  // (docs/research/krea2-edit-mode.md §2–3). Both are Krea 2 derivatives
  // under the Krea 2 Community License; the node packs above carry the
  // Apache-2.0/MIT code halves.
  {
    id: 'krea2-identity-edit',
    name: 'Krea 2 Identity Edit v1.2 (+ low-VRAM cuts)',
    group: 'weights',
    description: 'conradlocke\'s instruction-based identity-preserving edit LoRA for Krea 2 — the inference standard behind the Instruct, removal and two-reference edit families. This entry fetches the full v1.2 weights plus the SVD rank-reduced _r128/_r64 cuts (>99% weight energy; the low-VRAM fallbacks the edit-mode detection resolves automatically). Requires the comfyui-krea2edit node pack.',
    licenseSpdx: 'krea-2-community-license',
    licenseNote: 'Derivative Model of Krea 2 under the Krea 2 Community License Agreement (repo LICENSE.pdf + NOTICE): commercial use permitted under the revenue threshold (§2.3, currently <$1M/yr), content-moderation duty (§4.2), AI-disclosure duties where required (§4.3). SFW-only training; the author disallows non-consensual use of real people.',
    licenseUrl: 'https://huggingface.co/conradlocke/krea2-identity-edit/blob/main/LICENSE.pdf',
    source: { kind: 'hf', repo: 'conradlocke/krea2-identity-edit', revision: { kind: 'sha', value: '89e9e7a09ee2e5c9331e952063d79b1b8a703280' } },
    destination: { kind: 'model-root', root: 'loras' },
    files: [
      { path: 'krea2_identity_edit_v1_2.safetensors', sizeBytes: 1_828_256_432, sha256: '6adf9a69cc9502d286db7b69964d37da7e9cfe4b05b4d004bc275f087d3fd3cf' },
      { path: 'krea2_identity_edit_v1_2_r128.safetensors', sizeBytes: 914_159_744, sha256: 'f53db0bb4b081d638f196865cbc9f055379704fafb788336784fc1ccde18d825' },
      { path: 'krea2_identity_edit_v1_2_r64.safetensors', sizeBytes: 457_111_048, sha256: 'f794b47142555c929cf536a2f1e4f335174b9aedbb08572b07d45814d4242423' },
    ],
    detectGlob: '*krea2_identity_edit_v1_2*',
    sizeBytes: 3_199_527_224,
    sizeClass: 'huge',
    homepage: 'https://huggingface.co/conradlocke/krea2-identity-edit',
  },
  {
    id: 'krea2-anypaint',
    name: 'Krea 2 AnyPaint rank-32',
    group: 'weights',
    description: 'yijunwang2\'s AnyPaint functional adapter (rank/alpha 32/32, trained on RAW, run on Turbo) — arbitrary-mask inpaint, outpaint and mixed edits with per-step latent restoration and a 32-px boundary blend band, no post-hoc composite. Requires the krea2-anypaint node pack. A functional adapter, not a plain LoRA — stock importers do not apply it; only the pack\'s nodes do.',
    licenseSpdx: 'krea-2-community-license',
    licenseNote: 'Krea 2 derivative under the Krea 2 Community License (repo LICENSE.pdf; the pipeline code it ships carries its own PIPELINE_LICENSE — only the adapter weights land here). Training data not disclosed; unofficial.',
    licenseUrl: 'https://huggingface.co/yijunwang2/krea2-anypaint/blob/main/LICENSE.pdf',
    source: { kind: 'hf', repo: 'yijunwang2/krea2-anypaint', revision: { kind: 'sha', value: '1a9fb37a304c27523939c44fc2b770c11472451b' } },
    destination: { kind: 'model-root', root: 'loras' },
    files: [{ path: 'krea2_anypaint_rank32.safetensors', sizeBytes: 228_587_752, sha256: '3a7d09f6b27f8ead160d340f2f59c11f4ee635c4a1ee87ffd8b1b9f9ba412f7a' }],
    detectGlob: '*krea2_anypaint*',
    sizeBytes: 228_587_752,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/yijunwang2/krea2-anypaint',
  },

  // ---- Experiment prerequisites: Fun Control input surface ---------------
  {
    id: 'fun-control-union',
    name: 'MiniMax-H3-Fun-Controlnet-Union',
    group: 'weights',
    description: 'The official Fun Control union checkpoint — one model, five control kinds (pose/depth/canny/HED/MLSD) selected by the control video content. Experiment prerequisite for the Fun Control input surface (guidance 1.0, 17n+5 frame grid). A locally staged quantized variant (e.g. the pruned int8 convrot) satisfies presence too.',
    licenseSpdx: 'MiniMax H3 Community License',
    licenseNote: 'alibaba-pai community license (LICENSE file in the repo): region and commercial-use terms ride with the outputs. docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union/blob/main/LICENSE',
    source: { kind: 'hf', repo: 'alibaba-pai/MiniMax-H3-Fun-Controlnet-Union', revision: { kind: 'sha', value: '6419c27ece80f330826ae4439fa9c5910c475ccf' } },
    destination: { kind: 'model-root', root: 'model_patches' },
    files: [{ path: 'MiniMax-H3-Fun-Controlnet-Union.safetensors', sizeBytes: 6_806_843_904, sha256: '919a48acb525dc8fc70287fcd94ec1f5e5e289a77f1df14d01099c6ce204eb02' }],
    detectGlob: '*fun_controlnet_union*',
    sizeBytes: 6_806_843_904,
    sizeClass: 'huge',
    experimentPrerequisite: true,
    homepage: 'https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union',
  },

  // ---- Experiment prerequisites: VDN stage files (models/vdn is empty) ---
  {
    id: 'vdn-stage-dmd-250',
    name: 'OpenVDN stage-dmd-step-250 (8-step VDN-H3)',
    group: 'weights',
    description: 'The VDN 8-step stack: linear branch + default and turbo adapters, DMD2-distilled from the community turbo LoRA. Needed by the vendored ComfyUI-VDN-H3 pack; lands under models/vdn/stage-dmd-step-250 (the pack\'s own README layout).',
    licenseSpdx: 'minimax-h3-community-license-agreement',
    licenseNote: 'OpenVDN releases under the MiniMax H3 community agreement (LICENSE file in the repo). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/OpenVDN/vdn-minimax-h3/blob/main/LICENSE',
    source: { kind: 'hf', repo: 'OpenVDN/vdn-minimax-h3', revision: { kind: 'sha', value: '51eeecefdb5b524c0df5539446d1dd54a17aa439' } },
    destination: { kind: 'model-root', root: 'vdn', subpath: 'stage-dmd-step-250' },
    files: [
      { path: 'stage-dmd-step-250/linear_branch/model.safetensors', sizeBytes: 4_279_428_112, sha256: 'dec6981c7874f5b3bc92d1a02e256b673a3b3499dc1a124714bb3b19da602855' },
      { path: 'stage-dmd-step-250/linear_branch/config.json', sizeBytes: 465 },
      { path: 'stage-dmd-step-250/adapters/default/adapter_model.safetensors', sizeBytes: 334_026_912, sha256: '58558fef506f88bb41649242de9b9b3a365da806b51b2e96afbbe1625222058a' },
      { path: 'stage-dmd-step-250/adapters/default/adapter_spec.json', sizeBytes: 415 },
      { path: 'stage-dmd-step-250/adapters/turbo/adapter_model.safetensors', sizeBytes: 851_452_696, sha256: '24fc93c82fe84dc45d0627f4e72c637bc387d282ba18f60ed3b7f8c81089392c' },
      { path: 'stage-dmd-step-250/adapters/turbo/adapter_spec.json', sizeBytes: 22_264 },
      { path: 'stage-dmd-step-250/metadata.json', sizeBytes: 463 },
      { path: 'stage-dmd-step-250/model_spec.json', sizeBytes: 25_705 },
    ],
    detectGlob: 'stage-dmd-step-250/*',
    sizeBytes: 5_465_455_067,
    sizeClass: 'huge',
    experimentPrerequisite: true,
    homepage: 'https://huggingface.co/OpenVDN/vdn-minimax-h3',
  },
  {
    id: 'vdn-stage-b-2000',
    name: 'OpenVDN stage-b-step-2000 (50-step VDN-H3)',
    group: 'weights',
    description: 'The VDN 50-step stack: linear branch + default adapter (no turbo adapter). Same layout as the 8-step stage; fetch only the step count you run.',
    licenseSpdx: 'minimax-h3-community-license-agreement',
    licenseNote: 'OpenVDN releases under the MiniMax H3 community agreement (LICENSE file in the repo). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/OpenVDN/vdn-minimax-h3/blob/main/LICENSE',
    source: { kind: 'hf', repo: 'OpenVDN/vdn-minimax-h3', revision: { kind: 'sha', value: '51eeecefdb5b524c0df5539446d1dd54a17aa439' } },
    destination: { kind: 'model-root', root: 'vdn', subpath: 'stage-b-step-2000' },
    files: [
      { path: 'stage-b-step-2000/linear_branch/model.safetensors', sizeBytes: 4_279_428_112, sha256: 'dec6981c7874f5b3bc92d1a02e256b673a3b3499dc1a124714bb3b19da602855' },
      { path: 'stage-b-step-2000/linear_branch/config.json', sizeBytes: 465 },
      { path: 'stage-b-step-2000/adapters/default/adapter_model.safetensors', sizeBytes: 334_026_912, sha256: '58558fef506f88bb41649242de9b9b3a365da806b51b2e96afbbe1625222058a' },
      { path: 'stage-b-step-2000/adapters/default/adapter_spec.json', sizeBytes: 415 },
      { path: 'stage-b-step-2000/metadata.json', sizeBytes: 190 },
    ],
    detectGlob: 'stage-b-step-2000/*',
    sizeBytes: 4_613_463_594,
    sizeClass: 'huge',
    experimentPrerequisite: true,
    homepage: 'https://huggingface.co/OpenVDN/vdn-minimax-h3',
  },

  // ---- OPTIONAL: pre-merged hybrids (runtime merge preferred) ------------
  {
    id: 'smhfacct-hybrid-b25-49',
    name: 'smhfacct FL2VA/Ref2VA hybrid (blocks 25-49, int8)',
    group: 'weights',
    description: 'Pre-merged FL2VA base with the Ref2VA adaln_proj overlay for blocks 25-49 (the tensor-analysis-recommended preset). OPTIONAL: the HybridLoader runtime merge of checkpoints you already own is preferred — fetch this only for the single-checkpoint convenience.',
    licenseSpdx: 'MiniMax H3 Community License',
    licenseNote: 'Inherits all terms of the source MiniMax fl2va/ref2va checkpoints (repo README); no additional grant. docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models',
    source: { kind: 'hf', repo: 'smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models', revision: { kind: 'sha', value: 'a36feb17fbd1f20ff4bdd509ccd07e2b7b585a38' } },
    destination: { kind: 'model-root', root: 'diffusion_models' },
    files: [{ path: 'minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors', sizeBytes: 20_970_379_632, sha256: 'a629cfea8d89a071b140c6e1935dc9a23e72de6badc18975a2bb9e6d1423d76d' }],
    detectGlob: '*hybrid_fl2va_ref2va*',
    sizeBytes: 20_970_379_632,
    sizeClass: 'huge',
    optional: true,
    homepage: 'https://huggingface.co/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models',
  },

  // ---- Experiment prerequisites: preprocessor weights --------------------
  {
    id: 'dwpose-onnx',
    name: 'DWPose ONNX backend (detector + pose)',
    group: 'preprocessors',
    description: 'The controlnet_aux DWPose ONNX pair — yolox_l detector + dw-ll wholebody pose — placed into the aux pack\'s ckpts tree so first offline pose extraction needs no auto-download. The TorchScript backend is the faster alternative (separate entry).',
    licenseSpdx: 'Apache-2.0',
    source: { kind: 'hf', repo: 'yzd-v/DWPose', revision: { kind: 'sha', value: '1a7144101628d69ee7a3768d1ee3a094070dc388' } },
    destination: { kind: 'pack-ckpt', packDirectory: 'comfyui_controlnet_aux', relativePath: 'ckpts/yzd-v/DWPose' },
    files: [
      { path: 'yolox_l.onnx', sizeBytes: 216_746_733, sha256: '7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411' },
      { path: 'dw-ll_ucoco_384.onnx', sizeBytes: 134_399_116, sha256: '724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843' },
    ],
    sizeBytes: 351_145_849,
    sizeClass: 'large',
    experimentPrerequisite: true,
    homepage: 'https://huggingface.co/yzd-v/DWPose',
  },
  {
    id: 'dwpose-torchscript',
    name: 'DWPose TorchScript backend (batch-size 5)',
    group: 'preprocessors',
    description: 'The DWPose TorchScript backend the aux pack prefers when present — no onnxruntime dependency. Staged on the research testbed; fetchable here for other machines.',
    licenseSpdx: 'Apache-2.0',
    source: { kind: 'hf', repo: 'hr16/DWPose-TorchScript-BatchSize5', revision: { kind: 'sha', value: '359d662a9b33b73f6d0f21732baf8845f17bb4be' } },
    destination: { kind: 'pack-ckpt', packDirectory: 'comfyui_controlnet_aux', relativePath: 'ckpts/hr16/DWPose-TorchScript-BatchSize5' },
    files: [{ path: 'dw-ll_ucoco_384_bs5.torchscript.pt', sizeBytes: 135_059_124, sha256: 'd86a0b2b59fddc0901a7076e9f59c9f8602602133ed72511c693fd11eea23d91' }],
    sizeBytes: 135_059_124,
    sizeClass: 'large',
    experimentPrerequisite: true,
    homepage: 'https://huggingface.co/hr16/DWPose-TorchScript-BatchSize5',
  },
  {
    id: 'da3-base',
    name: 'Depth Anything 3 (Base)',
    group: 'preprocessors',
    description: 'Comfy-Org\'s DA3 Base conversion for ComfyUI\'s native LoadDA3Model — the depth preprocessor of the committed Fun Control experiment (dual-DPT, geometrically consistent). Lands in models/geometry_estimation.',
    licenseSpdx: 'Apache-2.0',
    source: { kind: 'hf', repo: 'Comfy-Org/Depth-Anything-3', revision: { kind: 'sha', value: '248c0c2c1fca3cf3046db1d0d3d5256f2d078f41' } },
    destination: { kind: 'model-root', root: 'geometry_estimation' },
    files: [{ path: 'geometry_estimation/depth_anything_3_base.safetensors', sizeBytes: 541_524_124, sha256: '418c0d2ea857e2d1215fa51baa46833f499a62eb2400ec63d337aa20d326414f' }],
    detectGlob: '*depth_anything_3*',
    sizeBytes: 541_524_124,
    sizeClass: 'large',
    experimentPrerequisite: true,
    homepage: 'https://huggingface.co/Comfy-Org/Depth-Anything-3',
  },
  {
    id: 'hed-annotator',
    name: 'HED soft-edge annotator',
    group: 'preprocessors',
    description: 'lllyasviel/Annotators ControlNetHED.pth for the aux HEDPreprocessor — one of the union checkpoint\'s five control kinds; auto-downloads on first use otherwise (breaks offline runs).',
    licenseSpdx: 'NO-LICENSE',
    licenseNote: 'The Annotators repo ships no license file (all-rights-reserved by default): fetched for your own use with consent, never redistributed by the studio.',
    licenseUrl: 'https://huggingface.co/lllyasviel/Annotators',
    source: { kind: 'hf', repo: 'lllyasviel/Annotators', revision: { kind: 'sha', value: '982e7edaec38759d914a963c48c4726685de7d96' } },
    destination: { kind: 'pack-ckpt', packDirectory: 'comfyui_controlnet_aux', relativePath: 'ckpts/lllyasviel/Annotators' },
    files: [{ path: 'ControlNetHED.pth', sizeBytes: 29_444_406, sha256: '5ca93762ffd68a29fee1af9d495bf6aab80ae86f08905fb35472a083a4c7a8fa' }],
    sizeBytes: 29_444_406,
    sizeClass: 'medium',
    experimentPrerequisite: true,
    homepage: 'https://huggingface.co/lllyasviel/Annotators',
  },
  {
    id: 'mlsd-annotator',
    name: 'MLSD line annotator',
    group: 'preprocessors',
    description: 'lllyasviel/Annotators mlsd_large_512_fp32.pth for the aux MLSDPreprocessor — straight-line control kind of the union checkpoint; auto-downloads on first use otherwise.',
    licenseSpdx: 'NO-LICENSE',
    licenseNote: 'The Annotators repo ships no license file (all-rights-reserved by default): fetched for your own use with consent, never redistributed by the studio.',
    licenseUrl: 'https://huggingface.co/lllyasviel/Annotators',
    source: { kind: 'hf', repo: 'lllyasviel/Annotators', revision: { kind: 'sha', value: '982e7edaec38759d914a963c48c4726685de7d96' } },
    destination: { kind: 'pack-ckpt', packDirectory: 'comfyui_controlnet_aux', relativePath: 'ckpts/lllyasviel/Annotators' },
    files: [{ path: 'mlsd_large_512_fp32.pth', sizeBytes: 6_341_481, sha256: '5696f168eb2c30d4374bbfd45436f7415bb4d88da29bea97eea0101520fba082' }],
    sizeBytes: 6_341_481,
    sizeClass: 'small',
    experimentPrerequisite: true,
    homepage: 'https://huggingface.co/lllyasviel/Annotators',
  },

  // ---- LTX-2.3 one-graph utilities (task 068xwy3) --------------------------
  // The keep-utilities-only verdict (docs/research/ltx-vs-h3-verdict.md):
  // these weights ARE the LTX engine path's surviving purpose. Filenames are
  // the official template_ltx2_3_* widget values; pins verified against the
  // HF APIs on 2026-09-15 (sizes + x-linked-etag sha256; repo HEAD shas).
  // License verdicts: Lightricks/Comfy-Org/Kijai/oumoumad/WepeNerd all carry
  // the LTX-2 Community License via their LTX-2 derivative weights
  // (docs/LICENSES.md §5); joyfox's ICEdit-Insight pair is Apache-2.0.
  {
    id: 'ltx23-dev-checkpoint',
    name: 'LTX-2.3 22B dev checkpoint (bf16, 46 GB)',
    group: 'weights',
    description: 'The full-precision single-file dev checkpoint the remove-subtitles / remove-watermark / restore-archival templates pin (CheckpointLoaderSimple + LTXVAudioVAELoader + the text-projection half of LTXAVTextEncoderLoader all read THIS one file — diffusion model, video VAE, audio VAE and projection in one). The fp8 entry below is the 29 GB alternative for smaller disks; either satisfies the utilities\' checkpoint slot.',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'LTX-2 Community License Agreement (repo LICENSE, dated January 5, 2026): permitted commercial use under the revenue threshold with content-moderation and disclosure duties — the Lightricks counterpart of the Krea 2 / MiniMax community licenses. docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3/blob/main/LICENSE',
    source: { kind: 'hf', repo: 'Lightricks/LTX-2.3', revision: { kind: 'sha', value: '5948be4ced3a4493d1f836df64378ff136ddb770' } },
    destination: { kind: 'model-root', root: 'checkpoints' },
    files: [{ path: 'ltx-2.3-22b-dev.safetensors', sizeBytes: 46_149_344_974, sha256: '24e3bcb3d581f40415a7044b09415a55b22ec45b13f794b796dc44d3cdea0882' }],
    detectGlob: 'ltx-2.3-22b-dev*',
    sizeBytes: 46_149_344_974,
    sizeClass: 'huge',
    homepage: 'https://huggingface.co/Lightricks/LTX-2.3',
  },
  {
    id: 'ltx23-dev-fp8',
    name: 'LTX-2.3 22B dev checkpoint (fp8, 29 GB)',
    group: 'weights',
    description: 'The official fp8 quant of the same single-file dev checkpoint — the exact file the outpaint and img+audio→video templates pin. Satisfies every LTX-2.3 utility\'s checkpoint slot at 63% of the bf16 size; the remove family template pins bf16 but the graph is identical on this file.',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'LTX-2 Community License (same terms as the bf16 release; repo LICENSE). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3-fp8/blob/main/LICENSE',
    source: { kind: 'hf', repo: 'Lightricks/LTX-2.3-fp8', revision: { kind: 'sha', value: '1d756cd27fa11c0896c4dfee093cd1bf36c7f7a1' } },
    destination: { kind: 'model-root', root: 'checkpoints' },
    files: [{ path: 'ltx-2.3-22b-dev-fp8.safetensors', sizeBytes: 29_145_431_166, sha256: '94d11e676b844dd40d74196f059f8b6fdc0fa5c6a07ed9db72d91be06910640a' }],
    detectGlob: 'ltx-2.3-22b-dev-fp8*',
    sizeBytes: 29_145_431_166,
    sizeClass: 'huge',
    homepage: 'https://huggingface.co/Lightricks/LTX-2.3-fp8',
  },
  {
    id: 'ltx23-gemma-encoders',
    name: 'Gemma 3 12B text encoders (bf16 + fp4_mixed)',
    group: 'weights',
    description: 'The LTX-2.3 text encoders: gemma_3_12B_it.safetensors (bf16, the remove-family/outpaint pick) and gemma_3_12B_it_fp4_mixed.safetensors (the fp4 cut the Obscura and IA2V templates pin). Fetch both in one pass or either alone — the utilities resolve whichever is present.',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'Comfy-Org repack of Google\'s Gemma 3 under the LTX-2 release terms (repo carries the LTX-2 license; Gemma terms also apply to the underlying weights — fetched for your own use, never redistributed). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Comfy-Org/ltx-2/blob/main/README.md',
    source: { kind: 'hf', repo: 'Comfy-Org/ltx-2', revision: { kind: 'sha', value: '101c239b4b64dd1b45d645365339c56e0e7df4c3' } },
    destination: { kind: 'model-root', root: 'text_encoders' },
    files: [
      { path: 'split_files/text_encoders/gemma_3_12B_it.safetensors', sizeBytes: 24_379_468_890, sha256: '4080dc65561b7d1cdf20268fc09829829409edecd9fc035fcbbfd77aee7b98aa' },
      { path: 'split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors', sizeBytes: 9_447_702_218, sha256: 'a06d967fe9be66bf35c43beede6395619bb62a6bcc1582d2055ccb2095bf9d51' },
    ],
    detectGlob: 'gemma_3_12B_it*',
    sizeBytes: 33_827_171_108,
    sizeClass: 'huge',
    homepage: 'https://huggingface.co/Comfy-Org/ltx-2',
  },
  {
    id: 'ltx23-latent-upscaler',
    name: 'LTX-2.3 spatial upscaler x2 v1.1',
    group: 'weights',
    description: 'The latent spatial upscaler the remove family and img+audio→video templates pin for their two-stage ladders (stage 1 at half resolution, this model doubles the latents, stage 2 refines). Lands in models/latent_upscale_models.',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'LTX-2 Community License (Lightricks release, repo LICENSE). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3/blob/main/LICENSE',
    source: { kind: 'hf', repo: 'Lightricks/LTX-2.3', revision: { kind: 'sha', value: '5948be4ced3a4493d1f836df64378ff136ddb770' } },
    destination: { kind: 'model-root', root: 'latent_upscale_models' },
    files: [{ path: 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors', sizeBytes: 995_743_560, sha256: '7a1afffa6138fe776771cad82002a1dbb945636778d8268b0d1da3d96df9084b' }],
    detectGlob: 'ltx-2.3-spatial-upscaler-x2*',
    sizeBytes: 995_743_560,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/Lightricks/LTX-2.3',
  },
  {
    id: 'ltx23-distilled-loras',
    name: 'LTX-2.3 distilled LoRAs (384 + 384-1.1)',
    group: 'weights',
    description: 'Lightricks\' distilled-acceleration LoRAs: 384-1.1 (pinned by the Obscura template @0.4) and 384 (pinned by the outpaint template @0.5). The img+audio→video template instead pairs the Comfy-Org rank-111 repack (separate entry below) — any official variant satisfies the distilled slot.',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'LTX-2 Community License (Lightricks release, repo LICENSE). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.3/blob/main/LICENSE',
    source: { kind: 'hf', repo: 'Lightricks/LTX-2.3', revision: { kind: 'sha', value: '5948be4ced3a4493d1f836df64378ff136ddb770' } },
    destination: { kind: 'model-root', root: 'loras' },
    files: [
      { path: 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors', sizeBytes: 7_605_507_256, sha256: 'fca5735c41013042a3a32d0d2829e403a5c8b094dbe01312d9d21da0db47dac9' },
      { path: 'ltx-2.3-22b-distilled-lora-384.safetensors', sizeBytes: 7_605_507_256, sha256: 'aec1918d71536467cf71f5546c42d6bbe894f0a06115134f2a127d821301c6a4' },
    ],
    detectGlob: 'ltx-2.3-22b-distilled-lora-384*',
    sizeBytes: 15_211_014_512,
    sizeClass: 'huge',
    homepage: 'https://huggingface.co/Lightricks/LTX-2.3',
  },
  {
    id: 'ltx23-distilled-rank111',
    name: 'LTX-2.3 distilled 1.1 LoRA (Comfy-Org rank-111 repack)',
    group: 'weights',
    description: 'The rank-111 rank-reduced repack the official img+audio→video workflow pins (dynamic-fro09 averaged, bf16) — the smaller distilled alternative the IA2V template actually ships with.',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'Comfy-Org repack under the LTX-2 release terms. docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Comfy-Org/ltx-2.3/blob/main/README.md',
    source: { kind: 'hf', repo: 'Comfy-Org/ltx-2.3', revision: { kind: 'sha', value: 'f246c0865f5214499a12b72d47464ac8f4f54bee' } },
    destination: { kind: 'model-root', root: 'loras' },
    files: [{ path: 'split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors', sizeBytes: 2_741_024_390, sha256: '32f33f6cc7f407a7cc3354cb80cd83ba8d5b2b5c5edfdeeda75e897fc678fc5c' }],
    detectGlob: 'ltx_2.3_22b_distilled_1.1_lora*',
    sizeBytes: 2_741_024_390,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/Comfy-Org/ltx-2.3',
  },
  {
    id: 'ltx23-icedit-remove-pair',
    name: 'ICEdit-Insight remove pair (subtitles + watermark)',
    group: 'weights',
    description: 'joyfox\'s task-aware IC-LoRA pair the official remove templates pin: ltx2.3-ic-subtitles-remove-general.safetensors @1.2 and ltx2.3-ic-watermark-remove-general.safetensors @1.5 — the exact filenames in the templates\' LTXICLoRALoaderModelOnly widgets. The one Apache-2.0 line in the LTX-2.3 utility stack.',
    licenseSpdx: 'Apache-2.0',
    licenseNote: 'Apache-2.0 (repo LICENSE, verified via the HF API 2026-09-15). Trained on top of LTX-2.3 — outputs remain subject to the base model\'s use terms.',
    licenseUrl: 'https://huggingface.co/joyfox/LTX2.3-ICEdit-Insight/blob/main/LICENSE',
    source: { kind: 'hf', repo: 'joyfox/LTX2.3-ICEdit-Insight', revision: { kind: 'sha', value: '4e81eeb7b3d5addf773668b7c3911f0a30ee891d' } },
    destination: { kind: 'model-root', root: 'loras' },
    files: [
      { path: 'ltx2.3-ic-subtitles-remove-general.safetensors', sizeBytes: 327_287_384, sha256: 'b095ae29bde7af2bbfd3fc5d00e7ad50359709f0d0d926dae95462fff314dc23' },
      { path: 'ltx2.3-ic-watermark-remove-general.safetensors', sizeBytes: 327_287_384, sha256: '8d591d22e6cddd1b6e4c88c12a4e614ae4c4ea298753422c40670370c6d8dc2b' },
    ],
    detectGlob: 'ltx2.3-ic-*-remove-general.safetensors',
    sizeBytes: 654_574_768,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/joyfox/LTX2.3-ICEdit-Insight',
  },
  {
    id: 'ltx23-dearchive',
    name: 'dearchive — LTX-2.3 archival restoration IC-LoRA',
    group: 'weights',
    description: 'oumoumad\'s dearchive IC-LoRA (step 05000) — the exact weights the official restore-archival template pins @1.0: rewrites real archive footage (B&W broadcast, low-bitrate rips, sepia prints) as modern-looking video. The template renames this file to ltx-2.3-dearchive-lora_weights_step_05000.safetensors on placement; the model inference accepts both names.',
    licenseSpdx: 'ltx-video-license',
    licenseNote: 'LTX-2 derivative under the LTX Video / LTX-2 Community terms (repo card: ltx-video-license, linking the Lightricks LICENSE.txt). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/oumoumad/ltx-2.3-dearchive-lora/blob/main/README.md',
    source: { kind: 'hf', repo: 'oumoumad/ltx-2.3-dearchive-lora', revision: { kind: 'sha', value: 'c106f0fa10519cb9cbb5aedaea2a4c562790c9f2' } },
    destination: { kind: 'model-root', root: 'loras' },
    files: [{ path: 'lora_weights_step_05000.safetensors', sizeBytes: 1_711_612_856, sha256: 'ffdb766fb6ff3e4f8433b03668e35e14188143d8d999e554a5959d3829686a22' }],
    detectGlob: '*lora_weights_step_05000*',
    sizeBytes: 1_711_612_856,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/oumoumad/ltx-2.3-dearchive-lora',
  },
  {
    id: 'ltx23-obscura-remova',
    name: 'Obscura Remova (remove-object LoRA)',
    group: 'weights',
    description: 'WepeNerd\'s Obscura Remova LoRA — the remove-object template\'s engine, pinned @2.0 on the Kijai split stack with the distilled-384-1.1 @0.4. Prompt form "Remove the {object} from the foreground.", strength band 1.3–2.0 per the author card. Fetched from the HF mirror for integrity pinning (the template embeds a civitai download link instead).',
    licenseSpdx: 'ltx-video-license',
    licenseNote: 'LTX-2 derivative under the LTX Video license terms (HF repo carries the Lightricks LICENSE link). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/WepeNerd/Obscura_Remova/blob/main/README.md',
    source: { kind: 'hf', repo: 'WepeNerd/Obscura_Remova', revision: { kind: 'sha', value: '907f5d25e0b1d8fcc15936a064fd85b4609e7d2b' } },
    destination: { kind: 'model-root', root: 'loras' },
    files: [{ path: 'LTX23_Obscura_Remova_v1.safetensors', sizeBytes: 327_344_864, sha256: 'f15c206d2abd0859eb5729abc23067ae36a480f297dbfd8d92efef3cefd5cb7c' }],
    detectGlob: '*obscura_remova*',
    sizeBytes: 327_344_864,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/WepeNerd/Obscura_Remova',
  },
  {
    id: 'ltx23-ic-outpaint',
    name: 'LTX-2.3 outpaint IC-LoRA',
    group: 'weights',
    description: 'oumoumad\'s outpaint IC-LoRA — the exact ltx-2.3-22b-ic-lora-outpaint.safetensors the official video-outpainting template pins @1.0 (with distilled-384 @0.5). Aspect-ratio canvas growth on the half-res grid pipeline.',
    licenseSpdx: 'ltx-video-license',
    licenseNote: 'LTX-2 derivative under the LTX Video license terms. docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/oumoumad/LTX-2.3-22b-IC-LoRA-Outpaint/blob/main/README.md',
    source: { kind: 'hf', repo: 'oumoumad/LTX-2.3-22b-IC-LoRA-Outpaint', revision: { kind: 'sha', value: 'b747e10700e7460f90d0cb1ceb061f69c719431a' } },
    destination: { kind: 'model-root', root: 'loras' },
    files: [{ path: 'ltx-2.3-22b-ic-lora-outpaint.safetensors', sizeBytes: 1_308_756_416, sha256: '76df7c1ccbe8d657e38f38e8defbc0755a8d57b1a2b34fcad1f6376f4ce289f0' }],
    detectGlob: 'ltx-2.3-22b-ic-lora-outpaint*',
    sizeBytes: 1_308_756_416,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/oumoumad/LTX-2.3-22b-IC-LoRA-Outpaint',
  },
  {
    id: 'ltx23-kijai-transformer',
    name: 'Kijai LTX-2.3 transformer-only split (bf16)',
    group: 'weights',
    description: 'The transformer-only bf16 cut of the LTX-2.3 22B dev weights — the diffusion-model half of the Obscura Remova tool\'s split stack (lands in models/diffusion_models; the projection and VAE splits are separate entries).',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'Kijai\'s conversion of the LTX-2.3 dev weights — same LTX-2 Community License as the source checkpoints (repo carries the Lightricks license). docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Kijai/LTX2.3_comfy/blob/main/README.md',
    source: { kind: 'hf', repo: 'Kijai/LTX2.3_comfy', revision: { kind: 'sha', value: '6d980fde0d330f2fed6ff8dfdfddb06d88a004e5' } },
    destination: { kind: 'model-root', root: 'diffusion_models' },
    files: [{ path: 'diffusion_models/ltx-2.3-22b-dev_transformer_only_bf16.safetensors', sizeBytes: 42_020_149_760, sha256: 'fb6a3b1c2af0c9a72d6a45183fc0b34fa4bd78097b0dfc7c5c8d0ef77b99c45e' }],
    detectGlob: 'ltx-2.3-22b-dev_transformer_only*',
    sizeBytes: 42_020_149_760,
    sizeClass: 'huge',
    homepage: 'https://huggingface.co/Kijai/LTX2.3_comfy',
  },
  {
    id: 'ltx23-kijai-projection',
    name: 'Kijai LTX-2.3 text projection (bf16)',
    group: 'weights',
    description: 'The text-projection split (ltx-2.3_text_projection_bf16.safetensors, models/text_encoders) — the second DualCLIPLoader input of the Obscura Remova tool\'s stack (the Gemma encoder is the first).',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'Kijai\'s conversion — same LTX-2 Community License as the source checkpoints. docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Kijai/LTX2.3_comfy/blob/main/README.md',
    source: { kind: 'hf', repo: 'Kijai/LTX2.3_comfy', revision: { kind: 'sha', value: '6d980fde0d330f2fed6ff8dfdfddb06d88a004e5' } },
    destination: { kind: 'model-root', root: 'text_encoders' },
    files: [{ path: 'text_encoders/ltx-2.3_text_projection_bf16.safetensors', sizeBytes: 2_312_149_072, sha256: '6143818bdd6198b841aa2056c4f7e811f787d49a418b47dda360cc9fe5626c43' }],
    detectGlob: 'ltx-2.3_text_projection*',
    sizeBytes: 2_312_149_072,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/Kijai/LTX2.3_comfy',
  },
  {
    id: 'ltx23-kijai-vaes',
    name: 'Kijai LTX23 video + audio VAE splits (bf16)',
    group: 'weights',
    description: 'The separate bf16 VAE pair (models/vae) the Obscura Remova tool loads through VAELoaderKJ: LTX23_video_vae_bf16.safetensors and LTX23_audio_vae_bf16.safetensors.',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'Kijai\'s conversion — same LTX-2 Community License as the source checkpoints. docs/LICENSES.md §5.',
    licenseUrl: 'https://huggingface.co/Kijai/LTX2.3_comfy/blob/main/README.md',
    source: { kind: 'hf', repo: 'Kijai/LTX2.3_comfy', revision: { kind: 'sha', value: '6d980fde0d330f2fed6ff8dfdfddb06d88a004e5' } },
    destination: { kind: 'model-root', root: 'vae' },
    files: [
      { path: 'vae/LTX23_video_vae_bf16.safetensors', sizeBytes: 1_452_258_578, sha256: '820453bebc75dc239c0ba3a0b09c748d956a6440c11f8bb5fd95470ed4bad64d' },
      { path: 'vae/LTX23_audio_vae_bf16.safetensors', sizeBytes: 364_855_188, sha256: 'b66bb0875cdc12cc370b243ac3c297b81a2fc262451c476fc7dbfae9b4bf7125' },
    ],
    detectGlob: 'LTX23_*_vae*',
    sizeBytes: 1_817_113_766,
    sizeClass: 'large',
    homepage: 'https://huggingface.co/Kijai/LTX2.3_comfy',
  },

  // ---- Clone-on-demand seam (task 3ay7wbz) --------------------------------
  {
    id: 'engine-comfyui',
    name: 'ComfyUI reference checkout (v0.34.0)',
    group: 'engine',
    description: 'The reference ComfyUI revision the studio\'s graphs and patch layouts are verified against, fetched via the consent flow as a pinned checkout you can nominate for the managed engine. GPL-3.0: fetched for you, never vendored into the studio.',
    licenseSpdx: 'GPL-3.0',
    licenseNote: 'ComfyUI is GPL-3.0. The studio conveys no ComfyUI copy — the checkout exists only on your machine, produced by your consented fetch (the same pattern as the consent patch tier, docs/LICENSES.md §8).',
    licenseUrl: 'https://github.com/comfyanonymous/ComfyUI/blob/master/LICENSE',
    source: { kind: 'git', url: 'https://github.com/comfyanonymous/ComfyUI', revision: { kind: 'tag', value: 'v0.34.0' } },
    destination: { kind: 'engine-checkout' },
    sizeBytes: 45_000_000,
    sizeClass: 'medium',
    homepage: 'https://github.com/comfyanonymous/ComfyUI',
  },
]

export const FETCH_ENTRY_IDS = new Set(FETCH_CATALOG.map((entry) => entry.id))

export function findFetchEntry(id: string): FetchCatalogEntry | null {
  return FETCH_CATALOG.find((entry) => entry.id === id) ?? null
}

// ---------------------------------------------------------------------------
// Pure helpers shared by the engine, the routes and the tests
// ---------------------------------------------------------------------------

/** The distinct extra model roots the catalog places weights into (beyond
 *  the six scanner kinds) — the managed runtime mirrors these into
 *  extra_model_paths.yaml when they exist, so fetched weights are visible
 *  to the managed instance without copying bytes. */
export function fetchExtraModelRoots(): string[] {
  const roots = new Set<string>()
  for (const entry of FETCH_CATALOG) {
    if (entry.destination.kind === 'model-root' && !SCANNER_KINDS.has(entry.destination.root)) roots.add(entry.destination.root)
  }
  return [...roots].sort()
}

/** Simple `*`-wildcard glob (substring/prefix/suffix) — enough for presence
 *  detection over directory listings. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/** True when a filename matches a `*`-style glob. */
export function matchesGlob(filename: string, glob: string): boolean {
  return globToRegExp(glob).test(filename)
}

/** Model-root destination resolution shared by placement and status checks:
 *  the file lands at <root>/<subpath?>/<basename of the repo path>. */
export function modelRootTargetPath(destination: Extract<FetchDestination, { kind: 'model-root' }>, settings: AppSettings, repoPath: string): string {
  const root = fetchModelRootPath(destination.root, settings)
  const basename = repoPath.slice(repoPath.replace(/\\/g, '/').lastIndexOf('/') + 1)
  return join(root, ...(destination.subpath ? [destination.subpath] : []), basename)
}

/** Human destination summary for the consent dialog + catalog rows. */
export function describeFetchDestination(entry: FetchCatalogEntry, settings: AppSettings): string {
  switch (entry.destination.kind) {
    case 'model-root': {
      const root = fetchModelRootPath(entry.destination.root, settings)
      return `${entry.destination.root} → ${root}${entry.destination.subpath ? `/${entry.destination.subpath}` : ''}`
    }
    case 'pack-ckpt':
      return `custom_nodes/${entry.destination.packDirectory}/${entry.destination.relativePath}`
    case 'node-pack': {
      const pack = findNodePack(entry.destination.packId)
      return `custom_nodes/${pack?.name ?? entry.destination.packId}`
    }
    case 'engine-checkout':
      return 'a ComfyUI checkout fetched next to the studio home (nominate it for the managed engine afterwards)'
  }
}

/** The pack registry entries the fetcher can install (license data lives in
 *  ENGINE_NODE_PACKS — surfaced here for the integrity tests). */
export function fetchableNodePacks(): typeof ENGINE_NODE_PACKS {
  return ENGINE_NODE_PACKS.filter((pack) => FETCH_CATALOG.some((entry) => entry.packId === pack.id))
}
