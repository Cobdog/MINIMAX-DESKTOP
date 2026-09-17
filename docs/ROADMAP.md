# Roadmap — state of play

> **Derived from Flux (project `r2lnrfw`); refreshed 2026-09-17 after the Phase-4
> landing (lead).** Flux is the source of truth; this file is the human-readable
> state of play — if it disagrees with the board, the board wins. Task ids are Flux ids.

## Shipped (verified, CI green at landing)

- **Stabilization + web migration** (epics m2yc3vd, 1qv5cg3, yl4tzwb, ph34nd8):
  P0 data-loss/silent-failure fixes, LAN hardening, App.tsx decomposition, Electron
  stripped → standalone Node server + SPA.
- **Foundation pass** (epic t63llq): perf, pino+boundaries, SQLite/FTS5 + OPFS storage,
  realtime fabric (WS+SSE, binary previews, LLM streaming), zustand state discipline,
  CSS tokens + Base UI, EngineProcess, PreviewSource/filmstrips/pooling.
- **LLM layer** (1de65kg): router primary + Ollama fallback; 8-layer composer; vision
  captioning; unload-before-generate.
- **Graph factory + optimization registry** (ttlqwwi, g07jo24): every turbo/accel/upscale
  method as data; inertness-golden-proven.
- **Self-managed runtime increments 1–2** (3ay7wbz): RuntimeManager, launch profiles,
  vendored nodes, consent patch tier, link-never-copy.
- **Local-first fetcher** (hgjbea2) + catalog.
- **Identity Edit** (t8u00uu, released with E-K1 corrections); **form-adaptive LoRA node**
  (k271ykk); **IK pose rig** (r2kxcjh, AP-10K unlocked per E-FC1); **camera compiler
  port** (ving89w); **Krea 2 edit families**; **LTX 2.3 utility family** (068xwy3);
  **Diagnostics suite**; **benchmark harness v1** (cp96zdm, 7 suites, 41 backfilled
  rows, candidate CLI); **AutoContext catalog + temporal-exclusivity guidance**
  (p8oyfy1).
- **Canvas spec BLESSED** (0rtwaj4, 8378214) after three adversarial audits.
- **Canvas Phases 0–4 SHIPPED**: document store (oiavqh8, 904825c) → substrate +
  launcher + spatial queue (jl4ye8x, 0ee1bcb) → generation on canvas (flyuh6h, 2ae8ce1)
  → ops/forks/takes + engines-as-ops + first view retirement (j5sj28v, 80f48eb) →
  latent-fork rendering + the retirement wave + LocationStudio→H3 + engines-as-ops
  completion + libraries/Settings docking (6rymbx3, 44d25df; CI green on both legs,
  vision 9/9 after two real defect rounds). All behind `?canvas=1`; vision-verified;
  old shell still default until Phase 5. Engine-side latent handoff deferred to the
  live-verify follow-up (puy428n — offline seam asserted in-tree).
- **Experiment program**: tranches 1–3b + E-FC0.5/1 + E-MD1 + E-K1 + the MATLOWAI
  bake-off — every verdict in the research docs as dated addenda. Headlines: AddGuide
  movement director (E-MD1 winner); hybrid wins identity edits (E-ED1); turbo sharpest
  on stills, tiers buy motion/audio only; MATLOWAI 4-step ref2va verified (Mystic style
  baked in — default-vs-labeled call open); same-seed cross-tier = sibling takes.
- **DiffSynX control-branch smoke: EXECUTES** (a80ekav closed) — LoRA-on-controlnet
  trains locally on this box (18.2s/step at 256×448×39f, 9.8 GiB VRAM, disk-streamed
  int8 DiT); full-controlnet blocked by optimizer-state VRAM. Two stock bugs found,
  2-site patch documented + upstreamable.
- **Infrastructure migration** (dgrkp2e): central model home `/home/agent/models/`
  (86G, git-committed manifest); canonical ComfyUI at `/home/agent/comfyui` (unified
  nodes, coordination-protocol CLAUDE.md); 118 GiB deduplicated; soak-verified with a
  real Krea 2 render; quarantine at `/home/agent/model-quarantine-2026-09-16/` (128G)
  awaiting the maintainer's purge. The studio's vendored install is exempt (ships with
  the distribution). Batch 4 (keep/kill list) posted for the maintainer.
- **H3 LoRA training guide** (mfdza7o, 69049d9): per-class configs (style/character/
  motion), caption format verdict (natural-language, mid-density, H3 vocabulary, trigger
  token), dataset technicals (curation > quantity, near-dup capping, slow-motion audit),
  DeCFG requirement for real training runs.
- **H3 LoRA training envelope MEASURED** (1n3a4mi, 3aaf0b4): the practitioner's map —
  345f trains up to 544×320 (23.4G ceiling); 124f @ 480×832; native 768×1344×39f at
  14.7G (DiT-LoRA halves the controlnet arm's VRAM); budget rule VRAM ≈ 5.1G fixed +
  ~2.6G/Mtok(px×frames); mixed buckets FREE (peak = max of buckets, never the sum;
  image+video mixing proven); musubi = trainer pick (1.6× faster at long rungs, no
  host pinning), DiffSynX keeps sub-5s durations + the control branch; rank 16 free;
  DeCFG required for 500+ steps. Guide §8 reconciled; runbook training-run conventions
  folded. Training weights consolidated into the central model home (manifest b1347e9).
- **VLM video research** (complete): llama.cpp ≥v0.4.0 supports native `input_video`
  (ffmpeg server-side); Gemma 4 31B-IT video-capable today; Qwen3-VL only family with
  temporal frame merging; DeepSeek V4 Flash Vision image-only; GLM 5.3 Flash not yet
  in llama.cpp (issue #27922).

## Building (in flight)

- **Canvas Phase 5** (7mcp11b) — the deletion wave: 7 greyed views + old shell +
  `View` union die; canvas becomes THE app. Dispatched 2026-09-17 per the standing
  sequential-development directive.

## Queued (specced/planning)

- **Latent-fork live-verify** (puy428n) — one engine-side render confirming the
  LoadLatent handoff + latent retention across restarts; next GPU window.
- **Dataset manager** (sv14rt0) — mixed-media training browser (import/browse/preview/
  caption/recaption/coverage/export), 5→1000 items, canvas op-stack prep integration.
- **Drift-envelope suite** (5nfy24y) — how long can chains really go per mitigation
  combo; the mitigation recipe + calibrated drift-budget thresholds.
- **Few-shot LoRA training sidecar** (ehzagoc, promoted from deferred) — the in-app
  training pipeline the envelope + guide + dataset manager feed into.
- **Camera editor** (y93rk61, split from ving89w) — canvas-phase component.
- **Control-input creation tools** (r2copa7, epic 66xhflw).
- **Engine integrations**: start-frame factory (xlfl0iv), RefMod factory (y5ipryd),
  VDN chain option (9up52mj), FaceRefine (krzunud), Krea 2 stills (mf3wfq6),
  spectrum (u6d6mop), SplitUpscale (3l8h28e).
- **Derive-curve-form utility** — full-width-only model architecture + on-demand
  curve derivation (the form story completed).
- Graph visual verification (yq8fnel); licensing final statement (68rnn84).

## Awaiting maintainer

- **Batch 4 keep/kill list** (dgrkp2e): fl2va-pruned (19.5G), ref2va-pruned, 32B TE
  variant, GLM-in-tmp relocation — each with size + recommendation.
- **Quarantine purge** (128G): after soak, single-folder delete.
- **MATLOWAI default-vs-labeled**: 4-step ref2va winner, Mystic style baked in.
- **Intern bakeoff soak**: their project's verification round from the new install.
- **Qwen3.8-Flash-Next abliterated GGUF**: identified (Huihui, Q4_K_XL 111G, fits
  24+112GB combined); the quality VLM target for the recaption pipeline. Needs
  llama.cpp qwen4exp architecture verification + the mmproj file question resolved.

## Explicitly not planned

- Audio work (V2A, silent-inference toggle vzpyldn) — parked per the maintainer
  ("I don't care about it right now"); hinges on the envelope's audio A/B results.
- GPU/testbed work only in maintainer-authorized windows; 8188 off-limits to agents.
- No network telemetry, no filters/gating (content-neutral by design).
