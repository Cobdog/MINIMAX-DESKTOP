# YuE2-3B + MiniMax Music 3 — the audio-lane deep-dive (fresh-release assessment, charter-expanded)

> Maintainer-requested look, assessed 2026-09-21 (model created on HF
> 2026-09-09 — twelve days old). The maintainer's words pausing our
> standalone audio lanes: "audio generation outside of H3 should get
> disabled for now, purely because there is a new open weight model that
> just released that could likely be useful for us." Paused by that
> directive: the **music3** dock (MiniMax Music 3 — open weights, corrected
> below) and **acestep** (open-weight music); H3's joint audio-video lanes
> (audioVae) are untouched by the pause. The disable task the coordinator already cut
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
>
> CHARTER EXPANSION (maintainer, 2026-09-21, same day): Part I below is the
> original day-one YuE2 card, kept as the first half. **Part II (§8–§12) is
> the deep two-model pass** — Music 3 profiled side-by-side from our own
> dock code and the official card, plus the maintainer's direct questions:
> voice training, small-sample reference conditioning, video-first sync, H3
> audio cleanup, and the latent-interop question. Pass-2 method: our
> `src/lib/music3Workflow.ts` + `src/lib/modelOverrides.ts` +
> [ecosystem-2026-09.md](ecosystem-2026-09.md) lane-5 capture (the
> f70p7ta-era audio work); raw HF card + COMMUNITY LICENSE of
> `MiniMaxAI/MiniMax-Music3`; YuE repo `docs/covers.md` + `docs/editing.md`;
> HF API checks for Music 3 fine-tunes; ai-toolkit and MiniMax-platform
> searches (cited inline). Same discipline: no GPU, no engine, nothing
> downloaded; unknowns are named UNKNOWN — TERRITORY UNTESTED with the
> micro-experiment that would settle them.

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
  is open weights running locally through our dock (the "API-class" label
  in this card's first draft was wrong — corrected in Part II §8: MiniMax's
  paid music API closed to new users 2026-08-20; the community license is
  commercial-friendly). YuE2 does not retire it; it contests the crown
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
- Contrast inside our lanes: music3 rides the **MiniMax Community License**
  (commercial use free under $20M/yr revenue with attribution — corrected
  from "provider API terms" in the first draft, Part II §8); ACE-Step is
  Apache-2.0 (reverify at any adoption commit) — so the ladder keeps
  commercial-safe rungs even with YuE2 adopted **[SPEC]**.

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
| The gates | (a) **CC-BY-NC 4.0** — the Apache-2.0 lineage assumption is corrected for 2.x; personal-desktop fine, commercial future foreclosed, recorded on the family row; (b) all quality numbers are their self-bench with disclosed best-of-8 selection — our harness arbitrates before any lane switch; (c) music3 (PER edge, commercial-friendly community license) and acestep (instrumental) each keep a hole YuE2 doesn't fill; (d) instance ComfyUI ≥ v0.35 is a hard precondition |
| Revisit trigger | The instance-version bump landing; benchmark-gate results on the six golden domains; an official instrumental mode or first-party relicense (unlikely); the frontier moving (Suno/Mureka) — and the fallback ladder means none of these strand us |

Part I sources (all retrieved 2026-09-21): HF model API — `m-a-p/YuE2-3B`
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

# Part II — the deep-dive (charter expansion, 2026-09-21)

The maintainer's questions, mapped: *"what YuE and Music can do, strong
for what, weak where"* → §8; *"just music, or SFX/dialogue/background
noise"* → §8; *"can we train voices, reference video / tiny-sample
conditioning"* → §9; *"video-only render, then a consistent audio pass —
how do we sync"* → §10; *"clean up a lower-quality H3 audio track"* → §11;
*"do raw H3 latents help or hurt"* → §12.

## 8. The two profiles, side by side

**Correction to the day-one card first [DOC]:** the task brief called the
music3 dock "API-class" and the first draft repeated it. Wrong on both
ends. Music 3 is **open weights** (`MiniMaxAI/MiniMax-Music3`, ungated,
~Aug 13 2026) and our dock generates **locally** through ComfyUI
(`src/lib/music3Workflow.ts`: UNETLoader → MiniMaxMusic3TextEncode →
KSampler → tiled VAE decode); and MiniMax's **paid music API closed to new
users on 2026-08-20** (platform docs) — the open-weights lane is the only
lane going forward. The dock was right; the label was wrong.

| Axis | MiniMax Music 3 | YuE2-3B |
| --- | --- | --- |
| Class | Hierarchical AR + flow: **8B Global LLM (Qwen3-8B init)** + 0.6B Local LLM, RVQ tokenizer (1 semantic 16,384 + 7 acoustic ×1,024), hidden-state fusion → **2.4B flow-matching** → **123M Flow-VAE** decoder (~11B system) **[DOC]** | One **3.63B AR–NAR Mixture-of-Transformers** + 132M VAE; flow-matching acoustic stage **[DOC]** |
| Scope | **Music only** — complete songs with vocals. No SFX, no dialogue, no ambience anywhere in the card **[DOC]** | **Music only** — songs, covers, edited re-renders. Same exclusions **[DOC]** |
| Output | 32 kHz, 16-bit stereo WAV (dock saves mp3 V0) **[DOC]** | 48 kHz stereo FLAC **[DOC]** |
| Length | Native ≤ 5 min; 25 audio frames/s; dock clamps `max_duration` 4–300 s **[DOC]** | Node envelope 900–1000 s, demos to 5:00, context-bounded with `truncated` flag **[DOC]** |
| Modes | One: text-to-music (lyrics + structured caption). No continuation, no editing, no reference — one-shot **[DOC — absence verified: card + our ecosystem capture]** | `full`/`melody`/`off` CoT modes, bring-your-own ABC, cover pipeline, agentic edit loop, staged plan→render API **[DOC]** |
| Control surface | Three-section caption (Global Metadata: genre/BPM/key/scale/emotional progression/scenario/production; Vocal Details: gender/timbre/harmonies/effects; Arrangement: instruments/groove/bass/percussion/textures/spatial) + `[Intro]…[Outro]` tags in lyrics; seed, cfg 1.7, top_k 50 in our dock **[DOC]** | Style prompt + lyrics + **ABC melody/chord score** (the control Music 3 lacks) + CoT mode + per-stage CFG + seed for plan reuse **[DOC]** |
| Reference input | **None** — no audio, no melody, no video conditioning **[DOC — verified absence]** | Audio only via the SheetSage2→ABC bridge; the model never sees a waveform **[DOC]** |
| Editing | None — regenerate and hope | Score/style/lyric edit → full re-render; timbre/singing NOT guaranteed identical (their editing doc says so verbatim) **[DOC]** |
| Fine-tuning | No first-party trainer; license permits it; community exists but nascent — `ntc-ai/minimax-music3-concept-sliders` (MIT, ComfyUI-format genre sliders, 2026-08-16) is the only fine-tune found **[DOC — HF search]** | Live machinery: ostris **ai-toolkit added YuE2 LoRA training with music-only and vocals-only modes** (~2026-09-18); genre/instrumental/tokenizer/hum-to-song LoRAs already published **[DOC]** |
| VRAM (local) | INT8 DiT + tiled decode 1536/64 = the official low-VRAM path, our dock default **[DOC]** | 11.18 GiB bf16 peak / 14.08 GiB max-context; official int8_convrot repack **[DOC]** |
| ComfyUI | Native, already in our instance's **v0.34.0** schemas (the dock runs today) **[DOC]** | Native **≥ v0.35.0** — the instance bump is the precondition **[DOC]** |
| License | **MiniMax Community License**: free commercial use under $20M/yr revenue, attribution display required, AUP; >$20M needs written authorization **[DOC]** | **CC-BY-NC 4.0** weights (code components MIT) — non-commercial **[DOC]** |
| Their bench | SongBench 6.2830; **PER 6.27% — best in table** (lyric intelligibility) | SongBench 6.7316 (Bo8 6.9632); musicality/alignment best-in-table; PER 8.44% |

**Strong for what [DOC+SPEC]:** Music 3 — lyric intelligibility, long-form
structural coherence to 5 min, production-grade caption control (BPM/key/
scale/evolution), commercial-safe license, zero new integration debt (the
dock exists). YuE2 — raw musicality and prompt alignment (their table),
**melodic/harmonic control via ABC** (the only symbolic control surface of
the two), covers, iterative editing, 48 kHz, an open training surface, and
the plan-first workflow (§10 makes this load-bearing).

**Weak where:** Music 3 — no melodic control, no reference, no editing, no
documented instrumental-only mode, 32 kHz, behind YuE2 on every
quality axis except PER (their table). YuE2 — non-commercial license,
weaker PER, singer/timbre not stable across renders, no first-party
instrumental mode (community LoRA), and the editing loop re-renders whole
songs rather than patching spans.

**The honest NEITHER list [DOC — verified absences]:** neither does sound
effects, dialogue/speech/TTS, ambience or texture beds, audio restoration
or upscaling, video input of any kind, timestamp/beat-grid conditioning,
or voice cloning as a feature (MiniMax's platform voice cloning — $1.50,
single sample — is the **speech** product line, a different model family;
it does not give Music 3 a new singer). And neither guarantees a stable
vocal identity across generations: Music 3 keeps *a* voice coherent
within one song (card claim) but the user cannot lock *which* voice; YuE2
explicitly does not promise the same singing across re-renders.

## 9. Voice + reference questions

**Voice training (singing voice identity):**

- **Music 3: effectively no.** No first-party trainer ships; the license
  permits fine-tuning, and exactly one community artifact exists (the
  ntc-ai genre sliders — which steer genre, not voice). No voice/timbre
  fine-tune found anywhere. Also no API escape hatch: the paid music API
  is closed to new users (2026-08-20). **UNKNOWN — TERRITORY UNTESTED**
  whether the 8B+0.6B stack is LoRA-trainable at dock scale (no trainer =
  no cheap experiment; this one is a project, not a micro-experiment).
- **YuE2: the machinery is live; the voice use is untested.** ai-toolkit
  trains YuE2 fs_audio LoRAs and **added music-only / vocals-only training
  modes** (~2026-09-18). Community guidance (RunComfy) reports the AR
  expert memorizes lyrics while the NAR expert carries style — vary the
  dataset to avoid memorization. Published LoRAs so far steer genre,
  instrumentation, tokenizers, hum-to-song — **no demonstrated
  singer-identity/timbre LoRA in anything fetched. UNKNOWN — TERRITORY
  UNTESTED.** Micro-experiment (GPU-gated, 8189, queueable): 3–5 songs of
  one vocalist → vocals-only ai-toolkit LoRA → blind A/B of "same singer?"
  against base YuE2 on held-out lyrics. Hours, not days; answers the
  maintainer's question directly.

**Reference-video → tiny-sample conditioning:**

- Neither model accepts **video** at inference — both are text-in (plus
  YuE2's ABC-in), audio-out **[DOC]**.
- **Music 3 accepts no reference audio at all** — verified absence on card
  and ComfyUI docs (our ecosystem capture already recorded this).
- **YuE2's "reference" is transcription, not conditioning:** reference
  audio goes to **SheetSage2** (separate model: Python 3.10/3.11, FFmpeg
  6.1, its own deps — or bundled in ComfyUI's cover workflow) which emits
  an ABC melody score; YuE2 then renders from the *score*, never from the
  waveform. Lyrics come separately (ASR/agent) **[DOC]**. So
  "generate from an extremely small sample" decomposes into: how little
  audio does SheetSage2 need to produce a usable melody line? **Not
  stated anywhere — UNKNOWN — TERRITORY UNTESTED.** Micro-experiment
  (GPU-gated): 5/10/20/30 s excerpts of one song → SheetSage2 → inspect
  ABC (notes, meter, section sanity) → render covers → A/B identity by
  ear. The hum-to-song LoRA also exists but its input mechanism is
  undocumented in what we fetched **[UNK]**.

## 10. The video-first sync question

**What exists today: nothing model-side.** Neither model takes video,
timestamps, scene boundaries, or beat grids **[DOC — verified absence]**.
Music 3's section tags and YuE2's lyric sections are *musical* structure,
not wall-clock sync. "Generate a video-only track, then do an audio pass"
is a **pipeline pattern we build**, not a feature either model ships.

**What "consistent" can mean, and the mechanism for each [SPEC]:**

1. **Mood/genre consistency** — the solved-in-principle layer: our timeline
   metadata (per-scene mood/energy tags) → LLM-compiled caption (Music 3's
   three-section format, reusing the dock's caption-rewriter pattern) or
   YuE2 style prompt. Same seed family across cues for cohesion.
2. **Structural alignment** (section boundaries ≈ scene cuts) — Music 3:
   section tags are ordered but have **no duration guarantees**; only
   `max_duration` caps total length. Steerable only by trial. **YuE2 is
   the real handle: an ABC score has note durations and tempo — wall-clock
   length is computable from the plan before rendering.** The staged API
   (`pipe.plan()` first) enables a plan-measure-adjust loop: iterate the
   score until the computed duration fits the target cut, *then* pay for
   audio. This is a structural advantage no other lane has.
3. **Exact duration fit** — same split: Music 3 emits end-of-audio when it
   decides; YuE2 plans to length. Both get trimmed/padded by the mux.

**Practice [SPEC]:** render video → read timeline (cut times, scene
durations) → compile (LLM) either lyrics-with-tags (Music 3, approximate)
or an ABC plan iterated to duration (YuE2, precise) → generate →
`ffmpeg` mux with pad/trim (the dock already saves through this path).
Frame-accurate hit points (a sting landing exactly on a cut) are
**UNKNOWN — TERRITORY UNTESTED** for YuE2's plan-loop (micro-experiment:
iterate ABC until a section boundary lands within ±0.5 s of a target cut,
10 tries, measure hit rate) and **unsupported** for Music 3 (nothing to
iterate against). Unsupported by both: lip-sync (speech territory),
time-addressable instrument changes, audio conditioned on motion/visual
events.

## 11. H3 audio cleanup

**Plainly: neither model restores audio.** No denoise, no bandwidth
extension, no separation, no enhance path exists in either surface
**[DOC — verified absence]**. Generation and restoration are different
task classes; these are generators.

The one H3-audio→YuE2 bridge that exists is the **cover pipeline**: H3
track → SheetSage2 (melody ABC) + ASR (lyrics) → YuE2 re-render in a
matching style. But that is a **re-creation, not a cleanup** — timbre and
production are re-rolled (their editing doc's no-timbre-guarantee warning
applies), so it rescues a melody from a muddy track rather than cleaning
the track. Wrong tool for "make *this exact* audio better." **[DOC +
SPEC]**

**The actual tool class** (none in our lanes today): audio
restoration/enhancement — speech/music denoisers, bandwidth extension /
super-resolution (lifting H3's audio toward 44.1/48 kHz), source
separation if stems are the goal. ComfyUI community audio-tool nodes exist
but are unassessed here **[UNK]**. The other honest route is upstream: H3
audio quality is a property of the audioVae joint lane (untouched by the
pause), and its preserve/edit wiring (`audio_mode: preserve`, `Sound:`
clauses — our instruction-editing capture) may already be the cheaper fix.
**[SPEC]**

**UNKNOWN — TERRITORY UNTESTED** micro-experiment (GPU-gated): one H3 clip
→ (a) cover-rescue through SheetSage2→YuE2 same-style, (b) raw H3 audio,
(c) H3 regenerate with `Sound:` instruction — blind three-way "which
sounds best" tells us whether rescue is worth building at all.

## 12. The latent question

**Definitive: feeding raw H3 latents into either model is not a thing
either model can do.** Three unrelated latent spaces: H3 audio lives in
MiniMax's audioVae space (our H3 graphs bind `audio_vae` into
conditioning); Music 3 in Flow-VAE (123M, adapted from MiniMax Speech,
32 kHz lineage); YuE2 in its own VAE (132M, 64-channel latent, temporal
ratio 1920 — 25 latent frames/s at 48 kHz). Different dimensionality,
different semantics, different decoders: cross-feeding latents is a
category error, not a quality question — there is no "better or worse,"
only "no input port." **[DOC]** (Amusing non-bridge: Music 3's Global LLM
is Qwen3-8B-initialized and YuE2 carries `qwen.tiktoken` — both
Qwen-family backbones, and it buys exactly nothing for latent interop;
the tokenizers and VAEs are bespoke.)

**What interop would require [SPEC]:** either (a) a shared audio-VAE
standard — the way video models converged on common video VAEs, which is
what later made cross-model latent continuation possible in video — and
**no such convergence exists in audio today**; or (b) a trained
latent↔latent translator with paired data. **No public evidence anyone
has built H3audio↔YuE2/Music3 translation — UNKNOWN territory, and it is
a research project, not an integration.** Adjacent real mechanism:
ComfyUI-H3-Continuum's Open Integration Contract preserves audio rows
through latent bridges — but only *within* H3.

**The practical interop is signal-domain, not latent-domain [SPEC]:** H3
audio (waveform) → SheetSage2/ASR → ABC/text → YuE2 (or caption → Music
3). That is §11's cover bridge; latents add nothing to it.
Micro-experiment only if curiosity demands: decode an H3 audio latent →
waveform → §11's pipeline — which is the signal-domain test wearing a
latent hat; the latent-domain version has no mechanism to test.

Sources for Part II (retrieved 2026-09-21, same session): HF
`MiniMaxAI/MiniMax-Music3` raw README (architecture, RVQ, SGLang-Omni,
diffusers, 25 frames/s, Qwen3-8B init) + raw COMMUNITY LICENSE (commercial
terms); YuE repo `docs/covers.md` + `docs/editing.md` (SheetSage2 flow,
separate env, no-timbre-guarantee quote); HF API —
`ntc-ai/minimax-music3-concept-sliders` (the lone Music 3 fine-tune),
search absence checks for further fine-tunes; [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit)
(YuE2 music-only/vocals-only LoRA training, ~2026-09-18) and the
[RunComfy YuE2 LoRA guide](https://www.runcomfy.com) (AR-memorizes/NAR-styles
guidance) via search; MiniMax platform docs via search —
[music API closure to new users 2026-08-20](https://platform.minimax.io),
rapid voice cloning $1.50/voice single-sample (speech line); local —
`src/lib/music3Workflow.ts` (the dock graph, caption builder, section
tags, 4–300 s clamp), `src/lib/modelOverrides.ts` (family slots),
`src/components/Music3Workspace.tsx` row in
[ui-inventory-and-migration-map.md](ui-inventory-and-migration-map.md),
[ecosystem-2026-09.md](ecosystem-2026-09.md) lane 5 + verified-absence
notes (Music 3 reference conditioning), H3 audio facts from
[h3-instruction-based-editing.md](h3-instruction-based-editing.md)
(`audio_mode: preserve`, `Sound:` clause, not-bit-preserved).
