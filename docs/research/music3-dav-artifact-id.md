# Music 3's DAV audio VAE vs the H3 family's audio VAE — one artifact or two?

> **Provenance.** Researched 2026-09-26 for the truth-surface sweep (task 68e9k17, audit items F3/M4 — "Music 3's audio-VAE inference is blind to the file the H3 video family infers"). The product question: should Music 3's auto-inference accept `minimax_h3_audio_vae_fp32.safetensors` (the file the maintainer's instance serves) into its audio-VAE slot, so "nothing detected" stops appearing?
> **METHOD:** primary sources only, read live — the official Comfy-Org workflow template `templates/audio_minimax_music_3.json` (raw fetch from Comfy-Org/workflow_templates@main, 2026-09-26) and the two Hugging Face repo file trees via the HF API (`Comfy-Org/MiniMax-Music-3`, `Comfy-Org/MiniMax-H3`). No GPU, no engine, nothing downloaded beyond metadata.

## The finding: two distinct artifacts

| | Music 3's DAV | H3's audio VAE |
|---|---|---|
| Official file | `vae/minimax_music3_dav.safetensors` | `vae/minimax_h3_audio_vae_fp32.safetensors` |
| Repo | Comfy-Org/MiniMax-Music-3 | Comfy-Org/MiniMax-H3 |
| Size (HF API) | 216,696,128 bytes (~217 MB) | 605,254,808 bytes (~605 MB) |
| Decodes | Music 3 song latents (`VAEDecodeAudioTiled` in the official template) | H3 video audio latents (the video graph's second `VAELoader`, node 4) |

Different repos, different sizes, different names, different latent families. Nothing anywhere claims interchangeability, and the size delta rules out "same weights, different precision naming". These are **two different decoders**.

## The decision (recorded, 2026-09-26)

**Music 3's auto-ladder does NOT accept the H3 audio VAE.** Auto-wiring a wrong-family decoder into `VAEDecodeAudioTiled` is exactly the doomed-graph class the override layer's cross-class refusals exist to prevent — inference must not do what an explicit pick is merely *allowed* to (the engine stays the arbiter for conscious choices).

What the sweep ships instead (audit fix-shape option: "label the slot so 'nothing detected' reads as a requirement, not a bug", plus the coordinator's loosened-anchor tiebreak):

1. **The loosened anchor** (matching the H3 family's own audio-VAE ladder shape): exact official tier `^minimax_music3_dav\.safetensors$` → the `music3.*dav` family tier → the bare `dav` substring needle. A renamed quant, a repack, or a subpath'd DAV auto-resolves; the `dav` needle cannot substring-match `minimax_h3_audio_vae_fp32` (no `dav` in it), so the exclusion is structural, not a blocklist.
2. **The named requirement**: `MUSIC3_DAV_FILENAME` is exported and the Settings music3 audio-VAE row says what it needs when nothing resolves — the maintainer's engine (which serves no DAV at all) now reads as a fetch requirement, not a detection bug. Their short-name convention (`music3_dit_int8`, `music3_text_encoder_bf16`) resolves a future `music3_dav*` fetch through both the family tier and the needle.

**Sources** (live-read 2026-09-26):
- Comfy-Org workflow template: https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/audio_minimax_music_3.json
- HF API file trees: https://huggingface.co/api/models/Comfy-Org/MiniMax-Music-3 · https://huggingface.co/api/models/Comfy-Org/MiniMax-H3

**Follow-on (out of this sweep's scope):** the fetch catalog carries no Music 3 rows at all — a catalog entry for `vae/minimax_music3_dav.safetensors` (217 MB) would make the requirement one click. That belongs to the catalog sweep (audit item #7's lane).
