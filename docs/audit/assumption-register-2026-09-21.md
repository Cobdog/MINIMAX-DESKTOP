# The load-bearing assumption register — ratify-and-verify pass 1

> **Provenance.** Commissioned by maintainer directive `6a857386` (epic 4lphxv8, 2026-09-21): *"ratify and verify critical assumptions we have made in other documentation. Not EVERYTHING, but things that if we get wrong will force us to pivot on the fly or lead to surprises."* Sparked by the YuE2 agent self-catching a wrong "Music 3 is API-only" claim. This file is pass 1 and the TEMPLATE the recurring spot-checks update (recurrence: after major research landings, before spec rounds, on any self-caught wrong claim).
> **Method.** Every row verified against primary sources 2026-09-21: in-repo code reads (read-only), the canonical shared install `/home/agent/comfyui` (v0.34.0 @ `a87667f` — read-only, nothing run), upstream ComfyUI tags + master via raw.githubusercontent + the GitHub API, the HF model API, the npm registry, and web search for the two platform facts. No GPU, no engine boots, no installs. Verdicts: **VERIFIED** (evidence cited) · **CORRECTED** (dated addendum patched into the source doc — never silent replacement) · **UNVERIFIABLE-NOW** (the cheap settling test named).
> **Scope discipline.** Pivot-forcing tier only. Sweep sources: `docs/audit/remediation-plan.md` (§1–§6), `docs/devdocs/` (MANIFEST + both captures + divergence sections), the 2026-09-20/21 research assessments (qwen-image-2.1, h3-image-studio-pack, node-pack-registry, ui-systems-design-language, shibui-fonts-icons, crossview-warp, yue2-3b), the epic directive facts, `docs/ROADMAP.md` + `docs/LEARNINGS.md`.

---

## 0. Headline

**24 rows: 3 CORRECTED (2 patched in-pass), 18 VERIFIED, 3 UNVERIFIABLE-NOW.** The trigger item (Music 3 API-only) was already self-corrected in the YuE2 doc and verifies as correct. The real cluster this pass found is **version-pin drift**: upstream tagged three releases in 15 days (v0.35.0 Sep 9, v0.36.0 Sep 15, **v0.37.0 today**), and two of our newest family gates quote wrong or stale minimums (CORRECTED rows 2–3). The good news: every captured engine-contract semantic was re-verified UNCHANGED from v0.34.0 through master — the app's integration surface is stable; only the node-inventory surface (which families exist where) moved. Policy recommendation in §2.

| # | The assumption | Verdict |
|---|---|---|
| 1 | Music 3 delivery = open weights, local, API closed to new users | **VERIFIED** (the self-correction holds) |
| 2 | YuE2 native nodes require "ComfyUI ≥ v0.35.0" (docs.comfy.org, quoted into our assessment) | **CORRECTED** — nodes first ship **v0.36.0**; `cfg_scale` needs v0.37.0+ |
| 3 | Qwen-Image-2.1 native nodes "require master/nightly or the next tagged release" | **CORRECTED** — that release exists now: **v0.37.0** (tagged 2026-09-21) |

---

## 1. The register

### A. Version-pin drift (the cluster this pass exists to catch)

| ID | Assumption (as currently recorded) | Verdict | Evidence (all fetched 2026-09-21) | Decision it shapes |
|---|---|---|---|---|
| A-1 | Our engine reference + schema fixtures pin v0.34.0 (`a87667f`); upstream releases v0.35.0 (Sep 9), v0.36.0 (Sep 15), v0.37.0 (Sep 21 — today); master pyproject = 0.37.0 | **VERIFIED** — the drift itself is real and faster than the capture cadence assumed | `pyproject.toml`/`comfyui_version.py` at master = 0.37.0; tag dates via github.com/releases; shared install `cat comfyui_version.py` = 0.34.0 + `git log -1` = `a87667f` | The re-capture policy (§2) and every "instance bump" precondition in the new-family tasks |
| A-2 | Captured API semantics hold at master (maintainer's runtime), not just at the 0.34.0 pin — checked: no `/refresh` route; `/object_info/{node}` unknown → `200 {}`; terminal events = `execution_success`/`_error`/`_interrupted` (no null-node `executing`); typed-scalar min/max validation (`value_smaller_than_min`); `MAXIMUM_HISTORY_SIZE` eviction; tqdm `progress` hijack in `main.py`; WS first-message feature negotiation; `/experiment/models`; `/api/jobs` | **VERIFIED — UNCHANGED 0.34.0 → master on every checked surface** | Shared-install greps + master raw fetches of `server.py`, `execution.py`, `main.py`, `app/model_manager.py` (e.g. master `execution.py:824` `execution_success`; master route list has no `/refresh`; `MAXIMUM_HISTORY_SIZE = 10000` at `execution.py:1291`) | The app's integration floor can stay "≥0.34.0 semantics" with confidence; no forced app-side change from upstream motion |
| A-3 | YuE2 native nodes require "v0.35.0+" (docs.comfy.org, quoted in `yue2-3b-assessment.md` §4) | **CORRECTED** — `comfy_extras/nodes_yue2.py` is **absent from v0.35.0, v0.35.1, v0.35.2** (raw fetch 404; zero YuE classes anywhere at those tags — the only "yue" hit is the Cantonese language code in `nodes_ace.py`) and **first ships in v0.36.0**; the `cfg_scale` input exists only at v0.37.0/master (commit #16373, 09-17, post-v0.36.0-tag) | Raw file checks per tag + class grep; docs.comfy.org states "v0.35.0 or later is required" — the site is wrong against its own tags, and we inherited the number | The audio-adoption instance-bump precondition: bumping to "v0.35.0 as documented" would still 404 YuE2. Patched as a dated addendum in `docs/devdocs/comfyui-api/index.md`; the YuE2 doc is owned in-flight — coordinator relays to the audio agent |
| A-4 | Qwen-Image-2.1 native nodes "not in the v0.36.0 tag; requires master/nightly or the next tagged release" (`qwen-image-2.1-assessment.md` §3, written release-day) | **CORRECTED (stale by one release, in the predicted direction)** — **v0.37.0 (2026-09-21) is the first tagged release carrying `QwenImage21`** (6 occurrences in v0.37.0 `nodes_qwen.py`; zero in v0.35.x/v0.36.0). The doc's own revisit trigger ("first tagged ComfyUI release carrying #16400") has fired | Per-tag raw fetches of `comfy_extras/nodes_qwen.py` | Family-registry timing for the Workbench's qwen-edit lane; one instance bump to v0.37.0+ now unblocks BOTH new families. Dated addendum patched into the assessment |
| A-5 | The maintainer's own instance (8188, off-limits) runs latest master — i.e. ≈ v0.37.0 today — while the shared install + testbed base sit at v0.34.0 | **UNVERIFIABLE-NOW (by policy — 8188 is never probed)**; recorded as the standing reason captures pinned at 0.34.0 may under-describe the maintainer's runtime | Project CLAUDE.md states the instance runs latest master; cheap settling test: ask the maintainer, or read their launcher log with permission | The app must keep probing rather than assuming (the registry-only + object_info-probe design already does); the shared-install bump decision (§2) |

### B. The trigger item — Music 3 delivery

| ID | Assumption | Verdict | Evidence | Decision it shapes |
|---|---|---|---|---|
| B-1 | Music 3 = **open weights, generated locally** (the YuE2 doc's Part II §8 correction of the inherited "API-only" label) | **VERIFIED** — HF `MiniMaxAI/MiniMax-Music3`: ungated, repo created 2026-08-07, LICENSE file = "MiniMax Music3 COMMUNITY LICENSE" (12.2k downloads); stock core nodes `MiniMaxMusic3TextEncode` + `EmptyMiniMaxMusic3LatentAudio` exist at the shared install 0.34.0 (`comfy_extras/nodes_minimax_music.py:10,44`) AND unchanged at master; our dock builds locally (`src/lib/music3Workflow.ts`: UNETLoader → TextEncode → KSampler → tiled VAE decode) | HF model API + raw LICENSE head, 2026-09-21; shared-install + master code reads | The paused-audio-lane rebalance (music3 stays a fallback-ladder rung, zero new integration debt) |
| B-2 | MiniMax's paid music API closed to new users 2026-08-20 (open weights = the only forward lane) | **VERIFIED** | Platform docs via search (secondary corroboration: [minimax-ai.chat](https://minimax-ai.chat) citing platform.minimax.io, "August 20, 2026: paid Music Generation and Lyrics Generation APIs are no longer available to new users") | Whether any music3 "API mode" is ever worth building — no |
| B-3 | No OTHER doc embeds the wrong "API-only" characterization | **VERIFIED** — repo-wide grep: the only "API-only" hit is fal's H3 Max (a different model, correctly labeled); `ecosystem-2026-09.md` lane 5 already says "open weights, Aug 13 2026" | grep -rn over docs/, 2026-09-21 | None — the wrong claim lived only in the YuE2 first draft and is already corrected there |

### C. Engine-contract facts (the devdocs captures — re-verified at both revisions)

| ID | Assumption | Verdict | Evidence | Decision it shapes |
|---|---|---|---|---|
| C-1 | No `/refresh` route at the pinned revision (capture addendum 2026-09-20); the studio's Refresh = best-effort POST + mandatory re-fetch | **VERIFIED** at 0.34.0 (grep of `server.py`/`main.py`/`app/`/`api_server/` — zero route hits) **and still at master** (master route list re-enumerated: no `/refresh`) | Shared-install grep + master `server.py` route enumeration, 2026-09-21 | R-12's refresh affordance stays as built; the best-effort POST starts doing real work for free if upstream ever ships the route |
| C-2 | `/object_info/{node}` unknown node → HTTP 200 `{}`; absence = key-miss, never status | **VERIFIED** at 0.34.0 (`server.py:813-819`) and master (`server.py:816-817`, same handler body) | Code reads both revisions | A-8 incremental pulls + the F6 preflight diff (live in Wave 1/2) |
| C-3 | Terminal-signal contract: completion is `execution_success` (never a null-node `executing`) | **VERIFIED** at 0.34.0 (`execution.py:824`) and master (`execution.py:824`) | Code reads both revisions | `realtime.ts` job-done derivation — contract-correct, stays |
| C-4 | H3 still-image `length` floor is server-side, twice (schema min at validation + `align_frame_count(max(5,·))` grid-snap at execution) — T=1 impossible on stock nodes; tiers 9/13 snap to 22 | **VERIFIED** at 0.34.0 (`execution.py` `value_smaller_than_min`; `nodes_minimax_h3.py` `temporal_shape`) **and UNCHANGED at master** (same lines fetched 2026-09-21) | Code reads both revisions; also enforced in CI by the engine-contract real-schema gate (PR #39) | The `h3img.generate.t1` family's known-broken-against-stock status; the Image-Studio adoption task (`afvlbk4`) or first-party port remains the only fix; packet-tier 9/13 repricing |
| C-5 | ComfyUI-Manager absent on the shared install (pip pin `4.2.2` present, package not installed, no `--enable-manager`) — presence must be probed | **VERIFIED** — `manager_requirements.txt` = `comfyui_manager==4.2.2`; site-packages contains `comfyui_embedded_docs`/`comfyui_frontend_package`/`comfyui_workflow_templates` but **no `comfyui_manager`** | Shared-install reads, 2026-09-21 | The Manager-first install build (still pending, registry doc correction #3) will probe "absent" there and fall back to our fetcher |
| C-6 | Manager 4.3 (tag 2026-09-18) remains undiffed — the capture's verify-on trigger | **UNVERIFIABLE-NOW** (GitHub API rate-limited late in this pass; not load-bearing until the Manager-first build) — cheap settling test: read `comfyui_manager/glob/manager_server.py` at tag 4.3 and diff the route table + `QueueTaskItem` vs the capture §1 (~30 min, no engine) | — | Whether the Wave-2-style Manager-first recipe needs adjusting before that build |

### D. H3 image lane + node-pack registry

| ID | Assumption | Verdict | Evidence | Decision it shapes |
|---|---|---|---|---|
| D-1 | GAP-1: `workflow.ts` emits Motion-Context classes (`MiniMaxH3MotionContext{,LoadLatent,SaveLatent,Trim}`) with no `ENGINE_NODE_PACKS` row | **VERIFIED — still open** — `src/lib/workflow.ts:241-286` emits exactly those four; the 9 registry rows contain no motion-context entry | In-repo reads at main `51b5326` | The two missing rows (registry doc correction #1) — detection/preflight still falls through for the chain lane |
| D-2 | GAP-2: `upscale.ts` emits LBH upscaler classes (`MinimaxH3LatentUpscalerNode2D/3D`) with no row, no pin, no provenance | **VERIFIED — still open** — `src/lib/graph/upscale.ts:10-34`; absent from the registry | Same | Same — plus the origin-repo pin the registry doc asks for |
| D-3 | `ENGINE_NODE_PACKS` = 9 rows (the registry doc's "current code truth") | **VERIFIED** — vdn-h3, lora-form-adapter, minimax-h3-turbo, h3-hybrid-loader, krea2-controlnet, h3-audio-t8, krea2edit, krea2-anypaint, autocontext | `src/lib/nodePackRegistry.ts:41-159` | The A-3 family-registry join (§8 of the registry doc) |
| D-4 | Klein lane BROKEN-UNTIL-FIXED at validation (CFGGuider misnamed inputs; `ImageScaleToTotalPixels` wants `resolution_steps`) | **VERIFIED — still unfixed** — `src/lib/graph/h3image.ts:969` still emits `conditioning`/`conditioning_1` on CFGGuider (engine wants `positive`/`negative`); the two divergences are ledgered in `src/lib/engineSemantics.ts:167-182` | In-repo reads | The klein refine lane remains un-runnable on a real engine until the fix task lands; do not schedule klein A/B benchmarks before it |
| D-5 | Kreatine supersession claims (license-clean `control_loader`, byte-vendored anypaint pair, notices kept) | **VERIFIED at file level** — `nodes/control_loader.py`, `core/anypaint.py`, `THIRD_PARTY_NOTICES.md`, `ARCHITECTURE.md` all present at `Kreatine/vendor/ComfyUI-Kreatine` | Directory reads, 2026-09-21. The behavioral claim ("loads the same weights") settles in the Krea lane's own test — UNVERIFIABLE-NOW, cheap test = the TS-1/registry-row testbed task | The CUT list (facok controlnet, ostris-edit, standalone anypaint) — holds as proposed |
| D-6 | astropuzzo Image Studio v23.0.0 (`47dea30`, 2026-09-12) is still latest; Unlicense | **VERIFIED** — GitHub releases/latest = v23.0.0, published 2026-09-12 | GitHub API, 2026-09-21 | The adoption task's pin stays valid |
| D-7 | The pack's "ComfyUI ≥0.30" floor vs our shared install 0.34.0 ✓ | **VERIFIED** (0.34.0 > 0.30; install version read directly) | `comfyui_version.py` | No blocker on the adoption path |

### E. UI toolbox (the ui-systems + fonts/icons captures)

| ID | Assumption | Verdict | Evidence | Decision it shapes |
|---|---|---|---|---|
| E-1 | `@base-ui/react` 1.8.0 installed = latest; exports ~50 component modules; only 2 used | **VERIFIED** — installed 1.8.0; npm latest 1.8.0; 49 module dirs in `node_modules/@base-ui/react/` | npm registry + node_modules listing, 2026-09-21 | The wave-3 wrapper-layer expansion (migration step 1) |
| E-2 | lucide-react 0.468.0 installed, 1.47.0 latest; bump pending with 8-name canonical sweep | **VERIFIED** — npm latest 1.47.0; installed 0.468.0 | npm + package.json | The cheap chore stands; nothing changed upstream since the pass |
| E-3 | dockview-react 8.3.1 latest (the DA-5 rack answer); react-rnd 10.5.3 installed-matches; neither dockview/tanstack-virtual/YARL installed yet (correctly — "no shelf-ware deps") | **VERIFIED** — npm latest 8.3.1; package.json has only base-ui/lucide/react-rnd of the interactive set | npm + package.json | Control Center spec can rely on dockview 8.3.x features (pinned tabs, floating groups, popouts) |
| E-4 | @dnd-kit/core "npm last published 2024-12-05 despite repo activity" (the staleness datum behind its rejection) | **VERIFIED exactly** — npm latest 6.3.1, published 2024-12-05, no newer version exists | npm registry time index | The rejection stands; re-trigger (Workbench cross-surface drag) unchanged |

### F. Licenses (the load-bearing surprises, re-verified)

| ID | Assumption | Verdict | Evidence | Decision it shapes |
|---|---|---|---|---|
| F-1 | YuE2-3B weights = **CC-BY-NC-4.0**, ungated (breaks the m-a-p Apache lineage) | **VERIFIED** — HF API tag `license:cc-by-nc-4.0`, `gated: False` | HF model API, 2026-09-21 | The family row's non-commercial verdict; catalog consent posture |
| F-2 | Qwen-Image-2.1 = **Qwen Research License** (`license: other`, non-commercial), not Apache-2.0 | **VERIFIED** — HF API `license: other` (the full text was read in the assessment; license_name `qwen-research`) | HF model API, 2026-09-21 | The ADOPT verdict's gate; fetch-catalog license verdict rows |
| F-3 | Comfy-Org ships official int8-convrot DiT + TE (+W4A8) day-one for Qwen 2.1 (our quant class) | **VERIFIED** — file list: `qwen_image_2.1_int8_convrot.safetensors`, `qwen3vl_8b_int8_convrot.safetensors`, `qwen3vl_8b_w4a8.safetensors`, bf16 VAE | HF API siblings, 2026-09-21 | The ~17.3 GB resident-on-24GB plan for the family |
| F-4 | Music 3 = MiniMax Community License (commercial under $20M/yr) | **VERIFIED** — LICENSE file head "MiniMax Music3 COMMUNITY LICENSE" (HF tag unset — the file is the truth, not the tag) | Raw LICENSE fetch | music3 as the commercial-safe rung of the audio ladder |

### G. Remediation-plan §6 + direction-audit anchors (post-Wave-1/2 spot-check)

| ID | Assumption | Verdict | Evidence | Decision it shapes |
|---|---|---|---|---|
| G-1 | Job landing is still client-side today (A-1 server-side watcher not yet built) | **VERIFIED** — `src/hooks/useGenerationQueue.ts` is still the client history-poll loop; no server-side completion watcher exists | In-repo read at main `51b5326` | The binding constraint on the Control Center / Workbench spec rounds: A-1 must land first (as §6 already orders) |
| G-2 | "Full object_info is megabytes" (A-8's incremental-pull premise) | **CORROBORATED** — the engine-contract fixture records `rawClassCount: 1718` against a 151 KB trimmed 69-class capture; MB-class at full breadth. Cheap settling test: the next CPU-only capture records the raw JSON byte size in the provenance block (one-line script addition) | `scripts/fixtures/engine-object-info.json` provenance | A-8's targeted-probe design (landed in Wave 2) — premise holds |
| G-3 | better-sqlite3 + WAL single-writer stays (no Postgres) | **VERIFIED as built** — `server/db.ts` decision record 2026-09-11; `better-sqlite3@^13.0.3` | In-repo | A-7's worker-threading rule applies to the existing substrate only |
| G-4 | The plan's file:line anchors (R-01 `useStudioSession.ts:69-74`, `core.ts:194-215`, etc.) | **VERIFIED-as-moved, symbols intact** — Wave 1/2 landed: `checkConnection` now `useStudioSession.ts:117`; `structuralPromptError` refactored to `src/lib/promptError` (imported at `core.ts:27`); `validateH3Render` at `h3Submit.ts:117`; R-13's `''`-guard landed with its comment at `fetchCatalog.ts:81`; `instanceInventory.ts` is now fully registry-only (R-12 landed). The plan's own header disclaimer ("anchors at HEAD `7ee1e3c`; branches may have moved code") held exactly | In-repo reads vs plan §2 | None — disclaimed drift, recorded so nobody treats stale anchors as defects |
| G-5 | The registry-only inventory invariant (instance-invisible = nonexistent) is the built behavior | **VERIFIED** — `server/instanceInventory.ts` header: "there is no local scan, no local/instance merge, and no fallback" (Wave 2, PR #38) | In-repo read | The A-3 family registry builds on landed ground |

---

## 2. The version-pin recommendation (the policy this pass produces)

**Facts:** upstream tagged 3 releases in 15 days; two of our family gates quoted wrong/stale minimums within 48 hours of writing; the maintainer's runtime is master while our reference is 0.34.0; every captured semantic re-verified stable 0.34.0→master.

1. **The app's compatibility floor stays "≥ v0.34.0 semantics."** Verified stable through v0.37.0/master on every load-bearing surface (A-2). No code change is forced by upstream motion.
2. **The engine-contract fixture + devdocs captures re-capture per ADOPTED TAG, not per calendar.** Trigger: any task that adds or exercises engine classes the current fixture lacks (YuE2, Qwen-Image-2.1, and every future family). The capture script's regenerate header is the procedure; record the raw byte size while there (G-2).
3. **New-family rows carry a per-class `minComfyVersion`** in the family registry data (A-3 join), sourced from tag-level file checks (raw fetch), NEVER from docs.comfy.org version strings — this pass caught the docs site claiming 0.35.0 for nodes that ship in 0.36.0.
4. **The shared canonical install should bump to the latest TAG (today: v0.37.0), not to master**, when the audio/Qwen adoption tasks dispatch — tagged for reproducibility; coordinated with the maintainer (their instance, their GPU window). One bump unblocks both new families (YuE2 ≥0.36.0, cfg_scale + Qwen 2.1 at ≥0.37.0). Until then, engine-dependent tests for those families cannot run — plan them as graph-shape-only.

## 3. UNVERIFIABLE-NOW (with the settling test)

| Item | Cheap test that settles it |
|---|---|
| Manager 4.3 route-table diff (C-6) | Read `glob/manager_server.py` at tag 4.3; diff routes + `QueueTaskItem` vs the capture §1. ~30 min, no engine. Fire BEFORE the Manager-first install build. |
| Issue #15644 tracker state (any maintainer reply / PR since 2026-09-21 morning) | Fetch the issue page (API was rate-limited this pass). Informational only — the code-level floor is verified unchanged at master, which is the load-bearing half. |
| Full raw object_info byte size (G-2) | One line in `capture-engine-schemas.cjs`: record the raw JSON's byte count into `__provenance`. Lands with the next re-capture. |
| Kreatine `control_loader` behavioral parity (D-5) | The Krea lane's own testbed A/B (already the TS-1/registry-row plan); file-level license-cleanliness is verified. |
| The 8188 instance's exact current revision (A-5) | Ask the maintainer (never probe 8188). Only matters if a captured symptom fails to reproduce on the shared install. |

## 4. Recurrence

Re-run this register: **(1)** after any major research landing (a new assessment that embeds engine/version/license facts), **(2)** before each spec round (Control Center, Workbench), **(3)** on any self-caught wrong claim. Each re-run appends a dated pass section below — rows are never silently rewritten; superseded rows get a verdict update with the new evidence line.

### Pass 1 record (2026-09-21)

- Swept: remediation-plan §1–§6, both devdocs captures + MANIFEST, 7 research assessments, the epic directives' embedded facts, ROADMAP + LEARNINGS headlines. 24 rows registered.
- Corrected in-pass: `docs/devdocs/comfyui-api/index.md` (version-drift addendum incl. the YuE2 minimum), `docs/research/qwen-image-2.1-assessment.md` (v0.37.0 trigger fired), `docs/devdocs/MANIFEST.md` (last-verified bump for the comfyui-api row).
- Relayed, not patched (owned file): the YuE2 v0.36.0 minimum — `docs/research/yue2-3b-assessment.md` is in-flight-owned; the devdocs addendum carries the fact with a pointer.
- No corrections found in: ui-systems-design-language, shibui-fonts-icons, node-pack-registry, h3-image-studio-pack, crossview-warp, remediation-plan, ROADMAP, LEARNINGS (their claims verified as recorded).
