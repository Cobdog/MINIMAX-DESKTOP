import fs from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The one place the app's version is read from package.json — injected as a
// build-time constant so the renderer can stamp it into the diagnostic
// report without importing JSON at runtime.
const appVersion = (JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version

// Dev flow: `pnpm start:server` (or dev:server) runs the app on :4178 — no
// proxy needed. `pnpm dev` (vite HMR on :5173) proxies API calls to a server
// already running on 4178.
export default defineConfig({
  plugins: [react()],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  build: { outDir: 'dist' },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4178' } },
})
