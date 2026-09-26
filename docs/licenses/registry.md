# The Monoka license registry

> **What this is:** the standing, heavy-diligence record of every third-party
> component Monoka touches — code, packs, weights, fonts, ideas — with what the
> license ACTUALLY STATES (one honest line, not just the SPDX label), how we use
> it, whether it survives AGPLv3, what it obligates, and what it costs to rip
> out. Commissioned by maintainer directives `5b19f1bb` (the license
> infrastructure) and `c5673267` (surface minimality) on epic 4lphxv8; the
> diligence is heavy, the surface is minimal.
>
> **The four license documents, one line each:**
> [LICENSE](../../LICENSE) is the grant (AGPLv3 full text) ·
> [docs/LICENSES.md](../LICENSES.md) is the consolidated third-party NOTICES
> file (the distribution surface — what we ship and what it obligates) ·
> **this file** is the registry (the internal diligence record) ·
> [policy.md](policy.md) is the decision rules + compliance map.
> [PROVENANCE.md](../PROVENANCE.md) records who *we* are (fork lineage, the
> rewrite measurement).
>
> **Machine-checked:** `pnpm license:audit` (gate + CI) verifies registry ↔
> reality lockstep — every `package.json` dependency, every fetch-catalog
> entry id, every node-pack registry id, and every vendored directory named
> below, or the build fails. An addition without its registry row fails CI.
>
> **Verification legend** (inherited from docs/LICENSES.md):
> `[API-YYYY-MM-DD]` checked against the GitHub/HF API that day ·
> `[LOCAL]` verified in this repo's tree · `[DOC]` recorded from research
> captures (`docs/research/*`), not independently re-verified this pass ·
> `[UNK]` not yet verified — verify before adoption.

## Usage modes and blast radius

| Mode | Meaning | C&D blast radius (the modularity contract) |
| --- | --- | --- |
| **vendored** | Third-party code ships in this repo at a pinned revision | The manifest pattern: delete `vendor/nodes/<dir>` + its registry row + LICENSES.md §2 row; the audit catches the residue. Never welded — no vendored pack may grow import edges beyond the node-class seam |
| **fetch-consent** | The user obtains it, through the consent-gated catalog or a local copy they nominate; we redistribute nothing | **Trivial** — delete the catalog entry + registry row. No code of ours contains its bytes; the graph builders reference node *classes*, not pack code |
| **API** | We call a hosted service; nothing enters our tree | Trivial — remove the client call site |
| **replicated** (ported) | Re-implementation in our language; no upstream bytes ship | Provenance headers + goldens; removal = delete the module |
| **referenced-only** | Idea/pattern source in research docs or devdocs; no code or asset flows | Nothing to remove — the citation stays, and citations are protected speech |

The invariant that makes every "less than ideal" license safe: **we never
redistribute what we cannot ship.** The fetch-consent catalog is the standing
workaround (policy.md §3).

---

## 1. Our own code — license and fork inheritance (task 68rnn84, carried forward)

| Component | Source / revision | License as stated | Mode | AGPLv3 verdict | Obligations | Blast radius |
| --- | --- | --- | --- | --- | --- | --- |
| Monoka itself | this repo (`Cobdog/Monoka-dev`, renamed from `Cobdog/MINIMAX-DESKTOP` 2026-09-20) | AGPLv3, full text at repo root `[LOCAL]` | first-party | — | Conveying: license text + source (§4/§6); network interaction: source offer (§13); interactive UIs: Appropriate Legal Notices (§5d) — satisfied by the Settings → License & source section | n/a |
| Upstream fork base (`jamesk9526/MINIMAX-DESKTOP`, no license file → all-rights-reserved) | merge-base `f58eb4b` (upstream tip, 2026-09-09) | **No license — ARR by default.** Our position (recorded openly in [PROVENANCE.md](../PROVENANCE.md)): upstream is machine-generated (no human authorship → not copyrightable per US Copyright Office guidance), and the rewrite is measured: **96.2% of the tree ex-lockfile is authored in-project; upstream residue is 4,516 lines, fully enumerated** (mobile route, Studios suite + prompt machinery, aux builders, styles.css design language, scraps). If the no-authorship position were ever rejected, exposure is exactly that residue; remedies in order: replace it / seek a written grant from jamesk9526 / carve-outs (not recommended) | inherited | The AGPLv3 claim rests on the two recorded grounds; nothing new obstructs it (68rnn84 verdict, 2026-09-17) | Keep the final-diff statement current as the residue shrinks | A C&D from upstream → execute remedy 1 (replace ~4.5k lines, largest chunks: styles.css ~1.3k, mobile route ~388, Studios suite ~2k). Costly but bounded, and the diff is the evidence |
| `docs/archive/plan-v0.md` | upstream planning doc, archived per archive-don't-delete | upstream prose, kept for history, not shipped code | referenced-only | no code exposure | none | already inert |

## 2. Runtime + dev dependencies (all 38 direct, every one permissive)

Every direct dependency is permissive and AGPLv3-compatible — notices ride in
the manifests (`node_modules/<pkg>/package.json` `license` fields) + the
lockfile pins exact versions; a bundled/binary distribution would need a
generated notices bundle first (LICENSES.md §9.2). The full per-package table
with versions regenerates from `pnpm license:audit` into
[docs/LICENSES.md §1](../LICENSES.md); the rows below are the license classes
that carry anything beyond "notice":

| Component(s) | License as stated | Obligations beyond notice | Verdict |
| --- | --- | --- | --- |
| `@huggingface/transformers` | Apache-2.0 — full text + patent grant; §4: retain notices, state changes | Apache §4 notice retention (met by manifest + lockfile) | clean |
| `@playwright/test`, `typescript` | Apache-2.0 (dev deps, not distributed) | — | clean |
| `d3-selection`, `d3-transition`, `d3-zoom` | ISC — permission to use/copy/modify/sell, "provided that… copyright notice… this permission notice… appear in all copies" | copyright + permission notice retention | clean |
| `lucide-react` | ISC (see also §6 — the icon system) | same ISC notice class | clean |
| The MIT mass: `react`, `react-dom`, `zustand`, `better-sqlite3`, `pino`, `pino-pretty`, `ws`, `three`, `hash-wasm`, `react-rnd`, `@base-ui/react`, `@eslint/js`, `@rollup/rollup-win32-x64-msvc`, `@types/better-sqlite3`, `@types/d3-selection`, `@types/d3-transition`, `@types/d3-zoom`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/three`, `@types/ws`, `@vitejs/plugin-react`, `eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`, `stylelint`, `stylelint-config-standard`, `typescript-eslint`, `vite`, `vitest` | MIT — do anything, keep the copyright + permission notice | notice only | clean |

MPL-2.0, BSD, Unlicense-class deps would also pass the audit allowlist; GPL
family WARNs (combining-compatible but distribution duties — record the
decision before committing to one); CC-BY is permissive-but-attribution (never
vendorable); anything NC/proprietary/missing FAILs.

## 3. Vendored, ported, and first-party code (ships in this repo)

| Component | Source / pin | License as stated | Mode | Obligations (and how met) | Blast radius |
| --- | --- | --- | --- | --- | --- |
| `ComfyUI-VDN-H3` (vendor tree) | `Saganaki22/ComfyUI-VDN-H3` @ `3eb63496c24ca70faaf8a14b6c75fcb480e34bf1` (v1.5.2) | Apache-2.0 `[API-2026-09-14]` `[LOCAL]` | vendored | Apache §4: LICENSE ships in-tree (audit-checked); changes stated (functional content verbatim; `.git/`, `.github/`, `assets/`, workflow PNGs excluded — recorded in PROVENANCE) | manifest pattern; pack `vdn-h3` row goes with it |
| LongCache patch constants (`server/enginePatch.ts`) | maintainer's ComfyUI-VDN-H3-24GB fork, `tools/install_minimax_block_loop_hook.py` @ local scratchpad | Apache-2.0 as the fork states it; **second reading** — if the ~45 constant lines substantially copy ComfyUI's own loop, they are GPL-3.0 in origin (a licensee cannot relicense the licensor's code). Either reading: no blocker, only attribution (LICENSES.md §8; sign-off still staged) | replicated (verbatim port of constants, TS) | in-file attribution header `[LOCAL]`; never ship a pre-applied patch; applies user-locally behind consent, reversible | self-contained module; the §8 analysis is the record |
| Camera-path compiler (`src/lib/camera/`) | `NyckM/3d-Camera-control-H3-Minimax` @ `846880de859959e801b2c506dc424bd5c8b5c6c4` | Apache-2.0 `[LOCAL]` (LICENSE read from the clone before porting) | replicated (faithful TS port, compiler half only; no upstream bytes) | Apache §4 via per-file provenance headers (repo + commit) + deviations documented in module headers; fidelity locked by upstream-generated goldens (`pnpm test:camera`) | delete the module + goldens; zero import edges outside its seam |
| `minimax-lora-form-adapter` (custom node) | first-party, `v1.0.0` | MIT (LICENSE in the pack) | first-party | MIT notice (shipped); **zero MiniMax-derived runtime bytes** — the projection encoder derives at first use from the user's own artifacts; test-only golden vectors documented in the pack's FIXTURES.md | copy-the-directory = the pack; independently releasable |

## 4. Node packs (the `ENGINE_NODE_PACKS` registry — all ids machine-checked)

Policy in one line: permissive = vendor-eligible; GPL/NO-LICENSE = fetch-consent
only, flagged at consent time (license text + verdict surfaced before the
network is touched); we never redistribute them.

| Pack id | Source / pin | License as stated | Mode | Verdict + obligations | Blast radius |
| --- | --- | --- | --- | --- | --- |
| `vdn-h3` | Saganaki22 @ `3eb6349…` | Apache-2.0 | vendored (§3) | clean; notice | manifest pattern |
| `lora-form-adapter` | first-party | MIT | first-party | clean | trivial |
| `minimax-h3-turbo` | Larryvrh @ `4274783a…` | Apache-2.0 `[API-2026-09-14]` | fetch-consent (vendor candidate) | clean; notice if ever vendored | trivial |
| `h3-hybrid-loader` | scottmudge @ `a44c69b0…` | MIT `[LOCAL 2026-09-18]` | fetch-consent (vendor candidate) | clean | trivial |
| `krea2-controlnet` | facok @ branch `main` (SHA stamped at fetch) | **NO-LICENSE — no license file in the repo; all-rights-reserved by default.** Redistribution not permitted, ever | fetch-consent, flagged | gate holds — we never redistribute; user installs their own copy. NOTE: superseded-by-Kreatine on the Krea lane (§7) | trivial |
| `h3-audio-t8` | T8mars @ branch `main` (SHA stamped) | **GPL-3.0-or-later** — combining-compatible with AGPLv3, but vendoring would fold third-party GPL code into our distribution and couple releases to an unmaintained-by-us contributor set | fetch-consent, flagged; pattern-adopt only in our code | none triggered (never redistributed) | trivial |
| `krea2edit` | lbouaraba @ `86f886da…` | Apache-2.0 `[API-2026-09-14]` | fetch-consent | clean; solo-maintained, v2 retrain in progress — re-verify at v2 | trivial |
| `krea2-anypaint` | alexw5702-afk @ `675be5a9…` | MIT `[API-2026-09-14]` (NOTICE credits Rebels + ostris) | fetch-consent | clean | trivial |
| `autocontext` | supElement @ `f1062d34…` | Apache-2.0 `[API-2026-09-16]` | fetch-consent (vendor candidate — 14 files, no weights) | clean | trivial |
| `h3-image-studio` | astropuzzo @ `47dea30…` (v23.0.0) | Unlicense `[code-read 2026-09-21 — pack assessment; served-schema capture from the shared install's clone at this rev 2026-09-22]` | fetch-consent (vendor-eligible: public-domain-equivalent; user-fetch matches the current posture — "adopt now, port later" per the maintainer's 2026-09-22 ruling) | clean | trivial — the ADOPTED T=1/exact-9-13/slice-decode machinery (task afvlbk4; the gate's pack, d4er4ati); our builder emits its 5 load-bearing classes |
| `h3-motion-context` | NikoDemon80 @ `5335715a…` (v0.6.2) | **GPL-3.0-only** — plain v3 LICENSE (no or-later grant), read from the canonical shared install's copy at this rev `[LOCAL 2026-09-21]` | fetch-consent, flagged; never vendored (the T8mars posture) | none triggered (never redistributed); the chain lane's engine side (GAP-1 closed, task 06jr4eh) | trivial |
| `lbh-latent-upscaler` | LBH-123-AI @ `40316cf0…` | MIT `[API + code-read 2026-09-21 — LICENSE added upstream at exactly this commit, 2026-09-17]` | fetch-consent (vendor candidate) | clean; the upscaler WEIGHTS are separate engine-side downloads | trivial — the LBH 2D/3D hires-fix lane (GAP-2 closed, task 06jr4eh) |
| `h3-preview-override` | simsim9-stack @ `d1eb17b0…` | MIT `[code-read 2026-09-22 — LICENSE file (© 2026 InsanE_GeN) read from the repo at the pinned revision during the pack assessment; GitHub API license record MIT]` | fetch-consent (vendor candidate) | clean; the shipped 39.4 MB `taeh3_decoder.safetensors` is a MiniMax-H3-derivative weight that rides the pack's own minivae/ (README's copy-into-vae_approx step) — never vendored by us, and the catalog's Kijai taeh3 row keeps serving the vae_approx slot | trivial — the maintainer-endorsed preview-decoding path (task t6vub9k; the pack-absent fallback is the stock vae_approx file convention) |
| `fizgig-h3-still` | shootthesound @ `f3252d2b…` | MIT `[code-read 2026-09-25 — LICENSE file (© 2026 Peter Neill) read from the repo at the pinned revision during the pack assessment (the whole pack: 94 lines, 2 classes); GitHub API license record MIT]` | fetch-consent (vendor candidate) | clean; zero dependencies, official weights only — the pack RETIRES a weight dependency (the Mamad8 T=1 VAE) rather than adding one | trivial — the E-FS1 challenge arm behind the `experimentalT1Decode` flag only (task 464xfvd; NOT adopted — the bake-off owns the verdict); removal = the registry row + the builder's flag branch + the fixture entries, nothing welds |

Fetch-catalog packs not in `ENGINE_NODE_PACKS` (fetched into the user's
instance; same fetch-consent discipline):

| Pack | Pin | License as stated | Verdict |
| --- | --- | --- | --- |
| `pack:lora-form-adapter` (catalog face of the first-party pack) | — | MIT | clean (our own payload, no network) |
| Lightricks/ComfyUI-LTXVideo | `15d09abb…` | **LTX-2-Community-License** — the same agreement as the LTX-2.3 weights (§5): revenue-threshold commercial use + moderation + AI-disclosure duties | fetch-consent; never vendored (custom license, not SPDX-listed) |
| kijai/ComfyUI-KJNodes | `d3cfe216…` | GPL-3.0 `[LOCAL 2026-09-15]` | fetch-consent, flagged (three LTX-2.3 utility nodes) |
| fxtdstudios/radiance | `64fee414…` | GPL-3.0 `[API-2026-09-15]` | fetch-consent, flagged (Float32ColorCorrect) |
| ComfyUI reference checkout (`engine-comfyui` catalog id) | tag `v0.34.0` → `12d52794…` | **GPL-3.0.** The checkout exists only on the user's machine, produced by their consented fetch; we convey nothing | fetch-consent, flagged; the §8 tool-vs-program analysis applied to the whole engine |
| ComfyUI_MinimaxH3_AutoContext deep-read sources, Motion Context (NikoDemon80), LBH upscaler | — | Motion Context: **GPL-3.0** `[DOC]` (devdocs MANIFEST); LBH: no provenance yet | GAP rows from the node-pack curation pass: license/pin verification happens AT ROW TIME before they enter `ENGINE_NODE_PACKS` |

## 5. Model weights and checkpoints (never in the repo; linked, never copied)

Weights are fetched by the user with the license surfaced at consent
(`flaggedLicense()` classes in FetchBrowser), or staged manually. We convey
none of them. The catalog pins sizes + sha256 per file.

### 5a. The MiniMax H3 community-license family

What the license actually states (as recorded; the agreement text is
MiniMax's, per-repo): the weights are a licensed grant, not open source —
community-reported **Applicable Territory excludes EU/UK/South Korea/USA**;
commercial use requires a MiniMax license (sold through Comfy); **outputs
follow the same terms**; derivatives inherit. Verify the current text on the
model card — this is `[DOC]`-grade, community-confirmed in multiple pack
READMEs, not legal advice.

| Asset (catalog id where fetchable) | License record | Mode |
| --- | --- | --- |
| MiniMax H3 base / turbo / audio-VAE (the primary stack) | MiniMax H3 Community License `[DOC]` | manual-stage (user-supplied); the one-time LicenseNotice was the designed in-app surface — currently unrouted, see policy.md §4 |
| `vdn-stage-dmd-250`, `vdn-stage-b-2000` (OpenVDN/vdn-minimax-h3) | `minimax-h3-community-license-agreement` `[API-2026-09-14]` | fetch-consent |
| `fun-control-union` (alibaba-pai) | MiniMax H3 Community License `[API]` | fetch-consent |
| `smhfacct-hybrid-b25-49` | inherits fl2va/ref2va terms, no additional grant `[API]` | fetch-consent (optional; runtime merge preferred) |
| `mamad8-t1-image-vae` | MiniMax H3 derivative, no separate grant `[API-2026-09-18]` | fetch-consent |
| `fasth3-vae-w4a8` (jacokon) | `minimax-h3-community-license-agreement` + **HF dataset gate** (per-account acceptance; anonymous fetch fails honestly 401) `[API-2026-09-15]` | fetch-consent |
| `matlowai-fused-turbo-int8-convrot` (`matlowai-fused-turbo-int8` catalog id) | merged weights stay MiniMax-H3 derivatives (folded turbo/base conversion are Apache-2.0 sides) `[API-2026-09-15]` | fetch-consent |
| `taeh3-preview-decoder` (Kijai) | **Apache-2.0 repo**; the weights are a MiniMax-H3 derivative trained by Kijai `[API-2026-09-18]` | fetch-consent |
| Viggle/Viggle-Animate; t8star Vdn-Minimax-H3-Comfy; FastVideo FastH3; Tutu 20→8 NFE LoRA | `minimax-h3-community-license` class `[API]`/`[DOC]` | watch tier |

### 5b. The Krea 2 community-license family

What it actually states (from the LICENSE.pdf + NOTICE, `[API-2026-09-14]`):
derivative works under the same license; **commercial use only under the
revenue threshold (§2.3, currently <$1M/yr)**; content-moderation duty (§4.2);
AI-disclosure duties (§4.3); the identity-edit author additionally disallows
non-consensual use of real people. These are USER duties that ride the
weights — surfaced at consent, never enforced in-app (the content-neutral
position, 68rnn84 F10).

| Asset | License record | Mode |
| --- | --- | --- |
| `krea2-identity-edit` (conradlocke v1.2 + r128/r64) | `krea-2-community-license` `[API]` | fetch-consent |
| `krea2-anypaint` (yijunwang2 rank-32 adapter; its pipeline code carries a separate PIPELINE_LICENSE — only the adapter is fetched) | `krea-2-community-license` `[API]` | fetch-consent |
| Krea 2 base + style-reference module | Krea AI Community License `[DOC]` | verify at first-classing |

### 5c. The LTX-2 community-license family

What it actually states (LICENSE dated 2026-01-05, `[API-2026-09-15]`): the
Lightricks counterpart of the community licenses — permitted commercial use
under a revenue threshold, content-moderation + AI-disclosure duties; the
`ltx-video-license` rows are derivatives linking the same Lightricks terms.

Catalog ids under this class: `ltx23-dev-checkpoint`, `ltx23-dev-fp8`,
`ltx23-gemma-encoders` (Comfy-Org repack of Gemma 3 — Gemma terms also apply
to the underlying weights), `ltx23-latent-upscaler`, `ltx23-distilled-loras`,
`ltx23-distilled-rank111`, `ltx23-dearchive`, `ltx23-obscura-remova`,
`ltx23-ic-outpaint` (these three carry `ltx-video-license`),
`ltx23-kijai-transformer`, `ltx23-kijai-projection`, `ltx23-kijai-vaes`
(Kijai conversions, same terms). All fetch-consent, flagged at consent.
`ltx23-icedit-remove-pair` (joyfox) is **Apache-2.0** on the LoRAs themselves
— outputs remain subject to the LTX-2.3 base terms.

### 5d. Qwen (the regime change)

What the license actually states (full text read, `[DOC 2026-09-20]`):
**Qwen RESEARCH LICENSE — NOT Apache-2.0** (every predecessor in the family
was; 2.1 changed the regime). Non-commercial — research/evaluation use only;
commercial use requires a separate license from Alibaba; attribution + naming
restrictions ("Built with Qwen" documentation when outputs train distributed
models; "Qwen" must not be a derivative product's primary name);
redistribution requires the license copy + change notices; **governed by
Chinese law, Hangzhou courts**.

Catalog ids: `qwen21-dit-convrot`, `qwen21-te-convrot`, `qwen21-vae` —
fetch-consent, flagged (the `flaggedLicense()` restricted-use class catches
`qwen-research`). A commercial posture for the app would flip this family to
NONE — not our call to make, and the personal-desktop use case stays inside
the research grant.

### 5e. The audio lane (research-stage rows)

| Asset | License as stated | Mode |
| --- | --- | --- |
| YuE2-3B (m-a-p) | **CC-BY-NC 4.0 on the weights** — ungated public download; attribution required; non-commercial, and in CC-BY-NC practice the terms attach to outputs/adaptations. Lineage break: every YuE 1.x repo was Apache-2.0 (v1 preserved on the `YuE-v1` branch); code components MIT (stable-audio-tools, SnakeBeta). Every derivative quant/LoRA inherits NC `[DOC 2026-09-21]` | fetch-consent when adopted; never vendored; forecloses selling YuE2-generated music — music3 stays the commercial-safe rung (acestep removed 2026-09-21, nn5ld47) |
| MiniMax Music 3 (MiniMaxAI/MiniMax-Music3) | **MiniMax Community License — open weights, ungated** (corrected 2026-09-21 from "provider API terms"; the paid music API closed to new users 2026-08-20). Commercial use free under the revenue threshold (~$20M/yr) with attribution `[DOC]` | fetch-consent when the music3 dock goes first-class; same consent surfacing as §5a |
| ACE-Step (1.5) | Apache-2.0 per the research capture `[DOC]` — **re-verify at any adoption commit** (LICENSES.md §5 keeps this row open) | fetch-consent when first-classed |
| LTX-2.5, Z-Image | per their HF cards — **verify at first-classing time** `[UNK]` | open |

### 5f. The image lane: Klein, Anima, Qwen-IE

| Asset | License | Mode |
| --- | --- | --- |
| FLUX.2 klein (BFL, 4B/9B base + distilled) — the fast refine tier | **`[UNK]` — not yet verified.** BFL model licenses are custom agreements (the FLUX Dev class is non-commercial with output terms); nothing may be assumed from the family name. Verify the repo LICENSE before the family enters the model registry | fetch-consent only after the row exists |
| Anima (circlestone-labs, 2B anime/illustration T2I) — future arrival | **`[UNK]` — verify at arrival.** Also: the name collides with the Intern pack's `Anima*` node prefix — rename one side when it lands (node-pack-registry §1.5) | stock loaders expected; verify |
| Qwen-Image-Edit 2511 Lightning (refine watch-item) | same Qwen research license as §5d | referenced-only today |

### 5g. Preprocessor weights

| Asset | License | Mode |
| --- | --- | --- |
| `dwpose-onnx` (yzd-v), `dwpose-torchscript` (hr16), `da3-base` (Comfy-Org Depth-Anything-3) | Apache-2.0 `[API-2026-09-14]` | fetch-consent; notice-clean |
| `hed-annotator`, `mlsd-annotator` (lllyasviel/Annotators) | **NO-LICENSE** — repo carries only a `license: other` tag, no file `[API]` | fetch-consent, flagged; never redistributed |

## 6. Fonts, icons, cursor (the shibui plan — none shipped yet)

Planned per [shibui-fonts-icons.md](../research/shibui-fonts-icons.md); rows
become obligations only when files land in `public/fonts/`:

| Asset | License as stated | Obligations when shipped | Verdict |
| --- | --- | --- | --- |
| JetBrains Mono (variable, mono voice) | **OFL 1.1** — bundle/embed freely in AGPL software, ship the license text, respect Reserved Font Names (no renaming internal names; no subclassing — we do neither) | OFL copy beside the woff2 + the Reserved-Font-Name discipline | vendor-safe |
| IBM Plex Sans (variable, body voice) | OFL | same | vendor-safe |
| Nerd Fonts symbols-only subset (fallback glyph layer) | OFL (patched-font release) | same; the full patched fonts (127 MB+) are never shipped — symbols-only ~3 MB | vendor-safe |
| lucide-react (current dep, planned upgrade `^0.468.0 → ^1.47.0`) | ISC | notice (already in §2) | vendor-safe |
| The custom cursor | self-drawn PNG data-URIs (sumi fill, washi outline) — first-party work | none (our own asset) | clean |
| Berkeley Mono (considered) | **Proprietary** — commercial license, no app embedding, no redistribution | — | **REJECTED** — cannot ship in an AGPL repo; recorded so it is not re-litigated |

## 7. The open-decision zone (maintainer calls — surfaced, not decided)

| Component | The question | The facts that frame it |
| --- | --- | --- |
| **ComfyUI-Kreatine** (the maintainer's own two-stage sampler) | Vendor / fetch-consent / first-party-install / dual-license? | **GPLv3, and the copyright is the maintainer's** — the never-vendor-GPL rule exists to avoid coupling releases to third-party contributor sets; here the contributor set is us. Options recorded in [node-pack-registry.md §5](../research/node-pack-registry.md). The registry row (when the Krea lane lands) records which and why. Subordination note: Kreatine itself vendors the anypaint prepare/encode pair byte-faithfully (MIT notices kept) and takes schedule math from Auryg (MIT) + per-token weighting from Kijai lineage (GPLv3) — consistent with its own GPLv3; it ships THIRD_PARTY_NOTICES.md |
| **astropuzzo ComfyUI-MiniMax-H3-Image-Studio** | Vendor the 4 needed nodes, or write the ~150-line first-party port? | **The Unlicense** — public-domain-equivalent, the permissiveness ceiling: unconditionally vendor-eligible under AGPLv3, and equally clean to pattern-copy (the Unlicense asks nothing — no attribution obligation exists; we would still credit by habit, not duty). Both paths license-clean; the trade is maintenance-ours vs bus-factor-1-theirs. Adoption task in flight |
| **Acly comfyui-tooling-nodes (ETN)** | Runtime-only GPL dependency for the bridge lane | GPL-3.0 — installed on the user's instance, never vendored; the separate-process/instance boundary is the compliance mechanism (policy.md §2 grey) |
| **Acly/krita-ai-diffusion** | Prior art for a Monoka↔editor bridge | GPL-3.0 — referenced-only; code never copied (the transport *pattern* is uncopyrightable fact) |
| **intern_nodes** (the maintainer's own contract-seam pack) | Row + license when the bridge lane lands | first-party-class; assign a license at row time (MIT suggested — matches the form-adapter precedent) |

Standing decisions carried forward from 68rnn84 (staged, unchanged): the
headers policy (LICENSES.md §7 — default A, no per-file headers); the VDN
patch §8 sign-off (status-quo + documentation recommended).

## 8. Referenced-only (docs/library + docs/devdocs captures)

The [library](../library/README.md) and [devdocs](../devdocs/MANIFEST.md)
captures are internal reference copies — GPL-3.0 and no-license sources read
there, never shipped, never vendored; each capture's header carries its
license verdict. External ARR web docs (docs.comfy.org) are cited as URLs
where possible; captured pages are internal-reference only. Nothing in this
section distributes.

## 9. The C&D posture, summarized

If any single component's owner ever objects, the answer is already
mechanical:

1. **Fetch-consent items (all GPL/NO-LICENSE/NC packs, every weight):** remove
   the catalog row + registry row. We never possessed a distribution right and
   never exercised one; the user's own consented copy is theirs. Cost: minutes.
2. **Vendored Apache/MIT items:** the grant is irrevocable-in-practice and
   recorded at a pinned revision; a hostile relicensing upstream cannot
   retroactively revoke the version we pinned. Cost of removal anyway: the
   manifest pattern.
3. **Our AGPLv3 claim:** the 68rnn84 measurement is the defense file — the
   diff is the evidence; remedies enumerated and bounded.
4. **The name**: "Monoka" + the placeholder grep-ability note (PROVENANCE) —
   no third-party naming exposure known; the Qwen naming restriction is the
   one live naming rule (never make "Qwen" a product name — it never will be).

*This registry is engineering diligence, not legal advice (IANAL, as ever).
The grey areas and the disclaimer live in [policy.md §5](policy.md).*
