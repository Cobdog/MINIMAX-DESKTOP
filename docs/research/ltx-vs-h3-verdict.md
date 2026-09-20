# LTX vs H3 — keep, retire, or keep-utilities-only (decision input for spec ledger L4)

**Status:** decision input, researched 2026-09-14 (agent report, lead-reviewed). Full
citation set in the agent's report (Flux 0rtwaj4 comment); headlines here.

> **ADDENDUM 2026-09-20 — VERDICT SUPERSEDED.** The maintainer's Phase-0 verdict
> overrules this document's KEEP-UTILITIES-ONLY outcome: **LTX is entirely removed**
> (engines, utility graphs, packs, surfaces — PR #33, restore map in
> [../audit/removals-phase0.md](../audit/removals-phase0.md)). Nothing here
> survives into the current app; git history is the archive. The head-to-head
> research below remains accurate as ecosystem record.

## Verdict: KEEP-UTILITIES-ONLY

Retire the general LTX-2.5 generation workspace; keep the LTX engine path as
(a) the 2.3-dev utility-graph family (remove-subtitles/watermark/object,
restore-archival, outpaint, img+audio→video — official one-graph templates
with **no H3 equivalent**; backlog task 068xwy3 requires this path to exist),
(b) the headless survey builder transitionally until LocationStudio migrates
to H3 Ref2V, and (c) Ltx25Workspace + its mobile parity retired with the nav
model. Confidence moderate-high; one measurable unknown (single-24GB VDN
cost — one afternoon in-app) could flip the survey-engine part.

## Head-to-head (community consensus, cited)

- **H3 dominates the product's axes**: quality, prompt adherence,
  identity/reference (consensus "miles ahead" even vs character-LoRA'd LTX),
  audio quality, ranked #1 open-weights + #1 video-editing (Artificial
  Analysis; first open model to top a video ranking).
- **LTX retains real niches**: native 4K@50fps + portrait-native (H3 caps at
  2K/24fps); legible on-screen text (2.5's diffusion decoder — officially
  marketed; H3's text untested head-to-head [UNK]); dedicated audio→video
  mode (2–20s tracks); the restoration/utility family (LTX-only); LoRA
  trainer ecosystem; friendlier license for hypothetical distribution.
- **Speed on 24GB**: LTX-distilled ~4× faster than H3-standard but only
  ~1.5–3× faster than H3 Turbo-8 — the gap narrowed materially now that the
  app has the fast stack. VDN single-card cost = the unknown that settles
  the survey question.
- **2.5 vs 2.3**: 2.5 closed much of the image-quality gap (new video
  decoder) but the editing/utility surface is 2.3-dev — the utilities task
  targets 2.3 regardless.

## The app's own evidence

- The repo is ALREADY migrating: ContactSheet demoted the LTX turntable to
  fallback (85475cf); LBH presets superseded the LTX 2× upscale (7f843af);
  only LocationStudio remains LTX-only, and it is migratable (~1.5–3× cost
  on H3, quality likely up).
- Identity surveys are the job H3 is consensus-BEST at; using LTX there was
  a cost decision, not a quality decision.
- Maintenance of the general path: ~400–600 lines of surface (workspace,
  gates, mobile parity, regression tests) + demonstrated upstream-schema
  breakage (DynamicCombo incident). Bounded, forever.

## The three strongest points each way

**Keep (as utilities/complement):** the LTX-only restoration family (068xwy3
needs it) · consumer-GPU tier with headroom for background jobs · text/4K
ceilings above H3's.
**Retire (the general workspace):** H3 wins every product axis · the app's
own consumers are leaving LTX · real recurring maintenance for shrinking
differentiation.

## Decision hinges

1. The single-24GB VDN/Turbo-8 survey-cost number [UNK — measurable in one
   afternoon; joins the experiment ladder]. Under ~2–3 min per 10s survey
   clip ⇒ the last speed argument for the general workspace collapses.
2. Commitment to 068xwy3 (utilities) — some LTX path survives regardless;
   the efficient shape is LTX-as-tool-family in the ops registry.
3. LocationStudio migration appetite (or keep just the 90-line headless
   builder for it — most of the savings come from dropping the workspace +
   mobile parity).

**Recommended closure:** L4 = YES, engines dissolve into ops; LTX retained
as the utility-graph family + transitional survey builder; general
Ltx25Workspace retired with the nav model.
