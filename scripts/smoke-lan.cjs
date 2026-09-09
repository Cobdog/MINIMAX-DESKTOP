const { readFile } = require('node:fs/promises')
const { join } = require('node:path')

const origin = process.env.MINIMAX_LAN_ORIGIN || 'http://127.0.0.1:4178'
const tokenPath = join(process.env.APPDATA || '', 'minimax-desktop', 'lan-access-token.txt')

async function request(path, init) {
  const response = await fetch(`${origin}${path}`, init)
  return { status: response.status, body: await response.text() }
}

async function main() {
  const token = (await readFile(tokenPath, 'utf8')).trim()
  if (!/^[a-f0-9]{32}$/i.test(token)) throw new Error('The saved LAN token is missing or invalid.')

  const studio = await request(`/?desktop=1&token=${encodeURIComponent(token)}`)
  if (studio.status !== 200 || !studio.body.includes('<div id="root"></div>')) {
    throw new Error(`Full Studio returned ${studio.status} or an invalid app shell.`)
  }

  const scriptPath = studio.body.match(/<script[^>]+src="\.([^"?]+)"/)?.[1]
  const stylePath = studio.body.match(/<link[^>]+href="\.([^"?]+\.css)"/)?.[1]
  if (!scriptPath || !stylePath) throw new Error('Full Studio did not publish its JavaScript and stylesheet assets.')
  const [script, style] = await Promise.all([fetch(`${origin}${scriptPath}`), fetch(`${origin}${stylePath}`)])
  if (!script.ok || !script.headers.get('content-type')?.includes('javascript')) {
    throw new Error(`Full Studio JavaScript returned ${script.status} ${script.headers.get('content-type') || 'without a content type'}.`)
  }
  if (!style.ok || !style.headers.get('content-type')?.includes('text/css')) {
    throw new Error(`Full Studio stylesheet returned ${style.status} ${style.headers.get('content-type') || 'without a content type'}.`)
  }

  const denied = await request('/api/lan/bootstrap', { headers: { 'x-minimax-token': 'invalid' } })
  if (denied.status !== 401) throw new Error(`An invalid LAN token returned ${denied.status}, expected 401.`)

  const allowed = await request('/api/lan/bootstrap', { headers: { 'x-minimax-token': token } })
  if (allowed.status !== 200) throw new Error(`An authorized LAN request returned ${allowed.status}, expected 200.`)

  console.log('LAN smoke passed: Full Studio shell/assets 200, invalid token 401, authorized service 200.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
