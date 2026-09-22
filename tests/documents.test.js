// Canvas document store test (Phase 0, docs/specs/canvas-document-model.md):
// boots the BUILT standalone server on a scratch port + scratch home (like
// the storage suite) and drives the document store end to end:
//   (a) migration 002: all §1 tables + triggers + jobs extension on a fresh
//       boot; golden-fixture N→N+1 (a 001-only db with real legacy rows
//       migrates forward byte-identically); history divergence = hard error
//   (b) CRUD + tombstone round-trips (project/chain/asset); trash retains
//       blobs; restore is full
//   (c) take append-only (invariant 2): UPDATE of payload columns aborts;
//       supersede/evict markers are the only legal mutations
//   (d) bake immutability (S10) + staleness propagation (invariant 3)
//   (e) §6 legacy import: counts asserted, blob hashes spot-checked, marker
//       set, retry clean, sources untouched
//   (f) retention/GC adversarials (§3): fork-edge liveness across a
//       tombstoned source chain, locked-chain takes, canonical never evicted,
//       session-scoped prune, trash-empty as the explicit destructive act
//   (g) §7 archive: export/import round-trip incl. blobs + global-asset
//       ride-by-id placeholders, cross-version refusal, id-collision refusal
//   (h) §4 FTS: chain/asset/plan/take/job surfaces, kind filter, injection
//   (i) unknown-newer document version refuses loudly (§2/F9); old surface
//       untouched (jobs upsert keeps the new columns)
//   (j) document-read cache + ETag (perf wave 1): hit/miss/304, and NO
//       STALE READS across every mutation route + external-connection
//       writes (fail-closed stamp invalidation)
// Run after `pnpm build` (the server + modules are loaded from dist-server).
//
// Vitest port (task z7ogmig, 2026-09-20) of scripts/test-documents.cjs:
// assertion bodies carry over verbatim; the linear main() became a beforeAll
// boot + one test per section (sequential within the file, so the
// cross-section state flow is unchanged); CWD-relative paths are now
// __dirname-anchored and ports draw from this suite's disjoint range
// (tests/lib/ports.cjs).
import { test, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const REPO = require('node:path').resolve(__dirname, '..')

const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const { makePortAllocator } = require('./lib/ports.cjs')
// Scratch-home ledger (Wave 4 test hygiene): every mkdtemp registers;
// afterAll tears them all down — per-run homes never leak again.
const { makeScratchDir, removeAllScratchDirs } = require('./lib/scratch.cjs')
afterAll(() => { void removeAllScratchDirs() })

const { migrations, migrateDatabase } = require(path.join(REPO, 'dist-server/server/db.js'))
const { packZip, unpackZip, MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES } = require(path.join(REPO, 'dist-server/server/documentArchive.js'))

const freePort = makePortAllocator('documents')

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const sha256File = (file) => sha256(fs.readFileSync(file))

function makeHome(label) {
  return makeScratchDir(path.join(os.tmpdir(), `minimax-documents-${label}-`))
}

/** Every server booted this run — the SUCCESS path and every FAILURE path
 *  kill them all (a spawned child holds its stdio pipes open, so a missed
 *  kill both orphans the server AND parks the runner in ep_poll forever:
 *  the merge-verification hang, and the 50-orphan leak on failed runs). */
const bootedServers = []
const killAllServers = () => {
  for (const child of bootedServers) {
    try {
      child.kill()
    } catch { /* already gone — the exit-status kill below stays honest */ }
  }
}
process.on('exit', killAllServers)

async function bootServer(home, label) {
  const output = { text: '', label }
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(REPO, 'dist-server', 'server', 'index.js')], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bootedServers.push(child)
  child.stdout.on('data', (chunk) => { output.text += String(chunk) })
  child.stderr.on('data', (chunk) => { output.text += String(chunk) })
  const deadline = Date.now() + 15_000
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/lan/settings`)
      if (response.ok && output.text.includes(`"port":${port}`)) return { child, port, home, output }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`${label} server did not become ready in 15 s`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  child.kill()
  throw new Error(`${label} server never announced its port`)
}

function client(port) {
  const base = `http://127.0.0.1:${port}`
  const get = async (pathname) => {
    const response = await fetch(base + pathname)
    const body = await response.json().catch(() => ({}))
    return { status: response.status, body }
  }
  const getRaw = async (pathname) => {
    const response = await fetch(base + pathname)
    return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), headers: response.headers }
  }
  const post = async (pathname, payload) => {
    const response = await fetch(base + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await response.json().catch(() => ({}))
    return { status: response.status, body }
  }
  return { get, getRaw, post }
}

let assertions = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  assertions += 1
}

// ---- cross-section state (sequential tests share it, as the linear main() did)
let canvasTables = []
let homeA = ''
let serverA = null
let api = null
let dbFileA = ''
let outDir = ''
let mediaFiles = []
let legacyJobs = []
let projectId = ''
let chainId = ''
let outputId = ''
let assetCreated = null
let archive = null
let manifest = null
let latentFiles = []
let serverA2 = null
let apiA2 = null

test('(a) migration: golden fixture N→N+1, fresh boot shape, 004 stray healing, divergence hard-error', () => {
  const fixtureDbFile = path.join(makeHome('fixture'), 'studio.db')
  const fixtureDb = new Database(fixtureDbFile)
  const migration001 = migrations.find((migration) => migration.id === 1)
  migration001.up(fixtureDb)
  fixtureDb.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  fixtureDb.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(1, '001-foundation', 0)
  // golden legacy rows — REAL document shapes from the old surface
  fixtureDb.prepare("INSERT INTO jobs (id, provider, media_type, mode, status, prompt, params_json, created_at, updated_at, error, width, height, duration, output_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('golden-1', 'minimax', null, 'text', 'completed', 'golden hour courtyard', '{"seed":7}', 100, 100, null, 1344, 768, 5, '/api/lan/media?source=output&path=%2Ftmp%2Fgolden.mp4')
  fixtureDb.prepare("INSERT INTO workspace_state (name, data_json, updated_at) VALUES ('create', '{\"mode\":\"reference\",\"prompt\":\"golden workspace\"}', 50)").run()
  fixtureDb.prepare("INSERT INTO saved_prompts (id, label, prompt, saved_at) VALUES ('golden-prompt', 'Golden', 'a golden prompt kept verbatim', 60)").run()
  fixtureDb.prepare("INSERT INTO projects (id, name, kind, data_json, updated_at) VALUES ('old-1', 'Old cut', 'movie', '{}', 70)").run()
  const goldenBefore = sha256(JSON.stringify({
    jobs: fixtureDb.prepare('SELECT * FROM jobs').all(),
    workspace: fixtureDb.prepare('SELECT * FROM workspace_state').all(),
    prompts: fixtureDb.prepare('SELECT * FROM saved_prompts').all(),
    projects: fixtureDb.prepare('SELECT * FROM projects').all(),
  }))
  const applied = migrateDatabase(fixtureDb) // applies 002 + 003 + 004 (one-way, append-only)
  check(applied === 3, `golden fixture migration applies exactly 002 + 003 + 004 (got ${applied})`)
  const goldenAfter = sha256(JSON.stringify({
    jobs: fixtureDb.prepare('SELECT id, provider, media_type, mode, status, prompt, params_json, created_at, updated_at, error, width, height, duration, output_url FROM jobs').all(),
    workspace: fixtureDb.prepare('SELECT * FROM workspace_state').all(),
    prompts: fixtureDb.prepare('SELECT * FROM saved_prompts').all(),
    projects: fixtureDb.prepare('SELECT * FROM projects').all(),
  }))
  check(goldenBefore === goldenAfter, 'legacy rows survive migration 002 byte-identically (copy-never-destroy)')
  canvasTables = fixtureDb.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'canvas%'").all().map((row) => row.name)
  for (const expected of ['canvas_project', 'canvas_session', 'canvas_chain', 'canvas_output', 'canvas_take', 'canvas_op_stack', 'canvas_op', 'canvas_identity_payload', 'canvas_control_track', 'canvas_asset', 'canvas_asset_fork', 'canvas_plan', 'canvas_blob', 'canvas_import_marker', 'canvas_fts']) {
    check(canvasTables.includes(expected), `migration 002 creates ${expected}`)
  }
  const fixtureColumns = fixtureDb.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name)
  for (const column of ['gpu_queue_state', 'plan_ref', 'failure_json']) check(fixtureColumns.includes(column), `jobs extension adds ${column}`)
  check(migrateDatabase(fixtureDb) === 0, 're-running migrations is a no-op (idempotent, one-way)')

  // --- migration 004: one-canonical-take partial unique index + healing ---
  // A pre-004 database can carry strays (the crash window the single-process
  // transaction could not close). The migration HEALS them (newest wins,
  // marker-only — nothing deleted) and then enforces the invariant at the
  // statement boundary.
  {
    const strayDb = new Database(path.join(makeHome('strays'), 'studio.db'))
    migrations.find((migration) => migration.id === 1).up(strayDb)
    migrations.find((migration) => migration.id === 2).up(strayDb)
    strayDb.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    strayDb.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (1, '001-foundation', 0)").run()
    strayDb.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (2, '002-canvas-documents', 0)").run()
    strayDb.prepare("INSERT INTO canvas_project (id, name, schema_version, camera_json, settings_defaults_json, app_version, created_at, last_active_at) VALUES ('p1', 'Strays', 1, '{}', '{}', 'test', 1, 1)").run()
    strayDb.prepare("INSERT INTO canvas_chain (id, project_id, kind, input_spec_json, settings_json, lock_state, hop_count, created_at) VALUES ('c1', 'p1', 'media', '{}', '{}', 'unlocked', 0, 1)").run()
    strayDb.prepare("INSERT INTO canvas_output (id, chain_id, substrates_available_json, created_at) VALUES ('o1', 'c1', '[]', 1)").run()
    strayDb.prepare("INSERT INTO canvas_output (id, chain_id, substrates_available_json, created_at) VALUES ('o2', 'c1', '[]', 1)").run()
    // o1: TWO strays (the crash window) + one already-superseded prior;
    // o2: a clean single canonical (must be untouched).
    strayDb.prepare("INSERT INTO canvas_take (id, output_id, artifacts_json, created_at) VALUES ('t-old', 'o1', '[]', 100)").run()
    strayDb.prepare("INSERT INTO canvas_take (id, output_id, artifacts_json, created_at, superseded_by) VALUES ('t-prior', 'o1', '[]', 200, 't-old')").run()
    strayDb.prepare("INSERT INTO canvas_take (id, output_id, artifacts_json, created_at) VALUES ('t-mid', 'o1', '[]', 300)").run()
    strayDb.prepare("INSERT INTO canvas_take (id, output_id, artifacts_json, created_at) VALUES ('t-new', 'o1', '[]', 400)").run()
    strayDb.prepare("INSERT INTO canvas_take (id, output_id, artifacts_json, created_at) VALUES ('t-clean', 'o2', '[]', 500)").run()
    const strayApplied = migrateDatabase(strayDb)
    check(strayApplied === 2, `the stray fixture applies exactly 003 + 004 (got ${strayApplied})`)
    const canonicalOf = (outputId) => strayDb.prepare('SELECT id FROM canvas_take WHERE output_id = ? AND superseded_by IS NULL').all(outputId).map((row) => row.id)
    check(JSON.stringify(canonicalOf('o1')) === JSON.stringify(['t-new']), `migration 004 heals strays to the newest take (got ${JSON.stringify(canonicalOf('o1'))})`)
    check(strayDb.prepare("SELECT superseded_by FROM canvas_take WHERE id = 't-mid'").get().superseded_by === 't-new', 'the healed stray is superseded BY the winner (marker semantics match appendTake)')
    check(strayDb.prepare("SELECT superseded_by FROM canvas_take WHERE id = 't-prior'").get().superseded_by === 't-old', 'an existing supersession marker is never rewritten')
    check(JSON.stringify(canonicalOf('o2')) === JSON.stringify(['t-clean']), 'a clean output is untouched by the heal')
    const indexInfo = strayDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'canvas_take_one_canonical'").get()
    check(Boolean(indexInfo), 'migration 004 creates the partial unique index')
    assert.throws(() => strayDb.prepare("INSERT INTO canvas_take (id, output_id, artifacts_json, created_at) VALUES ('t-invader', 'o1', '[]', 600)").run(), /UNIQUE/, 'a second non-superseded take per output is refused AT THE STATEMENT LEVEL (the index enforces the invariant)')
    assertions += 1
    strayDb.close()
  }

  const divergent = new Database(path.join(makeHome('diverge'), 'studio.db'))
  divergent.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  divergent.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (999, 'bogus', 0)").run()
  assert.throws(() => migrateDatabase(divergent), /diverges/, 'a persisted history that is not a prefix of the code list is a hard error')
  assertions += 1
  fixtureDb.close()
  divergent.close()
})

beforeAll(async () => {
  // =====================================================================
  // Boot server A + seed the OLD surface (import sources)
  // =====================================================================
  homeA = makeHome('a')
  serverA = await bootServer(homeA, 'A')
  api = client(serverA.port)
  dbFileA = path.join(homeA, 'studio.db')

  // real artifact files for hash spot-checks
  outDir = path.join(homeA, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  mediaFiles = ['one.mp4', 'two.mp4', 'three.mp4'].map((name, index) => {
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(`legacy-media-${index}-${Math.random()}`))
    return file
  })
  legacyJobs = [
    { id: 'doc-job-1', mode: 'text', status: 'completed', prompt: 'a lantern courtyard at dusk', createdAt: 1000, progress: 100, width: 1344, height: 768, duration: 5, outputUrl: `/api/lan/media?source=output&path=${encodeURIComponent(mediaFiles[0])}`, manifest: { seed: 11, steps: 30 } },
    { id: 'doc-job-2', mode: 'text', status: 'completed', prompt: 'neon rain on chrome', createdAt: 2000, progress: 100, width: 1344, height: 768, duration: 5, outputUrl: `/api/lan/media?source=output&path=${encodeURIComponent(mediaFiles[1])}`, manifest: { seed: 22 } },
    { id: 'doc-job-3', mode: 'audio', status: 'completed', prompt: 'low drone under rain', createdAt: 3000, progress: 100, width: 0, height: 0, duration: 8, outputUrl: `/api/lan/media?source=output&path=${encodeURIComponent(mediaFiles[2])}`, manifest: { seed: 33 } },
    { id: 'doc-job-4', mode: 'text', status: 'failed', prompt: 'a failed shot', createdAt: 4000, progress: 10, width: 0, height: 0, duration: 5, error: 'engine reset mid-render' },
    { id: 'doc-job-5', mode: 'text', status: 'running', prompt: 'an in-flight shot', createdAt: 5000, progress: 40, width: 0, height: 0, duration: 5 },
  ]
  const jobsPosted = await api.post('/api/lan/jobs', { jobs: legacyJobs })
  check(jobsPosted.status === 200 && jobsPosted.body.saved === 5, 'legacy jobs seed via the old surface')
  const workspacePosted = await api.post('/api/lan/workspace', { workspace: { mode: 'reference', prompt: 'legacy workspace seed', duration: 6, steps: 30 } })
  check(workspacePosted.status === 200, 'legacy workspace seeds via the old surface')
  const promptsPosted = await api.post('/api/lan/prompts', { entries: [
    { id: 'user.prompt-1', label: 'Lantern', prompt: 'A lantern-lit courtyard kept verbatim.', savedAt: 9 },
    { id: 'user.prompt-2', label: 'Rooftops', prompt: 'Neon rooftops after rain.', savedAt: 10 },
  ] })
  check(promptsPosted.status === 200, 'legacy user prompts seed via the old surface')
  // (The mobile companion's /api/lan/characters sync route was removed
  // 2026-09-20, Phase 0 — the character arm of the §6 import is exercised
  //  through the explicit documents import route instead.)
  const charactersPosted = await api.post('/api/lan/documents/import/legacy', { characters: [
    { id: 'char-mara', name: 'Mara', description: 'a courier with a lantern', referenceImages: ['/inputs/mara-1.png', '/inputs/mara-2.png'] },
    { id: 'char-olio', name: 'Olio', referenceImages: [] },
  ] })
  check(charactersPosted.status === 200 && charactersPosted.body.import.counts.characters === 2, 'legacy character library imports via the explicit documents import route')
})

afterAll(() => { killAllServers() })

test('(e) §6 legacy import — first canvas boot', async () => {
  const bootstrap = await api.get('/api/lan/documents/bootstrap')
  check(bootstrap.status === 200, 'documents bootstrap answers')
  check(bootstrap.body.legacyImport.imported === true, 'first canvas boot runs the legacy import (marker set)')
  const counts = bootstrap.body.legacyImport.counts
  check(counts.jobsSeen === 5, `import sees all 5 jobs (got ${counts.jobsSeen})`)
  check(counts.completedJobs === 3 && counts.takes === 3, `3 completed jobs -> 3 canonical takes (got ${counts.completedJobs}/${counts.takes})`)
  check(counts.failureOutputs === 1, `1 failed job -> 1 visible failure output (got ${counts.failureOutputs})`)
  check(counts.skippedRunning === 1, 'the running job is skipped (not a document yet)')
  check(counts.prompts === 2, `user prompts import as prompt assets, techniques excluded (got ${counts.prompts})`)
  check(counts.characters === 2, `character library imports as global assets (got ${counts.characters})`)
  check(counts.projectsSeeded === 1, 'the workspace seeds one initial project')
  check(counts.blobHashChecks === 3 && counts.blobHashMismatches === 0, `blob hashes spot-checked clean (got ${counts.blobHashChecks} checks, ${counts.blobHashMismatches} mismatches)`)

  const legacyDocument = await api.get('/api/lan/documents/project?id=legacy:project')
  check(legacyDocument.status === 200, 'the imported document reads back')
  check(legacyDocument.body.project.settingsDefaults.prompt === 'legacy workspace seed', 'workspace -> project chain-settings defaults (§6)')
  const legacyChains = legacyDocument.body.chains
  check(legacyChains.length === 4, `3 completed + 1 failed job -> 4 legacy chains (got ${legacyChains.length})`)
  const chainOne = legacyChains.find((chain) => chain.id === 'legacy:chain:doc-job-1')
  check(chainOne && chainOne.inputSpec.fresh.prompt === 'a lantern courtyard at dusk', 'legacy chain input spec carries the job prompt')
  check(chainOne.settings.seed === 11 && chainOne.settings.steps === 30, 'job manifest imports as chain settings (settings-results separation by construction)')
  const chainOneTake = chainOne.outputs[0].takes[0]
  check(chainOne.outputs[0].canonicalTakeId === chainOneTake.id, 'the completed job take is canonical')
  check(chainOneTake.contentHash === sha256File(mediaFiles[0]), 'take content hash matches the source media (blob hash spot-check)')
  const blobAbs = path.join(homeA, chainOneTake.artifacts[0])
  check(fs.existsSync(blobAbs) && sha256File(blobAbs) === chainOneTake.contentHash, 'the artifact landed in the content-addressed blob tree, hash-verified')
  const failedChain = legacyChains.find((chain) => chain.id === 'legacy:chain:doc-job-4')
  check(failedChain && failedChain.outputs.length === 1 && failedChain.outputs[0].takes.length === 0, 'failed job -> output with NO take (no fabricated result)')
  check(failedChain.settings.legacy.error === 'engine reset mid-render', 'the failure is visible on the imported object (F6 seam)')
  const failedJobRow = (() => {
    const db = new Database(dbFileA)
    const row = db.prepare("SELECT failure_json FROM jobs WHERE id = 'doc-job-4'").get()
    db.close()
    return row
  })()
  const failurePayload = JSON.parse(failedJobRow.failure_json)
  check(failurePayload.stage === 'legacy' && failurePayload.ref === 'doc-job-4', 'the failure is durable on the job row (jobs.failure_json)')

  // prompt + character assets
  const assets = await api.get('/api/lan/documents/assets')
  check(assets.status === 200, 'global asset store answers')
  const promptAsset = assets.body.assets.find((asset) => asset.id === 'legacy:prompt:user.prompt-1')
  check(promptAsset && promptAsset.fields.prompt === 'A lantern-lit courtyard kept verbatim.', 'prompt library -> assets(kind:prompt) verbatim')
  const characterAsset = assets.body.assets.find((asset) => asset.id === 'legacy:character:char-mara')
  check(characterAsset && characterAsset.canonicalReferenceSet.length === 2, 'libraries -> global assets as CURATED reference sets (L13 recorded-open, not takes)')

  // retry clean + sources untouched
  const rerun = await api.post('/api/lan/documents/import/legacy', {})
  check(rerun.status === 200, 'legacy import re-runs (force) cleanly')
  const legacyAfterRerun = await api.get('/api/lan/documents/project?id=legacy:project')
  check(legacyAfterRerun.body.chains.length === 4, 're-run creates no duplicates (deterministic ids)')
  const sourcesDb = new Database(dbFileA)
  const jobsUntouched = sourcesDb.prepare('SELECT COUNT(*) AS n FROM jobs').get().n
  const workspaceUntouched = sourcesDb.prepare("SELECT data_json FROM workspace_state WHERE name = 'create'").get().data_json
  const promptsUntouched = sourcesDb.prepare('SELECT COUNT(*) AS n FROM saved_prompts').get().n
  sourcesDb.close()
  check(jobsUntouched === 5, 'import never touches the jobs source (copy-never-destroy)')
  check(JSON.parse(workspaceUntouched).prompt === 'legacy workspace seed', 'import never touches the workspace source')
  check(promptsUntouched >= 10, 'import never touches the prompt library source')
})

test('(b)(c) CRUD + take append-only on a fresh project: supersession round-trip + trigger enforcement', async () => {
  const created = await api.post('/api/lan/documents/projects', { name: 'Document test' })
  check(created.status === 200 && created.body.project.schemaVersion >= 1, 'project create stamps schemaVersion')
  projectId = created.body.project.id
  const defaultsSet = await api.post('/api/lan/documents/projects/update', { id: projectId, settingsDefaults: { duration: 6, resolution: '1344x768' } })
  check(defaultsSet.status === 200, 'project chain-settings defaults set')

  const chainCreated = await api.post('/api/lan/documents/chains', { projectId, inputSpec: { fresh: { prompt: 'a quiet lighthouse at dawn' } }, settings: { seed: 99 } })
  check(chainCreated.status === 200 && chainCreated.body.chain.stale === false, 'chain create answers')
  chainId = chainCreated.body.chain.id
  check(chainCreated.body.chain.settings.seed === 99, 'chain settings persist')
  check(chainCreated.body.chain.settings.duration === 6, 'project settings-defaults seed new chains (workspace import payoff)')
  check(typeof chainCreated.body.chain.opStackId === 'string', 'chain create provisions an op stack')

  const outputCreated = await api.post('/api/lan/documents/outputs', { chainId, substrates: ['decoded'] })
  check(outputCreated.status === 200, 'output create answers')
  outputId = outputCreated.body.output.id

  // takes with real files (registered + hashed on ingest)
  latentFiles = []
  const takePayload = (index) => {
    const file = path.join(outDir, `take-${index}.latent`)
    fs.writeFileSync(file, Buffer.from(`latent-payload-${index}-${Math.random()}`))
    latentFiles.push(file)
    return { outputId, artifacts: [file], metrics: { width: 1344, height: 768 } }
  }
  const takeOne = await api.post('/api/lan/documents/takes', takePayload(1))
  const takeTwo = await api.post('/api/lan/documents/takes', takePayload(2))
  check(takeOne.status === 200 && takeTwo.status === 200, 'takes append')
  const takeOneId = takeOne.body.take.id
  const takeTwoId = takeTwo.body.take.id
  check(takeOne.body.take.contentHash && takeOne.body.take.contentHash === sha256File(latentFiles[0]), 'take artifact registered + content-hashed on ingest (invariant 9)')
  const takesAfterAppend = await api.get(`/api/lan/documents/takes?outputId=${outputId}`)
  check(takesAfterAppend.body.canonicalTakeId === takeTwoId, 'a newly appended take is canonical (pointer switch = supersession marker)')
  check(takesAfterAppend.body.takes.find((take) => take.id === takeOneId).supersededBy === takeTwoId, 'the prior is superseded, never deleted (invariant 2)')
  const reverted = await api.post('/api/lan/documents/takes/supersede', { outputId, takeId: takeOneId })
  check(reverted.status === 200, 'explicit pointer switch (revert to an earlier take) answers')
  const takesAfter = await api.get(`/api/lan/documents/takes?outputId=${outputId}`)
  check(takesAfter.body.canonicalTakeId === takeOneId, 'the reverted take is canonical again')
  check(takesAfter.body.takes.find((take) => take.id === takeTwoId).supersededBy === takeOneId, 'the displaced take is superseded by the restored canonical')
  // put the pointer back on takeTwo for the retention sections below
  const reReverted = await api.post('/api/lan/documents/takes/supersede', { outputId, takeId: takeTwoId })
  check(reReverted.status === 200 && (await api.get(`/api/lan/documents/takes?outputId=${outputId}`)).body.canonicalTakeId === takeTwoId, 'pointer returns to the newest take')

  // (c) take append-only, enforced by trigger
  const takeDb = new Database(dbFileA)
  assert.throws(
    () => takeDb.prepare('UPDATE canvas_take SET artifacts_json = ? WHERE id = ?').run('["tampered"]', takeOneId),
    /append-only/,
    'UPDATE of take payload columns must abort (invariant 2)',
  )
  assertions += 1
  takeDb.prepare('UPDATE canvas_take SET superseded_by = ? WHERE id = ?').run(takeTwoId, takeOneId) // idempotent marker write
  takeDb.close()
  assertions += 1
})

test('(d) ops bake immutability + identity/control-track upserts + staleness propagation + assets + plan/camera/session', async () => {
  // ops: add, reorder, bake, immutability
  const opOne = await api.post('/api/lan/documents/ops', { chainId, kind: 'crop', settings: { x: 0, y: 0, w: 100 } })
  const opTwo = await api.post('/api/lan/documents/ops', { chainId, kind: 'trim', settings: { start: 1, end: 4 } })
  check(opOne.status === 200 && opTwo.status === 200, 'ops append to the stack')
  const reordered = await api.post('/api/lan/documents/ops/reorder', { chainId, orderedIds: [opTwo.body.op.id, opOne.body.op.id] })
  check(reordered.status === 200 && reordered.body.ops[0].kind === 'trim', 'ordinal reorder (an UPDATE of ordinals only)')
  const baked = await api.post('/api/lan/documents/ops/bake', { id: opOne.body.op.id })
  check(baked.status === 200, 'bake sets the irreversible marker')
  const bakedUpdate = await api.post('/api/lan/documents/ops/update', { id: opOne.body.op.id, settings: { x: 999 } })
  check(bakedUpdate.status === 500, 'baked op settings are frozen (schema-enforced, surfaces as a structural 500)')
  const bakedDelete = await api.post('/api/lan/documents/ops/delete', { id: opOne.body.op.id })
  check(bakedDelete.status === 400 && /irreversible/i.test(bakedDelete.body.error ?? ''), 'baked ops cannot be deleted — a business-rule refusal answers 400 WITH the reason (cleanup wave: no opaque 500s)')
  const opDb = new Database(dbFileA)
  assert.throws(() => opDb.prepare('UPDATE canvas_op SET settings_json = ? WHERE id = ?').run('{}', opOne.body.op.id), /immutable/, 'bake immutability is trigger-enforced')
  assertions += 1
  opDb.close()

  // identity payload + control track (invariants 7, op separation)
  const identity = await api.post('/api/lan/documents/identity', { chainId, refAssetIds: ['legacy:character:char-mara'], subjectText: 'Mara the courier', strength: 0.6 })
  check(identity.status === 200 && identity.body.identity.refAssetIds.length === 1, 'identity payload upserts (ordered ref set is semantic)')
  const track = await api.post('/api/lan/documents/control-tracks', { chainId, kind: 'depth', source: 'extracted', inputRef: 'canvas-blobs/aa/deadbeef', params: { strength: 1 } })
  check(track.status === 200, 'control track adds')

  // staleness: fork chain B off the output, then edit upstream
  const forkChain = await api.post('/api/lan/documents/chains', { projectId, inputSpec: { outputRef: { outputId, substrate: 'decoded' } } })
  const forkChainId = forkChain.body.chain.id
  const upstreamEdit = await api.post('/api/lan/documents/chains/update', { id: chainId, settings: { seed: 100 } })
  check(upstreamEdit.status === 200, 'upstream settings edit applies')
  const forkAfter = await api.get(`/api/lan/documents/project?id=${projectId}`)
  const forkChainRow = forkAfter.body.chains.find((chain) => chain.id === forkChainId)
  check(forkChainRow.stale === true, 'upstream change marks downstream fork stale (invariant 3, persisted derived state)')
  const unstale = await api.post('/api/lan/documents/chains/update', { id: forkChainId, stale: false })
  check(unstale.status === 200 && unstale.body.chain.stale === false, 'stale clears on rerun (explicit)')

  // assets: global create + consent-gated fork into project
  assetCreated = await api.post('/api/lan/documents/assets', { kind: 'character', fields: { label: 'Harbormaster', description: 'keeps the light' }, canonicalReferenceSet: ['/inputs/harbor-1.png'] })
  check(assetCreated.status === 200, 'global asset create')
  const forkDenied = await api.post('/api/lan/documents/assets/fork', { projectId, assetId: assetCreated.body.asset.id })
  check(forkDenied.status === 400, 'fork-into-project without consent is refused (F3 consent gate)')
  const forkAllowed = await api.post('/api/lan/documents/assets/fork', { projectId, assetId: assetCreated.body.asset.id, consent: true, forkedSettings: { strength: 0.5 } })
  check(forkAllowed.status === 200, 'consented fork lands')
  const docWithFork = await api.get(`/api/lan/documents/project?id=${projectId}`)
  check(docWithFork.body.assetForks.length === 1 && docWithFork.body.assetForks[0].lineage.home === assetCreated.body.asset.id, 'fork record points home with lineage')

  // plan + camera + session (autosave always)
  const planCreated = await api.post('/api/lan/documents/plans', { projectId, document: { brief: 'A heist across foggy rooftops', segments: [{ chainRef: chainId, timeRange: [0, 5] }], gaps: [{ kind: 'cut' }] } })
  check(planCreated.status === 200, 'plan upsert')
  const cameraSaved = await api.post('/api/lan/documents/projects/update', { id: projectId, camera: { x: 120, y: -40, zoom: 1.5 } })
  check(cameraSaved.status === 200 && cameraSaved.body.project.camera.zoom === 1.5, 'camera state autosaves (invariant 10)')
  const sessionSaved = await api.post('/api/lan/documents/session', { openProjects: [projectId], activeProject: projectId })
  check(sessionSaved.status === 200 && sessionSaved.body.session.openProjects[0] === projectId, 'session persists open projects + active canvas')
  const sessionRead = await api.get('/api/lan/documents/session')
  check(sessionRead.body.session.activeProject === projectId, 'session reads back')
})

test('(f) retention/GC adversarials (§3): fork-edge liveness, locked/canonical protection, prune, trash round-trip, empty-trash', async () => {
  const gcProject = await api.post('/api/lan/documents/projects', { name: 'GC test' })
  const gcProjectId = gcProject.body.project.id
  const mkFile = (name) => {
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(`gc-${name}-${Math.random()}`))
    return file
  }
  // source chain A: prior + canonical (both file-backed; the second append
  // makes the first a tier-2 prior automatically)
  const gcSource = await api.post('/api/lan/documents/chains', { projectId: gcProjectId, inputSpec: { fresh: { prompt: 'gc source shot' } } })
  const gcSourceOutput = (await api.post('/api/lan/documents/outputs', { chainId: gcSource.body.chain.id })).body.output
  const gcPrior = await api.post('/api/lan/documents/takes', { outputId: gcSourceOutput.id, artifacts: [mkFile('gc-prior.latent')] })
  const gcCanonical = await api.post('/api/lan/documents/takes', { outputId: gcSourceOutput.id, artifacts: [mkFile('gc-canonical.latent')] })
  // fork of A's output (live edge)
  await api.post('/api/lan/documents/chains', { projectId: gcProjectId, inputSpec: { outputRef: { outputId: gcSourceOutput.id, substrate: 'decoded' } } })
  // locked chain with a prior
  const gcLocked = await api.post('/api/lan/documents/chains', { projectId: gcProjectId, lockState: 'locked', inputSpec: { fresh: { prompt: 'locked shot' } } })
  const gcLockedOutput = (await api.post('/api/lan/documents/outputs', { chainId: gcLocked.body.chain.id })).body.output
  const gcLockedPrior = await api.post('/api/lan/documents/takes', { outputId: gcLockedOutput.id, artifacts: [mkFile('gc-locked-prior.latent')] })
  const gcLockedNext = (await api.post('/api/lan/documents/takes', { outputId: gcLockedOutput.id, artifacts: [mkFile('gc-locked-canonical.latent')] })).body.take
  // plain live chain with a prior (prune target)
  const gcPlain = await api.post('/api/lan/documents/chains', { projectId: gcProjectId, inputSpec: { fresh: { prompt: 'plain shot' } } })
  const gcPlainOutput = (await api.post('/api/lan/documents/outputs', { chainId: gcPlain.body.chain.id })).body.output
  const gcPlainPrior = await api.post('/api/lan/documents/takes', { outputId: gcPlainOutput.id, artifacts: [mkFile('gc-plain-prior.latent')] })
  const gcPlainNext = await api.post('/api/lan/documents/takes', { outputId: gcPlainOutput.id, artifacts: [mkFile('gc-plain-canonical.latent')] })

  const blobPathOf = (takeResponse) => {
    const rel = takeResponse.body.take.artifacts[0]
    return { rel, abs: path.join(homeA, rel) }
  }
  const priorBlob = blobPathOf(gcPrior)
  const canonicalBlob = blobPathOf(gcCanonical)
  const lockedPriorBlob = blobPathOf(gcLockedPrior)
  const plainPriorBlob = blobPathOf(gcPlainPrior)
  const plainCanonicalBlob = blobPathOf(gcPlainNext)
  check(fs.existsSync(priorBlob.abs) && fs.existsSync(canonicalBlob.abs), 'gc fixture blobs are resident before sweep')

  // sweep 1: only the unprotected priors go
  const gcOne = await api.post('/api/lan/documents/gc', {})
  check(gcOne.status === 200 && gcOne.body.gc.evicted === 3, `first sweep evicts exactly the 3 unprotected priors (got ${gcOne.body.gc.evicted})`)
  check(!fs.existsSync(priorBlob.abs), 'superseded prior blob file deleted (tier 2, marker + metadata kept)')
  check(!fs.existsSync(plainPriorBlob.abs), 'plain prior evicted')
  check(fs.existsSync(lockedPriorBlob.abs), 'locked-chain prior file STILL PRESENT (tier 1)')
  check(fs.existsSync(path.join(homeA, gcLockedNext.artifacts[0])), 'locked-chain canonical file still present (tier 1)')
  const evictedRow = (() => {
    const db = new Database(dbFileA)
    const row = db.prepare('SELECT evicted, evicted_at, artifacts_json FROM canvas_take WHERE id = ?').get(gcPrior.body.take.id)
    db.close()
    return row
  })()
  check(evictedRow.evicted === 1 && evictedRow.evicted_at > 0, 'eviction marker + date recorded; row + metadata retained')
  check(JSON.parse(evictedRow.artifacts_json).length === 1, 'evicted take keeps its settings/metadata for re-generation (invariant 1 rerun-stable)')

  // THE adversarial: tombstone the SOURCE chain — the live fork edge keeps the
  // canonical take's latents resident. GC must never evict them.
  await api.post('/api/lan/documents/chains/delete', { id: gcSource.body.chain.id })
  const gcTwo = await api.post('/api/lan/documents/gc', {})
  check(gcTwo.status === 200 && gcTwo.body.gc.evicted === 0, `sweep after source tombstone evicts nothing new (got ${gcTwo.body.gc.evicted})`)
  check(fs.existsSync(canonicalBlob.abs), 'LIVE-FORK-REFERENCED take latents survive GC with a tombstoned source (invariant 4)')

  // session-scoped prune: canonical + locked untouchable, priors of live unlocked chains go
  const prune = await api.post('/api/lan/documents/prune', { projectIds: [gcProjectId] })
  check(prune.status === 200, 'session prune answers')
  check(prune.body.pruned.prunedTakes === 0, 'nothing left to prune in that project (priors already swept; canonical/locked never eligible)')
  const canonicalAfterPrune = await api.get(`/api/lan/documents/takes?outputId=${gcSourceOutput.id}`)
  check(canonicalAfterPrune.body.canonicalTakeId === gcCanonical.body.take.id, 'canonical take survives every sweep/prune')
  check(fs.existsSync(canonicalBlob.abs) && fs.existsSync(plainCanonicalBlob.abs), 'canonical blobs survive prune')

  // tombstone round-trip (trash retains blobs until explicitly emptied)
  const trashed = await api.post('/api/lan/documents/projects/delete', { id: gcProjectId })
  check(trashed.status === 200 && trashed.body.deleted === 1, 'project delete is a tombstone')
  const listed = await api.get('/api/lan/documents/projects')
  check(!listed.body.projects.some((project) => project.id === gcProjectId), 'tombstoned project leaves the live list')
  const trashList = await api.get('/api/lan/documents/projects?trash=1')
  check(trashList.body.projects.some((project) => project.id === gcProjectId), 'tombstoned project appears in trash')
  const gcThree = await api.post('/api/lan/documents/gc', {})
  check(gcThree.body.gc.evicted === 0, 'GC does not touch trash (blobs retained until empty)')
  check(fs.existsSync(canonicalBlob.abs), 'trash retains blobs (§3)')
  const restored = await api.post('/api/lan/documents/projects/restore', { id: gcProjectId })
  check(restored.status === 200 && restored.body.restored === 2, `project restore is FULL (project + its tombstoned chain; got ${restored.body.restored})`)
  const restoredDoc = await api.get(`/api/lan/documents/project?id=${gcProjectId}`)
  check(restoredDoc.body.chains.length === 4, 'restore is FULL: all chains back (tombstoned source included)')
  const restoredSource = restoredDoc.body.chains.find((chain) => chain.id === gcSource.body.chain.id)
  check(restoredSource.outputs[0].canonicalTakeId === gcCanonical.body.take.id, 'canonical pointer intact after round-trip')
  check(fs.existsSync(canonicalBlob.abs), 'blob intact after trash round-trip')

  // empty trash = explicit destructive act (requires confirm)
  await api.post('/api/lan/documents/projects/delete', { id: gcProjectId })
  const emptyUnconfirmed = await api.post('/api/lan/documents/trash/empty', {})
  check(emptyUnconfirmed.status === 400, 'empty-trash demands an explicit confirm')
  const emptyConfirmed = await api.post('/api/lan/documents/trash/empty', { confirm: 'empty-trash' })
  check(emptyConfirmed.status === 200 && emptyConfirmed.body.emptied.projects === 1, 'confirmed empty deletes the tombstoned project')
  const gone = await api.get('/api/lan/documents/projects?trash=1')
  check(!gone.body.projects.some((project) => project.id === gcProjectId), 'trash emptied')
  check(!fs.existsSync(canonicalBlob.abs), 'blob file removed with its last reference at empty-trash')
})

test('(h) §4 FTS surfaces + injection safety', async () => {
  const ftsChain = await api.get(`/api/lan/documents/search?${new URLSearchParams({ q: 'lighthouse' })}`)
  check(ftsChain.body.results.some((result) => result.source_id === chainId && result.source_kind === 'chain'), 'chain prompt is searchable')
  const ftsPlan = await api.get(`/api/lan/documents/search?${new URLSearchParams({ q: 'heist' })}`)
  check(ftsPlan.body.results.some((result) => result.source_kind === 'plan'), 'plan brief is searchable')
  const ftsAsset = await api.get(`/api/lan/documents/search?${new URLSearchParams({ q: 'Harbormaster' })}`)
  check(ftsAsset.body.results.some((result) => result.source_kind === 'asset' && result.source_id === assetCreated.body.asset.id), 'asset fields are searchable')
  const ftsJob = await api.get(`/api/lan/documents/search?${new URLSearchParams({ q: 'lantern', kind: 'job' })}`)
  check(ftsJob.body.results.some((result) => result.source_id === 'doc-job-1'), 'job metadata is searchable (live trigger on the old surface writes)')
  const ftsTake = await api.get(`/api/lan/documents/search?${new URLSearchParams({ q: 'chrome', kind: 'take' })}`)
  check(ftsTake.body.results.some((result) => result.source_kind === 'take'), 'take metadata (via its job) is searchable')
  const ftsInjection = await api.get(`/api/lan/documents/search?${new URLSearchParams({ q: '" OR 1=1 --' })}`)
  check(ftsInjection.status === 200 && ftsInjection.body.results.length <= 20, 'FTS injection attempt neither errors nor degenerates to all rows')
  const ftsLone = await api.get(`/api/lan/documents/search?${new URLSearchParams({ q: '"' })}`)
  check(ftsLone.status === 200, 'lone double quote must not error')
})

test('(h2) Phase 2 ingestion routes: bytes -> blob row -> served media', async () => {
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d4948445200000040000000400806000000', 'hex')
  const ingest = await api.post('/api/lan/documents/blobs/ingest', { data: pngBytes.toString('base64'), name: 'dropped-plate.png', kind: 'image' })
  check(ingest.status === 200 && ingest.body.path.includes('canvas-media') && ingest.body.blob.relPath.startsWith('canvas-blobs/'), 'ingest returns the engine-visible copy + the content-addressed blob path')
  check(typeof ingest.body.blob.hash === 'string' && ingest.body.blob.hash.length === 64, 'ingest hashes the bytes (invariant 9)')
  const served = await api.getRaw(`/api/lan/documents/blobs/file?${new URLSearchParams({ path: ingest.body.blob.relPath })}`)
  check(served.status === 200 && Buffer.compare(served.buffer.subarray(0, pngBytes.length), pngBytes) === 0, 'the blob file route serves the exact ingested bytes')
  const traversal = await api.get(`/api/lan/documents/blobs/file?${new URLSearchParams({ path: '../../studio.db' })}`)
  check(traversal.status === 404, 'blob serving is containment-gated (a traversal is an honest 404)')
  const unregistered = await api.get(`/api/lan/documents/blobs/file?${new URLSearchParams({ path: 'canvas-blobs/ff/not-registered' })}`)
  check(unregistered.status === 404, 'unregistered blob paths answer 404 (no fabricated content)')
  const badKind = await api.post('/api/lan/documents/blobs/ingest', { data: 'aGVsbG8=', name: 'x.bin', kind: 'document' })
  check(badKind.status === 400, 'ingest refuses unknown media kinds')
  const emptyBytes = await api.post('/api/lan/documents/blobs/ingest', { data: '', name: 'empty.png', kind: 'image' })
  check(emptyBytes.status === 400, 'ingest refuses empty payloads')
})

test('(i) unknown-newer refuses loudly; old surface untouched', async () => {
  const futureDb = new Database(dbFileA)
  futureDb.prepare("UPDATE canvas_project SET schema_version = 999, app_version = '9.9.9-future' WHERE id = 'legacy:project'").run()
  futureDb.close()
  const futureRead = await api.get('/api/lan/documents/project?id=legacy:project')
  check(futureRead.status === 400, 'unknown-newer document version is a LOUD refusal (400)')
  check(/schema version 999/.test(futureRead.body.error) && futureRead.body.error.includes('9.9.9-future'), 'the refusal names the version AND the writing app version (§2)')
  check(futureRead.body.error.includes('upgrade MiniMax Studio'), 'the refusal says what to do')

  // old surface byte-identical: job upsert keeps the canvas extension columns
  const queueSet = await api.post('/api/lan/documents/jobs/state', { id: 'doc-job-5', gpuQueueState: 'queued_for_gpu', planRef: 'plan-x' })
  check(queueSet.status === 200, 'job extension state set (gpu queue + plan ref)')
  const reupserted = await api.post('/api/lan/jobs', { jobs: [{ ...legacyJobs[4], progress: 55 }] })
  check(reupserted.status === 200, 'the old jobs upsert still works')
  const preservedDb = new Database(dbFileA)
  const preserved = preservedDb.prepare("SELECT gpu_queue_state, plan_ref FROM jobs WHERE id = 'doc-job-5'").get()
  preservedDb.close()
  check(preserved.gpu_queue_state === 'queued_for_gpu' && preserved.plan_ref === 'plan-x', 'old-surface job upsert never clobbers the canvas extension columns (zero impact)')
  const oldJobsListed = await api.get('/api/lan/jobs')
  check(oldJobsListed.status === 200 && oldJobsListed.body.jobs.length === 5, 'the old jobs listing still answers identically')
})

test('(g) §7 archive: round-trip into a fresh studio + refusals', async () => {
  const exportResponse = await api.getRaw(`/api/lan/documents/export?id=${projectId}`)
  check(exportResponse.status === 200 && exportResponse.headers.get('content-type') === 'application/zip', 'export answers with a zip')
  archive = exportResponse.buffer
  manifest = JSON.parse(unpackZip(archive).get('manifest.json'))
  check(manifest.format === 'minimax-canvas-archive' && manifest.schemaVersion >= 1, 'manifest carries format + schemaVersion')
  check(manifest.counts.takes === 2 && manifest.counts.chains === 2, 'manifest counts the exported document')
  check(manifest.blobs.length === 1 && manifest.missingBlobs.length === 2, `present + evicted + unregistered-ref blobs all ride in the manifest (got ${manifest.blobs.length} + ${manifest.missingBlobs.length})`)
  check(manifest.missingBlobs.some((blob) => blob.path === 'canvas-blobs/aa/deadbeef' && blob.hash === 'unregistered'), 'a referenced-but-unregistered path (legacy control ref / pre-blob latent) is VISIBLE in missingBlobs — never a silent omission')
  check(manifest.globalAssets.some((asset) => asset.id === assetCreated.body.asset.id), 'global assets ride by id + hash manifest (not as rows)')

  const homeB = makeHome('b')
  const serverB = await bootServer(homeB, 'B')
  const apiB = client(serverB.port)
  const freshBootstrap = await apiB.get('/api/lan/documents/bootstrap') // fresh studio: nothing to import
  // Phantom-seed regression (review M1, g5x37k8 2026-09-19): a fresh install
  // with NO legacy data must NOT grow an "Imported workspace" project — the
  // old unconditional seed handed every new user a Resume card for a
  // workspace they never had (and made the honest "no other canvases yet"
  // empty state unreachable). Failing-without-it: projectsSeeded was 1 here.
  check(freshBootstrap.body.legacyImport.imported === true, 'the legacy import runs (marker set) even with nothing to import')
  check(freshBootstrap.body.legacyImport.counts.projectsSeeded === 0, `a legacy-free fresh boot seeds NO project (got ${freshBootstrap.body.legacyImport.counts.projectsSeeded})`)
  const freshProjects = await apiB.get('/api/lan/documents/projects')
  check(!(freshProjects.body.projects ?? []).some((project) => project.id === 'legacy:project' || /Imported workspace/i.test(String(project.name))), 'no phantom "Imported workspace" on a fresh install')
  const imported = await apiB.post('/api/lan/documents/import', { archiveBase64: archive.toString('base64') })
  check(imported.status === 200, `archive imports into a fresh studio (${JSON.stringify(imported.body).slice(0, 200)})`)
  const importedDoc = await apiB.get(`/api/lan/documents/project?id=${projectId}`)
  check(importedDoc.status === 200 && importedDoc.body.chains.length === 2, 'imported document reads back with all chains')
  const importedTake = importedDoc.body.chains[0].outputs[0].takes[0]
  const importedBlobAbs = path.join(homeB, importedTake.artifacts[0])
  check(fs.existsSync(importedBlobAbs) && sha256File(importedBlobAbs) === importedTake.contentHash, 'blob tree restored content-addressed + hash-verified')
  check(imported.body.import.counts.placeholderAssets === 1, 'the referenced-but-absent global asset becomes a VISIBLE placeholder (never silent)')
  const importedFts = await apiB.get(`/api/lan/documents/search?${new URLSearchParams({ q: 'lighthouse' })}`)
  check(importedFts.body.results.some((result) => result.source_id === chainId), 'imported chains reindex into FTS')
  // m4 (cleanup wave): imported TAKES reindex too — they were silently
  // unsearchable before (the reindex covered chains + plans only).
  const importedTakeFts = await apiB.get(`/api/lan/documents/search?${new URLSearchParams({ q: 'canvas-blobs', kind: 'take' })}`)
  check(importedTakeFts.body.results.length >= 1, `imported takes reindex into FTS (got ${importedTakeFts.body.results.length} take hits — pre-reindex-fix this was 0)`)

  // unknown-newer archive/document versions refuse loudly
  const tamperedManifestArchive = (patch) => {
    const files = unpackZip(archive)
    const patched = JSON.parse(files.get('manifest.json'))
    Object.assign(patched, patch)
    files.set('manifest.json', Buffer.from(JSON.stringify(patched)))
    return packZip([...files.entries()].map(([name, data]) => ({ name, data })))
  }
  const refusedSchema = await apiB.post('/api/lan/documents/import', { archiveBase64: tamperedManifestArchive({ schemaVersion: 999 }).toString('base64') })
  check(refusedSchema.status === 400 && refusedSchema.body.error.includes('schema version 999'), 'unknown-newer document schema in an archive refuses loudly')
  const refusedFormat = await apiB.post('/api/lan/documents/import', { archiveBase64: tamperedManifestArchive({ archiveVersion: 999 }).toString('base64') })
  check(refusedFormat.status === 400 && refusedFormat.body.error.includes('archive (format)'), 'unknown-newer archive FORMAT refuses loudly')
  const collision = await apiB.post('/api/lan/documents/import', { archiveBase64: archive.toString('base64') })
  check(collision.status === 400 && /already exists/.test(collision.body.error ?? ''), 'importing onto a taken project id refuses loudly (documented seam: no silent re-id)')
})

test('correctness wave 1 (junllxf) part 1: shared-blob eviction survival, takeId-pinned priors, jobId-idempotent + stray-healing appendTake', async () => {
  // --- B1′: a shared content hash must survive the eviction of ONE take ---
  const sharedProject = await api.post('/api/lan/documents/projects', { name: 'Shared content' })
  const sharedProjectId = sharedProject.body.project.id
  const sharedBytes = Buffer.from(`shared-flf-continuation-frame-${Math.random()}`)
  const sharedFile = path.join(outDir, 'shared-frame.png')
  fs.writeFileSync(sharedFile, sharedBytes)
  const mkSharedChain = async (prompt) => {
    const chain = await api.post('/api/lan/documents/chains', { projectId: sharedProjectId, inputSpec: { fresh: { prompt } } })
    const output = await api.post('/api/lan/documents/outputs', { chainId: chain.body.chain.id })
    return { chainId: chain.body.chain.id, outputId: output.body.output.id }
  }
  const chainA1 = await mkSharedChain('segment A (canonical keeps the shared frame)')
  const chainB1 = await mkSharedChain('segment B (its prior gets evicted)')
  // BOTH outputs register the SAME bytes → the same canvas-blobs path.
  await api.post('/api/lan/documents/takes', { outputId: chainA1.outputId, artifacts: [sharedFile] })
  const sharedPriorTake = await api.post('/api/lan/documents/takes', { outputId: chainB1.outputId, artifacts: [sharedFile] })
  // supersede B's first take with a DIFFERENT second take, then sweep: the
  // prior is evictable, but the shared blob file is NOT — A's canonical
  // still serves it.
  const bSecondFile = path.join(outDir, 'b-second.png')
  fs.writeFileSync(bSecondFile, Buffer.from(`b-own-bytes-${Math.random()}`))
  await api.post('/api/lan/documents/takes', { outputId: chainB1.outputId, artifacts: [bSecondFile] })
  const sharedBlobRel = sharedPriorTake.body.take.artifacts[0]
  const sharedBlobAbs = path.join(homeA, sharedBlobRel)
  const sharedSweep = await api.post('/api/lan/documents/gc', {})
  check(sharedSweep.status === 200, 'shared-content sweep answers')
  check(fs.existsSync(sharedBlobAbs), 'SHARED blob file survives the eviction of one referencing take (B1′: FLF frames, fixed-seed reruns)')
  const sharedServe = await api.getRaw(`/api/lan/documents/blobs/file?path=${encodeURIComponent(sharedBlobRel)}`)
  check(sharedServe.status === 200 && sharedServe.buffer.equals(sharedBytes), 'the LIVE canonical take still serves the shared blob bytes')
  const sharedRow = (() => {
    const db = new Database(dbFileA)
    const row = db.prepare('SELECT missing FROM canvas_blob WHERE path = ?').get(sharedBlobRel)
    db.close()
    return row
  })()
  check(sharedRow && sharedRow.missing === 0, 'the shared blob row stays PRESENT (an eviction of one take never marks shared content missing)')

  // --- B1′: a fork edge pinning a PRIOR take by takeId keeps it resident ---
  const pinnedProject = await api.post('/api/lan/documents/projects', { name: 'Pinned prior' })
  const pinnedProjectId = pinnedProject.body.project.id
  const pinnedSource = await api.post('/api/lan/documents/chains', { projectId: pinnedProjectId, inputSpec: { fresh: { prompt: 'pinned source' } } })
  const pinnedOutput = (await api.post('/api/lan/documents/outputs', { chainId: pinnedSource.body.chain.id })).body.output
  const mkFile = (name) => {
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(`gc-${name}-${Math.random()}`))
    return file
  }
  const pinnedPrior = await api.post('/api/lan/documents/takes', { outputId: pinnedOutput.id, artifacts: [mkFile('pinned-prior.latent')] })
  await api.post('/api/lan/documents/takes', { outputId: pinnedOutput.id, artifacts: [mkFile('pinned-canonical.latent')] })
  // the fork edge pins the PRIOR take explicitly (fork-from-early-take)
  await api.post('/api/lan/documents/chains', {
    projectId: pinnedProjectId,
    inputSpec: { outputRef: { outputId: pinnedOutput.id, takeId: pinnedPrior.body.take.id, substrate: 'latents' } },
  })
  const pinnedSweep = await api.post('/api/lan/documents/gc', {})
  check(pinnedSweep.status === 200 && pinnedSweep.body.gc.evicted === 0, `a takeId-pinned prior is tier 1 — sweep evicts nothing (got ${pinnedSweep.body.gc?.evicted})`)
  check(fs.existsSync(path.join(homeA, pinnedPrior.body.take.artifacts[0])), 'the pinned prior take\'s latent stays resident (§3 live fork edge)')

  // --- M1′: appendTake is idempotent by jobId (two tabs / retry) ---
  const idemOutput = (await api.post('/api/lan/documents/outputs', { chainId: pinnedSource.body.chain.id })).body.output
  const idemFirst = await api.post('/api/lan/documents/takes', { outputId: idemOutput.id, jobId: 'job-idem-1', artifacts: [mkFile('idem.latent')] })
  const idemSecond = await api.post('/api/lan/documents/takes', { outputId: idemOutput.id, jobId: 'job-idem-1', artifacts: [mkFile('idem-2.latent')] })
  check(idemFirst.body.take.id === idemSecond.body.take.id, 'a repeat append for the same jobId returns the EXISTING take (idempotent write boundary)')
  const idemCount = (() => {
    const db = new Database(dbFileA)
    const row = db.prepare('SELECT COUNT(*) AS n FROM canvas_take WHERE job_id = ?').get('job-idem-1')
    db.close()
    return row.n
  })()
  check(idemCount === 1, `one take row per jobId — no duplicates, no duplicate FTS rows (got ${idemCount})`)

  // --- M2′: appendTake restores the one-canonical invariant (supersede ALL
  // strays, not just the first) inside one transaction ---
  const strayProject = await api.post('/api/lan/documents/projects', { name: 'Strays' })
  const strayChain = await api.post('/api/lan/documents/chains', { projectId: strayProject.body.project.id, inputSpec: { fresh: { prompt: 'stray source' } } })
  const strayOutput = (await api.post('/api/lan/documents/outputs', { chainId: strayChain.body.chain.id })).body.output
  {
    // Migration 004's partial unique index makes the crash-window stray
    // state UNREPRESENTABLE: a direct second non-superseded insert is
    // refused at the statement level (pre-index, this block created the
    // two-stray state to prove appendTake's healing — the healing itself
    // is now proven by the migration-004 fixture above; the ONE legacy
    // stray below still exercises appendTake's supersede-before-insert).
    const db = new Database(dbFileA)
    const insert = db.prepare('INSERT INTO canvas_take (id, output_id, job_id, artifacts_json, latent_path, metrics_json, created_at, superseded_by, evicted, evicted_at, content_hash) VALUES (?, ?, NULL, ?, NULL, NULL, ?, NULL, 0, NULL, NULL)')
    insert.run('stray-take-1', strayOutput.id, '[]', 1000)
    let refused = false
    try {
      insert.run('stray-take-2', strayOutput.id, '[]', 1001)
    } catch (error) {
      refused = /UNIQUE/.test(String(error))
    }
    db.close()
    check(refused, 'a second non-superseded take per output is refused by the partial unique index (the crash window is closed at the schema level)')
  }
  const healingTake = await api.post('/api/lan/documents/takes', { outputId: strayOutput.id, artifacts: [mkFile('healing.latent')] })
  const strayCounts = (() => {
    const db = new Database(dbFileA)
    const rows = db.prepare('SELECT id, superseded_by FROM canvas_take WHERE output_id = ?').all(strayOutput.id)
    db.close()
    return rows
  })()
  check(strayCounts.filter((row) => row.superseded_by === null).length === 1 && strayCounts.find((row) => row.id === healingTake.body.take.id).superseded_by === null, 'a new append supersedes EVERY stray — exactly one non-superseded take remains (invariant 2 restored, not assumed)')
})

test('correctness wave 1 part 2: torn-copy repair, poisoned-list isolation, locked staleness, plan CAS, FTS kind filter', async () => {
  const outDirLocal = outDir
  // re-find the stray output from part 1 via its healing take's output
  // (the ids flow across tests through the server's own state)
  const strayProjectListed = await api.get('/api/lan/documents/projects')
  const strayProjectRow = strayProjectListed.body.projects.find((project) => project.name === 'Strays')
  const strayDoc = await api.get(`/api/lan/documents/project?id=${strayProjectRow.id}`)
  const strayOutput = strayDoc.body.chains.find((chain) => chain.inputSpec?.fresh?.prompt === 'stray source').outputs[0]

  // --- M6: a torn copy at the canonical hash path is detected and repaired,
  // never served as verified content ---
  {
    const tornFile = path.join(outDirLocal, 'torn-video.mp4')
    fs.writeFileSync(tornFile, Buffer.from(`torn-content-${Math.random()}`))
    const tornTake = await api.post('/api/lan/documents/takes', { outputId: strayOutput.id, artifacts: [tornFile] })
    const tornRel = tornTake.body.take.artifacts[0]
    const tornAbs = path.join(homeA, tornRel)
    // simulate the crash/ENOSPC torn copy: truncate the canonical file
    fs.writeFileSync(tornAbs, fs.readFileSync(tornAbs).subarray(0, 5))
    const repairTake = await api.post('/api/lan/documents/takes', { outputId: strayOutput.id, artifacts: [tornFile] })
    check(repairTake.status === 200, 're-registering content over a torn dedupe target answers')
    check(sha256File(tornAbs) === tornTake.body.take.contentHash, 'the dedupe-skip path RE-VERIFIED and repaired the torn canonical file (size+hash, not trust)')
    // and the staged-copy discipline never leaves tmp files behind
    const tmpLeftovers = (() => {
      const found = []
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name.includes('.tmp-') || entry.name.includes('.importing-')) found.push(full)
        }
      }
      walk(path.join(homeA, 'canvas-blobs'))
      return found
    })()
    check(tmpLeftovers.length === 0, `no staged tmp/importing files survive in the blob tree (got ${tmpLeftovers.length})`)
  }

  // --- M4: one newer-schema project must not poison the project list ---
  const poisonedListing = await api.get('/api/lan/documents/projects')
  check(poisonedListing.status === 200, `the project list stays healthy with a poisoned row present (${poisonedListing.status})`)
  check(poisonedListing.body.projects.some((project) => project.id === projectId), 'the OLD projects still list (boot un-bricked)')
  check(poisonedListing.body.skipped?.some((entry) => entry.id === 'legacy:project' && entry.schemaVersion === 999), 'the newer-schema project is skipped AND reported per row')

  // --- M4′: locks gate staleness propagation (coherent with switchCanonical) ---
  {
    const lockProject = await api.post('/api/lan/documents/projects', { name: 'Lock propagation' })
    const lockProjectId = lockProject.body.project.id
    const upstream = await api.post('/api/lan/documents/chains', { projectId: lockProjectId, inputSpec: { fresh: { prompt: 'upstream' } } })
    const upstreamOutput = (await api.post('/api/lan/documents/outputs', { chainId: upstream.body.chain.id })).body.output
    const lockedDownstream = await api.post('/api/lan/documents/chains', { projectId: lockProjectId, lockState: 'locked', inputSpec: { outputRef: { outputId: upstreamOutput.id, substrate: 'decoded' } } })
    const plainDownstream = await api.post('/api/lan/documents/chains', { projectId: lockProjectId, inputSpec: { outputRef: { outputId: upstreamOutput.id, substrate: 'decoded' } } })
    await api.post('/api/lan/documents/chains/update', { id: upstream.body.chain.id, settings: { prompt: 'changed upstream settings' } })
    const lockDoc = await api.get(`/api/lan/documents/project?id=${lockProjectId}`)
    const lockedChain = lockDoc.body.chains.find((chain) => chain.id === lockedDownstream.body.chain.id)
    const plainChain = lockDoc.body.chains.find((chain) => chain.id === plainDownstream.body.chain.id)
    check(lockedChain.stale === false, 'a LOCKED downstream chain stays pristine (locks gate propagation)')
    check(plainChain.stale === true, 'an unlocked downstream chain goes stale on the same upstream change')
  }

  // --- M5: plan writes are compare-and-swap (lost-update window closed) ---
  {
    const planCreated = await api.post('/api/lan/documents/plans', { projectId, document: { brief: 'cas plan', segments: [], gaps: [] } })
    check(planCreated.status === 200, 'plan create answers')
    const planId = planCreated.body.plan.id
    const staleWrite = await api.post('/api/lan/documents/plans', { projectId, id: planId, document: { brief: 'written against v0', segments: [], gaps: [] }, expectedUpdatedAt: 1 })
    check(staleWrite.status === 409 && staleWrite.body.conflict?.currentDocument?.brief === 'cas plan', `a stale expectedUpdatedAt answers 409 with the current document (got ${staleWrite.status})`)
    const freshDoc = await api.get(`/api/lan/documents/project?id=${projectId}`)
    const freshUpdatedAt = freshDoc.body.plans.find((plan) => plan.id === planId).updatedAt
    const freshWrite = await api.post('/api/lan/documents/plans', { projectId, id: planId, document: { brief: 'written against the real version', segments: [], gaps: [] }, expectedUpdatedAt: freshUpdatedAt })
    check(freshWrite.status === 200, 'the current expectedUpdatedAt writes cleanly')
  }

  // --- m2: the FTS kind filter applies BEFORE the limit ---
  {
    const ftsProject = await api.post('/api/lan/documents/projects', { name: 'Kind filter' })
    const ftsChain = await api.post('/api/lan/documents/chains', { projectId: ftsProject.body.project.id, inputSpec: { fresh: { prompt: 'needle-in-a-haystack unique chain prompt zqx' } } })
    for (let index = 0; index < 30; index += 1) {
      await api.post('/api/lan/jobs', { jobs: [{ id: `fts-noise-${index}`, provider: 'minimax', mode: 'text', status: 'completed', prompt: 'needle', createdAt: Date.now() + index, width: 64, height: 64, duration: 1 }] })
    }
    // limit 1: pre-fix, the single slot goes to a short noise job and the
    // kind filter empties the result — the chain exists beyond the cut.
    const chainHits = await api.get(`/api/lan/documents/search?${new URLSearchParams({ q: 'needle', kind: 'chain', limit: '1' })}`)
    check(chainHits.status === 200 && chainHits.body.results.length === 1 && chainHits.body.results[0].source_id === ftsChain.body.chain.id, `kind-filtered search finds the chain past 30 noisier job rows at limit 1 (got ${JSON.stringify(chainHits.body.results)})`)
  }
})

test('correctness wave 1 part 3 (M5′ + B2): honest cancel contract + remote-output fetch-and-ingest against a mock engine', async () => {
  const mockEngine = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://mock.engine')
    if (request.method === 'GET' && url.pathname === '/queue') {
      // cancelPromptAt reads item[1] as the prompt id
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(mockEngineState.pending.length
        ? { queue_running: [], queue_pending: [[0, mockEngineState.pending[0]]] }
        : { queue_running: [], queue_pending: [] }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/queue') {
      mockEngineState.pending = []
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    if (request.method === 'POST' && url.pathname === '/interrupt') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/history/')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    if (request.method === 'GET' && url.pathname === '/view') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(mockEngineState.viewBytes)
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  const mockEngineState = { pending: [], viewBytes: Buffer.from(`remote-engine-output-${Math.random()}`) }
  const mockPort = await freePort()
  await new Promise((resolve) => mockEngine.listen(mockPort, '127.0.0.1', resolve))
  const settingsRead = await api.get('/api/lan/settings')
  const originalSettings = settingsRead.body.settings
  const redirected = await api.post('/api/lan/settings', { settings: { ...originalSettings, comfyUrl: `http://127.0.0.1:${mockPort}`, outputDirectory: outDir } })
  check(redirected.status === 200, 'settings redirect to the mock engine answers')

  // cancel of a prompt the engine never heard of: cancelled FALSE (M5′)
  const cancelUnknown = await api.post('/api/lan/cancel', { promptId: 'never-submitted' })
  check(cancelUnknown.status === 200 && cancelUnknown.body.cancelled === false && cancelUnknown.body.state === 'unknown', `an unknown prompt cancels honestly (got ${JSON.stringify(cancelUnknown.body)})`)
  // cancel of a queued prompt: cancelled TRUE + the queue state
  mockEngineState.pending = ['queued-prompt-1']
  const cancelPending = await api.post('/api/lan/cancel', { promptId: 'queued-prompt-1' })
  check(cancelPending.body.cancelled === true && cancelPending.body.state === 'pending', `a queued prompt cancels truthfully (got ${JSON.stringify(cancelPending.body)})`)

  // B2: fetch-and-ingest of a remote engine output
  const remoteIngest = await api.post('/api/lan/documents/blobs/ingest-output', { filename: 'Canvas_Remote_123.mp4', subfolder: 'video', type: 'output', kind: 'video' })
  check(remoteIngest.status === 200, `remote output ingest answers (${remoteIngest.status} ${JSON.stringify(remoteIngest.body).slice(0, 140)})`)
  check(remoteIngest.body.blob?.hash === sha256(mockEngineState.viewBytes) && remoteIngest.body.blob.present === true, 'the fetched output is hash-verified + registered present')
  check(fs.existsSync(remoteIngest.body.path) && remoteIngest.body.path.startsWith(outDir), 'the fetched output landed as an output-dir copy (durable, engine-visible)')
  const remoteBad = await api.post('/api/lan/documents/blobs/ingest-output', { filename: '../escape.mp4', kind: 'video' })
  check(remoteBad.status === 400, 'ingest-output refuses traversal filenames (the proxy validation)')

  await api.post('/api/lan/settings', { settings: originalSettings })
  mockEngine.close()
})

test('correctness wave 1 part 4 (B1 + M3′): latent durability + exports, control-track blob lifecycle', async () => {
  const mkFile = (name) => {
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(`gc-${name}-${Math.random()}`))
    return file
  }
  // --- B1: latents register durably + ride exports; unregistered ones are
  // visible in missingBlobs (never silently omitted) ---
  {
    const latentProject = await api.post('/api/lan/documents/projects', { name: 'Latent durability' })
    const latentProjectId = latentProject.body.project.id
    const latentChain = await api.post('/api/lan/documents/chains', { projectId: latentProjectId, inputSpec: { fresh: { prompt: 'latent chain' } } })
    const latentOutput = (await api.post('/api/lan/documents/outputs', { chainId: latentChain.body.chain.id })).body.output
    // the engine-side latent: an ABSOLUTE file under the output dir — the
    // landing path's resolved form, in the Motion-Context pack's REAL slot
    // shape (SaveLatent clip_index>0 → <prefix>_%05d.safetensors, 1-based)
    const latentFile = path.join(outDir, 'h3_context', 'chain-7f3a', 'clip_00001.safetensors')
    fs.mkdirSync(path.dirname(latentFile), { recursive: true })
    fs.writeFileSync(latentFile, Buffer.from(`latent-substrate-${Math.random()}`))
    const latentTake = await api.post('/api/lan/documents/takes', { outputId: latentOutput.id, artifacts: [mkFile('latent-media.mp4')], latentPath: latentFile })
    check(latentTake.body.take.latentPath?.startsWith('canvas-blobs/'), `an absolute existing real-format latent (clip_%05d.safetensors) registers into the blob tree (got ${latentTake.body.take.latentPath})`)
    const latentHash = sha256File(latentFile)
    const latentExport = await api.getRaw(`/api/lan/documents/export?id=${latentProjectId}`)
    const latentFilesInZip = unpackZip(latentExport.buffer)
    const latentManifest = JSON.parse(latentFilesInZip.get('manifest.json'))
    check(latentFilesInZip.has(`blobs/${latentHash}`) && latentManifest.blobs.some((blob) => blob.hash === latentHash && blob.kind === 'latent'), 'the latent substrate rides the archive export (bytes, not just metrics)')
    // the registered latent blob EVICTS with its superseded take: a newer
    // take makes the latent take a plain prior, the sweep frees the blob
    const latentBlobAbs = path.join(homeA, latentTake.body.take.latentPath)
    check(fs.existsSync(latentBlobAbs), 'the registered latent blob is resident in canvas-blobs before sweep')
    await api.post('/api/lan/documents/takes', { outputId: latentOutput.id, artifacts: [mkFile('latent-newer.mp4')] })
    const latentSweep = await api.post('/api/lan/documents/gc', {})
    check(latentSweep.status === 200 && latentSweep.body.gc.evicted >= 1, `the sweep runs after supersession (got ${latentSweep.body.gc.evicted} evictions)`)
    check(!fs.existsSync(latentBlobAbs), 'the superseded take’s real-format latent blob is evicted (durability composes with GC, not around it)')
    // a RELATIVE latent (the pre-fix form, still present on old rows) is at
    // least VISIBLE as missing on export
    const relativeLatentProject = await api.post('/api/lan/documents/projects', { name: 'Relative latent' })
    const relativeChain = await api.post('/api/lan/documents/chains', { projectId: relativeLatentProject.body.project.id, inputSpec: { fresh: { prompt: 'relative latent chain' } } })
    const relativeOutput = (await api.post('/api/lan/documents/outputs', { chainId: relativeChain.body.chain.id })).body.output
    const relativeTake = await api.post('/api/lan/documents/takes', { outputId: relativeOutput.id, artifacts: [mkFile('relative-media.mp4')], latentPath: 'h3_context/some-chain/clip_00001.safetensors' })
    check(relativeTake.body.take.latentPath === 'h3_context/some-chain/clip_00001.safetensors', 'a relative latent that does not resolve stays the raw string (honest, no fabricated blob)')
    const relativeExport = await api.getRaw(`/api/lan/documents/export?id=${relativeLatentProject.body.project.id}`)
    const relativeManifest = JSON.parse(unpackZip(relativeExport.buffer).get('manifest.json'))
    check(relativeManifest.missingBlobs.some((blob) => blob.path === 'h3_context/some-chain/clip_00001.safetensors' && blob.kind === 'latent'), 'an unresolvable .safetensors latent is RECORDED as kind=latent in missingBlobs (the pack’s real extension, visible, never silently dropped)')
  }

  // --- M3′: control tracks register their media; exports carry it; trash
  // emptying never deletes a live track's blob ---
  {
    const trackProject = await api.post('/api/lan/documents/projects', { name: 'Control tracks' })
    const trackProjectId = trackProject.body.project.id
    const trackChain = await api.post('/api/lan/documents/chains', { projectId: trackProjectId, inputSpec: { fresh: { prompt: 'posed shot' } } })
    const sheetFile = path.join(outDir, 'pose-sheet.png')
    fs.writeFileSync(sheetFile, Buffer.from(`pose-sheet-pixels-${Math.random()}`))
    const track = await api.post('/api/lan/documents/control-tracks', { chainId: trackChain.body.chain.id, kind: 'pose', source: 'pose-rig', inputRef: sheetFile })
    check(track.status === 200 && track.body.controlTrack.id, 'control track create answers')
    const trackDoc = await api.get(`/api/lan/documents/project?id=${trackProjectId}`)
    const trackRow = trackDoc.body.chains[0].controlTracks[0]
    check(trackRow.inputRef.startsWith('canvas-blobs/'), `the control track stores the REGISTERED blob reference (got ${trackRow.inputRef})`)
    const trackBlobAbs = path.join(homeA, trackRow.inputRef)
    check(fs.existsSync(trackBlobAbs) && sha256File(trackBlobAbs) === sha256File(sheetFile), 'the control-track blob is content-addressed on disk')
    const trackExport = await api.getRaw(`/api/lan/documents/export?id=${trackProjectId}`)
    const trackFiles = unpackZip(trackExport.buffer)
    const trackManifest = JSON.parse(trackFiles.get('manifest.json'))
    check(trackManifest.blobs.some((blob) => blob.path === trackRow.inputRef), 'the control-track media rides the archive export (M3′: pose-rig sheets keep their bytes)')
    // emptying the trash of unrelated content must not delete the track's blob
    const trashAsset = await api.post('/api/lan/documents/assets', { id: 'track:trash:asset', kind: 'prompt', fields: { label: 'trashme' } })
    await api.post('/api/lan/documents/assets/delete', { id: trashAsset.body.asset.id })
    const trashEmptied = await api.post('/api/lan/documents/trash/empty', { confirm: 'empty-trash' })
    check(trashEmptied.status === 200, 'trash empty answers')
    check(fs.existsSync(trackBlobAbs), 'the live control track\'s blob survives an unrelated trash-empty (referencedNow includes tracks)')
  }
})

test('correctness wave 1 part 5 (M3): shared-blob archive import upserts; a failed import leaves NOTHING behind', async () => {
  const homeC = makeHome('c')
  const serverC = await bootServer(homeC, 'C')
  const apiC = client(serverC.port)
  await apiC.get('/api/lan/documents/bootstrap')
  // studio C ALREADY has the archive's blob content registered (the same
  // bytes ingested by an unrelated project) — the import must upsert over
  // the existing canvas_blob row instead of aborting on the path PK.
  const cProject = await apiC.post('/api/lan/documents/projects', { name: 'C local' })
  const cChain = await apiC.post('/api/lan/documents/chains', { projectId: cProject.body.project.id, inputSpec: { fresh: { prompt: 'c chain' } } })
  const cOutput = (await apiC.post('/api/lan/documents/outputs', { chainId: cChain.body.chain.id })).body.output
  const sharedAgain = path.join(homeC, 'same-bytes.latent')
  fs.writeFileSync(sharedAgain, fs.readFileSync(latentFiles[1]))
  await apiC.post('/api/lan/documents/takes', { outputId: cOutput.id, artifacts: [sharedAgain] })
  const sharedImport = await apiC.post('/api/lan/documents/import', { archiveBase64: archive.toString('base64') })
  check(sharedImport.status === 200, `importing an archive whose blob rows already exist UPSERTS instead of PK-aborting (${sharedImport.status} ${JSON.stringify(sharedImport.body).slice(0, 160)})`)
  const cBlobCount = (() => {
    const db = new Database(path.join(homeC, 'studio.db'))
    const rows = db.prepare('SELECT path, missing FROM canvas_blob').all()
    db.close()
    return rows
  })()
  check(cBlobCount.filter((row) => row.path === manifest.blobs[0].path).length === 1 && cBlobCount.find((row) => row.path === manifest.blobs[0].path).missing === 0, 'the shared blob row is single and PRESENT after import')

  // failed import after blob staging: rows roll back AND no staged file
  // survives ("a failure leaves nothing behind")
  const failFiles = unpackZip(archive)
  const failDocument = JSON.parse(failFiles.get('document.json'))
  failDocument.project.id = 'rollback:project'
  for (const chain of failDocument.chains) chain.project_id = 'nonexistent-project' // FK abort AFTER blob staging
  failFiles.set('document.json', Buffer.from(JSON.stringify(failDocument)))
  const failManifest = JSON.parse(failFiles.get('manifest.json'))
  failManifest.projectId = 'rollback:project'
  failFiles.set('manifest.json', Buffer.from(JSON.stringify(failManifest)))
  const failArchive = packZip([...failFiles.entries()].map(([name, data]) => ({ name, data })))
  const failedImport = await apiC.post('/api/lan/documents/import', { archiveBase64: failArchive.toString('base64') })
  check(failedImport.status === 400, `the doomed import fails loudly (${failedImport.status})`)
  const stagedLeftovers = (() => {
    const found = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.includes('.importing-')) found.push(full)
      }
    }
    walk(path.join(homeC, 'canvas-blobs'))
    return found
  })()
  check(stagedLeftovers.length === 0, `a failed import un-stages its blob payloads (got ${stagedLeftovers.length} leftovers)`)
  const rollbackProject = await apiC.get('/api/lan/documents/project?id=rollback:project')
  check(rollbackProject.status === 404, 'the rolled-back project left no rows behind')
  serverC.child.kill()
})

test('(g2) security hardening 1: archive column allowlist + zip resource caps', async () => {
  // SQL injection through column names: a crafted take key rewrites the
  // INSERT into an attacker-shaped statement. Pre-fix this import SUCCEEDED
  // (the injected row landed); the allowlist must refuse the whole import.
  // Runs against a FRESH studio (server D) so the id-collision refusal
  // cannot mask the column verdict.
  {
    const homeD = makeHome('d')
    const serverD = await bootServer(homeD, 'D')
    const apiD = client(serverD.port)
    await apiD.get('/api/lan/documents/bootstrap')
    const craftTakeInjection = () => {
      const files = unpackZip(archive)
      const document = JSON.parse(files.get('document.json'))
      const realOutputId = document.takes[0].output_id
      document.takes = [{
        [`id, output_id, artifacts_json, created_at) VALUES(?, '${realOutputId}', '["injected"]', 1750000000000) -- `]: 'injected-take-id',
      }]
      files.set('document.json', Buffer.from(JSON.stringify(document)))
      return packZip([...files.entries()].map(([name, data]) => ({ name, data })))
    }
    const injected = await apiD.post('/api/lan/documents/import', { archiveBase64: craftTakeInjection().toString('base64') })
    check(injected.status === 400 && /unknown canvas_take column/i.test(injected.body.error ?? ''), `a column-name injection in the archive is refused loudly (${JSON.stringify(injected.body).slice(0, 160)})`)
    const injectedDoc = await apiD.get(`/api/lan/documents/project?id=${projectId}`)
    check(injectedDoc.status === 404, 'the refused import left nothing behind (transaction rollback)')
    // A benign-but-unknown key is equally refused (no silent column drops).
    const benignUnknown = (() => {
      const files = unpackZip(archive)
      const document = JSON.parse(files.get('document.json'))
      document.takes[0].not_a_real_column = 1
      files.set('document.json', Buffer.from(JSON.stringify(document)))
      return packZip([...files.entries()].map(([name, data]) => ({ name, data })))
    })()
    const refusedUnknown = await apiD.post('/api/lan/documents/import', { archiveBase64: benignUnknown.toString('base64') })
    check(refusedUnknown.status === 400 && /not_a_real_column/.test(refusedUnknown.body.error ?? ''), 'an unknown archive column refuses the import naming the column')

    // One-canonical-take invariant (migration 004): an archive carrying TWO
    // non-superseded takes for one output is a store-invariant violation —
    // the partial unique index refuses it at the statement level and the
    // import answers 400 WITH THE REASON (pre-index this imported
    // "successfully", stranding two canonical takes).
    const twoCanonical = (() => {
      const files = unpackZip(archive)
      const document = JSON.parse(files.get('document.json'))
      const original = document.takes[0]
      document.takes = [original, { ...original, id: `${original.id}-second-canonical` }].map((take) => ({ ...take, superseded_by: null }))
      files.set('document.json', Buffer.from(JSON.stringify(document)))
      return packZip([...files.entries()].map(([name, data]) => ({ name, data })))
    })()
    const refusedCanonical = await apiD.post('/api/lan/documents/import', { archiveBase64: twoCanonical.toString('base64') })
    check(refusedCanonical.status === 400 && /store invariant/i.test(refusedCanonical.body.error ?? ''), `a two-canonical-take archive is refused with the reason (got ${refusedCanonical.status} ${JSON.stringify(refusedCanonical.body).slice(0, 140)})`)
    const refusedDoc = await apiD.get(`/api/lan/documents/project?id=${projectId}`)
    check(refusedDoc.status === 404, 'the invariant-refused import left nothing behind')

    // Business-rule refusals answer 400/404 with the reason (cleanup wave):
    // never an opaque 500.
    const bogusTake = await apiD.post('/api/lan/documents/takes', { outputId: 'no-such-output', artifacts: [] })
    check(bogusTake.status === 404 && /no-such-output/i.test(bogusTake.body.error ?? ''), `a take append on a missing output answers 404 with the reason (got ${bogusTake.status} ${JSON.stringify(bogusTake.body).slice(0, 120)})`)
    const malformed = await fetch(`http://127.0.0.1:${serverD.port}/api/lan/documents/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json' })
    check(malformed.status === 400 && /not valid JSON/i.test(String((await malformed.json()).error)), `a malformed JSON body answers 400 (got ${malformed.status})`)

    // Zip resource caps: entry count, declared size, and lying headers.
    const eocdOf = (buffer) => {
      for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 22 - 65_536); index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) return index
      }
      throw new Error('no EOCD')
    }
    assert.throws(() => {
      const buffer = Buffer.from(packZip([{ name: 'manifest.json', data: Buffer.from('{}') }]))
      buffer.writeUInt16LE(MAX_ZIP_ENTRIES + 1, eocdOf(buffer) + 10) // EOCD total-entries field
      unpackZip(buffer)
    }, /too many entries/, 'an over-cap entry count is refused')
    assertions += 1
    assert.throws(() => {
      const buffer = Buffer.from(packZip([{ name: 'manifest.json', data: Buffer.from('{}') }]))
      const central = buffer.readUInt32LE(eocdOf(buffer) + 16)
      buffer.writeUInt32LE(MAX_ZIP_ENTRY_BYTES + 1, central + 24)
      unpackZip(buffer)
    }, /oversized payload/, 'an over-cap declared entry size is refused before inflation')
    assertions += 1
    assert.throws(() => {
      const zeros = Buffer.alloc(4096)
      const buffer = Buffer.from(packZip([{ name: 'bomb.json', data: zeros }]))
      const central = buffer.readUInt32LE(eocdOf(buffer) + 16)
      buffer.writeUInt32LE(10, central + 24) // header lies: declares 10 bytes
      unpackZip(buffer)
    }, /inflated to/, 'a lying uncompressed-size header is refused after bounded inflation')
    assertions += 1
    serverD.child.kill()
  }
})

test('restart = migrations no-op + document stability', async () => {
  serverA.child.kill()
  await new Promise((resolve) => setTimeout(resolve, 400))
  serverA2 = await bootServer(homeA, 'A2')
  apiA2 = client(serverA2.port)
  const afterRestart = await apiA2.get(`/api/lan/documents/project?id=${projectId}`)
  check(afterRestart.status === 200 && afterRestart.body.chains.length === 2 && afterRestart.body.project.camera.zoom === 1.5, 'restart re-opens the document unchanged (append-only migrations, autosave stable)')
  const sessionAfterRestart = await apiA2.get('/api/lan/documents/session')
  check(sessionAfterRestart.body.session.activeProject === projectId, 'session survives restart')
  const importStatusAfterRestart = await apiA2.get('/api/lan/documents/bootstrap')
  check(importStatusAfterRestart.body.legacyImport.imported === true, 'the legacy-import marker survives restart (never re-imports)')
})

test('(g3) security hardening 1: blob-registration source scoping', async () => {
  // Route-level proof that uploads (output-contained) still register.
  const scopedOutput = path.join(homeA, 'scoped-output')
  fs.mkdirSync(scopedOutput, { recursive: true })
  const currentSettings = (await apiA2.get('/api/lan/settings')).body.settings
  const scopedSettings = await apiA2.post('/api/lan/settings', { settings: { ...currentSettings, outputDirectory: scopedOutput } })
  check(scopedSettings.status === 200, 'pointing the output directory at a scratch dir succeeds')
  const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const ingested = await apiA2.post('/api/lan/documents/blobs/ingest', { kind: 'image', name: 'probe.png', data: onePixel.toString('base64') })
  check(ingested.status === 200 && ingested.body.blob?.present === true, 'an output-contained upload still registers as a blob')

  // The arbitrary-file-read primitive: an out-of-scope source (outside the
  // studio home AND the output directory) must NOT be copied into the
  // content-addressed tree and must NOT become servable. The take keeps
  // the plain string; the would-be blob path 404s.
  const outsideHome = makeHome('outside')
  const secretFile = path.join(outsideHome, 'secret.txt')
  const secretBytes = Buffer.from(`secret-bytes-${Math.random()}`)
  fs.writeFileSync(secretFile, secretBytes)
  const scopeProject = (await apiA2.post('/api/lan/documents/projects', { name: 'Scope test' })).body.project
  const scopeChain = (await apiA2.post('/api/lan/documents/chains', { projectId: scopeProject.id, inputSpec: { fresh: { prompt: 'scope shot' } } })).body.chain
  const scopeOutput = (await apiA2.post('/api/lan/documents/outputs', { chainId: scopeChain.id })).body.output
  const refusedTake = await apiA2.post('/api/lan/documents/takes', { outputId: scopeOutput.id, artifacts: [secretFile] })
  check(refusedTake.status === 200, 'appending a take with an out-of-scope artifact still succeeds (the STRING is kept)')
  check(refusedTake.body.take.artifacts[0] === secretFile, `the out-of-scope artifact is stored as the plain string, never registered (got ${JSON.stringify(refusedTake.body.take.artifacts[0])})`)
  const wouldBeRelPath = path.join('canvas-blobs', sha256(secretBytes).slice(0, 2), sha256(secretBytes))
  const refusedBlob = await apiA2.getRaw(`/api/lan/documents/blobs/file?path=${encodeURIComponent(wouldBeRelPath)}`)
  check(refusedBlob.status === 404, `the would-be blob path must NOT serve the secret bytes (got ${refusedBlob.status})`)

  // In-scope control: a studio-home file still registers.
  const inHomeFile = path.join(outDir, 'scope-control.latent')
  fs.writeFileSync(inHomeFile, Buffer.from(`scope-control-${Math.random()}`))
  const controlTake = await apiA2.post('/api/lan/documents/takes', { outputId: scopeOutput.id, artifacts: [inHomeFile] })
  check(controlTake.status === 200 && controlTake.body.take.artifacts[0].startsWith(`canvas-blobs${path.sep}`), `an in-scope artifact still registers into the blob tree (got ${JSON.stringify(controlTake.body.take.artifacts[0])})`)
  const controlBlob = await apiA2.getRaw(`/api/lan/documents/blobs/file?path=${encodeURIComponent(controlTake.body.take.artifacts[0])}`)
  check(controlBlob.status === 200, 'the registered in-scope blob serves')
})

test('(j) document-read cache + ETag (perf wave 1): hit/miss/304 and NO STALE READS across every mutation route + external-connection writes', async () => {
  const base = `http://127.0.0.1:${serverA2.port}`
  const project = (await apiA2.post('/api/lan/documents/projects', { name: 'read-cache' })).body.project
  const chain = (await apiA2.post('/api/lan/documents/chains', { projectId: project.id, inputSpec: { fresh: { prompt: 'cache probe' } } })).body.chain
  const output = (await apiA2.post('/api/lan/documents/outputs', { chainId: chain.id })).body.output
  await apiA2.post('/api/lan/documents/takes', { outputId: output.id, artifacts: [], metrics: { kind: 'image', name: 'cache-probe' } })

  const docPath = `/api/lan/documents/project?id=${encodeURIComponent(project.id)}`
  const fetchDoc = async (etag) => {
    const response = await fetch(base + docPath, { headers: etag ? { 'if-none-match': etag } : {} })
    return { status: response.status, etag: response.headers.get('etag'), cache: response.headers.get('x-minimax-document-cache'), body: await response.text() }
  }

  const first = await fetchDoc()
  check(first.status === 200 && first.cache === 'miss' && typeof first.etag === 'string' && first.etag.length > 8, 'first read is a cache miss carrying a content ETag')
  const second = await fetchDoc()
  check(second.status === 200 && second.cache === 'hit' && second.etag === first.etag && second.body === first.body, 'unchanged re-read is a cache hit with a byte-identical body')
  const notModified = await fetchDoc(first.etag)
  check(notModified.status === 304 && notModified.body === '' && notModified.etag === first.etag, 'a matching If-None-Match answers 304 with no body')

  /** Mutate → the read MUST be rebuilt AND show the change; the OLD etag
   *  MUST re-validate. changeCheck receives the parsed fresh document. */
  const expectFresh = async (label, mutate, changeCheck) => {
    const before = await fetchDoc()
    const etagBefore = before.etag
    const mutation = await mutate()
    if (mutation && typeof mutation === 'object' && 'status' in mutation) {
      check(mutation.status === 200, `${label}: the mutation route answered 200 (got ${mutation.status}: ${JSON.stringify(mutation.body ?? {}).slice(0, 160)})`)
    }
    const after = await fetchDoc()
    check(after.status === 200, `${label}: read answers after the write`)
    check(after.cache === 'miss', `${label}: the cached entry was dropped (no stale serve)`)
    const parsed = JSON.parse(after.body)
    check(changeCheck(parsed), `${label}: the fresh document reflects the change`)
    check(after.etag !== etagBefore, `${label}: the content ETag moved`)
    const revalidate = await fetchDoc(etagBefore)
    check(revalidate.status === 200, `${label}: a conditional read with the pre-write ETag re-validates (never 304)`)
    return parsed
  }
  /** Write that cannot change THIS document (other tables): the entry
   *  still drops (fail-closed stamp), content is identical. */
  const expectDroppedOnly = async (label, mutate) => {
    await mutate()
    const after = await fetchDoc()
    check(after.status === 200 && after.cache === 'miss', `${label}: the global stamp dropped the entry (over-invalidation by design)`)
  }

  const chainsOf = (doc) => doc.chains.filter((entry) => entry.id === chain.id)
  await expectFresh('rename project', () => apiA2.post('/api/lan/documents/projects/update', { id: project.id, name: 'read-cache-2' }), (doc) => doc.project.name === 'read-cache-2')
  await expectFresh('project camera autosave', () => apiA2.post('/api/lan/documents/projects/update', { id: project.id, camera: { camera: { x: 123, y: 5, k: 0.9 }, layout: {} } }), (doc) => doc.project.camera?.camera?.x === 123)
  await expectFresh('chain create', () => apiA2.post('/api/lan/documents/chains', { projectId: project.id, kind: 'media', inputSpec: { fresh: { media: { kind: 'image', name: 'x.png' } } } }), (doc) => doc.chains.length === 2)
  await expectFresh('chain settings update', () => apiA2.post('/api/lan/documents/chains/update', { id: chain.id, settings: { seed: 77 } }), (doc) => chainsOf(doc)[0].settings.seed === 77)
  await expectFresh('chain staleness flip', () => apiA2.post('/api/lan/documents/chains/update', { id: chain.id, stale: true }), (doc) => chainsOf(doc)[0].stale === true)
  await expectFresh('output create', () => apiA2.post('/api/lan/documents/outputs', { chainId: chain.id, substrates: ['decoded'] }), (doc) => chainsOf(doc)[0].outputs.length === 2)
  await expectFresh('take append', () => apiA2.post('/api/lan/documents/takes', { outputId: output.id, artifacts: [], metrics: { kind: 'image', name: 'second' } }), (doc) => chainsOf(doc)[0].outputs.find((entry) => entry.id === output.id).takes.length === 2)
  const takesList = (await apiA2.get(`/api/lan/documents/takes?outputId=${output.id}`)).body
  const nonCanonicalTakeId = takesList.takes.find((entry) => entry.id !== takesList.canonicalTakeId).id
  await expectFresh('take supersede', () => apiA2.post('/api/lan/documents/takes/supersede', { outputId: output.id, takeId: nonCanonicalTakeId }), (doc) => chainsOf(doc)[0].outputs.find((entry) => entry.id === output.id).canonicalTakeId === nonCanonicalTakeId)

  let opOne
  await expectFresh('op add', async () => { opOne = (await apiA2.post('/api/lan/documents/ops', { chainId: chain.id, kind: 'crop', settings: { x: 0, y: 0, w: 10 } })).body.op }, (doc) => chainsOf(doc)[0].ops.length === 1)
  await expectFresh('op settings update', () => apiA2.post('/api/lan/documents/ops/update', { id: opOne.id, settings: { x: 42 } }), (doc) => chainsOf(doc)[0].ops.find((entry) => entry.id === opOne.id).settings.x === 42)
  let opTwo
  await expectFresh('second op add', async () => { opTwo = (await apiA2.post('/api/lan/documents/ops', { chainId: chain.id, kind: 'trim', settings: { start: 0, end: 2 } })).body.op }, (doc) => chainsOf(doc)[0].ops.length === 2)
  await expectFresh('op reorder', () => apiA2.post('/api/lan/documents/ops/reorder', { chainId: chain.id, orderedIds: [opTwo.id, opOne.id] }), (doc) => chainsOf(doc)[0].ops[0].id === opTwo.id)
  await expectFresh('op bake', () => apiA2.post('/api/lan/documents/ops/bake', { id: opOne.id }), (doc) => chainsOf(doc)[0].ops.find((entry) => entry.id === opOne.id).bakedAt !== null)
  await expectFresh('op delete', () => apiA2.post('/api/lan/documents/ops/delete', { id: opTwo.id }), (doc) => chainsOf(doc)[0].ops.length === 1)
  await expectFresh('identity upsert', () => apiA2.post('/api/lan/documents/identity', { chainId: chain.id, subjectText: 'Mara', strength: 0.5 }), (doc) => chainsOf(doc)[0].identity?.subjectText === 'Mara')
  await expectFresh('control track add', () => apiA2.post('/api/lan/documents/control-tracks', { chainId: chain.id, kind: 'depth', source: 'extracted', inputRef: 'canvas-blobs/aa/deadbeef', params: { strength: 1 } }), (doc) => chainsOf(doc)[0].controlTracks.length === 1)

  let plan
  await expectFresh('plan create', async () => { plan = (await apiA2.post('/api/lan/documents/plans', { projectId: project.id, document: { brief: 'first brief', segments: [], gaps: [] } })).body.plan }, (doc) => doc.plans.length === 1 && doc.plans[0].document.brief === 'first brief')
  const planDocNow = JSON.parse((await fetchDoc()).body)
  await expectFresh('plan CAS update', () => apiA2.post('/api/lan/documents/plans', { id: plan.id, projectId: project.id, expectedUpdatedAt: planDocNow.plans[0].updatedAt, document: { brief: 'second brief', segments: [], gaps: [] } }), (doc) => doc.plans[0].document.brief === 'second brief')

  const asset = (await apiA2.post('/api/lan/documents/assets', { kind: 'character', fields: { label: 'X' } })).body.asset
  await expectFresh('asset fork (consented)', () => apiA2.post('/api/lan/documents/assets/fork', { projectId: project.id, assetId: asset.id, consent: true }), (doc) => doc.assetForks.length === 1)
  await expectFresh('chain tombstone', () => apiA2.post('/api/lan/documents/chains/delete', { id: chain.id }), (doc) => doc.chains.length === 1)
  await expectFresh('chain restore', () => apiA2.post('/api/lan/documents/chains/restore', { id: chain.id }), (doc) => doc.chains.length === 2)
  await expectFresh('project tombstone', () => apiA2.post('/api/lan/documents/projects/delete', { id: project.id }), (doc) => doc.project.deletedAt !== null)
  await expectFresh('project restore', () => apiA2.post('/api/lan/documents/projects/restore', { id: project.id }), (doc) => doc.project.deletedAt === null)

  await expectDroppedOnly('session save (unrelated table)', () => apiA2.post('/api/lan/documents/session', { openProjects: [project.id], activeProject: project.id }))
  await expectDroppedOnly('blob ingest (blob rows are not document content)', () => apiA2.post('/api/lan/documents/blobs/ingest', { kind: 'image', name: 'stamp.png', data: Buffer.from('stamp-probe').toString('base64') }))

  // Cross-connection invalidation (the data_version half of the stamp): a
  // SECOND SQLite connection committing a chain row must drop the entry.
  const externalDb = new Database(path.join(serverA2.home, 'studio.db'))
  try {
    const beforeExternal = await fetchDoc()
    externalDb.prepare('UPDATE canvas_project SET name = ? WHERE id = ?').run('read-cache-external', project.id)
    const afterExternal = await fetchDoc()
    check(afterExternal.cache === 'miss', 'an external-connection write drops the cached entry (data_version)')
    check(JSON.parse(afterExternal.body).project.name === 'read-cache-external', 'the external write is visible immediately (no stale window)')
    check(afterExternal.body !== beforeExternal.body, 'the external write changed the served document')
  } finally {
    externalDb.close()
  }
  console.log(`PASS: canvas document store — migration 002 (golden fixture N→N+1, divergence hard-error, ${canvasTables.length} canvas tables + jobs extension); §6 legacy import (5 jobs -> 3 takes + 1 failure output, counts + hash spot-checks + marker + clean retry, sources untouched); tombstones/trash round-trips + GC adversarials (fork-edge liveness over a tombstoned source, locked + canonical never evicted, session prune); take append-only + bake immutability trigger-enforced; §7 archive round-trip (zip, hash-verified blobs, global-asset placeholders, unknown-newer refusal); §4 FTS (chain/asset/plan/take/job, injection-safe, kind-filter-before-limit); unknown-newer document refusal names the writer; correctness wave 1 (shared-blob eviction survival + takeId-pinned priors, jobId-idempotent + stray-healing appendTake, torn-copy repair, poisoned-list isolation, locked-staleness gating, plan CAS 409, honest cancel verdicts, remote-output fetch+ingest, latent durability + visible missingBlobs, control-track blob lifecycle, shared-blob import upsert + staged-file rollback); document-read cache + ETag (perf wave 1 — hit/miss/304 + no stale reads across every mutation route, external-connection invalidation). ${assertions} assertions.`)
})
