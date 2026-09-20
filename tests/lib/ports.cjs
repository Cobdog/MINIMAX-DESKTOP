'use strict'
/** Disjoint per-suite port ranges for the vitest era (task z7ogmig,
 * 2026-09-20).
 *
 * The cjs suites each probed a RANDOM port inside a suite-local range —
 * but the ranges OVERLAPPED (storage/filmstrip/realtime/documents all
 * shared 4400–4849; llm/datasets shared 4850–5149), which was safe only
 * because run-gate.cjs ran them strictly serially. Under vitest's
 * parallel file workers a probe-then-bind race between two suites picking
 * the same port becomes real, so each test file now draws from its OWN
 * disjoint range. Every allocation is still probe-verified before use
 * (something on this box squats on 4321; a busy candidate is skipped,
 * never killed — the shared-box discipline) and never handed out twice
 * within a process.
 *
 * Ranges deliberately avoid: 4178/4199 (launcher default + e2e webServer),
 * 4321 (box squatter), 5173 (vite dev), the other agents' assigned ranges
 * (5300–7199 except the launcher's historical 7000–7099 which this suite
 * keeps), 7300–7399 (this suite family's own agent range), and
 * 8188/8189/8191+ (engine — NEVER). */

const net = require('node:net')

const RANGES = {
  storage: [4200, 40],
  filmstrip: [4240, 40],
  realtime: [4280, 40],
  documents: [4320, 40],
  llm: [4360, 40],
  datasets: [4400, 40],
  runtime: [4440, 40],
  fetcher: [4480, 40],
  'engine-process': [4560, 40],
  instance: [6520, 40],
  launcher: [7000, 100],
}

function probeBusy(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ port, host: '127.0.0.1' })
    probe.on('error', () => resolve(false))
    probe.on('connect', () => { probe.destroy(); resolve(true) })
  })
}

/** Returns an async freePort() bound to the named suite's disjoint range.
 *  Rotates through the range, skipping ports already handed to this
 *  process and ports that fail the busy probe. */
function makePortAllocator(suite) {
  const [base, width] = RANGES[suite]
  if (base === undefined) throw new Error(`no port range registered for suite '${suite}'`)
  const handedOut = new Set()
  return async function freePort() {
    for (let offset = 0; offset < width; offset += 1) {
      const candidate = base + offset
      if (handedOut.has(candidate)) continue
      if (await probeBusy(candidate)) continue
      handedOut.add(candidate)
      return candidate
    }
    throw new Error(`no free port found in the ${suite} range ${base}-${base + width - 1}`)
  }
}

module.exports = { makePortAllocator, RANGES }
