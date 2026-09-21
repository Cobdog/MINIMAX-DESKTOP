# YuE2-3B — frontier song generation with editable scores (fresh-release assessment)

> Maintainer-requested look, assessed 2026-09-21 (model created on HF
> 2026-09-09 — twelve days old). The maintainer's words pausing our
> standalone audio lanes: "audio generation outside of H3 should get
> disabled for now, purely because there is a new open weight model that
> just released that could likely be useful for us." Paused by that
> directive: the **music3** dock (MiniMax Music 3, API-class) and
> **acestep** (open-weight music); H3's joint audio-video lanes (audioVae)
> are untouched by the pause. The disable task the coordinator already cut
> (nn5ld47) stays pending this verdict. No Flux task for this assessment
> (coordinator places those). Sibling research:
> [node-pack-registry.md](node-pack-registry.md) (§1.6 — the audio lanes'
> registry shape this slots into),
> [ecosystem-2026-09.md](ecosystem-2026-09.md),
> [qwen-image-2.1-assessment.md](qwen-image-2.1-assessment.md) (the other
> family gated on the same instance-version bump).
>
> METHOD: lean fetches 2026-09-21 — HF model API (per-repo metadata + file
> lists for `m-a-p/YuE2-3B`, `m-a-p/YuE2-Vae`, `Comfy-Org/YuE2`; author and
> search listings for the YuE 1.x lineage, day-one quants, and the LoRA
> ecosystem), the raw HF README, the raw GitHub README +
> `docs/generation.md` of [multimodal-art-projection/YuE](https://github.com/multimodal-art-projection/YuE),
> ComfyUI master **code** (`comfy_extras/nodes_yue2.py` raw + commit
> history), and the docs.comfy.org YuE2 tutorial. No GPU, no engine, no
> installs, nothing downloaded. Release is twelve days old — per the
> purpose doctrine, zero community metrics are cited as quality proof
> (HF trending badges the repo archives are recorded only as corroboration
> of the maintainer's discovery signal, not as evidence). Quality numbers
> below are the authors' own WildSongBench self-bench — unverified by us
> and belonging to our benchmark harness. Tags: **[DOC]** card/API/code
> verifiable, **[SPEC]** our fit reasoning, **[UNK]** not stated anywhere
> fetched.

## 1. What it is

A **lyrics-to-song model with an editable symbolic score** — one checkpoint
that composes (writes an ABC melody/chord plan), renders (full song with
vocals + accompaniment), covers (re-skins a transcribed song), and revises
(agent edits the score/style/lyrics, then re-renders) **[DOC]**.

| | |
| --- | --- |
| Architecture | One **AR–NAR Mixture-of-Transformers** backbone: predicts ABC score + semantic tokens autoregressively, then generates acoustic latents via **flow matching**; a separate VAE decodes to audio **[DOC]** |
| Parameters | **3,630,684,224 (BF16)** per the HF safetensors field — the "3B" name is honest rounding **[DOC]** |
| Custom code | `YuE2ForCausalLM` via `modeling_yue2.py` (`trust_remote_code`-class); ships its own inference wheel (`yue2_infer-0.1.5` in-repo, GitHub release `yue2-v0.1.6`); `qwen.tiktoken` in-repo and community quants tagged `qwen3` hint at a Qwen-family backbone **[DOC — backbone lineage is inferred, not stated]** |
| VAE | Separate repo `m-a-p/YuE2-Vae` — 132.6M params F32 (~0.5 GB); `YuE2-Vae-legacy` is the benchmark decoder (legacy scores higher musicality, default Vae better perceptual quality) **[DOC]** |
| Output | **48 kHz stereo** songs, saved FLAC; vocals + accompaniment **[DOC]** |
| Languages | Card: `zh`, `en`; ComfyUI docs: "English, Chinese, Japanese, and more" **[DOC]** |
| Length envelope | Card demos 1:09–5:00; ComfyUI node max duration 900 s, latent `seconds` input max 1000 s on master; length is context-bounded and the package surfaces a `truncated` flag **[DOC]** |
| Speed | "A 3.6-minute song in 71 seconds on an RTX 4090" (LM 139 tok/s); one song at a time **[DOC — their measurement]** |
| Modes | `cot="full"` (melody+chord plan), `cot="melody"` (melody-only, recommended for covers), `cot="off"` (direct); bring-your-own ABC accepted; staged API `plan() → generate_semantic() → synthesize() → decode()`; CFG on semantics only (1.0/1.01 defaults), none on ABC **[DOC]** |

**vs YuE 1.x [DOC]:** YuE 1 (arXiv 2503.08638, 2025-03) was a **7B
dual-track** lyric-to-song model (`s1`, with a 0.5B variant) plus a
separate 1B editing model (`s2`) and an upsampler — multi-repo, heavy,
slow, **Apache-2.0**. YuE 2 collapses create/cover/edit into **one 3.6B
checkpoint**, adds the symbolic-planning (ABC) stage and flow-matching
synthesis, outputs 48 kHz stereo at ~11 GiB unquantized, and is
**CC-BY-NC-4.0** (see §5 — the license flip is the lineage break; the
GitHub repo preserved v1's code and license on the `YuE-v1` branch at the
same time). On their bench the jump is generational: SongBench Avg
**4.9165 (YuE 1) → 6.7316 (YuE 2)**. The headline claim — "competitive
with Suno v5/v6", Bo8 6.9632 vs Suno v5's 6.8721 — comes with unusually
honest protocol disclosure: best-of-8 and 2-candidate selection named,
Suno v6 given the same 2-candidate protocol, Suno winning MuLan and
AllMusicCaps outright, and Mureka 9 (6.9377) essentially tying Bo8 YuE2.
Still a self-bench on their own dataset — our harness arbitrates **[DOC +
doctrine]**.

## 2. Capabilities vs our lanes

Their WildSongBench table happens to score **both of our paused lanes** —
the most direct comparison we could ask for (their numbers, 192 prompts,
selection protocols as disclosed above) **[DOC]**:

| Model | Musicality ↑ | SongBench Avg ↑ | MuLan ↑ | Q3O ↑ | PER ↓ |
| --- | ---: | ---: | ---: | ---: | ---: |
| YuE 1 | 4.0847 | 4.9165 | 0.2623 | 3.7301 | 36.38% |
| ACE-Step 1.5 | 5.1588 | 6.0118 | 0.4372 | 4.5809 | 7.46% |
| MiniMax Music 3 | 5.3482 | 6.2830 | 0.3928 | 4.4362 | **6.27%** |
| **YuE2** | **5.9075** | **6.7316** | **0.5068** | **4.6819** | 8.44% |

- **music3's role (song w/ vocals):** YuE2 beats MiniMax Music 3 on every
  axis in that table **except phoneme error rate** — music3's 6.27% vs
  YuE2's 8.44% means **lyric intelligibility stays music3's edge**. music3
  is also API-class: zero VRAM, zero local footprint, provider-side
  commercial terms. YuE2 does not retire it; it contests the crown
  **[DOC + SPEC]**.
- **acestep's role (open-weight music):** benchmarked directly and behind
  on the song lane (6.0118 vs 6.7316). But ACE-Step's standing job for us
  is **instrumental/score-for-video** ground; YuE2 is song-centric —
  instrumental-only generation is **not in the official surface** (lyrics
  are central to every documented workflow; instrumentals come from a
  community LoRA, `Mothersuperior/YuE2-instrumental-cot-full-loras`)
  **[DOC]**. Whether YuE2 can take the instrumental lane is untested
  **[UNK]**.
- **New ground neither lane has:** (a) **zero-shot covers** — SHS100K
  CLEWS mAP 0.647 / Hit@1 71.3% vs ACE-Step 1.5's 0.024 / 2.4%, a
  different class of capability, built on their SheetSage2 transcriber
  (which Comfy-Org repacks for ComfyUI, §4); (b) **editable ABC scores** —
  the composition is a white-box artifact a person or agent inspects and
  rewrites before re-rendering; (c) **agentic editing** — score/style/
  lyric revision loop on one checkpoint, shipped with a `SKILL.md` agent
  skill package; (d) hum-to-song via community LoRA **[DOC]**.
- **Style control:** text style prompt + genre; `[Verse]`/`[Chorus]`
  section tags in the ComfyUI workflow; melody+chord conditioning via ABC;
  seed reuse for exact-plan revision **[DOC]**.
- **Our use-case ledger:** song generation with vocals — strong coverage;
  score/music for videos — **partial and unproven** (song-centric);
  ambience — **no** (nothing in the surface suggests texture/ambience)
  **[SPEC]**.

## 3. The 24GB question

- **Weights on disk:** one 7.26 GB BF16 safetensors (3.63B params) +
  ~0.5 GB VAE + SheetSage2 encoder (covers only) ≈ **8–10 GB** for the
  full set. Comfy-Org's repack offers `yue2_3b_bf16.safetensors` **and**
  `yue2_3b_int8_convrot.safetensors` — the int8 variant is the one
  ComfyUI's own docs use, roughly half the weights size **[DOC]**.
- **Inference VRAM (their measurements, 4090, BF16, unquantized):** peak
  **11.18 GiB** for a 3.6-min song, **14.08 GiB** at maximum context, 24 GB
  host RAM alongside. Speed: 71 s wall for 3.6 min of audio **[DOC]**.
- **Coexistence:** 11–14 GiB unquantized does not co-reside with the video
  stack on 24 GB — but our testbed doctrine is already sequential
  (`POST /free` between phases), so it fits the existing rhythm rather
  than demanding a new one. The int8 ConvRot checkpoint should land
  meaningfully lower (~6–8 GiB peak is our estimate, unmeasured by anyone
  we read) **[SPEC]**.
- **Day-one quants (for completeness):** audio-cpp GGUF (an audio.cpp
  runtime port), two more GGUF sets, FP8/NVFP4 for vLLM, MLX, int8 for
  MPS. For ComfyUI specifically the **official int8_convrot is the day-one
  quant**; GGUF/FP8 formats are not ComfyUI-native here **[DOC]**.
- The vLLM serving path is a separate 78 GiB-class server runtime —
  irrelevant to a single shared 24 GB GPU **[DOC]**.

## 4. ComfyUI integration

**Native, in core — not a community pack.** `comfy_extras/nodes_yue2.py`
on ComfyUI master defines **`YuE2GenerateMusic`** (style + lyrics + cot
mode + ABC input + advanced `cfg_scale`), **`YuE2GenerateABC`**, and
**`EmptyYuE2LatentAudio`** (seconds, default 120, max 1000). Commits
2026-09-12 → 09-17 (AMD fixes, max-duration raise, CFG control) —
actively iterated in its first week **[DOC]**.

- **The version gate:** docs.comfy.org requires **v0.35.0+**. Our shared
  install is **v0.34.0** (rev `a87667f`, recorded in
  [docs/agent/testing.md](../agent/testing.md)) — **an instance update is
  the hard precondition**, and the same bump unblocks Qwen-Image-2.1's
  native nodes (sibling assessment): one update, two families **[DOC +
  SPEC]**.
- **Official weights repack:** `Comfy-Org/YuE2` —
  `checkpoints/yue2_3b_{bf16,int8_convrot}.safetensors` +
  `audio_encoders/sheetsage2_bf16.safetensors` (covers workflow only)
  **[DOC]**.
- **Official template workflows:** "YuE2: Text to Music" and "YuE2: Music
  Cover" in the Template Library; the cover workflow chains `LoadAudio` →
  SheetSage2 transcription → ABC → YuE2 **[DOC]**.
- **Ecosystem beyond core:** fs_audio LoRA training via ai-toolkit already
  works (instrumental, hum-to-song, concept-slider, genre LoRAs published
  against `Comfy-Org/YuE2`); a third-party "FL YuE2" piano-roll studio
  exists. None of it is needed for the core lanes **[DOC]**.
- **Integration shape for us = exactly the music3/acestep pattern**
  ([node-pack-registry.md](node-pack-registry.md) §1.6): stock core only,
  **no `ENGINE_NODE_PACKS` row** — cost is (a) instance ≥ v0.35, (b)
  weights visible to the instance (int8 first), (c) a `yue2` row on
  `MODEL_FAMILIES`, (d) a workflow builder mirroring
  `src/lib/music3Workflow.ts` **[SPEC]**.

## 5. License

- **CC-BY-NC 4.0 on the weights** — card front matter, LICENSE file, and
  README footer agree; **not gated** (public download) **[DOC]**.
- **This breaks the m-a-p lineage assumption.** Every YuE 1.x repo
  (`YuE-s1-7B-*`, `YuE-s2-1B-general`, `YuE-upsampler`) is Apache-2.0 —
  verified via HF API tags this session. The historical prior is CORRECTED
  for 2.x: the same GitHub repo moved v1 and its license to the `YuE-v1`
  branch when YuE2 landed on main **[DOC]**.
- Third-party code components are permissive (stable-audio-tools MIT,
  SnakeBeta NVIDIA MIT) — code MIT, weights NC **[DOC]**.
- Practical scope: non-commercial terms attach to the weights and, in
  CC-BY-NC practice, to outputs/adaptations. Fine for the maintainer's
  personal desktop tool; forecloses ever selling YuE2-generated music.
  Every derivative quant/LoRA inherited CC-BY-NC (one MLX port mistags
  Apache-2.0 — do not rely on it) **[DOC + SPEC]**.
- Contrast inside our lanes: music3 rides provider API terms; ACE-Step is
  Apache-2.0 (reverify at any adoption commit) — so the ladder keeps a
  commercial-safe rung even with YuE2 adopted **[SPEC]**.

## 6. Fit

**Not a wholesale replacement — a rebalance.** YuE2 out-scores both paused
lanes on the vocal-song lane and opens cover/edit ground we have never
had, but leaves two holes our lanes currently fill: lyric intelligibility
(music3's PER edge) and instrumental score/ambience for video (acestep's
ground; YuE2 instrumental = community LoRA, untested) **[SPEC]**.

- **Proposed posture:** YuE2 becomes the primary **local** vocal-song lane
  — **PROPOSED-PENDING-TEST**; music3 stays the next rung of the fallback
  ladder (API, zero VRAM, best PER, commercial-safe) for lyric-critical or
  publishable work; acestep stays the instrumental/video-score candidate
  until YuE2's instrumental surface is tested. Fallback ladder:
  **yue2 → music3 → acestep**; H3's audioVae lanes untouched throughout
  **[SPEC]**.
- **Registry shape:** family `yue2` on `MODEL_FAMILIES`; workflow builder
  `src/lib/yue2Workflow.ts`; engines = song (full/melody/off) + cover
  (SheetSage2); no pack row (stock core); weights sha-pinned,
  linked-not-copied, license verdict **non-commercial** recorded on the
  family row. nn5ld47 (the audio-disable cut) stays pending — this verdict
  does not re-enable music3/acestep; re-enable is per-lane after the
  benchmark gate **[SPEC]**.
- **Benchmark angle (golden audio domains, our epistemology — never blind
  adoption):** (1) **song quality w/ vocals** — golden prompt set, blind
  A/B against music3 + acestep outputs; (2) **lyric adherence** —
  ASR-transcript diff vs supplied lyrics (the decisive axis; their table
  says music3 should win it); (3) **genre/style control** — fixed lyrics,
  N target styles; (4) **cover identity** — one source song, 2–3 target
  styles, melody-preservation check (our first cover-capable lane); (5)
  **instrumental/video-score probe** — cot="off"/melody without vocals vs
  the instrumental LoRA vs acestep (decides acestep's fate); (6) **the
  envelope** — shared-24GB peak VRAM + wall time at 2–5 min lengths under
  the `/free` convention. Engine work happens on the 8189 testbed per the
  runbook when the coordinator schedules it — nothing this session
  **[SPEC]**.

## 7. Verdict

| Axis | Call |
| --- | --- |
| **Verdict** | **ADOPT** — as the local vocal-song lane candidate: family `yue2` on the registry, stock-core ComfyUI integration once the instance bumps to ≥ v0.35, PROPOSED-PENDING-TEST against the benchmark gate; the pause on music3/acestep resolves to a rebalance, not a swap |
| Why | The cheapest fresh-family integration surface our audio lanes could ask for — day-3 **native** ComfyUI nodes plus an official Comfy-Org checkpoint repack (bf16 and int8), exactly the stock-core pattern music3/acestep already use, no pack to write — while scoring above both paused lanes on the song lane and covering two grounds we've never had (zero-shot covers, editable-score/agentic editing) at a 24GB-feasible 11–14 GiB under the existing sequential doctrine |
| The gates | (a) **CC-BY-NC 4.0** — the Apache-2.0 lineage assumption is corrected for 2.x; personal-desktop fine, commercial future foreclosed, recorded on the family row; (b) all quality numbers are their self-bench with disclosed best-of-8 selection — our harness arbitrates before any lane switch; (c) music3 (PER, API, commercial-safe) and acestep (instrumental) each keep a hole YuE2 doesn't fill; (d) instance ComfyUI ≥ v0.35 is a hard precondition |
| Revisit trigger | The instance-version bump landing; benchmark-gate results on the six golden domains; an official instrumental mode or first-party relicense (unlikely); the frontier moving (Suno/Mureka) — and the fallback ladder means none of these strand us |

Sources (all retrieved 2026-09-21): HF model API — `m-a-p/YuE2-3B`
(metadata, file list, license), `m-a-p/YuE2-Vae`, `Comfy-Org/YuE2`,
author listing `m-a-p` (YuE 1.x licenses), search listing `YuE2` (quants,
LoRAs); raw READMEs — HF `m-a-p/YuE2-3B`, GitHub
`multimodal-art-projection/YuE` main (+ `docs/generation.md`, `docs/`
tree, agent-skill section); GitHub org listing `multimodal-art-projection`;
ComfyUI master `comfy_extras/nodes_yue2.py` (raw + commits #16292, #16293,
#16373); docs.comfy.org YuE2 tutorial (version requirement, node names,
workflow templates); local reads — `docs/agent/testing.md` (instance rev
`a87667f`, v0.34.0), [node-pack-registry.md](node-pack-registry.md) §1.6
(audio lane registry shape). Not captured: the YuE2 technical report
("coming soon" — only the YuE 1 arXiv 2503.08638 exists), the WildSongBench
results CSV beyond card-level numbers, and any local listen — no engine
work this session.
