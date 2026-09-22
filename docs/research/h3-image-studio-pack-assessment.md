# ComfyUI-MiniMax-H3-Image-Studio — pack assessment (the H3-as-image for-now question)

> **Provenance.** Maintainer-sent 2026-09-21 with the lean: *"We have complete graphs, a proper T=1 patch, decent documentation. Likely this is what we should be using for H3 as image gen/edit model for now."* Assessed same day.
> **Read at:** commit `47dea30d0bf07e7340ef0cc97e8174a15edf55b9` (v23.0.0, dated 2026-09-12 — main HEAD at assessment), shallow-cloned to scratch, never inside this repo.
> **METHOD:** full code read — `nodes.py` (2,389 lines, all 12 node classes), `__init__.py`, `scripts/convert_single_frame_decoder.py` + `tests/test_decoder_conversion.py`, API graphs `H3_REFERENCE_SINGLE / H3_IMAGE_EDIT / H3_T2I / H3_DETAIL_REFINER`, README + CHANGELOG + VALIDATION (v22/v23); ComfyUI core read at the canonical shared install `a87667f` (`0.34.0`) **and** upstream `master` (raw fetch 2026-09-21). Our side read against `src/lib/graph/h3image.ts`, `src/lib/modelOverrides.ts`, `src/images/submit.ts`, `src/lib/nodePackRegistry.ts`. No GPU, no engine, nothing installed or submitted.
> **Community metrics:** repo created 2026-08-03 (~7 weeks old — above the 2-week fresh-release line, so fair game but secondary): 170 stars, 8 forks, 19 issues (2 open), last push 2026-09-12. Solo author (astropuzzo); the issue tracker is a self-filed release/validation ledger (0 comments on every issue), not community triage.

---

## 1. WHAT IT IS

**Node inventory — 12 classes** (`nodes.py` NODE_CLASS_MAPPINGS), category `MiniMax H3/Image Studio`, zero runtime dependencies (`requirements.txt` empty — PyTorch + ComfyUI's native H3 support only):

| Node | What it does |
|---|---|
| `H3TextToImagePrepare` / `H3ImageToImagePrepare` / `H3ReferenceEditPrepare` / `H3ImagePrepare` | Conditioning + packed AV latent construction for the three modes (T2I FL2VA, I2I FL2VA-or-ref, REF2VA edit, ≤9 ordered `<Picture N>` refs). The combined node is the engine; the three wrappers pin sane defaults. |
| `H3ImageDecode` ("Exact Frame Decode") | Decodes the requested frame profile (trims a larger natural packet), OR independently decodes ONE temporal latent slice through an image VAE (`single_latent_slice`), with `spatial_decode` native / `full_image` (tiling off). Emits a `recommended_index`. |
| `H3ImageFrameSelector` ("Single Image Output") | Frame selection: 10 strategies (decode_recommended / first / stable_quality / balanced_edit / best_quality / most_similar_to_source / sharpest / middle / last / manual), candidate window + skip controls, ranked top-k debug output, optional emit-whole-batch. |
| `H3SamplingSettings` / `H3ImageSamplingPreset` | Sampler + scheduler + sigma-shift configuration as named recipes (incl. the ER-SDE hybrid-single-image profile) or full custom. |
| `H3ImageResolution` / `H3ImageResolutionPreset` | Canvas math: 32-px grid, aspect presets or source ratio, MP profiles 0.40–8.00, native-area cap (768×1344) with aspect-preserving search, honest oversize warnings. |
| `H3DetailToneLock` | Frequency-separation merge: refined image's fine detail + source image's broad tone (separable Gaussian blur low-pass, `tone_lock`/`refinement_strength`/`detail_radius`). |
| `H3WorkflowNote` | Canvas documentation node (legacy compatibility). |

**Graphs shipped — 12 workflows**, each as UI JSON + PNG-with-embedded-workflow + API prompt JSON: IMAGE_GENERATE / IMAGE_EDIT (Turbo 768p 8-step, the workhorses), IMAGE_DRAFT / EDIT_DRAFT (4-step), T2I / I2I / REFERENCE_EDIT (base quality), T2I_SINGLE / I2I_SINGLE / REFERENCE_SINGLE (the T=1 lane), I2I_TURBO, DETAIL_REFINER (Qwen Image Edit 2511 + Lightning 4-step + Detail Tone Lock).

**Weights expected:** the official stack we already use — `minimax_h3_{fl2va,ref2va}_pruned_int8_convrot`, `qwen3vl_32b_minimax_h3_nvfp4_awq`, `minimax_h3_video_vae_fp16` (audio VAE explicitly not required for stills). The T=1 lane adds the community stack our research already pins: the **pre-merged** smhfacct hybrid `minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors`, **Mamad8** `minimax_h3_t1_image_vae_step1597.safetensors`, FL2VA turbo 8-step @0.75, MaxiMin-HHH-R2V-ThisIsFine @0.5. LightX2V turbo adapters for the 768p recipes. The refiner lane wants the Qwen 2511 trio (we don't have it staged).

**Edit modes covered:** T2I, I2I (frame-0 anchor when multi-frame; Picture-1 reference conditioning when 1-frame), REF2VA ordered multi-ref edit with native/semantic transport. No pose/outfit/lighting/background role taxonomy, no directed settle, no refine engines beyond the Qwen pass, no burst lane, no video handoff — those are product-level surfaces, not node-level, and are ours.

## 2. THE T=1 PATCH, PRECISELY (the load-bearing claim)

**It is not a patch.** No ComfyUI core file, no monkey-patching, no fork — the README's claim "they do not patch ComfyUI or route around Image Studio's conditioning output" is literally true in code. The mechanism is a **parallel conditioning implementation**:

- Their Prepare nodes construct the packed H3 AV latent **themselves** (`_empty_h3_av_latent`, nodes.py:308-334): `NestedTensor(video[B,24,T,H/16,W/16], audio[B,32,2,T40])` with zero audio. Their own latent ladder `_latent_t_for_frame_count` permits `latent_t=1` — which decodes exactly 1 frame — and hits 9 and 13 frames exactly (temporal stride 4 per token; remainder table `5+17g+(0,4,8,12,13)`).
- Conditioning is built with the same core primitives the stock node uses (`clip.tokenize` with `minimax_ref_items`/`images`, `encode_from_tokens_scheduled`, `node_helpers.conditioning_set_values` for `minimax_refs`/`minimax_keyframes`) — exposed as a custom node where `length=1` is legal end-to-end, on ComfyUI ≥0.30 (their one-frame profile even predates and works without core commit `0696f61`).
- Decode: `H3ImageDecode` temporal mode keeps the requested profile; **`single_latent_slice` mode independently decodes one slice of a multi-frame latent through the image VAE** — image-VAE decode while retaining multi-frame sampling context. `spatial_decode=full_image` disables VAE tiling on a config copy.
- The decoder file is the **same Mamad8 step1597 we stage**. The sha256-pinned `convert_single_frame_decoder.py` (Diffusers→ComfyUI QKV/SwiGLU layout converter for the newer iamkaikai 500K decoder) is exploratory infrastructure whose own README section documents a **negative** validation result — 500K "not a recommended upgrade" (patch artifacts) [DOC: README:210, v23].

**Why this matters against stock ComfyUI — the floor binds server-side, twice** (this is [Comfy-Org/ComfyUI#15644](https://github.com/Comfy-Org/ComfyUI/issues/15644): opened 2026-08-15, labeled Feature, zero maintainer replies, no PR, no fix scheduled; verified at shared-install `a87667f`/0.34.0 **and** upstream master 2026-09-21):

1. **Prompt validation enforces the schema min on the raw /prompt path** — `execution.py:1020` (`value_smaller_than_min`) fires for typed scalar inputs not consumed by a node's own `VALIDATE_INPUTS`, and `nodes_minimax_h3.py` defines none. A hand-built graph JSON with `"length": 1` on `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` / `EmptyMiniMaxH3LatentAV` is **rejected before execution** — the widget `min=5` is not bypassed by going API-side.
2. **Even past validation, execution promotes the value** — `temporal_shape()` does `align_frame_count(max(5, length))` (nodes_minimax_h3.py:46-48), snapping UP to the 17k+5 grid (5, 22, 39…). Both conditioning nodes' `execute` build their latent through `_empty_av_latent(width, height, length)` — so **the latent output our sampler consumes is always ≥5 frames and grid-snapped**, whatever we submit.

**Comparison to our approach, exactly:** our decoder-class routing + `imageVae`(T=1) override slot govern *which decoder loads* — that was the legacy-pick wedge class we fixed (PR-side, UI/pick-layer, tmz8vh7/epdvxd4), and it is a **different problem entirely** from latent legality. Our T=1 Fast profile submits `length: 1` into the stock conditioning node (`h3image.ts` `conditioningInputs.length = tier`, sampler latent from `[conditioning, 1]`) — **stock engines refuse that prompt at validation**. Our engine-side verification of T=1 to date is graph-shape truth (vitest goldens, fake-engine e2e), not execution truth — nothing we ran would have caught it. We have *not* proven past this floor; the pack has. (If validation were somehow bypassed, the maintainer's "promoted to ≥5" reading is the execution-layer behavior — the refusal fires first as shipped.)

**Secondary correction from the same root — our packet tiers 9 and 13 are inflated:** `align_frame_count` snaps 9→22 and 13→22, so both tiers actually sample a 7-slice latent and decode 22 frames (we publish the first 9/13 via `ImageFromBatch`; 13 decoded frames are discarded on the 9-tier, and 9 vs 13 cost identical sampling). Tiers 5 (t=2) and 39 are native grid points. The pack's ladder hits 9 (t=3) and 13 (t=4) **exactly** — the 9-tier is ~2.3× more temporal slices on stock nodes than through their latent construction. [DOC, core source]

## 3. GRAPH QUALITY vs OURS

**Theirs does things ours doesn't:**
- Legal T=1 end-to-end (§2 — the decisive one).
- **Exact 9/13 packets** instead of snap-to-22 (§2 economy).
- **`single_latent_slice` decode**: image-VAE sharpness on one slice while sampling with multi-frame temporal context — a genuine middle operating point between our packet (video-VAE softness ceiling) and our T=1 (context-free single latent).
- **Semantic (vision-only) reference transport** — experimental global toggle following core commit `1aec3a135`; exactly the "edit-reference pack" lane our spec deferred to user-fetch. (Global, not per-slot like our transport table.)
- **`first_stable_edit` settle detection**: earliest frame at ≥80% of the robust (q90) change peak, requiring two consecutive mature frames — adaptive measured settle vs our pinned 34-38 directed tail; works at any tier.
- Engine-side scorer with `most_similar_to_source` / `balanced_edit` (similarity-weighted) strategies and ranked top-k debug.
- `H3DetailToneLock` frequency separation as a shipped node (cousin of our tone-lock op).
- The Qwen-Edit-2511 Lightning refine lane (a third refine engine; also note their refiner prompt discipline: preservation-first, "do not append the H3 generation prompt").
- Validation-report culture: measured wall-times (4090: T2I 22.16 s incl. load; 0.7-0.98 MP edits 6-16 s), unfiltered comparison sheets committed under `assets/benchmarks/`, negative results published.

**Ours does things theirs doesn't:** the family system itself — six edit families + directed 39 + compose + two refine engines + burst + start-frame exit; role-tagged refs with auto-per-role transport; **generated ownership contracts** (vs their fixed still-wrapper + preservation bands); **honest refusals** (empty contract, >9 refs, off-grid canvas, missing anchors, unnamed defects); **post-build audits** (`h3imgGraphAudit`: T=1-in-video ban, video-node ban, slot budgets, publish-set completeness) + canonical-serialization **golden determinism**; packet-as-one-take UX with app-side scorer and take-strip override; canvas op integration; override lanes (chain>global, legacy migration with D3 auto-clear); the VRAM staging matrix; availability detection with install guidance; RefMod read support; poserig renders as pose refs.

**Where adopting theirs wholesale would REGRESS us:** all of the above "ours" list — their workflows are 12 fixed canvas graphs, not a parametric builder; no audits, no refusal discipline beyond input checks, no contract generation, no canvas/override/staging integration. Their `source_fidelity` is prompt-wording only (honestly documented as not denoise) — same philosophy as our Keep dial, no regression there. Their graphs also re-fit the source inside the Prepare node (`crop_center` default) while our app already fits via `prepareImage` — an adopter must pick one owner of fitting.

## 4. INTEGRATION SHAPE under our architecture

- **Entry:** one `ENGINE_NODE_PACKS` row (`src/lib/nodePackRegistry.ts`) — `astropuzzo/ComfyUI-MiniMax-H3-Image-Studio`, pinned `47dea30…`, 12 `instanceNodeClasses`, ComfyUI-Manager/registry installable (`comfy node install minimax-h3-image-studio`, publisher id `astropuzzo`). Requires ComfyUI ≥0.30 — our shared install is 0.34.0. ✓
- **Modularity contract: clean.** No core patching, no deps, removal = drop the row + revert the builder branches that emit its classes; our detect() degradation already turns missing classes into install guidance. Nothing welds.
- **Duplication vs the engine — partial, and we should NOT call the duplicates:** `H3SamplingSettings`/`H3ImageSamplingPreset` re-bundle what the core `MiniMaxH3SigmaShift` + `BasicScheduler` + `KSamplerSelect` trio already gives us (their fixed profile list would also fight our pinned-recipe tests); `H3ImageResolution(Preset)` duplicates our app-side canvas math; `H3WorkflowNote` is canvas docs; `H3ImageFrameSelector` duplicates our app-side scorer. **The non-duplicating core is four classes:** the Prepare trio + `H3ImageDecode` (+ `H3DetailToneLock` as an optional op).
- **Weights:** no mandatory additions beyond what the T=1 lane already needs — and our scottmudge runtime-merge loader (b25-49 at load) is arguably *better* than their pre-merged smhfacct file (no duplicate multi-GB artifact; their `UNETLoader`-on-one-file path maps onto our existing `merged` override slot). Still graphs through their Prepare also never load the audio VAE (their latent carries zero audio rows the packed DiT denoises anyway) — a small real saving on refs-path stills, where our stock-node graphs must load it.

## 5. MAINTENANCE + LICENSE

- **Cadence:** 33 commits, releases v14→v23 over ~4 weeks (v17.0.1 2026-08-17 → v23.0.0 2026-09-12); disciplined semver + CHANGELOG with deprecation care (legacy profile strings kept loadable so saved workflows never silently change schedule). Last push 2026-09-12 (9 days quiet at assessment). CI: unittest suite with real-tensor runtime tests, release-artifact validation, registry publish + activation checks, benchmark audit scripts.
- **Issue hygiene:** the tracker is the author's own release/validation ledger (19 issues, nearly all self-filed, 0 comments) — a solo-discipline signal, not community triage. Bus factor 1.
- **License: The Unlicense** (SPDX `Unlicense`; LICENSE file + SPDX header in `nodes.py`) — public-domain-equivalent, the permissiveness ceiling: compatible with our AGPLv3 in both directions, **unconditionally vendor-eligible** (contrast GPL-3.0 packs: never vendored; no-license repos: user-fetch only). Consent-gated fetch trivially fine. The *weights* keep their own licenses (smhfacct hybrid, Mamad8 VAE + ThisIsFine adapter, LightX2V turbo, Comfy-Org adapters) — user-fetch via the origin-gated catalog, unchanged from today.

## 6. VERDICT — the maintainer's lean, tested

The three claims: **"complete graphs" TRUE** (12 workflows × three formats, tests, CI, registry publishing, measured validation reports). **"Proper T=1 patch" TRUE IN SUBSTANCE, misnamed** — it is not a patch but a parallel conditioning implementation, and that is exactly why it is durable (survives core updates, works ≥0.30, independent of issue #15644's resolution). **"Decent documentation" TRUE and understated** (honest negative results: white-border artifact on one single-frame gen, 500K decoder not recommended, five-frame "remains recommended for reliability", semantic not consistently faster).

**Direct answer — replace, complement, or patterns? Neither replace nor blanket-complement: ours stays the H3 image path; the pack becomes the engine-side machinery for the specific lanes where stock nodes block or overcharge us.**

1. **T=1 Fast:** our family keeps the UX/contract layer; its graph must switch from stock conditioning to the pack's Prepare+Decode — **until then the family is broken against stock engines** (validation refusal, §2), and `detect()` cannot see this (object_info shows the stock node present; the floor is invisible). Either land the pack row first or flag the family with the known blocker.
2. **Packet economy:** the exact-9/13 latent ladder (same nodes).
3. **`single_latent_slice`:** candidate new fast-sharp mode; also the **prerequisite for E-ED3's T=1 arms (b)/(c)** — as currently designed, that bake-off cannot run its T=1 arms through our builder.
4. **Patterns to steal regardless of install:** `first_stable_edit` settle detection into our scorer; Detail Tone Lock frequency separation for our tone-lock op; their validation-report format for our engine-dependent experiments.

**Migration under the A-3 family registry if adopted:** registry row (vendor-eligible given Unlicense; user-fetch matches current posture) → `detect()` keys `H3ImagePrepare`/`H3ImageDecode` for the `t1` profile → builder branch emits their nodes for T=1 (+ optionally a slice-decode family) → goldens regenerated → E-ED3 unblocked. **Named alternative:** a ~150-line first-party node (our form-adapter precedent, MIT) implementing legal-latent + exact-ladder + slice-decode, pattern-copied from their Unlicense code — zero third-party surface, same capability; the trade is maintenance ours vs theirs. **Not taken:** their sampler/resolution/scoring nodes, the Qwen refiner (we have two measured refine engines).

**The honest ledger:** ours is equivalent-or-better in edit-mode breadth, contracts, refusals, audits, determinism, integration, override lanes, staging. Theirs wins in latent legality (T=1), latent economy (exact 9/13), slice decode, experimental semantic transport, settle-adaptive scoring, and validation-report culture — and its T=1 mechanism is the one thing our stack provably cannot do today.

| Question | Answer |
|---|---|
| What is it | 12-node Unlicense pack: parallel H3 conditioning (legal T=1 latent), exact-frame/slice decode, frame selection, canvas + sampling presets, tone lock; 12 shipped workflows; official + community T=1 stack |
| The T=1 "patch" | Not a patch — own latent construction + own conditioning via core primitives; sidesteps the server-side `min=5` validation AND the `max(5,·)`+grid-snap execution clamp (#15644, open) |
| vs our T=1 | Our lane submits `length:1` to stock nodes → **refused at validation; never executed on a real engine** (graph-shape verification only). Decoder-class routing fixed a different (pick-layer) problem |
| Graph quality | Theirs: T=1 legality, exact 9/13, slice decode, semantic transport, adaptive settle. Ours: families, contracts, refusals, audits, goldens, integration — replacing would regress all of that |
| Integration | One registry row; 4 load-bearing classes (Prepare trio + Decode), the rest duplicate engine/app capability; modularity clean |
| Maintenance/license | Solo, fast disciplined cadence, real tests + measured validation, bus factor 1; Unlicense = vendor-eligible unconditionally |
| **Verdict** | **CORRECT + ADOPT** — corrects our "T=1 works" assumption (stock floor, #15644); adopt as the engine-side T=1/economy machinery (pack row or first-party port), not as our image path |

**Corrections/decisions this feeds:** gate-or-fix the `h3img.generate.t1` family now; re-price packet tiers 9/13 (both = 22 frames on stock nodes); unblock E-ED3 T=1 arms; candidate follow-up research pin — the 17k+5 vs exact-stride latent ladder cost table.

---

## ADDENDUM — 2026-09-22: ADOPTED (task afvlbk4; the maintainer's ruling "adopt the pack for now, and then port later")

The verdict's adoption path landed, exactly per §6's migration sketch minus the port question (deferred by the ruling):

- **The builder routes through the 4 load-bearing classes** (`src/lib/graph/h3image.ts`): when the engine serves any Prepare class, the T=1 and fast-sharp profiles are pack-conditioned (never stock), packet tiers 5/9/13 ride the pack's EXACT latent ladder (t=2/3/4; 39 stays stock — a native grid point with no pack preset), and the decode is `H3ImageDecode` (temporal for packets/T=1; `single_latent_slice` for fast-sharp). The pack's sampler/resolution/selector nodes are still never called; the model chain, recipe pins, contracts, audits, and scorer stay ours. `optimize_for_still=false` on every Prepare — our generated ownership contract is the prompt discipline.
- **The engine-truth gate flipped to capability**: pack present → T=1/fast-sharp render (detection admits); pack absent → the honest fetch-affordance refusal, and the BUILDER THROWS — the stock length:1 emission is dead everywhere (the `h3img.t1-length-1` engine-contract divergence RETIRED; the negative proof stays: a planted length:1 still fails against the real stock schema).
- **New profile — fast-sharp** (`h3img.generate.sharp`): the same 8-step hybrid recipe samples a 5/9/13-frame context, then ONE latent slice decodes through the Mamad8 image VAE — §3's "genuine middle operating point," now a family. The T1-VAE factory guard refined to its true invariant: the VAE may decode exactly one temporal unit (frame or slice), never a multi-frame batch.
- **Contract truth extended to the pack form**: the fixture gained the 5 classes' REAL served schemas (captured from the shared install with the pack cloned at 47dea30, --cpu boot, provenance-recorded); the whole builder corpus now validates CLEAN against the real schemas in both directions (pack-served and the pack-absent stock fallback — whose 9/13 snap stays ledgered as `h3img.packet-tier-9-13`, honestly labeled at the choice points).
- **Execution truth, once**: the 8189 probe (runbook-disciplined) built the T=1 graph through the new path, contract-validated it, submitted → the engine ACCEPTED (node_errors {}), and history carried EXACTLY ONE 1344x768 output frame (~63 s incl. cold loads). The thing the stock floor made impossible is now measured, not asserted.
- **Port-later note**: the maintainer's ruling keeps the first-party ~150-line port (§6's named alternative) as the eventual destination; until then the modularity contract holds — removal = drop the registry row + the builder branches + the fixture entries, nothing welded.
