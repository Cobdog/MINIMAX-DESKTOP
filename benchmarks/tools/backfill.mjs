// Seed the registry from benchmarks/data/backfill-2026-09.json — the EXISTING
// measured results (tranches 1-3b), so the leaderboard starts full, not empty.
// Idempotent: rows already present (by id) are skipped, never rewritten.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendRow, ensureEnvironment, loadRegistry, makeRow, setBaselineEnvironmentId } from '../lib/registry.mjs'
import { REGISTRY_PATH } from '../lib/util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.resolve(here, '..', 'data', 'backfill-2026-09.json')

export async function backfill({ dataPath = DATA, registryPath = REGISTRY_PATH } = {}) {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
  const reg = loadRegistry(registryPath)
  const before = reg.rows.length

  // 1. the environment block (idempotent, immutable once recorded)
  ensureEnvironment(data.environment, registryPath)
  const regNow = loadRegistry(registryPath)
  if (!regNow.baselineEnvironmentId) {
    setBaselineEnvironmentId(data.environment.id, registryPath)
  }

  // 2. rows — deterministic ids so re-running is a no-op
  let appended = 0
  const base = new Date('2026-09-16T00:00:00Z')
  data.rows.forEach((row, i) => {
    const at = new Date(base.getTime() + i * 1000)
    const full = makeRow({
      suite: row.suite,
      candidate: row.candidate,
      incumbent: row.incumbent === true,
      metrics: row.metrics,
      environmentId: data.environment.id,
      verdict: row.verdict,
      provenance: { ...row.provenance, source: 'backfill' },
      at,
    })
    const existsAlready = loadRegistry(registryPath).rows.some((r) => r.id === full.id)
    if (existsAlready) return
    appendRow(full, registryPath)
    appended += 1
  })
  const after = loadRegistry(registryPath).rows.length
  if (after !== before + appended) {
    throw new Error(`backfill accounting mismatch: ${before} + ${appended} != ${after}`)
  }
  return appended
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  backfill().then((n) => {
    console.log(`backfill: ${n} rows appended (${loadRegistry().rows.length} total)`)
  }).catch((e) => {
    console.error(`backfill failed: ${e.message}`)
    process.exit(1)
  })
}
