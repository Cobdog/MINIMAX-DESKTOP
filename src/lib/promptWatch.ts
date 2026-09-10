/**
 * Shared polling kernel for watching a ComfyUI prompt to completion.
 *
 * Every caller-supplied `tick` does one poll round and returns:
 *   true  — the watch is finished (success or a terminal error the tick
 *           already surfaced); stop polling
 *   false — still rendering; poll again after intervalMs
 * A tick that THROWS counts as a failed round: transient failures are
 * retried, and only `tolerance` consecutive failures (or the wall-clock
 * deadline) exhaust the watch with a single clear message.
 *
 * This replaces the previous per-workspace loops, which failed in opposite
 * directions: one transient network error killed still-running watches,
 * while other loops swallowed errors forever with no deadline.
 */
export type PollLoop = { cancel: () => void }

export function startPollLoop(config: {
  tick: () => Promise<boolean>
  intervalMs: number
  /** Consecutive failed ticks allowed before giving up (default 5). */
  tolerance?: number
  /** Hard wall-clock cap on the whole watch (default 30 minutes). */
  deadlineMs?: number
  onExhausted: (message: string) => void
}): PollLoop {
  const tolerance = config.tolerance ?? 5
  const deadlineMs = config.deadlineMs ?? 30 * 60 * 1000
  const startedAt = Date.now()
  let failures = 0
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
  }
  const schedule = () => {
    timer = setTimeout(() => void run(), config.intervalMs)
  }
  const run = async () => {
    if (cancelled) return
    if (Date.now() - startedAt > deadlineMs) {
      config.onExhausted(`Still rendering after ${Math.round(deadlineMs / 60000)} minutes with no completion. ComfyUI may have stopped responding — check its queue before retrying.`)
      stop()
      return
    }
    let finished: boolean
    try {
      finished = await config.tick()
    } catch {
      failures += 1
      if (failures > tolerance) {
        config.onExhausted(`Could not reach ComfyUI for ${tolerance + 1} consecutive checks. Verify that it is still running, then retry.`)
        stop()
        return
      }
      schedule()
      return
    }
    if (cancelled) return
    if (finished) {
      stop()
      return
    }
    failures = 0
    schedule()
  }
  void run()
  return { cancel: stop }
}
