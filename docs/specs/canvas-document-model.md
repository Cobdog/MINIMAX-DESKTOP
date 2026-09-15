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
  refmod/prompt), fields (json), canonical_reference_set (whether this
  unifies on takes semantics is **L13 — OPEN proposal**, not decided),
  created_at, deleted_at.
- `asset_fork`: project_id FK, asset_id FK, forked_settings_snapshot (json),
  lineage (points home; stale-propagation from global-asset changes to
  forks is a PROPOSAL reusing the chain staleness machinery — semantics not
  yet decided), consent_at.
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
(command palette — scope is L6 OPEN; proposal: actions/objects/ops primary),
take/job metadata (summonable index), library projection.

## 5. Open shapes (blocked on nothing, decided by schema-review)

- F6 failure propagation: the semantics table (spawn/block/skip per plan
  context; partial-take validation = a take whose job died mid-write is
  garbage-unless-decodes — validated at ingest, never trusted).
- F8 re-link UX: hash-match auto-relink over user-nominated roots.
- Macro/chain-template records (L12): likely a `chain_template` view over
  chains with fork-me markers — final shape at schema review.

## 6. Import from current stores (DRAFT design — third-audit O3; the load-bearing D5/R3 item)

Copy-never-destroy, verify-then-mark (the established migration pattern):

- **jobs → outputs/takes**: every existing completed job becomes an output +
  canonical take on a synthesized `legacy` chain per job (settings imported
  from the job manifest where present — settings-results separation holds by
  construction: manifest = settings, artifacts = take). Failed jobs import
  as outputs with failure state (durable-on-object contract applies
  retroactively — visible, dismissable, never silent).
- **workspace → project settings**: the server workspace store seeds one
  initial project's chain-settings defaults; the old surface keeps reading
  the same tables until Phase 5.
- **libraries → global assets**: characters/locations/wardrobes/accessories
  import as global assets with their approved-reference sets (the L13
  question applies to the import shape — decided at schema review, before
  import ships).
- **prompt library → assets (kind: prompt)**: verbatim content, attribution
  footer follows (L11).
- **localStorage remnants**: the copy-verify-mark pattern from the
  foundation pass, unchanged.
- **Verification**: import runs once on first canvas boot; counts asserted
  (N jobs → N takes; blob hashes spot-verified); a `legacy_import` marker
  records completion; failures leave the source intact and retry clean.

## 7. Project archive format (L32 — defined early per its own rationale)

Export = one project's DB rows (project, chains, outputs, takes, ops,
control tracks, plan, asset_forks — NOT global assets; they ride by id +
hash manifest) + the blob tree (media + latents by content hash) in a single
archive (zip/zstd). Import = reverse, honoring schemaVersion (unknown-newer
refuses loudly per F9). The v1 export UI may be minimal; the FORMAT is fixed
now — every always-autosaved document created before this exists makes
retrofit harder.
