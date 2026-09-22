'use strict'
/** Scratch-dir ledger + teardown (Wave 4 test hygiene, R-4a).
 *
 * The 1,201 `minimax-fetch-home-*` dirs (~280 GB — the fetcher suite writes
 * REAL-sized buffers through its claiming transport to verify size pins and
 * resume) accumulated because per-run scratch homes were never torn down.
 * Every temp dir a suite or spec creates now goes through makeScratchDir and
 * the suite's afterAll calls removeAllScratchDirs — scratch cleanup is part
 * of the suite contract, verified by the clean-slate check: a full local run
 * (TMPDIR=/home/agent/tmp-gpu) leaves ZERO `minimax-` or `mm-` strays.
 *
 * Deliberately tolerant: teardown failures NOTE-log and move on (a held file
 * handle on Windows must not fail the suite), and the ledger is per-process
 * so vitest's parallel workers never race each other's dirs. */

const fs = require('node:fs')

const created = []

/** mkdtemp of PREFIX (callers pass path.join(os.tmpdir(), 'suite-prefix-')
 * as before), remembered for afterAll teardown. */
function makeScratchDir(prefix) {
  const dir = fs.mkdtempSync(prefix)
  created.push(dir)
  return dir
}

/** Drops a dir from the ledger (a suite that owns its own lifecycle for it). */
function forgetScratchDir(dir) {
  const index = created.indexOf(dir)
  if (index >= 0) created.splice(index, 1)
}

/** Removes every registered scratch dir. Call from afterAll. */
async function removeAllScratchDirs() {
  const pending = created.splice(0)
  for (const dir of pending) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      console.log(`  NOTE - scratch teardown could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

module.exports = { makeScratchDir, forgetScratchDir, removeAllScratchDirs }
