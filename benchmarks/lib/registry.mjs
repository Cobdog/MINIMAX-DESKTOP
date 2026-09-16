// Append-only results registry (AC: committed registry; every run appends
// measured rows with environment metadata; incumbents pinned as golden
// baselines so verdicts are deltas).
//
// Shape (registry.json):
// {
//   "version": 1,
//   "baselineEnvironmentId": "2026-09-rtx3090-testbed",
//   "environments": [ {id, gpu, driver, comfyui, quant, adapters, note} ],
//   "rows": [ row... ]
// }
// row: {
//   id, suite, recordedAt, candidate: {id, label, kind, source},
//   incumbent: bool, metrics: {...}, environmentId,
//   verdict: {text, deltaVsIncumbent?}, blind?: {...}, provenance: {...}
// }
//
// APPEND-ONLY: appendRow never rewrites or drops existing rows; rewriting a
// row id is a hard error (a correction is a new row superseding the old one,
// with `supersedes` pointing back).

import fs from 'node:fs'
import { nowIso, readJson, REGISTRY_PATH, rowId, writeJson } from './util.mjs'

export const METRIC_KEYS = ['metrics']
const ROW_REQUIRED = ['id', 'suite', 'recordedAt', 'candidate', 'metrics', 'environmentId']

export function emptyRegistry() {
  return {
    version: 1,
    baselineEnvironmentId: null,
    environments: [],
    rows: [],
    generatedNote: 'Append-only. Rows are never edited or removed; corrections ' +
      'append a superseding row. Regenerate LEADERBOARD.md with ' +
      '`node benchmarks/run.mjs --regen-leaderboard`.',
  }
}

export function loadRegistry(file = REGISTRY_PATH) {
  if (!fs.existsSync(file)) return emptyRegistry()
  const reg = readJson(file)
  if (reg.version !== 1) throw new Error(`registry version ${reg.version} not supported`)
  if (!Array.isArray(reg.rows)) throw new Error('registry.rows must be an array')
  return reg
}

export function validateRow(row) {
  for (const key of ROW_REQUIRED) {
    if (!(key in row)) throw new Error(`registry row missing key '${key}'`)
  }
  if (typeof row.metrics !== 'object' || row.metrics === null) {
    throw new Error('registry row metrics must be an object')
  }
  if (typeof row.environmentId !== 'string' || !row.environmentId) {
    throw new Error('registry row needs an environmentId (see environments[])')
  }
  return true
}

export function appendRow(row, file = REGISTRY_PATH) {
  validateRow(row)
  const reg = loadRegistry(file)
  if (reg.rows.some((r) => r.id === row.id)) {
    throw new Error(`registry row id '${row.id}' already exists — the registry is ` +
      'append-only; append a superseding row instead (set supersedes)')
  }
  if (row.environmentId !== reg.baselineEnvironmentId &&
      !reg.environments.some((e) => e.id === row.environmentId)) {
    throw new Error(`row environmentId '${row.environmentId}' not declared in ` +
      'registry.environments — record the environment block first')
  }
  reg.rows.push(row)
  writeJson(file, reg)
  return reg
}

export function ensureEnvironment(env, file = REGISTRY_PATH) {
  const reg = loadRegistry(file)
  const existing = reg.environments.find((e) => e.id === env.id)
  if (existing) {
    for (const axis of ['gpu', 'driver', 'comfyui']) {
      if (env[axis] && env[axis] !== 'unknown' && existing[axis] !== env[axis]) {
        throw new Error(`environment '${env.id}' already recorded with ${axis}=` +
          `'${existing[axis]}'; refusing to silently change it to '${env[axis]}' — ` +
          'use a new environment id (environments are immutable, like rows)')
      }
    }
    return { registry: reg, environment: existing, added: false }
  }
  reg.environments.push(env)
  writeJson(file, reg)
  return { registry: reg, environment: env, added: true }
}

export function setBaselineEnvironmentId(id, file = REGISTRY_PATH) {
  const reg = loadRegistry(file)
  if (!reg.environments.some((e) => e.id === id)) {
    throw new Error(`cannot baseline unknown environment '${id}'`)
  }
  const previous = reg.baselineEnvironmentId
  reg.baselineEnvironmentId = id
  writeJson(file, reg)
  return { previous, baseline: id }
}

/** Build a measured row for a suite arm/candidate. */
export function makeRow({ suite, candidate, incumbent = false, metrics, environmentId, verdict, blind, provenance, at = new Date(), suffix = '' }) {
  const id = rowId(suite, candidate.id, at) + (suffix ? `@${suffix}` : '')
  const row = {
    id,
    suite,
    recordedAt: nowIso(),
    candidate,
    incumbent,
    metrics,
    environmentId,
  }
  if (verdict) row.verdict = verdict
  if (blind) row.blind = blind
  if (provenance) row.provenance = provenance
  return row
}

/** Verdicts are DELTAS vs the suite's incumbent rows under the same
 * environment. Returns { incumbents, deltaInput } for the leaderboard. */
export function suiteIncumbents(reg, suite, environmentId = null) {
  return reg.rows.filter((r) => r.suite === suite && r.incumbent &&
    (environmentId === null || r.environmentId === environmentId))
}
