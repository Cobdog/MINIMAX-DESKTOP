import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev flow: `pnpm start:server` (or dev:server) runs the app on :4178 — no
// proxy needed. `pnpm dev` (vite HMR on :5173) proxies API calls to a server
// already running on 4178.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4178' } },
})
