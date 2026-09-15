# H3 LoRA form compatibility — full-width ↔ pruned (curve) adaln

**Task:** Universal full-width→pruned LoRA compatibility for H3 (ti4dvtj) · **Date:** 2026-09-14
**Status:** research complete; verdict + architecture below. Evidence tags: **[SPEC]** primary source (code/checkpoint bytes), **[DOC]** official documentation, **[COMM]** community artifact/report, **[NUM]** measured in this investigation (all numbers reproducible from public artifacts + the local testbed; measurement scripts preserved in the task ti4dvtj comment log).

---

## 0. TL;DR

**Premise correction (maintainer, 2026-09-14):** the shape error came from the **Turbo LoRA**, not a style LoRA — and the Turbo LoRA "works on pruned" in the normal stack only because it is loaded through **larryvrh's node**, which silently form-adapts it at runtime (generic `LoraLoader` on the b25-49-INT8 hybrid exposes the raw mismatch). The ecosystem therefore splits into three classes, and "does a solution exist" has three different answers:

1. **Turbo-class full-width LoRAs (larryvrh line)** — the adaln delta is `[r, 2688]`-form. **An existing solution does work for exactly this class: larryvrh's node.** Its pruned-base machinery is **not a projection/conversion at all** — it re-injects the delta at runtime in activation space (`output += B·A·silu_t_emb(t)` with `silu_t_emb` lerped from a bundled [1025, 2688] E-grid), which is *exact*. It never touches the LoRA file. (Deep code-read in §3.2.)
2. **Mainstream lightx2v/Comfy-Org turbo LoRAs** — these "work on pruned" for a *different* reason: **they ship no adaln keys at all** (publication-time exclusion, verified from headers). No node magic involved. **[NUM]**
3. **Everything else full-width** (Acc/PDD trunk `[64,2688]`, tutu, diffusers-format trains, future ai-toolkit `adaln_full` trains) — **unsolved today**: stock loader throws; larryvrh's node silently no-ops or KeyErrors on them (open issue #28, filed on exactly fal-realism and tutu on pruned int8); offline conversions either *remove* the adaln delta (drbaph; "may be degraded or broken") or *re-fit* with ALS against the 66 GB base (xiaolibai-sys). **No load-time, base-agnostic, projection-based adapter exists anywhere.** That is the gap our node fills, with Turbo LoRAs as a first-class interop/supersede case, not a pass-through. **[COMM]+[SPEC]**

- The maintainer's **M-matrix load-time projection is mathematically sound and near-exact — but only if fit against the 9-dim `[table | 1]` basis (centered fit + bias delta)**. The naive uncentered fit loses **87.7 %** of the adaln delta; the corrected fit loses **0.2 %** (measured on a real public LoRA pair). This correction is the single most important finding: it is easy to get wrong, and the public implementations that work got it right only by doing the centered variant. **[NUM]**
- All required artifacts are **publicly derivable without the 66 GB checkpoint**: the E-grid (`silu(time_embedder(t))`, [1025, 2688], Apache-2.0, ships inside larryvrh's node) plus two 32.8 KB `adaln_t_table` extracts. Exactly **two canonical tables** exist (FL2VA / Ref2VA), bit-identical across every pruned quant and inside the smhfacct hybrid. **[NUM]**
- Full-width (unpruned) `int8_convrot` checkpoints **exist officially** for both FL2VA and Ref2VA at 34.0 GB — a real escape hatch, not a myth. **[DOC]**

---

## 1. Verdict table

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1a | Does larryvrh's node solve arbitrary-LoRA-on-pruned? | **Mechanism yes, universal no.** Runtime adaln re-injection via bundled E-grid is exact and base-form-agnostic; but its key map assumes unprefixed Turbo key names. Community LoRAs with `diffusion_model.`-prefixed keys bind **0 adapters silently**; alpha-suffixed adaln keys raise `KeyError`. Open, unanswered (issue #28, filed against the exact LoRAs the maintainer cares about: fal realism, tutu). | [SPEC] node source + [COMM] issue #28 |
| 1b | Do pruned publishers ship conversion tooling? | **Partial.** Abiray (quants): no method docs, no tool. Comfy-Org (originator): no script published; blog documents *that* the table is "functionally equivalent", not *how* it was fit. xiaolibai-sys: **public tool** (ALS re-fit; needs full BF16 base; output = "complete pruned LoRA" with replacement adaln weights). kijai: ships converted files, no tool. drbaph: ships adaln-*removed* files, no tool. matsuo-koya: public diffusers→ComfyUI converter (drops adaln) + a rebase experiment tool. | [COMM] |
| 1c | Reddit/HF threads hitting the shape error? | **Yes, abundantly.** Civitai re-releases literally titled "(No Tensor Errors)" / 「解决张量报错」; HF discussion #27 asking for a pruned LoRA version; drbaph metadata warning; matsuo-koya notes. | [COMM] |
| 2a | Is the table fit documented? | **No official math published.** Blog + staff (Kijai): modulation weights (~40 %, 13.1 B params) → lookup table "derived from the weights", "no loss in output quality" (Lexius), outputs differ per seed but "not better or worse" (Kijai). | [DOC] blog, HF discussion #4 |
| 2b | Published M/basis artifact? | **No standalone M exists.** But the E-grid (full time-embedding table) ships inside larryvrh's Apache-2.0 node, and both C tables extract from any pruned checkpoint in 32.8 KB. M follows in one `lstsq`. | [NUM] |
| 2c | Original time-embed network separately fetchable? | **Yes, trivially.** `time_embedder.*` is 3 tensors (~33 MB fp32) inside the 66 GB full checkpoint; safetensors range-read fetches them without the rest. xiaolibai-sys's `compute_silu_grid` shows the exact recipe (it's a 2-layer MLP + sin/cos timestep features, re-derivable end-to-end). | [SPEC] |
| 2d | Does projection preserve style-LoRA behavior? | **Near-exact in function (0.2 % residual with bias correction).** Perceptually: one measured A/B exists (matsuo-koya, FastH3 distill, n=3): rebased-adaln slightly *worse* than adaln-less on ArcFace identity (0.669→0.613). No style-LoRA A/B exists. **[UNK]** — needs our own A/B. | [NUM]+[COMM] |
| 3 | Load-time hook in ComfyUI? | **Yes, several supported ones.** Stock path: `comfy/lora.py::load_lora` → `ModelPatcher.add_patches` (merge; the reshape that throws is `comfy/weight_adapter/lora.py: weight = w + scale*diff.reshape(w.shape)`) or `comfy.weight_adapter.BypassInjectionManager` (runtime). Node-level: `add_object_patch`, `add_wrapper_with_key(WrappersMP.DIFFUSION_MODEL)`, custom key maps — all proven by larryvrh's node. | [SPEC] |
| 4a | Full-width int8_convrot exists? | **Yes — both FL2VA and Ref2VA, 34.0 GB each, official Comfy-Org.** Community already bakes onto them (aptech's `ref2va_pdd_acc_8step_baked_int8_convrot` is full-width, 1035 tensors, `time_embedder` present). | [DOC]+[NUM] |
| 4b | Pruned→full direction solved by anyone? | **Functionally yes, weight-space no.** matsuo-koya: "an adaln LoRA trained on the pruned model can be lifted to full rank with `ΔW_full = ΔW_pruned @ Z @ pinv(C)`" — legal because E lies in span([C‖1]) exactly; only the *on-curve function* is recoverable, the true full-width weights are not unique (min-norm only). Nobody ships a tool for the curve-LoRA-on-full-base case; it's rare. | [COMM]+[NUM] |
| 4c | Do Civitai uploaders publish both forms? | **Yes, increasingly.** Observed: a universal no-adaln re-release (302 MB) alongside the full version (605 MB); "(No Tensor Errors)" re-releases; "pruned & non-pruned universal" (剪枝与非剪枝通用) in the file name; a hand-made "adapted for merging with pruned FL2VA" fix upload. Both-form practice is emergent, not universal. | [COMM] |

---

## 2. The two forms — precise, verified facts

**Full-width (original) form** — `MiniMaxH3Transformer` with `time_embedder` (2-layer MLP: 256 → 5376 → 2688):
- `time_embedder.*` present; per-block `blocks.N.adaln_proj.linear.weight [96768, 2688]` (+`bias [96768]`), `final_layer.adaln_proj.linear.weight [10752, 2688]`. The block computes `adaln(silu(time_embedder(t)))`. **[SPEC]** comfy/ldm/minimax/model.py (local testbed)

**Pruned / curve form** — Comfy-Org's day-0 optimization (2026-08-03):
- No `time_embedder`. Shared buffer `adaln_t_table F32 [1025, 8]` (grid = `linspace(0,1,1025)`, t = 1−σ mapping rows); per-block `adaln_proj.linear.weight [96768, 8]` F16 + bias; final layer `[10752, 8]`. Forward: `t_emb = lerp(table[i0], table[i0+1], frac)` at fractional grid position. Detection in core ComfyUI: presence of `adaln_t_table` → `adaln_curve_grid=1025, time_embed_dim=8` (comfy/model_detection.py:404). Saves 13.1 B of 33.1 B params (~40 %): 66.3 GB bf16 → 40.2 GB pruned_bf16 → 21.0 GB pruned_int8/fp8. **[SPEC]+[DOC]**

**Verified identity facts [NUM]** (safetensors byte-range reads, this investigation):
- Local `minimax_h3_{fl2va,ref2va}_pruned_int8_convrot.safetensors` are byte-identical in `adaln_t_table` to Comfy-Org's `pruned_bf16`, `pruned_fp8_scaled` and `pruned_int8_convrot` copies → **exactly two canonical tables exist**: FL2VA `sha256 ac8727cdec52137c…`, Ref2VA `c02a6c1188829768…`. Quant variant does not matter.
- **smhfacct b25-49-INT8 hybrid = FL2VA table (bit-identical) + Ref2VA blocks 25–49 `adaln_proj` verbatim** (blocks 0/24 = FL2VA bytes, 25/30/49 = Ref2VA bytes). It is curve-form (932 tensors, no time_embedder) → **the maintainer's running base needs the FL2VA M**, which live-shape form-detection gets right automatically. Caveat worth knowing: Ref2VA curve weights were fit against Ref2VA's table but here ride FL2VA's — works subjectively (scottmudge's finding), but it means "M per live table" not "M per lineage".

**The error under study**: stock `LoraLoader` → `comfy/weight_adapter/lora.py`: `diff = B@A` is `[96768, 2688]` (260,112,384 elems) and `diff.reshape(w.shape)` throws `shape '[96768, 8]' is invalid for input of size 260112384`. **[SPEC]**

**LoRA forms in the wild [NUM]** (headers probed via HF range requests):

| LoRA | adaln keys | adaln `lora_A` | loads on pruned via stock loader? |
|---|---|---|---|
| larryvrh Turbo v4/v1 (518 tensors, 605 MB) | 102 (50 blocks + final) | `[16, 2688]` | **no** (needs node or conversion) |
| lightx2v Turbo `_comfyui_bf16` (624) | **0** | — | yes (never trained adaln) |
| fal realism, Hearmeman, KennethFal vhs, Jojocodex wushu | **0** | — | yes |
| aptech0081 Acc/PDD trunk (778, ComfyUI) | 150 (blocks only) | `[64, 2688]` | **no** |
| kijai Acc `_pruned_comfy` (578) | 150 | `[64, 8]` | yes (pre-projected) |
| kijai ref lora rank 256 (794) | 153 | `[8, 8]` | yes (trained on pruned) |
| drbaph `*_pruned_comfyui` (416) | **0** (removed) | — | yes (adaln effect dropped) |
| ethanfel pruned delta loras | 205 | `[8, 8]` | yes |
| PDD heads (not adaln): `proj_out [32,96,5376]`, `audio_proj_out [32,32,5376]` | — | raw replacement weights | needs PDD-capable loader (see §3.6) |

So the maintainer's blocked class = **full-width-adaln LoRAs**: larryvrh Turbo (the single most-downloaded H3 LoRA, 223 k — and per the premise correction, the actual source of the live shape error via generic `LoraLoader`), the Acc/PDD trunk (83 k + 39 k downloads), tutu, InstantX/diffusers-format trains, and any future ai-toolkit train with adaln targets (Jojocodex labels them `aitoolkit_adaln_full`). The style-LoRA fear was largely unfounded: **most Civitai-style LoRAs carry no adaln at all and load on pruned bases via the stock loader** — the ones that do not are turbo/distill-class.

---

## 3. Existing-solutions landscape

### 3.1 Comfy-Org — the pruned form's origin (no tooling)
Blog (2026-08-03): "the model's modulation weights (~40 % of the total parameters) could be pruned and replaced with a functionally equivalent lookup table … no loss in output quality". Staff in HF discussion #4 (Kijai): compressed "into a **curve derived from the weights**"; same-seed outputs differ, "not really to the worse or better". No fit procedure, script, or basis artifact published. Core ComfyUI gained first-class curve support (`adaln_t_table` detection). Comfy-Org's own answer to form mismatches elsewhere: **re-issue converted artifacts** (`model_patches/minimax_h3_fun_controlnet_union_pruned_*` — the Alibaba Fun-ControlNet is full-width, so a pruned-form twin was published). **[DOC]+[COMM]**

### 3.2 larryvrh `ComfyUI-MiniMax-H3-Turbo` — exact runtime injection, Turbo-scoped (Apache-2.0)

**Classification up front (the coordinator's question): its pruned-base math is NOT the M-projection and not a file conversion — it is exact activation-space re-injection.** The LoRA file is read as-is (full-width `[16, 2688]` adaln stays full-width); no tensor is ever reshaped or projected; the adaln delta is never folded into `[96768, 8]` weight space. Instead each adaln projection's *output* gets `+ B·A·silu_t_emb(t)` at forward time, where `silu_t_emb(t)` is reconstructed in the original 2688-dim space from a bundled grid. Functionally this equals what the full model would compute, up to grid lerp — i.e. **the residual is zero by construction** (vs 0.2 % for the best through-M projection, 87.7 % for the naive one). This is why the maintainer's Turbo LoRA "works on pruned int8" through the node while raw `LoraLoader` throws.

`__init__.py` (v1.1.0 "Pruned/curve base support: run-time adaln injection, one LoRA covers all bases", 2026-08-06):
- Detects `dm.use_adaln_curves`; splits LoRA modules into backbone vs `adaln_proj`.
- Backbone → stock-ish bypass (`BypassInjectionManager`, frugal in-place add) or merge (`add_patches`); **int8-fused `mlp.fc2` is invisible to bypass hooks** (fused kernel never calls forward) → routed through merge/weight-function. Critical for our int8_convrot bases.
- Adaln → the injection above: bundled `h3_silu_temb_grid.safetensors` = `silu_t_emb_grid [1025, 2688]` BF16 (metadata: "silu(time_embedder(t)) aligned with adaln_t_table rows", 5.5 MB). A `WrappersMP.DIFFUSION_MODEL` wrapper recomputes the model's unique-timestep rows each forward (`_unique_t` mirrors keyframe/ref/audio conditioning rows — the fragile part, see issues #21/#27/#29/#30), lerps E-grid rows, and an `add_object_patch` on each `adaln_proj.forward` adds `B @ A @ silu_t_emb` to the projection output.
- **Why we can't just adopt it as the universal answer**: key map is `{m: "diffusion_model."+m+".weight"}` from the LoRA's own keys — Turbo keys are unprefixed; community keys carry `diffusion_model.` → double prefix → **0 adapters bound, no error** (silent quality loss). Alpha-suffixed adaln keys (`...adaln_proj.linear.alpha`) break `rsplit(".lora_",1)` → `KeyError`. **Issue #28 (open, no comments)** documents exactly this for fal realism + tutu on pruned int8 — the arbitrary-LoRA case is a known live bug, not a solved problem. Object-patch/VRAM-streaming interaction was also subtle (issue #4: wrapper-module approach crashed on unload; fixed by forward-attribute patching).
- E-grid provenance: derivable from any full checkpoint's `time_embedder` (xiaolibai-sys's `compute_silu_grid` re-derives it: sinusoidal features of `t=linspace(0,1,1025)` → `proj_in` → silu → `proj_out` → silu).
- **Interop implication for our node**: the maintainer's stack already runs Turbo through this node on the hybrid. Our form-adaptive node must either supersede this path (load-time projection covers the same LoRAs with standard machinery) or coexist without double-applying; both nodes accept `MODEL → MODEL`, so double-chaining the same LoRA would double the delta — the registry should mark LoRA×node exclusivity.

### 3.3 kijai — real full→pruned LoRA conversions, no tool published
`Kijai/MiniMax-H3-experimental` ships Acc LoRA pairs: `..._comfy.safetensors` (adaln `[64, 2688]`) and `..._pruned_comfy.safetensors` (adaln `[64, 8]`). **[NUM] forensic verification** (block 0):
- `lora_B` **bit-identical** between the two files → deterministic conversion, not a retrain.
- `A_prun ≈ A_full @ M` with cos **0.9968** against the centered least-squares encoder (see §4) and cos 0.9934 against the uncentered one → kijai's tool effectively implements the centered projection (or an equivalent fit); no bias-delta keys are included (the ~2.7 % bias term is dropped — see §4).
- Same repo: `minimax_h3_ref_lora_rank_256_bf16` with adaln `[8,8]` (rank 8 *on* the 8-dim input) → proof that **training directly on a pruned base** works (ai-toolkit class). Reddit: "Kijai's pruned turbo loras" thread corroborates the family.

### 3.4 drbaph — removal, honestly labeled (Apache-2.0)
`drbaph/MiniMax-H3-Turbo-Lora-ComfyUI`: `*_pruned_comfyui.safetensors` files carry safetensors metadata (verbatim):
```
"conversion_type": "prefix_conversion_with_adaln_pairs_removed",
"removed_pair_count": "51", "retained_pair_count": "208",
"source_adaln_input_dimension": "2688", "target_adaln_input_dimension": "8",
"warning": "All AdaLN LoRA adapters were removed because the source targets input
dimension 2688 while the pruned model targets dimension 8. Four-step distillation
behaviour may be degraded or broken.", "partial_conversion": "true"
```
The 51 removed pairs = blocks 0–49 + `final_layer.adaln_proj.linear`. Also in the repo: exact-compact-SVD dynamic rank resizing of LightX2V LoRAs (unrelated to adaln). **This is the prevailing "conversion" on Civitai** (the mirrored "Minimax H3 Turbo Loras" page serves exactly these files). **[COMM]+[SPEC]**

### 3.5 xiaolibai-sys — public offline re-fit tool + complete-pruned loader (MiniMax community license)
- `MiniMax-H3-Pruned-Lora-Adapter` (`run_build_adaln.py`, 2026-08-06): takes the **full 66 GB BF16 model** + N LoRAs (+ optional official E-grid; else computes it from `time_embedder`) and produces a **"complete pruned LoRA"** = backbone LoRA keys + `adaln_t_table` + full replacement `blocks.*.adaln_proj.linear.weight/bias` + `final_layer…`. Math (from source): targets `M_b = E @ (W_b + Σ strength·B@A)ᵀ + bias` per block on the 1025-row grid; accumulates `S = Σ_b M_b M_bᵀ` (1025×1025); **PCA init of the table from S + ALS refinement** (`optimize_table: true`, better fidelity, outputs not linearly combinable) or **fixed official table, projection/bias-only solve** (`false`, multi-LoRA-safe). DoRA handled. This is the same *class* of joint fit Comfy-Org originally ran.
- `ComfyUI-MiniMaxH3` `MiniMaxH3LoraLoader`: eats only complete-pruned LoRAs; "AdaLN replacement is applied during model loading, so `h3_silu_temb_grid` is not required"; `silu_grid` combo (Auto/FL2VA/REF2VA). "Original 2688-dim AdaLN Turbo LoRAs are not supported … bake them into a complete pruned LoRA first."
- **License**: the repo is under the **MiniMax H3 Community License** (ships table data derived from checkpoints; NOTICE says so; territory-restricted: EU/UK/KR/US excluded). → We may match the *math* (PCA/ALS is generic) but must not copy code or table data from it; and our shipped table-derived assets need their own license review (see §5.6).

### 3.6 matsuo-koya/minimax-h3-notes — the deepest independent measurements [COMM]
- Public `tools/h3_lora_convert.py` (diffusers→ComfyUI): **fc1 halves are swapped** (diffusers `[value;gate]` vs ComfyUI `[gate;value]`) — shapes match so it silently half-works; fused qkv needs block-diagonal `lora_B`; **"the adaln family is dropped by the converter: the pruned checkpoints fold the time embedding into a `[1025, 8]` table, so a diffusers adaln LoRA has no direct mapping."**
- `tools/h3_adaln_rebase.py`: fits `z_full(t) − z_pruned(t)` in the **9-dim `[table | 1]` basis**; FastH3's 51 layers fit at residual 5–6e-4 of the delta — "any smooth curve over t∈[0,1] does, since every sinusoid frequency in the time embedding is ≤ 1 rad". Confirms the pruned table reproduces full-model modulation outputs at ~1.9e-4–2.4e-6.
- Perceptual A/B (FastH3 distill, n=3 seeds, lip-sync task): adaln-rebased merge vs adaln-less: ArcFace identity **0.669 → 0.613** (worse on all seeds), lip corr unchanged → for *that* LoRA the projected adaln added nothing (slightly negative). Honest unknown for style LoRAs.
- Reverse lift stated: `ΔW_full = ΔW_pruned @ Z @ pinv(C)` — curve→full works *functionally*.
- Also documents: "LoRA B·A ≠ W_fast − W_h3 in weight space even though base+LoRA matches on the time curve to 4e-4 — the LoRA is only meaningful on the curve" → **do all conversion math on-curve, never in raw weight space.**

### 3.7 Other actors (negative/boundary results)
- **Abiray** (quant compiler): no method docs, no tool, no LoRA guidance on the card.
- **rockerBOO**: pruned NVFP4/FP8 by "transplanting the pruned tensors directly" from Comfy-Org's release ("copied verbatim") — confirms the canonical-table property from a second source; quant tooling = `ctq` CLI (silveroxides/convert_to_quant), unrelated to adaln.
- **aptech0081 / alibaba-pai Acc-LoRAs**: trunk full-width (see table); `minimax_h3_pdd.py` documents the PDD heads: `pdd_num_steps: 32`, block 4 → 8 NFE; heads = `MiniMaxH3ParallelHead` — N per-interval copies of `proj_out`/`audio_proj_out` replacing the final linear, fused by plan-einsum per step; `lora_targets` includes `adaln_proj.linear` (upstream diffusers name identical). Per-family files (FL2VA / Ref2VA) — for the b25-49 hybrid (FL2VA base heads kept, verified above) the **FL2VA** PDD files are the matching family. The `*_baked_int8_convrot` variant is a **full-width** baked model (time_embedder present, `[96768, 2688]`) — community evidence for escape 4a.
- **Generic shape-adapting LoRA nodes**: none found. Closest is `SaturMars/ComfyUI-QwenImageLoraConverter` (namespace-only conversion). Comfy-Org/ComfyUI issue #11863 ("LoRA shape mismatches should fail fast") confirms core currently fails with raw reshape errors — no adaptation hook upstream.

---

## 4. The math — three strategies, measured

Notation: E ∈ ℝ^{1025×2688} = E-grid rows `silu(time_embedder(tᵢ))`; C ∈ ℝ^{1025×8} = `adaln_t_table` (per base); LoRA adaln delta ΔW = B·A, A ∈ ℝ^{r×2688}; target curves on the grid Y = A·Eᵀ.

**(1) Removal** (drbaph / Civitai re-releases): A' := none. Keeps 0 % of the adaln effect. Costs nothing, always "works". drbaph's own warning says distillation behavior "may be degraded or broken" — for Turbo-class LoRAs (where distillation lives largely in adaln; matsuo-koya: "the 4-step distillation lives only in the adaln weights") this is the bad case.

**(2) Weight/activation-space projection through M** (kijai's shipped files; the maintainer's plan):
- **Wrong way (uncentered)**: M = EᵀC(CᵀC)⁻¹ directly. Measured: E's energy in span(C) = **10.3 %**; through-C residual of Y = **87.7 %** → the delta is essentially lost. Reason: E has a large mean over the grid; span(C) alone does not contain it.
- **Right way (centered / `[C | 1]` basis)** [NUM]: center both (Ē = mean(E), c̄ = mean(C)); M_c = Ēᶜᵀ Cᶜ (CᶜᵀCᶜ)⁻¹ ∈ ℝ^{2688×8}; **A' = A·M_c**; optional **bias delta Δb = B·(A·Ē − A'·c̄)** added to `adaln_proj.linear.bias`. Measured on kijai's Acc block 0: residual of Y under `[C|1]` fit = **0.196 %**; E energy in span([C|1]) = **1.0000**; kijai's A_prun vs centered encoder cos = **0.9968** (kijai omits the bias term, ~2.7 % of delta norm). matsuo-koya independently measured 5–6e-4 residuals on FastH3 with the same basis. **Conclusion: the load-time projection is functionally near-exact; carry the bias term (patch the adaln bias) and the error budget is ~0.2–0.6 %.**
- Cost at load time: one [64×2688]·[2688×8] matmul per adaln pair (~0.5 MFLOP·51 — microseconds) + optional [96768] bias add. Standard machinery afterwards (bypass or merge both fine — shapes now match).

**(3) Runtime activation injection** (larryvrh): output += B·A·e(t) with e(t) lerped from the E-grid. **Exact by construction** (no projection at all); costs a DIFFUSION_MODEL wrapper + per-forward object-patch state; requires knowing the model's unique-timestep row set (H3 payload subtleties — issues #21/#27/#29/#30 show this is the fragile part); bypass-only (merge path can't express it).

**(4) Offline ALS re-fit** (xiaolibai-sys): re-factorizes the *merged* base+delta weights; fidelity = Comfy-Org-class ("functionally equivalent"), but requires the 66 GB base + GPU fit per LoRA/strength set; outputs are replacement weights (not stackable when table is re-optimized). Overkill for load-time; the right tool for *publishing* a definitive converted artifact.

**Reverse direction (curve→full)**: functionally recoverable (E ∈ span([C|1]) exactly → e(t) = M_dec·[c;1]); weight recovery is min-norm only. matsuo-koya's `ΔW_full = ΔW_pruned @ Z @ pinv(C)` lift. Rare need; do not build now. No one else solves it either — the maintainer's belief "impossible" is *weight-space* true, *function-space* false.

**Precedent from other model families**: no direct precedent found for pruned/base LoRA projection in other communities (closest analogues are rank-resizing via exact SVD — drbaph's LightX2V resizes — and Qwen namespace converters). This appears to be the first architecture family where a *basis change in the conditioning input* splits the LoRA ecosystem. **[UNK]** (absence of evidence from a bounded sweep).

---

## 5. Recommended architecture — standalone "H3 LoRA form adapter" node

Matches the maintainer's fixed constraints (standalone node, VDN-precedent isolation, public release, form detection from live tensors, M as shipped asset). Validated against everything found; the two corrections from research are boxed.

### 5.1 Form detection (constraint 1 — agreed, with specifics)
- **Model side**: `use_adaln_curves` on the diffusion model, or read `adaln_t_table` presence/shape from the live state-dict. `[1025, 8]` → curve; `time_embedder.*` / `[*, 2688]` adaln → full. Do NOT trust filename heuristics (the b25-49 hybrid has no "pruned" in the name; conversely `pruned_bf16` quants vary) — filename only for logging/UX.
- **LoRA side**: read the safetensors header only (sub-second, no tensor load): any `*.adaln_proj.linear.lora_A.weight` with shape[1] == 2688 → **full-width**; == 8 → **curve-native**; absent → **adaln-free** (most Civitai style LoRAs — pass through stock machinery untouched). Also detect: `diffusion_model.` prefix present/absent; `alpha` scalar keys; diffusers naming (needs §5.5 conversion); PDD heads (`proj_out [32,96,5376]`).

### 5.2 Artifacts shipped with the node (~5.6 MB total)
- `h3_e_grid [1025, 2688]` — the E-grid. Source options: (a) reuse larryvrh's Apache-2.0 grid with attribution; (b) regenerate from any full checkpoint's `time_embedder.*` via 33 MB partial fetch (recipe in xiaolibai-sys `compute_silu_grid`, verified model: sinusoidal(256)→5376→silu→2688→silu). (b) is cleaner for license independence.
- `adaln_t_table_fl2va [1025,8]`, `adaln_t_table_ref2va [1025,8]` — **preferably read live from the loaded model** (they're already in memory; then zero shipped table data and no per-variant question). Ship only as offline-extraction fallback.
- **Precomputed M**: `M_fl2va = ĒᶜᵀC_fl2ᶜ(C_fl2ᶜᵀC_fl2ᶜ)⁻¹`, `M_ref2va` (each 2688×8 fp32 ≈ 84 KB) + `ē [2688]` + per-base `c̄ [8]`. One-time extraction script (≈20 lines, runs in ms on CPU). *No published standalone M exists anywhere — we derive it; that is the gating question resolved GREEN.* **Correct M = centered fit; the uncentered fit is catastrophically wrong (87.7 % loss) — encode this in a unit test with a golden pair (see 5.7).**
- Base-selection: match the M to the **live model's table** (bit-compare C_live vs C_fl2/C_ref2; covers the hybrid case automatically — it matches FL2VA).

### 5.3 The form-adaptive load path (constraint 2; Turbo-class LoRAs are first-class, not pass-throughs)
```
detect(model form, lora form)
 curve model + full-width lora adaln:
     A' = A @ M_base                    # per adaln pair, fp32
     Δb = B @ (A @ ē  −  A' @ c̄_base)   # bias delta (≈2.7% of delta; include it)
     strip original adaln A/B from the LoRA dict; inject A', B (unchanged),
       and patch adaln_proj.linear.bias (bypass-safe: object patch or bias patch)
     → route through STOCK bypass/merge machinery (shapes now match)
 curve model + curve lora / full model + full lora / no adaln: pass through stock
 full model + curve lora: unsupported → explicit error (rare; reverse lift exists math-wise)
 key-map hygiene (bug class from issue #28): normalize `diffusion_model.` prefix,
   tolerate `.alpha`/dora keys, HARD-FAIL with a clear message if 0 keys bound
   (never silent no-op)
 int8_convrot bases: fc2 must use the merge/weight-function path (bypass hooks are
   invisible to the fused int8 kernel — measured 0/50 hook fires in larryvrh's node)
```
**Why projection (not runtime injection) as the default**: it composes with the standard machinery (merge mode, strength dials, LoRA stacking, our registry gating), needs no forward patches/VRAM-streaming care, and is now measured at 0.2 % functional error. Offer an opt-in "exact" mode reusing the runtime-injection approach for A/B validation (it is ~80 lines in larryvrh's node, Apache-2.0, but carries the unique-t row fragility — issues #21/#27/#29/#30).

### 5.4 Quality tiers to expose in UI/registry
1. exact (runtime injection) — 0 % loss (reference implementation)
2. projected (default) — ~0.2 % on-curve residual **[NUM]**; unmeasured perceptually for style LoRAs → schedule the A/B
3. adaln-dropped (fallback when artifacts missing) — drbaph-equivalent; must warn, never silent

### 5.5 Diffusers-format handling (adjacent but mandatory for "any Civitai LoRA")
fc1 gate/value half-swap + fused-qkv block-diagonal B (matsuo-koya's verified mappings); adaln: same M projection applies after namespace mapping. Without this, diffusers LoRAs silently half-work — worse than failing.

### 5.6 Public release notes
- Node code: permissive (Apache-2.0/MIT) as original work — fine.
- **M and the E-grid are data derived from MiniMax checkpoints** → they are arguably Model Derivatives under the MiniMax H3 Community License (territory-restricted: EU/UK/KR/US excluded; >$20 M revenue needs written authorization). xiaolibai-sys resolved this by shipping under the MiniMax license with a NOTICE. Alternative: ship the *extraction script* (fetch 33 MB of `time_embedder.*` + read tables from the user's own checkpoints) so no MiniMax-derived bytes leave our repo — the license-conservative default; revisit with the licensing task (Licensing pass ehzagoc). **[UNK]** — needs maintainer decision.
- Credit larryvrh (E-grid + injection design) and kijai (projection precedent) in README; state our centered-fit + bias-delta correction explicitly so the community converges on the right math.

### 5.7 Verification plan (must-do before release)
- Golden test: kijai's Acc pair is a public full+projected ground truth — our node's projected A' must match `_pruned_comfy` A to cos > 0.99 (we measured 0.9968 for the centered encoder).
- Round-trip test: projected lora + our exact mode → identical outputs (projection residual visible in log).
- Hybrid test: b25-49-INT8 + full-width lora → M auto-selects FL2VA (table bit-match).
- Silent-drop guard: assert bound-key count > 0.

---

## 6. Fallback decision tree — arbitrary Civitai LoRA on a pruned base

```
Read LoRA header (safetensors, no tensor load)
├─ no adaln keys (≈ most style LoRAs: lightx2v, fal, Hearmeman, vhs…)
│    → STOCK LoraLoader works on pruned as-is. Nothing to do. ✔
├─ adaln lora_A [*, 8] (curve-native: kijai _pruned, ethanfel)
│    → stock loader works. ✔
├─ adaln lora_A [*, 2688] (full-width: larryvrh Turbo, Acc/PDD trunk, tutu, InstantX…)
│    ├─ Turbo-class + larryvrh node already in the graph → THAT works today (exact
│    │  runtime injection). Never chain both nodes on the same LoRA (double delta).
│    ├─ our node present → project via M (+bias delta). DEFAULT PATH; supersedes the
│    │  larryvrh path for arbitrary LoRAs and for merge-mode/low-VRAM graphs. ✔
│    ├─ publisher ships a pruned twin (drbaph *_pruned_comfyui, kijai _pruned_comfy,
│    │  Civitai "(No Tensor Errors)" / 剪枝通用 re-release) → install that instead
│    │  (note: drbaph-class twins DROP adaln — weaker than our projection). ◐
│    ├─ escape hatch: switch base to FULL-WIDTH int8_convrot (34 GB, official,
│    │  both FL2VA & Ref2VA; runs on 24 GB with ComfyUI dynamic VRAM streaming;
│    │  community precedent: aptech's baked int8) → stock loader works. ✔
│    └─ last resort: adaln-stripped copy (drbaph-style) with explicit warning. ◌
├─ diffusers naming (PEFT: to_q/to_out.0/ff.net…)
│    → namespace + fc1-swap + qkv-block-diag conversion first (matsuo-koya mapping),
│      then the adaln branch above.
└─ PDD/Acc family (raw proj_out [32,96,5376] / audio_proj_out [32,32,5376] heads)
     → not a form problem: needs the PDD head loader/sampler (VDN-precedent runtime
       patch we already run); FL2VA-family heads for the b25-49 hybrid (FL2VA heads
       kept, verified). Trunk adaln is full-width → project via M. 
```

---

## 7. Sources

**Official / primary**
1. Comfy blog, "MiniMax H3 Day-0 Support in ComfyUI" (2026-08-03) — https://blog.comfy.org/p/minimax-h3-day-0-support-in-comfyui — modulation ~40 % → lookup table, "no loss in output quality", 123.6→42.5 GB, RTX 3060.
2. HF discussion Comfy-Org/MiniMax-H3 #4 "Differences Between Pruned and Unpruned?" — Lexius + Kijai (Comfy Org) quotes; "curve derived from the weights"; same-seed output differences.
3. Comfy-Org/MiniMax-H3 repo (file listing + README; sizes: bf16 66.3, int8_convrot 34.0, pruned_bf16 40.2, pruned_int8/fp8 21.0 GB; Fun-ControlNet pruned twins; lightx2v loras; embeddings).
4. Local primary code: comfy/ldm/minimax/model.py, comfy/model_detection.py:404, comfy/weight_adapter/lora.py (reshape site), comfy/lora.py, comfy/model_patcher.py — testbed at "/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI".
5. larryvrh/ComfyUI-MiniMax-H3-Turbo — README + `__init__.py` (local clone @4274783) + `h3_silu_temb_grid.safetensors` header; commit history (v1.1.0 2026-08-06 pruned support; v1.2.2 issue #4 fix); issues #4, #21, #27, #28, #29, #30 (esp. **#28**: community LoRAs silently fail on pruned — fal realism, tutu; double `diffusion_model.` prefix; alpha-key KeyError; OPEN).
6. alibaba-pai/MiniMax-H3-Acc-LoRAs — README + `minimax_h3_pdd.py` (PDD: 32 intervals, block 4, parallel heads, `lora_targets` incl. `adaln_proj.linear`; arXiv 2607.26004).
7. xiaolibai-sys/MiniMax-H3-Pruned-Lora-Adapter — README + `alignment.py`, `time_embed.py` (PCA-init + ALS joint fit; targets `E@Wfᵀ+bias`; complete-pruned output; MiniMax Community LICENSE/NOTICE) and xiaolibai-sys/ComfyUI-MiniMaxH3 (loader applies AdaLN replacement at model-load; silu_grid Auto/FL2VA/REF2VA).
8. matsuo-koya/minimax-h3-notes — converter drops adaln; fc1 gate/value swap; qkv block-diagonal B; `[table|1]` rebase residuals 5–6e-4; pruned table reproduces full outputs ~e-4–e-6; reverse lift formula; FastH3 perceptual A/B (n=3, identity 0.669→0.613); "LoRA only meaningful on the curve".

**Community artifacts (headers/metadata probed in this investigation)**
9. drbaph/MiniMax-H3-Turbo-Lora-ComfyUI — pruned variants metadata (`prefix_conversion_with_adaln_pairs_removed`, 51 pairs removed, warning) + exact-SVD rank-resize docs; Apache-2.0.
10. Kijai/MiniMax-H3-experimental — Acc `_comfy` vs `_pruned_comfy` pairs (B bit-identical; A' ≈ centered projection, cos 0.9968 — measured here), ref lora rank 256 `[8,8]`, Fun-ControlNet pruned twins, w4a8 quants.
11. aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI — trunk adaln `[64,2688]`; PDD heads `[32,96,5376]`/`[32,32,5376]`; `baked_int8_convrot` = full-width (time_embedder present).
12. lightx2v/Minimax-h3-Turbo — `_comfyui_bf16` files carry **no adaln keys**; metadata: diffusers→ComfyUI conversion, swiglu mapping; ref2v trained on fl2va bf16 base (card metadata).
13. fal/MiniMax-H3-Realism-People-LoRA, Hearmeman/minimax-h3-loras, KennethFal/vh5tape, Jojocodex wushu (`aitoolkit_adaln_full` naming; no adaln keys in comfy file) — the Civitai-style class, adaln-free.
14. ethanfel/MiniMax-H3-Pruned-Ref2VA-Delta-LoRAs-Experimental — pruned-form delta loras `[8,8]`.
15. Abiray/Minimax-H3-nvfp4-INT4-INT8-Convrot — quant collection (no method docs); Abiray/MiniMax-H3-Turbo-Lora-Pruned-ComfyUI ("structurally pruned and reformatted"; no method).
16. rockerBOO/minimax-h3-nvfp4-convrot — "transplanting the pruned tensors directly… copied verbatim from Comfy-Org's pruned release"; `adaln_t_table [1025,8]` F32 + `[96768,8]` F16 documentation; `ctq` CLI credits.
17. smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models — b25-49-INT8 verified: FL2VA table bit-identical; Ref2VA overlays blocks 25–49 verbatim (this investigation, byte-range sha256).
18. Civitai API — "Minimax H3 Turbo Loras" (mirrors drbaph pruned files); "Minimax H3 Cinematic Look (No Tensor Errors)" 「解决张量报错」; "Cinematic Version (Official Release)" 「剪枝与非剪枝通用」 (302 MB universal vs 605 MB full); "Turbo Lora adapted for merging with pruned FL2VA".
19. Comfy-Org/ComfyUI issue #11863 "LoRA shape mismatches should fail fast"; SaturMars/ComfyUI-QwenImageLoraConverter (namespace-only precedent).
20. Reddit r/StableDiffusion 1vecegy (pruned quality 1:1 thread), 1vgxf4x (drbaph turbo), 1vntltz (kijai pruned turbo loras); HF larryvrh/MiniMax-H3-Turbo-Lora discussion #27 (pruned version request).

**Measurements made in this investigation [NUM]** (all reproducible: HF safetensors range-reads + local testbed bytes; scripts embedded in task log): table bit-identities (§2), kijai A/B forensics + projection cosines, span/residual figures (87.7 % uncentered vs 0.196 % `[C|1]`; E-in-span([C|1]) = 1.0000), hybrid overlay provenance, adaln-form inventory (§2 table).

---

## 8. Implementation addendum (task k271ykk, 2026-09-15)

The node is built (`custom-nodes/minimax-lora-form-adapter/`, MIT) and every
number above was re-derived from the same artifacts during implementation.
One correction and three confirmations, all [NUM] from the implementation
run (scripts: the pack's `tools/derive_test_fixtures.py`):

1. **CORRECTION — kijai ships the bias delta.** §3.3 said "no bias-delta keys
   are included (the ~2.7 % bias term is dropped)". The `..._pruned_comfy`
   pair actually carries `*.adaln_proj.linear.diff_b [96768]` keys (F32, one
   per adaln block; 50 extra tensors vs the full file — visible in the file
   listing but missed by the header probe). Measured:
   **cos(our Δb = B·(A·ē − A′·c̄), kijai's diff_b) = 1.000000**
   (rel diff 6e-5 — bf16 storage rounding). kijai's conversion is exactly the
   centered projection + bias delta this node implements, which STRENGTHENS
   §4's recommendation: carry the bias term. (§3.3's cos 0.9968 / 0.9934 and
   the 0.196 % / 87.7 % figures all reproduced exactly.)
2. **Confirmed:** the two canonical tables extract locally with the exact
   sha256s recorded in §2 (ac8727cd… / c02a6c11…); E-in-span([C|1]) =
   0.999999; the Turbo LoRA projects at 0.14 % on-curve residual (the
   0.196 %-class), uncentered at 96.9 %.
3. **Trap anatomy (why 87.7 %):** the constant component carries ~90 % of
   E's Frobenius energy (‖1·qᵀ‖/‖C·P‖ = 2.954) and 1 is orthogonal to
   span(C) to 1e-9 — so any fit through C alone (uncentered, or centered
   without the bias row) structurally loses most of the delta. The near-rank-6
   centered spectrum (σ = 7.08 … 2.1e-3) is why the fit must use lstsq, not
   normal equations.
4. **Golden shipped offline:** the pair's block-0 tensors (A_full/A_prun/B
   rows/diff_b rows), 64 E-grid columns, both tables and the fitted encoders
   live in `tests/fixtures/h3_form_fixtures.npz` (~740 KB compressed,
   provenance embedded + FIXTURES.md) so CI runs the golden with zero
   network. Regenerate with the tool above (network, `--kijai`).
