// Profile analyzer (profiler task eebh7ah): aggregates the node
// --cpu-prof/--heap-prof output (self-time by function / by file; allocation
// by site) and the Chrome pan trace (main-thread category breakdown). Pure
// read-side analysis; prints a compact summary for the report.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL("../../test-results/perf-profile/", import.meta.url))
const read = (file) => JSON.parse(readFileSync(`${dir}${file}`, 'utf8'))

// ---- CPU profile ------------------------------------------------------------
const cpu = read('profiles/server-cpu.cpuprofile')
const nodesById = new Map(cpu.nodes.map((node) => [node.id, node]))
const selfMicros = new Map()
for (let index = 0; index < cpu.samples.length; index += 1) {
  const id = cpu.samples[index]
  const delta = cpu.timeDeltas[index] ?? 0
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + delta)
}
const totalMicros = [...selfMicros.values()].reduce((a, b) => a + b, 0)
const byFunction = new Map()
const byFile = new Map()
for (const [id, micros] of selfMicros) {
  const frame = nodesById.get(id)?.callFrame
  if (!frame) continue
  const fn = `${frame.functionName || '(anonymous)'}`
  const file = (frame.url || '').replace(/^.*\/dist-server\//, 'dist-server/').replace(/^.*\/node_modules\//, 'node_modules/')
  byFunction.set(`${fn} @ ${file}:${frame.lineNumber + 1}`, (byFunction.get(`${fn} @ ${file}:${frame.lineNumber + 1}`) ?? 0) + micros)
  byFile.set(file, (byFile.get(file) ?? 0) + micros)
}
const top = (map, count) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count)
console.log(`== SERVER CPU PROFILE == sampled ${(totalMicros / 1000).toFixed(0)}ms total`)
console.log('-- top functions by SELF time --')
for (const [name, micros] of top(byFunction, 22)) console.log(`${(micros / 1000).toFixed(1).padStart(9)}ms ${((micros / totalMicros) * 100).toFixed(1).padStart(5)}% ${name}`)
console.log('-- top files by SELF time --')
for (const [name, micros] of top(byFile, 12)) console.log(`${(micros / 1000).toFixed(1).padStart(9)}ms ${((micros / totalMicros) * 100).toFixed(1).padStart(5)}% ${name}`)

// ---- Heap profile -----------------------------------------------------------
const heap = read('profiles/server-heap.heapprofile')
const allocBySite = new Map()
const walk = (node) => {
  if (node.selfSize > 0) {
    const frame = node.callFrame
    const label = `${frame.functionName || '(anonymous)'} @ ${(frame.url || '').replace(/^.*\/dist-server\//, 'dist-server/').replace(/^.*\/node_modules\//, 'node_modules/')}:${frame.lineNumber + 1}`
    allocBySite.set(label, (allocBySite.get(label) ?? 0) + node.selfSize)
  }
  for (const child of node.children ?? []) walk(child)
}
walk(heap.head)
const totalAlloc = [...allocBySite.values()].reduce((a, b) => a + b, 0)
console.log(`\n== SERVER HEAP PROFILE == sampled allocations ${(totalAlloc / 1048576).toFixed(1)} MiB`)
for (const [name, bytes] of [...allocBySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`${(bytes / 1048576).toFixed(2).padStart(8)} MiB ${((bytes / totalAlloc) * 100).toFixed(1).padStart(5)}% ${name}`)
}

// ---- Chrome pan trace --------------------------------------------------------
const traceRaw = gunzipSync(readFileSync(`${dir}artifacts/trace-tier300-panfit.json.gz`))
const trace = JSON.parse(traceRaw.toString())
const events = trace.traceEvents ?? trace
const byCategory = new Map()
let longTasks = 0
let longTaskMs = 0
for (const event of events) {
  if (event.ph !== 'X' || !event.dur) continue
  const name = event.name
  const dur = event.dur / 1000
  if (name === 'RunTask' && dur > 50) { longTasks += 1; longTaskMs += dur }
  const interesting = ['RunTask', 'FunctionCall', 'UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Composite Layers', 'RasterTask', 'GPU', 'FireAnimationFrame', 'Commit', 'ParseHTML', 'V8.Execute', 'MinorGC', 'MajorGC', 'EventDispatch', 'HitTest', 'StyleRecalculation', 'UpdateLayerTree']
  if (!interesting.includes(name)) continue
  // top-level only (no parent within same thread): approximate by tracking ts ranges is
  // expensive; instead count ALL events by name but mark totals as inclusive.
  byCategory.set(name, (byCategory.get(name) ?? 0) + dur)
}
console.log(`\n== CHROME TRACE tier-300 pan/zoom (INCLUSIVE ms by event name; tracing overhead run) ==`)
for (const [name, ms] of [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`${ms.toFixed(1).padStart(9)}ms ${name}`)
}
console.log(`long tasks >50ms: ${longTasks}, total ${longTaskMs.toFixed(0)}ms`)
