# The custom-node inventory — the decision view (2026-09-26)

> **Provenance.** Maintainer ask 2026-09-26: *"an inventory of all custom nodes
> we are planning on using, and what their purpose is — so I can evaluate what
> we have, what can get cut and what can get added."* Flux task `txay0ol`
> (epic 4lphxv8). This is the **decision view** — the one document to mark up.
> It is NOT a second registry:
> [node-pack-registry.md](node-pack-registry.md) stays the living record; rulings
> made in the DECISION column here flow back there as dated addenda.
>
> **METHOD.** Docs synthesis (the registry §1–§11, the nine assessments:
> Image Studio, Fizgig-H3-Still, Fizgig-H3-Tweaks, PreviewOverride, Viggle,
> HyperFlow, YuE2, CrossView-Warp, Qwen-Image-2.1;
> [../licenses/registry.md](../licenses/registry.md)) **plus code verification
> of every USED BY cell** [DOC]: `src/lib/nodePackRegistry.ts` (14
> `ENGINE_NODE_PACKS` rows), `server/engineNodes.ts`, the graph builders
> (`src/lib/workflow.ts`, `src/lib/graph/{h3image,krea2edit,turbo,upscale,preview,registry}.ts`,
> `src/lib/music3Workflow.ts`), `src/lib/h3Submit.ts`, `server/{core,engineProfiles,enginePatch,fetchCatalog}.ts`,
> `src/canvas/generation.ts`, the engine-contract fixture
> `scripts/fixtures/engine-object-info.json` (72 real schemas, v0.37.4 capture
> 2026-09-26), the mirror profiles (`e2e/mirror/profiles/{maintainer-instance,stock-h3}.json`),
> and a read-only `ls` of `/home/agent/comfyui/custom_nodes/` (30 dirs: 25
> packs + the Kreatine/VDN-24GB installs + 5 trial-shim dirs) and the
> maintainer-instance inventory as mirrored. No GPU, no engine, nothing run.
>
> **Status marks:** ✅ adopted + in-use · 🧪 behind a flag or pending its
> experiment (named) · 👁 watch (triggers named) · 💤 dormant (why) · ❓
> unexamined (in the queue). **USED BY is code-verified** — class names grepped
> in the builders/fixtures/registry code; "none today" means no builder emits
> the pack's classes (an assessed-but-unwired row is a status, not a use).
>
> **The DECISION column is yours** (keep / cut / add / park — and anything
> more specific). Nothing below is decided by this document; every row already
> carries its experiment or trigger where one applies.

---

## Group 1 — IN USE (first-party + adopted third-party + the stock core)

| PACK/SOURCE | PURPOSE | STATUS | USED BY (code-verified) | LICENSE | BLAST RADIUS IF CUT | DECISION |
|---|---|---|---|---|---|---|
| **minimax-lora-form-adapter** (OURS, first-party, `custom-nodes/`, v1.0.0) | Load community H3 LoRAs correctly on pruned bases: detects curve vs full-width adaln forms, projects full-width onto curve bases at load | ✅ | H3 video lora stack (`workflow.ts:154` wrapModel; falls back to `LoraLoaderModelOnly`) + the H3 stills lora stack (`graph/h3image.ts`); pack board + PropertiesPanel UI | MIT, first-party | H3 renders fall back to the stock loader — full-width adaln LoRAs silently mis-pair on pruned bases (the bug it exists to fix) | |
| **the in-house seams** (no pack — our code around the packs) | The app-owned machinery: camera-path compiler (`src/lib/camera/`, Apache-2.0 port), the consent-gated LongCache block-loop hook (`server/enginePatch.ts`), the preview-override route (`h3Submit.ts`), schema guards (`engineSemantics.ts`) | ✅ | The video lane's camera guides; the VDN profile's optional patch; every live-preview render's route decision | Apache-2.0 (ported) / first-party | Feature-level losses, not pack-shaped; each is a self-contained module (the modularity contract held) | |
| **ComfyUI-MiniMax-H3-Turbo** (Larryvrh, `4274783`) | Turbo adapter loading with the `h3_silu_temb_grid` pruned-base fix + the paired sampler | ✅ | `graph/turbo.ts` pairings that declare `samplerNode: MiniMaxH3TurboSampler` (**drbaph-4, lightx2v-fl2v-4**; the dedicated loader when served) — `workflow.ts:262` swaps `KSamplerSelect` for it | Apache-2.0, fetch-consent | Those turbo entries degrade to the generic `LoraLoaderModelOnly` + `KSamplerSelect` — loses the grid fix and sampler pairing; other turbo entries unaffected | |
| **ComfyUI_MinimaxH3HybridLoader** (scottmudge, `a44c69b`) | One mmap per checkpoint instead of a pre-merged multi-GB file: b25-49 fl2va+ref2va runtime merge, ref capability at FL2VA quality | ✅ | `graph/h3image.ts` (`HYBRID_LOADER_NODE`) — the packet / T=1 / fast-sharp model load; e2e + canvas store pick it | MIT, fetch-consent | Packet/T=1 stills fall back to stock single-checkpoint loads — reference capability lost unless the pre-merged smhfacct file is fetched | |
| **comfyui-krea2edit** (lbouaraba, `86f886d`) | The dual-conditioning carrier for the Krea 2 identity-edit v1.2 LoRA (image-grounded Qwen3-VL encode) | ✅ | `graph/krea2edit.ts` (`Krea2EditGroundedEncode` ×2 + `ModelPatch`) — the Instruct / removal / two-reference edit families; also `graph/h3image.ts` image.krea2 family | Apache-2.0, fetch-consent | The Krea 2 identity-edit families die (detect() turns absence into install guidance — honest, not silent) | |
| **krea2-anypaint** (alexw5702-afk, `675be5a`) | Arbitrary-mask inpaint/outpaint on Krea 2 via the rank-32 functional adapter, per-step latent restoration | ✅ | `graph/krea2edit.ts` (`Krea2AnyPaintPrepare/Encode/ModelPatch`) — the anypaint family | MIT, fetch-consent | The Krea 2 inpaint/outpaint families die. NOTE: superseded on the Kreatine lane (Kreatine vendors prepare/encode byte-faithfully) — keep only while the non-Kreatine lane runs | |
| **ComfyUI-MiniMax-H3-Image-Studio** (astropuzzo, v23.0.0 `47dea30`) | The one thing stock nodes provably cannot do: legal T=1 latents, the exact 9/13-frame ladder (stock snaps both to 22), and `single_latent_slice` fast-sharp decode. **4+1 of 12 classes called; the other 7 duplicate app/engine capability and are never called** | ✅ adopted (afvlbk4; the maintainer's "adopt now, port later") | `graph/h3image.ts`: T=1 + fast-sharp + packet tiers 5/9/13 (`H3ImagePrepare` set + `H3ImageDecode`, temporal + slice modes); pack-absent ⇒ honest refusal + builder throws (the stock length:1 path is dead everywhere) | Unlicense, fetch-consent (vendor-eligible) | **High**: T=1/fast-sharp die outright; 9/13 packets return to the 22-frame snap (~2.3× temporal cost); E-ED3's T=1 arms re-blocked | |
| **ComfyUI-MiniMaxH3-PreviewOverride** (simsim9-stack, `d1eb17b`) | True-RGB per-step preview decoding, structurally immune to the stock path's null-previewer crash class; emits the `minimax_h3_preview_override` WS stream the hub already consumes | ✅ adopted (the maintainer's 2026-09-22 ruling, t6vub9k) | `graph/preview.ts` `PREVIEW_ENTRY` — wired as node `'7'` on **every live-preview render when the pack is served** (both modes, `resolvePreviewOverride` in `h3Submit.ts`); `server/core.ts` suppresses `preview_method` for override graphs. Absent on the canonical shared install (fixture `absent`) — live today on your instance | MIT, fetch-consent | Previews degrade to the stock vae_approx file convention — the fragile arm the pack exists to fix (the sha-pinned Kijai decoder is that arm's mitigation) | |
| **stock core (ComfyUI v0.37.4)** — no pack | The bulk of every graph: H3 video conditioning (`MiniMaxH3ImageToVideo/ReferenceToVideo/AddGuide/SigmaShift`, `EmptyMiniMaxH3LatentAV`), the `SamplerCustomAdvanced` grammar, KSampler paths (Krea 2, Music 3), the Klein trio (`Flux2Scheduler`/`EmptyFlux2LatentImage`/`CFGGuider`+`DualCLIPLoader` — **BROKEN-UNTIL-FIXED**: two schema divergences in `engineSemantics.ts`), the Music 3 audio set, the stock `LTXV{Separate,Concat}AVLatent` split/join the LBH lane reuses | ✅ | All lanes — **50 of the 72 emitted classes (69%)**; `QwenImage21` + `YuE2` native classes are served natively at 0.37.4 but not yet emitted (families pending, Group 3) | GPL-3.0 (the engine itself), user's own instance | N/A — this is the floor. The number to know before cutting packs: see the ratio section | |

## Group 2 — BUILT BUT GATED (the arm exists in code, default-off)

| PACK/SOURCE | PURPOSE | STATUS | USED BY | LICENSE | BLAST RADIUS IF CUT | DECISION |
|---|---|---|---|---|---|---|
| **ComfyUI-Fizgig-H3-Still** (shootthesound, `f3252d2`) | The T=1 challenge: a 94-line legal one-frame latent (stock conditioning kept, legal length submitted) + group-replicate video-VAE decode that claims to beat the Mamad8 image VAE on speed AND detail with zero extra weights | 🧪 **E-FS0/E-FS1** (464xfvd) — behind the `experimentalT1Decode` flag (`'image-studio'` default ⇒ byte-identical goldens, zero drift proven) | `graph/h3image.ts` flag-on T=1 branch only (`FizgigH3StillLatent` node 17 + `FizgigH3StillDecode`); fixture schemas source-derived at the pin (pack not installed) | MIT, fetch-consent (vendor-eligible) | **Trivial** — drop the row + flag branch + fixture entries; nothing welds. If it WINS instead: T=1 migrates, Mamad8 dependency retires, Image Studio stays for packets/sharp | |

## Group 3 — PENDING ADOPTION (the experiment queue)

| PACK/SOURCE | PURPOSE | STATUS | USED BY | LICENSE | BLAST RADIUS IF CUT | DECISION |
|---|---|---|---|---|---|---|
| **ComfyUI-Hyperflow** (Saganaki22, `b4bd9cf` + drbaph converted weights) | The flow-map (two-time `(t,r)`) distillation axis — NVlabs-productionized for H3. Same 8 NFE as our turbo: a **quality-side candidate at matched cost**, not a speed win | 🧪 **HF-1** (matched arms vs larryvrh v4-8; TS-1 shares the scoreboard) | None today — the seam is named and exists (`workflow.ts` turbo seam; `ApplyHyperFlow` would feed `SamplerCustomAdvanced.sigmas`) | Apache-2.0 code / MiniMax H3 Community License weights | None — nothing wired. XOR slot with turbo/VDN adapters; never loads through the generic LoRA loader | |
| **Viggle-Animate** (weights via drbaph `Viggle-Animate-ComfyUI`: pruned-int8 21 GB + r64 LoRA + frozen embed) | The recast-footage cell no lane covers: driving video + one repainted frame → whole-scene motion/camera transfer, non-human by construction; composes with our image-edit surface upstream | 🧪 **VG-1** (vs Fun Control + R2V edit; VG-2 the R2 reference falsifier). Gate OPEN — the int8 convrt quants shipped 09-05 (ul1l4j7 unblocked by fetch) | None today — **and no pack needed**: the conditioning layout is a graph-factory job on stock ref2va nodes (the Saganaki22 Viggle pack 404'd; Viggle's own inference = stock + two monkey-patches) | MiniMax H3 Community License (same class as our base stack) | None — nothing wired. Animate v2 in training upstream: do not over-invest in v1-specific wiring | |
| **Meridian** (Viggle, adapters-on-base: 2×2.5 GB LoRAs + VGGT-Omega) | Geometry-guided re-camera: depth+poses → colored 3-D points → render the camera path → H3 refines; camera and time as independent axes | 👁 **watch** — method adopts NOW (the camera-paths lane designs around geometry-render + cheap preview); weights wait for: a community ComfyUI port/quants, VGGT-Omega relicensing, or the camera-lane build starting | None today | H3 Community on weights — but **VGGT-Omega is FAIR Noncommercial**: any commercial posture is gated on a replacement | None — nothing wired | |
| **Qwen-Image-2.1-viggle-turbo** (Viggle, LoRA r256/r128) | 6-pass no-CFG few-step student of Qwen-Image-2.1 (~5× on the Workbench edit-lane candidate); rides the same family gate | 🧪 **VG-3** (their conceded limits are the falsifier: dense text, complicated edits) | None today — the Qwen-2.1 family itself is unwired (its native core nodes are served at 0.37.4) | `qwen-research` — **non-commercial**, flagged at consent | None — nothing wired | |
| **ComfyUI-Fizgig-H3-Tweaks** (shootthesound, `5f8b48a`) | CFG-free inference-shaping dials: Prompt Strength (fills the documented no-adherence-dial-at-guidance-1.0 gap — the 768p rescue candidate), Detail & Contrast band, graded Scene Variation | 🧪 **E-TW1/TW2/TW3** (prompt strength headline; detail sequenced BEHIND E-FS1; variation as the takes primitive). No registry row until an arm wins — a winning dial ports MIT-clean in ~60 lines (port-over-fetch) | None today (nothing emits `FizgigH3Tweaks`) | MIT | None — nothing wired; siblings "H3 Block Skip"/"Token Route" recorded UNEXAMINED-NEXT | |
| **ComfyUI-Kreatine** (YOURS — GPLv3, your copyright; installed on the shared instance, symlinked vendor) | The intended Krea path: two-stage raw→turbo sampling with sigma-exact handoff, prompt weighting, reference recipes, anypaint/control — single resident model | 🧪 **TS-1** is its gate (Krea first; H3 port only if the hypothesis survives). Row + license decision (vendor / first-party install / dual-license) land when the Krea lane adopts | None today (no `ENGINE_NODE_PACKS` row, no emission). On adoption it supersedes **facok controlnet + ostris-edit + standalone anypaint** on that lane (Group 3/6) | GPLv3 — the open decision is yours (registry §5: the never-vendor-GPL rule exists for third-party contributor sets; here the contributor set is us) | None — nothing wired | |
| **ComfyUI-VDN-H3** (Saganaki22, vendored `3eb6349`; the **-24GB** variant is separately installed on the shared instance) | Trained efficiency branch: delta-attention acceleration as runtime model patches — a different class from LoRA distills; the -24GB variant brings the validated AutoMemory policy for this stack | 🧪 the VDN arm (task 9up52mj, **planning**) | **None today — no builder emits `ApplyVDNH3`.** Wired regardless: vendored tree (`vendor/nodes/`), the `vdn` engine launch profile (`engineProfiles.ts`), the consent-gated LongCache hook, and the VDN stage-weight fetch rows | Apache-2.0 (vendored, LICENSE in-tree) | Row-drop trivial at the graph level; removing the vendored tree also drops the engine profile + patch + weight rows (one manifest-pattern change) | |
| **ComfyUI_MinimaxH3_AutoContext** (supElement, `f1062d3`) | Long-form without chain drift: prompt-timeline slicing, per-segment refs, 3-channel anchoring, hash-keyed latent cache with resume | 🧪/💤 the named **TS test vs Motion-Context** decides the default long-form lane — not scheduled yet | None today (row + deep-read only; not installed on the shared install) | Apache-2.0, fetch-consent | None — nothing wired | |
| **comfyui-minimax-h3-audio-T8** (T8mars, branch `main`) | H3 *video* audio editing sidecar (`MiniMaxH3AudioConditioningT8`) | 💤 **dormant** — pattern-adopt only so far; node names in-flux upstream; the audio lane is parked (vzpyldn) | None today | GPL-3.0-or-later, fetch-consent flagged | None — nothing wired | |
| **comfyui-krea2-controlnet** (facok, branch `main`) | Depth structure lock for Krea 2 (the control LoRA carrier) | 💤 **superseded-on-the-Kreatine-lane / cut candidate** — `KreatineControlLoader` loads the same weights license-clean; the row survives only as the non-Kreatine fallback arm | None today (row only; installed on the shared instance) | **NO-LICENSE** — fetch-consent flagged, never vendored | None — nothing wired | |

## Group 4 — THE MAINTAINER'S INSTANCE PACKS (the mirrored five)

PreviewOverride (Group 1) is the fifth of the mirrored five — listed once, above.
The ownership map that matters: on your instance **multishot's probe owns
`MiniMaxH3.extra_conds`** (one-node stood down; base Motion-Context does not
patch); VHS wraps `get_previewer` but is **inert for our graphs** (the
`VHS_latentpreview` opt-in is never sent); lora-manager's hook rides every node
execution. **Our emitted graphs are pass-through/inert in both regimes** — the
load-bearing conclusion of registry §11. Nothing here is ours to install or
remove; the rows exist so instance-level decisions are informed.

| PACK/SOURCE | PURPOSE | STATUS | USED BY (ours) | LICENSE | BLAST RADIUS IF CUT (your instance) | DECISION |
|---|---|---|---|---|---|---|
| **ComfyUI-Lora-Manager** (willmiao, examined `77109b3c` — the Kreatine vendor copy) | LoRA browsing/management; `SaveImageLM` civitai-style metadata; Kreatine's LoraBridge optionally persists through it | 👁 **observe-only** — values pass through untouched, every collection step fail-soft; it cannot alter results | None on the wire (zero `*LM` classes emitted); the hook does ride OUR jobs on a carrying engine: per-node overhead + a 3-prompt retention hold incl. ≥1 decoded image tensor by reference | GPL-3.0, runtime-only | Engine starts fine; Kreatine persistence degrades (by design — the Native+ rule never requires it); `SaveImageLM` workflows lose embedded metadata | |
| **ComfyUI-H3-Multishot** (jlucasmcrell, `d7d1977` v2.7.2) | Seamless multishot chaining: `H3Multishot*`, `H3KeyframeInject`, Rift prompts — **and the `h3_avbank_probe` extra_conds MERGE** (stock overwrites refs whenever keyframes are present) | 👁 environment — but **LOAD-BEARING semantics on your instance**: it is the sole owner of the merge there | None on the wire — our conditioning is pass-through by construction. The pattern-adopt (ownership-marker cohabitation) is what we bank | MIT | **Heads the cut-sensitivity list**: removal restores the stock overwrite bug and breaks every `H3KeyframeInject` chaining workflow you run | |
| **one-node-minimax-h3** (AIFSH fork, examined `2ba3a2e`; identification caveated) | The all-in-one H3 pipeline node (Chain/T2V/I2V/R2V/Keyframes/Extend, Audio Lock, nested upscaler, sigma refiner) | 💤 **dormant on your instance today** — its payload wrapper stands down while Motion-Context-MultiRef is absent ("repair unavailable" prints, nothing crashes) | None — and note it hard-imports **our LBH upscaler** at runtime (`H3NestedLatentUpscaler`) | GPL-3.0 | Its own all-in-one workflows; nothing of ours | |
| **ComfyUI-VideoHelperSuite** (Kosinkadink, `4d907be`) | Video I/O (`VHS_LoadVideo/VHS_VideoCombine`), batch ops, ffmpeg advanced previews | 💤 **inert for our graphs** — the wrapper only activates on a workflow opt-in we never send; our stills lane additionally forbids `VHS_VideoCombine` in code | None (the `get_previewer` wrapper is why VHS frames appear in preview-crash traces — surface, not cause) | GPL-3.0, runtime-only | Your multishot/one-node export steps that call `VHS_VideoCombine`; one-node's ffmpeg probe degrades | |

**UNEXAMINED-NEXT** (none installed on the mirrored five; all would ride a
fuller multishot/one-node setup — one line each, ❓ in the queue):

1. `ComfyUI_JoyAI_Echo_GGUF_Nodes` — bundled **modified** inside multishot's release zip (license unread).
2. base **Motion-Context pinned at 0.3.1** by multishot's preflight — it *refuses* 0.4.0+, at odds with one-node's MultiRef preference (neither flavor is on your instance; our shared install runs v0.6.2).
3. `RES4LYF` (beta57) — advanced sampling machinery, multishot co-install.
4. `ComfyUI-sol-attn` — sparse attention, multishot co-install.
5. `comfyui-minimax-h3-blockcache-T8` (T8mars — same author as our dormant T8 row).
6. `ComfyUI-Custom-Scripts` — QoL UI scripts.
7. `comfyui-inspire-pack` — the KJNodes-adjacent utility pack.
8. `ComfyUI-H3-Motion-Context-MultiRef` (seitanism, GPL-3.0, pin `0719855`) — **the actual extra_conds patch owner in one-node's recipe**; installing it flips ownership away from multishot's probe (compatible by design, marker-mediated).
9. `comfyui-vrgamedevgirl` — the Audio Lock provider one-node uses; upstream `LeonQ8/ComfyUI-ALLinONE-MinimaxH3` is one-node's parent.

**Our shared install's environment tier** (on `/home/agent/comfyui`, no rows by
design — environment, not product dependencies; the studio never requires
them): `comfyui_controlnet_aux`, `ComfyUI-KJNodes`, `rgthree-comfy`,
`crystools`, `basic_data_handling`, `dlss5-nr`, `ComfyUI-llamaPrompt`,
`intern_nodes`, `comfyui-tooling-nodes` (ETN — the bridge bring-in, Group 6),
the inpaint cluster (`LanPaint`, `comfyui-inpaint-nodes`,
`ComfyUI-Inpaint-CropAndStitch` + the duplicate `comfyui-crop-and-stitch` —
**one should go**), `comfyui-krea2-ostris-edit` + `krea2t-enhancer` (Group 6),
`ComfyUI-Kreatine`, `ComfyUI-VDN-H3-24GB`, and the gitignored trial shims.

## Group 5 — THE DEPENDENCY-PACKS our graphs require (the gap rows)

Found by the 2026-09-21 curation pass as load-bearing classes with no row
(detection/pinning/license invisible) — both closed (06jr4eh). They are not
feature adoptions; they are **required dependencies of shipping builders**.

| PACK/SOURCE | PURPOSE | STATUS | USED BY | LICENSE | BLAST RADIUS IF CUT | DECISION |
|---|---|---|---|---|---|---|
| **ComfyUI-H3-Motion-Context** (NikoDemon80, `5335715` v0.6.2 — the shared install's rev) | The chain lane's engine side: pins the previous clip's tail — picture sliced from the latent, audio window ending at the join — so the next clip continues rather than restarts | ✅ in use | `workflow.ts` chain lane (`MiniMaxH3MotionContextLoadLatent/MotionContext/SaveLatent/Trim`, nodes 24/26/28) + `src/canvas/generation.ts` chain continuation; `engineSemantics.ts` schema handling | **GPL-3.0-only**, fetch-consent flagged, never vendored | **The canvas chain lane dies** — no alternative is wired (AutoContext is the untested overlap, Group 3) | |
| **Comfyui_Minimax_h3_latent_Upscaler** (LBH-123-AI, `40316cf`) | 2× in latent space — keeps the audio path intact where the pixel path drops it | ✅ in use | `graph/upscale.ts` `upscale.lbh2d`/`lbh3d` (`MinimaxH3LatentUpscalerNode2D`/`3D` + the stock split/join/refine-sigma machinery). **Not installed on the shared install** — the fixture records both classes honestly absent; the fetch affordance covers the pick | MIT, fetch-consent (vendor candidate); the upscaler WEIGHTS are separate engine-side downloads | The LBH hires-fix entries go inert; the RTX pixel fallback works but **drops audio** | |
| *(the upscale lane's gated third arm)* **SeedVR2** video upscaler | The E-IW2 burst-enhancement arm's upscaler | 🧪 **E-IW2 gated** — deliberately not vendored or installed in v1 | Referenced by the upscale lane's contract only (fixture `absent` records it) | per its HF card — verify at any adoption | None — nothing wired | |

## Group 6 — CANDIDATES / IDEAS (the alternates and fallback ladders)

| PACK/SOURCE | PURPOSE | STATUS | USED BY | LICENSE | NOTES | DECISION |
|---|---|---|---|---|---|---|
| **ComfyUI-CrossViewWarp** (cseti007) + the CrossView-Warp LoRA (Cseti, step 3500) | Novel-view synthesis from video: MoGe depth-warp of the source into the target camera pose (magenta disocclusion holes promptable) feeding `MiniMaxH3AddGuide`; the LoRA steers viewpoint while the reference carries identity | 👁 **ADOPT post-remediation** (the assessment's verdict) — earns its place via a ref2v identity × camera-fidelity suite | None today — the port surface is our own `AddGuide`/`ReferenceToVideo` (already emitted); **the node is the only new dependency, and the LoRA works without it** if we produce warps from our own camera compiler | H3 Community License on the LoRA (territory carve-outs, same as base); node license unexamined | Composes with the DMD turbo stack out of the box (their examples run it stacked) | |
| **first-party Image Studio port** (~150 lines, Unlicense pattern-copy) | The standing "port later" destination for the 4+1 load-bearing classes — bus-factor-1 mitigation | 💤 the maintainer's 2026-09-22 ruling keeps it as the eventual destination | Would replace the fetch row | Unlicense — pattern-copy asks nothing | The trade is maintenance-ours vs theirs; nothing to do until the port increment is wanted | |
| **first-party Fizgig decode port** (~30 lines, MIT) | The hybrid fallback if E-FS1's decode-isolated arm (C) wins alone: keep the Image Studio latent, adopt group-decode | 💤 ladder position only | None | MIT | Named in the assessment; a follow-up, never shipped ahead of the verdict | |
| **first-party `ApplyHyperFlow` equivalent** | The named fallback if the Saganaki22 pack disappoints but HF-1's quality signal justifies the lane | 💤 ladder position only | None | Apache-2.0 pattern-copy | Moderate job (embedder + schedule + key remap + patcher forward patches) | |
| **comfyui-tooling-nodes / ETN** (Acly, installed on the shared install) | The bridge transport: in-RAM image cache both directions, `SendImageWebSocket`, regions, `model_info` — the Workbench↔external-editor lane's carrier | 👁 **bridge bring-in** — fold into the Workbench spec round; do not build ahead of it | None today | GPL-3.0 — runtime-only forever, never vendored | The Intern contract-seam vocabulary (`intern_nodes`, yours) is the Monoka-flavored alternative | |
| **the inpaint cluster** (`comfyui-inpaint-nodes`, `LanPaint`, `CropAndStitch` ×2) | Workbench-utility class: LaMa/MAT/Fooocus heads, universal sampler, crop-and-stitch | 👁 Workbench bring-in candidates at its spec round | None today | various (unexamined as rows) | Plus the instance-level duplicate-cleanup note (registry §2.5) | |
| **krea2t-enhancer** (capitan01r, installed, no row) | Prompt-adherence enhancement for Krea 2 turbo | 👁 **WATCH/PENDING-TEST** — candidate quality arm for the Krea lane's TS run | None today | unexamined | Not deeply examined; rides the Kreatine decision | |
| **comfyui-krea2-ostris-edit** (installed, no row) | The ostris/ai-toolkit t=0 edit-LoRA recipe runner | 💤 **CUT candidate** — redundant where Kreatine runs (`KreatineReferencePatch` implements the t=0 recipe; `index` defers to core `ReferenceLatent`) | None today | unexamined (registry §1.3) | Correctly absent from `ENGINE_NODE_PACKS`; do not add | |
| **the sweep's WATCH tier** (LongMedia latent-ops, FL-MiniMaxH3 transitions, Continuum N2B, MiniMaxH3Mod RefMod, + the speed/prompt clusters) | The transitions/experiment lanes' adoption candidates — held, not re-litigated here | 👁 owned by their lanes (absorbed as rows when those lanes become product) | None today | per-pack at row time | Registry §3 records the standing deferral | |
| **Anima** (circlestone-labs, 2B anime/illustration T2I — future arrival) | The Workbench character/reference-sheet lane's asset-authoring model | ❓ verify at arrival — stock loaders expected, no pack anticipated | None today | [UNK] — verify at arrival | **Name flag**: collides with the Intern pack's `Anima*` node prefix — rename one side when it lands | |

---

## STOCK-VS-PACK RATIO — how much of the graph surface is stock core

The engine-contract fixture (`scripts/fixtures/engine-object-info.json`,
captured 2026-09-26 at the shared install, v0.37.4) holds **72 real schemas —
every class our builders emit**:

- **50 stock core (69%)** — the conditioning, sampler, loader, decode, and I/O
  spine, the Klein trio, the Music 3 audio set, the stock AV split/join.
- **20 pack-emitted (28%)** — Image Studio 5 · Motion Context 4 · AnyPaint 3 ·
  Krea2Edit 2 · Turbo 2 · Fizgig 2 (flag-gated) · Hybrid Loader 1 ·
  Form Loader 1 (first-party).
- **2 pack classes served but never called** (3%) — Motion Context's own
  `…Chain` / `…SeamProbe`.

Counting the emitted-but-absent classes too (LBH 2D/3D, PreviewOverride —
referenced by builders, honestly absent on the shared install), the full
emitted surface is **75 classes: 50 stock (67%) / 25 pack (33%)**. Of the pack
third: 1 is first-party, 2 are flag-gated, 4 are chain-lane-only, 2 are
conditional turbo pairings — the **unconditional third-party surface in the
default render path is 11 classes across 6 packs** (Image Studio, hybrid
loader, krea2edit, anypaint, Motion Context, LBH). The healthy reading: this
is a stock-core app with a thin, named, removable pack layer — exactly the
shape the registry-only directives intended, and the number to hold onto
before any cut makes the pack share *look* bigger than it is.

## THE CUT-SENSITIVITY SHORTLIST — ordered, trivial last

1. **h3-multishot (your instance)** — the only entry whose removal changes
   *semantics silently*: it owns the `extra_conds` keyframe+ref MERGE; cutting
   it restores the stock overwrite bug inside every chaining workflow you run.
   Observe-only for us; heads the list because "no error, wrong output" is the
   worst failure class.
2. **h3-image-studio (ours)** — highest in-app blast: T=1/fast-sharp die
   outright (the builder throws; the stock length:1 path is retired), 9/13
   packets snap to 22 frames (~2.3× cost), E-ED3's T=1 arms re-block. Do not
   cut before the Fizgig arm reports (E-FS1 is precisely the replacement
   question).
3. **h3-motion-context (ours)** — the canvas chain lane dies with no wired
   alternative (AutoContext is the untested overlap — cutting both closes the
   long-form lane entirely).
4. **h3-preview-override (ours)** — degrades to the stock vae_approx
   convention: not a hard break, but the fragile arm (the crash class your
   session hit); the sha-pinned Kijai decoder is the mitigation.
5. **lbh-latent-upscaler (ours)** — LBH hires-fix entries go inert; the RTX
   fallback works but drops audio (a silent capability loss on video upscales).
6. **krea2edit + krea2-anypaint (ours)** — the Krea 2 edit families die
   honestly (detect() → install guidance). Anypaint additionally has its
   Kreatine-lane supersession pending — the pair is one decision, not two.
7. **h3-hybrid-loader (ours)** — falls back to stock single-checkpoint loads;
   capability loss (ref2va reference on the packet lane) unless the pre-merged
   file is fetched.
8. **minimax-h3-turbo (ours)** — two turbo entries degrade to the generic
   loader (grid fix + sampler pairing lost); the rest of the turbo stack is
   weights-as-data and unaffected.
9. **minimax-lora-form-adapter (ours, first-party)** — the stock loader
   fallback mis-pairs full-width adaln LoRAs on pruned bases, silently.
10. **Trivial row-drops (zero in-app breakage today):** fizgig-h3-still
    (flag-off default, byte-identical goldens prove zero drift) · VDN (nothing
    emits its classes — only the vendored tree/profile/patch/weights go with
    it) · krea2-controlnet, h3-audio-t8, autocontext (rows without emissions)
    · Fizgig-Tweaks (no row yet) · everything in Groups 4/6 (instance-level or
    unwired candidates).

---

### Registry-vs-code notes (code wins; disagreements footnoted)

- **[¹]** The registry doc's §1 header still reads "11 pack rows" (its
  2026-09-21 pass); `ENGINE_NODE_PACKS` carries **14 today** (the 11 +
  `h3-preview-override` 09-22 + `fizgig-h3-still` 09-26 — the latter has a
  license row and flag wiring but no §1.1 table row yet). The standing
  registry's §9 ledger already records both additions; the §1 table catches up
  at its next dated addendum.
- **[²]** The licenses registry §4's second table still lists
  `Lightricks/ComfyUI-LTXVideo`, `kijai/ComfyUI-KJNodes`, and
  `fxtdstudios/radiance` as fetch-catalog pack rows; **code carries only
  `pack:lora-form-adapter` + the `nodePackEntry()` derivatives** of the 14
  registry rows — the LTX-era pack rows left with the LTX lane removal. A
  licenses-registry cleanup row-level fix, not urgent (the audit gate keys on
  present ids, not absent prose).
- **[³]** VDN's registry row reads as speed-stack machinery in active posture;
  code truth is **machinery fully wired (vendored tree, engine profile, patch
  consent, weight rows) but zero builder emissions** — the graph lane is the
  unplanned arm (9up52mj). USED BY reflects code.
- **[⁴]** PreviewOverride is adopted and wired but **not installed on the
  canonical shared install** (fixture `absent`; it lives on your instance) —
  shared-install renders still ride the stock preview arm there. The GPU-window
  micro-checks that promote it to ADOPTED-TESTED are still queued.

*Rulings from the DECISION column flow back to
[node-pack-registry.md](node-pack-registry.md) as dated addenda — this file is
the mark-up surface, not the record.*
