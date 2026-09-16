/**
 * FetchManager — the consent-gated fetch engine (task hgjbea2).
 *
 * The doctrine (docs/architecture.md §Third-party components, the Wan2GP
 * pattern): the internet is touched ONLY on explicit user action, ONLY
 * inside this module's routes, ONLY for catalog ids with a recorded
 * consent. Everything else in the app stays local-first.
 *
 *   consent     start() refuses without settings.fetch.consents[id]
 *               { consented: true } whose licenseSpdx still matches the
 *               catalog entry — the check lives HERE (the engine), not
 *               only in the route, so no caller can bypass it.
 *   pin         branch pins are resolved to the HEAD SHA at fetch time
 *               and STAMPED into the install record and the node-pack
 *               marker (LICENSES.md §9.1 — never record a moving target).
 *   verify      every file is verified against the CATALOG pins (our own
 *               data — the trust anchor): sha256 where recorded, size
 *               always. A mismatch deletes the partial file and fails the
 *               fetch; nothing unverified is ever placed.
 *   place       weights are LINKED into their model root via
 *               linkNeverCopy (AC 35m2zvh — the bytes exist exactly once,
 *               in the fetch cache; roots hold links). Node packs ride the
 *               existing installNodePack staging/marker machinery from an
 *               extracted archive. A foreign file at a destination is
 *               refused, never overwritten.
 *   record      installs land in <home>/fetcher/fetch-state.json (atomic
 *               tmp+rename): resolved revision, per-file size+sha,
 *               placement paths, license acknowledged, verification level.
 *
 * The transport is injectable. Production uses plain HTTPS with a fixed
 * host allowlist (huggingface.co + hf.co CDN + github.com +
 * codeload.github.com + api.github.com + githubusercontent) — catalog URLs
 * are code-reviewed data, redirects are re-validated per hop, and the
 * allowlist keeps a hostile redirect from aim anywhere else. Tests inject
 * an in-memory/filesystem transport; MINIMAX_STUDIO_FETCH_TEST_ORIGIN
 * rewrites origins to a local server so the real HTTP path (redirects,
 * Range resume, backoff) runs against a stub with zero real network.
 */
import { createGunzip } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { AppSettings, FetchCatalogEntry, FetchEntryStatus, FetchPin, FetchProgress } from '../src/types'
import { findNodePack, installNodePack, isUsableCheckout, linkNeverCopy, nodePackInstalledRevision, uninstallNodePack } from './engineNodes'
import { FETCH_CATALOG, fetchModelRootPath, findFetchEntry, globToRegExp, modelRootTargetPath } from './fetchCatalog'

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type DownloadOptions = {
  url: string
  /** Absolute destination path for the verified file. */
  destPath: string
  expectedSizeBytes?: number
  expectedSha256?: string
  onProgress?: (bytes: number, totalBytes: number | undefined) => void
}

export type DownloadResult = { sizeBytes: number; sha256: string; upstreamEtag?: string; resumedBytes: number }

/** Everything the engine needs from the network. The production
 *  implementation speaks HTTPS to the allowlisted hosts; tests inject
 *  fakes (the consent-gating test asserts the transport is never touched
 *  without consent). */
export type FetchTransport = {
  resolveHfRevision(repo: string, ref: string): Promise<string>
  resolveGitHead(repoUrl: string, ref: string): Promise<string>
  download(options: DownloadOptions): Promise<DownloadResult>
}

export type HttpTransportOptions = {
  /** Backoff schedule between attempts (ms). Defaults suit real networks;
   *  tests shrink them. */
  backoffMs?: number[]
  /** Per-attempt budget for a single HTTP request (ms). */
  requestTimeoutMs?: number
}

const DEFAULT_BACKOFF_MS = [1_000, 5_000, 25_000]
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 5

/** Fixed allowlist — the ONLY hosts any fetch may touch, including every
 *  redirect hop. Catalog URLs are reviewed data; this is the second lock. */
const ALLOWED_HOST_PATTERNS = [
  /(^|\.)huggingface\.co$/i,
  /(^|\.)hf\.co$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)githubusercontent\.com$/i,
]

function hostAllowed(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname
    return ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(host))
  } catch {
    return false
  }
}

/** Test seam: when set, every (allowlist-checked) URL's origin is replaced
 *  with this one, so the real HTTP machinery runs against a local stub. */
function rewriteForTest(rawUrl: string): string {
  const origin = process.env.MINIMAX_STUDIO_FETCH_TEST_ORIGIN?.trim()
  if (!origin) return rawUrl
  const parsed = new URL(rawUrl)
  const replacement = new URL(origin)
  return `${replacement.protocol}//${replacement.host}${parsed.pathname}${parsed.search}`
}

type HttpResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Readable
  finalUrl: string
}

function header(headers: HttpResponse['headers'], name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** One allowlisted, redirect-following request. The ALLOWLIST runs against
 *  the logical (real-world) URL — redirects are resolved against the
 *  logical URL, re-validated, and only then rewritten for the test origin —
 *  so a hop to anywhere else is a hard failure, never followed. */
async function requestUrl(rawUrl: string, options: { method?: string; headers?: Record<string, string>; timeoutMs: number }): Promise<HttpResponse> {
  let logical = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!hostAllowed(logical)) throw new Error(`refusing to fetch from a non-allowlisted host: ${logical}`)
    const fetchedUrl = rewriteForTest(logical)
    const client = fetchedUrl.startsWith('http:') ? await import('node:http') : await import('node:https')
    const response = await new Promise<HttpResponse>((resolveRequest, rejectRequest) => {
      const request = client.request(fetchedUrl, { method: options.method ?? 'GET', headers: options.headers, timeout: options.timeoutMs }, (res) => {
        resolveRequest({ status: res.statusCode ?? 0, headers: res.headers, body: res, finalUrl: logical })
      })
      request.on('timeout', () => { request.destroy(new Error(`request timed out after ${options.timeoutMs} ms`)) })
      request.on('error', rejectRequest)
      request.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = header(response.headers, 'location')
      if (!location) throw new Error(`redirect without a location from ${logical}`)
      response.body.destroy()
      logical = new URL(location, logical).toString()
      continue
    }
    return response
  }
  throw new Error(`too many redirects fetching ${rawUrl}`)
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The production transport: HF + GitHub over HTTPS, resumable downloads. */
export function createHttpFetchTransport(options: HttpTransportOptions = {}): FetchTransport {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  return {
    async resolveHfRevision(repo, ref) {
      const response = await requestUrl(`https://huggingface.co/api/models/${repo}/revision/${encodeURIComponent(ref)}`, { headers: { Accept: 'application/json' }, timeoutMs })
      if (response.status !== 200) throw new Error(`could not resolve ${repo}@${ref} (status ${response.status})`)
      const payload = JSON.parse(await readAll(response.body)) as { sha?: string }
      if (!/^[0-9a-f]{40}$/i.test(payload.sha ?? '')) throw new Error(`no commit SHA in the ${repo}@${ref} response`)
      return payload.sha as string
    },

    async resolveGitHead(repoUrl, ref) {
      const match = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/.exec(repoUrl.trim())
      if (!match) throw new Error(`only github.com repositories are fetchable (got ${repoUrl})`)
      const [, owner, repository] = match
      const response = await requestUrl(`https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(ref)}`, { headers: { Accept: 'application/json' }, timeoutMs })
      if (response.status !== 200) throw new Error(`could not resolve ${owner}/${repository}@${ref} (status ${response.status})`)
      const payload = JSON.parse(await readAll(response.body)) as { sha?: string }
      if (!/^[0-9a-f]{40}$/i.test(payload.sha ?? '')) throw new Error(`no commit SHA in the ${owner}/${repository}@${ref} response`)
      return payload.sha as string
    },

    async download(downloadOptions) {
      // Already-verified bytes: reuse without touching the network.
      if (existsSync(downloadOptions.destPath)) {
        const cached = await verifyFile(downloadOptions.destPath, downloadOptions.expectedSizeBytes, downloadOptions.expectedSha256)
        if (cached.ok) return { ...cached.result, resumedBytes: 0 }
        await rm(downloadOptions.destPath, { force: true })
      }
      const partPath = `${downloadOptions.destPath}.part`
      await mkdir(resolve(downloadOptions.destPath, '..'), { recursive: true })
      let lastFailure: Error | null = null
      for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
        if (attempt > 0) await sleep(backoff[attempt - 1])
        const partialBytes = existsSync(partPath) ? (await lstat(partPath)).size : 0
        try {
          const result = await downloadOnce(downloadOptions, partPath, partialBytes, timeoutMs)
          await rm(partPath, { force: true }).catch(() => undefined)
          return result
        } catch (failure) {
          lastFailure = failure instanceof Error ? failure : new Error(String(failure))
          const status = (failure as { status?: number }).status
          if (status !== undefined && status !== 429 && status < 500) throw lastFailure // permanent — do not retry
        }
      }
      await rm(partPath, { force: true }).catch(() => undefined)
      throw lastFailure ?? new Error(`download failed: ${downloadOptions.url}`)
    },
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function verifyFile(path: string, expectedSizeBytes?: number, expectedSha256?: string): Promise<{ ok: true; result: { sizeBytes: number; sha256: string } } | { ok: false }> {
  const stat = await lstat(path).catch(() => null)
  if (!stat || !stat.isFile()) return { ok: false }
  if (expectedSizeBytes !== undefined && stat.size !== expectedSizeBytes) return { ok: false }
  const sha256 = await sha256File(path)
  if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase()) return { ok: false }
  return { ok: true, result: { sizeBytes: stat.size, sha256 } }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash as unknown as NodeJS.WritableStream)
  return hash.digest('hex')
}

/** One download attempt: Range-resume from an existing .part, append-mode
 *  writes, and verification AFTER the full file exists on disk. */
async function downloadOnce(options: DownloadOptions, partPath: string, partialBytes: number, timeoutMs: number): Promise<DownloadResult> {
  const headers: Record<string, string> = { 'User-Agent': 'minimax-studio-fetcher' }
  if (partialBytes > 0) headers.Range = `bytes=${partialBytes}-`
  const response = await requestUrl(options.url, { headers, timeoutMs })
  if (response.status === 429 || response.status >= 500) {
    response.body.destroy()
    const failure = new Error(`status ${response.status} fetching ${options.url}`) as Error & { status?: number }
    failure.status = response.status
    throw failure
  }
  if (response.status !== 200 && response.status !== 206) {
    response.body.destroy()
    throw new Error(`status ${response.status} fetching ${options.url}`)
  }
  const resumed = response.status === 206
  if (!resumed && partialBytes > 0) partialBytes = 0 // server ignored the range: restart clean
  const contentLength = Number(header(response.headers, 'content-length') ?? Number.NaN)
  const totalHint = Number.isFinite(contentLength) ? partialBytes + contentLength : options.expectedSizeBytes
  const etag = header(response.headers, 'x-linked-etag')?.replace(/^"|"$/g, '') ?? header(response.headers, 'etag')?.replace(/^"|"$/g, '')
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const output = createWriteStream(partPath, { flags: resumed ? 'a' : 'w' })
    let received = partialBytes
    let lastReport = 0
    response.body.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received - lastReport >= 4_000_000 || totalHint !== undefined && received >= totalHint) {
        lastReport = received
        options.onProgress?.(received, totalHint)
      }
    })
    pipeline(response.body, output).then(resolveWrite, rejectWrite)
  })
  const stat = await lstat(partPath)
  if (Number.isFinite(contentLength) && stat.size !== partialBytes + contentLength) {
    throw new Error(`incomplete download: ${stat.size} of ${partialBytes + contentLength} bytes for ${options.url}`)
  }
  const verified = await verifyFile(partPath, options.expectedSizeBytes, options.expectedSha256)
  if (!verified.ok) {
    // The bytes on disk do not match the CATALOG pin. Corruption or a moved
    // upstream — either way nothing unverified is ever placed; the partial
    // is deleted so a retry starts clean.
    await rm(partPath, { force: true })
    const detail = [
      options.expectedSizeBytes !== undefined ? `expected ${options.expectedSizeBytes} bytes` : '',
      options.expectedSha256 !== undefined ? `expected sha256 ${options.expectedSha256.slice(0, 16)}…` : '',
    ].filter(Boolean).join(', ')
    throw new Error(`verification failed (${detail || 'file unreadable'}) for ${options.url} — the partial file was discarded`)
  }
  await rename(partPath, options.destPath)
  return { sizeBytes: verified.result.sizeBytes, sha256: verified.result.sha256, ...(etag ? { upstreamEtag: etag } : {}), resumedBytes: partialBytes }
}

// ---------------------------------------------------------------------------
// Tar extraction (ustar/pax/gnu-longname, gzip) — zero dependencies
// ---------------------------------------------------------------------------

type TarEntry = { name: string; type: string; size: number; linkname: string }

function parseTarHeader(block: Buffer): TarEntry | null {
  if (block.length < 512 || block.every((byte) => byte === 0)) return null
  const readString = (start: number, length: number) => block.toString('utf8', start, start + length).replace(/\0.*$/s, '')
  const readOctal = (start: number, length: number) => {
    const text = readString(start, length).trim()
    return text ? parseInt(text, 8) || 0 : 0
  }
  const name = readString(0, 100)
  const size = readOctal(124, 12)
  const type = String.fromCharCode(block[156] || 0x30)
  const linkname = readString(157, 100)
  const prefix = readString(345, 155)
  return { name: prefix ? `${prefix}/${name}` : name, type, size, linkname }
}

/** Extracts a .tar.gz archive under destDir, stripping the first path
 *  segment (the `<repo>-<ref>/` root codeload adds). Path-safety: no
 *  absolute names, no `..`, symlinks must stay inside the tree; anything
 *  else is skipped and reported. Returns the list of extracted relative
 *  paths + skipped names. */
export async function extractTarGz(archivePath: string, destDir: string, onProgress?: (files: number) => void): Promise<{ files: string[]; skipped: string[] }> {
  await mkdir(destDir, { recursive: true })
  const files: string[] = []
  const skipped: string[] = []
  const stream = createReadStream(archivePath).pipe(createGunzip())
  let buffer = Buffer.alloc(0)
  let pending: { header: TarEntry; take: number; kind: 'file' | 'longname' | 'pax' } | null = null
  let pendingLongName: string | null = null
  let pendingPaxPath: string | null = null
  let seen = 0

  const safeJoin = (root: string, relative: string): string | null => {
    const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) return null
    return join(root, normalized)
  }

  const extractEntry = async (entry: TarEntry, data: Buffer): Promise<void> => {
    seen += 1
    if (seen % 64 === 0) onProgress?.(seen)
    const target = safeJoin(destDir, entry.name)
    if (!target) {
      skipped.push(entry.name)
      return
    }
    try {
      if (entry.type === '5') {
        await mkdir(target, { recursive: true })
        return
      }
      if (entry.type === '2') { // symlink: only fully-inside targets
        if (!safeJoin(destDir, entry.linkname)) {
          skipped.push(entry.name)
          return
        }
        await mkdir(resolve(target, '..'), { recursive: true })
        await symlink(entry.linkname, target).catch(() => undefined)
        return
      }
      if (entry.type === '1') { // hardlink: copy the already-extracted target
        const sourceFile = safeJoin(destDir, entry.linkname)
        if (!sourceFile) {
          skipped.push(entry.name)
          return
        }
        await mkdir(resolve(target, '..'), { recursive: true })
        await copyFile(sourceFile, target)
        files.push(entry.name)
        return
      }
      if (entry.type === '0' || entry.type === '\0' || entry.type === '7') {
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(target, data)
        files.push(entry.name)
        return
      }
      skipped.push(entry.name) // char/block/fifo: never part of a source tree we need
    } catch (failure) {
      skipped.push(`${entry.name} (${failure instanceof Error ? failure.message : String(failure)})`)
    }
  }

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk as Buffer])
    let more = true
    while (more) {
      if (pending) {
        if (buffer.length < pending.take) break
        const data = buffer.subarray(0, pending.header.size)
        buffer = buffer.subarray(pending.take)
        const current = pending
        pending = null
        if (current.kind === 'longname') {
          pendingLongName = data.toString('utf8').replace(/\0.*$/s, '')
        } else if (current.kind === 'pax') {
          const pathMatch = /(?:^|\n)\d+ path=([^\n]+)/.exec(data.toString('utf8'))
          if (pathMatch?.[1]) pendingPaxPath = pathMatch[1]
        } else {
          await extractEntry(current.header, data)
        }
        continue
      }
      if (buffer.length < 512) break
      const header = parseTarHeader(buffer.subarray(0, 512))
      buffer = buffer.subarray(512)
      if (!header) continue // all-zero padding block
      if (header.type === 'L' || header.type === 'x' || header.type === 'g') {
        pending = { header, take: Math.ceil(header.size / 512) * 512, kind: header.type === 'L' ? 'longname' : 'pax' }
        continue
      }
      let name = header.name
      if (pendingLongName !== null) { name = pendingLongName; pendingLongName = null }
      if (pendingPaxPath !== null) { name = pendingPaxPath; pendingPaxPath = null }
      const stripped = name.split('/').slice(1).join('/') // drop <repo>-<ref>/
      if (!stripped) continue
      const entry: TarEntry = { ...header, name: stripped }
      if (header.size > 0 && (header.type === '0' || header.type === '\0' || header.type === '7')) {
        pending = { header: entry, take: Math.ceil(header.size / 512) * 512, kind: 'file' }
        continue
      }
      await extractEntry(entry, Buffer.alloc(0))
      more = buffer.length >= 512 || pending !== null
    }
  }

  return { files, skipped }
}

// ---------------------------------------------------------------------------
// Install records
// ---------------------------------------------------------------------------

export type FetchFileRecord = { path: string; sizeBytes: number; sha256: string; upstreamEtag?: string }
export type FetchInstallRecord = {
  at: number
  revision: string
  pinKind: FetchPin['kind']
  sourceLabel: string
  files: FetchFileRecord[]
  placed: Array<{ path: string; kind: 'symlink' | 'junction' | 'hardlink' | 'tree' }>
  licenseSpdx: string
  licenseAcknowledged: boolean
  verified: 'sha256' | 'size' | 'none'
}
export type FetchStateFile = { version: 1; installs: Record<string, FetchInstallRecord>; failures: Record<string, string> }

const EMPTY_STATE: FetchStateFile = { version: 1, installs: {}, failures: {} }

// ---------------------------------------------------------------------------
// FetchManager
// ---------------------------------------------------------------------------

export type FetchManagerOptions = {
  homeDirectory: string
  loadSettings: () => Promise<AppSettings>
  logEvent: (event: { kind: string } & Record<string, unknown>) => void
  logFailure: (stage: string, error: unknown, context?: Record<string, string | number | boolean>, level?: 'fatal' | 'error' | 'warn' | 'debug') => void
  onProgress?: (progress: FetchProgress) => void
  transport?: FetchTransport
}

export class FetchManager {
  private readonly cacheRoot: string
  private readonly stateDir: string
  private readonly stateFilePath: string
  private readonly inFlight = new Map<string, FetchProgress>()
  private state: FetchStateFile | null = null
  private stateWrite: Promise<void> = Promise.resolve()

  constructor(private readonly options: FetchManagerOptions) {
    this.cacheRoot = join(options.homeDirectory, 'fetches')
    this.stateDir = join(options.homeDirectory, 'fetcher')
    this.stateFilePath = join(this.stateDir, 'fetch-state.json')
  }

  private get transport(): FetchTransport {
    return this.options.transport ?? defaultTransport()
  }

  private cacheDir(entryId: string): string {
    return join(this.cacheRoot, entryId.replace(/[^a-z0-9._-]+/gi, '_'))
  }

  private async readState(): Promise<FetchStateFile> {
    if (this.state) return this.state
    try {
      const raw = JSON.parse(await readFile(this.stateFilePath, 'utf8')) as FetchStateFile
      if (raw && raw.version === 1 && raw.installs && typeof raw.installs === 'object') {
        this.state = { version: 1, installs: raw.installs, failures: raw.failures && typeof raw.failures === 'object' ? raw.failures : {} }
        return this.state
      }
    } catch { /* absent or corrupt: no recorded installs */ }
    this.state = { ...EMPTY_STATE, installs: {}, failures: {} }
    return this.state
  }

  /** Serialized tmp+rename state writes. The mutator runs INSIDE the chain
   *  against the freshest in-memory state — two fetches finishing at the
   *  same moment can never lose each other's records (read-modify-write is
   *  atomic across all callers). */
  private async updateState(mutate: (state: FetchStateFile) => FetchStateFile): Promise<void> {
    this.stateWrite = this.stateWrite
      .then(async () => {
        const current = await this.readState()
        const next = mutate(current)
        this.state = next
        await mkdir(this.stateDir, { recursive: true })
        const staged = `${this.stateFilePath}.tmp`
        await writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        await rename(staged, this.stateFilePath)
      })
      .catch((error: unknown) => {
        this.options.logFailure('fetcher/state-write', error, undefined, 'warn')
      })
    await this.stateWrite
  }

  private emit(progress: Omit<FetchProgress, 'at'>): void {
    const stamped = { ...progress, at: Date.now() }
    if (stamped.phase === 'downloading' || stamped.phase === 'resolving' || stamped.phase === 'verifying' || stamped.phase === 'placing') this.inFlight.set(stamped.id, stamped)
    else this.inFlight.delete(stamped.id)
    this.options.onProgress?.(stamped)
  }

  // ---- status --------------------------------------------------------------

  /** Catalog + live machine state. NO network — presence is detected from
   *  install records, exact destination paths, detectGlob scans and the
   *  fetch cache. */
  async catalogStatus(checkoutOverride?: string | null): Promise<FetchEntryStatus[]> {
    const settings = await this.options.loadSettings()
    const checkout = checkoutOverride !== undefined ? checkoutOverride : (isUsableCheckout(settings.engine.checkoutPath) ? settings.engine.checkoutPath : null)
    const state = await this.readState()
    return Promise.all(FETCH_CATALOG.map(async (entry) => this.statusFor(entry, settings, checkout, state)))
  }

  private async statusFor(entry: FetchCatalogEntry, settings: AppSettings, checkout: string | null, state: FetchStateFile): Promise<FetchEntryStatus> {
    const flight = this.inFlight.get(entry.id)
    const base: FetchEntryStatus = { ...entry, state: 'absent', ...(flight ? { inFlight: true } : {}) }
    const record = state.installs[entry.id]
    if (record) {
      // existsSync follows links: a placement the user removed (or a link
      // whose cache bytes vanished) is honestly reported as not placed.
      const linksLive = record.placed.length > 0 && record.placed.every((placement) => existsSync(placement.path))
      if (linksLive) {
        return { ...base, state: 'placed', installedRevision: record.revision, placedPaths: record.placed.map((placement) => placement.path), verified: record.verified }
      }
      const cached = await this.cacheComplete(entry)
      return { ...base, state: cached ? 'cached' : 'absent', installedRevision: record.revision, verified: record.verified, note: 'previously placed files are gone from their destination — refetch re-links the cached bytes.' }
    }
    if (entry.destination.kind === 'node-pack') {
      const pack = findNodePack(entry.destination.packId)
      if (!pack) return { ...base, note: 'unknown node-pack registry entry' }
      if (!checkout) return { ...base, note: 'a valid ComfyUI checkout is required first (managed engine settings).' }
      const revision = await nodePackInstalledRevision(pack, checkout)
      if (revision) return { ...base, state: 'present', installedRevision: revision }
      return base
    }
    if (entry.destination.kind === 'engine-checkout') {
      if (isUsableCheckout(settings.engine.checkoutPath)) return { ...base, state: 'present', note: `the nominated checkout (${settings.engine.checkoutPath}) satisfies this entry.` }
      return base
    }
    if (entry.destination.kind === 'model-root' && entry.files) {
      const destination = entry.destination
      const every = (await Promise.all(entry.files.map(async (file) => existsSync(modelRootTargetPath(destination, settings, file.path))))).every(Boolean)
      if (every) return { ...base, state: 'present' }
      if (entry.detectGlob) {
        const detected = await scanForGlob(fetchModelRootPath(destination.root, settings), destination.subpath, entry.detectGlob)
        if (detected) return { ...base, state: 'present', note: `detected an existing local file: ${detected}.` }
      }
    }
    if (entry.destination.kind === 'pack-ckpt' && entry.files && checkout) {
      const destination = entry.destination
      const every = (await Promise.all(entry.files.map((file) => existsSync(join(checkout, 'custom_nodes', destination.packDirectory, destination.relativePath, file.path.slice(file.path.replace(/\\/g, '/').lastIndexOf('/') + 1)))))).every(Boolean)
      if (every) return { ...base, state: 'present' }
    }
    if (await this.cacheComplete(entry)) return { ...base, state: 'cached' }
    const failure = state.failures[entry.id]
    if (failure) return { ...base, note: `last fetch failed: ${failure}` }
    return base
  }

  private async cacheComplete(entry: FetchCatalogEntry): Promise<boolean> {
    if (!entry.files) return false
    const results = await Promise.all(entry.files.map(async (file) => {
      const cached = join(this.cacheDir(entry.id), 'files', file.path)
      const stat = await lstat(cached).catch(() => null)
      return stat?.isFile() && (file.sizeBytes === undefined || stat.size === file.sizeBytes)
    }))
    return results.every(Boolean)
  }

  // ---- consent -------------------------------------------------------------

  /** The gate. Consent must exist, be true, and have been recorded for the
   *  SAME license the catalog now carries — a license change requires a
   *  fresh acknowledgement. */
  consentState(entry: FetchCatalogEntry, settings: AppSettings): { ok: true } | { ok: false; reason: string } {
    const record = settings.fetch?.consents?.[entry.id]
    if (!record || record.consented !== true) return { ok: false, reason: `No consent recorded for "${entry.name}" — the studio never fetches from the network without one. Open the item's fetch dialog and acknowledge the license first.` }
    if (record.licenseSpdx !== entry.licenseSpdx) return { ok: false, reason: `The recorded consent acknowledges "${record.licenseSpdx}" but "${entry.name}" now carries "${entry.licenseSpdx}" — the license changed, so a fresh acknowledgement is required.` }
    return { ok: true }
  }

  // ---- fetch ----------------------------------------------------------------

  async start(entryId: string, startOptions: { destinationDir?: string } = {}): Promise<{ started: boolean; id: string; reason?: string }> {
    const entry = findFetchEntry(entryId)
    if (!entry) return { started: false, id: entryId, reason: 'Unknown fetchable item id.' }
    if (this.inFlight.has(entry.id)) return { started: false, id: entry.id, reason: 'A fetch for this item is already running.' }
    const settings = await this.options.loadSettings()
    const consent = this.consentState(entry, settings)
    if (!consent.ok) return { started: false, id: entry.id, reason: consent.reason }
    const checkout = isUsableCheckout(settings.engine.checkoutPath) ? settings.engine.checkoutPath : null
    if ((entry.destination.kind === 'node-pack' || entry.destination.kind === 'pack-ckpt') && !checkout) {
      return { started: false, id: entry.id, reason: 'A valid ComfyUI checkout (with main.py) must be configured in the managed engine settings first.' }
    }
    if (entry.destination.kind === 'model-root') {
      const root = fetchModelRootPath(entry.destination.root, settings)
      if (!isAbsolute(root)) return { started: false, id: entry.id, reason: `The ${entry.destination.root} model root does not resolve to an absolute path.` }
    }
    if (entry.destination.kind === 'engine-checkout') {
      const destination = resolve(startOptions.destinationDir?.trim() || this.defaultEngineCheckoutDir(entry))
      if (existsSync(destination) && (await readdir(destination)).length > 0) {
        return { started: false, id: entry.id, reason: `The engine checkout destination is not empty: ${destination}. The studio never overwrites an existing checkout — pick another directory or clear it first.` }
      }
    }
    // Fire-and-forget: progress rides the event fabric; the route returns
    // immediately so a multi-GB download never holds a request open.
    void this.runFetch(entry, settings, checkout ?? null, startOptions).catch((error: unknown) => {
      this.options.logFailure('fetcher/run', error, { entry: entry.id }, 'error')
    })
    return { started: true, id: entry.id }
  }

  private defaultEngineCheckoutDir(entry: FetchCatalogEntry): string {
    const label = entry.source.kind === 'git' ? `${entry.source.url.replace(/.*\//, '')}-${entry.source.revision.value}` : entry.id
    return join(this.cacheRoot, 'engine', label.replace(/[^a-z0-9._-]+/gi, '_'))
  }

  private async runFetch(entry: FetchCatalogEntry, settings: AppSettings, checkout: string | null, startOptions: { destinationDir?: string }): Promise<void> {
    const totalBytes = entry.files?.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0)
    try {
      // FIRST-PARTY packs (task k271ykk, localInstall entries): the payload
      // ships inside this repo (custom-nodes/) — install straight from it.
      // The transport is never touched (resolveRevision included); consent
      // was still required by start(), because the doctrine — every catalog
      // fetch is consent-gated — holds for local installs too.
      if (entry.localInstall) {
        this.emit({ id: entry.id, phase: 'placing', message: 'installing the studio\'s own payload (no network)' })
        const pack = entry.destination.kind === 'node-pack' ? findNodePack(entry.destination.packId) : null
        if (!pack || !checkout) throw new Error('the node-pack registry entry or the configured checkout disappeared mid-install')
        const installed = await installNodePack(pack, { checkout })
        if (!installed.installed && !installed.alreadyInstalled) throw new Error(`the pack install refused: ${installed.notes.join(' ')}`)
        const record: FetchInstallRecord = {
          at: Date.now(),
          revision: pack.pinnedRevision,
          pinKind: entry.source.revision.kind,
          sourceLabel: `first-party payload (custom-nodes)@${pack.pinnedRevision}`,
          files: [],
          placed: [{ path: join(resolve(checkout), 'custom_nodes', pack.name), kind: 'tree' }],
          licenseSpdx: entry.licenseSpdx,
          licenseAcknowledged: true,
          verified: 'none',
        }
        await this.updateState((state) => {
          const failures = { ...state.failures }
          delete failures[entry.id]
          return { version: 1, installs: { ...state.installs, [entry.id]: record }, failures }
        })
        this.emit({ id: entry.id, phase: 'done', message: `${entry.name} installed from the studio's own payload` })
        this.options.logEvent({ kind: 'fetcher.installed', entry: entry.id, revision: record.revision, verified: 'none', files: 0 })
        return
      }
      this.emit({ id: entry.id, phase: 'resolving', message: `resolving ${labelForSource(entry)}` })
      const revision = await this.resolveRevision(entry)
      const record: FetchInstallRecord = {
        at: Date.now(),
        revision,
        pinKind: entry.source.revision.kind,
        sourceLabel: `${entry.source.kind === 'hf' ? `hf:${entry.source.repo}` : `git:${entry.source.url}`}@${revision}`,
        files: [],
        placed: [],
        licenseSpdx: entry.licenseSpdx,
        licenseAcknowledged: true,
        verified: 'none',
      }
      if (entry.source.kind === 'hf' && entry.files) {
        // Verification level is the WEAKEST link: sha256 only when every
        // file carries one, size when every file carries a size.
        const allSha = entry.files.every((file) => typeof file.sha256 === 'string')
        const allSize = entry.files.every((file) => typeof file.sizeBytes === 'number')
        let done = 0
        for (const file of entry.files) {
          // Dataset repos live under /datasets/<repo>; model repos at the
          // bare path. SHA pins (the catalog's default for weights) resolve
          // locally, so only the download URL needs the distinction.
          const url = `https://huggingface.co/${entry.source.dataset ? 'datasets/' : ''}${entry.source.repo}/resolve/${revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`
          const cached = join(this.cacheDir(entry.id), 'files', file.path)
          this.emit({ id: entry.id, phase: 'downloading', file: file.path, bytes: done, totalBytes })
          const result = await this.transport.download({ url, destPath: cached, expectedSizeBytes: file.sizeBytes, expectedSha256: file.sha256, onProgress: (bytes) => this.emit({ id: entry.id, phase: 'downloading', file: file.path, bytes: done + bytes, totalBytes }) })
          done += result.sizeBytes
          record.files.push({ path: file.path, sizeBytes: result.sizeBytes, sha256: result.sha256, ...(result.upstreamEtag ? { upstreamEtag: result.upstreamEtag } : {}) })
        }
        record.verified = allSha ? 'sha256' : allSize ? 'size' : 'none'
        this.emit({ id: entry.id, phase: 'placing', message: entry.destination.kind === 'pack-ckpt' ? 'linking into the pack ckpt tree' : 'linking into the model root' })
        await this.placeHfEntry(entry, settings, checkout, record)
      } else if (entry.source.kind === 'git') {
        const archivePath = join(this.cacheDir(entry.id), 'archive.tar.gz')
        this.emit({ id: entry.id, phase: 'downloading', file: 'repository archive', totalBytes: entry.sizeBytes })
        const result = await this.transport.download({ url: `${codeloadUrl(entry.source.url)}/tar.gz/${revision}`, destPath: archivePath })
        record.files.push({ path: 'archive.tar.gz', sizeBytes: result.sizeBytes, sha256: result.sha256, ...(result.upstreamEtag ? { upstreamEtag: result.upstreamEtag } : {}) })
        // Git archives carry no catalog sha/size pin — the recorded sha is
        // informational (post-hoc), so the verification level is 'none'.
        record.verified = 'none'
        this.emit({ id: entry.id, phase: 'placing', message: 'extracting the repository archive' })
        if (entry.destination.kind === 'node-pack') {
          const pack = findNodePack(entry.destination.packId)
          if (!pack || !checkout) throw new Error('the node-pack registry entry or the configured checkout disappeared mid-fetch')
          const treeDir = join(this.cacheDir(entry.id), 'tree')
          await rm(treeDir, { recursive: true, force: true }).catch(() => undefined)
          await extractTarGz(archivePath, treeDir)
          const installed = await installNodePack(pack, { checkout, sourceDirectory: treeDir, resolvedRevision: revision })
          if (!installed.installed && !installed.alreadyInstalled) throw new Error(`the pack install refused: ${installed.notes.join(' ')}`)
          record.placed.push({ path: join(checkout, 'custom_nodes', pack.name), kind: 'tree' })
        } else if (entry.destination.kind === 'engine-checkout') {
          const destination = resolve(startOptions.destinationDir?.trim() || this.defaultEngineCheckoutDir(entry))
          await mkdir(destination, { recursive: true })
          const extracted = await extractTarGz(archivePath, destination)
          if (!extracted.files.some((file) => file === 'main.py' || file.endsWith('/main.py'))) {
            throw new Error(`the extracted archive does not look like a ComfyUI checkout (no main.py) — left at ${destination} for inspection`)
          }
          record.placed.push({ path: destination, kind: 'tree' })
        } else {
          throw new Error(`git sources cannot place into a ${entry.destination.kind} destination`)
        }
      } else {
        throw new Error(`unsupported source for destination combination: ${entry.source.kind} → ${entry.destination.kind}`)
      }
      await this.updateState((state) => {
        const failures = { ...state.failures }
        delete failures[entry.id]
        return { version: 1, installs: { ...state.installs, [entry.id]: record }, failures }
      })
      this.emit({ id: entry.id, phase: 'done', message: `${entry.name} ready (${record.verified === 'sha256' ? 'sha256-verified' : record.verified === 'size' ? 'size-verified' : 'unverified'})` })
      this.options.logEvent({ kind: 'fetcher.installed', entry: entry.id, revision, verified: record.verified, files: record.files.length })
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      await this.updateState((state) => ({ version: 1, installs: state.installs, failures: { ...state.failures, [entry.id]: reason } }))
      this.emit({ id: entry.id, phase: 'failed', message: reason })
      this.options.logFailure('fetcher/fetch', failure, { entry: entry.id }, 'warn')
    }
  }

  private async resolveRevision(entry: FetchCatalogEntry): Promise<string> {
    const pin = entry.source.revision
    if (pin.kind === 'sha') return pin.value
    // Branch and tag pins are MOVING (or at least indirect): resolve to the
    // immutable SHA now and stamp it everywhere the install is recorded.
    if (entry.source.kind === 'hf') return this.transport.resolveHfRevision(entry.source.repo, pin.value)
    return this.transport.resolveGitHead(entry.source.url, pin.value)
  }

  /** Weights LINK into their destination (never copied): a model root, or
   *  the installed preprocessor pack's own ckpts/ tree (the exact path the
   *  pack would have auto-downloaded into, so its first offline use finds
   *  them). A foreign file at the destination fails the fetch rather than
   *  overwriting anything. */
  private async placeHfEntry(entry: FetchCatalogEntry, settings: AppSettings, checkout: string | null, record: FetchInstallRecord): Promise<void> {
    if (!entry.files) throw new Error('placement requires files')
    if (entry.destination.kind === 'model-root') {
      const destination = entry.destination
      const root = fetchModelRootPath(destination.root, settings)
      await mkdir(root, { recursive: true })
      for (const file of entry.files) {
        const cached = join(this.cacheDir(entry.id), 'files', file.path)
        const linkPath = modelRootTargetPath(destination, settings, file.path)
        await mkdir(resolve(linkPath, '..'), { recursive: true })
        const linked = await linkNeverCopy(cached, linkPath)
        if (!linked.ok) throw new Error(`weight ${file.path} could not be linked into ${destination.root} (${linked.reason}) — refusing to place the rest`)
        record.placed.push({ path: linkPath, kind: linked.kind })
      }
      return
    }
    if (entry.destination.kind === 'pack-ckpt') {
      const destination = entry.destination
      if (!checkout) throw new Error('a configured ComfyUI checkout is required to place preprocessor weights')
      const packRoot = join(resolve(checkout), 'custom_nodes', destination.packDirectory)
      if (!existsSync(packRoot)) throw new Error(`custom_nodes/${destination.packDirectory} is not installed — install that pack first (the studio never creates files inside a pack it did not place)`)
      for (const file of entry.files) {
        const cached = join(this.cacheDir(entry.id), 'files', file.path)
        const basename = file.path.slice(file.path.replace(/\\/g, '/').lastIndexOf('/') + 1)
        const linkPath = join(packRoot, destination.relativePath, basename)
        await mkdir(resolve(linkPath, '..'), { recursive: true })
        const linked = await linkNeverCopy(cached, linkPath)
        if (!linked.ok) throw new Error(`weight ${file.path} could not be linked into custom_nodes/${destination.packDirectory} (${linked.reason}) — refusing to place the rest`)
        record.placed.push({ path: linkPath, kind: linked.kind })
      }
      return
    }
    throw new Error(`hf sources cannot place into a ${entry.destination.kind} destination`)
  }

  // ---- remove ---------------------------------------------------------------

  /** Removes the studio's placements (links and fetched trees) and the
   *  install record. The fetch CACHE is kept — re-placing then re-links
   *  without the network. Files the user owns are never touched: a
   *  destination path that is no longer our link is skipped and reported. */
  async remove(entryId: string): Promise<{ removed: boolean; reason?: string; notes: string[] }> {
    const entry = findFetchEntry(entryId)
    if (!entry) return { removed: false, reason: 'Unknown fetchable item id.', notes: [] }
    if (this.inFlight.has(entry.id)) return { removed: false, reason: 'A fetch for this item is running — wait for it to finish.', notes: [] }
    const state = await this.readState()
    const record = state.installs[entry.id]
    const notes: string[] = []
    if (!record) {
      if (entry.destination.kind === 'node-pack') {
        const settings = await this.options.loadSettings()
        const pack = findNodePack(entry.destination.packId)
        if (pack && isUsableCheckout(settings.engine.checkoutPath)) {
          const removed = await uninstallNodePack(pack, settings.engine.checkoutPath)
          return removed.removed ? { removed: true, notes: [`deleted custom_nodes/${pack.name}`] } : { removed: false, reason: removed.reason, notes: [] }
        }
      }
      return { removed: false, reason: 'This item has no studio fetch record.', notes: [] }
    }
    for (const placement of record.placed) {
      if (placement.kind === 'tree') {
        await rm(placement.path, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      const stat = await lstat(placement.path).catch(() => null)
      if (!stat) continue
      if (stat.isSymbolicLink()) {
        const pointsIntoCache = (await readlink(placement.path).catch(() => '')).includes(this.cacheRoot)
        if (pointsIntoCache || placement.kind === 'junction' || placement.kind === 'hardlink') {
          await rm(placement.path, { force: true }).catch(() => undefined)
          continue
        }
        notes.push(`kept ${placement.path} — it no longer points at the studio's fetch cache`)
        continue
      }
      notes.push(`kept ${placement.path} — it is a real file now (not the studio's link)`)
    }
    await this.updateState((current) => {
      const installs = { ...current.installs }
      delete installs[entry.id]
      return { version: 1, installs, failures: current.failures }
    })
    this.options.logEvent({ kind: 'fetcher.removed', entry: entry.id })
    return { removed: true, notes }
  }
}

function labelForSource(entry: FetchCatalogEntry): string {
  return entry.source.kind === 'hf' ? `${entry.source.repo}@${entry.source.revision.value}` : `${entry.source.url}@${entry.source.revision.value}`
}

function codeloadUrl(repoUrl: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/.exec(repoUrl.trim())
  if (!match) throw new Error(`only github.com repositories are fetchable (got ${repoUrl})`)
  return `https://codeload.github.com/${match[1]}/${match[2]}`
}

/** One-level glob scan for presence detection (root top level + the
 *  subpath directory when the entry declares one). */
async function scanForGlob(root: string, subpath: string | undefined, glob: string): Promise<string | null> {
  const pattern = globToRegExp(glob)
  const directories = [subpath ? join(root, subpath) : root, root]
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const candidate of entries) {
      if (candidate.isFile() && pattern.test(candidate.name)) return candidate.name
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Transport selection (production vs test-mock)
// ---------------------------------------------------------------------------

let sharedTransport: FetchTransport | null = null

function defaultTransport(): FetchTransport {
  if (!sharedTransport) sharedTransport = createHttpFetchTransport()
  return sharedTransport
}

/** A filesystem-backed transport for tests and offline development: HF
 *  files are served from <root>/hf/<repo>/<path> (a sibling `<path>.sha256`
 *  file may carry the expected digest), revisions from
 *  <root>/revision/<repo>/<ref>, git heads from <root>/githead/<ref> and
 *  archives from <root>/archive/<owner>_<repo>_<ref>.tar.gz. Zero network. */
export function createFilesystemTransport(root: string): FetchTransport {
  const absoluteRoot = resolve(root)
  const readShaSidecar = async (path: string): Promise<string | undefined> => {
    try {
      return (await readFile(`${path}.sha256`, 'utf8')).trim().toLowerCase()
    } catch {
      return undefined
    }
  }
  return {
    async resolveHfRevision(repo, ref) {
      try {
        const sha = (await readFile(join(absoluteRoot, 'revision', repo, ref), 'utf8')).trim()
        if (/^[0-9a-f]{40}$/i.test(sha)) return sha
      } catch { /* fall through */ }
      // Deterministic fallback so tests that never stub the resolver still
      // get a SHA-shaped stamp (the STAMPING is what is under test).
      return `f${Buffer.from(`${repo}@${ref}`).toString('hex').padEnd(39, '0').slice(0, 39)}`
    },
    async resolveGitHead(repoUrl, ref) {
      const label = repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\//g, '_')
      try {
        const sha = (await readFile(join(absoluteRoot, 'githead', label, ref), 'utf8')).trim()
        if (/^[0-9a-f]{40}$/i.test(sha)) return sha
      } catch { /* fall through */ }
      return `e${Buffer.from(`${label}@${ref}`).toString('hex').padEnd(39, '0').slice(0, 39)}`
    },
    async download(options) {
      if (existsSync(options.destPath)) {
        const cached = await verifyFile(options.destPath, options.expectedSizeBytes, options.expectedSha256)
        if (cached.ok) return { ...cached.result, resumedBytes: 0 }
        await rm(options.destPath, { force: true })
      }
      const parsed = new URL(options.url)
      let sourcePath: string
      if (parsed.hostname === 'huggingface.co') {
        // Model URLs: /<owner>/<repo>/resolve/<rev>/<path> → hf/<owner>/<path>
        // (the historical layout). Dataset URLs carry a leading /datasets/
        // segment and map under hf/datasets/<owner>/ so the two cannot
        // collide in the mock root.
        const segments = parsed.pathname.split('/')
        const isDataset = segments[1] === 'datasets'
        const owner = isDataset ? segments[2] : segments[1]
        const rest = segments.slice(isDataset ? 6 : 5)
        sourcePath = join(absoluteRoot, 'hf', ...(isDataset ? ['datasets'] : []), owner ?? 'unknown', rest.join('/'))
      } else {
        const codeload = parsed.pathname.replace(/^\/|\/$/g, '') // owner/repo/tar.gz/ref
        const [owner, repository, , ref] = codeload.split('/')
        sourcePath = join(absoluteRoot, 'archive', `${owner}_${repository}_${ref}.tar.gz`)
      }
      const bytes = await readFile(sourcePath)
      await mkdir(resolve(options.destPath, '..'), { recursive: true })
      await writeFile(options.destPath, bytes)
      const sha256 = await sha256File(options.destPath)
      if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256.toLowerCase()) {
        await rm(options.destPath, { force: true })
        throw new Error(`verification failed (expected sha256 ${options.expectedSha256.slice(0, 16)}…) for ${options.url} — the partial file was discarded`)
      }
      if (options.expectedSizeBytes !== undefined && bytes.length !== options.expectedSizeBytes) {
        await rm(options.destPath, { force: true })
        throw new Error(`verification failed (expected ${options.expectedSizeBytes} bytes, got ${bytes.length}) for ${options.url} — the partial file was discarded`)
      }
      const sidecar = await readShaSidecar(sourcePath)
      return { sizeBytes: bytes.length, sha256, ...(sidecar ? { upstreamEtag: sidecar } : {}), resumedBytes: 0 }
    },
  }
}

/** The transport the server uses: the filesystem mock when
 *  MINIMAX_STUDIO_FETCH_MOCK_ROOT is set (tests + offline dev), the HTTPS
 *  production transport otherwise. */
export function transportForEnvironment(): FetchTransport {
  const mockRoot = process.env.MINIMAX_STUDIO_FETCH_MOCK_ROOT?.trim()
  if (mockRoot && existsSync(mockRoot)) return createFilesystemTransport(mockRoot)
  return createHttpFetchTransport()
}
