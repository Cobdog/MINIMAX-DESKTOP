/**
 * THE SEMANTIC-RULES LEDGER (task 8dga2dy) — the engine's REINTERPRETATION
 * rules as committed data, plus the known-divergence registry. Schema
 * validation (engineContract.ts) catches what the engine REFUSES; this
 * ledger catches what the engine ACCEPTS BUT REINTERPRETS — the failure
 * class where "frame counts we say are the frame counts rendered" quietly
 * stops being true.
 *
 * Every rule here is verified against the pinned revision (a87667f,
 * v0.34.0 — source-read of comfy_extras/nodes_minimax_h3.py:46-48 and the
 * served object_info; see docs/devdocs/comfyui-api/index.md §ADDENDUM) and
 * carries its evidence source. Divergences are the honest-negative-results
 * artifact (the pack-author discipline): our builders' emissions the engine
 * does not honor as intended are PUBLISHED here — dated, owned, exact-match
 * enforced by tests/engine-contract.test.js — so the set can never grow
 * silently and every fix shrinks it audibly.
 */
export const ENGINE_SEMANTICS_PROVENANCE = {
  engineRevision: 'a87667f72f5fad094b74b10dc9c9f82faea728ef',
  engineVersion: '0.34.0',
  verifiedDate: '2026-09-21',
  evidence: 'comfy_extras/nodes_minimax_h3.py:46-48 (temporal_shape + align_frame_count), :103/:129/:264 (length INPUT_TYPES min 5, step 17); execution.py:1020-1027 (schema-min enforcement); served object_info capture scripts/fixtures/engine-object-info.json; upstream issue Comfy-Org/ComfyUI#15644',
} as const

/** The engine's own frame-grid math, mirrored exactly: promote to the
 * min-5 floor, then snap UP to the 17k+5 grid (5, 22, 39, 56, ...). This is
 * what temporal_shape() does to every `length` before the latent exists. */
export function h3AlignFrameCount(requested: number): number {
  let n = Math.max(5, Math.trunc(requested))
  while (n % 17 !== 5) n += 1
  return n
}

/** Frame counts the engine honors AS REQUESTED: exactly the 17k+5 grid
 * points (≤ the schema max 3600). Everything else renders as its snapped-up
 * grid point — a different video than the one asked for. */
export function h3NativeFrameCounts(upTo = 3600): number[] {
  const counts: number[] = []
  for (let n = 5; n <= upTo; n += 17) counts.push(n)
  return counts
}

export function isH3NativeFrameCount(frames: number): boolean {
  return frames >= 5 && frames <= 3600 && frames % 17 === 5
}

/** The number of temporal latent slices the H3 AV latent's video tensor
 * carries for a given requested frame count — video_latent_t(), mirrored
 * exactly: 2 slices at ≤5 frames, then +5 slices per 17-frame grid step.
 * Requested lengths that snap to the same grid point share one slice count —
 * e.g. every length 6..21 is the SAME 22-frame, 7-slice packet. */
export function h3TemporalSlices(frames: number): number {
  const frameCount = h3AlignFrameCount(frames)
  return frameCount <= 5 ? 2 : Math.floor((frameCount - 5) / 17) * 5 + 2
}

export type SemanticRule = {
  id: string
  rule: string
  evidence: string
}

/** The verified reinterpretation rules. */
export const ENGINE_SEMANTIC_RULES: readonly SemanticRule[] = [
  {
    id: 'h3.latent-grid',
    rule: "The H3 AV latent's temporal geometry is the 17k+5 grid (5, 22, 39, 56, ...). align_frame_count snaps every requested length UP to the next grid point before the latent exists.",
    evidence: 'nodes_minimax_h3.py:46-48 @ a87667f',
  },
  {
    id: 'h3.length-floor',
    rule: 'length < 5 is REFUSED at prompt validation (schema min 5) — value_smaller_than_min, before execution. Building the graph API-side does not bypass the widget floor.',
    evidence: 'execution.py:1020-1027 + served object_info length min @ a87667f',
  },
  {
    id: 'h3.max5-promotion',
    rule: 'temporal_shape computes align_frame_count(max(5, length)) — a length below 5 would be PROMOTED even if validation were bypassed.',
    evidence: 'nodes_minimax_h3.py:46-48 @ a87667f',
  },
  {
    id: 'h3.slice-window',
    rule: 'Every requested length 6..21 renders as the same 22-frame packet (7 temporal latent slices); 23..38 as 39 frames (12 slices). Only grid points are rendered as requested.',
    evidence: 'derived from h3.latent-grid + video_latent_t; served step:17 tooltip states the snap',
  },
  {
    id: 'h3.video-latent-t',
    rule: "The AV latent's video tensor T = 2 slices at ≤5 frames, then +5 per 17-frame grid step (video_latent_t: 2 if F<=5 else ((F-5)//17)*5+2) — 5→2, 22→7, 39→12.",
    evidence: 'nodes_minimax_h3.py:50-51 @ a87667f',
  },
  {
    id: 'h3.audio-context-grid',
    rule: 'Motion-context audio_context_length is widened to whole 40 Hz grid steps (multiples of 3; 24 = whole seconds) — off-grid values render widened.',
    evidence: 'served object_info MiniMaxH3MotionContext.audio_context_length tooltip @ a87667f',
  },
  {
    id: 'comfy.dynamic-combos',
    rule: 'Dynamic v3 combos (SaveVideo format/codec) are resolved per submitted value server-side; schema-side membership is not checkable and not claimed.',
    evidence: 'served object_info SaveVideo.format options shape @ a87667f',
  },
] as const

export type KnownDivergence = {
  id: string
  surface: string
  emission: string
  engineBehavior: string
  violationType: 'schema-refused' | 'silently-reinterpreted' | 'silently-dropped'
  opened: string
  owner: string
  note?: string
}

/** Our builders' known emissions the engine does not honor as intended.
 * tests/engine-contract.test.js asserts the builder corpus produces EXACTLY
 * these signatures — nothing more (a new divergence fails CI), nothing less
 * (a fix must also retire its entry here, visibly). */
export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  {
    id: 'h3img.t1-length-1',
    surface: 'h3img.generate.t1 (T=1 Fast profile → MiniMaxH3ReferenceToVideo / MiniMaxH3ImageToVideo)',
    emission: 'length: 1',
    engineBehavior: 'REFUSED at prompt validation — value_smaller_than_min (min 5). The T=1 family is broken-as-shipped on stock nodes; its verification to date was graph-shape only.',
    violationType: 'schema-refused',
    opened: '2026-09-21',
    owner: 'the T=1 remediation (first-party latent-construction node, ~150 lines per the devdocs addendum; upstream Comfy-Org/ComfyUI#15644 tracks the stock-node limit)',
    note: 'THE NAMESAKE LESSON of the engine-contract layer: no fake-engine wiring test can catch this — only real schemas do.',
  },
  {
    id: 'h3img.packet-tier-9-13',
    surface: 'h3img packet tiers 9 and 13 (generate/compose/edit families on the packet profile)',
    emission: 'length: 9 / length: 13',
    engineBehavior: "Schema-VALID but silently reinterpreted: both snap to the 22-frame grid point (7 temporal slices) — the tier menu's cost ladder is wrong above 5 on the stock path. 5 and 39 are native grid points.",
    violationType: 'silently-reinterpreted',
    opened: '2026-09-21',
    owner: 'the image-workbench tier ladder rework (retire or re-base tiers onto grid points; rides the T=1 remediation lane)',
  },
  {
    id: 'hybrid.form-adapter-low-vram',
    surface: 'MiniMaxH3LoraFormLoader emission (h3image.ts lora slot 1 + workflow.ts loraStack slot 0 when the pack is active)',
    emission: 'inputs omit low_vram (a REQUIRED widget — BOOLEAN, default false)',
    engineBehavior: 'REFUSED at prompt validation — required_input_missing. Found by this contract layer on its first audit pass (2026-09-21); the sibling larryvrh loader (MiniMaxH3TurboLoRA) DOES emit low_vram: false — the omission is an inconsistency, not a convention.',
    violationType: 'schema-refused',
    opened: '2026-09-21',
    owner: 'one-line builder fix (emit low_vram: false) + golden regeneration — a reviewed contract change, deliberately not folded into the test-layer build',
    note: 'Never executed live: the pack is not installed on the shared testbed, so no run has reached this refusal yet.',
  },
  // (The two acestep.* entries — timesignature/keyscale enum formats — were
  // removed with the ACE-Step lane itself, 2026-09-21, nn5ld47: the builder
  // they ledgered is gone, so the entries self-retire with it. If the
  // contract-ledger builder-fix work re-adds an acestep lane, its entries
  // return with it.)
  {
    id: 'klein.cfg-guider-input-names',
    surface: 'klein refine (buildKleinRefineGraph → CFGGuider)',
    emission: "conditioning / conditioning_1 (the official template's old widget names)",
    engineBehavior: "REFUSED at prompt validation — required_input_missing x2: CFGGuider's inputs are positive / negative at a87667f; the misnamed keys are silently ignored as unknown inputs. Found by this contract layer's first corpus pass.",
    violationType: 'schema-refused',
    opened: '2026-09-21',
    owner: 'the klein lane fix (rename to positive/negative + golden regeneration)',
    note: 'Never executed live: the klein trio has not been staged on the testbed, so no run has reached this refusal yet.',
  },
  {
    id: 'klein.istp-resolution-steps',
    surface: 'klein refine (buildKleinRefineGraph → ImageScaleToTotalPixels)',
    emission: 'divisible_by: 1 (and no resolution_steps)',
    engineBehavior: "REFUSED at prompt validation — required_input_missing: this revision's ImageScaleToTotalPixels requires resolution_steps (INT, default 1); divisible_by is no longer a field and is silently dropped. Schema drift since the official-template port (2026-09-18). Found by this contract layer's first corpus pass.",
    violationType: 'schema-refused',
    opened: '2026-09-21',
    owner: 'the klein lane fix (emit resolution_steps; drop the dead key; golden regeneration)',
    note: 'Never executed live — same staging note as klein.cfg-guider-input-names.',
  },
  {
    id: 'music3.bitrate-unknown-input',
    surface: 'Music 3 core (buildMusic3Workflow → SaveAudioAdvanced)',
    emission: "bitrate: 'V0' alongside format: 'mp3'",
    engineBehavior: "SILENTLY DROPPED: SaveAudioAdvanced declares no 'bitrate' input (the mp3 sub-input is 'quality'); validation ignores unknown keys, so the value never reaches the encoder. The mp3 default quality is V0 — the intent lands by luck today, not by contract. Found by this contract layer's first audit pass.",
    violationType: 'silently-dropped',
    opened: '2026-09-21',
    owner: 'the music3 lane fix (emit the real sub-input or drop the dead key)',
  },
] as const

/** Divergence ids as a plain set — the exact-match signature for tests. */
export function knownDivergenceIds(): string[] {
  return KNOWN_DIVERGENCES.map((entry) => entry.id)
}
