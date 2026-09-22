/**
 * ComfyUI-Manager API client (task 0pktw5h — the Manager-first install
 * path, directive ffcff765). The contract is the devdocs capture
 * docs/devdocs/comfyui-manager-api/index.md against Manager 4.2.2 (the
 * shared install's pin), re-verified at build time: every route below was
 * confirmed present at tag 4.2.2 and unchanged by the 4.3 diff (dated
 * addendum in the capture).
 *
 * The 4.x distribution model honored here: Manager is a PIP PACKAGE
 * activated with --enable-manager, mounting its routes on the engine's own
 * port. Presence is therefore PROBED, never assumed — and the probe is the
 * feature flag the Manager ADDS, not the `extension.manager` KEY:
 *
 *   core ComfyUI 0.34.0 itself unconditionally answers
 *   `features.extension.manager.supports_v4 = true`
 *   (comfy_api/feature_flags.py:105, verified at /home/agent/comfyui), so
 *   bare key-presence says NOTHING about the Manager. The pip Manager
 *   (>= 4.2.1) mutates that same dict to add `supports_csrf_post = true`
 *   — THAT key is the presence signal (Manager __init__.py at 4.2.2,
 *   read from the tag).
 *
 * The v2 task-queue surface (§1 of the capture): queue a task, correlate
 * by ui_id through history; progress rides the engine WS as cm-queue-status
 * / cm-task-started / cm-task-completed (normalized in server/realtime.ts).
 * The result arrives ASYNC — the queue route answers a bare 200 and the
 * install is eventually-consistent (restart to activate; the pack board's
 * version ladder verifies the landed revision afterwards).
 *
 * PIN HONESTY (the load-bearing limitation, verified against
 * glob/manager_core.py at 4.2.2): the by-id install path only special-cases
 * selected_version 'nightly'/'unknown' — a git CLONE OF THE DEFAULT BRANCH
 * HEAD, no commit checkout. A 40-hex SHA falls through to the CNR registry
 * branches and cannot resolve for a GitHub owner/repo pack; 'latest' is
 * refused for non-CNR packs. Manager therefore installs GitHub packs at
 * the repository's CURRENT HEAD, never the studio's pinned revision. The
 * caller must state this (the studio's consent-gated fetcher remains the
 * pin-exact path); the landed folder is attributed "managed by ComfyUI" by
 * the existing version ladder with its own revision.
 */
import type { NodePackDefinition } from '../src/types'

/** The honest presence verdict for one engine, for the pack board. */
export type ManagerProbe = {
  present: boolean
  /** Plain-text answer of GET /v2/manager/version, when present. */
  version: string | null
  /** WHY the verdict is what it is — always set, never a bare false. */
  reason: string
}

export type ManagerQueueKind = 'install' | 'uninstall'

/** What the history poll knows about one queued task. */
export type ManagerTaskVerdict = {
  state: 'success' | 'failed' | 'error' | 'skipped' | 'running' | 'unknown'
  messages: string[]
  /** The task's recorded result string, when history answered one. */
  result: string | null
}

/** Fetcher = core.ts's comfyFetch funnel (SSRF guard + timeout + JSON/text). */
export type ManagerFetcher = (url: string, path: string, init?: RequestInit) => Promise<unknown>

const PROBE_TTL_MS = 10_000

export type ManagerClient = ReturnType<typeof createManagerClient>

export function createManagerClient(fetcher: ManagerFetcher) {
  const probeCache = new Map<string, { at: number; value: ManagerProbe }>()
  const probeInFlight = new Map<string, Promise<ManagerProbe>>()

  async function askProbe(engineUrl: string): Promise<ManagerProbe> {
    try {
      const features = await fetcher(engineUrl, '/features')
      const manager = features && typeof features === 'object'
        ? (features as Record<string, unknown>).extension as Record<string, unknown> | undefined
        : undefined
      const flags = manager && typeof manager === 'object' && manager.manager && typeof manager.manager === 'object'
        ? manager.manager as Record<string, unknown>
        : undefined
      if (flags?.supports_csrf_post === true) {
        // Present: the version string is best-effort (plain text; any
        // failure leaves it null — presence does not depend on it).
        const version = await fetcher(engineUrl, '/v2/manager/version').catch(() => null)
        return { present: true, version: typeof version === 'string' ? version.trim() : null, reason: 'ComfyUI-Manager is active on the connected engine.' }
      }
      return {
        present: false,
        version: null,
        reason: 'the connected engine does not advertise ComfyUI-Manager (the extension.manager.supports_csrf_post feature flag is absent — the pip Manager is not installed, or the engine was not started with --enable-manager).',
      }
    } catch (failure) {
      return {
        present: false,
        version: null,
        reason: `the engine could not be asked (${failure instanceof Error ? failure.message : String(failure)}) — Manager presence is unknown and installs use the studio's own paths.`,
      }
    }
  }

  return {
    /** The honest-absent probe (TTL-cached; refresh drops the cache). */
    async probe(engineUrl: string): Promise<ManagerProbe> {
      const cached = probeCache.get(engineUrl)
      if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
      const running = probeInFlight.get(engineUrl)
      if (running) return running
      const pending = askProbe(engineUrl).then((value) => {
        probeCache.set(engineUrl, { at: Date.now(), value })
        probeInFlight.delete(engineUrl)
        return value
      })
      probeInFlight.set(engineUrl, pending)
      return pending
    },
    refresh(engineUrl: string) {
      probeCache.delete(engineUrl)
    },
    /** Queues one task; resolves the ui_id correlation on success, throws
     *  the Manager's own error text on anything else (never a silent
     *  fallback — the caller reports and the studio path takes over only
     *  for the ABSENT verdict, not for a Manager failure). */
    async queueTask(engineUrl: string, task: {
      kind: ManagerQueueKind
      uiId: string
      clientId: string
      params: Record<string, unknown>
    }): Promise<void> {
      // application/json is deliberate: the CSRF content-type gate
      // (reject_simple_form_post) rejects form-postable bodies, and a
      // cross-origin <form> cannot forge a JSON content type.
      await fetcher(engineUrl, '/v2/manager/queue/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ui_id: task.uiId,
          client_id: task.clientId,
          kind: task.kind,
          params: task.params,
        }),
      })
    },
    /** History lookup for one task by ui_id (+client_id), shape-tolerant. */
    async historyFor(engineUrl: string, task: { uiId: string; clientId: string }): Promise<ManagerTaskVerdict> {
      const query = `?client_id=${encodeURIComponent(task.clientId)}&ui_id=${encodeURIComponent(task.uiId)}`
      const body = await fetcher(engineUrl, `/v2/manager/queue/history${query}`).catch(() => null)
      const items = Array.isArray(body)
        ? body
        : body && typeof body === 'object' && Array.isArray((body as { history?: unknown[] }).history)
          ? (body as { history: unknown[] }).history
          : []
      const mine = items.find((item) => item && typeof item === 'object'
        && typeof (item as { ui_id?: unknown }).ui_id === 'string'
        && (item as { ui_id: string }).ui_id === task.uiId)
      if (!mine) return { state: 'running', messages: [], result: null }
      const record = mine as { status?: { status_str?: unknown; completed?: unknown; messages?: unknown }; result?: unknown }
      const statusStr = typeof record.status?.status_str === 'string' ? record.status.status_str : ''
      const messages = Array.isArray(record.status?.messages)
        ? record.status!.messages.filter((entry): entry is string => typeof entry === 'string')
        : []
      const result = typeof record.result === 'string' ? record.result : null
      const state: ManagerTaskVerdict['state'] = statusStr === 'success' || statusStr === 'failed' || statusStr === 'error' || statusStr === 'skipped'
        ? statusStr
        : record.status?.completed === true ? 'unknown' : 'running'
      return { state, messages, result }
    },
    /** Best-effort installed-pack names from the Manager itself (verify —
     *  never the detection of record; object_info owns that). */
    async installedPacks(engineUrl: string): Promise<string[]> {
      const body = await fetcher(engineUrl, '/v2/customnode/installed?mode=default').catch(() => null)
      if (Array.isArray(body)) {
        return body.flatMap((entry) => {
          if (typeof entry === 'string') return [entry]
          if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') return [(entry as { name: string }).name]
          return []
        })
      }
      return []
    },
  }
}

/** The Manager pack identity for a registry pack: GitHub owner/repo (the
 *  capture §1 id grammar; CNR registry names would ride here verbatim for
 *  registry-distributed packs — none today). Null when the pack has no
 *  github identity and therefore no Manager install target. */
export function managerPackId(pack: NodePackDefinition): string | null {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)\/?$/i.exec(pack.repoUrl.trim())
  if (!match) return null
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`
}

/** Install params for one registry pack, per InstallPackParams at 4.2.2.
 *  GitHub packs install at the repository's default-branch HEAD
 *  ('nightly' + repository) — the exact pinned SHA is NOT expressible
 *  through this API (see the module header); pack-board notes must say so. */
export function managerInstallParams(pack: NodePackDefinition): Record<string, unknown> | null {
  const id = managerPackId(pack)
  if (!id) return null
  return {
    id,
    version: 'nightly',
    selected_version: 'nightly',
    // nightly requires the repository URL (the capture §1 install params).
    repository: pack.repoUrl,
    mode: 'cache',
    channel: 'default',
  }
}

/** Uninstall params for one registry pack, per UninstallPackParams at 4.2.2. */
export function managerUninstallParams(pack: NodePackDefinition): Record<string, unknown> {
  return { node_name: pack.name, is_unknown: false }
}

/** Bounded history poll until the task reaches a terminal state (the queue
 *  answers immediately; installs are git clones + pip and can take minutes).
 *  'running' after the budget is an HONEST answer, not a failure — the
 *  caller reports it as queued-and-running and the cm-queue-status WS events
 *  carry the rest. */
export async function waitForManagerTask(
  client: ManagerClient,
  engineUrl: string,
  task: { uiId: string; clientId: string },
  options: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ManagerTaskVerdict> {
  const pollMs = options.pollMs ?? 1_500
  const timeoutMs = options.timeoutMs ?? 20_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const verdict = await client.historyFor(engineUrl, task)
    if (verdict.state !== 'running') return verdict
    if (Date.now() >= deadline) return verdict
    await sleep(pollMs)
  }
}
