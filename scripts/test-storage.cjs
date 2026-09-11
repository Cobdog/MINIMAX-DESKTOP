// Storage substrate test (wave 1): boots the BUILT standalone server on a
// scratch port + scratch home (like smoke-server.cjs) and exercises the
// SQLite/FTS5 layer end to end:
//   (a) fresh boot creates studio.db with a stamped schema version
//   (b) POST jobs -> GET returns them graph-stripped and manifest-preserved
//   (c) FTS5: word search finds prompts; FTS syntax injection returns safely
//   (d) localStorage -> server migration logic as a VM unit against fixture
//       stores, plus workspace/projects API round-trips
//   (e) per-job upserts: interleaved writes never lose the other job
// Run after `pnpm build` (the server is loaded from dist-server).
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const ts = require('typescript')
const Database = require('better-sqlite3')

/** Picks a port that verifiably has nothing listening — a stale dev server
 *  squatting in the range would otherwise answer the readiness probe and the
 *  test would assert against the WRONG server's home. */
async function freePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 4400 + Math.floor(Math.random() * 200)
    const busy = await new Promise((resolve) => {
      const probe = net.connect({ port: candidate, host: '127.0.0.1' })
      probe.on('error', () => resolve(false)) // connection refused — free
      probe.on('connect', () => { probe.destroy(); resolve(true) })
    })
    if (!busy) return candidate
  }
  throw new Error('no free port found in 50 attempts')
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-storage-'))
let child = null
let output = ''

const fail = (message) => {
  console.error(`FAIL: ${message}\n--- server output ---\n${output}`)
  if (child) child.kill()
  process.exit(1)
}

async function waitFor(port, pathname) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
      if (response.ok) return response
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  fail(`${pathname} never became ready`)
}

let port = 0

async function get(pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
  return { status: response.status, body: await response.json() }
}

async function post(pathname, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

// ---- VM harness for the client-side migration logic (src/lib is TS) -------
function localStorageStubFrom(initial) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  }
}

function loadServerStorage(localStorageStub, fetchStub, consoleStub) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync('src/lib/serverStorage.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(code, {
    exports,
    require,
    console: consoleStub ?? console,
    fetch: fetchStub,
    Headers,
    URLSearchParams,
    localStorage: localStorageStub,
    window: { location: { search: '' } },
  })
  return exports
}

const manifestFixture = {
  manifestVersion: 1, graphFamily: 'studio-2026-09', provider: 'minimax', mode: 'text',
  prompt: 'a lantern-lit courtyard', seed: 12345, steps: 30, turbo: 'off', sampler: 'res_multistep',
  scheduler: 'simple', resolution: '1344x768', durationSeconds: 5,
  models: { diffusion: { name: 'fl2va.safetensors', bytes: 1 } }, referenceCounts: { images: 0, videos: 0, audios: 0 },
  graphVersion: 'fnv1a-deadbeef', engine: { comfyUrl: 'http://127.0.0.1:8188', app: 'MiniMax Studio' },
}

const jobA = {
  id: 'job-alpha', mode: 'text', status: 'completed', prompt: 'a lantern-lit courtyard at dusk',
  createdAt: Date.now() - 60_000, progress: 100, width: 1344, height: 768, duration: 5,
  outputUrl: '/api/lan/media?source=output&path=%2Fout%2Fa.mp4', manifest: manifestFixture,
  graph: { '1': { class_type: 'HiddenNode', inputs: { secret: 'graph-must-not-persist' } } },
}
const jobB = {
  id: 'job-beta', mode: 'text', status: 'running', prompt: 'neon rain on chrome',
  createdAt: Date.now(), progress: 40, width: 352, height: 608, duration: 5,
}

async function main() {
  port = await freePort()
  child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const timeout = setTimeout(() => fail('server did not become ready in 15 s'), 15_000)

  await waitFor(port, '/api/lan/settings')
  clearTimeout(timeout)
  // Guard against talking to a foreign server that somehow took the port:
  // our child must have announced itself on this exact port.
  if (!output.includes(`"port":${port}`)) fail('the readiness probe reached a server that is not the test child')
  const base = `http://127.0.0.1:${port}`

  // (a) Fresh boot created studio.db with the schema version stamped.
  const dbFile = path.join(home, 'studio.db')
  assert.ok(fs.existsSync(dbFile), 'studio.db must exist in the studio home after boot')
  const db = new Database(dbFile)
  const userVersion = db.pragma('user_version', { simple: true })
  const appliedMigrations = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all()
  assert.ok(userVersion >= 1, `PRAGMA user_version must be stamped (got ${userVersion})`)
  assert.ok(appliedMigrations.length >= 1, 'schema_migrations must record migration 001')
  assert.equal(appliedMigrations[0].name, '001-foundation')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => row.name)
  for (const expected of ['jobs', 'job_events', 'assets', 'projects', 'workspace_state', 'saved_prompts', 'prompts_fts']) {
    assert.ok(tables.includes(expected), `table ${expected} must exist`)
  }
  db.close()
  // Re-boot idempotency is exercised by every later server start against an
  // existing home; here the single-boot path has already re-run migrations
  // safely (no divergence error on the already-migrated file).

  // (b) Job upsert round-trip: graph stripped, manifest preserved.
  const saved = await post('/api/lan/jobs', { jobs: [jobB, jobA] })
  assert.equal(saved.status, 200, `job POST failed: ${JSON.stringify(saved.body)}`)
  assert.equal(saved.body.saved, 2)
  const listed = await get('/api/lan/jobs')
  assert.equal(listed.status, 200)
  const returned = listed.body.jobs
  assert.equal(returned.length, 2, 'both posted jobs must list')
  const alpha = returned.find((job) => job.id === 'job-alpha')
  const beta = returned.find((job) => job.id === 'job-beta')
  assert.ok(alpha && beta, 'posted job ids must come back')
  assert.equal(alpha.graph, undefined, 'the submit graph must never persist')
  assert.equal('graph' in alpha, false, 'no graph key at all')
  assert.equal(JSON.stringify(alpha.manifest), JSON.stringify(manifestFixture), 'manifest must round-trip byte-identically')
  assert.equal(beta.status, 'running', 'non-terminal statuses persist')

  // Shape-first validation: unknown shapes are rejected with 400.
  const badShape = await post('/api/lan/jobs', { jobs: [{ id: 'x', prompt: 'no mode or numbers' }] })
  assert.equal(badShape.status, 400, 'malformed job must 400')
  const tooMany = await post('/api/lan/jobs', { jobs: Array.from({ length: 101 }, (_, index) => ({ ...jobB, id: `flood-${index}` })) })
  assert.equal(tooMany.status, 400, 'more than 100 jobs per request must 400')
  const wrongEnvelope = await post('/api/lan/jobs', { records: [jobA] })
  assert.equal(wrongEnvelope.status, 400, 'wrong envelope must 400')

  // (e) Per-job upsert isolation: a later partial write updates only its own
  // job; the other job from the earlier batch survives.
  const updatedAlpha = { ...jobA, status: 'failed', error: 'engine reset mid-render', createdAt: jobA.createdAt }
  const interleaveOne = await post('/api/lan/jobs', { jobs: [updatedAlpha] })
  assert.equal(interleaveOne.status, 200)
  const afterInterleave = await get('/api/lan/jobs')
  const alphaAfter = afterInterleave.body.jobs.find((job) => job.id === 'job-alpha')
  const betaAfter = afterInterleave.body.jobs.find((job) => job.id === 'job-beta')
  assert.ok(alphaAfter && alphaAfter.status === 'failed' && alphaAfter.error === 'engine reset mid-render', 'alpha must take the newer write')
  assert.ok(betaAfter && betaAfter.status === 'running', 'beta must survive the interleaved write (per-job upsert, never whole-list replace)')
  // Terminal transition was recorded in the append-only event tail.
  const eventsDb = new Database(dbFile)
  const events = eventsDb.prepare("SELECT * FROM job_events WHERE job_id = 'job-alpha' ORDER BY seq").all()
  assert.ok(events.length >= 1, 'terminal transition must append a job_events row')
  const lastEvent = events[events.length - 1]
  assert.equal(lastEvent.type, 'status')
  const payload = JSON.parse(lastEvent.payload_json)
  assert.equal(payload.to, 'failed', 'event payload records the terminal state')
  eventsDb.close()

  // (c) FTS5: seed prompts, search by word, attempt FTS syntax injection.
  const prompts = [
    { id: 'civitai.1', label: 'Golden hour', prompt: 'A courtyard bathed in golden hour light, dust motes drifting.', savedAt: 1 },
    { id: 'civitai.2', label: 'Neon rain', prompt: 'Neon reflections rippling across rain-slick chrome streets.', savedAt: 2 },
    { id: 'civitai.3', label: 'Snow field', prompt: 'A lone figure crossing a silent snow field at dawn.', savedAt: 3 },
  ]
  const seeded = await post('/api/lan/prompts', { entries: prompts })
  assert.equal(seeded.status, 200, `prompt seed failed: ${JSON.stringify(seeded.body)}`)
  const golden = await get(`/api/lan/search/prompts?${new URLSearchParams({ q: 'golden', limit: '50' })}`)
  assert.equal(golden.status, 200)
  assert.equal(golden.body.entries.length, 1, 'word search must find exactly the matching prompt')
  assert.equal(golden.body.entries[0].id, 'civitai.1')
  const prefix = await get(`/api/lan/search/prompts?${new URLSearchParams({ q: 'golde' })}`)
  assert.ok(prefix.body.entries.some((entry) => entry.id === 'civitai.1'), 'prefix token must match (quoted-prefix expression)')
  // Injection: a crafted query must neither error nor degenerate to all rows.
  const injection = await get(`/api/lan/search/prompts?${new URLSearchParams({ q: '" OR 1=1 --' })}`)
  assert.equal(injection.status, 200, 'FTS injection attempt must not error')
  assert.ok(injection.body.entries.length < 3 + 8, `injection must not return the whole library (got ${injection.body.entries.length})`)
  const loneQuote = await get(`/api/lan/search/prompts?${new URLSearchParams({ q: '"' })}`)
  assert.equal(loneQuote.status, 200, 'lone double quote must not error')
  // Bundled technique corpus re-seeds server-side, idempotently.
  const library = await get('/api/lan/search/prompts?limit=500')
  const techniqueIds = library.body.entries.filter((entry) => entry.technique).map((entry) => entry.id)
  assert.ok(techniqueIds.includes('technique.timed-beats'), 'bundled technique corpus must be seeded at boot')
  assert.equal(techniqueIds.length, 8, 'exactly the 8 bundled techniques (idempotent re-seed)')
  // Delete keeps FTS and the backing row in sync.
  const removed = await post('/api/lan/prompts/delete', { id: 'civitai.3' })
  assert.equal(removed.status, 200)
  const snow = await get(`/api/lan/search/prompts?${new URLSearchParams({ q: 'snow' })}`)
  assert.equal(snow.body.entries.length, 0, 'deleted prompt must leave the index')

  // (d1) Server-level round-trips: workspace + projects.
  const workspace = { mode: 'reference', prompt: 'migration fixture', duration: 6, resolution: '1344x768', turbo: 'off', steps: 30, seed: 42, advanced: true }
  const savedWorkspace = await post('/api/lan/workspace', { workspace })
  assert.equal(savedWorkspace.status, 200)
  const loadedWorkspace = await get('/api/lan/workspace')
  assert.equal(loadedWorkspace.body.workspace.mode, 'reference')
  assert.equal(loadedWorkspace.body.workspace.prompt, 'migration fixture')
  const project = { id: 'movie-1', name: 'Nightfall', kind: 'movie', data: { id: 'movie-1', name: 'Nightfall', scenes: [{ id: 's1', shots: [] }] } }
  const savedProject = await post('/api/lan/projects', { projects: [project] })
  assert.equal(savedProject.status, 200)
  const loadedProjects = await get('/api/lan/projects')
  assert.equal(loadedProjects.body.projects.length, 1)
  assert.equal(loadedProjects.body.projects[0].data.name, 'Nightfall')
  const deletedProject = await post('/api/lan/projects/delete', { id: 'movie-1' })
  assert.equal(deletedProject.status, 200)
  assert.equal((await get('/api/lan/projects')).body.projects.length, 0)

  // (d2) Migration logic as a unit: fixture localStorage stores against a
  // recording fetch stub that also serves the verification GET.
  const legacyJobs = [
    { id: 'legacy-1', mode: 'text', status: 'completed', prompt: 'old render one', createdAt: 100, progress: 100, width: 1344, height: 768, duration: 5, manifest: { seed: 1 } },
    { id: 'legacy-2', mode: 'text', status: 'failed', prompt: 'old render two', createdAt: 200, progress: 10, width: 0, height: 0, duration: 5 },
  ]
  const legacyStores = {
    'minimax.jobs': JSON.stringify(legacyJobs),
    'minimax.workspace': JSON.stringify({ mode: 'text', prompt: 'legacy workspace', duration: 5 }),
    'minimax.movie-projects': JSON.stringify([{ id: 'mp-1', title: 'Legacy cut', scenes: [] }]),
    'minimax.prompt-library': JSON.stringify([
      { id: 'civitai.9', label: 'Kept', prompt: 'A kept community prompt long enough.', savedAt: 5 },
      { id: 'technique.timed-beats', label: 'Technique', prompt: 'bundled technique entry', technique: true, savedAt: 0 },
    ]),
  }
  const posted = { jobs: [], workspace: null, projects: [], prompts: [] }
  const recordingFetch = async (pathname, init) => {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body)
      if (pathname === '/api/lan/jobs') { posted.jobs.push(...body.jobs); return { ok: true, status: 200, json: async () => ({ saved: body.jobs.length }) } }
      if (pathname === '/api/lan/workspace') { posted.workspace = body.workspace; return { ok: true, status: 200, json: async () => ({ saved: true }) } }
      if (pathname === '/api/lan/projects') { posted.projects.push(...body.projects); return { ok: true, status: 200, json: async () => ({ saved: body.projects.length }) } }
      if (pathname === '/api/lan/prompts') { posted.prompts.push(...body.entries); return { ok: true, status: 200, json: async () => ({ saved: body.entries.length }) } }
      throw new Error(`unexpected POST ${pathname}`)
    }
    if (pathname.startsWith('/api/lan/jobs')) return { ok: true, status: 200, json: async () => ({ jobs: posted.jobs }) }
    throw new Error(`unexpected GET ${pathname}`)
  }
  const migrationStorage = localStorageStubFrom(legacyStores)
  const snapshots = Object.fromEntries(Object.keys(legacyStores).map((key) => [key, migrationStorage.getItem(key)]))
  const storageModule = loadServerStorage(migrationStorage, recordingFetch)
  const outcome = await storageModule.migrateLocalData()
  assert.equal(outcome.migrated, true, `migration must succeed: ${JSON.stringify(outcome)}`)
  assert.equal(migrationStorage.getItem('minimax.data-migrated'), '1', 'marker must be set after verification')
  assert.equal(posted.jobs.length, 2, 'both legacy jobs must be posted')
  assert.equal(posted.jobs[0].id, 'legacy-1')
  assert.equal(posted.workspace.prompt, 'legacy workspace')
  assert.equal(posted.projects.length, 1)
  assert.equal(posted.prompts.length, 1, 'technique entries are seeded server-side and must NOT be copied')
  assert.equal(posted.prompts[0].id, 'civitai.9')
  for (const [key, before] of Object.entries(snapshots)) {
    assert.equal(migrationStorage.getItem(key), before, `legacy store ${key} must never be modified (COPY, NEVER DESTROY)`)
  }
  // Re-run is a no-op via the marker.
  const rerun = await storageModule.migrateLocalData()
  assert.equal(rerun.migrated, true)
  assert.equal(rerun.reason, 'already-migrated')
  assert.equal(posted.jobs.length, 2, 'marker present: no second copy')

  // Failure path: a rejecting API leaves no marker and retries next boot.
  const failingStorage = localStorageStubFrom(legacyStores)
  const warned = []
  const failingModule = loadServerStorage(failingStorage, async () => { throw new Error('server unreachable') }, { warn: (...args) => warned.push(args.join(' ')) })
  const failedOutcome = await failingModule.migrateLocalData()
  assert.equal(failedOutcome.migrated, false)
  assert.equal(failingStorage.getItem('minimax.data-migrated'), null, 'failed migration must not set the marker')
  assert.ok(warned.some((line) => line.includes('migration deferred')), 'failure must log structurally')

  child.kill()
  console.log(`PASS: storage substrate — studio.db boots with versioned migrations (${appliedMigrations.length} applied); jobs upsert per-job (graph stripped, manifest kept, events on terminal); FTS5 search is injection-safe and the technique corpus seeds idempotently; workspace/projects round-trip; the localStorage migration copies+verifies without touching the originals; degraded API writes leave no marker. Server: ${base}`)
}

void main().catch((error) => fail(error instanceof Error ? error.stack : String(error)))
