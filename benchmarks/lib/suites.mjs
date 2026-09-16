// Suite registry (JS mirror of benchmarks/shared/suiteconfig.py).
import fs from 'node:fs'
import path from 'node:path'
import { readJson, SUITES_DIR } from './util.mjs'

const REQUIRED_KEYS = ['name', 'family', 'measures', 'fixtures', 'arms',
  'candidateSlot', 'metrics', 'rubric', 'limits']

export function listSuites() {
  if (!fs.existsSync(SUITES_DIR)) return []
  return fs.readdirSync(SUITES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(SUITES_DIR, entry.name, 'SUITE.json')))
    .map((entry) => entry.name)
    .sort()
}

export function loadSuite(name) {
  const file = path.join(SUITES_DIR, name, 'SUITE.json')
  if (!fs.existsSync(file)) {
    throw new Error(`unknown suite '${name}' (no SUITE.json under benchmarks/suites/)`)
  }
  const cfg = readJson(file)
  for (const key of REQUIRED_KEYS) {
    if (!(key in cfg)) throw new Error(`suite ${name}: SUITE.json missing key '${key}'`)
  }
  if (cfg.name !== name) {
    throw new Error(`suite ${name}: SUITE.json name mismatch (${cfg.name})`)
  }
  return cfg
}

export function incumbents(cfg) {
  return Object.entries(cfg.arms)
    .filter(([, arm]) => arm.incumbent)
    .map(([id, arm]) => ({ id, ...arm }))
}

/** The runner module name for a suite (build_*.py / build.py present on disk). */
export function runnerInfo(cfg, name) {
  const dir = path.join(SUITES_DIR, name)
  const candidates = [
    'run_tiers.py', 'run_bakeoff.py', 'run_ed1.py', 'run_md1.py', 'run.py',
    'run_k1.py', 'run_battery.py',
  ]
  const run = candidates.find((f) => fs.existsSync(path.join(dir, f)))
  const analyze = fs.readdirSync(dir).find((f) => f.startsWith('analyze'))
  return { dir, run: run ?? null, analyze: analyze ?? null }
}
