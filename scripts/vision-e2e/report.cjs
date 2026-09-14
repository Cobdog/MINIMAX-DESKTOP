#!/usr/bin/env node
'use strict'

/**
 * VISION REPORT — phase 3 of 3 (capture → judge → report).
 *
 *   pnpm vision:report [bundle-dir]
 *
 * Validates verdicts.json in a captured bundle against its manifest.json,
 * prints a per-checkpoint PASS/FAIL table with issue lists, links the
 * artifact paths, and exits non-zero when any final verdict is a fail.
 *
 * Honesty rules (mirror JUDGE.md):
 *   - A bundle without verdicts.json is NOT a pass: loud error, exit 1,
 *     with the exact dispatch instructions for the judge step.
 *   - A malformed/partial verdicts.json is NOT a pass: every problem is
 *     listed, exit 1.
 *   - Missing verdicts for manifest checkpoints count as failures.
 */

const fs = require('node:fs')
const path = require('node:path')

const VISION_ROOT = path.resolve(__dirname, '..', '..', 'test-results', 'vision')

function fail(message) {
  console.error(`\nvision:report: ${message}`)
  process.exit(1)
}

/** Resolve the bundle: explicit arg > LATEST pointer > newest directory. */
function resolveBundle(argument) {
  if (argument) {
    const explicit = path.resolve(argument)
    if (!fs.existsSync(explicit)) fail(`bundle directory does not exist: ${explicit}`)
    return explicit
  }
  const pointer = path.join(VISION_ROOT, 'LATEST')
  if (fs.existsSync(pointer)) {
    const latest = fs.readFileSync(pointer, 'utf8').trim()
    const candidate = path.join(VISION_ROOT, latest)
    if (fs.existsSync(candidate)) return candidate
  }
  if (fs.existsSync(VISION_ROOT)) {
    const newest = fs.readdirSync(VISION_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ dir: path.join(VISION_ROOT, entry.name), mtime: fs.statSync(path.join(VISION_ROOT, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]
    if (newest) return newest.dir
  }
  fail('no vision bundles found under test-results/vision/ — run `pnpm test:vision` (capture) first')
}

const bundle = resolveBundle(process.argv[2])
const manifestPath = path.join(bundle, 'manifest.json')
const verdictsPath = path.join(bundle, 'verdicts.json')

if (!fs.existsSync(manifestPath)) fail(`bundle has no manifest.json (incomplete capture?): ${bundle}`)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

if (!fs.existsSync(verdictsPath)) {
  fail([
    `bundle captured but NOT JUDGED — no verdicts.json in ${bundle}`,
    `Judge it first: dispatch a Sonnet-tier subagent with —`,
    `  "Read scripts/vision-e2e/JUDGE.md and judge the vision bundle at ${bundle}.`,
    `   Write verdicts.json into the bundle and reply with the verdict table."`,
    `Then re-run: pnpm vision:report ${bundle}`,
  ].join('\n'))
}

let verdicts
try {
  verdicts = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'))
} catch (error) {
  fail(`verdicts.json is not valid JSON (${error.message}) in ${bundle}`)
}

// ---- Shape validation ------------------------------------------------------
const problems = []
const checks = verdicts && typeof verdicts.checkpoints === 'object' && !Array.isArray(verdicts.checkpoints) ? verdicts.checkpoints : null
if (!checks) problems.push('verdicts.json must contain a "checkpoints" object keyed by checkpoint id')
if (verdicts.runId !== manifest.runId) problems.push(`verdicts runId ${JSON.stringify(verdicts.runId)} does not match manifest runId ${JSON.stringify(manifest.runId)}`)

const rows = []
for (const scenario of manifest.scenarios ?? []) {
  for (const checkpoint of scenario.checkpoints ?? []) {
    const verdict = checks ? checks[checkpoint.id] : undefined
    if (!verdict || typeof verdict !== 'object') {
      problems.push(`no verdict for checkpoint "${checkpoint.id}" — the judge must cover every manifest checkpoint`)
      rows.push({ id: checkpoint.id, label: checkpoint.label, image: checkpoint.image, verdict: 'missing', confidence: '', rechecked: false, issues: [] })
      continue
    }
    if (verdict.verdict !== 'pass' && verdict.verdict !== 'fail') {
      problems.push(`checkpoint "${checkpoint.id}": verdict must be "pass" or "fail" (got ${JSON.stringify(verdict.verdict)})`)
    }
    if (!Array.isArray(verdict.issues)) {
      problems.push(`checkpoint "${checkpoint.id}": "issues" must be an array`)
    }
    if (typeof verdict.confidence !== 'number' || verdict.confidence < 0 || verdict.confidence > 1) {
      problems.push(`checkpoint "${checkpoint.id}": "confidence" must be a number between 0 and 1`)
    }
    rows.push({
      id: checkpoint.id,
      label: checkpoint.label,
      image: checkpoint.image,
      verdict: verdict.verdict === 'pass' || verdict.verdict === 'fail' ? verdict.verdict : 'invalid',
      confidence: typeof verdict.confidence === 'number' ? verdict.confidence.toFixed(2) : '?',
      rechecked: verdict.rechecked === true,
      issues: Array.isArray(verdict.issues)
        ? verdict.issues.map((issue) => (typeof issue === 'string' ? { severity: '?', description: issue } : issue))
        : [],
    })
  }
}

const expected = new Set((manifest.scenarios ?? []).flatMap((scenario) => (scenario.checkpoints ?? []).map((checkpoint) => checkpoint.id)))
for (const id of Object.keys(checks ?? {})) {
  if (!expected.has(id)) problems.push(`verdict for unknown checkpoint "${id}" (not in manifest)`)
}

if (problems.length > 0) {
  console.error(`\nvision:report: verdicts.json failed validation (${problems.length} problem${problems.length === 1 ? '' : 's'}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(`\nBundle: ${bundle}\nRe-judge with scripts/vision-e2e/JUDGE.md (two-pass rule included), then re-run pnpm vision:report.`)
  process.exit(1)
}

// ---- Report -----------------------------------------------------------------
console.log(`\nVision bundle ${manifest.runId}`)
console.log(`  captured ${manifest.createdAt} · viewport ${manifest.viewport.width}x${manifest.viewport.height} @${manifest.viewport.deviceScaleFactor}x · ${rows.length} checkpoints`)
console.log(`  judged ${verdicts.judgedAt ?? '?'} by ${verdicts.judge ?? '?'}`)
console.log('')

let failed = 0
for (const row of rows) {
  const mark = row.verdict === 'pass' ? 'PASS' : 'FAIL'
  if (row.verdict !== 'pass') failed += 1
  console.log(`  [${mark}] ${row.id}  (confidence ${row.confidence}${row.rechecked ? ', re-checked' : ''})`)
  console.log(`         ${row.label}`)
  console.log(`         artifact: ${path.join(bundle, row.image)}`)
  for (const issue of row.issues) {
    console.log(`         issue [${issue.severity ?? '?'}]: ${issue.description ?? JSON.stringify(issue)}`)
  }
}

console.log('')
if (failed > 0) {
  console.log(`vision:report: ${failed}/${rows.length} checkpoints FAILED — ${bundle}`)
  process.exit(1)
}
console.log(`vision:report: all ${rows.length} checkpoints PASS — ${bundle}`)
process.exit(0)
