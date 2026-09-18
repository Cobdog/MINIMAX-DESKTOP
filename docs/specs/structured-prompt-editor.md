# Structured H3 Prompt Editor — spec

Status: DRAFT for maintainer confirmation (the concept dictated by the maintainer
2026-09-18; this fills the details). Scope: **generation-side only** — the video
prompt surface, nothing to do with training captions. Written by the lead.

## 0. The idea (the maintainer's words, binding)

Boxes for each part of a proper H3 prompt, where elements build up **independently**;
a proper way to represent the **flow of the video** — structure, what happens when;
minor static tools around it; **everything gets concatenated before it is sent for a
run**. The one-large-textbox stays available for fast starts; structured is a
first-class co-equal mode.

## 1. Where it lives

A **structured ⇄ freeform toggle on the canvas prompt surface** (the properties panel's
prompt area). Same submit path — the structured draft composes into the exact prompt
string the engine already receives (the concat contract, §4). No new surface, no new
route. The workbench's prompt side may adopt the same components later (v1.1).

## 2. The boxes (derived from the captured official guides)

Per the H3 writing guide's dimensions — each box independently editable, each
collapsible, each optional (empty boxes contribute nothing to the concat):

| Box | Carries | Static assists |
|---|---|---|
| **Concept** | The one-line idea / task type (t2v, i2v continuation, style piece…) | guide link; the LLM distiller's target |
| **Subjects** | Repeating subject cards: name/role, appearance, wardrobe, distinctive features — one card per subject; identity-payload and library assets pin straight into cards | library pin; identity strength dial carried |
| **Setting** | Environment, location, era, atmosphere | vocabulary chips |
| **Lighting** | Light language per the guide's norms | chips (golden hour, neon dusk, overcast…) |
| **Style** | Visual style / medium | chips + library styles |
| **Camera** | Shots and movement vocabulary | chips from the captured camera-move vocabulary (ties to the camera compiler's terms) |
| **Flow** | **The timeline, first-class**: an ordered beat/shot list — each row a time range + what happens (action, state change, camera change, reference moment); subsumes the existing `timeline` LLM tool (that tool now fills this list instead of appending text) | add/reorder/duplicate rows; per-row guide-warning on out-of-range times (existing warning logic rides along) |
| **Audio** | Soundscape lines, music description, dialogue lines with the guide's `<d>` formatting | dialogue formatting helper |

**Per-box LLM assist** (the local router, as today): distill (rough notes → box
content), enhance (rewrite the box in guide-correct vocabulary), and a whole-prompt
**"compose preview"** showing the concatenated result before submit.

## 3. The flow editor's contract

Rows are `{ from, to, text }` with `to ≤ from` meaning a moment, ranges clipped to the
job duration; the concat renders rows in order as the guide's timed-shot prose. The
existing timeline-guides machinery (warnings, rendering into the final prompt) is the
substrate — the box is its editor.

## 4. The concat contract

One function, `composeStructuredPrompt(draft)`, pinned by golden tests: box order and
formatting follow the captured guide exactly (subjects defined before use; camera and
lighting folded into scene prose; flow rendered as ordered timed shots; audio last with
`<d>` dialogue). The submitted string is byte-what-the-freeform-path-would-send —
**the engine sees no difference**. **Round-trip**: an existing freeform prompt can be
parsed into boxes best-effort (LLM-assisted, reviewed before adopting) — the toggle
never loses text: switching to structured starts from the parse; switching back yields
the concat.

## 5. Non-goals (v1)

Training captions (different contract — the dataset manager owns that); the
full-reference six-section rewrite format as separate boxes (R2V prompts keep the
freeform path; the reference labels still work inside any box); multi-model doctrine
switching (H3 first; the fragments architecture makes per-model templates a v1.1 add).

## 6. Acceptance criteria

1. The toggle exists on the canvas prompt surface; freeform and structured stay in
   sync per §4's round-trip rule — no text ever lost either direction.
2. Every box editable independently with chips + per-box LLM assist; subjects accept
   library/identity pins; flow rows carry time ranges with warnings.
3. `composeStructuredPrompt` golden-tested against guide-exact output; the submitted
   prompt is indistinguishable from a hand-written freeform one.
4. The `timeline` tool fills the Flow box (its old text-append behavior retired with a
   dated note).
5. The prompt library loads entries as box-sets (best-effort parse, same as round-trip).
6. Full gate + e2e + vision (the structured editor at 1080p, DOM-truth asserted) +
   both CI legs via the PR train.
