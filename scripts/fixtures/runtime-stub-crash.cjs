'use strict'
// Crash variant of runtime-stub.cjs: comes up healthy (readiness passes,
// state = running), then exits with code 3 — the unexpected-death path. The
// runtime must land on state 'failed' with the exit code in lastError.
const http = require('node:http')

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 0
if (!port) {
  process.stderr.write('runtime-stub-crash: --port is required\n')
  process.exit(2)
}

const server = http.createServer((request, response) => {
  const body = JSON.stringify({ system: { os: 'stub' }, devices: [] })
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) })
  response.end(body)
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'ready', fixture: 'runtime-stub-crash' })}\n`)
  setTimeout(() => process.exit(3), 700)
})
