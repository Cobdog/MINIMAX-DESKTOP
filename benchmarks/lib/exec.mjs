// Spawn helper: every spawned process inherits the TMPDIR discipline
// (/tmp is an exhaustion-prone tmpfs; BENCH_TMPDIR defaults to
// /home/agent/tmp-gpu) — the runbook rule, encoded.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const TMPDIR = process.env.BENCH_TMPDIR ?? '/home/agent/tmp-gpu'

export function childEnv(extra = {}) {
  fs.mkdirSync(TMPDIR, { recursive: true })
  return {
    ...process.env,
    TMPDIR,
    // suite config env (benchmarks/shared/suiteconfig.py defaults mirror these)
    BENCH_TMPDIR: TMPDIR,
    ...extra,
  }
}

/** Run a command with TMPDIR + bench env; resolves {code, stdout, stderr}. */
export function run(cmd, args, { cwd, env = {}, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env: childEnv(env) })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', (e) => { clearTimeout(timer); reject(e) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export async function python3(script, args, opts = {}) {
  const bin = process.env.BENCH_PYTHON ?? 'python3'
  return run(bin, [script, ...args], opts)
}

export function outRoot() {
  return process.env.BENCH_OUT ?? path.join(process.env.BENCH_REPO ?? '.', 'test-results', 'benchmarks')
}
