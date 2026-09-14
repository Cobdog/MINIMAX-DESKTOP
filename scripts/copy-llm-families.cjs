// Build step: copies the family manifests (server/llm/families/*.json) next
// to the compiled server (dist-server/server/llm/families). tsc does not
// emit JSON, and the registry reads the manifests at runtime relative to
// __dirname — without this copy the built server would silently fall back
// to the embedded manifest.
const fs = require('node:fs')
const path = require('node:path')

const source = path.join(__dirname, '..', 'server', 'llm', 'families')
const target = path.join(__dirname, '..', 'dist-server', 'server', 'llm', 'families')
fs.cpSync(source, target, { recursive: true })
const count = fs.readdirSync(target).filter((name) => name.endsWith('.json')).length
if (count === 0) {
  console.error('copy-llm-families: no manifests found in', source)
  process.exit(1)
}
console.log(`copy-llm-families: ${count} family manifests -> ${path.relative(process.cwd(), target)}`)
