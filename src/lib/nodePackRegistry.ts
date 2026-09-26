/**
 * The node-pack registry as PURE DATA (remediation Wave 1, R-02): the same
 * entries server/engineNodes.ts owns, extracted so the RENDERER can map a
 * missing node class to its pack row in the submit-time preflight — one
 * source of truth, no drift, and pulling a pack out of the registry stays a
 * one-entry change (the modularity contract). Licensing discipline and the
 * per-pack provenance notes live with the entries; see engineNodes.ts for
 * the install machinery (vendor/user-fetch/first-party) that consumes this.
 */
import type { NodePackDefinition } from '../types'

/** License verdicts recorded 2026-09-14 (task 3ay7wbz increment 2):
 *  - ComfyUI-VDN-H3 (Saganaki22): Apache-2.0 — LICENSE file + README
 *    statement + GitHub badge, verified against the cloned payload.
 *  - ComfyUI-MiniMax-H3-Turbo (Larryvrh): Apache-2.0 — LICENSE file read
 *    from the local testbed install.
 *  - comfyui-krea2-controlnet (facok): NO license file in the repo —
 *    all-rights-reserved by default; NEVER vendored, user-fetch only
 *    (docs/research/krea2-edit-mode.md flags it as a hard blocker).
 *  - comfyui-minimax-h3-audio-T8 (T8mars, task hgjbea2): GPL-3.0-or-later
 *    (LICENSE file is an SPDX notice — docs/LICENSES.md §3). GPL packs are
 *    never vendored (pattern-adopt policy) but ARE fetchable-but-flagged
 *    through the consent-gated fetcher: the user fetches their own copy,
 *    we redistribute nothing.
 *  - comfyui-krea2edit (lbouaraba, task t8u00uu): Apache-2.0 (GitHub API
 *    license record + LICENSE file, verified 2026-09-14) — the Identity
 *    Edit node pack (dual-conditioning carrier for the Identity Edit v1.2
 *    LoRA). User-fetch: permissive, but not vendored (we ship no third-party
 *    code we have not deliberately vendored — same posture as Larryvrh's).
 *  - krea2-anypaint (alexw5702-afk, task t8u00uu): MIT (LICENSE file,
 *    verified 2026-09-14; NOTICE credits Rebels + ostris) — the AnyPaint
 *    mask nodes for the krea2_anypaint_rank32 functional adapter. User-fetch.
 *  - ComfyUI_MinimaxH3_AutoContext (supElement, task lxmtgss): Apache-2.0
 *    (LICENSE file read from a fresh fetch, 2026-09-16; template copyright
 *    line only) — the segmented-inference pack (prompt-timeline slicing,
 *    per-segment reference filtering, 3-channel anchoring; deep-read:
 *    docs/research/autocontext-deepread.md). Permissive: vendor-eligible,
 *    user-fetch until a vendoring increment is wanted.
 *  - ComfyUI-MiniMax-H3-Image-Studio (astropuzzo, task d4er4ti): Unlicense
 *    (LICENSE file + SPDX header in nodes.py, read at 47dea30 during the
 *    2026-09-21 pack assessment) — public-domain-equivalent; vendor-eligible
 *    in principle, user-fetch until wanted (same posture as the other
 *    permissive unfetched packs).
 *  - ComfyUI-H3-Motion-Context (NikoDemon80, task 06jr4eh — GAP-1): GPL-3.0
 *    (LICENSE file + pyproject classifier, read from the canonical shared
 *    install's copy at 5335715 / v0.6.2, 2026-09-21; plain v3 text with NO
 *    or-later grant → GPL-3.0-only). The T8mars posture: never vendored,
 *    fetch-consent only.
 *  - Comfyui_Minimax_h3_latent_Upscaler (LBH-123-AI, task 06jr4eh — GAP-2):
 *    MIT (LICENSE file added upstream at exactly the pinned revision —
 *    commit 40316cf "Add MIT License", 2026-09-17; GitHub API license record
 *    MIT, verified 2026-09-21). Vendor-eligible; user-fetch until a
 *    vendoring increment is wanted (the Larryvrh posture).
 *  - ComfyUI-MiniMaxH3-PreviewOverride (simsim9-stack, task t6vub9k — the
 *    maintainer-endorsed preview-decoding path, 2026-09-22): MIT (LICENSE
 *    file read from the pinned revision d1eb17b during the pack assessment,
 *    docs/research/preview-override-assessment.md). Vendor-eligible;
 *    user-fetch until a vendoring increment is wanted (the Larryvrh
 *    posture).
 *  - ComfyUI-Fizgig-H3-Still (shootthesound, task 464xfvd — the E-FS1
 *    challenge arm): MIT (LICENSE file, Copyright 2026 Peter Neill — read
 *    from the repo at the pinned revision f3252d2 during the 2026-09-25
 *    assessment, docs/research/fizgig-h3-still-assessment.md).
 *    Vendor-eligible; user-fetch. NOT adopted — behind the
 *    experimentalT1Decode flag until the E-FS0/E-FS1 bake-off reports. */
export const ENGINE_NODE_PACKS: NodePackDefinition[] = [
  {
    id: 'vdn-h3',
    name: 'ComfyUI-VDN-H3',
    featureGroup: 'H3 video',
    description: 'The community VDN port — a node pack, not a fork. VDN-proper is applied as runtime model patches on ComfyUI\'s native MiniMax-H3 ModelPatcher: nothing outside custom_nodes/, no core patch, no new dependencies. Weights are downloaded separately from Hugging Face and land as links in your model roots.',
    repoUrl: 'https://github.com/Saganaki22/ComfyUI-VDN-H3',
    pinnedRevision: '3eb63496c24ca70faaf8a14b6c75fcb480e34bf1',
    licenseSpdx: 'Apache-2.0',
    installMode: 'vendor',
    vendorDir: 'ComfyUI-VDN-H3',
    homepage: 'https://github.com/Saganaki22/ComfyUI-VDN-H3',
    // NODE_CLASS_MAPPINGS read from the vendored payload (vendor/nodes/
    // ComfyUI-VDN-H3, 2026-09-19). The separately-named 24GB variant install
    // registers *_24GB-suffixed classes — detection is by OUR pinned pack.
    instanceNodeClasses: ['ApplyVDNH3', 'ApplyVDNH3Advanced'],
  },
  {
    id: 'lora-form-adapter',
    name: 'minimax-lora-form-adapter',
    featureGroup: 'Studio tooling',
    description: 'The studio\'s own form-adaptive LoRA loader for MiniMax-H3 (first-party code, MIT, independently releasable): detects curve(pruned) vs full-width adaln forms from live tensor shapes on both the model and the LoRA, passes matching/adaln-free LoRAs through the stock machinery, and projects full-width adaln LoRAs onto curve bases at load time (centered [C|1] encoder + adaln bias delta, golden-tested against kijai\'s published conversion). Installs from the studio\'s own payload — no network, no third-party license.',
    repoUrl: 'https://github.com/Cobdog/MINIMAX-DESKTOP',
    pinnedRevision: 'v1.0.0',
    licenseSpdx: 'MIT',
    licenseNote: 'Original work of this repo (custom-nodes/minimax-lora-form-adapter, MIT LICENSE file). The release pin is the node\'s own version; install copies the studio\'s payload, never a network fetch.',
    installMode: 'first-party',
    firstPartyDir: 'minimax-lora-form-adapter',
    homepage: 'https://github.com/Cobdog/MINIMAX-DESKTOP/tree/main/custom-nodes/minimax-lora-form-adapter',
    // Our own nodes.py (custom-nodes/minimax-lora-form-adapter).
    instanceNodeClasses: ['MiniMaxH3LoraFormLoader'],
  },
  {
    id: 'minimax-h3-turbo',
    name: 'ComfyUI-MiniMax-H3-Turbo',
    featureGroup: 'H3 video',
    description: 'Larryvrh\'s turbo-LoRA loader node (the pack the optimization registry detects as larryvrhTurbo) plus the h3_silu_temb_grid fix for pruned bases. License-clean (Apache-2.0) but not vendored yet — install from a local copy of the repo.',
    repoUrl: 'https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo',
    pinnedRevision: '4274783a23afcfdbea3b4876cb79effd6c510785',
    licenseSpdx: 'Apache-2.0',
    installMode: 'user-fetch',
    homepage: 'https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo',
    // NODE_CLASS_MAPPINGS read from the canonical shared install's copy of
    // the pack (2026-09-19); the optimization registry detects this pair.
    instanceNodeClasses: ['MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler'],
  },
  {
    // H3 Image Workbench (k9vu6t0, spec §4/§10 — decision 10: the hybrid
    // profile is a RUNTIME merge, one mmap per checkpoint, no duplicated
    // multi-GB files). MIT (LICENSE.txt read from the canonical shared
    // install clone at this exact rev, 2026-09-18).
    id: 'h3-hybrid-loader',
    name: 'ComfyUI_MinimaxH3HybridLoader',
    featureGroup: 'H3 image',
    description: 'scottmudge\'s hybrid loader for MiniMax H3: overlays selected tensor groups of one checkpoint onto another AT LOAD (MiniMaxH3HybridLoader, block_range_adaln 25..49 = the b25-49 fl2va+ref2va hybrid the H3 Image Workbench packet/T=1 profiles run on). One mmap per checkpoint — no pre-merged duplicate on disk; behaves exactly like the stock loader when the preset is "none".',
    repoUrl: 'https://github.com/scottmudge/ComfyUI_MinimaxH3HybridLoader',
    pinnedRevision: 'a44c69b02242e41fbd01e22abe2a492adc853038',
    licenseSpdx: 'MIT',
    licenseNote: 'MIT (LICENSE.txt in the repo, read from the canonical shared install at this rev, 2026-09-18). Vendor-eligible; user-fetch until a vendoring increment is wanted (the Larryvrh posture).',
    installMode: 'user-fetch',
    homepage: 'https://github.com/scottmudge/ComfyUI_MinimaxH3HybridLoader',
    // Single class — verified from the canonical shared install's nodes.py
    // and exercised by the H3-1F e2e object_info stub.
    instanceNodeClasses: ['MiniMaxH3HybridLoader'],
  },
  {
    id: 'krea2-controlnet',
    name: 'comfyui-krea2-controlnet',
    featureGroup: 'Krea 2 edit',
    description: 'facok\'s Krea 2 ControlNet-LoRA pack (depth structure lock for Krea 2 regeneration). The repo carries NO license file — all-rights-reserved by default — so it is never vendored and only ever installed into your own instance from a local copy, with your consent.',
    repoUrl: 'https://github.com/facok/comfyui-krea2-controlnet',
    pinnedRevision: 'main',
    licenseSpdx: 'NO-LICENSE',
    licenseNote: 'No license file in the upstream repo — redistribution not permitted; user-fetch only, never vendored (docs/research/krea2-edit-mode.md).',
    installMode: 'user-fetch',
    homepage: 'https://github.com/facok/comfyui-krea2-controlnet',
    // NODE_CLASS_MAPPINGS read from the canonical shared install (2026-09-19).
    instanceNodeClasses: ['Krea2ControlLoRALoader', 'Krea2ControlApply', 'Krea2ControlImageEncode'],
  },
  {
    id: 'h3-audio-t8',
    name: 'comfyui-minimax-h3-audio-T8',
    featureGroup: 'Audio',
    description: 'T8mars\' audio sidecar pack (H3 audio editing). GPL-3.0-or-later: pattern-adopted in our own code where ideas were useful, but fetchable-but-flagged for your own instance via the consent flow — the studio never vendors or redistributes it. The fetcher stamps the resolved HEAD SHA of the main branch at fetch time.',
    repoUrl: 'https://github.com/T8mars/comfyui-minimax-h3-audio-T8',
    pinnedRevision: 'main',
    licenseSpdx: 'GPL-3.0-or-later',
    licenseNote: 'LICENSE file is an SPDX notice, not full text (docs/LICENSES.md §3, API-verified 2026-09-14). GPL-3.0 is combining-compatible with our AGPLv3, but vendoring third-party GPL code couples our releases to a contributor set we do not control — user-fetch only.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/T8mars/comfyui-minimax-h3-audio-T8',
    // Upstream read 2026-09-19 (h3_t8/nodes.py): the pack uses the newer
    // extension API, and node ids like MiniMaxH3AudioConditioningT8 appear
    // inside define_schema() calls. Research flags T8 node names as in-flux;
    // this one class is the stable detection hook (any-match).
    instanceNodeClasses: ['MiniMaxH3AudioConditioningT8'],
  },
  {
    id: 'krea2edit',
    name: 'comfyui-krea2edit',
    featureGroup: 'Krea 2 edit',
    description: 'lbouaraba\'s Identity Edit node pack for Krea 2 (Krea2EditModelPatch + Krea2EditGroundedEncode) — the dual-conditioning carrier the krea2_identity_edit_v1_2 LoRA was trained with: the source rides both the in-context VAE latent path (RoPE frame 1) and the image-grounded Qwen3-VL encode. Powers the Instruct, removal and two-reference edit families.',
    repoUrl: 'https://github.com/lbouaraba/comfyui-krea2edit',
    pinnedRevision: '86f886dac23013d88996e3a2e99093ba44d322fb',
    licenseSpdx: 'Apache-2.0',
    licenseNote: 'Apache-2.0 (LICENSE file + GitHub API license record, verified 2026-09-14). Nodes only — the LoRA weights are a separate Krea-2-licensed fetch. Solo-maintained with a v2 retrain in progress: pinned by SHA; expect re-verification at v2.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/lbouaraba/comfyui-krea2edit',
    // Verified from the canonical shared install (2026-09-19) and mirrored
    // by KREA2EDIT_NODES in src/lib/graph/krea2edit.ts.
    instanceNodeClasses: ['Krea2EditModelPatch', 'Krea2EditGroundedEncode'],
  },
  {
    id: 'krea2-anypaint',
    name: 'krea2-anypaint',
    featureGroup: 'Krea 2 edit',
    description: 'alexw5702-afk\'s AnyPaint nodes (Krea2AnyPaintPrepare/Encode/ModelPatch) for the krea2_anypaint_rank32 functional adapter — arbitrary-mask inpaint/outpaint/mixed edits on Krea 2 Turbo with per-step latent restoration, a 384px semantic reference and an isolated reference K/V cache. Powers the refine and outpaint edit families.',
    repoUrl: 'https://github.com/alexw5702-afk/krea2-anypaint',
    pinnedRevision: '675be5a91eadbf8b8997b21c0e8e1848310b9571',
    licenseSpdx: 'MIT',
    licenseNote: 'MIT (LICENSE file, verified 2026-09-14); reference-attention/K-V-cache code adapted from ComfyUI-Rebels-Krea2-Outpaint and ComfyUI-Krea2-Ostris-Edit per its NOTICE. The LoRA is a separate Krea-2-licensed fetch.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/alexw5702-afk/krea2-anypaint',
    // Verified from the canonical shared install (2026-09-19); mirrored by
    // ANYPAINT_NODES in src/lib/graph/krea2edit.ts.
    instanceNodeClasses: ['Krea2AnyPaintPrepare', 'Krea2AnyPaintEncode', 'Krea2AnyPaintModelPatch'],
  },
  {
    // The H3-image engine-truth gate (task d4er4ti, Wave 3 rung 0; deep-read
    // docs/research/h3-image-studio-pack-assessment.md). astropuzzo's parallel
    // H3 conditioning pack: legal T=1 latents (own latent construction — the
    // stock conditioning node refuses length<5 at server-side validation,
    // ComfyUI issue #15644) and the exact 9/13-frame ladder the stock
    // 17n+5 grid snaps to 22. The T=1 Fast family is GATED on this pack's
    // Prepare classes until the studio-side pack-conditioned graph lands.
    id: 'h3-image-studio',
    name: 'ComfyUI-MiniMax-H3-Image-Studio',
    featureGroup: 'H3 image',
    description: 'astropuzzo\'s H3 image studio pack: a parallel conditioning implementation (12 nodes, no core patching, no dependencies — works on ComfyUI ≥0.30) that constructs the packed H3 AV latent itself, making single-frame (T=1) latents legal end-to-end and hitting the 9/13-frame packet tiers exactly where stock nodes snap both to a 22-frame sample. The load-bearing classes are the Prepare set + the exact/slice frame decode; its sampling/resolution/selector nodes duplicate capability the app already owns.',
    repoUrl: 'https://github.com/astropuzzo/ComfyUI-MiniMax-H3-Image-Studio',
    pinnedRevision: '47dea30d0bf07e7340ef0cc97e8174a15edf55b9',
    licenseSpdx: 'Unlicense',
    licenseNote: 'The Unlicense (LICENSE file + SPDX header in nodes.py, read at v23.0.0 / 47dea30 during the 2026-09-21 pack assessment) — public-domain-equivalent, the permissiveness ceiling; compatible with our AGPLv3 in both directions and unconditionally vendor-eligible. User-fetch matches the current posture (the Larryvrh precedent): permissive, but nothing ships in-tree until a vendoring increment is deliberately wanted. The WEIGHTS the T=1 lane needs keep their own licenses (the smhfacct hybrid / Mamad8 VAE / ThisIsFine adapter) via the origin-gated catalog.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/astropuzzo/ComfyUI-MiniMax-H3-Image-Studio',
    // NODE_CLASS_MAPPINGS read from the assessment's full code read of nodes.py
    // at 47dea30 (v23.0.0, 12 classes, category MiniMax H3/Image Studio). The
    // five listed are the non-duplicating core (the Prepare set + decode);
    // detection is any-match, exactly the pack board's rule.
    instanceNodeClasses: ['H3ImagePrepare', 'H3TextToImagePrepare', 'H3ImageToImagePrepare', 'H3ReferenceEditPrepare', 'H3ImageDecode'],
  },
  // -- segmented inference for H3 (task lxmtgss deep-read → task p8oyfy1) --
  {
    id: 'autocontext',
    name: 'ComfyUI_MinimaxH3_AutoContext',
    featureGroup: 'H3 video',
    description: 'supElement’s one-click segmented-inference pack for MiniMax H3: '
      + 'prompt-timeline slicing (Clip_Tag/timeline/sequential/global), per-segment reference '
      + 'filtering (only prompt-declared refs are passed), 3-channel inter-segment anchoring '
      + '(initial-latent splice + video_context_denoise dial, cond-row motion keyframes, '
      + 'untagged context-audio ref), hash-keyed per-segment latent cache with resume, '
      + 'video_guide bridging, audio_drive, and a pixel-domain seam-correction node. '
      + 'Deep-read: docs/research/autocontext-deepread.md.',
    repoUrl: 'https://github.com/supElement/ComfyUI_MinimaxH3_AutoContext',
    pinnedRevision: 'f1062d34e3c25ef421b2aadeb69f2d21831d1625',
    licenseSpdx: 'Apache-2.0',
    licenseNote: 'Apache-2.0 (LICENSE file read from a fresh fetch, 2026-09-16; template '
      + 'copyright line only). Permissive: vendor-eligible, user-fetch until a vendoring '
      + 'increment is wanted.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/supElement/ComfyUI_MinimaxH3_AutoContext',
    // Three-node pack per docs/research/autocontext-deepread.md §module map
    // (code-read 2026-09-16).
    instanceNodeClasses: ['Minimax_H3_AutoContext_parameter', 'Minimax_H3_AutoContext_Sampler', 'Minimax_H3_Seam_Correction'],
  },
  // -- GAP-1 closed (task 06jr4eh; found by the 2026-09-21 registry-curation
  // pass, docs/research/node-pack-registry.md §1.1): the chain lane's builder
  // emitted classes no registry row covered — invisible to object_info
  // detection, preflight remediation, and pinning. STATUS
  // PROPOSED-PENDING-TEST · ALT: ComfyUI_MinimaxH3_AutoContext segmented
  // inference (the overlap — a TS test decides the default long-form lane).
  {
    id: 'h3-motion-context',
    name: 'ComfyUI-H3-Motion-Context',
    featureGroup: 'H3 video',
    description: 'NikoDemon80\'s clip-chaining pack for MiniMax H3: pins the tail of the previous clip — picture and sound — so the next clip genuinely continues it (the picture is sliced out of the previous latent with no VAE round trip; the pinned audio window ends at the join so the soundtrack continues rather than restarts). The engine side of canvas latent continuation: chain renders save their sampler latents and latents forks continue from the source clip through these nodes.',
    repoUrl: 'https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context',
    pinnedRevision: '5335715abe54c1a9bfbe3494da29aae3e8635ce3',
    licenseSpdx: 'GPL-3.0-only',
    licenseNote: 'GPL-3.0 (LICENSE file + pyproject classifier, read from the canonical shared install\'s copy at 5335715 / v0.6.2, 2026-09-21; plain v3 text, no or-later grant). Same posture as T8mars: never vendored — fetch-consent for your own instance, the studio redistributes nothing.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context',
    // NODE_CLASS_MAPPINGS read from the shared install's nodes.py:1189-1193
    // (2026-09-21). The four listed are exactly what src/lib/workflow.ts
    // emits for chain continuation (MOTION_CONTEXT_NODES,
    // canvas/generation.ts); the pack also ships a …Chain node and a
    // seam-probe node this app never calls. Detection is any-match.
    instanceNodeClasses: ['MiniMaxH3MotionContext', 'MiniMaxH3MotionContextTrim', 'MiniMaxH3MotionContextSaveLatent', 'MiniMaxH3MotionContextLoadLatent'],
  },
  // -- GAP-2 closed (task 06jr4eh): the LBH hires-fix entries
  // (upscale.lbh2d/lbh3d) emitted two upscaler classes with no row, no pin,
  // and no install guidance beyond a hint string. STATUS
  // PROPOSED-PENDING-TEST · ALT: upscale.rtx (stock pixel 2× — loses the
  // audio path; the only stock fallback).
  {
    id: 'lbh-latent-upscaler',
    name: 'Comfyui_Minimax_h3_latent_Upscaler',
    featureGroup: 'H3 video',
    description: 'LBH-123-AI\'s learned latent upscaler for MiniMax H3 (24ch): 2× in latent space, bypassing the 5B-param VAE decode/encode round trip. Powers the upscale registry\'s LBH latent 2D/3D 2× hires-fix entries — latent-space scaling keeps the audio path intact where the RTX pixel path drops it. The upscaler weights are a separate download into the engine\'s upscale models root (the engine\'s own model list is the honest availability signal).',
    repoUrl: 'https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler',
    pinnedRevision: '40316cf008b2fd8663263270669eb4da23f89d2c',
    licenseSpdx: 'MIT',
    licenseNote: 'MIT (LICENSE file added upstream at exactly this pinned revision — commit 40316cf "Add MIT License", 2026-09-17; GitHub API license record MIT, verified 2026-09-21). Vendor-eligible; user-fetch until a vendoring increment is wanted (the Larryvrh posture).',
    installMode: 'user-fetch',
    homepage: 'https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler',
    // Class ids verified verbatim against the pinned revision's own files
    // (nodes/minimax_h3_latent_upscaler_2d.py and _3d.py, NODE_CLASS_MAPPINGS,
    // 2026-09-21) — exactly the two classes src/lib/graph/upscale.ts emits
    // for upscale.lbh2d/lbh3d. The repo also ships an MMH3 split node this
    // app never calls. Not installed on the canonical shared install — the
    // engine-contract fixture records both classes honestly absent.
    instanceNodeClasses: ['MinimaxH3LatentUpscalerNode2D', 'MinimaxH3LatentUpscaler3D'],
  },
  // -- The preview-decoding path (task t6vub9k; maintainer ruling 2026-09-22
  // after their session's preview crash: "We likely need to use that node
  // for the preview decoding, it's a fairly solid node"). PULLED FORWARD
  // from the curation sweep's queue — deep-read
  // docs/research/preview-override-assessment.md. The pack wraps the H3
  // model with an OUTER_SAMPLE step callback that decodes the video latent
  // itself (tiny TAEHV/TAESD from vae_approx, channel-checked, Latent2RGB
  // fallback at every level) and emits the minimax_h3_preview_override WS
  // event the realtime hub already consumes — the producer the 2026-09-21
  // registry pass could not locate (§4.2 item 3, now closed). Installed and
  // running on the maintainer's own instance. STATUS
  // PROPOSED-PENDING-TEST · ALT: the stock vae_approx file convention
  // (preview_method 'taesd' + the Kijai taeh3 fetch row — the pack-absent
  // fallback the app keeps).
  {
    id: 'h3-preview-override',
    name: 'ComfyUI-MiniMaxH3-PreviewOverride',
    featureGroup: 'H3 video',
    description: 'simsim9-stack\'s live preview override for MiniMax H3: a single node between the model and the sampler that decodes the H3 video latent itself on every step (a trained 24-channel tiny autoencoder from vae_approx — TAEHV/TAESD only, channel-checked, animated Latent2RGB as the graceful fallback) and streams true-RGB frames over the minimax_h3_preview_override websocket event, suppressing the stock sampler preview while sampling. The maintainer-endorsed answer to the fragile stock preview path (its null-previewer crash class when an arbitrary taeh3* file wins the engine\'s prefix match). Ships its own 39.4 MB taeh3_decoder.safetensors (minivae/ — copy into vae_approx per its README); the Kijai 9.3 MB fetch row serves the same slot when the pack is absent.',
    repoUrl: 'https://github.com/simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride',
    pinnedRevision: 'd1eb17beb5e11856f93eb682e0998b6f232969d1',
    licenseSpdx: 'MIT',
    licenseNote: 'MIT (LICENSE file — © 2026 InsanE_GeN — read from the repo at the pinned revision during the 2026-09-22 pack assessment; GitHub API license record MIT). Vendor-eligible; user-fetch until a vendoring increment is wanted (the Larryvrh posture). The shipped decoder weights are a MiniMax-H3 derivative trained by the author for preview purposes — they ride the pack\'s MIT, never vendored by us.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride',
    // Single class, verified from the pinned revision's own preview_override.py
    // (define_schema node_id "MiniMaxH3PreviewOverride", category
    // model/sampling/minimax, is_experimental). This is the class
    // findH3PreviewOverrideNode's pattern match catches and graph/preview.ts
    // wires as node '7'; detection is exact-any-match like every row.
    instanceNodeClasses: ['MiniMaxH3PreviewOverride'],
  },
  // -- The E-FS1 challenge arm (task 464xfvd; assessment
  // docs/research/fizgig-h3-still-assessment.md, maintainer ruling
  // 2026-09-25: "Our T1 method is now obsolete"). STATUS
  // PROPOSED-PENDING-TEST: the pack rides BEHIND the experimentalT1Decode
  // settings flag ('image-studio' default = zero behavior change); the
  // E-FS0/E-FS1 bake-off owns adoption. Removal stays trivial — the
  // registry row + the builder's flag branch + the fixture entries, nothing
  // welds (the assessment's own migration sketch).
  {
    id: 'fizgig-h3-still',
    name: 'ComfyUI-Fizgig-H3-Still',
    featureGroup: 'H3 image',
    description: "shootthesound's 94-line stills pack for MiniMax H3 (zero dependencies, official weights only): a true one-frame packed AV latent — the trainer's preview path — plus a decode that replicates the lone latent into the 5-latent temporal group the H3 ViT decoder was chunk-trained on and keeps pixel frame 3 (past the causal lead-in). The stock decode's banded/dark lone-token output fixed at the source; challenges the T=1 lane's Mamad8 decode head-on.",
    repoUrl: 'https://github.com/shootthesound/ComfyUI-Fizgig-H3-Still',
    pinnedRevision: 'f3252d2b6c94c2e34d71f583d5e1804b683afe06',
    licenseSpdx: 'MIT',
    licenseNote: 'MIT (LICENSE file, Copyright 2026 Peter Neill — read from the repo at the pinned revision f3252d2 during the 2026-09-25 assessment; GitHub API license record MIT). Vendor-eligible; user-fetch. NOT adopted: behind the E-FS1 flag only — the row exists so the flag-on path has detection + a fetch affordance; the bake-off decides whether it stays.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/shootthesound/ComfyUI-Fizgig-H3-Still',
    // NODE_CLASS_MAPPINGS read verbatim from __init__.py @ f3252d2 (the
    // whole pack: 2 classes, category Fizgig). Both classes are exactly
    // what the flag-on T=1 branch emits; the engine-contract fixture
    // carries their schemas source-derived at this pin.
    instanceNodeClasses: ['FizgigH3StillLatent', 'FizgigH3StillDecode'],
  },
]

export function findNodePack(id: string): NodePackDefinition | null {
  return ENGINE_NODE_PACKS.find((pack) => pack.id === id) ?? null
}
