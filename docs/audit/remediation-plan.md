# Remediation plan — the three audit punch lists consolidated into the Phase-3 build order

> **Task:** The remediation plan (9o05wyq) · **Epic:** Foundation remediation program (4lphxv8) · **Project:** MINIMAX-DESKTOP (r2lnrfw)
> **Dated:** 2026-09-20, consolidated at main HEAD `7ee1e3c`. File:line anchors are as reported by the audits at that HEAD; the two in-flight branches (§2, "In flight") may have moved code under some anchors by the time a wave dispatches.
> **Sources:** Audit A — UX/IA punch list, comment `uf6ze42` on Audit A — UX/IA punch list (8jeql63); Audit B — generation pipeline + realtime/SSE, comment `cp6m9gu` on Audit B (mlkl83v); Audit C — external parity + node friction, comment `tfl239c` on Audit C (zqorlib); maintainer directive 2987ef3e (registry-only models) + its extension (comment `43gi05j` on Phase 0 removals (z8bc21p)); the epic charter (4lphxv8 notes — the day-one verdict).
> **Status:** DRAFTED — presented for maintainer approval. **No Phase-3 build dispatches until this plan is approved.** Items marked **[REC]** are sequencing or shape judgments this plan applied; the maintainer reorders them at approval. Settled directives (2987ef3e + extension) are implemented as written, never re-litigated.
> **Method:** consolidation only — no new code reading; every finding is carried from its audit record, deduplicated and cross-referenced. Effort bands: **S** ≤ a focused patch (≈ a day), **M** multi-file feature or bounded refactor (days), **L** cross-cutting build or redesign (a week or more).

---

## 1. Executive summary (the approval surface)

The day-one verdict was: *"entering a prompt on startup, selecting the video path, then trying to execute it with a failure… Our solid foundation is not very solid."* Three audits went granular on the three suspected areas. They converge on three root-cause clusters:

1. **The render loop has no feedback.** The app checks the engine once at boot and never again (Audit B P0-1 ≡ Audit C F3 — one root cause); it never checks what a render will need before submitting it (C F2); and when the engine fails, the sanitizer mangles the error into `[redacted]` soup the failure taxonomy cannot classify (C F1). A stuck user — the maintainer, day one — gets no true status, no preflight, and no readable failure. This cluster is **Wave 1**, and it carries a single acceptance bar: the maintainer's exact first-session journey, walked end to end on external mode.
2. **The model-location design fights the engine.** Audit A found four stacked auto-detection failures (empty app-internal defaults, six hand-typed paths, exact-filename regex, basename-vs-subpath double-listing). The maintainer has settled this architecturally (directive 2987ef3e): **the ComfyUI registry is the only source of truth; instance-invisible = nonexistent; the manual-folders complex is removal scope.** That directive is not a finding to weigh — it is Wave 2's core, and it supersedes the parts of Audit A's B3 that proposed patching the path fields (do not build the models-root field).
3. **Surfaces accumulated without an information architecture.** Settings is 17 sections / 15,147 px / 144 controls — every surface the app ever built, stacked (A B1); first-run dumps every decision at once (A B2); external mode closed its *install* parity but not the *notice→decide→confirm* arc (C lane 1). These are **Wave 3** redesigns — sequenced after the removals and registry-only work so nothing redesigns a section that is about to die.

**The wave plan:** Wave 1 unblocks rendering (in-flight fixes + engine re-check loop + preflight + readable failures + the inverse-misroute gate). Wave 2 lands removals + the registry-only inventory (directive implementation). Wave 3 does the redesigns (Settings IA 17→3+exits, first-run wizard, the F6 per-item-consented preflight surface, sidebar/panel declutter). Wave 4 sweeps the P2/minor tail, post-redesign, where several items dissolve.

**In flight right now** (not double-counted by this plan): Critical-path fixes (tmz8vh7) — the T=1 misroute at the family-selection seam + the dock scroll bugs; Phase 0 removals (z8bc21p) — LTX, Z-Image, and original-build cruft out, manifest at `docs/audit/removals-phase0.md`.

**Carried forward whatever is already good** (§4): honest refusals, typed-hole menus, the verified-clean pipeline seams, the closed external parity surface. The audits' keep-lists are binding on every redesign.

**Decision points at approval** (§5): six — the asset-spine keep, Wave-1 rung-2 composition, auto-clearing wedged legacy picks, the inverse-misroute fix shape, external-mode fetch destinations under registry-only, and the revised (post-directive) Settings/wizard target shapes.

**Effort roll-up:** Wave 1 ≈ 6×S + 2×M + one S–M (+ the in-flight M); Wave 2 ≈ L + S + one decision (+ the in-flight L); Wave 3 ≈ 5×S + 4×M + 1×L; Wave 4 ≈ 7×S + 1×M + 4 dissolving (one S optional). Nothing in the plan requires new research beyond what its waves already name.

---

## 2. The consolidated findings register

Severity keeps each audit's own scale (A: BLOCKER/MAJOR/MINOR · B: P0–P2 · C: SEV-1–3), normalized in the Sev column to **P0** (breaks the core journey today) / **P1** (reported bug class, high impact) / **P2** (real defect, bounded blast) / **P3** (polish/minor). Deduplication and supersession notes follow the table.

| ID | Finding | Sev | Sources | Root cause (one line) | Remediation shape | Wave |
|---|---|---|---|---|---|---|
| R-01 | Engine state is a boot-time snapshot — never re-checked; external mode has no liveness | P0 | B-P0-1 ≡ C-F3 (deduped) | `checkConnection` runs only in the boot effect (`useStudioSession.ts:69-74`); the 2.5s poll is managed-only by design; the fabric's engine channel has zero subscribers | REFACTOR: periodic re-check (fast when down, slow when up) + wire fabric engine state into session status; on connected-transition re-pull object_info + inventory; external restart-watch flips pack chips and toasts | 1 |
| R-02 | No preflight: the built graph is never diffed against object_info before submit | P0 | C-F2 | `validateH3Render` (`h3Submit.ts:114-140`) checks upscale/prompt/connection/models — never the base graph's class_types; per-family `detect()` surfaces exist but nothing consults them | PATCH: after graph build, diff class_types vs object_info and refuse with a readable missing list mapped to pack rows (the foundation for R-17) | 1 |
| R-03 | Failed renders are unreadable: the sanitizer mangles engine errors and the taxonomy cannot classify them | P0 | C-F1 | `structuralPromptError` drops `error.type` (`core.ts:194-215`); sanitizer KEYWORDS lack every ComfyUI failure phrase (`logSanitize.ts:39-51`); the taxonomy's node-missing patterns cannot survive sanitization — its own stated contract, unmet | PATCH: surface structured `error.type`/`errors[].type` tokens; add the tokens to KEYWORDS; regression-test `classifyFailure(sanitize(<real shapes>))` lands node-missing; split the advice core-update vs pack-install | 1 |
| R-04 | The T=1 misroute on the video path (the maintainer's exact block) + the dock scroll bugs | P0 | Epic symptom; B's report-answer; **in flight** (tmz8vh7) | Family-selection seam (diagnosis owned by the in-flight task); docks share the react-rnd inline-display class | IN FLIGHT — seam-rooted fix + the failing-without-it test reproducing the maintainer's flow + the scroll fix audited across every dock/panel | 1 |
| R-05 | Inverse misroute: an image-intent chain plus any reference/frame binding silently renders an H3 video | P1 | B-P1-2 | `stillIntent` catches only modes text/image; `add-reference`/`set-first-frame` are unguarded by mediaType (`options.ts:124`, `store.ts:1885-1893`) | Small REFACTOR: refuse honestly at validate/submit with the rule stated **[REC D4]**; gate the binding rows' availability by mediaType | 1 |
| R-06 | A wedged override pick is invisible: the refusal names no layer; a wedged global pick shows an innocent "auto" label | P1 | B-P1-1 (the post-#30 remainder; mechanical half in flight via tmz8vh7) | The panel computes a per-slot verdict only for the chain's own pick (`PropertiesPanel.tsx:751`); the models section is collapsed by default | PATCH: refusal text states the layer (chain / global / migrated legacy); run verdicts on the merged layer in the panel; **[REC D3]** auto-clear a migrated legacy pick that refuses (warn, don't wedge) | 1 |
| R-07 | Sticky SSE demotion disables LLM streaming for the rest of the session | P1 | B-P1-3 | `demotedToSse` is never cleared — no WS re-probe exists; `streamLlm` hard-requires WS (`useRealtime.ts:63,217,332-337`) | PATCH: periodic WS re-probe while demoted (60s / visibilitychange) or an SSE POST uplink for llm generate/abort | 1 **[REC D2, rung 2]** |
| R-08 | Events missed during reconnect are never detected — the seq-gap resync is blind over the reconnect window | P1 | B-P1-4 | `lastSeq` is cleared on WS reopen; subscribe acks only, no snapshot/replay | PATCH: after the reopen-time `lastSeq.clear()`, fire `emitResync` for every subscribed channel (client-side) | 1 **[REC D2, rung 2]** |
| R-09 | The "engine offline" chip is a dead button on the one screen a stuck user looks at | P1 | A-B4 | Status display with no onClick (`Radar.tsx:95-98`; repeated `BottomBar.tsx:127-129`) | PATCH: click opens Settings docked at the engine section (or the wizard); the models-missing degraded state deep-links to the stack/fetch view | 1 **[REC D2, rung 2]** |
| R-10 | Pack fetch completion leaves the pack board stale ("missing" until its own Refresh) | P2 | C-F4 | `onAfterFetch` is wired to the model scan only; `refreshNodePacks` deps exclude fetch completion (`SettingsView.tsx:357`, `:221`) | PATCH: one line — `onAfterFetch` also calls `refreshNodePacks()` | 1 **[REC D2, rung 2]** |
| R-11 | Phase-0 removals: LTX and Z-Image fully out + original-build cruft | P0 | Epic charter; **in flight** (z8bc21p) | Inherited surfaces with no current purpose — git history is the archive | IN FLIGHT — full excision (submit paths, graph families, utilities surfaces, MobileApp + exclusive deps, five asset studios, `lib/zimage.ts`, smoke script) + the removal manifest at `docs/audit/removals-phase0.md` | 2 |
| R-12 | Registry-only model inventory — directive 2987ef3e implemented (supersedes A-B3(a)/(b); absorbs A-B3(c)/(d)) | P0 | Directive 2987ef3e + extension `43gi05j`; A-B3 | Local-scan-first defaults point at app-internal empty dirs (`core.ts:557-578`); six hand-typed paths + `modelRoot` plumbing with no root field; the local/instance merge keys basename vs subpath (`instanceInventory.ts:104-122`) and local basenames feed graphs the engine can't load | REDESIGN (settled, not optional): inventory ONLY from the connected instance (object_info loader enums + `/models` endpoints); a user-requested refresh affordance (ComfyUI `/api/refresh` semantics); **instance-invisible = nonexistent enforced at the resolution seam** — graph population uses exactly the registry-listed subpath; override picks resolve against the registry alone; the scan/merge machinery, local/both source tags, and scan-anchored validation legs become dead code to remove; the inference anchors are re-targeted at registry subpaths and loosened (substring + size-class — A-B3(c) folds here) | 2 |
| R-13 | Weights-fetch destinations are external-instance-blind; an empty root resolves to the server CWD | P2 | C-F5 | `settings.paths[root] ?? join(modelRoot, root)` treats `''` as a value (`fetchCatalog.ts:66-69`) → `resolve('')` = CWD passes the absolute-path guard; no instance-visibility statement in the consent dialog | PATCH the `''`-means-absent guard now (GB-scale fetches can land in the launch directory); REDESIGN the destination statement under registry-only **[REC D5]** — see §5 | 2 |
| R-14 | Asset-spine keep/kill — the product call the removals survey left to this plan | decision | z8bc21p comment `wqoi7sf` | The five `*Library.ts` modules + the canvas asset spine (bind/projection/composer arms/jobRecords write-backs/server `canvas_asset`) are current-architecture Phase-4 surface | **[REC D1]** RATIFY KEEP, as the survey proposed — the natural re-attachment point for future asset authoring; recorded here so the call is made once, by the maintainer | 2 |
| R-15 | Settings IA redesign: 17 sections / 15,147 px / 144 controls → 3 groups + exits | P0 | A-B1 (M1, M2, M3, m2, m4, m6 fold in) | `SettingsView.tsx` is the absorption surface of a year of increments — a catalog store, run tools, mode pickers, reference prose, all appended with nothing gating what belongs | REDESIGN: SETUP (engine, managed engine, input/output, packs + fetchables as a sub-page) / DEFAULTS (generation, LLM router, Ollama) / STATUS & DIAGNOSTICS (stack report, doctor, graph compat, quality test); exits — run tools to canvas typed-hole menus + diagnostics dock, GPU guidance to a help popover, License to About; FetchBrowser promoted to its own "Library / Get models" surface; sticky nav rail + sticky dirty-aware save. **Post-directive revision:** no Model-locations section (R-12 removes the fields); no LTX utilities (R-11) | 3 |
| R-16 | First-run wizard: the cliff becomes four steps | P0 | A-B2 | No onboarding state machine exists; the notice's CTAs scroll-hack ~9,000 px into the 15k document (`FirstRunNotice.tsx:41-54` — the `setTimeout`+`scrollIntoView` is itself evidence the destination doesn't fit) | REDESIGN: (1) engine — external URL with common-port probe (consent-gated) vs managed; (2) models — **post-directive revision:** a registry readout + refresh affordance + stack verdict, not path entry; (3) nodes — the pack board, pre-validated; (4) first prompt. Skippable, resumable, driven by the facts FirstRunNotice already reads; the notice stays as the fallback surface (its latch is keep-listed) | 3 |
| R-17 | The F6 preflight surface at the render attempt — per-item-consented remediation | P1 | C-F6 | The burden sits on prose-reading; every automation piece exists (class→pack map, consent-gated fetcher with auto-install, live chip) but is unassembled at the point of need | REDESIGN: the Wave-1 preflight refusal (R-02) becomes a surface — "This render needs: X — fetch 12 MB (license, consent), Y — install (vendored, no network), Z — already present"; one action per row, per-item consent (the Origin-locked consent gate is verified working); the Settings board becomes the audit/override view | 3 (depends R-02) |
| R-18 | Properties panel: seven always-on sections of expert jargon for every chain, first prompt included | P1 | A-M4 | The panel absorbed CreateView's entire binding model with one `<details>` as disclosure (~60 controls before the fold) | REFACTOR: progressive disclosure — prompt + engine tier visible; references/identity/LoRA-timeline/guides/takes contextual (identity only when a reference exists; the LoRA rail only when >0 LoRAs are installed) | 3 |
| R-19 | "Not installed" is a dead end at the point of choice | P1 | A-M5 | The catalog deep-link machinery exists but is not wired into the family picker; disabled LLM tools point at the 15k document with no button | PATCH: `openFetchBrowser`/fetch-focus in the family picker rows; a "Connect…" action on the disabled LLM tools opening Settings docked at the LLM section | 3 |
| R-20 | Launcher chip sprawl + duplication across three bars | P1 | A-M6 (+ m5 folds in) | Nine launcher chips on empty canvas; three bars repeat the same docks; "noDialogue handoff" is developer-speak | REFACTOR: one canonical home per engine (the typed-hole produce menu lists audio engines); launcher = prompt bar, media-type toggle, drop, library; rename the chip to "no dialogue"; the bottom bar shows queue state only | 3 |
| R-21 | Settings deep-links from other surfaces are full-page navigations that lose context | P2 | A-M7 | SettingsDock is not mounted at the app-shell level; `/?settings=1` replaces the current view | PATCH: shell-level dock mount (the panel is self-contained; session hooks exist per surface) or an on-surface modal | 3 |
| R-22 | Typed-hole menus: good bones, mixed vocabulary, dead-end footers | P2 | A-M8 | Hints leak engine internals ("17n+5 grid"); rows name storage substrates ("latents on disk"); the footer teaches instead of enforcing | PATCH: humanize hints ("~6.6 s clip · HD"); outcome-named rows ("continue from this take (no re-encode)"); gate the consume menu on a selected source | 3 |
| R-23 | The video-path rule is never explained at choice time | P2 | A-M9 | `effectiveMode` is derived and labeled but the rule (bind a picture → reference mode) is stated nowhere | PATCH: one hint line under the panel's mode chip; the launcher chips state their effect | 3 |
| R-24 | Default `comfyUrl` 8188 is a silent convention (and this box's off-limits port) | P3 | C-F10 | Default points at the canonical ComfyUI port with no prompt | PATCH: folds into the wizard's engine step (R-16); reconsider the shipped default | 3 |
| R-25 | chainJobs link clobber during upload — the queued ring detaches | P2 | B-P2-1 | `recomputeTiles` rebuilds links oldest→newest from manifests; a just-submitted job carries none until the running transition, so an older job overwrites its link for the upload window | PATCH: a manifest link cannot displace a newer non-terminal job's link | 4 |
| R-26 | Dead-engine jobs spin "running" for up to 60 minutes | P2 | B-P2-2 | `RUNNING_DEADLINE_MS = 60min`; poll failures swallowed; the sweep only fails past-deadline jobs (compounds R-01) | PATCH: a consecutive-poll-failure streak marks the job honestly "engine unreachable" long before an hour (largely mitigated once R-01 lands; the sweep remains) | 4 |
| R-27 | SSE reopen churn on preview registration | P2 | B-P2-3 | Every `onPreviewFrame` registration while on SSE reopens the EventSource even when the channel set didn't change | PATCH: reopen only when `sseChannels()` actually changed | 4 |
| R-28 | `submitPrompt`'s `pending:` chainId fallback creates tiles for nonexistent chains | P2 | B-P2-4 | `pending:<n>` is minted when `createChain` returns falsy without throwing | PATCH: fail honestly at creation | 4 |
| R-29 | Doctor + H3 stack report never check node classes | P3 | C-F7 | Both check files/system only; an instance a version behind passes everything and fails only at render (through R-03) | PATCH: add the family's core-node check to both (object_info is already fetched there) | 4 |
| R-30 | `/engine/status` speaks managed-runtime language in external mode | P3 | C-F8 | `state:'stopped'` is a non-concept externally; consumers are misled | PATCH: per-mode shape or documented per-mode fields | 4 |
| R-31 | External health card is thin while honest equivalents are reachable | P3 | C-F9 | No stdout to tail (inherent) — but latency, version, queue depth via system_stats/queue are already reachable | REFACTOR (low): the honest external readout | 4 |
| R-32 | Pack-board version vocabulary is accurate but dense | P3 | C-F11 | Seven version states per row before any grouping | POLISH: group rows by feature before version state (likely dissolves into R-15/R-17) | 4 |
| R-33 | Node-packs section: 7,857 chars of policy prose in small print | P3 | A-m1 | Policy prose embedded in the settings scroll | PATCH → dissolves into R-15/R-17 (a "how installs work" popover) | 4 |
| R-34 | FirstRunNotice wall of text (implementation detail addressed to a pre-model user) | P3 | A-m3 | Five lines of yaml/blob-path detail at the wrong moment | Dissolves into R-16 (two sentences + two buttons) | 4 |
| R-35 | Settings heading undersells the page | P3 | A-m4 | Copy matches neither the IA nor the content | Dissolves into R-15 | 4 |
| R-36 | Queue-status events are normalized but unconsumed; terminal events only touch the progress label | P3 | B notes | `queue_status` has no client handler (queue position never shown); completion rides the 1s poll | PATCH (optional): surface queue position; let terminal events update tile state | 4 |

### Deduplication and supersession notes (what the table folded, and why)

- **B-P0-1 ≡ C-F3** — one root cause (boot-only connection checks), one item (R-01). Audit B contributes the managed-mode symptoms (stale-flag poll gating, spin-then-raw-fail); Audit C contributes the external-mode restart dance. Both remediations are the same loop.
- **A-B3(a) and A-B3(b) are SUPERSEDED by directive 2987ef3e.** Audit A proposed an editable models-root field deriving the six paths; the directive removes the fields instead — registry-only, no manual pointing. Nobody builds the root-derivation field.
- **A-B3(c)** (exact-filename regex) folds into R-12: the inference ladder re-targets registry subpaths and its anchors are loosened there — the escape-hatch surfacing half lives in R-18/R-19.
- **A-B3(d)** (basename-vs-subpath double-listing) folds into R-12: the merge machinery dies outright, and "instance-invisible = nonexistent at the resolution seam" is precisely the loader-naming fix — graphs receive exactly the registry-listed subpath or the model is not used.
- **B-P1-1 splits:** the mechanical misroute/migration half is in flight (tmz8vh7, building on PR #30's VAE-slot split); the surviving wedge — no layer attribution, no panel verdict on merged layers — is R-06.
- **A-M3 splits:** the LTX-utilities exit is moot (R-11 removes them); the H3-quality-test and Krea-2 exits fold into R-15.
- **B's "legacy fabric" note** (MobileApp consuming `/api/lan/events`, two fabrics running concurrently) is subsumed by R-11 — the MobileApp removal retires the second consumer.
- **A-m2, m4, m6** fold into R-15; **A-m5** folds into R-20; **A-m7** (PathCheckNote) is a keep-list pattern, not a defect (§4).
- **C-F7** builds on R-02's class map (same object_info source, applied to diagnostics).
- **C-F5's refactor half** interacts with R-12 (see D5, §5): under registry-only, a fetch destination that the instance cannot see is a bug by definition.

### In flight (marked, not double-counted)

- **Critical-path fixes (tmz8vh7)** — R-04. The plan's Wave 1 verifies its landing as part of the acceptance bar; the family-selection seam diagnosis is that task's deliverable.
- **Phase 0 removals (z8bc21p)** — R-11, plus the directive extension (`43gi05j`) that puts the whole manual-folders complex in removal scope. The removal manifest (`docs/audit/removals-phase0.md`) is the restore map.

---

## 3. The wave plan

### Wave 1 — unblock rendering (the critical path to "a person sits down and renders")

**Rung 1 — the acceptance-bar items:** R-01, R-02, R-03, R-04 (in flight), R-05, R-06.

**The single acceptance bar — the maintainer's exact first-session journey, walked end to end on external mode:**

1. Fresh home, external mode, engine **not** running: the app says engine offline truthfully, and the chip is a live control (R-01/R-09).
2. Start the engine: the app notices **by itself** within the re-check interval — status flips, object_info + inventory re-pulled, pack chips go live. No manual "Test connection", no restart dance (R-01).
3. Enter a prompt at startup, select the video path, execute: it submits a **video graph** — never a T=1/image family (R-04, proven by the in-flight task's failing-without-it test).
4. If something is missing, the submit is refused **before** the engine with a readable list mapped to actions (R-02) — and if the engine itself fails, the error comes back classified, unmangled, with per-cause advice (R-03). `[redacted]` never reaches a user.
5. Kill the engine mid-session: tiles fail honestly in seconds-to-minutes with an actionable state — not a 60-minute spin (R-01; the R-26 sweep backstop lands in Wave 4).
6. The render completes and lands on the canvas (takes visible) — the verified-clean landing seams (§4) carry it.

Engine-dependent verification uses the 8189 testbed per the runbook, or Audit C's fake-engine harness (scratch port, isolated `MINIMAX_STUDIO_HOME`, PID/port ledger, teardown verified). **Never 8188.**

| Item | Effort | Depends on | Verify shape |
|---|---|---|---|
| R-01 engine re-check loop | M | — | Unit: mocked engine states across boot/transition/loss. Live walk: boot-before-engine → submit works with no manual refresh; kill-mid-job → honest failure. The stale-flag poll-gating symptom (B-P0-1c) has a regression test |
| R-02 preflight before submit | M | R-01 shares the object_info cache, not the code | Failing-test-first: build a family graph against object_info missing a class → refusal names the class and its pack; fake-engine e2e — dead end #1 from Audit C's walk is gone |
| R-03 sanitizer/taxonomy fix | S | — | The audit's named test: `classifyFailure(sanitizeErrorMessage(<real ComfyUI error shapes>))` lands node-missing; the empirical `[redacted]` body from Audit C becomes a fixture |
| R-04 (in flight) | M | — | Owned by Critical-path fixes (tmz8vh7): failing-without-it test reproducing the exact flow + every-dock scroll audit |
| R-05 inverse-misroute gate | S–M | — | Failing test reproducing the 3-click repro (image seed → add-reference) asserting an honest refusal **[REC D4]**; availability gating asserted in the options suite |
| R-06 override-wedge visibility | S | R-04's seam clarity | Unit: refusal text names the layer; panel shows a verdict for a wedged global pick; the wedge-clear journey walked |
| R-07 SSE demotion recovery **[REC D2]** | S | — | Unit: demote → re-probe → streaming restored; live restart-during-boot walk |
| R-08 reconnect resync **[REC D2]** | S | — | Unit: reopen fires `emitResync` for every subscribed channel; a drop during reconnect heals |
| R-09 live offline chip **[REC D2]** | S | R-01 makes it truthful | Walked: offline click lands docked at the engine section |
| R-10 fetch-refresh one-liner **[REC D2]** | S | — | Fetch a pack → the chip flips without manual Refresh |

**Wave-exit criteria:** the acceptance bar passes end to end (walked, evidence recorded), the named regression tests are in `tests/*.test.js`, both CI legs green.

### Wave 2 — removals + registry-only

The settled architecture lands here. Nothing in this wave is a finding to weigh — directive 2987ef3e and its extension are the design.

| Item | Effort | Depends on | Verify shape |
|---|---|---|---|
| R-11 Phase-0 removals (in flight) | L | — | Owned by Phase 0 removals (z8bc21p): gate + e2e + vision re-capture + both legs + the manifest with restore paths |
| R-12 registry-only inventory | L | R-11 lands first (the manual-folders removal cascade is one motion) | Resolution-seam unit tests: **no graph ever references a model absent from the instance registry** — the R-12 invariant; inventory built purely from object_info enums + `/models` endpoints against a fake engine; external-mode e2e with empty local roots (Audit C's harness); the local-scan suites and merge machinery deleted with the code (tests die with what they tested — listed in the commit); UI tree contains no path fields |
| R-13 fetch-destination guard + statement | S (+design) | R-12 for the statement half | Pure-function probe test (empty root ≠ CWD — Audit C's exact probe becomes the test); consent copy states instance-visibility **[REC D5]** |
| R-14 asset-spine ratification | decision | — | Maintainer's call at approval (D1); no build |

**Wave-exit criteria:** the instance registry is the app's only model source; the manual-folders complex is gone from the user surface and the codebase; the removal manifest and the registry-only invariant tests are the record.

### Wave 3 — the redesigns

Sequenced strictly after R-11/R-12 so no redesign bakes in a dying section.

| Item | Effort | Depends on | Verify shape |
|---|---|---|---|
| R-15 Settings IA | L | R-11, R-12 | Vision capture + judge on the new Settings; the measured baseline is the contract: docked settings fits its groups on screen (from 15,147 px / 144 controls / 17 sections to the 3-group shape); sticky dirty-aware save verified by walk |
| R-16 first-run wizard | M | R-12 (step 2's shape), R-15 (visual language) | Fresh-home e2e/vision scenario: boot → wizard → connected + verified models → first prompt renders; skip and resume paths walked |
| R-17 F6 preflight surface | M | R-02 (machinery), R-12 (registry truth) | Fake-engine e2e: first render attempt lists needed items with per-row consented fetch/install; the Origin-consent gate exercised (403 without / 200 with — already verified); one remediation action completes the loop to a successful re-render |
| R-18 properties-panel disclosure | M | — | Vision: prompt + tier visible, ~60-controls-before-fold gone; sections contextual (no LoRA rail at zero LoRAs; no identity section without a reference) |
| R-19 choice-point dead ends | S | R-15's Library surface for full value (the deep-link machinery exists today) | Walked: family picker offers the fetch affordance; disabled LLM tools get a Connect action landing at the LLM section |
| R-20 launcher/bar consolidation | M | — | Vision: chip count and single-prompt-surface checks; "no dialogue" copy |
| R-21 shell-level settings dock | S | R-15 (mount point settles) | From the datasets surface, Settings opens without replacing it |
| R-22 menu vocabulary + consume gating | S | — | Copy review + gated consume menu verified by walk |
| R-23 mode-rule hints | S | — | Hint line present under the mode chip; launcher chips state their effect |
| R-24 default-port + connect prompt | S | R-16 | Wizard presents the connect step; the shipped default reconsidered |

### Wave 4 — the P2/minor tail (post-redesign; several dissolve)

R-25, R-26, R-27, R-28 (Audit B's P2s — each S, each a failing-test-first unit fix); R-29, R-30 (S); R-31 (M, low); R-32, R-33, R-34, R-35 (expected to dissolve into R-15/R-16/R-17 — re-triage after Wave 3, delete what dissolved); R-36 (optional observability polish). **Wave-entry criterion:** Wave 3's redesigns have landed, so the dissolutions can be counted honestly rather than guessed.

---

## 4. The keep-list (binding on every redesign)

**From Audit A:**
- **Honest refusals at the submission point** — the toast + validation pair (offline engine, missing models, refused overrides with reasons) works and was verified live. Every redesign keeps refusal-with-reason as the interaction of record; Waves 1–3 only make the reasons readable and actionable.
- **Typed-hole produce/consume menus** — availability-gated rows with install guidance and fetch deep-links: "the best information scent in the app." R-15/R-17 route more of the app toward this pattern, never away from it.
- **FirstRunNotice's latch** — dismiss-once-per-browser, never-flash-before-scan. The wizard (R-16) absorbs the journey; the notice stays as the honest fallback surface.
- **The PathCheckNote pattern** (A-m7) — inline, debounced, honest, saves-anyway. Generalize it to every future settings field (engine URL first).

**From Audit B (verified-clean — recorded so nothing is re-litigated):**
- The F6 clientId pin (server-enforced, page-supplied ids ignored); the inference ladders' T=1 cross-pick guards; the h3img builder's honest refusals and post-build graph audits; jobReducer terminal guards; the sanitized/taxonomized error **mechanism** (R-03 fixes the content, not the design); landing honesty on both branches with bounded retries; the audio cores' canvas-link-at-creation; the empty-jobs persist guard class; the routing-predicate enumeration itself (the two live divergence holes are R-05/R-06, not the ladder).

**From Audit C (at parity — do not redo):**
- External-dir install/uninstall with foreign-refusal; the live instance chip; the consent gate + auto-install-after-fetch; the `/engine/start` refusal copy; the patch tier's managed-scoping with graceful degradation; doctor engine-agnosticism.

**One honest supersession:** Audit A praised the recursive, symlink-aware local scan core and the instance-inventory preference order as keep-list foundations. The directive removes the local scan — that praise is recorded, and overridden: what survives of it is the *preference order principle* (instance rows are the truth), which R-12 makes the whole inventory rather than the winning half of a merge.

---

## 5. Decision points at approval

Where the audits disagreed with each other, with the directives, or left a product call open — this plan applied judgment. The maintainer reorders or overrules here:

- **D1 [REC] — asset spine: RATIFY KEEP (R-14).** The removals survey proposed keeping the five `*Library.ts` modules + canvas asset spine as the Phase-4 re-attachment point; killing them is a product call that belongs to this approval, not to an agent.
- **D2 [REC] — Wave-1 rung 2 composition (R-07–R-10).** The acceptance bar is rung 1 only. R-07/R-08 (SSE demotion, reconnect resync) are P1s but not on the render critical path — the maintainer's verdict named SSE explicitly and both are S, so this plan schedules them immediately after the bar inside Wave 1 rather than burying them in the tail. R-09/R-10 are S-polish pulled forward for stuck-user value. Overrule freely: they are independent.
- **D3 [REC] — auto-clear migrated legacy picks (R-06).** Audit B proposed "consider auto-clearing a migrated legacy pick that refuses (warn, don't wedge)". Recommendation: yes — a pick the user never made consciously, refusing every render, should clear itself with a warning; a conscious chain-level pick should not.
- **D4 [REC] — inverse-misroute fix shape (R-05).** Refuse honestly now (S, kills the silent wrong-output class); routing image+reference to the workbench compose family is a product feature, deferred — say the word and it becomes a Wave-3 item instead.
- **D5 [REC] — external-mode fetch destinations under registry-only (R-13).** Once instance-invisible = nonexistent, fetching weights an external instance cannot see is pointless-by-definition. Recommendation: the fetch surface states destination visibility; when not provably instance-visible, external mode offers download-with-placement-guidance instead of a silent local landing. The `''`-root CWD guard lands regardless (it is a data-loss-adjacent bug today in managed mode).
- **D6 [REC] — the revised redesign targets (R-15/R-16).** Audit A's B1/B2 shapes predate the directive; this plan revises both (no Model-locations group or path entry — registry readout instead). Blessing the *revised* shapes is the approval act; the originals are superseded and should not be built.

---

*Consolidation record: this document adds no findings beyond its three sources and invents no severity — every row traces to an audit comment or a maintainer directive. Phase-3 tasks should be cut wave-by-wave from this register, each carrying its verify shape as an acceptance criterion.*
