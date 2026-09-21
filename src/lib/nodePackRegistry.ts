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
 *    user-fetch until a vendoring increment is wanted. */
export const ENGINE_NODE_PACKS: NodePackDefinition[] = [
  {
    id: 'vdn-h3',
    name: 'ComfyUI-VDN-H3',
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
  // -- segmented inference for H3 (task lxmtgss deep-read → task p8oyfy1) --
  {
    id: 'autocontext',
    name: 'ComfyUI_MinimaxH3_AutoContext',
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
]

export function findNodePack(id: string): NodePackDefinition | null {
  return ENGINE_NODE_PACKS.find((pack) => pack.id === id) ?? null
}
