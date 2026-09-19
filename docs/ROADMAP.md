# Roadmap — state of play

> **Derived from Flux (project `r2lnrfw`); refreshed 2026-09-17 after the Phase-5b
> landing (lead), then again 2026-09-19 by the docs-conformance audit (u7rxi2e) to
> pick up every merge since (PRs #6–#20) — three "in flight" entries had already
> landed.** Flux is the source of truth; this file is the human-readable
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
- **Canvas Phases 0–5b SHIPPED**: document store (oiavqh8, 904825c) → substrate +
  launcher + spatial queue (jl4ye8x, 0ee1bcb) → generation on canvas (flyuh6h, 2ae8ce1)
  → ops/forks/takes + engines-as-ops + first view retirement (j5sj28v, 80f48eb) →
  latent-fork rendering + the retirement wave + LocationStudio→H3 + engines-as-ops
  completion + libraries/Settings docking (6rymbx3, 44d25df) → **the deletion wave:
  the canvas became THE app** (7mcp11b, c61e4c5 — the 7 greyed views + the old shell +
  the `View` union deleted; default route is the canvas, `?canvas=1` a harmless alias;
  Diagnostics + the five asset studios + MoviePlanner dock; MoviePlanner's shot handoff
  seeds consent-gated canvas chains; ContactSheet-required cleanup applied). Vision
  9/9 on the final tree (new default-boot scenario). Engine-side latent handoff still
  deferred to the live-verify follow-up (puy428n — offline seam asserted in-tree) →
  **the Director Suite** (2u0rent — the timeline projection as V's second family
  member: plan segments with chain facts, or the unplanned chain-output chronology
  with the adopt-chronology upgrade; plan documents on canvas_plan per schema §1;
  the MEASURED gap menu — only the FLF splice executes offline (36 dB
  continuation-frame wiring: ffmpeg 'last'-frame → next segment's first frame),
  dip-to-black + diegetic bridge carry honest engine-work labels; MoviePlanner
  RETIRED — seedSegmentChain (chain_ref written into the plan) + the latent-episode
  render (submitPlanEpisode) carry its parity; the Ollama plan copilot is the named
  retirement gap).
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
- **Overnight full audit SHIPPED** (junllxf, 5 PRs merged: d06cc82 security w1,
  9111c40 correctness w1, f85fdf9 perf profile + harness, 08fe916 security w2 datasets,
  d45fd2f E2E-audit fixes): four blind audits + a real-engine drive (4 H3 renders
  through the app; the latent live-verify POSITIVE — true continuation, 0.01ms drift;
  puy428n closed) + the perf density answer (300 mixed objects: 44fps, media path never
  binds; the first cliff is server-side project hydration). Every blocker/major fixed
  and CI-proven; deferreds consolidated into the cleanup wave (twmpu4m); perf
  improvements queued (pq7d48a); maintainer design desk items named (F6 live progress,
  fetch-consent, token-mode, settings-GET gating). New process assets: the agent
  resource ledger + coordination protocol, PID-only kills, the branch→CI→PR merge train,
  the reusable perf harness. Demo project persists at /home/agent/audit-e2e/home.
- **Dataset Manager v1 SHIPPED** (sv14rt0, 1ab8176 + ba3ffd1): the blessed spec built
  end-to-end — dual-path ingest (by-reference hash-tracked + LAN-upload with per-path
  trash), master/child layers with the stamp-crop editor (managed aspect spectrum,
  hard stops, middle-click mirror), per-layer captions with stale/authorship/history
  and the from-scratch llama.cpp VLM client (≤8s chunks, 2fps N-even, dense→condense,
  four automation modes), two-tier advisory curation + CLIP reference-triage, the
  per-trainer preflight dashboard (both profiles vs the envelope walls), the nine QA
  gates, and dual-shape + external-trainer export with recipe cards. Own route
  `?datasets=1`; canvas bridge both directions. Gate 23/23 (test:datasets 138
  assertions); vision 12/13 (the one fail pre-existing, flagged to the correctness
  lane); both CI legs green. Spec: docs/specs/dataset-manager-v1.md (BLESSED).
- **H3 Image Workbench SHIPPED** (jvcrud2 spec+blessing, k9vu6t0 build, PR #12
  492436d): the blessed spec r2 end-to-end at `?images=1` — packets (5/9/13 +
  directed 39) + T=1 Fast, compose (9 role+transport slots), the six edit
  families, opt-in refine (klein/Krea 2), first-party scorer + take-strip
  picking, burst lane gated on E-IW2, start-frame exit, the Mamad8
  never-in-video-graphs factory guard. Suite `test:h3img`.
- **Post-audit cleanup wave SHIPPED** (twmpu4m, PR #8 fe535f1): latent-path
  naming alignment, menu clamping, the seeding race, the one-canonical-take
  index (migration 004), honest /free + 400/404 refusals, VDN consolidation.
- **Design-decision implementations SHIPPED** (2hbv2ib, PR #9 8b5d59f): F6 live
  progress (the stable server-side clientId + per-prompt `preview_method=taesd`
  previews decoded through taeh3; percent/label + in-progress frames on the
  generating tile), fetch-consent origin gating (Option A), settings-GET
  token contract (Option B). 3a (token-mode default stays open) recorded, not
  implemented. Mechanism capture: docs/research/comfyui-live-progress-mechanism.md.
- **Performance wave 1 SHIPPED** (pq7d48a, PR #6 320eb34): hydration cache/ETag
  (300-object project GET burst p99 439→31 ms), overlay virtualization (zero
  long tasks at 300 objects), cull coalescing — measured before/after in
  docs/research/app-performance-profile.md's addendum.
- **QOL wave SHIPPED** (rrxlw2r): the surface registry + titlebar switcher
  (Alt+n), one-click fetch affordances, first-run guidance.
- **Structured H3 Prompt Editor SHIPPED** (fh94g76): the structured ⇄ freeform
  toggle on the canvas prompt surface — boxes per prompt part, Flow as a
  first-class timed list, `composeStructuredPrompt` goldens, round-trip
  no-text-lost. Spec: docs/specs/structured-prompt-editor.md.
- **Image pathway reroute SHIPPED** (34afx79, PR #18 f1a0a8d): the canvas image
  intent renders H3-1F (T=1 Fast through the workbench core); Z-Image retired;
  the Krea 2 stills seam stubbed for mf3wfq6; edit-intent hands off to the
  workbench. Spec addendum: docs/specs/canvas-ui-v1.md §8.
- **Model overrides SHIPPED** (euxwdva, PR #19 99cfddb): global (Settings) +
  per-chain (properties panel) checkpoint/TE/VAE selection over the inference
  seam; chain > global > auto; wrong-kind refusal.
- **LoRA timeline SHIPPED** (7twfk6o, PR #20 ee0594c): paint LoRA ranges over a
  clip; the compiler emits per-LoRA segment chains joined by measured-transition
  defaults; plan/manifest/take provenance; layer 1 (segment granularity).
- **Research cadence since 09-17** (all landed in docs/research/): the
  per-model prompt-doctrine harvest (6niii1p/3449qan — Anima/Klein/Krea 2/H3
  captioning doctrines + the 8-rule spine; the missing anima fragments row
  filed as eagkso0), the burst-frame-enhancement survey (ucsnubx, E-IW2 GO),
  the pan-stitch extension research (4akaet6), the Fizgig ADOPT addendum
  (6niii1p — block-role map, voice grid, third de-distillation data point),
  the benchmark harness joining the gate (cp96zdm — `test:benchmarks`).

## Building (in flight)

- **External-instance integration** (9om4bi9) — instance-sourced model inventory,
  app-relative input/output defaults, node-pack install into an external
  custom_nodes folder, live pack status in Settings. PR train.
- **Nits logged for a future polish pass** (5vu57ue) — deliberately deferred, not lost.

## Queued (specced/planning)

- **Canvas Phase 5b follow-ups (inherited at 5b landing, 2026-09-17)**: the
  **plan copilot** (the retired MoviePlanner's Ollama brief→shots revisions,
  re-homed on plan documents); the **guided dip-to-black + diegetic-bridge
  renders** (AddGuide-pinned bridge generations — the gap menu labels them
  honestly as engine work; E7 identity-across-bridge still unmeasured).
- **Canvas Phase 6 candidates (inherited from Phase 5)**: the five asset studios'
  authoring flows become canvas macros (batch → approve → survey → extract; the
  LocationStudio guided builder is the best macro template); `syncLibraryAssets`
  becomes the libraries' primary write path when the studios retire (deferred at
  Phase 5 — the studios still author into the shared libraries; projection stays
  copy-never-destroy); pruning the dead old-shell CSS blocks in styles.css.
- **Latent-fork live-verify** (puy428n) — one engine-side render confirming the
  LoadLatent handoff + latent retention across restarts; next GPU window.
- **Drift-envelope suite** (5nfy24y) — how long can chains really go per mitigation
  combo; the mitigation recipe + calibrated drift-budget thresholds.
- **Few-shot LoRA training sidecar** (ehzagoc, promoted from deferred) — the in-app
  training pipeline the envelope + guide + dataset manager feed into.
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
