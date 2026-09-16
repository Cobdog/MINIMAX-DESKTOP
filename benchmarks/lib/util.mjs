// Shared path + JSON helpers for the benchmarks CLI.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BENCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(BENCH_ROOT, '..')
export const SUITES_DIR = path.join(BENCH_ROOT, 'suites')
export const REGISTRY_PATH = path.join(BENCH_ROOT, 'results', 'registry.json')
export const LEADERBOARD_PATH = path.join(BENCH_ROOT, 'LEADERBOARD.md')

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const staged = `${file}.tmp`
  fs.writeFileSync(staged, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(staged, file)
}

export function exists(file) {
  return fs.existsSync(file)
}

export function nowIso() {
  return new Date().toISOString()
}

/** Stable, sortable row id: <date>.<suite>.<candidate>[@<suffix>] */
export function rowId(suite, candidateId, at = new Date()) {
  const day = at.toISOString().slice(0, 10)
  return `${day}.${suite}.${candidateId}`
}
