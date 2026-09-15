# Test fixture provenance — `h3_form_fixtures.npz`

Regenerate with `python3 tools/derive_test_fixtures.py --kijai` (the `--kijai`
step reads the public pair through Hugging Face range requests — network,
regeneration only; the committed file makes the tests offline forever after).
The npz embeds the same provenance in its `provenance_json` entry.

| entry | what it is | source |
|---|---|---|
| `table_fl2va`, `table_ref2va` | the two canonical `adaln_t_table` [1025, 8] grids (fp32) | extracted from the local pruned int8_convrot checkpoints; tensor sha256 `ac8727cd…` / `c02a6c11…` — bit-identical across every pruned quant per the research note |
| `egrid_cols` | first 64 columns of the silu time-emb grid [1025, 2688] | larryvrh's `h3_silu_temb_grid.safetensors` (Apache-2.0, bundled with ComfyUI-MiniMax-H3-Turbo); 64 columns are enough because M's rows are independent per E column |
| `M_fl2va`, `M_trap_fl2va` | the centered and the UNCENTERED encoder fitted from the full grid + FL2VA table (fp32, [2688, 8]) | derived at fixture-generation time by `math_core` itself |
| `e_mean_fl2va`, `c_mean_fl2va` | encoder means | as above |
| `turbo_A_blk0` | block-0 adaln `lora_A` [16, 2688] of the full-width Turbo LoRA | larryvrh's public MiniMax-H3 Turbo v4 (ema, step 600) |
| `kijai_A_full_blk0`, `kijai_A_prun_blk0` | block-0 adaln `lora_A` from the public full/pruned Acc pair | `Kijai/MiniMax-H3-experimental`: `loras/MiniMax-H3-FL2VA-Acc-8Step_comfy.safetensors` + `..._pruned_comfy.safetensors` — the independent published full→pruned conversion |
| `kijai_B_rows256`, `kijai_diff_b_rows256` | first 256 rows of block-0 `lora_B` and of kijai's shipped bias delta | the pruned pair's `diff_b` keys (kijai ships the bias delta; see the research-note addendum) |

## Licensing posture

These are TEST-ONLY vectors, not runtime assets: the node's default runtime
path ships zero MiniMax-derived bytes (the encoder is derived at first use
from the user's own artifacts — see the README §M sourcing). The tables and
kijai tensors are derived from MiniMax-H3 checkpoints (arguably Model
Derivatives under the MiniMax H3 Community License); they are embedded here
at small, deterministic-slice size because the task that commissioned this
node explicitly sanctioned committed golden vectors over network-dependent
tests, and a golden test that skips in CI would defeat its purpose. Total
fixture payload: ~740 KB compressed.

- E-grid columns: Apache-2.0 via larryvrh's bundle (upstream's own grant).
- Tables/kijai tensors: derived from public artifacts for interoperability
  testing; never redistributed as usable model assets (64-column slices,
  single LoRA blocks, and the [1025,8] tables are not loadable as models).
- Recorded in the studio's docs/LICENSES.md alongside this note.
