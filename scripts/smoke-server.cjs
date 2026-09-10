// Smoke test: boots the standalone server on a scratch port + config home and
// exercises representative routes, including the security guards. Run after
// `pnpm build`. No ComfyUI required — generation connectivity is not asserted.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-smoke-'))
const port = String(4190 + Math.floor(Math.random() * 100))
const child = spawn(process.execPath, ['dist-server/server/index.js'], {
  env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: port },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (chunk) => { output += String(chunk) })
child.stderr.on('data', (chunk) => { output += String(chunk) })

const fail = (message) => {
  console.error(`FAIL: ${message}\n--- server output ---\n${output}`)
  child.kill()
  process.exit(1)
}
const timeout = setTimeout(() => fail('server did not become ready in 15 s'), 15_000)

async function waitFor(pathname) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
      if (response.ok) return response
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  fail(`${pathname} never became ready`)
}

async function main() {
  await waitFor('/api/lan/settings')
  clearTimeout(timeout)
  const base = `http://127.0.0.1:${port}`

  const index = await fetch(`${base}/`)
  const html = await index.text()
  if (index.status !== 200 || !html.includes('id="root"')) fail('SPA shell not served at /')

  const settings = await (await fetch(`${base}/api/lan/settings`)).json()
  if (typeof settings.settings?.comfyUrl !== 'string') fail('settings route returned an unexpected shape')

  const evil = await fetch(`${base}/api/lan/comfy-status?url=${encodeURIComponent('http://example.com')}`)
  if (evil.status !== 400) fail(`SSRF guard did not reject an external URL (${evil.status})`)

  const injection = await fetch(`${base}/api/lan/video/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clips: [{ source: { output: '/a.mp4' }, start: "0\nfile 'hack'" }, { source: { output: '/b.mp4' } }] }),
  })
  if (injection.status !== 400) fail(`concat-directive injection not rejected (${injection.status})`)

  const traversal = await fetch(`${base}/api/lan/media?source=output&path=${encodeURIComponent('/etc/passwd')}`)
  if (traversal.status !== 403) fail(`output-directory containment failed (${traversal.status})`)

  child.kill()
  console.log('PASS: standalone server boots, serves the SPA, and rejects SSRF / concat-injection / traversal probes')
}

void main()
