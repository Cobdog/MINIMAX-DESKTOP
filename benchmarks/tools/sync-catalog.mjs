// Regenerate benchmarks/data/catalog-snapshot.json from the REAL fetch catalog
// (dist-server/server/fetchCatalog.js — the compiled server/fetchCatalog.ts).
// The snapshot is the offline fallback for catalog.mjs (dry-runs, CI before
// build, laptops without a build); it carries exactly the fields the
// benchmark bridge needs. Run after `pnpm build:server` whenever the catalog
// changes:  node benchmarks/tools/sync-catalog.mjs
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '..', '..', 'dist-server', 'server', 'fetchCatalog.js')
if (!fs.existsSync(dist)) {
  console.error('dist-server/server/fetchCatalog.js missing — run pnpm build:server first')
  process.exit(1)
}
const { FETCH_CATALOG } = require(dist)
const snapshot = FETCH_CATALOG.map((e) => ({
  id: e.id, name: e.name, group: e.group, description: e.description,
  licenseSpdx: e.licenseSpdx, licenseNote: e.licenseNote, licenseUrl: e.licenseUrl,
  destination: e.destination, files: e.files, detectGlob: e.detectGlob,
  sizeBytes: e.sizeBytes, experimentPrerequisite: e.experimentPrerequisite === true,
  optional: e.optional === true, homepage: e.homepage,
}))
const out = path.resolve(here, '..', 'data', 'catalog-snapshot.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n')
console.log(`snapshot: ${snapshot.length} catalog entries -> ${path.relative(process.cwd(), out)}`)
console.log(`experimentPrerequisite entries: ${snapshot.filter((e) => e.experimentPrerequisite).length}`)
