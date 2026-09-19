# Docs-vs-app conformance audit — every documented area checked against the code

> Flux task u7rxi2e (project r2lnrfw), 2026-09-19. The maintainer's ask: "take our
> documentation findings, and ensure all areas of our app are actually following what
> our docs are saying, that we don't have any obvious gaps or glaring issues."
>
> **Method.** Docs inventory first (every file under `docs/specs/`, `docs/research/`
> verdicts + dated addenda, `docs/agent/*`, `docs/audit/*`, `docs/LEARNINGS.md`,
> `docs/ROADMAP.md`, `README.md`, `architecture.md`, `migration.md`, `PROVENANCE.md`,
> `LICENSES.md`, the library README), extracting each load-bearing assertion
> (behavior / default / enforcement / adoption / measured number), then verifying each
> against the code (jcodemunch index + direct reads; the Flux board and git history as
> the deferral/landing record). Then the reverse sweep (code behaviors with no doc
> home) and the contradiction sweep (doc vs doc). Evidence tags: **[DOC]** verified in
> shipped code at the cited lines, **[BOARD]** verified on the Flux record,
> **[GIT]** verified in git history. Every finding carries BOTH citations (doc
> file:line and code file:line).
>
> **Base commit:** `f9c61c9` (worktree HEAD; main was one docs-only commit ahead,
> `ce5df88` — the Fizgig addendum — reviewed via `git show` and folded in). No
> engine/GPU was touched; this is a read-only analysis plus the unambiguous STALE-Doc
> fixes applied in the same PR (§7). **Doc line numbers in the findings cite the
> pre-fix tree** (the state that was audited); the fixes land in this PR.

---

## 0. Verdict summary

The repo's documentation discipline is genuinely strong — the newest, most
load-bearing areas (dataset manager, image workbench, canvas document schema,
caption doctrines, training-guide recipe cards, the perf harness docs) conform to
their specs **line-for-line**, including measured numbers (budget formulas, floors,
pins). The audit found **zero VIOLATIONS** (no case where the app actively defies a
current, intentional documented requirement).

The failure mode that does exist is **doc lag behind deliberate change**: the
README, `architecture.md`'s renderer/API sections, `ROADMAP.md`, `testing.md`, and
four spec status lines all describe the app as it stood 2026-09-14/17 — before the
canvas deletion wave (Phase 5/5b, 2026-09-17) and the five PRs merged after the last
ROADMAP refresh (#18 image pathway, #19 model overrides, #20 LoRA timeline, plus the
QOL wave and the benchmark harness joining the gate). Two major shipped features
(the **LoRA timeline** and **model overrides**) have **no doc home at all** — the
exact "obvious gap" class the maintainer named.

| Class | Count | GLARING | MODERATE | COSMETIC |
|---|---|---|---|---|
| STALE-Doc (doc describes an older reality) | 16 | 4 | 8 | 4 |
| GAP (documented promise not implemented) | 10 | 0 | 7 | 3 |
| DRIFT (spec/build wording divergence) | 3 | 0 | 2 | 1 |
| VIOLATION (app defies a current doc requirement) | 0 | — | — | — |
| Reverse-GAP (code behavior with no doc home) | 8 | 2 | 4 | 2 |

Thirty-seven findings total. Twenty-plus are fixed mechanically in this PR (§7);
the task-level remainder are queued on the Flux record (§8).

---

## 1. Findings — STALE-Doc (the doc describes an older reality)

### S1. GLARING — README "Capabilities" describes the pre-Phase-5 app: Movie Planner, Z-Image, LTX workspace, and six more retired affordances

- **Doc:** `README.md:152` ("Latent scene chaining: render a Movie Planner scene as
  one continuous sequence… The Clip Editor's frame-accurate pixel concat remains
  the manual fallback"), `README.md:148` ("presets — Native Quality, official
  Turbo 8, Preview… custom sampling isolated under an explicit Experimental
  disclosure"), `README.md:150` ("warns when a character carries more than four
  identity pictures (every reference is scaled to a 2048px short edge)… with the
  LTX turntable as fallback"), `README.md:153` ("manifests… downloadable per job
  or exported in bulk"), `README.md:156` ("Non-destructive reference video
  clipping… create a focused 2–15 s reference MP4"), `README.md:158-162` ("Other
  providers (separate workspaces…): LTX-2.5…; Z-Image Turbo first-frame and
  standalone still generation"), `README.md:167` ("Movie Planner: Ollama-assisted
  scene/shot planning…"), `README.md:161` (Music 3 "official three-section
  caption builder… LLM-layer caption rewriter"), `README.md:195-201` ("The LTX
  2.5 workspace is a separate provider…").
- **Code (all verified against the current tree; the UI claims lived in the
  Phase-5-deleted views):** MoviePlanner RETIRED — `src/canvas/StudiosDock.tsx:16`;
  ClipEditor + VideoReferenceClipper deleted (only the non-destructive trim op
  remains, `src/canvas/ops.ts:39`); the preset trio lived in the deleted
  CreateView — canvas tiers are "Quality / Fast · 4-step / Fast · 8-step"
  (`src/canvas/PropertiesPanel.tsx:48-52`) and `experimentalSampling` is
  hardcoded false everywhere (no UI toggle); the >4-identity warning and
  2048px-scaling strings existed only in CreateView (grep: zero hits in src);
  manifest `downloadJson` (`src/lib/manifest.ts:116`) has ZERO callers since
  JobsView died (manifests still recorded on jobs/takes); the LTX turntable
  fallback was deliberately removed ("ContactSheet-required — the LTX survey
  fallback dies", commit c61e4c5); Z-Image retired for stills
  (`src/canvas/stillIntent.ts:28-30`); the Music 3 caption builder +
  LLM rewriter are ORPHANED (`src/components/Music3Workspace.tsx` has no
  importers — the AudioDock uses a freeform caption,
  `src/canvas/AudioDock.tsx:91-99`); all per-engine workspaces deleted (engines
  are canvas ops + the AudioDock).
- **Why GLARING:** a user or agent reading the README would look for at least
  nine features/affordances that no longer exist and miss the ones that replaced
  them (plan documents / Director Suite, H3-1F stills, canvas ops).
- **Remediation:** fix-now (applied — §7.1): every affected bullet rewritten to
  the current reality. A full canvas-era README polish pass is queued (Q1).

### S2. GLARING — README never mentions the canvas (THE app), the dataset manager, or the image workbench

- **Doc:** `README.md:141-181` (Capabilities) — no mention of the canvas surface,
  `?datasets=1`, `?images=1`, the timeline/plan documents, or the surface switcher.
- **Code:** canvas IS the default route (`src/main.tsx:33-34`, `src/surfaces/registry.ts:44-46`
  — `default: true, matches: () => true`); datasets surface (`registry.ts:48`),
  images surface (`registry.ts:51`); V-key projection cycle and plan documents per
  `docs/specs/canvas-ui-v1.md:395-419`, verified in `src/canvas/store.ts:988-997`,
  `src/canvas/plan.ts:309-420`.
- **Why GLARING:** the single biggest fact about the current app — the default
  surface — is absent from the user-facing doc.
- **Remediation:** fix-now (applied — §7.1, a "Surfaces" paragraph); full rewrite
  queued (Q1).

### S3. GLARING — architecture.md "Renderer structure" describes the deleted shell

- **Doc:** `docs/architecture.md:145-157` — "`src/App.tsx` (~630 lines) is the
  composition shell", "`src/views/` … `CreateView`, `LibraryView`, `JobsView`…",
  "the legacy view tree above remains the default surface while the canvas
  build-out continues"; `:247` "e2e … 14-view render sweep"; `:61` API route list
  omits the `documents/*` and `datasets/*` route families.
- **Code:** `src/App.tsx` does not exist (deleted with the View union, Phase 5);
  `src/views/` = `DiagnosticsView.tsx` + `SettingsView.tsx` only; default route is
  the canvas (`src/main.tsx:68-79`); e2e is canvas-centric (`e2e/canvas.spec.ts`,
  50 tests + datasets/images/poserig/prototypes specs); `server/documents.ts`
  (route family wired in `server/core.ts`) and `server/datasets/index.ts` exist.
- **Remediation:** fix-now (applied — §7.2): dated correction block + the three
  falsehoods fixed inline; full architecture refresh queued (Q2).

### S4. GLARING — ROADMAP "state of play" is 6+ merged PRs behind

- **Doc:** `docs/ROADMAP.md:103-124` ("Building (in flight)") lists
  **2hbv2ib** (design decisions), **twmpu4m** (post-audit cleanup), **pq7d48a**
  (perf wave 1) as in-flight; `:145` "Queued… Camera editor (y93rk61)". Refreshed
  2026-09-17 (`:3-4`).
- **Board/GIT:** all four are DONE and merged — 2hbv2ib = PR #9 (`8b5d59f`), twmpu4m
  = PR #8 (`fe535f1`), pq7d48a = PR #6 (`320eb34`, measured addendum in
  `docs/research/app-performance-profile.md:261-295`), y93rk61 done on the board.
  Post-refresh merges absent from the ROADMAP entirely: image workbench
  (jvcrud2+k9vu6t0, PR #12 `492436d`), QOL wave (rrxlw2r), image pathway reroute
  (34afx79, PR #18 `f1a0a8d`), model overrides (euxwdva, PR #19 `99cfddb`), LoRA
  timeline (7twfk6o, PR #20 `ee0594c`), structured prompt editor (fh94g76), the
  per-model doctrine harvest (3449qan), pan-stitch research (4akaet6), the Fizgig
  addendum (6niii1p, `ce5df88`).
- **Why GLARING:** ROADMAP is the orientation doc agents are pointed at; an agent
  would believe perf wave 1 / design decisions / cleanup are unfinished and might
  re-dispatch them, and cannot discover model overrides or the LoRA timeline at all.
  Mitigation (why this is fixable doc-side): the header says the board wins on
  disagreement.
- **Remediation:** fix-now (applied — §7.3): the three waves moved to Shipped with
  commit cites, post-refresh entries added, camera editor removed from Queued.
  Process note queued (Q3): refresh ROADMAP at every PR-train merge.

### S5. MODERATE — testing.md gate list + benchmark-harness status stale

- **Doc:** `docs/agent/testing.md:37-41` (gate chain omits `test:documents`,
  `test:canvas`, `test:benchmarks`) and `:123-127` ("Benchmark harness (in
  flight)… when it lands it joins the gate chain — update this file and the README
  when it does").
- **Code:** `scripts/run-gate.cjs:48-99` — the actual chain includes
  `test:documents` (:58), `test:canvas` (:87), `test:benchmarks` (:93); the harness
  landed (cp96zdm DONE) and joined the gate; testing.md's own instruction to update
  it was not followed.
- **Remediation:** fix-now (applied — §7.4).

### S6. MODERATE — README gate list omits four suites

- **Doc:** `README.md:40-45` — the gate order omits `test:h3img`, `test:documents`,
  `test:canvas`, `test:benchmarks`.
- **Code:** `scripts/run-gate.cjs:52` (h3img), `:58` (documents), `:87` (canvas),
  `:93` (benchmarks).
- **Remediation:** fix-now (applied — §7.1).

### S7. MODERATE — security-audit resolution note says HTTPS "remains open"; it shipped

- **Doc:** `docs/audit/security-audit.md:5` — "The HTTPS-with-fingerprint
  recommendation remains open as the long pole (task eqbx1dq, P2)."
- **Code/Board:** eqbx1dq DONE; `server/index.ts:40-49` prints the scheme and the
  certificate fingerprint, with the plain-HTTP advisory line.
- **Remediation:** fix-now (applied — §7.5).

### S8. MODERATE — image-workbench spec status line says "awaiting maintainer blessing"; it was blessed and built

- **Doc:** `docs/specs/image-workbench-v1.md:3-4` ("Status: DRAFT r2 — … awaiting
  maintainer blessing") — contradicted by its own inputs line (`:5-6`, "the twelve
  locked decisions + the refine amendment").
- **GIT/Board:** blessing task jvcrud2 DONE ("spec + blind audit + blessing"); build
  commit `028e392` "feat(images): H3 Image Workbench v1 — **the blessed spec built**
  (k9vu6t0)"; PR #12 `492436d` "the blessed spec r2 complete".
- **Remediation:** fix-now (applied — §7.6).

### S9. MODERATE — structured-prompt-editor spec says "DRAFT for maintainer confirmation"; it shipped

- **Doc:** `docs/specs/structured-prompt-editor.md:3-5`.
- **Code/Board:** fh94g76 DONE; implemented as `src/lib/structuredPrompt.ts` +
  `src/components/StructuredPromptEditor.tsx` + the properties-panel toggle
  (`src/canvas/PropertiesPanel.tsx:482-507` — comment cites "fh94g76, spec §4").
- **Remediation:** fix-now (applied — §7.6).

### S10. MODERATE — canvas-document-model spec is "DRAFT v0.1" while the schema shipped and has moved past it

- **Doc:** `docs/specs/canvas-document-model.md:1-3` (status DRAFT).
- **Code:** the schema shipped in Phase 0 (oiavqh8) and has since gained fields the
  spec doesn't list — e.g. `canvas_plan` segments carry `loraRange`/`loraStack`
  (`src/canvas/plan.ts:126-130,153-167`, PR #20) and migration 004 added the
  one-canonical-take index (`139ba9c`). All §2.2 invariants verified present
  (`server/documents.ts` — append-only trigger :192-203, staleness :1262-1280,
  version guard :645-659, blob hashes :294-304, tombstones, `asset_fork.consent_at`
  :272-279, archive `server/documentArchive.ts`).
- **Remediation:** status line fixed now (§7.6); a dated schema addendum (new fields
  since §1) queued (Q4).

### S11. MODERATE — canvas-ui spec §9 ledger rows read "OPEN" for rows the header says were DECIDED

- **Doc:** `docs/specs/canvas-ui-v1.md:447-454` (BLESSED header: "all DECIDED as
  recommended") vs the table rows L1-L25 still carrying "OPEN" (`:461-486`).
- **Remediation:** fix-now (applied — §7.7): one-line note at the table head
  deferring to the blessing block (the table was deliberately not rewritten at
  blessing; the note makes that explicit instead of silent).

### S12. COSMETIC — canvas-ui spec carries two contradictory status blocks

- **Doc:** `docs/specs/canvas-ui-v1.md:2-9` (BLESSED) followed by `:11-18` (a
  leftover "**Status:** DRAFT — section-by-section review" block from v0.2).
- **Remediation:** fix-now (applied — §7.7): the leftover block removed.

### S13. COSMETIC — LICENSES.md cites a non-existent task id

- **Doc:** `docs/LICENSES.md:191` — "task 2hbv2b" (the design-decisions task is
  **2hbv2ib**; the typo'd id resolves to nothing, breaking traceability).
- **Remediation:** fix-now (applied — §7.8).

### S14. COSMETIC→MODERATE — fun-control research doc cites deleted code as "[DOC our code]"

- **Doc:** `docs/research/fun-control-input-surface.md:23` — "What carries over from
  our shipped Z-Image Fun Control Union path (commit `63a09c2`,
  `src/lib/zImageControlnet.ts`)".
- **Code:** the file was deleted with Z-Image (34afx79). The doc is a dated research
  record, but its live-code citation now points at nothing, with no addendum noting
  the retirement.
- **Remediation:** queued (Q5): one dated addendum line. (Judgment call: not
  applied now because the retirement note belongs with the canvas-spec addendum
  cross-reference and touches a research doc's audit trail — maintainer may prefer
  the conventions' addendum style verbatim.)

### S15. COSMETIC — `pnpm test:all` is not "the same chain" as the gate

- **Doc:** `README.md:45-46` ("`pnpm test:all` is the same chain without the
  harness niceties").
- **Code:** `package.json:38` — test:all runs a different order (test:e2e, which
  re-runs `pnpm build`, right after test:h3img), includes test:vision, and is
  not gate-ordered. Left as-is in this pass (harmless imprecision, queued with
  Q1's README polish).

### S16. COSMETIC — "both are PWA-installable"

- **Doc:** `README.md:180` — one shared, mobile-branded manifest exists
  (`public/manifest.webmanifest`, `start_url: /?mobile=1`); there is no desktop
  PWA identity. Adjusted in §7.1 to claim only the mobile companion.

---

## 2. Findings — GAP (documented promise, not implemented)

### G1. MODERATE — canvas spec §7 keyboard map: Space play/pause, ←/→ scrub, ⇧1-9 camera bookmarks absent

- **Doc:** `docs/specs/canvas-ui-v1.md:322-328` (§7 base: "Space play/pause
  (selected tile), ←/→ scrub… camera bookmarks (⇧1–9 set / 1–9 with modifier go)";
  §3 `:203-204` "camera bookmarks (named, in the palette)"; `:327-328` "Shortcuts
  printed on affordances… every discoverable surface shows its keys" — §1-§10 were
  blessed).
- **Code:** no Space binding (only `Tile.tsx:226` uses `' '` for op chips); no
  ArrowLeft/Right scrub (mouse slider `OpEditor.tsx:265-283`); no bookmark code
  anywhere in `src/canvas/` or `src/camera`; J/K and digits 1-9 are not printed on
  any affordance (verified: `<kbd>` prints exist only for V/P/B/R/↵/⌘K/⌘Z/Esc//).
  Implemented and verified: J/K, B, P, R, V (cycle ∅→timeline→library→∅), digits
  1-9 take-jump, Escape, `/`, ⌘K, Enter, ⌘Z (`src/canvas/CanvasApp.tsx:78-153`).
- **Deferral check:** no task on the board covers the missing three. NOT a
  documented deferral.
- **Remediation:** queued (Q6).

### G2. MODERATE — radar promised a GPU meter; none exists on canvas

- **Doc:** `docs/specs/canvas-ui-v1.md:252-253` ("engine chip + GPU meter live
  inside it [the radar] — the one fixed-chrome survival").
- **Code:** `src/canvas/Radar.tsx:96-98` — engine chip only; no GPU/VRAM meter
  anywhere in `src/canvas/` (telemetry exists server-side, `/api/telemetry`).
- **Remediation:** queued (Q6).

### G3. MODERATE — summonable index promised retry / cancel / rerun-stale; only cancel exists

- **Doc:** `docs/specs/canvas-ui-v1.md:255-256` ("flat list across all jobs
  (retry/cancel/rerun-stale)"); the Phase-4 addendum `:431-433` says the D3
  three-layer synthesis was "verified complete".
- **Code:** `src/canvas/IndexOverlay.tsx:172-182` — stop/cancel only; rerun-stale
  lives on R + the bottom bar, retry absent.
- **Remediation:** queued (Q6) — small UI addition or a spec addendum accepting the
  split.

### G4. MODERATE — workbench spec §6 RefMod strength dial has no implementation and no deferral note

- **Doc:** `docs/specs/image-workbench-v1.md:118-119` ("**RefMod strength** =
  blur-latent blend, order-invariant, per-slot dial" — normative §6).
- **Code:** no `refmodStrength`/blur-latent RefMod path anywhere; RefMod slots never
  reach a graph in v1 (`src/lib/graph/h3image.ts:865` throws honestly; slots are
  read-only files, `src/images/session.ts:39`). Defensible as riding the H8
  (RefMod factory) deferral — but the spec does not say so, unlike its other
  deferrals (E-IW1/E-IW2 are explicitly marked).
- **Remediation:** queued (Q7 — one spec addendum line + optionally a task).

### G5. MODERATE — AutoContext §8 "adoption notes" beyond guidance+catalog were never implemented and are only partly deferral-tracked

- **Doc:** `docs/research/autocontext-deepread.md:476-488` (§8 "what our graph
  factory takes": per-segment reference filtering "adopt as-is", hash-based resume,
  the vcd dial "adopt the primitive", untagged context-audio ref "adopt; cheap",
  seam-index export).
- **Code/Board:** what shipped is the catalog row + temporal-exclusivity prompt
  guidance only (`server/engineNodes.ts:211-227`, `src/lib/promptComposer.ts:152-192`,
  p8oyfy1 DONE; the lxmtgss closure records that scope). The §8 remainder has no
  tasks; the nearest queued work is the drift-envelope suite (5nfy24y). The research
  doc's §8 heading ("what our graph factory takes") reads as an adoption commitment.
- **Remediation:** queued (Q8): either a dated addendum scoping §8 to "adopted:
  catalog + guidance; remainder folded into the drift-envelope suite (5nfy24y)" or
  individual tasks.

### G6. MODERATE — per-family caption-instruction branches still absent in the Studio LLM layer

- **Doc:** `docs/research/per-model-prompt-doctrines.md:38,68,96,108` —
  "`DEFAULT_CAPTION_INSTRUCTION` needs the Anima branch… likewise… gets the Krea 2
  branch… the two gaps above feed `DEFAULT_CAPTION_INSTRUCTION`'s H3 branch".
- **Code:** `server/llm/index.ts:56` — still the single generic instruction; no
  per-family branches (the **dataset manager's** VLM path does carry the class
  templates, `server/datasets/vlm.ts:85-103` — the H3 doctrine is followed there).
  The anima `OF_` row gap IS tracked (task eagkso0, planning) — that one is a
  documented deferral. The `DEFAULT_CAPTION_INSTRUCTION` upgrade is framed as the
  standalone harness project's upgrade path (epic 6niii1p, spec round a1jy64t) —
  partially documented, no Studio-side task.
- **Remediation:** queued (Q9): confirm the Studio-side branch work belongs to the
  harness project (then record that on the doctrines doc) or file the Studio task.

### G7. COSMETIC — dataset spec §8 tier summary omits gate 5

- **Doc:** `docs/specs/dataset-manager-v1.md:211` ("1–4 and 8 are refusing, 6–7 and
  9 warning-tier" — gate 5 unclassified), while §5 `:166-169` says decoded < target
  refuses.
- **Code:** `server/datasets/bake.ts:289-293` — gate 5 refuses (decoded-count +
  bake-failed). The spec summary just forgot the tier.
- **Remediation:** queued (Q7 — one word, but it is a BLESSED spec; a dated errata
  note is the conventions-correct fix).

### G8. COSMETIC — dataset spec §13 duplicates the "Held-back features" paragraph

- **Doc:** `docs/specs/dataset-manager-v1.md:307-308` and `:315-316` — the same
  paragraph twice.
- **Remediation:** queued (Q7; trivial, but blessed-spec edits deserve a dated note).

### G9. GAP (documented, tracked — recorded for completeness) — anima output_format row

- `docs/research/per-model-prompt-doctrines.md:38` flagged it; task **eagkso0**
  (planning) carries it with failing-without-it test ACs; verified absent in
  `server/llm/fragments.ts` (no anima row; rows at :162-170). This one is working
  AS DESIGNED (doc flagged → board tracked). No action beyond the existing task.

### G10. MODERATE — the one-time model-license notice is orphaned (unrouted after the Phase-5 shell deletion)

- **Doc:** `README.md:188` ("One-time model-license notice covering the MiniMax
  community license's reported region and commercial-use constraints") and the
  migration inventory's explicit classification — `docs/research/ui-inventory-and-migration-map.md:114`
  (row 40 `LicenseNotice.tsx`: "**KEEP** — Legal surface; must survive any
  shell (first-run risk R1 companion)").
- **Code:** `src/components/LicenseNotice.tsx:10-28` exists with the claimed
  content but has **no mount point** — its only renderer was the deleted
  `App.tsx`; nothing in `CanvasApp` renders it (the canvas `FirstRunNotice` is
  about empty model folders, not the license).
- **Why it matters:** a documented KEEP-class legal surface silently stopped
  rendering in the deletion wave; the README claimed it to users.
- **Remediation:** fix-now on the README side (the claim now states the notice is
  unrouted and tracked — §7.1); the code fix (re-mount on canvas first run) is
  queued (Q10) — small, but it is a code change beyond this read-only-plus-docs
  PR's scope.

---

## 3. Findings — DRIFT (spec/build wording divergence)

### D1. MODERATE — workbench spec §7 says the scorer uses "CLIP similarity"; the build uses a declared CLIP seam + color-histogram affinity

- **Doc:** `docs/specs/image-workbench-v1.md:127-129` ("ranking frames by Laplacian
  sharpness + CLIP similarity to the prompt/ref roles — the E-IW2 metric set, no new
  dependencies").
- **Code:** `src/lib/h3imageScorer.ts:46-48,117-138` — Laplacian + color-histogram
  affinity; CLIP is an explicit seam ("pass clipScores when a consent-gated CLIP
  ever rides the lane; the v1 rank never depends on one"); `metricBasis` states it
  in provenance. Honest in code, divergent in spec wording (the spec's own "no new
  dependencies" line is what forced the substitution).
- **Remediation:** queued (Q7 — spec addendum).

### D2. COSMETIC — README "Segments cap at 15 s" phrasing vs the grid reality

- **Doc:** `README.md:152` ("Segments cap at 15 s" for latent chaining).
- **Code:** the cap is the 17n+5 grid at 24 fps with 345 f = 15 s the released max
  (`server/datasets/model.ts:29-40` gridTargets ≤345; plan segments carry no
  separate 15 s constant — the enforced maximum is the engine's 345-frame grid).
  The claim is materially true but reads like an app-side constant. Covered by the
  S1 rewrite; no separate action.

### D3. MODERATE — the custom-sampling "Experimental disclosure" exists as a code seam with no UI

- **Doc:** `README.md:148` (pre-fix) promised custom sampling "isolated under an
  explicit Experimental disclosure".
- **Code:** the seam is real and enforced (`src/lib/workflow.ts:256-266` pins the
  official pair unless `options.experimentalSampling`; `src/lib/h3Submit.ts:230-233`)
  — but `experimentalSampling: true` is unreachable: no UI sets it (canvas
  hardcodes false, `src/canvas/generation.ts:451`, `SettingsDock.tsx:63`). The
  disclosure UI died with CreateView.
- **Remediation:** the README claim was adjusted in §7.1; the product decision
  (re-expose an experimental toggle on the canvas, or retire the seam) is queued
  (Q11).

---

## 4. Reverse sweep — significant app behaviors with NO doc home

(Definition: a user/agent could not discover the behavior from any doc — README,
architecture, ROADMAP, specs, or research addenda.)

| # | Behavior | Code | Severity |
|---|---|---|---|
| R1 | **The LoRA timeline** — paint LoRA ranges over a clip; the compiler emits per-LoRA segment chains joined by measured transition defaults (the tranche-measured FLF/dip numbers become UI defaults); plan segments gained `loraRange`/`loraStack` fields; take provenance records active LoRAs. Shipped in PR #20 (7twfk6o, `ee0594c`). | `src/canvas/loraTimeline.ts` (417 lines: grid conformance :22-98, measured transition defaults :113-133, compiler :268-359), `src/canvas/PropertiesPanel.tsx:66-318`, `store.ts:1238-1299`, `plan.ts:126-130` | **GLARING** (a whole authoring surface + a document-schema extension, documented only in the PR/commit) |
| R2 | **Model overrides** — global (Settings) + per-chain (properties panel) checkpoint/TE/VAE selection over the inference seam, chain>global>auto, wrong-kind refusal. Shipped in PR #19 (euxwdva, `99cfddb`). | `src/canvas/generation.ts:104-109,193-200`, `PropertiesPanel.tsx:734-759`, `store.ts:176-198`; also wired into the workbench (`src/images/submit.ts:55-66`) | **GLARING** (changes what every render loads; zero doc coverage) |
| R3 | Surface registry/switcher with Alt+1..9 accelerators + FirstRunNotice onboarding (QOL wave rrxlw2r) | `src/surfaces/registry.ts`, `SurfaceSwitcher.tsx:19-46`, `FirstRunNotice.tsx:1-73` | MODERATE |
| R4 | Canvas→workbench take chip ("N frames · pick" opens `?images=1`) — the reverse direction of the documented handoff | `src/canvas/Tile.tsx:247-255` | MODERATE |
| R5 | `h3img.tone-lock` as a canvas op-stack op (spec'd in the workbench spec §1, absent from the canvas specs' op list) | `src/canvas/ops.ts:20,47` | MODERATE |
| R6 | Live sampler-preview painting on generating tiles (F6/2hbv2ib) — mechanism captured in research, the UI behavior itself in no doc | `src/canvas/Tile.tsx:85-138`, `generation.ts:467-472` | MODERATE (ROADMAP fix in §7.3 covers most of it) |
| R7 | Structured prompt mode on canvas chains — spec'd (structured-prompt-editor.md) but never cross-referenced from the canvas specs (§5.5 names SmartPromptEditor only) | `PropertiesPanel.tsx:482-507,605-647` | COSMETIC |
| R8 | README documentation table missing the three newest specs (dataset-manager-v1, image-workbench-v1, structured-prompt-editor) and the load-bearing training guide/envelope/doctrines research docs | `README.md:236-266` | COSMETIC (fix-now applied — §7.1) |

Not reverse-gaps (checked, documented elsewhere): the dataset bridge both ways
(dataset spec §11), the benchmark harness (ROADMAP + testing.md after §7.4), the
perf overlay windowing (perf doc addendum), DiagnosticsDock/StudiosDock (canvas spec
Phase-5 addendum), the exit anchor+references variant (workbench build, queued with
Q7's spec addendum).

---

## 5. Contradiction sweep (doc vs doc)

1. **ROADMAP vs board/git** — three waves listed in-flight that are merged; six
   merged PRs absent (S4). The ROADMAP header's "board wins" clause resolves the
   conflict in principle; the doc is still the first thing agents read.
2. **testing.md vs run-gate.cjs** — gate lists differ; testing.md's benchmark
   prediction is self-acknowledged as needing an update it never got (S5).
3. **README vs testing.md** — two different (both incomplete) gate orderings (S5,
   S6).
4. **image-workbench spec status line vs its own inputs line vs git** (S8).
5. **canvas-ui spec: blessing block vs leftover DRAFT block; ledger header
   (DECIDED) vs row statuses (OPEN)** (S11, S12).
6. **security-audit note vs board** (eqbx1dq done) (S7).
7. **perf research addendum (wave 1 landed, measured) vs ROADMAP (in flight)** —
   the newer doc is correct; ROADMAP fixed in §7.3.
8. **per-model doctrines vs fragments.ts** — doc says "no anima row today" (still
   true, task-filed — consistent, not a contradiction).
9. Checked and clean: LEARNINGS vs code (pyFixed/pyFormatG in
   `src/lib/camera/parity.ts`, freePort in `scripts/test-{storage,realtime}.cjs`,
   `.gitignore:11` = `test-results/`, stylelint allowlist present,
   `OFFICIAL_H3_SAMPLER/SCHEDULER` at `src/lib/workflow.ts:15-16` and shift defaults
   12/3 at `src/lib/workspace.ts:52` — every LEARNINGS code citation verified
   current); migration.md (marked COMPLETE, historical by design); the two audit
   docs (resolution notes dated); the library README (captures + pins verified
   present).

---

## 6. Verified-conforming areas (so nobody re-audits these)

Every load-bearing assertion in these areas was checked and holds, with the doc's
own citations still accurate:

- **Dataset manager (BLESSED spec vs build):** both ingest paths + hash identity +
  per-path trash semantics; floors exactly as specced (video hard 160×96 / warn
  320×192 with the ~224 note; stills warn 512² / refuse 256² carrying the
  SPEC-inferred labels — `server/datasets/model.ts:112-141`); 17n+5 grid math,
  +2 bake headroom, decoded ∈ [target, target+2] (`model.ts:31-66`, `bake.ts` gate
  5); the managed aspect spectrum + middle-click mirror + 32-px crop grid
  (`model.ts:69-115`); all nine QA gates with the specced tiers and policy-gated
  gate 7 (`bake.ts:244-315`); musubi TOML + DiffSynX row exports + recipe cards
  (`bake.ts:362-445`, `model.ts:379-421`); both-trainer preflight against the
  envelope's measured numbers (VRAM ≈ 5.1 + 2.6×Mtok, musubi offset 20,074−17,286
  MiB — `model.ts:205-231`; walls 345 f/544×320, 124 f/480×832, 39 f/768×1344 —
  `model.ts:233-245`).
- **Caption doctrine (H3):** templates, character-class negative rules + appearance
  markers, trigger-first condensation — `server/datasets/model.ts:323-355`,
  `vlm.ts:85-103` match training-guide §4.4/§4.6 exactly. The
  noDialogue→ambience + `non_diegetic_music: N/A` root-cause fix (sampler doc §1c
  plague (a)) is implemented (`src/lib/dialogPolicy.ts:27-32`, task r0z7pf1).
- **Training guide + envelope numbers:** every measured value cited by the app
  (budget rule, walls, rank/LR/steps/de-distillation bands, batch-1, GC-mandatory)
  matches the docs; the sidecar itself is queued (ehzagoc) — the defaults await it
  by design.
- **Image workbench spec (12 decisions):** 11 of 12 verified with both-side
  citations (route+handoffs, packets/T=1 pins incl. Mamad8 guard
  `assertNoT1ImageVaeInVideoGraph` wired at `workflow.ts:97` + `h3image.ts:994`,
  transports, 9-slot honest refusal, Keep dial + generated contracts, refine
  always-opt-in, one-take-per-generation + scorer + manual override, 2 LoRA slots +
  guidance + form-adapter-first, hybrid loader gating, start-frame exit, E-IW1
  absent); VRAM staging /free discipline, burst gating + never-worse fallback,
  take-strip-as-pick-surface, session = `h3img` chain — all verified.
- **Canvas document model invariants:** all §2.2 invariants + §6 legacy import +
  §7 archive format verified in `server/documents.ts`/`documentArchive.ts`
  (append-only trigger, staleness respects locks, unknown-version loud refusal
  naming the writer, blob hashes + re-link, tombstones, baked-op immutability,
  consent-stamped asset forks, one-time legacy marker, version-refusing import).
- **Director Suite (Phase 5b):** plan documents on `canvas_plan` with the five gap
  kinds; hard-cut default; FLF splice genuinely executes offline (ffmpeg
  `-sseof -0.15` last-frame extraction `server/core.ts:942-956`, wired
  `store.ts:759-792,1124-1130`); dip-to-black structural ~0.7 s + guided variant
  honestly labeled engine work (`plan.ts:75-90`); diegetic bridge opt-in labeled;
  consent-gated seedSegmentChain writing chain_ref back; submitPlanEpisode
  Motion-Context episode runs; adopt-chronology upgrade — all verified, with the
  gap-menu dB numbers matching the tranche-1 addenda.
- **Phase-4 latent-fork + docks:** Motion-Context latent saving, never-denoised
  continuation folders, honest refusals, `canvas_asset` copy-never-destroy
  projection, consent-gated fork-into-project, audio docks, react-rnd Settings —
  verified.
- **Live-progress mechanism (2hbv2ib):** hubClientId (`server/realtime.ts:331,759`),
  per-prompt `preview_method: 'taesd'` (`server/core.ts:2164-2169`), the
  taeh3 catalog entry with the exact sha/size (`server/fetchCatalog.ts:646-656`),
  both accepted decoder names (`src/lib/modelSelection.ts:22-23`) — the research
  capture's claims are all still true.
- **Fetch-consent Option A + settings-GET Option B** (the 2hbv2ib decisions) —
  merged (PR #9); mechanism documented in the research capture + architecture
  security posture.
- **Krea 2 recipe pins:** grounding 384-768 default 768, ref_boost hard cap 10 /
  UI cap 6 with the >10 removal-break note, ≤2 MP, 384-px reference max edge —
  `src/lib/graph/krea2edit.ts:98-121,369-426` match krea2-edit-mode.md's
  recommendation table exactly.
- **Optimization registry discipline** (insert-only + inertness goldens), sampler
  pins, style embeddings (exactly ten, `src/lib/promptPresets.ts:83-96`), eight
  technique starters (`src/lib/promptCorpus.ts:31-38`), ACE-Step pins (shift 3,
  50 steps, CFG SFT 7 / Base 6 — `src/lib/aceStepWorkflow.ts:41,47`).
- **README quick-start + local-services claims** (verified one-by-one): scripts
  and ports (4178 default, `MINIMAX_LAN_PORT`; vite 5173 → 4178 proxy;
  `~/.minimax-studio` / `MINIMAX_STUDIO_HOME`; token mode), reference caps 9/3/3
  (`src/lib/h3Submit.ts:153-155`), the 15 s segment cap
  (`src/canvas/loraTimeline.ts:31-38`), the fixed-seed diagnostic pair
  (`src/lib/h3Diagnostics.ts:27-55`), graph-family version + testedComfyVersion
  warning (`src/lib/manifest.ts`, `SettingsView.tsx:280-289`), the /free +
  tiled-VAE retry (`src/hooks/useGenerationQueue.ts:165-181`), Civitai
  pinned-host proxy scoped to the H3 base model (`server/core.ts:2992-3010`),
  Music 3 tiled decode + mp3 V0 (`src/lib/music3Workflow.ts`), the LLM layer
  (router-primary/Ollama fallback, family detection, sticky keep-alive,
  unload-before-generation), output presets + crop preview, GPU telemetry +
  cancellation + bounded failure, the official graph topology + model-file
  preference ranking (`src/lib/h3Stack.ts:9-13`), 17k+5 grid conversion,
  exact-filename attribution, LTX two-stage/turbo presets
  (`src/lib/ltx25Workflow.ts`), the ACE-Step five-file table + node names +
  recipe pins, the setup doctor (FFmpeg/HTTPS/device/attention —
  `server/core.ts:1186-1235`), GPU-tier guidance, ComfyUI 8188 default, and the
  model-listing embedding/cloud exclusion (`server/llm/providers/ollama.ts:73-90`).

---

## 7. Fix-now remediations applied in this PR (each with its evidence above)

All are unambiguous STALE-Doc corrections — the newer reality is recorded on the
Flux board and/or git, and the doc simply predates it.

1. **README.md** — S1/S2/S6/R8/G10/G12: the Movie Planner, latent-chaining,
   Clip-Editor-fallback, preset-trio, identity-warning/2048px, manifest-download,
   reference-clipper, Music-3-builder, Z-Image, and LTX-workspace bullets rewritten
   to the current reality (plan documents / Director Suite, canvas quality tiers,
   H3-1F stills intent, canvas ops + audio docks); the license-notice line now
   states the component is unrouted and tracked; a "Surfaces" paragraph added
   (canvas default, `?datasets=1`, `?images=1`, `?mobile=1` companion, Alt+n
   switcher); gate list gains the four missing suites; documentation table gains
   the three specs + the training guide/envelope/doctrines rows.
2. **docs/architecture.md** — S3: dated correction at "Renderer structure" (App.tsx
   and the legacy shell deleted at Phase 5; canvas is the default; views reduced to
   Settings/Diagnostics as docks), the stale layer-table rows fixed (the deleted
   `useCreateWorkspace`/`useGenerationFlows` hooks and the dead "route in App.tsx"
   one-file-change line — now the surface-registry append), the state/persistence
   section corrected (SQLite document store; retired clip-projects/frame-bookmarks
   keys), the "14-view render sweep" line fixed, the API route list gains
   `documents/*` and `datasets/*`, and the verified-date note updated.
3. **docs/ROADMAP.md** — S4: 2hbv2ib / twmpu4m / pq7d48a moved from Building to
   Shipped with PR/commit cites; post-refresh landings added (image workbench,
   QOL wave, image pathway reroute, model overrides, LoRA timeline, structured
   prompt editor, doctrine harvest, pan-stitch research, Fizgig addendum, benchmark
   harness in the gate); camera editor removed from Queued (y93rk61 done);
   refresh date updated.
4. **docs/agent/testing.md** — S5: gate chain gains test:documents, test:canvas,
   test:benchmarks; the benchmark-harness paragraph updated to "landed, in the
   gate" per its own instruction.
5. **docs/audit/security-audit.md** — S7: resolution note corrected — HTTPS with
   fingerprint shipped (eqbx1dq done; `server/index.ts:40-49`).
6. **Spec status lines** — S8/S9/S10: image-workbench-v1.md → BLESSED + BUILT
   (commit cites); structured-prompt-editor.md → implemented (fh94g76, shipped);
   canvas-document-model.md → schema SHIPPED (Phase 0, oiavqh8) with the
   post-spec drift note pointing at Q4.
7. **docs/specs/canvas-ui-v1.md** — S11/S12: leftover DRAFT status block removed;
   one-line note added at the §9 ledger table deferring row statuses to the
   blessing block.
8. **docs/LICENSES.md** — S13: `2hbv2b` → `2hbv2ib`.

## 8. Queued remediations (task-level — posted to the Flux record for the maintainer)

- **Q1** README capabilities polish pass for the canvas era (the surgical fix
  applied here corrected every false claim; a full voice/pass over the section,
  plus the test:all wording, belongs to a docs task).
- **Q2** architecture.md full refresh (renderer structure rewrite beyond the
  dated correction applied here, surface registry, state/persistence section
  incl. the SQLite document store).
- **Q3** Process: ROADMAP refresh as a merge-train step (this staleness recurs by
  construction — three waves landed without it).
- **Q4** canvas-document-model.md dated addendum: schema fields added since §1
  (plan `loraRange`/`loraStack`, migration 004 one-canonical index).
- **Q5** fun-control-input-surface.md addendum: the cited Z-Image path retired
  (34afx79).
- **Q6** Canvas §7/§4 completion or amendment: Space play/pause, ←/→ scrub,
  camera bookmarks, radar GPU meter, index retry/rerun-stale, print J/K + 1-9 on
  affordances (or a dated spec amendment accepting the current subset).
- **Q7** Image-workbench + dataset spec addenda: RefMod-dial rides H8 (say so);
  scorer CLIP-seam wording; code-beyond-spec items (model overrides in submit,
  T=1 I2I auto-switch, conditional sigma shifts, SeedVR2 trims, exit variant,
  tone-lock pins); dataset gate-5 tier word + §13 duplicate paragraph.
- **Q8** AutoContext §8 scoping addendum (remainder → drift-envelope suite 5nfy24y
  or individual tasks).
- **Q9** `DEFAULT_CAPTION_INSTRUCTION` per-family branches: record the owner
  (harness project a1jy64t) on the doctrines doc, or file the Studio-side task.
- **Q10** Re-mount `LicenseNotice` on the canvas first run (G10 — a documented
  KEEP-class legal surface orphaned by the Phase-5 deletion; tiny code fix).
- **Q11** Decide the fate of the unreachable `experimentalSampling` seam
  (re-expose a canvas toggle or retire the seam) and of the orphaned
  Music3Workspace caption-builder module (delete or re-home into the AudioDock).
- (Existing, no new action: eagkso0 anima fragments row.)

---

## Verdict table

| Question | Verdict | Basis |
|---|---|---|
| Does the app follow the docs where the docs are current? | **Yes — zero VIOLATIONS found**; the newest specs conform line-for-line including measured numbers | §6 |
| Are there GLARING issues? | **Yes — six, all doc-lag or reverse-gap**: README pre-Phase-5 capabilities (S1/S2), architecture.md renderer section (S3), ROADMAP 6+ PRs behind (S4), LoRA timeline + model overrides undocumented (R1/R2) | §1, §4 |
| Are documented findings implemented or deferral-tracked? | Mostly; 10 GAPs, of which 2 are board-tracked (eagkso0, harness-project framing) and 8 need tasks or spec amendments | §2 |
| Do docs contradict each other? | Yes — 9 pairs found, all resolved by "newer doc/board wins"; 8 fixed in this PR | §5, §7 |
| Were measured numbers copied correctly into the app? | Yes — every checked number (envelope budget rule, walls, floors, recipe bands, gap-menu dB, krea2 pins, ACE pins, counts of 10/8) matches | §6 |
