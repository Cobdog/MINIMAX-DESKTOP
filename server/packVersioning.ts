/**
 * Node-pack version detection (task mjhlt3k — the status board's version
 * half). Everything here READS state the pack folder already carries; nothing
 * mutates, nothing fetches, and no claim is invented when a rung cannot
 * answer.
 *
 * THE LADDER (first rung that answers wins; documented limits per AC-5):
 *
 *  1. .studio-node.json   the studio's own install marker — records the
 *                         revision the studio placed (a sha pin, or the
 *                         fetcher-stamped HEAD of a branch pin). Exact for
 *                         studio-managed installs; nothing else can be
 *                         trusted for attribution.
 *  2. .git/               a git checkout. ComfyUI-Manager's git-mode installs
 *                         leave exactly this state — and so does a manual
 *                         `git clone`, which is INDISTINGUISHABLE from it
 *                         (the honest limit: both are attributed "instance-
 *                         side, not studio-managed"; the studio never touches
 *                         either). Version = the checked-out commit, read
 *                         from .git/HEAD → .git/refs/<ref>, falling back to
 *                         .git/packed-refs; a worktree-style `.git` FILE
 *                         (gitdir: pointer) is followed. The origin URL from
 *                         .git/config rides along for identity.
 *  3. pyproject.toml with a [tool.comfy] section — a Comfy Registry (CNR)
 *                         install: ComfyUI-Manager's registry mode places the
 *                         published package, whose pyproject carries
 *                         [tool.comfy] + [project] version (docs.comfy.org
 *                         publishing spec, verified 2026-09-19). Managed by
 *                         ComfyUI; version is the registry semver.
 *  4. pyproject.toml with a bare [project] version — a version string is
 *                         discoverable, but nothing attributes the folder;
 *                         reported as present with a version and UNKNOWN
 *                         management.
 *  5. nothing readable    version unknown — presence itself is still honest
 *                         (folder exists / node classes live on the instance).
 *
 * ORDERING against the studio's pin (ahead/behind, AC-3/AC-4):
 *  - sha vs sha: `git merge-base --is-ancestor` run against the folder's OWN
 *    history — the only local ground truth. Both commits present → ahead or
 *    behind, exactly. The pinned commit absent from the folder's history →
 *    "differs" with the direction explicitly NOT claimed. git unavailable or
 *    the folder not a checkout → differs/unknown, never a guess.
 *  - semver vs a tag pin: numeric compare (v-prefix tolerated).
 *  - branch pin vs a detected sha/semver: a branch label is moving — no
 *    local relation exists; unknown.
 *  - mixed shapes (sha vs semver): unknown.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { NodePackDefinition } from '../src/types'

/** What the folder itself says about one installed pack. */
export type PackFolderVersion =
  | { kind: 'git-checkout'; revision: string; remoteUrl?: string }
  | { kind: 'comfyui-registry'; version: string }
  | { kind: 'pyproject'; version: string }

/** How the discovered version relates to the registry pin. */
export type VersionRelation = 'at-pin' | 'ahead-of-pin' | 'behind-pin' | 'differs' | 'unknown'

const SHA_PATTERN = /^[0-9a-f]{40}$/i
const SEMVERISH_PATTERN = /^v?\d+(\.\d+)*(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

/** A 40-hex string is a commit SHA; anything else is a branch/tag name. */
export function isSha(value: string): boolean {
  return SHA_PATTERN.test(value.trim())
}

/** True for tag-shaped pins a semver compare can meaningfully order. */
function isSemverish(value: string): boolean {
  return SEMVERISH_PATTERN.test(value.trim())
}

// ---------------------------------------------------------------------------
// git metadata readers (pure, file reads only)
// ---------------------------------------------------------------------------

/** Resolve a `.git` entry (directory OR worktree-style gitdir-pointer file)
 *  to the directory holding the repository's metadata. */
export function gitMetadataDir(packDir: string): string | null {
  const dotGit = join(packDir, '.git')
  let stat: { isDirectory(): boolean } | null = null
  try {
    stat = statSync(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dotGit
  // A `.git` FILE: `gitdir: <path>` (worktrees/submodules). Relative paths
  // resolve against the pack folder.
  try {
    const raw = readFileSync(dotGit, 'utf8').trim()
    const match = /^gitdir:\s*(\S.*)$/.exec(raw)
    if (!match) return null
    const target = resolve(packDir, match[1].trim())
    return existsSync(target) ? target : null
  } catch {
    return null
  }
}

/** Read the checked-out commit from .git/HEAD — ref files first, then
 *  packed-refs, then a detached raw sha. Null when nothing resolves. */
export function readGitHeadSha(metadataDir: string): string | null {
  let head: string
  try {
    head = readFileSync(join(metadataDir, 'HEAD'), 'utf8').trim()
  } catch {
    return null
  }
  const refMatch = /^ref:\s*(\S+)/.exec(head)
  if (refMatch) {
    const ref = refMatch[1]
    try {
      const direct = readFileSync(join(metadataDir, ref), 'utf8').trim()
      if (SHA_PATTERN.test(direct)) return direct.toLowerCase()
    } catch { /* loose ref absent — try packed-refs */ }
    try {
      const packed = readFileSync(join(metadataDir, 'packed-refs'), 'utf8')
      for (const line of packed.split('\n')) {
        if (line.startsWith('#') || line.startsWith('^')) continue
        const entry = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim())
        if (entry && entry[2] === ref) return entry[1].toLowerCase()
      }
    } catch { /* no packed-refs — unresolved */ }
    return null
  }
  return SHA_PATTERN.test(head) ? head.toLowerCase() : null
}

/** The origin remote URL from .git/config, when present. */
export function readGitRemoteUrl(metadataDir: string): string | undefined {
  try {
    const config = readFileSync(join(metadataDir, 'config'), 'utf8')
    const inOrigin = config.includes('[remote "origin"]')
    if (!inOrigin) return undefined
    const section = config.split('[remote "origin"]')[1]?.split('[')[0] ?? ''
    const match = /^\s*url\s*=\s*(\S+)\s*$/m.exec(section)
    return match ? match[1] : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// pyproject.toml reader (pure; minimal TOML — sections + scalar strings)
// ---------------------------------------------------------------------------

export type PyprojectInfo = { version?: string; hasComfySection: boolean }

/** Extract [project] version + [tool.comfy] presence from a pyproject.toml.
 *  Deliberately line-based: pack pyprojects are author-written and simple,
 *  and a parser that throws on exotic syntax would turn a version source
 *  into an error — degrade to "nothing found" instead. */
export function parsePyproject(text: string): PyprojectInfo {
  const info: PyprojectInfo = { hasComfySection: false }
  let section = ''
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      section = header[1].trim()
      if (section === 'tool.comfy') info.hasComfySection = true
      continue
    }
    if (section !== 'project') continue
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/.exec(line)
    if (pair && pair[1] === 'version' && pair[2]) info.version = pair[2]
  }
  return info
}

// ---------------------------------------------------------------------------
// Folder detection (the ladder's filesystem half)
// ---------------------------------------------------------------------------

/** Detect a foreign pack folder's version state (rungs 2–4). Rung 1 — the
 *  studio marker — is the caller's concern (engineNodes owns the marker). */
export function detectPackFolderVersion(packDir: string): PackFolderVersion | null {
  const metadataDir = gitMetadataDir(packDir)
  if (metadataDir) {
    const sha = readGitHeadSha(metadataDir)
    if (sha) {
      const remoteUrl = readGitRemoteUrl(metadataDir)
      return { kind: 'git-checkout', revision: sha, ...(remoteUrl ? { remoteUrl } : {}) }
    }
  }
  try {
    const pyproject = parsePyproject(readFileSync(join(packDir, 'pyproject.toml'), 'utf8'))
    if (pyproject.hasComfySection && pyproject.version) return { kind: 'comfyui-registry', version: pyproject.version }
    if (pyproject.version) return { kind: 'pyproject', version: pyproject.version }
  } catch { /* no pyproject — nothing more to read */ }
  return null
}

// ---------------------------------------------------------------------------
// Pin relation (ordering half; gitOrder injectable for tests)
// ---------------------------------------------------------------------------

export type GitOrder = 'ancestor' | 'descendant' | 'unrelated' | 'unknown'

/** Default git ordering helper: `git merge-base --is-ancestor A B` against
 *  the folder's own history. Runs only when BOTH revisions are shas and the
 *  folder is a git checkout — the one case with local ground truth. */
export async function gitOrderRevision(packDir: string, candidate: string, reference: string): Promise<GitOrder> {
  if (!isSha(candidate) || !isSha(reference)) return 'unknown'
  const isAncestor = (a: string, b: string) => new Promise<boolean | 'error'>((resolvePromise) => {
    execFile('git', ['-C', packDir, 'merge-base', '--is-ancestor', a, b], { timeout: 3000 }, (error) => {
      if (error && (error as { code?: number }).code !== 1) resolvePromise('error')
      else resolvePromise(!error)
    })
  })
  const candidateFirst = await isAncestor(candidate, reference)
  if (candidateFirst === 'error') return 'unknown'
  if (candidateFirst) return 'ancestor' // candidate is an ancestor of reference
  const referenceFirst = await isAncestor(reference, candidate)
  if (referenceFirst === 'error') return 'unknown'
  if (referenceFirst) return 'descendant' // candidate descends from reference
  return 'unrelated'
}

/** Numeric semver-ish compare; null when either side is not ordered shape. */
export function compareSemverish(a: string, b: string): number | null {
  if (!isSemverish(a) || !isSemverish(b)) return null
  const parts = (value: string) => value.trim().replace(/^v/, '').split('-')[0].split('+')[0].split('.').map((piece) => Number.parseInt(piece, 10))
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** Relate a discovered folder version to the pack's pin. Pure except the
 *  injectable gitOrder (default: the real spawn). */
export async function relateVersionToPin(
  pin: string,
  detected: PackFolderVersion,
  packDir: string,
  gitOrder: typeof gitOrderRevision = gitOrderRevision,
): Promise<VersionRelation> {
  if (detected.kind === 'git-checkout') {
    if (detected.revision === pin.trim().toLowerCase()) return 'at-pin'
    if (!isSha(pin)) return 'unknown' // branch pin vs a sha — no local relation
    const order = await gitOrder(packDir, detected.revision, pin)
    if (order === 'descendant') return 'ahead-of-pin'
    if (order === 'ancestor') return 'behind-pin'
    // Diverged history, the pin absent from this checkout, or git itself
    // unavailable — the revisions DIFFER (both are shas and unequal) but
    // the direction is not claimed. 'unknown' is reserved for shapes where
    // even the difference is unestablishable.
    return 'differs'
  }
  if (detected.version.trim() === pin.trim()) return 'at-pin'
  const ordering = compareSemverish(detected.version, pin)
  if (ordering === null) return 'unknown'
  return ordering === 0 ? 'at-pin' : ordering > 0 ? 'ahead-of-pin' : 'behind-pin'
}

// ---------------------------------------------------------------------------
// Managed-instance notice (AC-4)
// ---------------------------------------------------------------------------

function shortRevision(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

/** The informational notice for a ComfyUI-managed pack whose version differs
 *  from the pin (AC-4): names both versions, never claims an unknowable
 *  direction, and says updates happen instance-side. Undefined when there is
 *  nothing to notice (at-pin, or no version to compare). */
export function managedNoticeText(pack: NodePackDefinition, detected: PackFolderVersion, relation: VersionRelation): string | undefined {
  if (relation !== 'ahead-of-pin' && relation !== 'behind-pin' && relation !== 'differs') return undefined
  const installed = detected.kind === 'git-checkout' ? shortRevision(detected.revision) : detected.version
  const pinLabel = isSha(pack.pinnedRevision) ? shortRevision(pack.pinnedRevision) : pack.pinnedRevision
  const direction = relation === 'ahead-of-pin' ? ' (ahead of the pin)'
    : relation === 'behind-pin' ? ' (behind the pin)'
      : ' — ahead or behind is not determinable from this machine'
  return `${pack.name} is managed by the ComfyUI instance — the studio pins ${pinLabel}, the installed version is ${installed}${direction}. Updates happen on the instance side (ComfyUI-Manager); the studio never modifies this folder.`
}
