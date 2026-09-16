// Canvas document store test (Phase 0, docs/specs/canvas-document-model.md):
// boots the BUILT standalone server on a scratch port + scratch home (like
// test-storage.cjs) and drives the document store end to end:
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
// Run after `pnpm build` (the server + modules are loaded from dist-server).
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')

const { migrations, migrateDatabase } = require('../dist-server/server/db.js')
const { packZip, unpackZip } = require('../dist-server/server/documentArchive.js')

/** Picks a port that verifiably has nothing listening. */
async function freePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 4600 + Math.floor(Math.random() * 200)
    const busy = await new Promise((resolve) => {
      const probe = net.connect({ port: candidate, host: '127.0.0.1' })
      probe.on('error', () => resolve(false))
      probe.on('connect', () => { probe.destroy(); resolve(true) })
    })
    if (!busy) return candidate
  }
  throw new Error('no free port found in 50 attempts')
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const sha256File = (file) => sha256(fs.readFileSync(file))

function makeHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `minimax-documents-${label}-`))
}

async function bootServer(home, label) {
  const output = { text: '', label }
  const port = await freePort()
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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

async function main() {
  // =====================================================================
  // (a) Migration: golden fixture N→N+1 + fresh boot shape
  // =====================================================================
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
  const applied = migrateDatabase(fixtureDb) // applies 002 (one-way, append-only)
  check(applied === 1, `golden fixture migration applies exactly 002 (got ${applied})`)
  const goldenAfter = sha256(JSON.stringify({
    jobs: fixtureDb.prepare('SELECT id, provider, media_type, mode, status, prompt, params_json, created_at, updated_at, error, width, height, duration, output_url FROM jobs').all(),
    workspace: fixtureDb.prepare('SELECT * FROM workspace_state').all(),
    prompts: fixtureDb.prepare('SELECT * FROM saved_prompts').all(),
    projects: fixtureDb.prepare('SELECT * FROM projects').all(),
  }))
  check(goldenBefore === goldenAfter, 'legacy rows survive migration 002 byte-identically (copy-never-destroy)')
  const canvasTables = fixtureDb.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'canvas%'").all().map((row) => row.name)
  for (const expected of ['canvas_project', 'canvas_session', 'canvas_chain', 'canvas_output', 'canvas_take', 'canvas_op_stack', 'canvas_op', 'canvas_identity_payload', 'canvas_control_track', 'canvas_asset', 'canvas_asset_fork', 'canvas_plan', 'canvas_blob', 'canvas_import_marker', 'canvas_fts']) {
    check(canvasTables.includes(expected), `migration 002 creates ${expected}`)
  }
  const fixtureColumns = fixtureDb.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name)
  for (const column of ['gpu_queue_state', 'plan_ref', 'failure_json']) check(fixtureColumns.includes(column), `jobs extension adds ${column}`)
  check(migrateDatabase(fixtureDb) === 0, 're-running migrations is a no-op (idempotent, one-way)')
  const divergent = new Database(path.join(makeHome('diverge'), 'studio.db'))
  divergent.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  divergent.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (999, 'bogus', 0)").run()
  assert.throws(() => migrateDatabase(divergent), /diverges/, 'a persisted history that is not a prefix of the code list is a hard error')
  assertions += 1
  fixtureDb.close()
  divergent.close()

  // =====================================================================
  // Boot server A + seed the OLD surface (import sources)
  // =====================================================================
  const homeA = makeHome('a')
  const serverA = await bootServer(homeA, 'A')
  const api = client(serverA.port)
  const dbFileA = path.join(homeA, 'studio.db')

  // real artifact files for hash spot-checks
  const outDir = path.join(homeA, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const mediaFiles = ['one.mp4', 'two.mp4', 'three.mp4'].map((name, index) => {
    const file = path.join(outDir, name)
    fs.writeFileSync(file, Buffer.from(`legacy-media-${index}-${Math.random()}`))
    return file
  })
  const legacyJobs = [
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
  const charactersPosted = await api.post('/api/lan/characters', { characters: [
    { id: 'char-mara', name: 'Mara', description: 'a courier with a lantern', referenceImages: ['/inputs/mara-1.png', '/inputs/mara-2.png'] },
    { id: 'char-olio', name: 'Olio', referenceImages: [] },
  ] })
  check(charactersPosted.status === 200 && charactersPosted.body.synced === 2, 'legacy character library syncs via the old surface')

  // =====================================================================
  // (e) §6 legacy import — first canvas boot
  // =====================================================================
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

  // =====================================================================
  // (b)(c)(d) CRUD + invariants on a fresh project
  // =====================================================================
  const created = await api.post('/api/lan/documents/projects', { name: 'Document test' })
  check(created.status === 200 && created.body.project.schemaVersion >= 1, 'project create stamps schemaVersion')
  const projectId = created.body.project.id
  const defaultsSet = await api.post('/api/lan/documents/projects/update', { id: projectId, settingsDefaults: { duration: 6, resolution: '1344x768' } })
  check(defaultsSet.status === 200, 'project chain-settings defaults set')

  const chainCreated = await api.post('/api/lan/documents/chains', { projectId, inputSpec: { fresh: { prompt: 'a quiet lighthouse at dawn' } }, settings: { seed: 99 } })
  check(chainCreated.status === 200 && chainCreated.body.chain.stale === false, 'chain create answers')
  const chainId = chainCreated.body.chain.id
  check(chainCreated.body.chain.settings.seed === 99, 'chain settings persist')
  check(chainCreated.body.chain.settings.duration === 6, 'project settings-defaults seed new chains (workspace import payoff)')
  check(typeof chainCreated.body.chain.opStackId === 'string', 'chain create provisions an op stack')

  const outputCreated = await api.post('/api/lan/documents/outputs', { chainId, substrates: ['decoded'] })
  check(outputCreated.status === 200, 'output create answers')
  const outputId = outputCreated.body.output.id

  // takes with real files (registered + hashed on ingest)
  const latentFiles = []
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
  check(bakedDelete.status === 500, 'baked ops cannot be deleted (bake is irreversible)')
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
  const assetCreated = await api.post('/api/lan/documents/assets', { kind: 'character', fields: { label: 'Harbormaster', description: 'keeps the light' }, canonicalReferenceSet: ['/inputs/harbor-1.png'] })
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

  // =====================================================================
  // (f) retention/GC adversarials (§3)
  // =====================================================================
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

  // =====================================================================
  // (h) §4 FTS surfaces + injection safety
  // =====================================================================
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

  // =====================================================================
  // (i) unknown-newer refuses loudly; old surface untouched
  // =====================================================================
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

  // =====================================================================
  // (g) §7 archive: round-trip into a fresh studio + refusals
  // =====================================================================
  const exportResponse = await api.getRaw(`/api/lan/documents/export?id=${projectId}`)
  check(exportResponse.status === 200 && exportResponse.headers.get('content-type') === 'application/zip', 'export answers with a zip')
  const archive = exportResponse.buffer
  const manifest = JSON.parse(unpackZip(archive).get('manifest.json'))
  check(manifest.format === 'minimax-canvas-archive' && manifest.schemaVersion >= 1, 'manifest carries format + schemaVersion')
  check(manifest.counts.takes === 2 && manifest.counts.chains === 2, 'manifest counts the exported document')
  check(manifest.blobs.length === 1 && manifest.missingBlobs.length === 1, `present + evicted blobs both ride in the manifest (got ${manifest.blobs.length} + ${manifest.missingBlobs.length})`)
  check(manifest.globalAssets.some((asset) => asset.id === assetCreated.body.asset.id), 'global assets ride by id + hash manifest (not as rows)')

  const homeB = makeHome('b')
  const serverB = await bootServer(homeB, 'B')
  const apiB = client(serverB.port)
  await apiB.get('/api/lan/documents/bootstrap') // fresh studio: nothing to import
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

  // =====================================================================
  // restart = migrations no-op + document stability
  // =====================================================================
  serverA.child.kill()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const serverA2 = await bootServer(homeA, 'A2')
  const apiA2 = client(serverA2.port)
  const afterRestart = await apiA2.get(`/api/lan/documents/project?id=${projectId}`)
  check(afterRestart.status === 200 && afterRestart.body.chains.length === 2 && afterRestart.body.project.camera.zoom === 1.5, 'restart re-opens the document unchanged (append-only migrations, autosave stable)')
  const sessionAfterRestart = await apiA2.get('/api/lan/documents/session')
  check(sessionAfterRestart.body.session.activeProject === projectId, 'session survives restart')
  const importStatusAfterRestart = await apiA2.get('/api/lan/documents/bootstrap')
  check(importStatusAfterRestart.body.legacyImport.imported === true, 'the legacy-import marker survives restart (never re-imports)')

  serverA2.child.kill()
  serverB.child.kill()
  console.log(`PASS: canvas document store — migration 002 (golden fixture N→N+1, divergence hard-error, ${canvasTables.length} canvas tables + jobs extension); §6 legacy import (5 jobs -> 3 takes + 1 failure output, counts + hash spot-checks + marker + clean retry, sources untouched); tombstones/trash round-trips + GC adversarials (fork-edge liveness over a tombstoned source, locked + canonical never evicted, session prune); take append-only + bake immutability trigger-enforced; §7 archive round-trip (zip, hash-verified blobs, global-asset placeholders, unknown-newer refusal); §4 FTS (chain/asset/plan/take/job, injection-safe); unknown-newer document refusal names the writer. ${assertions} assertions.`)
}

void main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
