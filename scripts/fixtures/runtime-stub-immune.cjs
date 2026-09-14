'use strict'
// SIGTERM-immune variant of runtime-stub.cjs: the main process AND a spawned
// grandchild both ignore SIGTERM, proving the managed-runtime stop escalates
// to the tree-kill (POSIX process-group SIGKILL / Windows taskkill /T /F)
// and that descendants die with the tree. Grandchild outlives its parent by
// 10 s by design — anything under ~8 s proves the sweep reached it.
const { spawn } = require('node:child_process')
const http = require('node:http')

process.on('SIGTERM', () => { /* ignored on purpose */ })

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 0
if (!port) {
  process.stderr.write('runtime-stub-immune: --port is required\n')
  process.exit(2)
}

const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 10000)'], { stdio: 'ignore', windowsHide: true })
grandchild.unref()

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`)
}

const server = http.createServer((request, response) => {
  const body = request.url === '/system_stats' ? JSON.stringify({ system: { os: 'stub' }, devices: [] }) : '{}'
  response.writeHead(request.url === '/system_stats' ? 200 : 404, { 'content-type': 'application/json', 'content-length': String(body.length) })
  response.end(body)
})

server.listen(port, '127.0.0.1', () => {
  emit({ level: 'info', msg: 'grandchild', pid: grandchild.pid })
  emit({ level: 'info', msg: 'ready', fixture: 'runtime-stub-immune' })
})
