# Roadmap — state of play

> **Derived from Flux (project `r2lnrfw`); refreshed 2026-09-20 by the doc-hygiene
> fork at the maintainer's pre-compaction request, then again post-merge by the
> session-closing cohesion check (881p9ik).** Flux is the source of truth;
> this file is the human-readable state of play — if it disagrees with the board,
> the board wins. Task ids are Flux ids.

## THE ACTIVE FRAME — the foundation remediation program (epic 4lphxv8)

**The maintainer's verdict (2026-09-20)**: the foundation wasn't solid — a full day
of small-friction fixes never got them past "enter a prompt, pick video, execute,
fail." The response is a full audit + remediation program, with the maintainer's
stated stakes: remediate, or the project gets scrapped and restarted fresh.

**Where it stands**: three section-assigned audits complete (UX/IA, generation
pipeline + realtime, external-instance + node friction) plus the adversarial
direction audit (cygbkeq, report on its task record); the consolidated remediation
plan landed (PR #31, `docs/audit/remediation-plan.md` — 36 deduplicated findings,
four waves, six `[REC]` decision points awaiting the maintainer). **The critical-path
fixes and Phase 0 removals have MERGED**: PR #32 (tmz8vh7 — the T=1 wedge fixed at
both seams) and PR #33 (z8bc21p — LTX + Z-Image + original-build cruft out, −12,953
lines, manifest at `docs/audit/removals-phase0.md`). Main is at `665ed96`; 33 PRs
merged lifetime. **The maintainer is reading the direction-audit report and ruling
on the plan's decision points — no wave dispatches until that approval lands.**

**The rename, locked (2026-09-20)**: the app is **MONOKA** and the aesthetic is
**shibui** (sumi base, washi neutrals, vermillion seal-accent, wood-warm chrome;
font/icon criteria on the epic) — directives `55857485` + `2561df9e` on 4lphxv8.
The GitHub repo is now **Cobdog/Monoka-dev** (origin repointed; the LOCAL FOLDER
deliberately stays MINIMAX-DESKTOP — renaming it breaks Claude Code). The
public-repo strategy (directive `262db65f`): Cobdog/Monoka exists PRIVATE as a
stub; Monoka-dev stays the messy working repo and curates into it later. The full
app/doc/git rename sweep executes as ONE atomic pass during remediation (wave 2–3
timing) — the in-app and catalog URLs still naming `Cobdog/MINIMAX-DESKTOP`
(they redirect) are that sweep's scope, not staleness to fix piecemeal.

**The four waves** (the plan carries the detail):
- **W1 — unblock rendering**: the maintainer's exact first-session journey as the
  acceptance bar (engine re-check loop, preflight before submit, readable failures,
  the misroute gates, the debug suite instrumented as fixes land).
- **W2 — removals + registry-only**: the strip completes; the registry-only
  inventory build implements the directives below.
- **W3 — the redesigns**: Settings IA, first-run wizard, the preflight surface,
  node-level model dials — shaped post-directive.
- **W4 — the tail**, with named dissolution expectations.

### The destination architecture (the maintainer's directives, all on the epic)

A **workshop of three workstations** — modular to the core:
- **WIRING** (the canvas): the infinite graph, complete and self-sufficient.
- **CONTROL** (the control center, post-foundation design): modular rack tiles,
  previews, lock-and-cascade; reads everything, edits nothing.
- **CREATION** (the workbench, post-foundation design): all media/prompt creation —
  editing, reference sheets, refmods, LoRAs (trainers: Fizgig/Musubi/Ostris), the
  multi-model stack, the LLM/prompt-library composer. Both INPUT (source
  abstraction: disk | upload | workbench, for media AND prompts) and OUTPUT (the
  gallery — the canonical output home).

**Settled architecture directives** (never re-litigate):
1. **Registry-only MODELS** — ComfyUI's registry is the only source of truth; no
   manual pointing; instance-invisible = nonexistent; the manual model-location UI dies.
2. **Registry-only NODES** — detection reads object_info; the custom_nodes folder is
   only the install target for remediation; ComfyUI-Manager's API first for installs,
   our fetcher second.
3. **Models live on the NODES** — node-level dials; Settings is the fallback layer
   (global default → chain override → node dial).
4. **The debug suite** — tagged toggleable junction logging; the
   describe-the-problem era ends.
5. **The chain manager** — post-foundation, full brainstorm/spec/audit/blessing.
6. **The modularity contract** — "pulling out and removing old tools should be as
   easy as buying a new one"; every wave's acceptance includes the removal-cost test.

## Shipped (verified, CI green at landing)

*Pre-program history — real, CI-proven, and now under the remediation frame: the
audits found the load-bearing structures sound (document model, graph factories,
realtime core, landing machinery) with the debt concentrated at the seams.*

- **Stabilization + web migration** (epics m2yc3vd, 1qv5cg3, yl4tzwb, ph34nd8):
  P0 data-loss/silent-failure fixes, LAN hardening, Electron stripped → standalone
  Node server + SPA.
- **Foundation pass** (epic t63llq): perf, pino+boundaries, SQLite/FTS5 + OPFS,
  realtime fabric, zustand discipline, CSS tokens + Base UI, EngineProcess,
  PreviewSource/filmstrips/pooling.
- **LLM layer** (1de65kg): router primary + Ollama fallback; 8-layer composer;
  vision captioning; unload-before-generate.
- **Graph factory + optimization registry** (ttlqwwi, g07jo24); **self-managed
  runtime increments 1–2** (3ay7wbz); **local-first fetcher + catalog** (hgjbea2);
  **Identity Edit** (t8u00uu); **form-adaptive LoRA node** (k271ykk); **IK pose
  rig** (r2kxcjh); **camera compiler port** (ving89w); **Krea 2 edit families**;
  **Diagnostics suite**; **benchmark harness v1** (cp96zdm); **AutoContext
  catalog** (p8oyfy1).
- **Canvas Phases 0–5b SHIPPED** (specs blessed after adversarial audits): document
  store → substrate/launcher/queue → generation on canvas → ops/forks/takes →
  latent-fork rendering + the retirement wave → the deletion wave (canvas became THE
  app) → the Director Suite (timeline projection, plan documents, the gap menu;
  MoviePlanner retired).
- **Experiment program**: tranches 1–3b + E-FC + E-MD1 + E-K1 + MATLOWAI — verdicts
  in the research docs as dated addenda.
- **Training research**: DiffSynX smoke (a80ekav), the envelope (1n3a4mi), the
  training guide (mfdza7o), the per-model prompt doctrines, the Fizgig assessment.
- **Infrastructure migration** (dgrkp2e): central model home, canonical ComfyUI,
  118 GiB dedup, quarantine purged.
- **Overnight full audit** (junllxf, 5 PRs): security/correctness/perf/E2E —
  the latent live-verify POSITIVE.
- **Dataset Manager v1** (sv14rt0): the blessed spec end-to-end at `?datasets=1`.
- **H3 Image Workbench** (k9vu6t0, PR #12): the blessed spec r2 at `?images=1` —
  now understood as the SEED of the creation surface.
- **The 09-19 fix waves** (PRs #18–#27): image-pathway reroute (Z-Image → H3-1F),
  model overrides, LoRA timeline, external-instance integration, the settings +
  app-tour UX waves, start.sh launcher (configure TUI, dev mode, pull-freshness,
  tty hygiene), the node-pack status board.
- **Test suite migrated to vitest** (z7ogmig, PR #29): 19 serial cjs suites →
  `tests/*.test.js`, one parallel run (4.6× unit speedup), port allocator,
  build-before-unit gate.
- **Override layer completed** (rq0lsax PR #28 + epdvxd4 PR #30): instance-source
  form arm, the three checkpoint lanes (fl2va/ref2va/merged), the VAE trio
  (video/audio/image) + the workflow-population audit as a standing test.
- **Critical-path fixes** (tmz8vh7, PR #32): the T=1 wedge — legacy VAE picks
  route by decoder class at both seams, the server heals stored wedges at load,
  the inverse image/reference misroute refuses honestly, the remaining three
  dock scroll locks fixed.
- **Phase 0 removals** (z8bc21p, PR #33): LTX and Z-Image fully removed; the
  mobile companion, the five asset studios, and 447 dead CSS class families out
  (styles.css 274 KB → 60 KB); the manual model-path surface cut (read-only
  inventory + refresh); manifest with restore paths at
  `docs/audit/removals-phase0.md`; e2e 101 passed on the merged tree.

## Queued (the plan's waves carry the real order)

- **Wave 1 dispatch** — after the maintainer approves the plan (the fixes and
  removals it waited on have landed).
- **Control Center + Workbench spec rounds** — post-foundation, full design
  treatment (brainstorm → spec → blind audit → blessing).
- Pre-program queue (re-scoped by the plan where relevant): the training sidecar
  (ehzagoc), drift-envelope suite (5nfy24y), camera editor, control-input tools,
  engine integrations (start-frame factory, RefMod factory, VDN chain option,
  FaceRefine, Krea 2 stills, spectrum, SplitUpscale), derive-curve-form utility,
  graph visual verification, licensing statement.
- **Nits backlog** (5vu57ue) — deliberately deferred; many will dissolve in the
  redesigns.
- **GPU-window batch** (maintainer-timed): first real training run, E-IW2 (burst
  fusion), E-IW3 (pan-stitch), benchmark plumbing pass, Fizgig A/B.

## Awaiting maintainer

- **The remediation plan's six `[REC]` decision points** (the plan's executive
  summary) — the approval gate for wave 2+ dispatch.
- **Batch 4 keep/kill list** (dgrkp2e): fl2va-pruned, ref2va-pruned, 32B TE
  variant, GLM-in-tmp relocation.
- MATLOWAI default-vs-labeled; Intern bakeoff soak; Qwen3.8-Flash-Next
  verification (qwen4exp + mmproj).

## Explicitly not planned

- Audio work (V2A, vzpyldn) — parked; hinges on the envelope's audio A/B.
- GPU/testbed work only in maintainer-authorized windows; 8188 off-limits to agents.
- No network telemetry, no filters/gating (content-neutral by design).
- **Agentic Dataset Harness** (epic xfm74qg) — parked P2 per the maintainer
  ("the base app comes first"); all groundwork done and on its record.
