# The central-model audit — the standing punch list

**Task** Central-model-pattern audit (ho7p1f8) · **Epic** 4lphxv8 · **Directive** 5c93040f ·
**Date** 2026-09-26 · **Method** grep-driven candidate sweep → read every candidate → classify REAL vs
FALSE-POSITIVE against the law below. Read-only audit of `main` @ b3ba921.

## The law (verbatim)

> "This is where the modularization desire came in when we first started this project — break down
> these systems that rely on their own way of interpreting something, and create a central model they
> all read from. This should be a pattern throughout. We have too many mini systems that try and do
> their own thing. We can simplify this and reduce the error surface."

THE LAW: **no consumer surface maintains its own interpretation of a shared domain** — every reader
(stack report, doctor, wizard, pickers, chips, boards) derives from the ONE central resolution/model
the system itself uses; expectations-tables, parallel regexes, shadow fallbacks, and summary-logic
forks are error surface, not features. New PRs that introduce a parallel interpretation of an
existing domain fail review; this document is the standing inventory each such PR is checked
against, and each row here is a centralization punch-list item.

## How to read a row

Every REAL row names: the **domain** (the shared thing being interpreted), the **mini-system** (the
file(s) keeping their own interpretation), the **central model** it should read (or the one to
create), the **disagreement scenario** (how the two diverge and who lies — a row without a concrete
divergence is a refactor taste, not an error surface), the **fix shape**, and the **risk** of
leaving it. Ranking is likelihood × cost of the disagreement firing.

---

## The punch list, ranked by error surface

| # | Row | Class | Error surface |
|---|-----|-------|---------------|
| R1 | The 17k+5 frame-grid ledger is read only by tests — five production readers re-derive it | duplicated domain logic | **HIGH** |
| R2 | "H3 stack ready" computed by four different predicates | status summarizer | **HIGH** |
| R3 | Turbo optimizer matches FULL registry names; the ladders match basenames | shadow matcher | **HIGH** |
| R4 | Server settings-load re-implements decoder-class routing + family sets | shadow matcher | **MED-HIGH** |
| R5 | Pack presence: any-match (board) vs all-match (optimizers, gates) | presence tracker | **MED** |
| R6 | Node-class vocabularies mirrored beside the registry | presence tracker | **MED** |
| R7 | Three object_info presence channels with independent staleness | status summarizer | **MED** |
| R8 | `optionAvailability`'s own music3 gating + missing-label vocabulary | counts/labels | **MED-LOW** |
| R9 | krea2edit's own ladder: full-name matching, own quant policy, first-match ranking | shadow matcher | **MED-LOW** |
| R10 | contactSheet's turnaround-LoRA matcher (dormant) | shadow matcher | **LOW** |
| R11 | The doctor's own vocabularies (attention regex, VRAM-tier advice) | presence tracker | **LOW** |
| R12 | License-risk classification as a client regex | counts/labels | **LOW** |
| R13 | `inferFamily(model).includes('qwen')` — capability by family-name substring | shadow matcher | **LOW** |
| R14 | The prompt grammar restated inline in promptComposer | duplicated domain logic | **LOW** |
| R15 | Preview-override class regex duplicated client/server | shadow matcher | **LOW** |
| R16 | Port conventions in three homes (types comment, runtime constants, wizard list) | duplicated domain logic | **LOW** |

The stack report itself — the directive's reference case — is **being centralized now** (in flight,
PR branch in a worktree: `h3Stack.ts` rewritten to read `inferSelections` + `resolveModels`, its own
expectation table deleted; not re-audited here per its in-flight status). R2 and R8 are the same
pattern in that row's *neighbors* and should ride the same rework.

---

## The rows

### R1 — The engine-semantics ledger is unread (HIGH · duplicated domain logic)

**Domain:** the H3 engine's frame-grid semantics (the 17k+5 grid: 5, 22, 39, 56…; snap-up
alignment; temporal-slice counts).

**Mini-systems:** `src/lib/engineSemantics.ts` *declares itself* "THE SEMANTIC-RULES LEDGER" and
exports `h3AlignFrameCount`, `h3NativeFrameCounts`, `isH3NativeFrameCount`, `h3TemporalSlices`.
Its **only consumer is `tests/engine-contract.test.js`**. Every production reader re-derives the
grid with its own arithmetic:

- `src/lib/workflow.ts:19-21` — `frameCount(seconds)`: own snap-up formula
  (`base + ((5 - (base % 17) + 17) % 17)`).
- `src/lib/camera/motionFrame.ts:44` — snap-**down** truncation
  (`5 + 17 * Math.floor((target - 5) / 17)`) — a *different policy* over the same constraint,
  decided locally.
- `server/datasets/model.ts:32,44` — `17 * n + 5`, twice.
- `server/datasets/bake.ts:519` — its own validator (`(entry - 5) % 17 === 0`).

**Disagreement scenario:** the engine's grid changes (a ComfyUI bump re-shapes `temporal_shape`).
The ledger is updated, its provenance pin bumped, the contract tests go green — and **nothing
forces the five copies to follow**. The tests enforce the ledger, not the readers; the central
model exists and the system still doesn't read it. This is the audit's emblem: a central model
plus unread copies is *worse* than no central model, because the provenance pin and the green tests
 certify a truth the production code doesn't use. (Closer in: motionFrame's down-truncation and
workflow's up-snap are two policies for one physical rule — legitimate differences, but decided
per-file instead of named in the one home.)

**Fix shape:** import from `engineSemantics` at every site; add an explicit
`h3TruncateToGridDown()` (or similar) in the ledger for motionFrame's reference-truncation policy
so the one deliberate divergence is named, owned, and tested. Server files can import `src/lib`
(precedent: `server/core.ts` already imports `../src/lib/preflight`).

**Risk:** silently reinterpreted renders — the exact `KNOWN_DIVERGENCES` class the ledger exists to
prevent, re-entering through the side door.

### R2 — Four "H3 stack ready" predicates (HIGH · status summarizer)

**Domain:** "is the H3 stack usable right now" (per engine + registry + overrides).

**Mini-systems:**

1. `src/canvas/store.ts:203-206` `modelReadyFor()` — requires
   `fl2va && ref2va && textEncoder && videoVae && audioVae` (+ an `activeModel` conditional that is
   dead weight: both lanes are always required anyway). Used at five call sites (option
   availability, probe facts, submit-context `modelReady`).
2. `src/canvas/EngineHost.tsx` — the canvas chip's inline predicate: same five fields, computed
   separately (duplicate of #1, equivalent today, drifting by construction).
3. `src/lib/h3Stack.ts` `h3StackReport().ready` (main's version — being centralized now): requires
   the five *table rows* **including the Turbo-8 LoRA** and **excluding ref2va**, plus
   `missingCoreNodeClasses === 0`.
4. `src/lib/h3Diagnostics.ts:70-74` `diagnosticSelectionsReady` — requires
   `fl2va && textEncoder && videoVae && audioVae && turbo.fl2vLora`, **no ref2va, no node check**.

**Disagreement scenarios (all live):** a stack with no turbo LoRA → canvas chip says "H3 ready",
Settings/wizard stack report says incomplete. A stack with fl2va but no ref2va (text-mode-only
user) → the report says ready (no ref2va row), the chip and option menu say not ready — soft-gating
first-frame renders the graph could actually run. The diagnostics pair requires turbo-8; the chip
doesn't. Who lies: each surface to its own audience; the maintainer sees "ready" one place and
"incorrect/incomplete" another for the same engine — precisely the 2026-09-26 ruling class ("the
auto inferred models are there, the H3 Engine Stack reports are incorrect").

**Central model:** the resolution itself (`inferSelections` + `resolveModels` — already what
surfaces run to *pick* files) plus ONE exported readiness predicate, parameterized by what is
actually being gated (mode: text needs the fl2va set; reference mode adds ref2va; turbo plans add
the LoRA; render readiness adds the core-node check `missingCoreNodeClasses`). Natural home:
`modelSelection.ts`/`modelOverrides.ts` territory or the rewritten `h3Stack.ts`.

**Fix shape:** the in-flight stack-report rework centralizes the report's side; extend its
resolution-derived verdict to the canvas chip, `modelReadyFor`'s call sites, and the diagnostics
gate. Delete `modelReadyFor` and the EngineHost inline copy.

**Risk:** the critical path's most user-visible verdict keeps disagreeing with itself; every new
surface re-encodes membership again.

### R3 — Turbo optimizer matches full names, ladders match basenames (HIGH · shadow matcher)

**Domain:** "which turbo LoRA family does this registry file belong to."

**Mini-system:** `src/lib/graph/turbo.ts:26-34` `firstLoraMatch` tests `pattern.test(file.name)` —
the **full registry name** — with **anchored** patterns (`^minimax_h3_fl2v_turbo_8step…`), while
`modelSelection.findRegistryModel` (which consumes the *same* `turboLoraPatterns` for the video
ladder) tests `basenameOf(file.name)`. Same patterns, two normalization rules, one file. Bonus:
`turboFetchPlan` (turbo.ts:~232) declares its **own local `basenameOf`** instead of importing the
export that exists precisely so "no surface can drift back to full-name compares"
(modelSelection.ts header).

**Disagreement scenario:** a registry row listed with a subpath
(`H3/turbo/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` — exactly the subpath shape
Wave 2 R-12 documented and the registry serves): the video ladder resolves it; the optimization
registry's `detect()` reports the family **unavailable**. The picker shows the file as selected;
the optimization dropdown says the family isn't installed. This is the same bug class the stack
report's F2/C3 basename fix killed — still live one layer down.

**Fix shape:** route `firstLoraMatch` (and `classifyTurboFamily` callers that see registry names)
through the imported `basenameOf`; delete the local copy in `turboFetchPlan`.

**Risk:** every subpath'd turbo LoRA gets silently invisible to the optimizer while visible to the
ladder — a ready-stack user offered "not available" for weights the engine serves.

### R4 — Server settings-load re-implements decoder-class routing (MED-HIGH · shadow matcher)

**Domain:** VAE decoder-class routing + per-family slot legality (the tmz8vh7/epdvxd4 rules).

**Mini-system:** `server/core.ts:~838-895` (the settings-load normalizer) hand-copies
`t1Marker = /^minimax_h3_t1_image_vae/i`, `audioMarker = /audio|dav/i`, `videoMarker = /video/i`,
plus `laneFamilies`/`videoVaeFamilies`/`audioVaeFamilies`/`imageVaeFamilies` sets and a
`routeOnVideoFamily` function — "mirroring" `src/lib/modelOverrides.ts`'s `T1_IMAGE_VAE_PATTERN`,
`AUDIO_VAE_MARKER`, `VIDEO_VAE_MARKER`, `VIDEO_VAE_FAMILIES`, `AUDIO_VAE_FAMILIES`,
`H3_LANE_FAMILIES`, and `migrateLegacyModelOverrideSlots`. The comment discipline ("mirrors the
same dated rule…") is the only thing holding the copies together. `core.ts` already imports from
`../src/lib` — the duplication is unnecessary, not forced.

**Disagreement scenario:** family membership changes (the LTX and acestep removals each edited
**both** copies by hand — the comments record the lockstep). The next family change updates
`modelOverrides.ts` and misses the server copy: stored picks silently drop or misroute at
settings-load while the client-side migration preserves them — the stored settings and what the
surfaces resolve diverge **invisibly** (no error, no warning; the server copy runs before the UI
ever sees the values). A marker broadened client-side (new decoder naming) likewise never reaches
the server's copy.

**Fix shape:** export the markers, family sets, and a pure `normalizeStoredOverrideSlots()`
(server-safe, no store imports) from `modelOverrides.ts`; `core.ts` imports it. One home, one
dated rule.

**Risk:** silent stored-state divergence on the migration seam — the wedge class tmz8vh7 itself
was called in to fix, re-enterable from the other side.

### R5 — Pack presence: any-match vs all-match (MED · presence tracker)

**Domain:** "is node pack X active on this engine."

**Mini-systems:** the board's rule — `server/engineNodes.ts:316` — is **any-match**
(`instanceNodeClasses.some` served → `active`). Other readers require **all** classes:
`graph/turbo.ts` `larryvrhTurboPackPresent` (both `MiniMaxH3TurboLoRA` + `MiniMaxH3TurboSampler`),
`canvas/store.ts:148` `motionContextReady` (`MOTION_CONTEXT_NODES.every`), and per-family
all-match gates inside `h3image.ts`'s detection.

**Disagreement scenario (fires today, no code change needed):** a stale/partial checkout serves
`MiniMaxH3TurboLoRA` but not `…Sampler`. The pack board chip says **active**. The turbo plan says
the pack is **absent** and falls back to the plain loader; motion-context options grey out on the
same evidence the board calls green. Two surfaces, two verdicts, one engine — and the user who
trusts the board re-installs nothing because "it's already active."

**Fix shape:** one presence function owned by the registry — `packPresence(info, packId)` — with
the any/all rule as **registry data per row** (a pack that legitimately needs all its classes
declares so; a pack detected by one stable hook declares any-match). Every gate (board, optimizer,
canvas options, wizard summary) calls it.

**Risk:** partial installs produce permanently contradictory UI; each new gate re-picks a rule.

### R6 — Node-class vocabularies mirrored beside the registry (MED · presence tracker)

**Domain:** the studio's node-class vocabulary (which class ids each pack serves).

**Mini-systems:** `nodePackRegistry.instanceNodeClasses` is the declared one source (engineNodes
imports it — the server/client split was avoided by design), **but** graph builders keep mirror
copies: `KREA2EDIT_NODES` / `ANYPAINT_NODES` (`src/lib/graph/krea2edit.ts:83-84`),
`MOTION_CONTEXT_NODES` (`src/canvas/generation.ts:597`), `LARRYVRH_TURBO_NODES`
(`src/lib/graph/ids.ts:75`). The registry's own comments admit it: "mirrored by KREA2EDIT_NODES in
src/lib/graph/krea2edit.ts."

**Disagreement scenario:** a pack pin-bump renames a class; the registry row is updated (detection,
preflight remediation, fetch pins all follow) and the mirror stales → the builder still emits the
old class. The engine refuses (schema) or — worse — the emitted class maps to **no** row in
`preflight`'s `CLASS_TO_PACK`, so the refusal's remediation advice degrades to the generic line.
GAP-1/GAP-2 in the 2026-09-21 curation pass were exactly this class, found by hand instead of by
construction.

**Fix shape:** builders import their class constants from `nodePackRegistry` (single spelling), or
a test asserts set-equality between every mirror and its registry row so drift fails CI loudly.

**Risk:** the modularity contract's removal test ("pull a pack = one-entry change") silently
requires N edits; a missed one ships broken graphs.

### R7 — Three object_info presence channels, independent staleness (MED · status summarizer)

**Domain:** "which node classes does the engine serve right now."

**Mini-systems:** (1) the client session store's `info` (pulled on connect/recovery/drift,
epoch-counted — the fabric's truth); (2) the server's `objectInfoProbe` (per-class
`/object_info/{class}` asks, 10 s TTL) feeding the pack board; (3) the doctor's own full
`/object_info` pull. Each channel has its own freshness clock.

**Disagreement scenario:** recorded in the code's own words — `engineWatch.ts`'s comment: "the
studio keeps the old registry while the pack board (its own TTL-probed object_info pull) flips."
Concretely: the user installs a pack; the board's probe flips its chip **active** within 10 s;
submit-time preflight diffs against the client store's `info` (no transition, no epoch bump yet)
and **refuses** — "install it from Settings → Node packs" — for a pack the board says is running.
Or the reverse ordering after a restart. The A-8 probe is a *performance* optimization that became
a second truth source.

**Fix shape:** keep the probe (it's the right cost model) but key every presence answer on one
invalidation spine: the board re-resolves on `infoEpoch` (SettingsView already does this — the TTL
just answers independently), and the probe's cache invalidates on the same fabric events the
engine-watch emits. The doctor's pull is fine as a *diagnostic* re-measurement as long as its
verdict is labeled by its own snapshot time, not merged silently with the others.

**Risk:** the remediation loop (refuse → install → re-submit) dead-ends or false-starts depending
on which channel answered last.

### R8 — `optionAvailability`'s own music3 gating and labels (MED-LOW · counts/labels)

**Domain:** family availability + "what's missing" vocabulary.

**Mini-system:** `src/canvas/store.ts:2188-2203` — its own `music3.available` predicate
(`diffusion && textEncoder && vae`) and hand-written missing labels ('Music 3 diffusion model',
'Music 3 text encoder', 'Music 3 DAV VAE'), beside `MODEL_FAMILIES`' registry data
(`slotKinds`, `emptyAutoHint` — designed for exactly this) and `resolveModels`' per-slot
auto/applied/degraded/refused outcomes.

**Disagreement scenario:** the family registry gains a nuance (a new slot, a refusal vocabulary,
an updated hint); the option menu's copy stales. The seam already refuses wrong-kind and
wrong-class picks with specific reasons; the option menu only knows three file-shaped strings —
the menu says "available" for a stack whose picks would refuse at submit.

**Fix shape:** derive from `resolveModels('music3', …).resolution` per-slot states +
`SLOT_LABELS`/`emptyAutoHint`; delete the local strings.

**Risk:** low-frequency but user-facing; every family change touches one more place than the
registry contract promises.

### R9 — krea2edit's own ladder (MED-LOW · shadow matcher)

**Domain:** registry file resolution for the Krea 2 edit stack.

**Mini-system:** `src/lib/graph/krea2edit.ts:583-594` `firstFileMatch` + `EXCLUDED_QUANT` +
`KREA2_FILE_PATTERNS` — not `findRegistryModel`. Three divergences from the one inference engine:
(a) `pattern.test(file.name)` against the **full name** with anchored patterns — the subpath
blindness of R3, again; (b) its own quant policy (`EXCLUDED_QUANT = /(nvfp4|mxfp8)/i` — an
exclusion list) where `modelSelection` expresses quant preference as `SIZE_CLASS_PREFER` ranking;
(c) first-match-wins within a tier where the central engine ranks by size class then shortest
basename.

**Disagreement scenario:** the same registry yields different picks for different families: a
subpath'd `krea2_turbo_int8_convrot.safetensors` resolves for nothing in krea2edit (anchored,
full-name) while every H3 slot resolves it; two files matching one krea2 tier pick by registry
order, not by quant quality.

**Fix shape:** express the krea2 ladders as `findRegistryModel` expressions (the engine already
supports fallback needles); if the NVFP4/MXFP8 exclusion is a real policy, make it a named,
documented policy in the one home (or a per-family tier list) rather than a parallel regex.

**Risk:** the workbench's edit families silently resolve worse (or nothing) on registries the rest
of the app handles fine.

### R10 — contactSheet's turnaround matcher, dormant (LOW · shadow matcher)

`src/lib/contactSheet.ts:33` — `/five[_-]?view|turnaround/i` against the full name, first-match,
no ladder. No production callers (tests only — `tests/workflows.test.js`, `tests/canvas.test.js`).
If reactivated: a subpath'd or renamed turnaround LoRA resolves nowhere. **Fix:** one
`findRegistryModel` call, or delete the module — git history is the archive (the Phase-0 doctrine);
a dormant mini-system is error surface waiting for its first caller.

### R11 — The doctor's own vocabularies (LOW · presence tracker)

`server/core.ts` doctor checks: (a) attention backends detected by class-name regex
(`/blocksparse|sage|triton|flash/i`) — a presence interpretation parallel to the registry/preflight
discipline (it names "Sol-Attn" in prose, which no registry row knows); (b) the VRAM-tier check
(`vramGb < 18`) with a hardcoded community-tier advice sentence duplicating `SettingsView`'s
`gpuTiers` guidance strings — the same tier guidance `modelSelection.SIZE_CLASS_PREFER` anchors
on. **Disagreement:** tier advice updated in one home stales in the other (the doctor's sentence
already reads as a paraphrase of the '16'-ish tier row). The doctor *measuring* hardware itself is
correct — its job — but its **advice text** should be data-derived (read the `gpuTiers` table) and
its attention check should read known-pack presence rather than a free regex. Core-class checks
already do this correctly (`missingCoreNodeClasses` — the shared home).

### R12 — License-risk classification as a client regex (LOW · counts/labels)

`src/components/FetchBrowser.tsx:33` — `id === 'no-license' || gpl* || agpl* || cc* ||
/qwen-research|non-?commercial|research-?only/` — interprets SPDX ids into "needs attention,"
parallel to the license registry/policy (`docs/licenses/`) and the per-row `licenseNote` data the
catalog serves. **Disagreement:** a new gated id (a future 'gemma'/'llama-gateway' class) is
under-flagged; `startsWith('cc')` over-flags permissive CC-BY. The consent gate's honesty rides a
regex that doesn't read the registry. **Fix:** the catalog row carries a computed
attention/flag from license-registry data server-side; the client renders it.

### R13 — Capability by family-name substring (LOW · shadow matcher)

`server/core.ts:1567` (`supportsNativeVideo`) and `:2854` (`nativeVideo`):
`inferFamily(model).includes('qwen')` — substring on the family key, while the family manifest
(`server/llm/registry.ts`, `server/llm/families/*.json`) is the declared family-truth home and
already carries a `vision` block. **Disagreement:** a non-qwen family with native video (or a qwen
rename/split) silently answers false — VLM dataset planning degrades with no error anywhere.
**Fix:** add `nativeVideo` to `FamilyManifest`; route both sites through the manifest.

### R14 — The prompt grammar restated inline (LOW · duplicated domain logic)

`src/lib/promptComposer.ts:177` restates the official `[Shot 1]` / `[Shot N] At MM:SS.mmm` timing
grammar as an inline coaching string, while `promptContracts.ts` encodes the same grammar as
sourced data (from MiniMax's official skill) and `structuredPrompt.ts` implements compose/parse
against it. **Disagreement:** the pinned guide updates → contracts updated, the assistant's
coaching text stales, and the LLM coach teaches a different shape than the editor enforces and the
validators catch. **Fix:** build the coaching line from the contract section data (import, don't
paraphrase).

### R15 — Preview-override regex, two copies (LOW · shadow matcher)

`/minimax.*h3.*preview.*override/i` lives in `src/lib/h3Stack.ts` (`findH3PreviewOverrideNode`)
and again in `server/core.ts:2450` (`graphSelfPreviews` — the comment admits "the class signature
mirrors findH3PreviewOverrideNode"). The CS-suffix precedent already forced this pattern to be
broadened once; next time only one copy gets the edit and live-preview behavior (suppress/request
the stock `taesd` channel) diverges from what the pack-detection UI reports. **Fix:** export the
pattern from one home; import server-side (same precedent as R4's fix).

### R16 — Port conventions in three homes (LOW · duplicated domain logic)

The "8188/8189 are the user's, 8191+ is ours" convention lives in: `src/types.ts:71` (comment),
`server/runtime.ts:73-74` (`RESERVED_ENGINE_PORTS`, `DEFAULT_PORT_SCAN_START` — the executable
home), and `src/canvas/FirstRunWizard.tsx:58` (`COMMON_PORTS = [8188, 8189, 8190, 8191, 8192]`).
The wizard's probe list hardcodes the managed scan range (8191/8192) as candidate *user* engines —
offering the studio's own future managed port as a connect target. **Fix:** the wizard derives its
probe list from the runtime constants (reserved ∪ scan-start window), imported.

---

## Already centralized — the honor roll (the pattern's lineage)

The law generalizes what the program already enforced piecemeal. These are the proof it works, and
the templates for every row above:

- **Registry-only inventory** (directive 2987ef3e): `server/instanceInventory.ts` + the
  scanModels bootstrap — one model truth; instance-invisible = nonexistent, everywhere.
- **The family registry + override seam** (`src/lib/modelOverrides.ts`): `MODEL_FAMILIES`,
  `SLOT_FIELDS`, `SLOT_LABELS`, `emptyAutoHint`, `resolveModels` — one override truth; the
  Settings rows and the properties panel render the same `overridePickOutcome` the submit path
  enforces ("never a second validation path").
- **`findRegistryModel`** (`src/lib/modelSelection.ts`): one inference engine — the video ladder,
  the workbench's `inferH3ImgSelection`, and music3's `inferMusic3Selection` (the DAV
  unification) all resolve through it; **`basenameOf` exported** (sweep #1, 68e9k17) so no surface
  can drift back to full-name compares. R3/R9/R10 are the lapses against this roll entry.
- **engineWatch + engineRecovery + sessionStore** (R-01, sweep #2): one engine/session truth —
  transitions, the resync *record* (toasts speak only after the inventory lands), the infoEpoch.
  The canvas chip's facts are mirrored *from* the fabric by EngineHost (R2 is the predicate, not
  the plumbing, being duplicated).
- **jobReducer + failureTaxonomy** (`classifyFailure`): one job-state reduction; the diagnostic
  report, toasts, and the queue all classify through it.
- **preflight + nodePackRegistry** (R-02): one class→pack mapping; the server's engineNodes
  *imports the renderer's registry* — the two-runtime split was avoided by construction. R5/R6 are
  the readers that didn't get the memo.
- **The in-flight stack-report rework**: the reference implementation of this law — the report now
  reads `inferSelections` + `resolveModels` and states per-row resolution provenance; its own
  expectations table is deleted. R2's remaining predicates should ride it.
- **`turboFetchPlan`** (journey sweep #7): the R-19 fetch-count fix — counts only families a
  catalog row can deliver; the affordance can no longer promise what the destination can't
  fulfill.
- **`overrideLayerCounts`/`overrideLayerSummary`**: the models-section header chip derived from
  the same layer data the rows render — "the chip can never contradict the rows beneath it."

## Enforcement — what a reviewer greps for in new PRs

1. **New matchers:** any added `RegExp` / `.test(` / `.includes(` against model, pack, class, or
   filename tokens must live in (or be imported from) the domain's one home — the ladders
   (`modelSelection`, family `infer*`), the registries (`nodePackRegistry`, turbo entries), or the
   markers (`modelOverrides`). A new expectations table or parallel fallback list fails review on
   sight.
2. **New verdicts:** any new `ready` / `available` / `missing` / `active` predicate must call the
   resolution seam (`resolveModels` / `inferSelections` / registry data) — not re-encode
   membership. If you can name a file where the same verdict is already computed, you've found the
   row, not the pattern.
3. **Duplicated constants:** typing a second copy of anything — `basenameOf`, decoder markers,
   family sets, node-class lists, frame-grid math, port numbers, tier advice — is a finding. Grep
   the identifier before writing it.
4. **The word "mirrors"** in a comment is an automatic flag: mirroring is the smell the law names.
   Either import, or add the set-equality test that makes the mirror loud when it drifts.
5. **Presence reads:** a new object_info consumer declares which snapshot it answers from (client
   `info` epoch, probe TTL, or its own pull) — and a *rendering* surface never invents a fourth
   channel.
6. **Advice strings** that paraphrase policy data (GPU tiers, prompt contracts, license rules)
   derive from the data home or cite it; prose copies drift.

## Method and coverage

Swept: all of `src/` + `server/` (215 TS files) for (a) regex/substring matchers against
model/pack/class/filename tokens outside the ladder homes; (b) readiness/availability/status
predicates; (c) presence/version trackers; (d) counts and label vocabularies; (e) duplicated
domain arithmetic (frame grid, AR/snapping, prompt grammar, port conventions). Every candidate was
read and classified. **Classified FALSE-POSITIVE (derived display or legitimately distinct
domain), for the record:** `derive.ts` `STATUS_LABEL` (label map over tile status);
`diagnosticReport.ts` (pure view over injected fabric state); the wizard (renders `h3StackReport`
+ the board's own listing); SettingsDock/RemediationDock (render central reports);
`packVersioning.ts` (filesystem ladder demoted to install-verification by directive ffcff765 —
verification, not detection); `engineProfiles`/`engineProcess`/`managerClient` (managed-runtime
domain); `music3SelectionOf`/`familyOverrides` in the canvas store (proper `resolveModels`
consumers — the music3-DAV unification landed and holds); the GPU telemetry fallback poll (same
sample source by design); `canvas/store.ts:2610` `loraLoaderCount` (debug-telemetry substring
count — borderline, telemetry only); `h3Stack.ts` on main (the expectations table itself — being
centralized now, excluded per its in-flight status).

Two build agents were in flight during this audit (worktrees at b3ba921): the stack-report
centralization (touches `h3Stack.ts`, `modelOverrides.ts`, `SettingsView`, wizard) and the
hands-on review trio (`submit`/`h3Submit`/`imageCrop`). Rows R2/R8 overlap the first worktree's
territory by design — they are its natural follow-through, not conflicts.
