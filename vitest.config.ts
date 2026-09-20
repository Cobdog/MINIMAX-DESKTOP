import { defineConfig } from 'vitest/config'

// Vitest migration (task z7ogmig, 2026-09-20). One invocation runs every
// unit suite that scripts/run-gate.cjs used to chain serially; the suites
// themselves live in tests/*.test.js (ported near-verbatim from
// scripts/test-*.cjs — assertion bodies unchanged, node:assert kept).
export default defineConfig({
  test: {
    // Restrictive on purpose: the repo's Playwright specs are e2e/*.spec.ts
    // and must stay owned by Playwright, not vitest.
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // Process-per-file: today's suites each ran as their own node process
    // (own process.env — e.g. runtime sets NODE_TLS_REJECT_UNAUTHORIZED —
    // own native better-sqlite3 handles). The forks pool with default
    // isolation preserves exactly that; threads would share the realm.
    pool: 'forks',
    // Full parallelism ACROSS files; tests WITHIN a file stay sequential
    // (state flows across a suite's sections, same as the linear scripts).
    fileParallelism: true,
    // Cap the shared dev box politely (20 cores, other agents live here);
    // CI runners (4 cores) stay at their natural default below this.
    // (vitest 5: former poolOptions.forks.* moved to top-level options.)
    maxForks: 8,
    // The ported suites are whole-scenario flows (server boots, ~1 GB
    // fixture writes, ffmpeg pipelines) — the old gate allowed 5–20 min
    // per suite; a per-test ceiling of 20 min matches the most generous.
    testTimeout: 20 * 60_000,
    hookTimeout: 5 * 60_000,
    teardownTimeout: 60_000,
  },
})
