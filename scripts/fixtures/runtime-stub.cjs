'use strict'
// Stub "ComfyUI" checkout entry for scripts/test-runtime.cjs. Copied into a
// temp checkout as main.py and launched with the production argv shape
// (`<python> main.py --listen 127.0.0.1 --port N --disable-auto-launch`) —
// node runs the .py-named JS file fine, so the REAL RuntimeManager spawn
// path (command from settings, cwd checkout, fixed args) is what runs. It
// mimics exactly the properties increment 1 supervises:
//
//   • binds 127.0.0.1:<--port N>, serves /system_stats (+ /queue) as JSON
//   • emits one structured NDJSON event and one raw line (log capture)
//   • NEVER reads stdin — ComfyUI has no quit protocol, so every stop must
//     go through the grace-window → tree-kill escalation
//   • runs until killed
//
// Sibling fixtures: runtime-stub-immune.cjs (SIGTERM-immune + grandchild),
// runtime-stub-crash.cjs (healthy start, then exit 3), runtime-stub.py
// (python realism, used when an interpreter exists).
const http = require('node:http')

const port = argAfter('--port') ?? 0
if (!port) {
  process.stderr.write('runtime-stub: --port is required\n')
  process.exit(2)
}

function emit(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`)
}

const server = http.createServer((request, response) => {
  if (request.url === '/system_stats') {
    const body = JSON.stringify({ system: { os: 'stub', comfyui_version: 'stub-v1' }, devices: [{ name: 'StubDevice', vram_total: 1024, vram_free: 1024 }] })
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) })
    response.end(body)
    return
  }
  if (request.url === '/queue') {
    const body = JSON.stringify({ queue_running: [], queue_pending: [] })
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) })
    response.end(body)
    return
  }
  response.writeHead(404)
  response.end()
})

server.listen(port, '127.0.0.1', () => {
  // The profile-env injection test (increment 2) sets one probe variable and
  // asserts it arrives here — ComfyUI itself would see VDN_H3_* toggles the
  // same way (spawn env, nothing else).
  const profileProbe = process.env.MINIMAX_STUDIO_PROFILE_PROBE
  emit({ level: 'info', msg: 'boot', fixture: 'runtime-stub', port: server.address().port, pid: process.pid, ...(profileProbe ? { profileProbe } : {}) })
  process.stdout.write('runtime-stub: raw startup line\r\n')
  emit({ level: 'info', msg: 'ready' })
})

function argAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? Number(process.argv[index + 1]) : null
}
