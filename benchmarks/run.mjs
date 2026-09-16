#!/usr/bin/env node
// benchmarks/run.mjs — the candidate-driven benchmark CLI (the snake-oil detector).
//
//   node benchmarks/run.mjs --list
//   node benchmarks/run.mjs --suite <name> --candidate <path|catalogId> [--incumbents a,b|none]
//                           [--dry-run] [--execute] [--emit-blind] [--unblind <bundle>]
//                           [--regen-leaderboard] [--rebaseline] [--backfill]
//
// A NEW checkpoint / LoRA / method runs the same pinned scenes+seeds against
// pinned incumbents: the candidate is described by a small JSON (see the
// suite's SUITE.json candidateSlot), a catalog id is fetched first through the
// real fetcher (license surfaced at run start), and the measured row lands in
// the append-only registry with the verdict computed as a delta vs the
// incumbent baseline.
import fs from 'node:fs'
import path from 'node:path'
import { emitBundle, unblindBundle, visionReportHint } from './lib/blindjudge.mjs'
import { catalogAvailable, entryPresentIn, fetchCandidate, findCatalogEntry, licenseBanner } from './lib/catalog.mjs'
import { run } from './lib/exec.mjs'
import { baselineVerdict, captureEnvironment, loadBaselineEnvironment } from './lib/environment.mjs'
import { regenerateLeaderboard } from './lib/leaderboard.mjs'
import { ensureEnvironment, loadRegistry, setBaselineEnvironmentId } from './lib/registry.mjs'
import { listSuites, loadSuite, runnerInfo } from './lib/suites.mjs'
import { outRoot } from './lib/exec.mjs'
import { REPO_ROOT, writeJson } from './lib/util.mjs'

const HELP = `benchmarks/run.mjs — benchmark a candidate against pinned incumbents.

  --list                       list suites + their incumbents + candidate slots
  --suite <name>               pick a suite (see --list)
  --candidate <path|catalogId> a candidate JSON file, or a fetch-catalog id
  --incumbents <a,b|none>      incumbents to run alongside (default: the suite's pinned set)
  --dry-run                    resolve + validate + print the plan; no GPU, no registry writes
  --execute                    actually run the suite runner (GPU: the 8189 testbed runbook binds)
  --record <runDir>            append the measured row (after the analyzer): verdict computed
                               as a delta vs the suite's incumbent rows under the same environment
  --emit-blind <runId>         emit the blind-judge vision bundle from a run's artifacts
  --unblind <bundleDir>        unblind a judged bundle -> perceptual registry row (printed)
  --regen-leaderboard          regenerate benchmarks/LEADERBOARD.md from the registry
  --rebaseline                 appoint the CURRENT environment as the baseline (after
                               re-running incumbents under it)
  --backfill                   seed the registry from benchmarks/data/backfill-2026-09.json
  --fetch                      fetch a catalog candidate through the real fetcher first

Candidate JSON (suite-specific fields in SUITE.json candidateSlot):
  { "id": "my-turbo", "label": "My new 6-step turbo", "steps": 6,
    "slot": { "kind": "turbo-lora", "file": "my_turbo.safetensors", "steps": 6 } }
`

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function has(name) {
  return process.argv.includes(name)
}

function fail(msg) {
  console.error(`benchmarks: ${msg}`)
  process.exit(1)
}

function suitesMap() {
  const map = {}
  for (const name of listSuites()) map[name] = loadSuite(name)
  return map
}

// ---- --list -----------------------------------------------------------------
if (has('--list')) {
  for (const name of listSuites()) {
    const cfg = loadSuite(name)
    const inc = Object.entries(cfg.arms).filter(([, a]) => a.incumbent).map(([id, a]) => `${id} (${a.label})`)
    console.log(`\n${name} — ${cfg.family}`)
    console.log(`  measures: ${cfg.measures}`)
    console.log(`  incumbents: ${inc.join(' | ')}`)
    console.log(`  candidate slot: ${cfg.candidateSlot.description}`)
    console.log(`    kinds: ${cfg.candidateSlot.kinds.join(', ')}; requires: ${cfg.candidateSlot.requires.join(', ') || '—'}`)
  }
  process.exit(0)
}

// ---- --regen-leaderboard ----------------------------------------------------
if (has('--regen-leaderboard')) {
  const md = regenerateLeaderboard(undefined, undefined, suitesMap)
  console.log(`leaderboard regenerated (${md.split('\n').length} lines)`)
  process.exit(0)
}

// ---- --unblind --------------------------------------------------------------
if (has('--unblind')) {
  const bundleDir = path.resolve(arg('--unblind'))
  const perceptual = unblindBundle(bundleDir)
  console.log(JSON.stringify(perceptual, null, 2))
  console.log(`\nunblinded ${bundleDir} — append the perceptual row with the run's ` +
    `--record step, or judge first if verdicts.json is missing (${visionReportHint(bundleDir)})`)
  process.exit(0)
}

// ---- --emit-blind -----------------------------------------------------------
if (has('--emit-blind')) {
  const suiteName = arg('--suite') ?? fail('--emit-blind needs --suite')
  const runId = arg('--emit-blind')
  const cfg = loadSuite(suiteName)
  const media = path.join(outRoot(), suiteName, runId, 'media')
  if (!fs.existsSync(media)) fail(`no media dir for run ${suiteName}/${runId} (${media}) — run the analyzer first`)
  const items = fs.readdirSync(media)
    .filter((f) => f.startsWith('blind_') && f.endsWith('.png'))
    .map((f) => ({
      label: f.replace(/^blind_/, '').replace(/_contact\.png$|_strip\.png$/, '').replace(/\.png$/, ''),
      candidateId: f,
      image: path.join(media, f),
    }))
  if (!items.length) fail(`no blind_* artifacts in ${media} — the analyzer emits them`)
  const rubric = [cfg.rubric.contact ?? cfg.rubric.pair ?? cfg.rubric.strip]
    .filter(Boolean).join('\n')
  const { bundleDir } = emitBundle({
    suite: suiteName, runId: `${runId}-blind-${Date.now()}`, items,
    rubricText: rubric + '\n\nSuite limits the judge should know:\n' +
      cfg.limits.map((l) => `- ${l}`).join('\n'),
    outRoot: path.join(outRoot(), 'vision-bundles'),
  })
  console.log(`blind bundle emitted: ${bundleDir}`)
  console.log(`judge it (Sonnet-tier subagent) with the JUDGE-INSTRUCTIONS.md inside, then:`)
  console.log(`  ${visionReportHint(bundleDir)}`)
  console.log(`  node benchmarks/run.mjs --unblind "${bundleDir}"`)
  process.exit(0)
}

// ---- --record: append the measured row (verdict = delta vs incumbents) ------
if (has('--record')) {
  const runDir = path.resolve(arg('--record'))
  const suiteName = arg('--suite') ?? fail('--record needs --suite')
  loadSuite(suiteName) // validates
  const { recordRun } = await import('./lib/record.mjs')
  const row = await recordRun(runDir, { suite: suiteName })
  console.log(`registry row appended: ${row.id}`)
  console.log(`verdict: ${row.verdict.text}`)
  console.log('regenerate the human view: node benchmarks/run.mjs --regen-leaderboard')
  process.exit(0)
}

// ---- --rebaseline -----------------------------------------------------------
if (has('--rebaseline')) {
  const captured = await captureEnvironment()
  const id = arg('--rebaseline') || `env-${captured.gpu}-${captured.driver}`.replace(/\s+/g, '')
  const env = { ...captured, id, note: 'rebaseline: appointed by --rebaseline after incumbent re-runs' }
  ensureEnvironment(env)
  const { previous } = setBaselineEnvironmentId(id)
  console.log(`baseline environment: ${previous ?? '(none)'} -> ${id}`)
  console.log('NOTE: re-run each suite\'s incumbents under this environment BEFORE ' +
    'benchmarking candidates (verdicts are deltas vs incumbents).')
  process.exit(0)
}

// ---- --backfill (delegates to tools/backfill.mjs semantics) ------------------
if (has('--backfill')) {
  const { backfill } = await import('./tools/backfill.mjs')
  const n = await backfill()
  console.log(`backfill complete: ${n} rows appended (idempotent — existing ids skipped)`)
  process.exit(0)
}

// ---- the main path: --suite [--candidate ...] --------------------------------
const suiteName = arg('--suite') ?? fail(`--suite is required (or --list). ${HELP}`)
const cfg = loadSuite(suiteName)
const info = runnerInfo(cfg, suiteName)
if (!info.run) fail(`suite ${suiteName} has no runner script on disk`)

let candidate = null
let candidateFile = null
const candidateArg = arg('--candidate')
if (candidateArg) {
  if (fs.existsSync(candidateArg)) {
    candidate = JSON.parse(fs.readFileSync(candidateArg, 'utf8'))
    candidateFile = path.resolve(candidateArg)
  } else if (catalogAvailable() && findCatalogEntry(candidateArg)) {
    const banner = licenseBanner(candidateArg)
    console.log('== candidate license (surfaced at run start) ==')
    console.log(banner)
    const entry = findCatalogEntry(candidateArg)
    const modelsRoot = process.env.BENCH_MODELS_ROOT ??
      path.join(process.env.BENCH_TESTBED ?? '/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI', 'models')
    const present = entryPresentIn(entry, modelsRoot)
    if (present) {
      console.log(`already staged: ${present[0]}`)
    } else if (has('--fetch')) {
      console.log('fetching through the real fetcher (consent pre-recorded: experimentPrerequisite)...')
      const home = path.join(outRoot(), 'fetch-home')
      const status = await fetchCandidate(candidateArg, { homeDirectory: home, modelsRoot })
      console.log(`fetched + placed: ${(status.placedPaths ?? []).join(', ')}`)
    } else {
      fail(`catalog candidate '${candidateArg}' is not staged under ${modelsRoot} — ` +
        'run with --fetch to fetch it through the real fetcher first')
    }
    // map the catalog entry to the suite slot: the candidate JSON is derived
    // from the entry's first file (checkpoint/LoRA file name)
    const file = path.basename(entry.files?.[0]?.path ?? '')
    if (!file) fail(`catalog entry '${candidateArg}' declares no files`)
    candidate = {
      id: entry.id,
      label: `${entry.name} (catalog ${entry.id})`,
      catalogId: entry.id,
      slot: { kind: null, file, catalogId: entry.id }, // kind filled per-suite below
    }
    const kindByGroup = {
      'ref2va-bakeoff': entry.group === 'weights' && /fused|hybrid/i.test(file)
        ? 'fused-checkpoint' : 'turbo-lora',
      'hybrid-ab': 'checkpoint',
    }
    if (kindByGroup[suiteName]) {
      candidate.slot.kind = kindByGroup[suiteName]
      candidate.slot.steps = 4
    } else {
      fail(`suite '${suiteName}' needs an explicit candidate JSON for catalog id ` +
        `'${candidateArg}' (the slot semantics are suite-specific) — see SUITE.json candidateSlot`)
    }
    candidateFile = path.join(outRoot(), suiteName, 'last-catalog-candidate.json')
    writeJson(candidateFile, candidate)
  } else {
    fail(`candidate '${candidateArg}' is neither an existing file nor a known catalog id` +
      (catalogAvailable() ? '' : ' (catalog unavailable: pnpm build:server / tools/sync-catalog.mjs)'))
  }
  // validate against the slot
  const kind = candidate?.slot?.kind
  if (!kind || !cfg.candidateSlot.kinds.includes(kind)) {
    fail(`candidate kind '${kind}' not in suite slot kinds [${cfg.candidateSlot.kinds.join(', ')}]`)
  }
  for (const req of cfg.candidateSlot.requires) {
    if (!candidate.slot[req]) fail(`candidate of kind '${kind}' requires slot.${req}`)
  }
}

const incumbentsArg = arg('--incumbents')
let incumbentArms = Object.entries(cfg.arms).filter(([, a]) => a.incumbent).map(([id]) => id)
if (incumbentsArg === 'none') incumbentArms = []
else if (incumbentsArg) incumbentArms = incumbentsArg.split(',').map((s) => s.trim())

// environment + baseline gate (recorded, not guessed)
const reg = loadRegistry()
const captured = await captureEnvironment()
const baselineEnv = loadBaselineEnvironment(reg)
const gate = baselineEnv ? baselineVerdict(baselineEnv, captured) : { ok: true, changed: [] }

const plan = {
  suite: suiteName,
  family: cfg.family,
  runId: `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}`,
  candidate: candidate ? { id: candidate.id, label: candidate.label, slot: candidate.slot } : null,
  incumbents: incumbentArms,
  fixtures: { seed: cfg.fixtures.seed ?? cfg.fixtures.seeds, scene: cfg.fixtures.scene },
  metrics: cfg.metrics,
  environment: captured,
  baseline: { id: reg.baselineEnvironmentId, ok: gate.ok, changedAxes: gate.changed },
  steps: [],
}
if (candidate) plan.steps.push(`candidate arm: cand (${candidate.id})`)
plan.steps.push(...incumbentArms.map((a) => `incumbent arm: ${a}`))
plan.steps.push('analyze -> metrics.json + blind artifacts')
plan.steps.push('registry append (verdict = delta vs incumbents)')

console.log(JSON.stringify(plan, null, 2))

if (has('--dry-run')) {
  if (!gate.ok) console.warn(`\nWARNING: ${gate.reason}`)
  console.log('\n--dry-run: plan validated. No GPU touched, no registry writes.')
  process.exit(0)
}

if (!gate.ok && !has('--rebaseline-run-anyway')) fail(gate.reason)
if (!has('--execute')) {
  console.log('\nplan only (add --execute to run on the 8189 testbed per the runbook; ' +
    'the maintainer\'s GPU window rules apply).')
  process.exit(0)
}

// ---- execute: drive the suite runner with the candidate wired via env --------
const runDir = path.join(outRoot(), suiteName, plan.runId)
fs.mkdirSync(runDir, { recursive: true })
let candidateEnv = {}
if (candidate) {
  const candPath = path.join(runDir, 'candidate.json')
  writeJson(candPath, candidate)
  candidateEnv = { BENCH_CANDIDATE_JSON: candPath }
}
const armsArg = [...incumbentArms].join(',')
const res = await run('python3', [path.join(info.dir, info.run), '--run-id', plan.runId,
  ...(armsArg ? [armsArg] : [])], {
  cwd: REPO_ROOT,
  env: { BENCH_RUN_ID: plan.runId, ...candidateEnv },
  timeoutMs: 60 * 60_000 * 6,
})
console.log(res.stdout.slice(-4000))
if (res.stderr) console.error(res.stderr.slice(-2000))
if (res.code !== 0) fail(`suite runner exited ${res.code}`)
console.log(`\nrun artifacts: ${runDir} (raw, gitignored)`)
console.log('next: the analyzer (suite analyze*.py, testbed venv) -> metrics.json; then ' +
  `"node benchmarks/run.mjs --suite ${suiteName} --record ${runDir}" to append the ` +
  'measured row (verdict = delta vs incumbents); optionally --emit-blind first.')
