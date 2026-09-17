// Chrome heap-snapshot analyzer (profiler task eebh7ah): aggregates the
// .heapsnapshot (v8 serialization: nodes/edges/meta.string_table) by object
// type + constructor name, and totals self size — the SPA-side memory story
// for the density report.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL("../../test-results/perf-profile/", import.meta.url))
const snap = JSON.parse(readFileSync(`${dir}artifacts/heap-tier300-fit.heapsnapshot`, 'utf8'))
const { nodes, strings } = snap
// node_fields: type, name, id, self_size, edge_count, detachedness
const fields = snap.snapshot.meta.node_fields
const typeIndex = fields.indexOf('type')
const nameIndex = fields.indexOf('name')
const selfIndex = fields.indexOf('self_size')
const width = fields.length

const nodeTypes = snap.snapshot.meta.node_types[0]
const byName = new Map()
let totalSelf = 0
let nodeCount = 0
for (let offset = 0; offset < nodes.length; offset += width) {
  const typeName = nodeTypes[nodes[offset + typeIndex]]
  const name = strings[nodes[offset + nameIndex]]
  const self = nodes[offset + selfIndex]
  nodeCount += 1
  totalSelf += self
  if (typeName !== 'object' && typeName !== 'native' && typeName !== 'closure') continue
  const key = `${name || typeName}`
  byName.set(key, (byName.get(key) ?? 0) + self)
}
console.log(`nodes: ${nodeCount}, total self size: ${(totalSelf / 1048576).toFixed(1)} MiB`)
console.log('-- top objects by retained-self size --')
for (const [name, bytes] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)) {
  console.log(`${(bytes / 1048576).toFixed(2).padStart(8)} MiB ${name}`)
}
