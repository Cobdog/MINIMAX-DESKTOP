// Benchmarks offline suite (task cp96zdm). NO GPU, NO network anywhere:
//   (a) suite inventory: 7 suites, SUITE.json schema, incumbents pinned,
//       fixture data committed (prompts/seeds/plans present)
//   (b) registry: append-only semantics on a temp registry (duplicate ids and
//       undeclared environments rejected; environments immutable)
//   (c) leaderboard: deterministic regeneration; the committed LEADERBOARD.md
//       is byte-identical to a fresh regeneration (never hand-edited)
//   (d) CLI: --list; unknown suite refused; --dry-run plan with a candidate
//       file; a candidate of the wrong slot kind refused
//   (e) fetch-catalog bridge: license banner + presence check + consent
//       gating (non-prerequisite entries refused) against the committed
//       snapshot — zero network
//   (f) candidate parameterization: the python build smoke (a mock candidate
//       exercises EVERY suite's build path) — self-skips with a reason if
//       python3 is absent
//   (g) metric math: pure metric functions vs fixed arrays (python+numpy)
//   (h) blind-judge: bundle emission is vision:report-compatible (unjudged
//       bundle fails the gate; judged fixture passes) + unblind round trip
// Run after `pnpm build` on CI (uses dist-server when present; snapshot otherwise).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const REPO = path.join(__dirname, '..')
const BENCH = path.join(REPO, 'benchmarks')

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tests-'))
}

async function importLib(name) {
  return import(path.join(BENCH, 'lib', name))
}

// 1x1 PNG (transparent) — the blind-bundle fixture image
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64')

async function main() {
  console.log('(a) suite inventory + fixture invariants')
  const suites = await importLib('suites.mjs')
  const names = suites.listSuites()
  ok(names.length === 7, `7 suites present (${names.join(', ')})`)
  const expectedSuites = ['ref2va-bakeoff', 'tier-ladder', 'hybrid-ab', 'movement-md1',
    'nonhuman-fc1', 'preservation-k1', 'transitions-e1e4'].sort()
  ok(JSON.stringify(names) === JSON.stringify(expectedSuites), 'suite set matches the task inventory')
  for (const name of names) {
    const cfg = suites.loadSuite(name)
    ok(cfg.candidateSlot.kinds.length > 0, `${name}: candidate slot declares kinds`)
    ok(Object.values(cfg.arms).some((a) => a.incumbent), `${name}: incumbents pinned`)
    ok(cfg.limits.length > 0, `${name}: known limits documented`)
    const runner = suites.runnerInfo(cfg, name)
    ok(runner.run !== null, `${name}: runner script present (${runner.run})`)
    // fixture data is COMMITTED, not testbed-side: prompts/seeds present in SUITE.json
    const blob = JSON.stringify(cfg.fixtures)
    ok(/prompt|sceneText|sourcePrompt/.test(blob), `${name}: fixture prompts committed`)
    ok(/42133[78]/.test(blob) || /seed/.test(blob), `${name}: fixture seeds committed`)
  }

  console.log('(b) registry append-only semantics (temp registry)')
  const registry = await importLib('registry.mjs')
  const tmp = tmpdir()
  const regPath = path.join(tmp, 'registry.json')
  const env = { id: 'test-env', gpu: 'Test GPU', driver: '1.0', comfyui: '0.34.0', quant: [], adapters: [] }
  registry.ensureEnvironment(env, regPath)
  ok(true, 'environment recorded')
  let threw = false
  try {
    registry.ensureEnvironment({ ...env, gpu: 'DIFFERENT GPU' }, regPath)
  } catch { threw = true }
  ok(threw, 'environments are immutable (silent GPU change refused)')
  const row = registry.makeRow({
    suite: 'tier-ladder', candidate: { id: 'cand-x', label: 'X' },
    metrics: { wall_s: 100 }, environmentId: 'test-env',
  })
  registry.appendRow(row, regPath)
  ok(registry.loadRegistry(regPath).rows.length === 1, 'row appended')
  threw = false
  try { registry.appendRow(row, regPath) } catch { threw = true }
  ok(threw, 'duplicate row id refused (append-only)')
  threw = false
  try {
    registry.appendRow(registry.makeRow({
      suite: 'tier-ladder', candidate: { id: 'cand-y' }, metrics: {},
      environmentId: 'undeclared-env',
    }), regPath)
  } catch { threw = true }
  ok(threw, 'row with undeclared environment refused')
  threw = false
  try {
    registry.appendRow({ suite: 'x', candidate: { id: 'z' } }, regPath)
  } catch { threw = true }
  ok(threw, 'malformed row refused (schema check)')

  console.log('(c) leaderboard regeneration')
  const leaderboard = await importLib('leaderboard.mjs')
  const suitesMap = () => Object.fromEntries(suites.listSuites().map((n) => [n, suites.loadSuite(n)]))
  const out1 = path.join(tmp, 'LEADERBOARD-1.md')
  const out2 = path.join(tmp, 'LEADERBOARD-2.md')
  leaderboard.regenerateLeaderboard(regPath, out1, suitesMap)
  leaderboard.regenerateLeaderboard(regPath, out2, suitesMap)
  ok(fs.readFileSync(out1, 'utf8') === fs.readFileSync(out2, 'utf8'), 'regeneration is deterministic')
  const committed = fs.readFileSync(path.join(BENCH, 'LEADERBOARD.md'), 'utf8')
  const fresh = path.join(tmp, 'LEADERBOARD-fresh.md')
  leaderboard.regenerateLeaderboard(undefined, fresh, suitesMap)
  ok(committed === fs.readFileSync(fresh, 'utf8'),
    'committed LEADERBOARD.md is byte-identical to a fresh regeneration (never hand-edited)')
  ok(committed.startsWith('# Benchmark leaderboard — GENERATED, do not edit'),
    'leaderboard carries the do-not-edit header')

  console.log('(d) CLI argument handling')
  const runCli = (args) => spawnSync(process.execPath, [path.join(BENCH, 'run.mjs'), ...args],
    { encoding: 'utf8', cwd: REPO, timeout: 60_000 })
  let r = runCli(['--list'])
  ok(r.status === 0 && /ref2va-bakeoff/.test(r.stdout) && /incumbents:/.test(r.stdout),
    '--list exits 0 and lists suites + incumbents')
  r = runCli(['--suite', 'no-such-suite', '--dry-run'])
  ok(r.status !== 0 && /unknown suite/.test(r.stderr), 'unknown suite refused with a reason')
  r = runCli([])
  ok(r.status !== 0 && /--suite is required/.test(r.stderr), 'missing --suite refused')
  const candFile = path.join(tmp, 'cand.json')
  fs.writeFileSync(candFile, JSON.stringify({
    id: 'mock-turbo', label: 'Mock 6-step turbo',
    slot: { kind: 'tier-config', steps: 6, sampler: 'turbo', loraFile: 'mock.safetensors' },
  }))
  r = runCli(['--suite', 'tier-ladder', '--candidate', candFile, '--dry-run'])
  ok(r.status === 0 && /mock-turbo/.test(r.stdout) && /"incumbents"/.test(r.stdout),
    '--dry-run resolves the candidate and prints the plan (no GPU, no writes)')
  const badCand = path.join(tmp, 'bad-cand.json')
  fs.writeFileSync(badCand, JSON.stringify({ id: 'bad', slot: { kind: 'nope' } }))
  r = runCli(['--suite', 'tier-ladder', '--candidate', badCand, '--dry-run'])
  ok(r.status !== 0 && /not in suite slot kinds/.test(r.stderr),
    'candidate of the wrong slot kind refused')
  const missingReq = path.join(tmp, 'req-cand.json')
  fs.writeFileSync(missingReq, JSON.stringify({ id: 'x', slot: { kind: 'tier-config' } }))
  r = runCli(['--suite', 'tier-ladder', '--candidate', missingReq, '--dry-run'])
  ok(r.status !== 0 && /requires slot\.steps/.test(r.stderr),
    'candidate missing a required slot field refused')
  const before = fs.readFileSync(path.join(BENCH, 'results', 'registry.json'), 'utf8')
  runCli(['--suite', 'tier-ladder', '--candidate', candFile])
  ok(fs.readFileSync(path.join(BENCH, 'results', 'registry.json'), 'utf8') === before,
    'plan-only mode (no --execute) writes nothing to the registry')

  console.log('(e2) --record: run-dir -> registry row with delta verdict')
  const record = await importLib('record.mjs')
  const recReg = path.join(tmp, 'registry-record.json')
  registry.ensureEnvironment(env, recReg)
  // an incumbent row to delta against (same environment)
  registry.appendRow(registry.makeRow({
    suite: 'tier-ladder', candidate: { id: 't8', label: 'turbo tier', kind: 'arm' },
    incumbent: true, metrics: { arcface_mean: 0.18, wall_s: 117.3 },
    environmentId: 'test-env',
  }), recReg)
  const fixtureRun = path.join(tmp, 'run-fixture')
  fs.mkdirSync(fixtureRun, { recursive: true })
  fs.writeFileSync(path.join(fixtureRun, 'candidate.json'), JSON.stringify({
    id: 'mock-turbo', label: 'Mock 6-step turbo',
    slot: { kind: 'tier-config', steps: 6, sampler: 'turbo', loraFile: 'mock.safetensors' },
  }))
  fs.writeFileSync(path.join(fixtureRun, 'results.json'), JSON.stringify([
    { id: 'cand-mock-turbo_s421337', wall_s: 88.0, files: [], prompt_id: 'x' },
  ]))
  fs.writeFileSync(path.join(fixtureRun, 'metrics.json'), JSON.stringify({
    cand: { arcface_vs_ref: { f0: { cos: 0.3 }, f62: { cos: 0.32 }, f123: { cos: 0.31 } } },
  }))
  const recorded = await record.recordRun(fixtureRun, {
    suite: 'tier-ladder', environmentId: 'test-env', registryPath: recReg,
  })
  ok(recorded.incumbent === false && recorded.environmentId === 'test-env',
    'recorded row carries candidate + environment metadata')
  ok(recorded.metrics.arcface_vs_ref_f0_cos === 0.3 && recorded.metrics.wall_s === 88,
    'headline metrics flattened from the analyzer output (arcface + wall)')
  ok(/delta vs incumbents/.test(recorded.verdict.text) && /\[t8\]/.test(recorded.verdict.text),
    'verdict computed as a delta vs the incumbent row')
  ok(registry.loadRegistry(recReg).rows.length === 2, 'row appended to the registry')
  const before2 = registry.loadRegistry(recReg).rows.length
  // incomplete run dir refused loudly (no silent skips)
  const badRun = path.join(tmp, 'run-bad')
  fs.mkdirSync(badRun, { recursive: true })
  let recordThrew = false
  try { await record.recordRun(badRun, { suite: 'tier-ladder', environmentId: 'test-env', registryPath: recReg }) } catch { recordThrew = true }
  ok(recordThrew && registry.loadRegistry(recReg).rows.length === before2,
    'incomplete run dir refused; nothing appended')

  console.log('(e) fetch-catalog bridge (snapshot; zero network)')
  const catalog = await importLib('catalog.mjs')
  ok(catalog.catalogAvailable(), 'catalog resolvable (dist-server or committed snapshot)')
  const banner = catalog.licenseBanner('matlowai-fused-turbo-int8')
  ok(/minimax-h3-community-license/i.test(banner) && /pre-recorded \(experiment prerequisite/.test(banner),
    'license banner surfaces license + pre-recorded consent for the MATLOWAI entry')
  ok(catalog.licenseBanner('not-a-catalog-id') === null, 'unknown catalog id -> null banner')
  const modelsRoot = path.join(tmp, 'models')
  fs.mkdirSync(path.join(modelsRoot, 'diffusion_models'), { recursive: true })
  const entry = catalog.findCatalogEntry('matlowai-fused-turbo-int8')
  ok(entry.detectGlob && entry.files.length > 0, 'catalog entry carries files + detectGlob')
  ok(catalog.entryPresentIn(entry, modelsRoot) === false, 'absent entry detected as not staged')
  fs.writeFileSync(path.join(modelsRoot, 'diffusion_models',
    'minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors'), 'x')
  ok(Array.isArray(catalog.entryPresentIn(entry, modelsRoot)),
    'staged entry detected by detectGlob')
  let fetchRefused = false
  try {
    await catalog.fetchCandidate('smhfacct-hybrid-b25-49', {
      homeDirectory: path.join(tmp, 'fetch-home'), modelsRoot,
    })
  } catch (e) { fetchRefused = /not an experiment prerequisite/.test(e.message) }
  ok(fetchRefused, 'fetchCandidate refuses non-prerequisite entries (consent must be human-recorded)')

  console.log('(f) candidate parameterization — mock candidate through every build path')
  const pythonBin = process.env.BENCH_PYTHON ?? 'python3'
  const pyProbe = spawnSync(pythonBin, ['-c', 'import numpy'], { encoding: 'utf8' })
  if (pyProbe.status !== 0) {
    console.log('  skip - python3+numpy unavailable in this environment (logged reason; CI legs install both)')
  } else {
    const buildSmoke = spawnSync(pythonBin, [path.join(BENCH, 'tools', 'smoke_builds.py')],
      { encoding: 'utf8', cwd: REPO, timeout: 120_000 })
    ok(buildSmoke.status === 0 && /7\/7 suites/.test(buildSmoke.stdout),
      `every suite builds incumbent+candidate graphs (${buildSmoke.stdout.trim().split('\n').pop()})`)
    console.log('(g) metric math vs fixtures')
    const metricSmoke = spawnSync(pythonBin, [path.join(BENCH, 'tools', 'smoke_metrics.py')],
      { encoding: 'utf8', cwd: REPO, timeout: 120_000 })
    ok(metricSmoke.status === 0 && /all assertions passed/.test(metricSmoke.stdout),
      'pure metric math passes fixed-array fixtures (psnr/seam/activity/motion/thirds)')
  }

  console.log('(h) blind-judge bundle: vision:report compatibility + unblind')
  const blindjudge = await importLib('blindjudge.mjs')
  const media = path.join(tmp, 'media')
  fs.mkdirSync(media, { recursive: true })
  const items = ['P_cand', 'Q_incumbent'].map((tag) => {
    const img = path.join(media, `blind_${tag}_contact.png`)
    fs.writeFileSync(img, TINY_PNG)
    return { label: tag, candidateId: `cand-${tag}`, image: img }
  })
  const { bundleDir } = blindjudge.emitBundle({
    suite: 'tier-ladder', runId: 'test-blind', items,
    rubricText: 'Test rubric: judge overall render quality.',
    outRoot: path.join(tmp, 'bundles'),
  })
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'))
  ok(manifest.scenarios[0].checkpoints.length === 2 && manifest.kind === 'benchmark-blind-judge',
    'manifest carries lettered checkpoints in the vision shape')
  ok(fs.existsSync(path.join(bundleDir, 'sealed-mapping.json')) &&
    Object.keys(JSON.parse(fs.readFileSync(path.join(bundleDir, 'sealed-mapping.json'), 'utf8'))).length === 2,
    'sealed mapping written with both letters')
  // unjudged bundle MUST fail the vision:report gate
  let report = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'vision-e2e', 'report.cjs'), bundleDir],
    { encoding: 'utf8' })
  ok(report.status !== 0 && /NOT JUDGED/.test(report.stderr + report.stdout),
    'unjudged bundle fails pnpm vision:report (loud, not a pass)')
  // judged fixture passes
  const verdicts = {
    runId: manifest.runId, judgedAt: new Date().toISOString(), judge: 'test',
    checkpoints: Object.fromEntries(manifest.scenarios[0].checkpoints.map((cp) => [
      cp.id, { verdict: 'pass', confidence: 0.9, rechecked: false, summary: 'fixture', issues: [] },
    ])),
  }
  fs.writeFileSync(path.join(bundleDir, 'verdicts.json'), JSON.stringify(verdicts))
  report = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'vision-e2e', 'report.cjs'), bundleDir],
    { encoding: 'utf8' })
  ok(report.status === 0 && /all 2 checkpoints PASS/.test(report.stdout),
    'judged bundle passes pnpm vision:report unchanged')
  const unblinded = blindjudge.unblindBundle(bundleDir)
  ok(Object.keys(unblinded.perCandidate).length === 2 &&
    unblinded.perCandidate[Object.keys(unblinded.perCandidate)[0]].verdict === 'pass',
    'unblind maps letters back to candidates with verdicts')

  console.log(`\nbenchmarks offline suite: ${passed} assertions passed`)
}

main().catch((e) => {
  console.error(`\nbenchmarks offline suite FAILED: ${e.message}`)
  process.exit(1)
})
