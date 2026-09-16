# Roadmap — state of play

> **Derived from Flux (project `r2lnrfw`) on 2026-09-16 by hygiene pass 2
> (zbn31xs).** Flux is the source of truth; this file is the human-readable
> state of play and is refreshed by hygiene passes / at milestone changes —
> if it disagrees with the board, the board wins. Task ids are Flux ids.

## Shipped (verified, CI green at landing)

- **Stabilization + web migration** (epics m2yc3vd, 1qv5cg3, yl4tzwb,
  ph34nd8 — all closed 2026-09-14): P0 data-loss/silent-failure fixes, LAN
  hardening, App.tsx decomposition, Electron stripped → standalone Node
  server + SPA (`docs/migration.md` is the record).
- **Foundation pass** (epic t63llqq, closed 2026-09-14): perf batch, pino
  logging + error boundaries, SQLite/FTS5 + IndexedDB/OPFS storage substrate,
  realtime fabric (WS+SSE, binary previews, LLM streaming), zustand state
  discipline, CSS design tokens + Base UI, EngineProcess sidecar contract,
  PreviewSource/filmstrips/video pooling.
- **LLM layer** (1de65kg): llama.cpp router primary + Ollama fallback; 8-layer
  composer; vision captioning; unload-before-generate choreography.
- **Graph factory + optimization registry** (ttlqwwi, g07jo24): every
  turbo/acceleration/upscale/preview method is data; insert-only + inertness
  golden-proven.
- **Self-managed runtime increments 1–2** (3ay7wbz, partially landed):
  RuntimeManager (managed ComfyUI on 8191+, config mirroring, boot reconcile),
  launch profiles, vendored node packs, consent patch tier, weight-linking
  invariant. **Remaining ACs on the task = active work** (see Queued).
- **Local-first fetcher** (hgjbea2) + catalog rows: sha-pinned, consent-gated,
  user-fetch pattern for restrictive licenses (`docs/architecture.md` §fetcher).
- **Capabilities shipped along the way**: official prompt contracts, prompt
  library (Civitai harvest + bundled corpora + style embeddings), multiframe
  timeline keyframes, latent scene chaining, character sheets in-model,
  reproducibility manifests, diagnostics suite, Music 3, form-adaptive LoRA
  node (k271ykk), Identity Edit (t8u00uu), Krea 2 edit families (t8u00uu
  sibling registry), IK pose rig (r2kxcjh), camera compiler port (ving89w,
  `src/lib/camera/`).
- **Canvas UI spec BLESSED** (0rtwaj4 lineage, 8378214) after three
  adversarial audit passes; **Canvas Phase 1** (jl4ye8x, 0ee1bcb) and
  **Phase 2** (flyuh6h, 2ae8ce1) landed behind `?canvas=1`, vision-verified
  7/7.
- **Experiment ladder complete** (qx1e45p, 7ed5ewa, muwufpp, a80ekav-partial,
  ma59y73): measured verdicts folded into the research docs — headline: the
  AddGuide positional-guide movement director is the product path (E-MD1);
  Ref2VA turbo default = larryvrh v4_step600_ema (fast tier only, per the
  maintainer's quality steer); MATLOWAI fused-turbo verified at 4-step (blind
  clear gap) with the Mystic-style-baked-in caveat; adaln-hybrid wins
  subject-preserving edits (E-ED1); held-seed tiers measured (turbo sharpest;
  extra steps buy motion/audio only).

## Building (in flight)

- **Benchmark harness v1** (cp96zdm) — committed suites + candidate CLI, the
  snake-oil detector; `benchmarks/` is its untracked working tree.
- **AutoContext catalog row follow-on** (p8oyfy1) — fetch-catalog entry +
  temporal-exclusivity prompt guidance (research landed: lxmtgss).

## Queued (specced/planning, P0 first)

- Self-managed ComfyUI runtime completion (3ay7wbz, P0 — remaining ACs).
- Benchmark harness construction (cq67hpj) and the real-world numbers it
  enables; camera A/B (v15 prose vs numeric keyframes) rides it.
- Graph visual verification via Playwright-into-ComfyUI (yq8fnel).
- Canvas document-model spec (o0xw49r) + drift-envelope suite (5nfy24y) —
  both feed the canvas build-out; canvas build tasks fan out from the blessed
  spec (epic vbrstja), including the camera editor + graph integration
  (y93rk61, split from ving89w).
- Engine integrations: start-frame factory (xlfl0iv), RefMod factory
  (y5ipryd), VDN 24GB chain option (9up52mj), FaceRefine during-render
  (krzunud), Krea 2 stills + Kreatine two-stage (mf3wfq6), spectrum
  acceleration (u6d8mop), MMH3SplitUpscale tiled preset (3l8h28e),
  control-input creation tools (r2copa7, Control Surfaces epic 66xhflw).
- Research backlog: upstream watch items (zxx05jm), deferred candidates
  (kqgromm).

## Awaiting maintainer / external

- **DiffSynX smoke** (open AC on a80ekav): 10-minute staged script
  (`test-results/experiments/tranche3b/scripts/diffsynth_smoke.sh`) — last
  attempt was blocked ~320 MB short on GPU memory by desktop apps; needs a
  quiet GPU window.
- **MATLOWAI fused-turbo default-vs-labeled** — verified winner at 4-step but
  Mystic style is baked in; the maintainer's call whether it becomes a
  (labeled) default tier.
- **Licensing final statement** (68rnn84): refresh PROVENANCE.md with the
  final-diff statement when the canvas rewrite completes.
- Deferred: few-shot LoRA training sidecar (ehzagoc, P2).

## Explicitly not planned

- Anything GPU/testbed-bound runs only in maintainer-authorized windows
  (`docs/agent/runbook.md`); the maintainer's 8188 instance is always
  off-limits to agents.
- No network telemetry, no filters/gating (content-neutral by design).
