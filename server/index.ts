/**
 * Standalone MiniMax Studio web server — the migration target (no Electron).
 *
 *   pnpm build && pnpm start:server
 *   → http://<this-machine>:4178
 *
 * Configuration lives in MINIMAX_STUDIO_HOME (default ~/.minimax-studio):
 * settings.json + the LAN access token (token only used with --token /
 * MINIMAX_LAN_TOKEN=1). ComfyUI and Ollama are expected at their usual local
 * addresses and reconfigurable from the app's Settings page.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStudioServer } from './core'

const home = process.env.MINIMAX_STUDIO_HOME ?? join(homedir(), '.minimax-studio')
mkdirSync(home, { recursive: true })

const staticRoot = join(__dirname, '..', '..', 'dist')
if (!existsSync(join(staticRoot, 'index.html'))) {
  console.error('The web build is missing — run `pnpm build:web` (or `pnpm build`) before starting the server.')
  process.exit(1)
}

const studio = createStudioServer({
  settingsFile: join(home, 'settings.json'),
  lanTokenFile: join(home, 'lan-access-token.txt'),
  tempDirectory: tmpdir(),
  documentsDirectory: join(homedir(), 'Documents'),
  staticRoot,
})

studio.startLanServer().then(() => {
  const status = studio.status()
  if (!status.running) {
    console.error(`MiniMax Studio could not start: ${status.error ?? 'unknown error'}`)
    process.exit(1)
  }
  const scheme = status.secure ? 'https' : 'http'
  console.log(`MiniMax Studio is running.`)
  console.log(`  Open:       ${scheme}://127.0.0.1:${status.port}`)
  console.log(`  On the LAN: ${scheme}://${studio.lanAddress()}:${status.port}`)
  console.log(`  Config:     ${home}`)
  if (status.secure && status.certificateFingerprint) {
    console.log(`  TLS:        self-signed (first visit shows a warning — verify this SHA-256 fingerprint, then trust it):`)
    console.log(`              ${status.certificateFingerprint}`)
  } else {
    console.log(`  TLS:        plain HTTP (PWA install and token mode are safer over HTTPS; install openssl or drop --no-https)`)
  }
  console.log(`  Auth:       ${process.argv.includes('--token') || /^(1|true|yes)$/i.test(process.env.MINIMAX_LAN_TOKEN ?? '') ? 'token required (passed as ?token= or x-minimax-token)' : 'open on the LAN (pass --token to require a token)'}`)
})
