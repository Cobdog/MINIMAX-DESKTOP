/**
 * Vendored custom-node management (increment 2 of task 3ay7wbz — the first
 * slice of AC zzdfklo). custom_nodes/ is ComfyUI's sanctioned extension
 * seam: every pack the managed instance needs is tracked HERE, as data,
 * with an explicit license verdict and install mode:
 *
 *   vendor      the studio ships the pack inside its own repo
 *               (vendor/nodes/<dir>, pinned revision, license-verified
 *               permissive). Install = code files copied into the
 *               checkout's custom_nodes/, WEIGHT files LINKED (never
 *               copied — the AC 35m2zvh invariant), a studio marker
 *               recording id/revision. Uninstall = delete the folder.
 *   user-fetch  the user consents to the pack being placed into the
 *               instance's custom_nodes/ themselves: from a local
 *               directory they nominate, or fetched from the pinned
 *               repository revision through the consent-gated fetcher
 *               (server/fetcher.ts, task hgjbea2 — branch pins are
 *               resolved-and-stamped there). Used for packs whose license
 *               does not permit redistribution — facok's controlnet pack
 *               carries NO license and must never be vendored — and for
 *               packs not yet vendored.
 *
 * LICENSING DISCIPLINE IS ABSOLUTE here: every registry entry carries an
 * SPDX record; a repo with no license file is recorded as 'NO-LICENSE'
 * (all-rights-reserved by default) and forced to user-fetch mode. Anything
 * ambiguous also goes user-fetch. The registry data below is the audit
 * record — see docs/PROVENANCE.md for the vendored payload's provenance.
 *
 * Weight policy (AC 35m2zvh): the managed instance LINKS weights, never
 * copies them. extra_model_paths.yaml v1 already references the user's
 * real model roots in place; this module's linkNeverCopy() is the same
 * invariant for pack-carried weights and for any weight the studio places
 * into a model root: symlink → junction (dirs, Windows) → hardlink (files,
 * same volume) → REFUSE with a reason. Never a byte-for-byte copy.
 *
 * External-instance targets (task 9om4bi9): the same registry and the same
 * install discipline apply when the studio talks to an instance it does NOT
 * launch — the user points it at that instance's custom_nodes folder and
 * packs install into <folder>/<pack name> with identical staging, marker,
 * and foreign-refusal rules. Availability additionally consults the LIVE
 * instance (object_info node classes), so a pack installed-but-not-yet-
 * restarted is reported honestly instead of claimed active.
 */
import { existsSync, statSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AppSettings, ModelKind, NodePackDefinition, NodePackStatus } from '../src/types'

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

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
 *  - ComfyUI-LTXVideo (Lightricks, task 068xwy3): LTX-2 Community License
 *    (LICENSE file read from a fresh clone 2026-09-15) — the IC-LoRA guide
 *    machinery behind the official LTX-2.3 editing templates. User-fetch
 *    (custom license, never vendored).
 *  - ComfyUI-KJNodes (kijai, task 068xwy3): GPL-3.0 (full text in the
 *    clone) — three nodes (GetImageSizeAndCount, ImagePadKJ, VAELoaderKJ).
 *    Fetchable-but-flagged like T8mars.
 *  - radiance (FXTD Studios, task 068xwy3): GPL-3.0 — one node
 *    (Float32ColorCorrect, load-bearing in the outpaint template).
 *    Fetchable-but-flagged.
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
  // ---- LTX-2.3 utility packs (task 068xwy3, verdict keep-utilities-only) --
  {
    id: 'ltxvideo',
    name: 'ComfyUI-LTXVideo',
    description: 'Lightricks\' own LTX node pack — the IC-LoRA machinery the official template_ltx2_3_* editing templates are built on: LTXICLoRALoaderModelOnly + LTXAddVideoICLoRAGuide (the in-context video guide), LTXVSetAudioRefTokens (joint audio-video reference tokens), LTXVTiledVAEDecode and LTXFloatToInt. Required by the remove-subtitles / remove-watermark / restore-archival / remove-object / outpaint utility families.',
    repoUrl: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
    pinnedRevision: '15d09abb5a187a8dcaea2fc31fe51ee96e6c9d0d',
    licenseSpdx: 'LTX-2-Community-License',
    licenseNote: 'The repo ships the LTX-2 Community License Agreement (LICENSE file, read from a fresh clone 2026-09-15 — the same terms as the LTX-2.3 weights). A custom permissive-with-conditions license, not SPDX-listed: user-fetch, never vendored. The node INPUT schemas ported in src/lib/graph/ltx23.ts were verified against this exact revision.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
    // LTXVIDEO_NODES in src/lib/graph/ltx23.ts — INPUT schemas ported and
    // verified against the pinned revision.
    instanceNodeClasses: ['LTXICLoRALoaderModelOnly', 'LTXAddVideoICLoRAGuide', 'LTXVSetAudioRefTokens', 'LTXVTiledVAEDecode', 'LTXFloatToInt'],
  },
  {
    id: 'kjnodes',
    name: 'ComfyUI-KJNodes',
    description: 'kijai\'s kitchen-sink node collection — the LTX-2.3 utilities use three of its nodes: GetImageSizeAndCount (the frame-count split the remove family counts with), ImagePadKJ (the outpaint aspect pad) and VAELoaderKJ (the Obscura Remova tool\'s split bf16 VAE loader with device/dtype control).',
    repoUrl: 'https://github.com/kijai/ComfyUI-KJNodes',
    pinnedRevision: 'd3cfe21625e5170126ce06fbfcfe1d88108688c3',
    licenseSpdx: 'GPL-3.0',
    licenseNote: 'GPL-3.0 (full LICENSE text, read from a fresh clone 2026-09-15). Same fetchable-but-flagged policy as T8mars: GPL-3.0 combines with our AGPLv3 but we never vendor or redistribute it — the user fetches their own copy through the consent flow. We use three nodes out of the pack.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/kijai/ComfyUI-KJNodes',
    // The three nodes we use (KJNODES_USED in src/lib/graph/ltx23.ts). The
    // pack registers hundreds more — any-match keeps detection cheap.
    instanceNodeClasses: ['GetImageSizeAndCount', 'ImagePadKJ', 'VAELoaderKJ'],
  },
  {
    id: 'radiance',
    name: 'radiance',
    description: 'FXTD Studios\' 32-bit color science suite — the LTX-2.3 outpaint template uses one node, Float32ColorCorrect, and it is generation-load-bearing there (the gamma-2 correction of the padded in-context guide; not demo scaffolding). The outpaint tool\'s availability gates on this node.',
    repoUrl: 'https://github.com/fxtdstudios/radiance',
    pinnedRevision: '64fee4144cd4818a087b4269effe6c40d6f6fe2f',
    licenseSpdx: 'GPL-3.0',
    licenseNote: 'GPL-3.0 (GitHub API license record, verified 2026-09-15). Fetchable-but-flagged like every GPL pack: user-fetch only, never vendored; one node used.',
    installMode: 'user-fetch',
    homepage: 'https://github.com/fxtdstudios/radiance',
    // RADIANCE_NODES in src/lib/graph/ltx23.ts — the one load-bearing node.
    instanceNodeClasses: ['Float32ColorCorrect'],
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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Everything the studio must never copy byte-for-byte into an install. */
const WEIGHT_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf'])
/** Dirs that never belong in an installed pack. */
const EXCLUDED_DIRS = new Set(['__pycache__', '.git', '.github', 'node_modules', '.pytest_cache', '.mypy_cache'])
const INSTALL_MARKER = '.studio-node.json'

export function isWeightFile(file: string): boolean {
  return WEIGHT_EXTENSIONS.has(file.slice(file.lastIndexOf('.')).toLowerCase())
}

/** Where a pack installs (task 9om4bi9): either the managed checkout's
 *  custom_nodes/<name>, or — for an instance the studio does not launch —
 *  <external custom nodes folder>/<name>. Both are ComfyUI's sanctioned
 *  extension seam; only the parent differs. */
export type NodePackTarget =
  | { kind: 'checkout'; checkout: string }
  | { kind: 'external'; customNodesDir: string }

/** The shape an EXTERNAL install target must have: an absolute, existing
 *  directory. Deliberately NOT isUsableCheckout — the user points the studio
 *  at the custom_nodes folder itself (which may live on a share or beside an
 *  install we cannot see the root of); demanding main.py there would be a
 *  category error. */
export function isUsableCustomNodesDir(directoryPath: string): boolean {
  if (!directoryPath.trim()) return false
  const candidate = resolve(directoryPath)
  if (!isAbsolute(candidate) || !existsSync(candidate)) return false
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/** Where a pack installs for a given target. */
export function nodePackInstallDir(pack: NodePackDefinition, target: NodePackTarget): string {
  return target.kind === 'checkout'
    ? join(resolve(target.checkout), 'custom_nodes', pack.name)
    : join(resolve(target.customNodesDir), pack.name)
}

/** The custom-nodes ROOT of a target (…/custom_nodes for a checkout, the
 *  folder itself for an external target) — pack-ckpt placements (weights
 *  inside an arbitrary pack folder) resolve against this. */
export function nodePackCustomNodesRoot(target: NodePackTarget): string {
  return target.kind === 'checkout' ? join(resolve(target.checkout), 'custom_nodes') : resolve(target.customNodesDir)
}

/** The install target implied by the engine settings (task 9om4bi9): managed
 *  mode installs into the checkout's custom_nodes/; external mode prefers the
 *  configured external custom nodes folder. LEGACY FALLBACK: an external-mode
 *  studio with a usable checkoutPath and NO external folder keeps installing
 *  into that checkout — the pre-9om4bi9 behavior, never silently dropped
 *  (fetcher installs and existing settings files relied on it). A configured
 *  external folder always wins over a stale checkout in external mode. */
export function resolveNodePackTarget(engine: { mode: string; checkoutPath: string; externalCustomNodesDir?: string }): { target: NodePackTarget | null; targetKind: 'checkout' | 'external' | 'none' } {
  if (engine.mode === 'managed') {
    return isUsableCheckout(engine.checkoutPath)
      ? { target: { kind: 'checkout', checkout: engine.checkoutPath }, targetKind: 'checkout' }
      : { target: null, targetKind: 'none' }
  }
  const directory = engine.externalCustomNodesDir ?? ''
  if (isUsableCustomNodesDir(directory)) return { target: { kind: 'external', customNodesDir: directory }, targetKind: 'external' }
  return isUsableCheckout(engine.checkoutPath)
    ? { target: { kind: 'checkout', checkout: engine.checkoutPath }, targetKind: 'checkout' }
    : { target: null, targetKind: 'none' }
}

/** The vendored payload root: env override first, then a walk up from this
 *  module (dist-server/server → repo root) to vendor/nodes. Null in a
 *  packaged build without the vendor payload — vendored packs then report
 *  unavailable and user-fetch remains the path. */
export function resolveVendorRoot(): string | null {
  const override = process.env.MINIMAX_STUDIO_VENDOR_ROOT?.trim()
  if (override && isAbsolute(override) && existsSync(override)) return override
  return walkUpFor('vendor', 'nodes')
}

/** The first-party payload root (task k271ykk): our OWN node packs live at
 *  the repo's custom-nodes/<dir> — first-class modules, independently
 *  releasable, installed from the studio's own payload without a network.
 *  Same walk as resolveVendorRoot; env override for tests. */
export function resolveFirstPartyRoot(): string | null {
  const override = process.env.MINIMAX_STUDIO_FIRST_PARTY_ROOT?.trim()
  if (override && isAbsolute(override) && existsSync(override)) return override
  return walkUpFor('custom-nodes')
}

function walkUpFor(...segments: string[]): string | null {
  let directory = __dirname
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, ...segments)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/** Where a FIRST-PARTY pack's installable payload lives, when present: the
 *  repo's custom-nodes/<firstPartyDir>. Null = not a first-party pack or no
 *  payload in this install. (Vendor packs keep their injected vendorRoot
 *  seam; user-fetch packs have no studio payload by definition.) */
export function firstPartyPayloadDir(pack: NodePackDefinition): string | null {
  if (pack.installMode !== 'first-party' || !pack.firstPartyDir) return null
  const root = resolveFirstPartyRoot()
  return root && existsSync(join(root, pack.firstPartyDir)) ? join(root, pack.firstPartyDir) : null
}

/** The install marker: our record of what we placed and when. */
type InstallMarker = { id: string; revision: string; mode: string; installedAt: number; source: string }

async function readInstallMarker(installDir: string): Promise<InstallMarker | null> {
  try {
    const raw = JSON.parse(await readFile(join(installDir, INSTALL_MARKER), 'utf8')) as InstallMarker
    if (raw && typeof raw.id === 'string' && typeof raw.revision === 'string') return raw
  } catch { /* not installed by us, or unreadable */ }
  return null
}

// ---------------------------------------------------------------------------
// Weight symlinking — LINK, NEVER COPY (AC 35m2zvh)
// ---------------------------------------------------------------------------

export type LinkKind = 'symlink' | 'junction' | 'hardlink'

/** Links target → linkPath without duplicating bytes. Chain: symlink →
 *  junction (directories, Windows — no privilege needed) → hardlink (files,
 *  same volume only). When none can be created the link is REFUSED with a
 *  reason — the caller surfaces it; a copy is never the fallback. An
 *  existing linkPath that already resolves to the same target is reused
 *  (idempotent); anything else existing there is refused (never silently
 *  re-targeted, never overwritten). */
export async function linkNeverCopy(target: string, linkPath: string): Promise<{ ok: true; kind: LinkKind } | { ok: false; reason: string }> {
  const absoluteTarget = resolve(target)
  if (!existsSync(absoluteTarget)) return { ok: false, reason: `link target does not exist: ${absoluteTarget}` }
  if (existsSync(linkPath) || (await isLinkPresent(linkPath))) {
    const pointsAt = await resolvesTo(linkPath, absoluteTarget)
    if (pointsAt) return { ok: true, kind: 'symlink' }
    return { ok: false, reason: `refusing to overwrite the existing entry at ${linkPath}` }
  }
  const targetStat = await lstat(absoluteTarget)
  try {
    await symlink(absoluteTarget, linkPath)
    return { ok: true, kind: 'symlink' }
  } catch {
    // Windows without developer mode: symlinks need a privilege. Junctions
    // work for directories without one; hardlinks work for files on the
    // same volume. Both still share the bytes — never a copy.
    try {
      if (targetStat.isDirectory()) {
        await symlink(absoluteTarget, linkPath, 'junction')
        return { ok: true, kind: 'junction' }
      }
      await link(absoluteTarget, linkPath)
      return { ok: true, kind: 'hardlink' }
    } catch (linkFailure) {
      return { ok: false, reason: `could not link ${absoluteTarget} → ${linkPath} (${linkFailure instanceof Error ? linkFailure.message : String(linkFailure)})` }
    }
  }
}

/** existsSync follows symlinks — a dangling link needs lstat to be seen. */
async function isLinkPresent(linkPath: string): Promise<boolean> {
  return (await lstat(linkPath).catch(() => null)) !== null
}

async function resolvesTo(linkPath: string, target: string): Promise<boolean> {
  const { realpath } = await import('node:fs/promises')
  try {
    return resolve(await realpath(linkPath)) === resolve(await realpath(target))
  } catch {
    return false
  }
}

/** Places a weight into one of the user's real model roots as a LINK — the
 *  invariant's public seam for any weight the studio ever manages (fetched
 *  checkpoints included; the vendored packs use it for pack-carried
 *  tensors). Returns the link path on success; refusals carry a reason and
 *  NEVER fall back to copying. */
export async function linkWeightIntoModelRoot(source: string, kind: ModelKind, settings: AppSettings): Promise<{ ok: true; path: string; kind: LinkKind } | { ok: false; reason: string }> {
  const root = settings.paths[kind]
  if (typeof root !== 'string' || !isAbsolute(root) || !existsSync(resolve(root))) {
    return { ok: false, reason: `the ${kind} model root is not a usable absolute directory` }
  }
  const name = source.slice(source.replace(/\\/g, '/').lastIndexOf('/') + 1)
  const linkPath = join(resolve(root), name)
  const linked = await linkNeverCopy(source, linkPath)
  return linked.ok ? { ok: true, path: linkPath, kind: linked.kind } : linked
}

// ---------------------------------------------------------------------------
// Availability / install / uninstall
// ---------------------------------------------------------------------------

/** True when the path is shaped like a ComfyUI checkout we may install into. */
export function isUsableCheckout(checkoutPath: string): boolean {
  if (!checkoutPath.trim()) return false
  const checkout = resolve(checkoutPath)
  return isAbsolute(checkout) && existsSync(join(checkout, 'main.py'))
}

/** A 40-hex string is a commit SHA; anything else is a branch/tag name. */
function isShaRevision(revision: string): boolean {
  return /^[0-9a-f]{40}$/i.test(revision)
}

/** The revision an install records: for a branch pin, the fetcher-resolved
 *  HEAD SHA (pin discipline — a branch string in a marker is a moving
 *  target); for a sha pin, the pin itself. */
function installRevision(pack: NodePackDefinition, options: InstallNodePackOptions): string {
  if (!isShaRevision(pack.pinnedRevision) && options.resolvedRevision && isShaRevision(options.resolvedRevision)) return options.resolvedRevision
  return pack.pinnedRevision
}

/** True when a marker revision is a stamped SHA satisfying a branch pin. */
function isBranchPin(markerRevision: string, pinnedRevision: string): boolean {
  return !isShaRevision(pinnedRevision) && isShaRevision(markerRevision)
}

/** Revision recorded in the studio marker of an installed pack, when it is
 *  (the fetcher's catalog status reads this; branch pins report the stamped
 *  fetch-time SHA). */
export async function nodePackInstalledRevision(pack: NodePackDefinition, target: NodePackTarget | null): Promise<string | null> {
  if (!target) return null
  const installDir = nodePackInstallDir(pack, target)
  if (!existsSync(installDir)) return null
  return (await readInstallMarker(installDir))?.revision ?? null
}

/** Live-instance verdict from the CONNECTED engine's object_info keys
 *  (task 9om4bi9): 'active' when any registered class id is served (the
 *  pack is installed AND the instance loaded it), 'absent' when the instance
 *  answered but serves none of them, 'unknown' when there was no object_info
 *  to ask (engine offline / request failed). */
export function nodePackInstanceState(pack: NodePackDefinition, objectInfoKeys: string[] | null): 'active' | 'absent' | 'unknown' {
  if (!objectInfoKeys) return 'unknown'
  if (pack.instanceNodeClasses.length === 0) return 'unknown'
  return objectInfoKeys.some((nodeClass) => pack.instanceNodeClasses.includes(nodeClass)) ? 'active' : 'absent'
}

/** True when the target itself is usable for the operations below. */
function isUsableTarget(target: NodePackTarget): boolean {
  return target.kind === 'checkout' ? isUsableCheckout(target.checkout) : isUsableCustomNodesDir(target.customNodesDir)
}

function targetLabel(target: NodePackTarget): string {
  return target.kind === 'checkout'
    ? 'a valid ComfyUI checkout (with main.py) is required before packs can be installed there.'
    : 'a valid external custom nodes folder (an absolute, existing directory) is required before packs can be installed there.'
}

/** Relative label of the install dir inside its target, for notes. */
function installDirLabel(pack: NodePackDefinition, target: NodePackTarget): string {
  return target.kind === 'checkout' ? `custom_nodes/${pack.name}` : `${pack.name}`
}

export async function checkNodePack(pack: NodePackDefinition, target: NodePackTarget | null, vendorRoot: string | null, instanceState?: NodePackStatus['instanceState']): Promise<NodePackStatus> {
  const vendored = pack.installMode === 'vendor'
    ? Boolean(pack.vendorDir && vendorRoot && existsSync(join(vendorRoot, pack.vendorDir)))
    : pack.installMode === 'first-party'
      ? firstPartyPayloadDir(pack) !== null
      : false
  const base: NodePackStatus = {
    ...pack,
    vendored,
    installed: false,
    availability: 'unavailable',
    targetKind: target ? target.kind : 'none',
    ...(instanceState ? { instanceState } : {}),
  }
  if (!target || !isUsableTarget(target)) {
    return { ...base, note: target?.kind === 'external'
      ? targetLabel(target)
      : 'a valid ComfyUI checkout (with main.py) is required before packs can be installed.' }
  }
  const installDir = nodePackInstallDir(pack, target)
  const folderExists = existsSync(installDir)
  const marker = folderExists ? await readInstallMarker(installDir) : null
  if (marker) {
    const status: NodePackStatus = { ...base, installed: true, installedRevision: marker.revision }
    const drifted = marker.revision !== pack.pinnedRevision && !isBranchPin(marker.revision, pack.pinnedRevision)
    return withAvailability(status, pack, vendored, drifted ? `pinned revision changed — reinstall to move ${marker.revision.slice(0, 12)} → ${pack.pinnedRevision.slice(0, 12)}.` : undefined)
  }
  if (folderExists) {
    // The folder exists but WE did not place it (no studio marker). Never a
    // candidate for replacement or deletion — reported, the user decides.
    // Bugfix (9om4bi9 follow-up, 2026-09-19): in an EXTERNAL custom nodes
    // folder this is the NORMAL state of a working instance — its own packs
    // are already there, and "cannot be installed" was the wrong story. The
    // note now leads with PRESENCE, availability keeps telling the truth
    // about the studio's payload (vendored/first-party rows no longer read
    // as source-less), and the live instance chip says whether it loads.
    const foreignNote = target.kind === 'external'
      ? `${installDirLabel(pack, target)} is already present in the external custom nodes folder — placed outside the studio. The studio never replaces, updates, or deletes it; the live status chip reads the connected instance's own node list. Remove it yourself first if you want the studio's pinned, managed copy.`
      : `${installDirLabel(pack, target)} already exists but was not installed by the studio — remove it yourself first if you want the studio's pinned copy.`
    return withAvailability({ ...base, folderState: 'foreign' }, pack, vendored, foreignNote)
  }
  return withAvailability({ ...base, folderState: 'missing' }, pack, vendored)
}

function withAvailability(status: NodePackStatus, pack: NodePackDefinition, vendored: boolean, note?: string): NodePackStatus {
  const availability: NodePackStatus['availability'] = pack.installMode === 'vendor' || pack.installMode === 'first-party'
    ? (vendored ? 'ready' : 'unavailable')
    : 'needs-source'
  const baseNote = pack.installMode === 'vendor' && !vendored
    ? 'the vendored payload is not present in this install (vendor/nodes not found); use user-fetch from a local copy or the fetcher.'
    : pack.installMode === 'first-party' && !vendored
      ? 'the first-party payload is not present in this install (custom-nodes not found).'
      : pack.installMode === 'user-fetch' && !note
        ? 'user-fetch: install from a local copy of the repository, or through the consent-gated fetcher (Settings → Fetchable items).'
        : undefined
  const notes = [note, baseNote].filter((entry): entry is string => Boolean(entry))
  return { ...status, availability, note: notes.length ? notes.join(' ') : undefined }
}

export type InstallNodePackOptions = {
  /** The install target (task 9om4bi9): the managed checkout OR the external
   *  custom nodes folder. */
  target: NodePackTarget
  /** Local directory holding the pack's files (user-fetch mode: the user's
   *  nominated copy, or the fetcher's extracted archive). */
  sourceDirectory?: string
  vendorRoot?: string | null
  /** Resolved HEAD SHA for a BRANCH pin (task hgjbea2 pin discipline): when
   *  the registry pins a moving branch, the fetcher resolves it at fetch
   *  time and the install marker records THIS — the stamped revision, never
   *  the branch string. Ignored for sha pins. */
  resolvedRevision?: string
}

export type InstallNodePackResult = { status: NodePackStatus; installed: boolean; alreadyInstalled?: boolean; notes: string[] }

/** Installs (or reinstalls-at-pin) one pack into the target's custom-node
 *  folder (the managed checkout's custom_nodes/, or the external custom
 *  nodes folder). Code files are copied; weight files are LINKED (never
 *  copied); a marker records id + pinned revision so a version bump is a
 *  delete-and-reinstall rather than a merge. A foreign <name> folder
 *  (present without our marker) is refused, never replaced — in EITHER
 *  target. The install is staged-then-renamed: a mid-copy failure leaves no
 *  half pack behind. */
export async function installNodePack(pack: NodePackDefinition, options: InstallNodePackOptions): Promise<InstallNodePackResult> {
  const notes: string[] = []
  const { target } = options
  const vendorRoot = options.vendorRoot !== undefined ? options.vendorRoot : resolveVendorRoot()
  if (!isUsableTarget(target)) {
    return { status: await checkNodePack(pack, target, vendorRoot), installed: false, notes: [targetLabel(target)] }
  }
  let sourceRoot: string | null = null
  let sourceLabel = ''
  if (pack.installMode === 'vendor') {
    sourceRoot = pack.vendorDir && vendorRoot ? join(vendorRoot, pack.vendorDir) : null
    sourceLabel = 'vendored payload'
    if (!sourceRoot || !existsSync(sourceRoot)) {
      return { status: await checkNodePack(pack, target, vendorRoot), installed: false, notes: ['the vendored payload is not present in this install.'] }
    }
  } else if (pack.installMode === 'first-party') {
    // OUR OWN code: install from the studio's custom-nodes payload — no
    // network, no third-party license, no sourceDirectory needed.
    sourceRoot = firstPartyPayloadDir(pack)
    sourceLabel = 'first-party payload (custom-nodes)'
    if (!sourceRoot) {
      return { status: await checkNodePack(pack, target, vendorRoot), installed: false, notes: ['the first-party payload is not present in this install (custom-nodes not found).'] }
    }
  } else {
    const nominated = options.sourceDirectory?.trim() ?? ''
    if (!nominated || !isAbsolute(nominated) || !existsSync(resolve(nominated))) {
      return { status: await checkNodePack(pack, target, vendorRoot), installed: false, notes: ['user-fetch packs install from an absolute local directory holding the repository — or one consented fetch through the Fetchable items section, which downloads the pinned revision for you.'] }
    }
    sourceRoot = resolve(nominated)
    sourceLabel = `local copy (${sourceRoot})`
  }

  const installDir = nodePackInstallDir(pack, target)
  const existingMarker = existsSync(installDir) ? await readInstallMarker(installDir) : null
  if (existsSync(installDir) && !existingMarker) {
    return { status: await checkNodePack(pack, target, vendorRoot), installed: false, notes: [`${installDirLabel(pack, target)} already exists but was not installed by the studio — refusing to replace it. Remove it first if you want the pinned copy.`] }
  }
  if (existingMarker && existingMarker.revision === pack.pinnedRevision) {
    return { status: await checkNodePack(pack, target, vendorRoot), installed: true, alreadyInstalled: true, notes: [`${pack.name} is already installed at the pinned revision ${pack.pinnedRevision.slice(0, 12)}.`] }
  }
  if (existingMarker && isBranchPin(existingMarker.revision, pack.pinnedRevision)) {
    // Branch pin already stamped at a resolved SHA: nothing to move. (The
    // fetcher stamps HEAD at fetch time; a later fetch re-stamps.)
    return { status: await checkNodePack(pack, target, vendorRoot), installed: true, alreadyInstalled: true, notes: [`${pack.name} is already installed at the fetched revision ${existingMarker.revision.slice(0, 12)} (branch pin ${pack.pinnedRevision}).`] }
  }
  if (existingMarker) {
    // Version bump: uninstall the old copy, then reinstall at the pin —
    // never merge two revisions of a pack into one folder.
    notes.push(`revision changed (${existingMarker.revision.slice(0, 12)} → ${installRevision(pack, options)}): reinstalling at the pin.`)
    await uninstallNodePack(pack, target)
  }

  await mkdir(dirname(installDir), { recursive: true })
  const staged = `${installDir}.studio-staging`
  await rm(staged, { recursive: true, force: true }).catch(() => undefined)
  try {
    const weightLinks: string[] = []
    await copyPackTree(sourceRoot, staged, weightLinks)
    if (weightLinks.length) notes.push(`weights linked, never copied: ${weightLinks.map((entry) => entry.split(/[/\\]/).pop()).join(', ')}.`)
    const marker: InstallMarker = { id: pack.id, revision: installRevision(pack, options), mode: pack.installMode, installedAt: Date.now(), source: sourceLabel }
    await writeFile(join(staged, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    await rename(staged, installDir)
  } catch (installFailure) {
    // The staged tree never became the installed one — discard it whole.
    await rm(staged, { recursive: true, force: true }).catch(() => undefined)
    const status = await checkNodePack(pack, target, vendorRoot)
    return { status, installed: false, notes: [installFailure instanceof Error ? installFailure.message : String(installFailure)] }
  }
  return { status: await checkNodePack(pack, target, vendorRoot), installed: true, notes }
}

/** Copies the pack tree: code files byte-for-byte, weight files as links
 *  (linkNeverCopy), junk dirs skipped, symlinks replicated as the same kind
 *  of link. A weight that cannot be linked THROWS — the staged tree is then
 *  discarded by the caller's catch, and no half-installed pack survives
 *  (install is staged-then-rename atomic). */
async function copyPackTree(source: string, destination: string, weightLinks: string[]): Promise<void> {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyPackTree(from, to, weightLinks)
      continue
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(from)
      await symlink(target, to).catch((linkFailure: unknown) => { throw new Error(`symlink ${entry.name} could not be replicated (${linkFailure instanceof Error ? linkFailure.message : String(linkFailure)})`) })
      continue
    }
    if (!entry.isFile()) continue
    if (isWeightFile(entry.name)) {
      const linked = await linkNeverCopy(from, to)
      if (!linked.ok) throw new Error(`weight ${entry.name} could not be linked (${linked.reason}) — refusing to copy it instead`)
      weightLinks.push(to)
      continue
    }
    await copyFile(from, to)
  }
}

/** Uninstall = delete the folder (the design's own rule) — but ONLY a
 *  marker install. A folder present WITHOUT the studio marker is foreign:
 *  the studio never deletes what it did not place (the refusal the install
 *  side has always had, now held by the engine itself instead of relying on
 *  the UI's installed-gating — the route is callable directly). */
export async function uninstallNodePack(pack: NodePackDefinition, target: NodePackTarget): Promise<{ removed: boolean; reason?: string }> {
  const installDir = nodePackInstallDir(pack, target)
  if (!existsSync(installDir)) return { removed: false, reason: `${pack.name} is not installed` }
  const marker = await readInstallMarker(installDir)
  if (!marker) {
    return { removed: false, reason: `${pack.name} is present but was not installed by the studio — the studio never deletes a folder it did not place. Remove it yourself if that is what you want.` }
  }
  await rm(installDir, { recursive: true, force: true })
  await rm(`${installDir}.studio-staging`, { recursive: true, force: true }).catch(() => undefined)
  return { removed: true }
}

/** Availability for every entry in one call (the Settings surface + the
 *  nodes route). instanceStates carries the live object_info verdict per
 *  pack id when the caller has one (the route decorates the fs verdicts). */
export async function checkAllNodePacks(target: NodePackTarget | null, vendorRoot: string | null, instanceStates?: Record<string, NodePackStatus['instanceState']>): Promise<NodePackStatus[]> {
  return Promise.all(ENGINE_NODE_PACKS.map((pack) => checkNodePack(pack, target, vendorRoot, instanceStates?.[pack.id])))
}
