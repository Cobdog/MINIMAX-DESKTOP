# Canvas document model — schema spec (DRAFT v0.1, co-designed with canvas-ui-v1 §2)

**Status:** DRAFT — companion to `docs/specs/canvas-ui-v1.md` §2 (the model)
and Flux o0xw49r (the ACs). The schema freeze blockers are closed (F3 global
asset store + fork-into-project; F5 retention tiers + tombstones + session
prune; F9 full versioning — all maintainer-decided 2026-09-14/15). F6
(failure propagation) and F8 (blob re-link mechanics) remain open-shaped and
are marked throughout. Substrate: **SQLite via better-sqlite3 + FTS5,
versioned migrations, copy-never-destroy** (foundation stack, unchanged;
"sync layer over SQLite, never a server DB" stands).

---

## 1. Tables (shape, not DDL)

- `project`: id, name, schema_version, camera (json: x/y/zoom), created_at,
  deleted_at (tombstone, indexed), last_active_at.
- `session`: singleton-ish row — open_projects (ordered ids), active_project.
- `chain`: id, project_id FK, kind, input_spec (json: the §2.1 recursion),
  op_stack_id FK, settings (json: engine params, identity payload id, anchor
  strength, sigma/sampler, keyframe guides), lock_state, hop_count,
  drift_metrics (json: per-join arcface/dE/seam), stale (derived-persisted:
  set by upstream changes, cleared on rerun), created_at, deleted_at.
- `output`: id, chain_id FK, substrates_available (json list).
- `take`: id, output_id FK, job_id FK, artifacts (json paths), latent_path,
  metrics (json), created_at, superseded_by (nullable take id), evicted
  (marker + eviction_date for retention tier 2), content_hash.
  **Append-only** — no UPDATE except superseded_by/evicted markers.
- `op_stack` + `op`: stack id; ops: ordinal, kind, settings (json), baked_at
  (null = live; set = irreversible marker), undo cursor support (ordinal
  reorder is an UPDATE of ordinals only).
- `identity_payload`: id, owner (chain), ref_asset_ids (json, ordered —
  wiring order is semantic), refmod_ids, subject_text (verbatim), strength
  (chain dial), per-slot strengths (json).
- `control_track`: id, chain_id FK, kind (canny/depth/HED/MLSD/pose/custom),
  source (extracted | authored | fetched), input_ref (blob), mask_ref
  (nullable), params (json).
- `asset` (GLOBAL — above projects): id, kind (character/location/wardrobe/
  refmod/prompt), fields (json), canonical_reference_set (→ takes, unified
  per L13), created_at, deleted_at.
- `asset_fork`: project_id FK, asset_id FK, forked_settings_snapshot (json),
  lineage (points home; global asset changes surface as upstream-stale on
  forks — same staleness machinery as chains), consent_at.
- `plan`: id, project_id FK, document (json: MoviePlanner inheritance —
  brief, segments[{chain_ref, time range}], gaps[{kind: cut|nle|flf|black|
  bridge}], per-segment reference handoffs).
- `job` (extend existing): + gpu_queue_state (active|queued_for_gpu),
  + plan_ref, + failure {stage, reason, ref} (diagnostics contract).
- `blob`: path, kind (video|image|latent|audio), content_hash, size,
  last_verified_at, missing (placeholder state), relinked_from (F8).

## 2. Migrations (F9 decided)

- Every table above carries schema_version at the document level (project,
  session, plan); `schema_migrations` (existing) gains document-level
  append-only entries: version N→N+1 functions, one-way, tested against
  golden fixtures of real documents. **Unknown-newer version = loud refusal**
  with a clear message naming the app version that wrote it. No ad-hoc
  on-open mangling.

## 3. Retention & GC (F5 decided)

- Tier 1 (always resident): canonical takes + takes referenced by a live
  fork edge + locked chains' takes.
- Tier 2 (evictable-with-marker): superseded priors — latent/blob deleted,
  row + metadata + low-res poster retained; restore = re-generation or
  re-fetch (settings persist — rerun-stable by invariant 1).
- GC = mark-and-sweep over fork edges, never reference-counting guesses;
  runs at session-prune or storage-pressure thresholds.
- Trash: tombstoned chains/canvases/projects restore fully (blobs retained
  for tombstoned entities until trash emptied — explicit destructive act).

## 4. FTS surfaces

Existing FTS5 index extended: chain prompts + asset fields + plan briefs
(command palette, L6), take/job metadata (summonable index), library
projection. Prompt-content search is a surface, not the palette's primary
role (L6 open-confirmed scope).

## 5. Open shapes (blocked on nothing, decided by schema-review)

- F6 failure propagation: the semantics table (spawn/block/skip per plan
  context; partial-take validation = a take whose job died mid-write is
  garbage-unless-decodes — validated at ingest, never trusted).
- F8 re-link UX: hash-match auto-relink over user-nominated roots.
- Macro/chain-template records (L12): likely a `chain_template` view over
  chains with fork-me markers — final shape at schema review.
