#!/usr/bin/env node
'use strict'

/**
 * License audit — the machine-checkable third-party inventory (task 68rnn84;
 * lockstep check added by the license-infrastructure pass, task nwtoz6y).
 *
 * Four checks, mirroring docs/LICENSES.md + docs/licenses/registry.md:
 *
 *   1. dependencies — every DIRECT dep in package.json must resolve to a
 *      license field in its node_modules manifest, classified against the
 *      AGPLv3-compatibility allowlist. GPL-family deps are legal to combine
 *      with AGPLv3 but carry distribution duties — they WARN (record the
 *      decision in docs/LICENSES.md before committing to one). Anything
 *      missing, non-SPDX, or noncommercial/proprietary FAILS.
 *   2. vendored packs — every vendor/nodes/<dir>/ must actually ship a
 *      LICENSE file (the Apache-2.0 verdict recorded in PROVENANCE is only
 *      worth what ships in the tree).
 *   3. registry discipline — the hard invariant: no server/engineNodes.ts
 *      entry whose licenseSpdx is not permissive may be installMode
 *      'vendor'. NO-LICENSE, GPL-*, AGPL-*, CC-*, anything unresolved =
 *      user-fetch only, never vendored.
 *   4. registry lockstep — every package.json dep, every fetch-catalog
 *      entry id, every node-pack registry id, and every vendored/first-party
 *      directory must be NAMED in docs/licenses/registry.md. The registry
 *      row is part of landing an addition, never a follow-up; this check is
 *      the mechanical never-forget (the license infrastructure's maintenance
 *      charter, docs/licenses/policy.md §6).
 *
 * Output: PASS/FAIL/WARN lines + the markdown table body for the
 * docs/LICENSES.md dependency section (regenerate there after dep changes).
 * Exit non-zero on any FAIL. Runs as `pnpm license:audit` (gate + CI).
 */
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')

/** Permissive, AGPLv3-compatible, no distribution duties beyond notices. */
const PERMISSIVE = new Set([
  'MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD-4-Clause',
  'Apache-2.0', 'Zlib', 'Unlicense', 'Python-2.0', 'MPL-2.0',
  'BlueOak-1.0.0', 'CC0-1.0', 'CC-BY-4.0', 'BSL-1.0',
])

/** Licenses we may VENDOR into this repo (subset: the safe default). */
const VENDORABLE = new Set([...PERMISSIVE].filter((id) => id !== 'CC-BY-4.0'))

/** AGPLv3-compatible copyleft — WARN, needs a recorded decision. */
const COPYLEFT_RE = /^(GPL|LGPL|AGPL)-\d/

const failures = []
const warnings = []

function classify(spx) {
  if (!spx || spx === 'NONE' || spx === 'UNLICENSED') return 'FAIL'
  if (spx.startsWith('SEE LICENSE IN')) return 'FAIL'
  if (PERMISSIVE.has(spx)) return 'OK'
  if (COPYLEFT_RE.test(spx)) return 'WARN'
  return 'FAIL'
}

// --- 1. direct dependencies -------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const depNames = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
const rows = []
for (const name of depNames) {
  const manifest = path.join(repoRoot, 'node_modules', name, 'package.json')
  if (!fs.existsSync(manifest)) {
    failures.push(`dependency ${name}: no node_modules manifest (run pnpm install)`)
    rows.push(`| ${name} | ? | MISSING | FAIL |`)
    continue
  }
  const dep = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const spdx = typeof dep.license === 'string' ? dep.license : dep.license?.type || ''
  const verdict = classify(spdx)
  if (verdict === 'FAIL') failures.push(`dependency ${name}@${dep.version}: license "${spdx || '(none)'}" is not AGPLv3-compatible — resolve or replace, then record it in docs/LICENSES.md`)
  if (verdict === 'WARN') warnings.push(`dependency ${name}@${dep.version}: ${spdx} is copyleft — compatible with AGPLv3 but carries distribution duties; record the decision in docs/LICENSES.md`)
  rows.push(`| ${name} | ${dep.version} | ${spdx || '(none)'} | ${verdict === 'OK' ? 'ok' : verdict} |`)
}

// --- 2. vendored node packs ---------------------------------------------------
const vendorRoot = path.join(repoRoot, 'vendor', 'nodes')
const vendored = fs.existsSync(vendorRoot) ? fs.readdirSync(vendorRoot).filter((entry) => fs.statSync(path.join(vendorRoot, entry)).isDirectory()) : []
for (const dir of vendored) {
  const license = path.join(vendorRoot, dir, 'LICENSE')
  if (!fs.existsSync(license)) {
    failures.push(`vendored pack ${dir}: no LICENSE file in the vendor tree — the recorded SPDX verdict has no shipped basis`)
    continue
  }
  const head = fs.readFileSync(license, 'utf8').split('\n').slice(0, 4).join(' ').replace(/\s+/g, ' ').trim()
  console.log(`vendored ${dir}: LICENSE present ("${head.slice(0, 60)}…")`)
}

// --- 2b. first-party node packs (task k271ykk) --------------------------------
// OUR OWN packs live at custom-nodes/<dir> — the same LICENSE discipline
// applies (they ship in our releases and are independently releasable).
const firstPartyRoot = path.join(repoRoot, 'custom-nodes')
const firstPartyDirs = fs.existsSync(firstPartyRoot) ? fs.readdirSync(firstPartyRoot).filter((entry) => fs.statSync(path.join(firstPartyRoot, entry)).isDirectory()) : []
for (const dir of firstPartyDirs) {
  const license = path.join(firstPartyRoot, dir, 'LICENSE')
  if (!fs.existsSync(license)) {
    failures.push(`first-party pack ${dir}: no LICENSE file in custom-nodes/${dir} — our own packs ship their license`)
    continue
  }
  const head = fs.readFileSync(license, 'utf8').split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim()
  console.log(`first-party ${dir}: LICENSE present ("${head.slice(0, 60)}…")`)
}

// --- 3. registry discipline (never vendor what we can't ship) -----------------
// (Wave 1 R-02) the registry DATA moved to src/lib/nodePackRegistry.ts so the
// renderer's submit-time preflight maps classes to pack rows from the same
// entries — the license discipline checks it where it lives now.
const registryPath = path.join(repoRoot, 'src', 'lib', 'nodePackRegistry.ts')
const registry = fs.readFileSync(registryPath, 'utf8')
const arrayMatch = /ENGINE_NODE_PACKS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(registry)
const packIds = []
if (!arrayMatch) {
  failures.push('src/lib/nodePackRegistry.ts: could not locate the ENGINE_NODE_PACKS array — registry discipline not checkable')
} else {
  const entries = arrayMatch[1].match(/\{[^{}]+\}/g) ?? []
  if (entries.length === 0) failures.push('server/engineNodes.ts: ENGINE_NODE_PACKS parsed as empty — check the entry shape')
  for (const entry of entries) {
    const id = /id:\s*'([^']+)'/.exec(entry)?.[1]
    const spdx = /licenseSpdx:\s*'([^']+)'/.exec(entry)?.[1]
    const mode = /installMode:\s*'([^']+)'/.exec(entry)?.[1]
    if (id) packIds.push(id)
    if (!id || !spdx || !mode) {
      failures.push(`registry entry ${id ?? '(unparsed)'}: id/licenseSpdx/installMode must all be present — every entry carries an explicit license verdict`)
      continue
    }
    if (mode === 'vendor' && !VENDORABLE.has(spdx)) {
      failures.push(`registry entry ${id}: licenseSpdx ${spdx} is not vendorable but installMode is 'vendor' — we never vendor what we can't ship`)
    }
    if (mode === 'first-party' && !VENDORABLE.has(spdx)) {
      failures.push(`registry entry ${id}: licenseSpdx ${spdx} is not permissive but installMode is 'first-party' — our own packs release under permissive terms`)
    }
    console.log(`registry ${id}: ${spdx} / ${mode} ${((mode === 'vendor' || mode === 'first-party') && VENDORABLE.has(spdx)) ? 'ok' : '(user-fetch — license gate holds)'}`)
  }
}

// --- 4. registry lockstep (docs/licenses/registry.md) ------------------------
// The heavy diligence record must name everything reality contains: deps,
// fetch-catalog ids, pack-registry ids, shipped directories. An addition
// without its registry row fails here — the row lands with the change.
const licenseRegistryPath = path.join(repoRoot, 'docs', 'licenses', 'registry.md')
if (!fs.existsSync(licenseRegistryPath)) {
  failures.push('docs/licenses/registry.md: missing — the license registry is the diligence record every addition must land a row in')
} else {
  const licenseRegistry = fs.readFileSync(licenseRegistryPath, 'utf8')
  // Token-boundary match: `react` must not be satisfied by `react-dom`,
  // `d3-selection` must not be satisfied by `@types/d3-selection`. Colon is a
  // boundary, so the pack id `lora-form-adapter` matches inside the catalog
  // id `pack:lora-form-adapter` (same component, deliberately).
  const covers = (key) => new RegExp(`(^|[^A-Za-z0-9@/._-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9@/._-])`).test(licenseRegistry)
  const fetchCatalogPath = path.join(repoRoot, 'server', 'fetchCatalog.ts')
  const catalogIds = [...fs.readFileSync(fetchCatalogPath, 'utf8').matchAll(/^\s*id: '([^']+)'/gm)].map((match) => match[1])
  const missing = []
  for (const name of depNames) if (!covers(name)) missing.push(`dependency ${name}`)
  for (const id of catalogIds) if (!covers(id)) missing.push(`fetch-catalog entry ${id}`)
  for (const id of packIds) if (!covers(id)) missing.push(`node-pack registry entry ${id}`)
  for (const dir of vendored) if (!covers(dir)) missing.push(`vendored pack ${dir}`)
  for (const dir of firstPartyDirs) if (!covers(dir)) missing.push(`first-party pack ${dir}`)
  for (const item of missing) failures.push(`registry lockstep: ${item} has no docs/licenses/registry.md row — the row is part of landing the addition, never a follow-up`)
  console.log(`registry lockstep: ${depNames.length} deps, ${catalogIds.length} fetch-catalog ids, ${packIds.length} pack ids, ${vendored.length + firstPartyDirs.length} shipped dirs — ${missing.length === 0 ? 'all named in docs/licenses/registry.md' : `${missing.length} MISSING`}`)
}

// --- report -------------------------------------------------------------------
console.log('\nDependency table body (docs/LICENSES.md §1):')
console.log(rows.join('\n'))
for (const warning of warnings) console.log(`WARN: ${warning}`)
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`)
  process.exit(1)
}
console.log(`\nlicense audit PASS (${depNames.length} direct deps, ${vendored.length} vendored packs)`)
