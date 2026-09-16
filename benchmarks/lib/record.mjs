// --record: turn a completed run dir (results.json + metrics.json +
// candidate.json from the suite runner + analyzer) into a registry row, with
// the verdict computed as a DELTA vs the suite's incumbent rows under the
// same environment. This is the "every run appends a measured row" step.
import fs from 'node:fs'
import path from 'node:path'
import { captureEnvironment } from './environment.mjs'
import { appendRow, ensureEnvironment, loadRegistry, makeRow, suiteIncumbents } from './registry.mjs'
import { loadSuite } from './suites.mjs'
import { readJson } from './util.mjs'

/** Flatten an analyzer metrics.json into headline scalar metrics (mean of
 * numeric leaves under stable keys). Suite-agnostic on purpose: the analyzer
 * owns the deep shape; the registry row keeps headline numbers + the deep
 * metrics verbatim under `metrics.raw`. */
function headline(metrics) {
  const out = {}
  const walk = (prefix, obj) => {
    if (obj === null || obj === undefined) return
    if (typeof obj === 'number') {
      out[prefix.replace(/^_+/, '')] = Math.round(obj * 10000) / 10000
      return
    }
    if (Array.isArray(obj)) {
      const nums = obj.filter((x) => typeof x === 'number')
      if (nums.length) out[`${prefix}_mean`] = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10000) / 10000
      return
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) walk(prefix ? `${prefix}_${k}` : k, v)
    }
  }
  // the candidate arm flattens WITHOUT its arm prefix (analyzers key the
  // candidate arm as `cand` / `cand-<id>`); other arms keep theirs
  const entries = {}
  for (const [k, v] of Object.entries(metrics)) {
    if (/^cand(-|$)/.test(k)) Object.assign(out, headline.cand(v))
    else entries[k] = v
  }
  walk('', entries)
  return out
}
// helper: flatten a candidate-arm sub-object with no prefix
function candFlatten(obj) {
  const out = {}
  const walk = (prefix, o) => {
    if (o === null || o === undefined) return
    if (typeof o === 'number') { out[prefix.replace(/^_+/, '')] = Math.round(o * 10000) / 10000; return }
    if (Array.isArray(o)) {
      const nums = o.filter((x) => typeof x === 'number')
      if (nums.length) out[`${prefix}_mean`] = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10000) / 10000
      return
    }
    if (typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(prefix ? `${prefix}_${k}` : k, v)
  }
  walk('', obj)
  return out
}
headline.cand = candFlatten

function pickComparand(candidateHeadline, incumbentHeadline) {
  // prefer a shared QUALITY metric; fall back to wall_s when it is the only
  // shared headline (a wall-only overlap is still an honest delta)
  const shared = Object.keys(candidateHeadline).filter((k) => k in incumbentHeadline)
  const quality = shared.filter((k) => !k.startsWith('wall') && !k.startsWith('walls'))
  return quality[0] ?? shared.find((k) => k === 'wall_s') ?? null
}

export async function recordRun(runDir, {
  suite, environmentId = null, capturedEnvironment = null, registryPath, notes,
} = {}) {
  const resultsPath = path.join(runDir, 'results.json')
  const metricsPath = path.join(runDir, 'metrics.json')
  const candPath = path.join(runDir, 'candidate.json')
  for (const f of [resultsPath, metricsPath, candPath]) {
    if (!fs.existsSync(f)) throw new Error(`run dir incomplete (missing ${path.basename(f)}): ${runDir}`)
  }
  const results = readJson(resultsPath)
  const metrics = readJson(metricsPath)
  const candidate = readJson(candPath)
  const cfg = loadSuite(suite)

  // walls from the run rows (candidate + incumbent arms)
  const walls = {}
  for (const row of results) {
    if (typeof row.wall_s === 'number') walls[row.id] = Math.round(row.wall_s * 10) / 10
  }
  const candWallKey = Object.keys(walls).find((k) => k.startsWith(`cand-${candidate.id}_`))
  const candHeadline = {
    ...headline(metrics),
    ...(candWallKey ? { wall_s: walls[candWallKey] } : {}),
  }

  // environment: explicit id, else capture live and record it
  let envId = environmentId
  if (!envId) {
    const cap = capturedEnvironment ?? await captureEnvironment()
    envId = `env-${cap.gpu}-${cap.driver}-${cap.comfyui}`.replace(/[^a-z0-9.-]+/gi, '-').slice(0, 80)
    ensureEnvironment({ ...cap, id: envId, source: 'run' }, registryPath)
  }

  // verdict = delta vs the incumbent rows under the same environment
  const reg = loadRegistry(registryPath)
  const incumbents = suiteIncumbents(reg, suite, envId)
  const deltas = []
  for (const inc of incumbents) {
    const incHeadline = { ...headline(inc.metrics) }
    const key = pickComparand(candHeadline, incHeadline)
    if (key) {
      const d = candHeadline[key] - incHeadline[key]
      deltas.push(`${key}: ${candHeadline[key]} vs ${incHeadline[key]} (${d >= 0 ? '+' : ''}${Math.round(d * 10000) / 10000}) [${inc.candidate.id}]`)
    } else {
      deltas.push(`no shared headline metric with ${inc.candidate.id} — compare in LEADERBOARD.md`)
    }
  }
  const verdict = {
    text: deltas.length ? `delta vs incumbents — ${deltas.join('; ')}` :
      'no incumbent row under this environment yet — run the incumbents first for delta verdicts',
    deltaVsIncumbent: deltas,
  }

  const row = makeRow({
    suite,
    candidate: { id: candidate.id, label: candidate.label ?? candidate.id, kind: candidate.slot?.kind ?? 'candidate', source: 'run' },
    incumbent: false,
    metrics: { ...candHeadline, walls, raw: metrics },
    environmentId: envId,
    verdict,
    provenance: { runDir: path.basename(runDir), suiteFamily: cfg.family, ...(notes ? { notes } : {}) },
  })
  appendRow(row, registryPath)
  return row
}
