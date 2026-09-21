/**
 * Targeted object_info presence probe with a TTL cache (remediation Wave 2,
 * A-8 — direction-audit DA-8). A loaded instance's FULL /object_info is
 * megabytes; the pack board re-resolves its live chips on every settings
 * change, save, and engine recovery, and pulling the whole registry for a
 * yes/no-per-class verdict turned the restart fix into its own stall.
 *
 * The probe asks the instance about ONE class at a time —
 *   GET /object_info/{node_class}
 * — which the pinned revision answers with `{ "<class>": node_info }` when
 * the class is served and **HTTP 200 with `{}` when it is not**: key-miss
 * is the absence signal, never the status (docs/devdocs/comfyui-api/
 * index.md §4 + divergence note 4 — verified against server.py:813-819 at
 * a87667f). Results are cached per (engine url, class) for a short TTL so
 * a board refresh that asks the same classes is free; `probe.refresh`
 * clears the cache for one url when the caller knows the engine restarted
 * (the explicit Refresh affordance).
 *
 * Everything stays ASYNC and OFF the main loop (A-7): the probe issues
 * bounded-concurrency fetches (small sequential batches — a local engine
 * is never asked for more than BATCH parallel responses) and never touches
 * the filesystem or SQLite. An unreachable engine answers 'unknown' per
 * class — the caller's existing unknown-verdict contract.
 */
export type ClassPresence = 'present' | 'absent' | 'unknown'

/** How long one (url, class) verdict stands. Short by design: pack chips
 *  must flip to 'active' soon after an engine restart even without an
 *  explicit Refresh, and the cheap {} answers make re-probing harmless. */
const PROBE_TTL_MS = 10_000

/** Parallel asks per batch — polite to the engine and to the event loop. */
const PROBE_BATCH = 6

type CacheEntry = { presence: ClassPresence; at: number }

export type ObjectInfoProbe = {
  /** One class's live verdict (cached within the TTL). */
  classPresence(engineUrl: string, className: string): Promise<ClassPresence>
  /** Drop one engine's cached verdicts (the explicit-refresh path). */
  refresh(engineUrl: string): void
}

/** Builds a probe over an injected fetcher (core.ts's comfyFetch funnel —
 *  the SSRF guard and timeouts apply to every ask by construction). */
export function createObjectInfoProbe(fetcher: (url: string, path: string) => Promise<unknown>): ObjectInfoProbe {
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<ClassPresence>>()

  const ask = async (engineUrl: string, className: string): Promise<ClassPresence> => {
    try {
      const body = await fetcher(engineUrl, `/object_info/${encodeURIComponent(className)}`)
      // 200 {} = the instance answered and does not serve the class; any
      // object carrying the class key = served. Shape-tolerant on purpose
      // (the lean bare-object instance precedent): presence is key-presence.
      if (body && typeof body === 'object' && className in (body as Record<string, unknown>)) return 'present'
      return 'absent'
    } catch {
      return 'unknown'
    }
  }

  return {
    async classPresence(engineUrl, className) {
      const key = `${engineUrl}\u0000${className}`
      const cached = cache.get(key)
      if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.presence
      const running = inFlight.get(key)
      if (running) return running
      const pending = ask(engineUrl, className).then((presence) => {
        cache.set(key, { presence, at: Date.now() })
        inFlight.delete(key)
        return presence
      })
      inFlight.set(key, pending)
      return pending
    },
    refresh(engineUrl) {
      for (const key of cache.keys()) if (key.startsWith(`${engineUrl}\u0000`)) cache.delete(key)
    },
  }
}

/** Resolves every (engine url, class) ask through the probe with bounded
 *  concurrency — the batch shape A-7 asks for when a caller needs many
 *  verdicts at once (the pack board's ~30 classes). */
export async function probeClassPresence(probe: ObjectInfoProbe, asks: Array<{ engineUrl: string; className: string }>): Promise<ClassPresence[]> {
  const results: ClassPresence[] = new Array(asks.length).fill('unknown')
  for (let start = 0; start < asks.length; start += PROBE_BATCH) {
    const batch = asks.slice(start, start + PROBE_BATCH)
    const settled = await Promise.all(batch.map(({ engineUrl, className }) => probe.classPresence(engineUrl, className)))
    for (let index = 0; index < settled.length; index += 1) results[start + index] = settled[index]
  }
  return results
}
