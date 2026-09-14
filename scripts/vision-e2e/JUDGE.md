# Vision bundle judge — execution instructions

You are the JUDGE phase of the studio's vision QA loop (phase 2 of 3:
**capture → judge → report**). You are dispatched by an orchestrator with a
bundle directory produced by `pnpm test:vision` (phase 1). Your only job:
look at every screenshot, apply its rubric, and write `verdicts.json` back
into the bundle. Phase 3 (`pnpm vision:report <bundle>`) validates your file
and turns it into a pass/fail gate — so a bundle without your verdicts is
loudly "not yet judged", and sloppy verdicts become false test results.
Treat this as a QA responsibility, not a chat task.

## Dispatch one-liner (orchestrator)

> Read `<repo>/scripts/vision-e2e/JUDGE.md` and judge the vision bundle at
> `<bundle-dir>`. Write `verdicts.json` into the bundle and reply with the
> per-checkpoint verdict table.

`<repo>` is the MINIMAX-DESKTOP checkout — quote it, the path contains a
space. `<bundle-dir>` looks like `test-results/vision/<run-id>/`.

## Inputs

- `<bundle-dir>/manifest.json` — run metadata plus, per scenario, an ordered
  `checkpoints` array. Each checkpoint has:
  - `image` — PNG filename in the same directory (1920x1080, fullPage).
  - `rubric` — the expected contract: what MUST be present/correct.
  - `label` — human description of the moment.
  - The scenario may also carry `consoleErrors` (context only — renderer
    errors filtered to non-environmental ones; weigh them as supporting
    evidence, never as the sole basis for a verdict).
- Screenshots are named `<run-id>--<checkpoint-id>.png`. Filenames are unique
  per run BY DESIGN — read them natively by absolute path and you will always
  get the fresh upload, never a cached one.

## Procedure

For EACH checkpoint in manifest.json, in order:

1. **Read the PNG** (absolute path inside the bundle). Never judge from the
   filename, the rubric, or memory of a previous run. If you cannot read the
   image at all: verdict `fail`, issue "screenshot unreadable", confidence
   `0.2`, and continue with the other checkpoints.
2. **Apply the rubric literally.** The rubric is the contract the UI must
   meet TODAY. Every clause in the rubric must hold in the screenshot. Where
   the rubric is ambiguous, judge against the literal wording and mention the
   ambiguity in the checkpoint `summary`.
3. **Hunt the general bug taxonomy** in addition to the rubric clauses:
   - **overlap** — elements rendered on top of each other unintentionally
   - **clipping** — content cut off by a container or the viewport edge
   - **misalignment** — rows/columns/baselines visibly off-grid
   - **contrast failures** — text unreadable against its background
   - **truncated text** — labels or values cut mid-word or replaced by `…`
     where the full string is the contract
   Only report what is VISIBLE in this screenshot; do not speculate about
   states you cannot see. A disabled control is not a bug unless the rubric
   says it must be enabled (e.g. Generate is correctly disabled offline).
4. **Two-pass rule (anti-flake).** If (and only if) your first verdict is
   `fail`, re-examine the SAME image once — re-Read it — and re-evaluate
   before recording the final verdict. Vision judgments are noisy; the
   second look exists to kill one-off hallucinated defects. If the second
   look passes, record `verdict: "pass"`, `rechecked: true`, and note what
   the first pass got wrong in `summary`. A fail that survives the re-look
   is recorded as `fail` with `rechecked: true`.
5. **Confidence** — 0.0–1.0, honestly: 0.9+ only when the rubric clauses are
   unambiguous and you saw the whole scene clearly; ~0.5 when judging small
   text or subtle alignment.

## Output — write `<bundle-dir>/verdicts.json`

Exactly this shape (valid JSON, no trailing commas, UTF-8):

```json
{
  "runId": "<copy verbatim from manifest.json>",
  "judgedAt": "<ISO-8601 timestamp>",
  "judge": "sonnet-tier subagent via scripts/vision-e2e/JUDGE.md",
  "checkpoints": {
    "<checkpoint id>": {
      "verdict": "pass",
      "confidence": 0.9,
      "rechecked": false,
      "summary": "One line: what was verified / what changed on re-look.",
      "issues": [
        { "severity": "high", "description": "Generate bar overlaps the composer footer (rubric: fully visible)" }
      ]
    }
  }
}
```

Rules for the file:

- One entry for EVERY checkpoint id in the manifest — no more (unknown ids
  will be flagged by the report), no fewer (missing ones count as failures).
- `verdict` is `"pass"` or `"fail"` — nothing else.
- `issues` is an array (empty for a clean pass). Each issue has `severity`
  (`"low"` | `"medium"` | `"high"`) and a concrete `description` naming the
  element and the violated rubric clause or taxonomy class.
- `rechecked` is `true` exactly when you exercised the two-pass rule.
- Optional extra key per checkpoint: `"notes"` for anything the orchestrator
  should know that is not an issue (e.g. rubric ambiguity).

## Hard constraints

- Write ONLY `verdicts.json`. Never modify screenshots, `manifest.json`, or
  anything else in the repo.
- No external API calls, no image tooling beyond reading the PNGs.
- Do not skip a checkpoint because it "looks obviously fine" — an unread
  checkpoint is a fabrication, and the whole loop exists to remove those.
- If the manifest references an image that does not exist on disk, that
  checkpoint is `fail` with issue "image file missing from bundle".
