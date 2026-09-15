import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

// ---------------------------------------------------------------------------
// SYSTEM CHROMIUM POLICY — this suite NEVER downloads a bundled browser.
//
// Playwright launches the machine's own Chromium/Google Chrome. `pnpm install`
// fetches nothing (the `playwright` package in this lockfile has no postinstall
// script, and no `playwright install` command is run anywhere — CI included:
// GitHub's ubuntu runners and typical dev boxes already ship Chrome/Chromium).
// Resolution order:
//   1. MINIMAX_TEST_BROWSER env — explicit executable path override (any OS).
//   2. Common install paths for chromium / google-chrome / chrome (Linux + Windows).
//   3. A scan of $PATH for the same binary names.
// If nothing is found the config throws with one clear line — a missing system
// browser is a SETUP ERROR to fix on the machine, never a silent skip.
// ---------------------------------------------------------------------------
const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
  ...(process.env.LOCALAPPDATA
    ? [path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')]
    : []),
]
// Google Chrome is probed BEFORE distro Chromium on purpose: Chrome ships the
// proprietary codec set (H.264/AAC), while Debian/Ubuntu-packaged chromium
// builds ship without them — the filmstrip e2e proves pooled VIDEO playback
// and needs a decodable mp4. Distro chromium remains a valid fallback where
// it is codec-complete (e.g. Arch); the spec side guards with a loud skip
// when the resolved browser cannot decode H.264 at all.
const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chrome',
  '/snap/bin/chromium',
]
const PATH_BINARY_NAMES = process.platform === 'win32'
  ? ['chromium.exe', 'chrome.exe']
  : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']

function detectSystemChromium(): string {
  const override = process.env.MINIMAX_TEST_BROWSER?.trim()
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`MINIMAX_TEST_BROWSER points at a missing executable: ${override}`)
    }
    return override
  }
  const candidates = process.platform === 'win32' ? WINDOWS_CANDIDATES : LINUX_CANDIDATES
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    for (const name of PATH_BINARY_NAMES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error(
    'No system Chromium/Chrome found — install one (or set MINIMAX_TEST_BROWSER to its executable). This suite never downloads a bundled browser.',
  )
}

const systemChromium = detectSystemChromium()

// Two projects over one shared webServer:
//   e2e    — the assertion suite (e2e/app.spec.ts).
//   vision — CAPTURE ONLY (e2e/vision-capture.spec.ts): writes a screenshot
//            bundle under test-results/vision/<run-id>/ and never judges.
//            Judgment is a harness-side step (scripts/vision-e2e/JUDGE.md),
//            reporting is `pnpm vision:report`. Run one project explicitly:
//            `playwright test --project=e2e` / `--project=vision`.
//
// outputDir is scoped to test-results/pw (Playwright WIPES its outputDir at
// every run start). The vision bundles at test-results/vision/<run-id>/ and
// the per-view shots at test-results/shots/ live OUTSIDE that wipe so a
// captured bundle survives later Playwright runs until its judge/report step.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results/pw',
  use: {
    baseURL: 'http://127.0.0.1:4199',
    // The maintainer's required surface: exactly 1920x1080 @ 1x. Every
    // screenshot (shots/, vision bundles) is comparable pixel-for-pixel.
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // System Chromium, resolved above — never a Playwright-managed download.
    // NOTE: executablePath is a LAUNCH option; a bare `executablePath` key in
    // `use` is silently ignored and Playwright falls back to its browser
    // registry (which errors on CI where no bundled browser exists).
    launchOptions: { executablePath: systemChromium },
  },
  projects: [
    // e2e: the app suite + the pose-rig dev surface (task 41ebvfo —
    // deterministic hook-driven interactions + palette-pixel assertions).
    { name: 'e2e', testMatch: /(app|poserig)\.spec\.ts/ },
    { name: 'vision', testMatch: /vision-capture\.spec\.ts/ },
  ],
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
