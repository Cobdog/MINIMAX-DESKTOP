# MiniMax-H3 LoRA Form Adapter

A form-adaptive LoRA loader for MiniMax-H3 in ComfyUI. It loads **any
ComfyUI-format H3 LoRA** onto **any H3 base** — full-width, pruned ("curve"),
or hybrid (e.g. the FL2VA/Ref2VA b25-49 class) — by detecting the adaln form
on both sides from **live tensor shapes** and, when a full-width LoRA meets a
curve base, projecting the adaln pairs through a centered `[C | 1]` encoder
at load time.

Works in any ComfyUI install (no dependency on the MiniMax Studio server).
MIT.

## Why

Comfy-Org's day-0 pruning replaced the 2688-dim time-embedding path with a
`[1025, 8]` lookup table (`adaln_t_table`) and `[out, 8]` adaln weights. A
LoRA trained on the full-width model carries adaln adapters shaped
`[rank, 2688]`; loading it on a pruned base throws
`shape '[96768, 8]' is invalid for input of size 260112384`. The ecosystem
answers so far: remove the adaln pairs (drbaph — "may be degraded or
broken"), re-fit against the 66 GB base (xiaolibai-sys), or re-inject at
runtime for one node's own LoRAs (larryvrh). This node is the missing piece:
a **load-time, base-agnostic projection** that keeps the adaln delta at a
measured **0.196%** on-curve residual and then routes through ComfyUI's
stock machinery (bypass or merge, strength dials, LoRA stacking).

## The math (and the trap)

With `E` = the grid of `silu(time_embedder(t))` rows `[1025, 2688]` and `C` =
the base's `adaln_t_table`, the real grid satisfies
`E = C·P + 1·qᵀ` to ~0.17% — i.e. E lies in the 9-dim span of `[C | 1]`,
**not** in span(C) (the constant carries ~90% of the energy and is
orthogonal to span(C) to 1e-9). A full-width adaln delta `B·A` acts on-curve
as `B·A·Eᵀ`, which decomposes **exactly** into:

```
A'  = A · M                        M = centered least squares of E on C
Δb  = B · (A·ē − A'·c̄)             patched into the adaln bias
```

- **The centering trap**: fitting `M = EᵀC(CᵀC)⁻¹` without centering loses
  **87.7%** of the adaln delta (measured on kijai's public Acc pair; 94.7%
  on the grid itself). The uncentered solution is the correct one plus a
  rank-one contamination along the mean direction `q`.
- **The bias trap**: using the centered fit but dropping the bias delta loses
  the same **87.7%** — the mean is real signal, and it lives in the bias.
- Both traps are pinned by unit tests (`tests/test_math_core.py`,
  `tests/test_golden.py`), including a golden against **kijai's published
  full/pruned Acc pair**: our projection matches their shipped
  `lora_A` at **cos 0.9968** and their shipped `diff_b` bias delta at
  **cos 1.000000** — their conversion is (numerically) exactly this
  projection, including the bias term.

## Modes

| mode | behavior | residual |
|---|---|---|
| `projected (default)` | A′ = A·M, bias delta patched; stock machinery after | ~0.2% on-curve |
| `exact (runtime injection)` | adaln delta re-injected in activation space from the E-grid (larryvrh's mechanism, Apache-2.0, credited) | 0% by construction; forward wrapper + per-forward grid lerp; the reference tier for A/B |
| `adaln-dropped (warn)` | removes the adaln pairs (the drbaph-style fallback), prints a loud warning | the delta's adaln part is gone |

Routing details:

- matching forms / adaln-free LoRAs (most Civitai style LoRAs) pass through
  the stock machinery **untouched**;
- curve-form LoRAs on full-width bases are **refused** with an explanation
  (wrong direction; the functional lift exists but nothing ships it);
- diffusers/PEFT-named LoRAs are **refused** with pointers (namespace +
  fc1-half-swap + qkv-block-diagonal conversion is v1-out-of-scope;
  silently half-loading them would be worse);
- **zero bound modules is a hard failure** — never a silent no-op (the
  larryvrh issue-#28 bug class: community LoRAs with a `diffusion_model.`
  prefix double-prefixed into 0 adapters, no error);
- key hygiene: `diffusion_model.` prefixes are normalized (never doubled),
  `.alpha` / `dora` keys never become modules, DoRA-on-adaln is refused
  explicitly;
- on `int8_convrot` bases the fused-int8 `mlp.fc2` never calls the module's
  forward, so those pairs are routed through the merge/weight-function path
  (bypass hooks would silently drop them — 0/50 hook fires, measured in
  larryvrh's node);
- kijai-style `diff_b` keys on curve-native LoRAs are applied as bias
  patches — the stock loader silently drops them.

**Do not chain this node and larryvrh's turbo node on the same LoRA** — both
would apply the adaln delta (double delta). One or the other.

## M sourcing — licensing-aware by default

The encoder inputs are the model's own live `adaln_t_table` (always read
from the loaded model — nothing ships) and the E-grid. The E-grid is data
derived from MiniMax checkpoints and is **not bundled** with this node: it
is discovered from artifacts already on your machine, in order:

1. the node's `egrid_path` input (point it at any `[grid, 2688]`
   safetensors — build one with `tools/derive_projection.py egrid` from any
   full-width checkpoint's `time_embedder`, a byte-range read that never
   touches the other 66 GB);
2. a previously derived copy in this package's cache;
3. the Apache-2.0 grid bundled with larryvrh's
   `ComfyUI-MiniMax-H3-Turbo` pack, when installed.

The fitted encoder is memoized per process and cached on disk keyed by both
inputs' sha256 (the fit itself is ~22 MFLOP — microseconds).

**Advanced option**: precompute and ship the encoder bundle with
`tools/derive_projection.py encoder --egrid … --table … --write-cache` (M is
2688×8 fp32 ≈ 84 KB per base; exactly two canonical tables exist — FL2VA and
Ref2VA — and every pruned quant plus the b25-49 hybrid carries one of them
bit-identically). Shipping precomputed matrices is a documented option for
advanced users/distributions that accept the MiniMax-derivative licensing
posture; the default derivation-first flow keeps this repository free of
checkpoint-derived bytes. See the studio's `docs/LICENSES.md` for the
analysis.

## Tests

```
python3 -m unittest discover -s tests      # offline, numpy-only, no torch
```

- `test_math_core.py` — analytic ground truths (E = C·P + 1·qᵀ recovered
  exactly) and both traps as tests, against a well-conditioned synthetic AND
  the real FL2VA table's near-rank-6 spectrum;
- `test_golden.py` — the real-artifact golden: derivation path reproduces
  the committed encoder; kijai's published pair matched at cos 0.9968
  (uncentered measurably worse at 0.9934); our Δb matches their shipped
  `diff_b` at cos 1.000000;
- `test_forms.py` — the full detection matrix (model × LoRA × mode), key
  hygiene, refusal cases.

The studio's Node-side gate (`pnpm test:lora-form`) runs this suite plus the
server-side registry/catalog tests; CI installs numpy.

## Release story

This directory is a **first-party module of MiniMax Studio** (it lives at
`custom-nodes/minimax-lora-form-adapter/` in the studio repo) but is written
to be **released independently**: self-contained package, MIT, no
dependencies beyond the torch+numpy+ComfyUI any host already has. To publish
standalone, copy this directory into its own repository (it IS the pack:
`__init__.py` exports `NODE_CLASS_MAPPINGS`, `pyproject.toml` carries the
Comfy registry metadata) and tag it. Inside the studio it installs into a
managed ComfyUI checkout as a `first-party` node pack — code files copied
from this exact directory, no network.

## Credits

- **larryvrh** — the runtime activation-injection mechanism (Apache-2.0),
  the bundled E-grid, the int8-fused-fc2 finding, and the forward-attribute
  patching pattern that survives VRAM streaming; this node's `exact` tier
  and its bypass/merge routing follow that implementation.
- **kijai** — the published full→pruned Acc conversions whose forensics
  (bit-identical `lora_B`, centered-encoder `lora_A`, shipped `diff_b`)
  validated this projection and serve as its golden test.
- **Comfy-Org** — the pruned curve form itself and the `adaln_t_table`
  detection this node mirrors.
- **matsuo-koya** — the `[table | 1]` basis measurements and the reverse-lift
  formula quoted in the refusal message.
- Research context: `docs/research/h3-lora-form-compatibility.md` in the
  studio repo.
