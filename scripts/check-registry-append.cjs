#!/usr/bin/env node
'use strict'

/**
 * Registry-append verification (task eg6l3v5, remediation-plan §6 A-CI).
 *
 * Runs on MAIN merges only (the full-gate "contracts" job): the golden
 * registry fixtures' entry sets are APPEND-ONLY across a merge — an entry
 * that existed on the previous main and vanished on the new one fails the
 * gate. Additions are free; removals/modifications are deliberate acts
 * that must go through a conscious golden regeneration (and land with a
 * plan note), not ride a merge silently.
 *
 *   node scripts/check-registry-append.cjs <old-ref> <new-ref>
 *
 * e.g.  node scripts/check-registry-append.cjs HEAD~1 HEAD
 *
 * The drift direction (committed goldens vs what the code generates TODAY)
 * is the SEPARATE golden-regeneration check in .github/workflows/ci.yml
 * (MINIMAX_UPDATE_GOLDEN=1 + git diff --exit-code); this script only
 * guards the append direction across the merge boundary.
 */

const { execFileSync } = require('node:child_process')

/** The golden fixtures whose entry sets are the registry contract. */
const FIXTURES = ['scripts/fixtures/registry-golden.json', 'scripts/fixtures/krea2edit-golden.json']

/** Sorted entry keys of a parsed fixture ({ entries: { name: … } }). */
function extractEntryKeys(parsed) {
  return Object.keys(parsed?.entries ?? {}).sort()
}

/** Keys present in old but missing from new (the forbidden direction). */
function removedKeys(oldKeys, newKeys) {
  const present = new Set(newKeys)
  return oldKeys.filter((key) => !present.has(key))
}

function readFixtureAt(ref, fixture) {
  const stdout = execFileSync('git', ['show', `${ref}:${fixture}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(stdout)
}

function main() {
  const [oldRef, newRef] = process.argv.slice(2)
  if (!oldRef || !newRef) {
    console.error('usage: node scripts/check-registry-append.cjs <old-ref> <new-ref>')
    process.exit(2)
  }
  let failures = 0
  for (const fixture of FIXTURES) {
    const oldKeys = extractEntryKeys(readFixtureAt(oldRef, fixture))
    const newKeys = extractEntryKeys(readFixtureAt(newRef, fixture))
    const removed = removedKeys(oldKeys, newKeys)
    const added = newKeys.filter((key) => !oldKeys.includes(key))
    if (removed.length > 0) {
      failures += 1
      console.error(`FAIL - ${fixture}: registry entries are APPEND-ONLY across main merges; these vanished:`)
      for (const key of removed) console.error(`  - ${key}`)
      console.error('  If the removal is deliberate (a family/entry retirement), it must land as a conscious')
      console.error('  golden regeneration with a remediation-plan note — not silently inside a merge.')
    } else {
      console.log(`OK - ${fixture}: ${newKeys.length} entries (${added.length} appended, 0 removed)`)
    }
  }
  process.exit(failures > 0 ? 1 : 0)
}

if (require.main === module) main()

module.exports = { FIXTURES, extractEntryKeys, removedKeys }
