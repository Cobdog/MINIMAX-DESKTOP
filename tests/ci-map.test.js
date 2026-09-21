// The CI manifest self-test (task eg6l3v5, remediation-plan §6 A-CI).
//
// The manifest (scripts/ci-map.cjs) is REVIEWED DATA that the fast PR leg
// executes verbatim — so the data gets CI-checked itself. This suite runs
// on every PR (its own rule maps .github/**, scripts/ci-map.cjs and this
// file to it), which makes "changed the CI contract" and "broke the CI
// contract" the same signal.
//
// What is enforced:
//   1. CATALOG LOCKSTEP — every tests/*.test.js on disk is catalogued in
//      the manifest's SUITES, and every catalogued suite exists on disk.
//      Adding a suite without mapping it FAILS here (and unmapping a
//      deleted suite likewise).
//   2. RULE HYGIENE — every rule names real suites and carries a reason
//      (the greppability contract: a rule without a why is unauditable).
//   3. SEAM HONESTY — the declared seam fan-outs (server core, the client
//      graph builder, the canvas kernel) resolve to their declared sets.
//      Narrowing a seam without updating this test is a visible diff.
//   4. COMPLETENESS WALK — no file in today's src/lib or server tree falls
//      through to the loud catch-alls: every real module is precisely
//      mapped. A NEW unmapped module in those trees fails here, forcing a
//      mapping decision instead of a silent full-run.
//   5. RESOLVER BEHAVIOR — fallbacks, build tiers, the Windows-leg
//      intersection, e2e escalation, docs-only emptiness.

import { test } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const REPO = path.resolve(__dirname, '..')

const { SUITES, RULES, ALL_SUITES, BOOTING, PORT_USERS, VM_SUITES, resolve, globToRegExp, suiteFromFile } = require(path.join(REPO, 'scripts', 'ci-map.cjs'))

const ok = (cond, label) => assert.ok(cond, label)
const eq = (actual, expected, label) => assert.deepEqual(actual, expected, label)

test('(1) catalog lockstep — manifest SUITES == tests/*.test.js on disk', () => {
  const onDisk = fs.readdirSync(path.join(REPO, 'tests'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => f.replace(/\.test\.js$/, ''))
    .sort()
  const catalogued = Object.keys(SUITES).sort()
  eq(catalogued, onDisk, 'every tests/*.test.js is catalogued, nothing stale in the catalog')
  for (const name of onDisk) {
    ok(fs.existsSync(path.join(REPO, 'tests', `${name}.test.js`)), `suite "${name}" file exists`)
  }
})

test('(2) rule hygiene — real suites, real reasons', () => {
  for (const rule of RULES) {
    ok(rule.reason && rule.reason.length > 10, `rule for ${rule.match[0]}… carries a reason`)
    const suites = rule.suiteFromFile ? [] : rule.suites
    for (const s of suites) {
      ok(SUITES[s] !== undefined, `rule for ${rule.match[0]}… names catalogued suite "${s}"`)
    }
  }
})

test('(2b) reachability — every suite is selected by at least one concrete resolution', () => {
  for (const name of Object.keys(SUITES)) {
    const plan = resolve([`tests/${name}.test.js`])
    ok(plan.suites.includes(name), `suite "${name}" reachable (its own file rule)`)
  }
})

test('(3) seam honesty — declared fan-outs are what the resolver produces', () => {
  const core = resolve(['server/core.ts'])
  eq(core.suites, BOOTING, 'server/core.ts fans out to every booting suite (the declared seam)')
  eq(resolve(['server/index.ts']).suites, BOOTING, 'server/index.ts is the same seam')
  eq(resolve(['src/lib/workflow.ts']).suites, ['canvas', 'h3img', 'poserig', 'registry', 'workflows'], 'src/lib/workflow.ts fans out to every client suite that loads it')
  const store = resolve(['src/canvas/store.ts'])
  eq(store.suites, ['canvas'], 'src/canvas/store.ts runs the canvas suite')
  ok(store.runE2e === true, 'src/canvas/store.ts forces e2e on the PR leg (the kernel has no direct unit execution)')
})

test('(4) completeness walk — no src/lib or server module rides a catch-all', () => {
  const LOUD = ['LOUD CATCH-ALL', 'NO RULE MATCHED']
  const srcLibFiles = fs.readdirSync(path.join(REPO, 'src', 'lib'), { recursive: true })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `src/lib/${f.replaceAll('\\', '/')}`)
  ok(srcLibFiles.length > 20, `src/lib walk found the tree (${srcLibFiles.length} files)`)
  for (const file of srcLibFiles) {
    const plan = resolve([file])
    ok(!plan.matched.some((m) => LOUD.some((marker) => m.reason.includes(marker))), `${file} has a PRECISE rule (not a catch-all/full-run)`)
  }
  const serverFiles = fs.readdirSync(path.join(REPO, 'server'), { recursive: true })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `server/${f.replaceAll('\\', '/')}`)
  ok(serverFiles.length > 20, `server walk found the tree (${serverFiles.length} files)`)
  for (const file of serverFiles) {
    const plan = resolve([file])
    ok(!plan.matched.some((m) => m.reason.includes('LOUD CATCH-ALL')), `${file} has a PRECISE rule (not the server catch-all)`)
  }
})

test('(5a) the loud fallbacks actually fire', () => {
  ok(resolve(['src/lib/someBrandNewModule.ts']).fullRun === true, 'unmapped src/lib file escalates to the full run')
  const unknown = resolve(['a-whole-new-area/thing.ts'])
  ok(unknown.fullRun === true && unknown.unmatched.length === 1, 'a wholly unknown path hits the global fallback loudly')
  const uncatalogued = resolve(['tests/not-in-catalog.test.js'])
  ok(uncatalogued.fullRun === true, 'an uncatalogued test file escalates to full (and fails the lockstep test above)')
})

test('(5b) docs-only diffs run nothing', () => {
  const plan = resolve(['docs/agent/testing.md', 'README.md', 'docs/library/README.md'])
  eq(plan.suites, [], 'no suites for docs-only changes')
  ok(plan.buildTier === null && plan.runE2e === false, 'no build, no e2e')
})

test('(5c) build tiers ride the suite catalog (the stale-dist rule)', () => {
  eq(resolve(['tests/launcher.test.js']).buildTier, 'full', 'launcher needs web + server dist (real start.sh boot)')
  eq(resolve(['tests/instance.test.js']).buildTier, 'full', 'instance route sections need the web build')
  eq(resolve(['tests/storage.test.js']).buildTier, 'server', 'storage boots dist-server')
  eq(resolve(['tests/canvas.test.js']).buildTier, null, 'VM-harness suites need no build')
})

test('(5d) the Windows leg intersects its OS-sensitive set', () => {
  eq(resolve(['server/fetcher.ts']).windowsSuites, ['fetcher', 'lora-form'], 'fetcher change runs both Windows suites that load it')
  eq(resolve(['src/lib/workflow.ts']).windowsSuites, [], 'client graph change skips the Windows leg (nothing OS-sensitive)')
  eq(resolve(['package.json']).windowsSuites, ['benchmarks', 'engine-process', 'fetcher', 'instance', 'lora-form', 'runtime'], 'infrastructure change runs the full Windows set')
  eq(resolve(['.github/workflows/engine-windows.yml']).windowsSuites, ['benchmarks', 'engine-process', 'fetcher', 'instance', 'lora-form', 'runtime'], 'changing the Windows workflow runs its full set (the leg verifies itself)')
})

test('(5e) shared test infra fans out honestly', () => {
  eq(resolve(['tests/lib/ports.cjs']).suites, PORT_USERS, 'the port allocator maps to every suite that draws ranges')
  eq(resolve(['scripts/lib/ts-vm.cjs']).suites, VM_SUITES, 'the VM harness maps to every client suite')
  ok(PORT_USERS.length === 11, 'the port-suite inventory is the declared eleven')
})

test('(5f) infrastructure inputs force the full run + license audit', () => {
  const pkg = resolve(['package.json'])
  ok(pkg.fullRun === true, 'package.json change runs everything')
  ok(pkg.licenseAudit === true, 'package.json change runs the license audit')
  ok(resolve(['vendor/nodes/some-pack/README.md']).licenseAudit === true, 'vendor changes run the license audit')
  ok(resolve(['server/fetcher.ts']).licenseAudit === false, 'unrelated server change does not')
})

test('(5g) glob matcher shapes', () => {
  ok(globToRegExp('docs/**').test('docs/a/b.md') && !globToRegExp('docs/**').test('docsx/a.md'), 'dir/** is a recursive prefix')
  ok(globToRegExp('tests/*.test.js').test('tests/foo.test.js') && !globToRegExp('tests/*.test.js').test('tests/sub/foo.test.js'), 'tests/*.test.js is one level')
  ok(globToRegExp('*.md').test('README.md') && !globToRegExp('*.md').test('docs/x.md'), '*.md is root-only')
  eq(suiteFromFile('tests/ci-map.test.js'), 'ci-map', 'suiteFromFile extracts the suite name')
})

test('(5h) e2e escalation stays narrow', () => {
  ok(resolve(['e2e/app.spec.ts']).runE2e === true && resolve(['e2e/app.spec.ts']).suites.length === 0, 'e2e spec change forces e2e, runs no unit suites')
  ok(resolve(['playwright.config.ts']).runE2e === true, 'playwright config change forces e2e')
  ok(resolve(['src/components/Foo.tsx']).runE2e === false, 'ordinary UI change does not force e2e on the PR leg')
})

test('(5i) this suite resolves to itself (the CI contract tests itself)', () => {
  const plan = resolve(['scripts/ci-map.cjs', 'tests/ci-map.test.js', '.github/workflows/ci.yml'])
  eq(plan.suites, ['ci-map'], 'CI-contract files run exactly the ci-map suite')
  ok(ALL_SUITES.includes('ci-map'), 'the catalog knows ci-map')
})
