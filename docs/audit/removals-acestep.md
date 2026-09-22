# The ACE-Step removal — the audio-lane ruling (task nn5ld47, 2026-09-21)

> The maintainer's ruling: ACE-Step **100% gets cut** — the model is nearly a
> year old; MiniMax Music 3 **stays** (MiniMax family cohesion); H3's native
> AV audio is untouched; the YuE2 song lane is pending-test separately
> (its own task). What died, why, and where each piece lives in git history.
> **Restore point: the commit immediately before the removal commit** —
> `b3687df` at authoring time (the gap-rows commit, this PR's first half).
> "Fully removed" means the runtime app carries none of it: no lane modules,
> no menu rows, no dock arms, no family entries, no provider members.

## The modularity contract's proof — the measured excision

The A-3 family registry (Wave 3 rung 1) existed so an engine removal is one
entry plus its lane modules. Measured:

| Cut | Cost |
|---|---|
| The two lane modules | `src/lib/aceStepSubmit.ts` (97 lines) + `src/lib/aceStepWorkflow.ts` (57 lines) — deleted whole |
| The family entry | `audio.acestep` in `src/lib/graph/engineFamilies.ts` — one STOCK_ENTRIES object deleted; the selector, panel gating, and inertness machinery needed ZERO changes (the selector matrix proves a stored `acestep` chain now selects nothing, same honest shape as the removed `ltx`) |
| The model family | the `acestep` row in `MODEL_FAMILIES` + `SLOT_FIELDS` + `AUDIO_VAE_FAMILIES` + the inference branch (`src/lib/modelOverrides.ts`) |
| Whole change | 28 files, +164 / −454 (net −290), no shared-surface rewrites — every touched shared file lost an arm or a union member, never gained a branch |

## What died, with restore paths (at `b3687df`)

| What | Restore path |
|---|---|
| The lane: submit core + validation, workflow builder + model inference | `src/lib/aceStepSubmit.ts`, `src/lib/aceStepWorkflow.ts` |
| The family-registry entry | the `audio.acestep` object in `src/lib/graph/engineFamilies.ts` (STOCK_ENTRIES) |
| The model family | the `acestep` row in `MODEL_FAMILIES`, `SLOT_FIELDS.acestep`, the `AUDIO_VAE_FAMILIES` member, `inferredOverrideSlotFile`'s acestep branch — `src/lib/modelOverrides.ts` |
| Types | `AceStepModelSelection`, `AceStepGenerationOptions` (src/types.ts); `EngineId`'s `'acestep'` member (graph/types.ts); `RenderManifest.provider`'s `'acestep'` member (manifest.ts); `GenerationJob.provider`'s `'acestep'` member (types.ts — the `(string & {})` arm keeps old jobs rendering their raw string) |
| Canvas surfaces | the `produce:acestep` typed-hole row + `availability.acestep` (options.ts); the dock's acestep arms — tags label, instrumental checkbox, 360s clamp, note line (AudioDock.tsx); the store's submit/validate/probe acestep branches + `aceSelectionOf` + the audioDock/createAudioChain/validateAudioDraft `'acestep'` union members (store.ts); the panel's audio-dock handoff row is now gated to music3 chains (PropertiesPanel.tsx) |
| The contract ledger | `acestep.timesignature-format` + `acestep.keyscale-format` (engineSemantics.ts KNOWN_DIVERGENCES) — the entries self-retired with the builder they ledgered. NOTE for the contract-ledger builder-fix work: the acestep enum-format fix is moot; if that PR still carries it, its ledger entry has no builder left to fix |
| Preflight / capture scope | preflight.ts's comment (the acestep classes were never in STOCK_GRAPH_CLASSES); the four AceStep class ids left `PACK_CLASSES` in scripts/capture-engine-schemas.cjs (out of contract scope once nothing emits them — the committed fixture keeps its captured entries until the next regeneration) |
| Server | the `acestep` member of the settings-normalization `audioVaeFamilies` set + comment (server/core.ts) |
| Tests (died with what they tested) | the acestep ladder arms (canvas.test.js §w), the corpus arms + divergence signatures (engine-contract.test.js), the snapshot row + selector arm→null (engine-families.test.js — the arm stays as the removed-engine tolerance proof), the override/audit/walk arms + scan fixtures + `MODEL_FAMILIES.length` 4→3 (workflows.test.js), the legacy-acestep migration arm re-purposed to prove a dead family's pick DROPS instead of migrating (instance.test.js) |
| e2e / vision | the acestep plan-probe arm (e2e/canvas.spec.ts engines-as-ops); two rubric lines (scripts/vision-e2e/scenarios.ts — the family-shapes note and the bottom-bar chips blessing) |
| Catalogs / docs | ci-map.cjs path lists (both acestep modules removed from the canvas + workflows rules); package.json description; the README's ACE-Step setup section (replaced by this pointer); docs/licenses/registry.md's YuE2 ladder note (music3 stays the commercial-safe rung); docs/agent/testing.md's divergence-list mention |

## Old data is tolerated, never crashed on (the honest-refusal rule)

- A **stored audio chain** with `engine: 'acestep'` is PRESERVED by
  `readChainSettings` (generation.ts) — `submitChain` and `validateChain`
  refuse it honestly ("ACE-Step was removed on 2026-09-21…") instead of
  silently rendering a Music 3 track from an ACE-Step chain's tags (the
  R-05 silent-wrong-output class). The panel shows no audio-dock handoff
  for such chains.
- A **stored acestep override family** keeps its shape through the server's
  settings normalization (shape-guarded, never a crash) but its legacy
  `vae` pick no longer migrates — a dead family's pick drops (the LTX
  precedent, asserted in instance.test.js).
- **Jobs** carrying `provider: 'acestep'` render their raw string
  (`(string & {})`), exactly like the Phase-0 ltx25/ltx23/zimage providers.

## Why music3 stays

MiniMax family cohesion (the ruling's own words: MiniMax Music 3 stays); the
audio dock, its typed-hole produce row, and the h3-audio T8 sidecar row are
untouched. The song lane's future is YuE2's pending-test assessment, not a
return of ACE-Step.
