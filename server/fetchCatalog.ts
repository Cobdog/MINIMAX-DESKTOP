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
