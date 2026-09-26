# H3 text-encoder dimension classes — the mapping behind the TE-dimension guard

> Task: TE-dimension compatibility guard (eyzcev5, epic 4lphxv8) · Date: 2026-09-26
> METHOD: the maintainer's 2026-09-22 session crash log (verbatim, quoted below) +
> a code-read of the official ComfyUI klein templates shipped in the canonical
> shared install (`/home/agent/comfyui/.venv/.../comfyui_workflow_templates_json/
> templates/image_flux2_klein_image_edit_{9b,4b}_distilled.json`, the revision
> installed with the v0.34-era engine this repo targets) + the repo's own TE
> inference ladders (`src/lib/modelSelection.ts`, `src/lib/graph/h3image.ts`,
> `src/lib/graph/krea2edit.ts`). No model card HTTP reads were needed: the crash
> log is its own dimension evidence (mat1's 2560 and mat2's 5120 are the two
> hidden widths in question).

## The crash class (the guard's reason to exist)

The loosened inference anchors take "best available". On the maintainer's real
instance only a 4B-class qwen3vl was visible at the moment of the pick, the
`qwen3vl` substring fallback resolved it into an H3 graph, and the render died
27 seconds in — mid-render, at the engine's `preprocess_text_embeds`:

```
mat1 and mat2 shapes cannot be multiplied (171x2560 and 5120x5376)
```

**[DOC]** 171×2560 is the 4B encoder's output (171 prompt tokens × its hidden
width); 5120×5376 is the H3 token refiner's weight matrix, expecting the 32B's
hidden width. The failure is schema-invisible: `CLIPLoader`'s `clip_name` combo
accepts any listed filename, so the engine's prompt-validation gate (the thing
`src/lib/engineContract.ts` mirrors) passes it — the mismatch surfaces only
inside execution. That is why the guard lives at the resolution seam, not in
the contract layer.

## The mapping (family-registry data, `FAMILY_TE_DIM_CLASS`)

| Family | TE dimension class | Hidden dim | Evidence |
| --- | --- | --- | --- |
| MiniMax H3 video (`minimax`) + H3 image workbench (`h3image`) — fl2va / ref2va / merged lanes | 32B-class (the only accepted class) | 5120 | **[DOC]** crash log mat2 5120; the official H3 stack artifact `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`; Qwen3-VL-32B model card hidden size |
| klein refine (this repo's 9B-distilled port) | small-Qwen3 companion class — 8B (its own trio) and 4B (the 4B template's pairing) both legal; 32B-class refused | 4096 / 2560 | **[DOC]** official template read: `image_flux2_klein_image_edit_9b_distilled` pairs `qwen_3_8b_fp8mixed.safetensors`; `image_flux2_klein_image_edit_4b_distilled` pairs `qwen_3_4b.safetensors` |
| qwen3vl 4B (the trap file, `qwen3vl_4b_minimax_h3_int8.safetensors`) | 4B-class | 2560 | **[DOC]** crash log mat1 2560; visible on the maintainer-instance mirror (`e2e/mirror/profiles/maintainer-instance.json`) beside the 32B — the exact trap |
| Krea 2 edit lane | 4B-class qwen3vl (its anchored pattern `^qwen3vl_4b…`) | 2560 | **[DOC]** `src/lib/graph/krea2edit.ts` ladder + the workbench research doc's TE table (Krea 2 qwen3vl_4b) |
| Music 3 | NO expectation row | — | **[DOC]** its TE ladder is fully anchored (`^music3.*text_encoder`, no substring fallback) — the loosened-anchor crash class cannot fire there; absence = inert |

## The honest limits (recorded, not hidden)

- **Classification is by the filename's own size token** (`32b` / `8b` / `4b`,
  case-insensitive, basename truth). The registry lists filenames only — no
  header reads. A name with no known token is UNCLASSIFIED and passes: the
  engine stays the final arbiter for community renames (the same discipline as
  the VAE decoder-class markers in `modelOverrides.ts`). No false refusals.
- **Within-small-class precision is not the guard's.** Klein-9B strictly pairs
  the 8B (4096); putting the 4B-class (2560) into klein-9B would mismatch
  klein's own text projection. The guard's klein row accepts both small classes
  and refuses only the cross-family 32B — the within-small pairing is pinned by
  klein's fully-anchored ladder (which resolves only `qwen_3_8b*` names) plus
  the engine. Encoding more precision would refuse correct-but-renamed files
  on evidence the filename does not carry.
- **The task's "Klein requires the 4B-class" is the 4B-template fact.** This
  repo ports the 9B template (qwen_3_8b). The guard encodes the class-level
  truth both templates share: klein consumes the small Qwen3 companion, never
  the 32B — and the same 4B file that H3 refuses is legal in klein, which is
  exactly the family-scoping the task's test spec names.

## Verdict table

| Claim | Verdict | Note |
| --- | --- | --- |
| H3's token refiner consumes a 5120-dim (32B-class) TE | **CONFIRM** | crash log + card |
| The 4B qwen3vl into H3 is the submit-and-crash class | **CONFIRM** | the 2026-09-22 session |
| klein's TE class is "small Qwen3" (4B/8B legal, 32B refused) | **CONFIRM** | official templates, both variants |
| The engine-contract layer could host this check | **CORRECT** (it cannot) | schema-invisible failure; object_info carries no tensor dims — the expectation is app-side family knowledge, enforced at the seam |
| Music 3 needs a TE-class row | **ADOPT no** (no row) | anchored ladder, no fallback needle — inert by absence |
