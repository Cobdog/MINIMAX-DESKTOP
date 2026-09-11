'use strict'
// Fixture child for scripts/test-engine-process.cjs — portable across POSIX
// and Windows (no shell-isms; everything is plain Node). Modes:
//
//   (none)        NDJSON lines (one deliberately-invalid line, CRLF-terminated
//                 to prove raw-wrap + \r stripping), then the stdin quit
//                 protocol (exit 0 on 'quit').
//   --no-quit     like the default, but spawns the GRANDCHILD and ignores the
//                 quit line — proves forced tree-kill.
//   --grandchild  ignores SIGTERM and outlives its parent by 10 s (internal
//                 mode, spawned by --no-quit).
//   --fail-fast   writes one stderr line, exits 7 immediately (exit taxonomy).
//   --http <port> serves 200 on 127.0.0.1:<port> for http-readiness probing,
//                 then the stdin quit protocol.
const { spawn } = require('node:child_process')

const mode = process.argv[2] || ''

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`)
}

function spawnGrandchild() {
  const grandchild = spawn(process.execPath, [__filename, '--grandchild'], { stdio: 'ignore', windowsHide: true })
  grandchild.unref()
  return grandchild.pid
}

function readStdin({ neverQuit }) {
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (line === 'quit') {
        if (neverQuit) {
          emit({ level: 'info', msg: 'still-here' })
        } else {
          emit({ level: 'info', msg: 'bye' })
          process.exit(0)
        }
      }
      newline = pending.indexOf('\n')
    }
  })
  // Stdin closed without a quit line is a protocol break, not a clean stop.
  process.stdin.on('end', () => {
    if (!neverQuit) process.exit(1)
  })
}

if (mode === '--grandchild') {
  // Deliberately SIGTERM-immune: only a group SIGKILL (POSIX) or taskkill /T
  // /F (Windows) can take this process down inside the test window.
  process.on('SIGTERM', () => { /* ignored on purpose */ })
  setTimeout(() => process.exit(0), 10_000)
} else if (mode === '--fail-fast') {
  process.stderr.write('engine-child: failing fast\r\n')
  process.exit(7)
} else if (mode === '--http') {
  const port = Number(process.argv[3])
  const http = require('node:http')
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
  })
  server.listen(port, '127.0.0.1', () => {
    emit({ level: 'info', msg: 'listening', port: server.address().port })
    emit({ level: 'info', msg: 'ready' })
    readStdin({ neverQuit: false })
  })
} else {
  const neverQuit = mode === '--no-quit'
  emit({ level: 'info', msg: 'boot', fixture: 'engine-child' })
  // Deliberately invalid JSON terminated with CRLF: exercises the raw-line
  // wrap AND \r stripping in one line.
  process.stdout.write('plain text that is not json\r\n')
  if (neverQuit) emit({ level: 'info', msg: 'grandchild', pid: spawnGrandchild() })
  emit({ level: 'info', msg: 'ready' })
  readStdin({ neverQuit })
}
