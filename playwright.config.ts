import { defineConfig } from '@playwright/test'

// E2E runs against the REAL app: the built standalone server + SPA on a
// scratch config home. HTTPS is disabled for deterministic runs (TLS is
// covered by smoke:server). Viewport is pinned to 1920x1080 so screenshots
// can be inspected with the vision MCP tooling.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4199',
    viewport: { width: 1920, height: 1080 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dist-server/server/index.js',
    url: 'http://127.0.0.1:4199/api/lan/settings',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      MINIMAX_STUDIO_HOME: 'test-home',
      MINIMAX_LAN_PORT: '4199',
      MINIMAX_NO_HTTPS: '1',
    },
  },
})
