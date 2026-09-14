/**
 * Vendored custom-node management (increment 2 of task 3ay7wbz — the first
 * slice of AC zzdfklo). custom_nodes/ is ComfyUI's sanctioned extension
 * seam: every pack the managed instance needs is tracked HERE, as data,
 * with an explicit license verdict and install mode:
 *
 *   vendor      the studio ships the pack inside its own repo
 *               (vendor/nodes/<dir>, pinned revision, license-verified
 *               permissive). Install = code files copied into the
 *               checkout's custom_nodes/, WEIGHT files LINKED (never
 *               copied — the AC 35m2zvh invariant), a studio marker
 *               recording id/revision. Uninstall = delete the folder.
 *   user-fetch  the user consents to the pack being placed into the
 *               instance's custom_nodes/ themselves (this increment: from
 *               a local directory they nominate; the network clone-on-
 *               consent fetcher is task hgjbea2). Used for packs whose
 *               license does not permit redistribution — facok's controlnet
 *               pack carries NO license and must never be vendored — and
 *               for packs not yet vendored.
 *
 * LICENSING DISCIPLINE IS ABSOLUTE here: every registry entry carries an
 * SPDX record; a repo with no license file is recorded as 'NO-LICENSE'
 * (all-rights-reserved by default) and forced to user-fetch mode. Anything
 * ambiguous also goes user-fetch. The registry data below is the audit
 * record — see docs/PROVENANCE.md for the vendored payload's provenance.
 *
 * Weight policy (AC 35m2zvh): the managed instance LINKS weights, never
 * copies them. extra_model_paths.yaml v1 already references the user's
 * real model roots in place; this module's linkNeverCopy() is the same
 * invariant for pack-carried weights and for any weight the studio places
 * into a model root: symlink → junction (dirs, Windows) → hardlink (files,
 * same volume) → REFUSE with a reason. Never a byte-for-byte copy.
 */
import { existsSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AppSettings, ModelKind, NodePackDefinition, NodePackStatus } from '../src/types'

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** License verdicts recorded 2026-09-14 (task 3ay7wbz increment 2):
 *  - ComfyUI-VDN-H3 (Saganaki22): Apache-2.0 — LICENSE file + README
 *    statement + GitHub badge, verified against the cloned payload.
 *  - ComfyUI-MiniMax-H3-Turbo (Larryvrh): Apache-2.0 — LICENSE file read
 *    from the local testbed install.
 *  - comfyui-krea2-controlnet (facok): NO license file in the repo —
 *    all-rights-reserved by default; NEVER vendored, user-fetch only
 *    (docs/research/krea2-edit-mode.md flags it as a hard blocker). */
export const ENGINE_NODE_PACKS: NodePackDefinition[] = [
  {
    id: 'vdn-h3',
    name: 'ComfyUI-VDN-H3',
    description: 'The community VDN port — a node pack, not a fork. VDN-proper is applied as runtime model patches on ComfyUI\'s native MiniMax-H3 ModelPatcher: nothing outside custom_nodes/, no core patch, no new dependencies. Weights are downloaded separately from Hugging Face and land as links in your model roots.',
    repoUrl: 'https://github.com/Saganaki22/ComfyUI-VDN-H3',
    pinnedRevision: '3eb63496c24ca70faaf8a14b6c75fcb480e34bf1',
    licenseSpdx: 'Apache-2.0',
    installMode: 'vendor',
    vendorDir: 'ComfyUI-VDN-H3',
    homepage: 'https://github.com/Saganaki22/ComfyUI-VDN-H3',
  },
  {
    id: 'minimax-h3-turbo',
    name: 'ComfyUI-MiniMax-H3-Turbo',
    description: 'Larryvrh\'s turbo-LoRA loader node (the pack the optimization registry detects as larryvrhTurbo) plus the h3_silu_temb_grid fix for pruned bases. License-clean (Apache-2.0) but not vendored yet — install from a local copy of the repo.',
    repoUrl: 'https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo',
    pinnedRevision: '4274783a23afcfdbea3b4876cb79effd6c510785',
    licenseSpdx: 'Apache-2.0',
    installMode: 'user-fetch',
    homepage: 'https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo',
  },
  {
    id: 'krea2-controlnet',
    name: 'comfyui-krea2-controlnet',
    description: 'facok\'s Krea 2 ControlNet-LoRA pack (depth structure lock for Krea 2 regeneration). The repo carries NO license file — all-rights-reserved by default — so it is never vendored and only ever installed into your own instance from a local copy, with your consent.',
    repoUrl: 'https://github.com/facok/comfyui-krea2-controlnet',
    pinnedRevision: 'main',
    licenseSpdx: 'NO-LICENSE',
    licenseNote: 'No license file in the upstream repo — redistribution not permitted; user-fetch only, never vendored (docs/research/krea2-edit-mode.md).',
    installMode: 'user-fetch',
    homepage: 'https://github.com/facok/comfyui-krea2-controlnet',
  },
]

export function findNodePack(id: string): NodePackDefinition | null {
  return ENGINE_NODE_PACKS.find((pack) => pack.id === id) ?? null
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Everything the studio must never copy byte-for-byte into an install. */
const WEIGHT_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf'])
/** Dirs that never belong in an installed pack. */
const EXCLUDED_DIRS = new Set(['__pycache__', '.git', '.github', 'node_modules', '.pytest_cache', '.mypy_cache'])
const INSTALL_MARKER = '.studio-node.json'

export function isWeightFile(file: string): boolean {
  return WEIGHT_EXTENSIONS.has(file.slice(file.lastIndexOf('.')).toLowerCase())
}

/** Where a pack installs: the checkout's custom_nodes/<name>. */
export function nodePackInstallDir(checkout: string, pack: NodePackDefinition): string {
  return join(resolve(checkout), 'custom_nodes', pack.name)
}

/** The vendored payload root: env override first, then a walk up from this
 *  module (dist-server/server → repo root) to vendor/nodes. Null in a
 *  packaged build without the vendor payload — vendored packs then report
 *  unavailable and user-fetch remains the path. */
export function resolveVendorRoot(): string | null {
  const override = process.env.MINIMAX_STUDIO_VENDOR_ROOT?.trim()
  if (override && isAbsolute(override) && existsSync(override)) return override
  let directory = __dirname
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'vendor', 'nodes')
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/** The install marker: our record of what we placed and when. */
type InstallMarker = { id: string; revision: string; mode: string; installedAt: number; source: string }

async function readInstallMarker(installDir: string): Promise<InstallMarker | null> {
  try {
    const raw = JSON.parse(await readFile(join(installDir, INSTALL_MARKER), 'utf8')) as InstallMarker
    if (raw && typeof raw.id === 'string' && typeof raw.revision === 'string') return raw
  } catch { /* not installed by us, or unreadable */ }
  return null
}

// ---------------------------------------------------------------------------
// Weight symlinking — LINK, NEVER COPY (AC 35m2zvh)
// ---------------------------------------------------------------------------

export type LinkKind = 'symlink' | 'junction' | 'hardlink'

/** Links target → linkPath without duplicating bytes. Chain: symlink →
 *  junction (directories, Windows — no privilege needed) → hardlink (files,
 *  same volume only). When none can be created the link is REFUSED with a
 *  reason — the caller surfaces it; a copy is never the fallback. An
 *  existing linkPath that already resolves to the same target is reused
 *  (idempotent); anything else existing there is refused (never silently
 *  re-targeted, never overwritten). */
export async function linkNeverCopy(target: string, linkPath: string): Promise<{ ok: true; kind: LinkKind } | { ok: false; reason: string }> {
  const absoluteTarget = resolve(target)
  if (!existsSync(absoluteTarget)) return { ok: false, reason: `link target does not exist: ${absoluteTarget}` }
  if (existsSync(linkPath) || (await isLinkPresent(linkPath))) {
    const pointsAt = await resolvesTo(linkPath, absoluteTarget)
    if (pointsAt) return { ok: true, kind: 'symlink' }
    return { ok: false, reason: `refusing to overwrite the existing entry at ${linkPath}` }
  }
  const targetStat = await lstat(absoluteTarget)
  try {
    await symlink(absoluteTarget, linkPath)
    return { ok: true, kind: 'symlink' }
  } catch {
    // Windows without developer mode: symlinks need a privilege. Junctions
    // work for directories without one; hardlinks work for files on the
    // same volume. Both still share the bytes — never a copy.
    try {
      if (targetStat.isDirectory()) {
        await symlink(absoluteTarget, linkPath, 'junction')
        return { ok: true, kind: 'junction' }
      }
      await link(absoluteTarget, linkPath)
      return { ok: true, kind: 'hardlink' }
    } catch (linkFailure) {
      return { ok: false, reason: `could not link ${absoluteTarget} → ${linkPath} (${linkFailure instanceof Error ? linkFailure.message : String(linkFailure)})` }
    }
  }
}

/** existsSync follows symlinks — a dangling link needs lstat to be seen. */
async function isLinkPresent(linkPath: string): Promise<boolean> {
  return (await lstat(linkPath).catch(() => null)) !== null
}

async function resolvesTo(linkPath: string, target: string): Promise<boolean> {
  const { realpath } = await import('node:fs/promises')
  try {
    return resolve(await realpath(linkPath)) === resolve(await realpath(target))
  } catch {
    return false
  }
}

/** Places a weight into one of the user's real model roots as a LINK — the
 *  invariant's public seam for any weight the studio ever manages (fetched
 *  checkpoints included; the vendored packs use it for pack-carried
 *  tensors). Returns the link path on success; refusals carry a reason and
 *  NEVER fall back to copying. */
export async function linkWeightIntoModelRoot(source: string, kind: ModelKind, settings: AppSettings): Promise<{ ok: true; path: string; kind: LinkKind } | { ok: false; reason: string }> {
  const root = settings.paths[kind]
  if (typeof root !== 'string' || !isAbsolute(root) || !existsSync(resolve(root))) {
    return { ok: false, reason: `the ${kind} model root is not a usable absolute directory` }
  }
  const name = source.slice(source.replace(/\\/g, '/').lastIndexOf('/') + 1)
  const linkPath = join(resolve(root), name)
  const linked = await linkNeverCopy(source, linkPath)
  return linked.ok ? { ok: true, path: linkPath, kind: linked.kind } : linked
}

// ---------------------------------------------------------------------------
// Availability / install / uninstall
// ---------------------------------------------------------------------------

/** True when the path is shaped like a ComfyUI checkout we may install into. */
export function isUsableCheckout(checkoutPath: string): boolean {
  if (!checkoutPath.trim()) return false
  const checkout = resolve(checkoutPath)
  return isAbsolute(checkout) && existsSync(join(checkout, 'main.py'))
}

export async function checkNodePack(pack: NodePackDefinition, checkout: string | null, vendorRoot: string | null): Promise<NodePackStatus> {
  const vendored = pack.installMode === 'vendor' && Boolean(pack.vendorDir && vendorRoot && existsSync(join(vendorRoot, pack.vendorDir)))
  const base: NodePackStatus = {
    ...pack,
    vendored,
    installed: false,
    availability: 'unavailable',
  }
  if (!checkout || !isUsableCheckout(checkout)) {
    return { ...base, note: 'a valid ComfyUI checkout (with main.py) is required before packs can be installed.' }
  }
  const installDir = nodePackInstallDir(checkout, pack)
  const folderExists = existsSync(installDir)
  const marker = folderExists ? await readInstallMarker(installDir) : null
  if (marker) {
    const status: NodePackStatus = { ...base, installed: true, installedRevision: marker.revision }
    return withAvailability(status, pack, vendored, marker.revision !== pack.pinnedRevision ? `pinned revision changed — reinstall to move ${marker.revision.slice(0, 12)} → ${pack.pinnedRevision.slice(0, 12)}.` : undefined)
  }
  if (folderExists) {
    // The folder exists but WE did not place it (no studio marker). Never a
    // candidate for silent replacement — reported, the user decides.
    return { ...base, note: `custom_nodes/${pack.name} already exists but was not installed by the studio — remove it yourself first if you want the studio's pinned copy.` }
  }
  return withAvailability(base, pack, vendored)
}

function withAvailability(status: NodePackStatus, pack: NodePackDefinition, vendored: boolean, note?: string): NodePackStatus {
  const availability: NodePackStatus['availability'] = pack.installMode === 'vendor'
    ? (vendored ? 'ready' : 'unavailable')
    : 'needs-source'
  const baseNote = pack.installMode === 'vendor' && !vendored
    ? 'the vendored payload is not present in this install (vendor/nodes not found); use user-fetch from a local copy.'
    : pack.installMode === 'user-fetch' && !note
      ? 'user-fetch: install from a local copy of the repository (the consent-based network fetcher lands in a later increment).'
      : undefined
  const notes = [note, baseNote].filter((entry): entry is string => Boolean(entry))
  return { ...status, availability, note: notes.length ? notes.join(' ') : undefined }
}

export type InstallNodePackOptions = {
  checkout: string
  /** Local directory holding the pack's files (user-fetch mode; the
   *  network clone-on-consent fetcher is a later increment). */
  sourceDirectory?: string
  vendorRoot?: string | null
}

export type InstallNodePackResult = { status: NodePackStatus; installed: boolean; alreadyInstalled?: boolean; notes: string[] }

/** Installs (or reinstalls-at-pin) one pack into the checkout's
 *  custom_nodes/. Code files are copied; weight files are LINKED (never
 *  copied); a marker records id + pinned revision so a version bump is a
 *  delete-and-reinstall rather than a merge. A foreign custom_nodes/<name>
 *  (present without our marker) is refused, never replaced. The install is
 *  staged-then-renamed: a mid-copy failure leaves no half pack behind. */
export async function installNodePack(pack: NodePackDefinition, options: InstallNodePackOptions): Promise<InstallNodePackResult> {
  const notes: string[] = []
  const checkout = resolve(options.checkout)
  const vendorRoot = options.vendorRoot !== undefined ? options.vendorRoot : resolveVendorRoot()
  if (!isUsableCheckout(checkout)) {
    return { status: await checkNodePack(pack, checkout, vendorRoot), installed: false, notes: ['a valid ComfyUI checkout (with main.py) is required before packs can be installed.'] }
  }
  let sourceRoot: string | null = null
  let sourceLabel = ''
  if (pack.installMode === 'vendor') {
    sourceRoot = pack.vendorDir && vendorRoot ? join(vendorRoot, pack.vendorDir) : null
    sourceLabel = 'vendored payload'
    if (!sourceRoot || !existsSync(sourceRoot)) {
      return { status: await checkNodePack(pack, checkout, vendorRoot), installed: false, notes: ['the vendored payload is not present in this install.'] }
    }
  } else {
    const nominated = options.sourceDirectory?.trim() ?? ''
    if (!nominated || !isAbsolute(nominated) || !existsSync(resolve(nominated))) {
      return { status: await checkNodePack(pack, checkout, vendorRoot), installed: false, notes: ['user-fetch packs install from an absolute local directory holding the repository (network fetcher lands in a later increment).'] }
    }
    sourceRoot = resolve(nominated)
    sourceLabel = `local copy (${sourceRoot})`
  }

  const installDir = nodePackInstallDir(checkout, pack)
  const existingMarker = existsSync(installDir) ? await readInstallMarker(installDir) : null
  if (existsSync(installDir) && !existingMarker) {
    return { status: await checkNodePack(pack, checkout, vendorRoot), installed: false, notes: [`custom_nodes/${pack.name} already exists but was not installed by the studio — refusing to replace it. Remove it first if you want the pinned copy.`] }
  }
  if (existingMarker && existingMarker.revision === pack.pinnedRevision) {
    return { status: await checkNodePack(pack, checkout, vendorRoot), installed: true, alreadyInstalled: true, notes: [`${pack.name} is already installed at the pinned revision ${pack.pinnedRevision.slice(0, 12)}.`] }
  }
  if (existingMarker) {
    // Version bump: uninstall the old copy, then reinstall at the pin —
    // never merge two revisions of a pack into one folder.
    notes.push(`revision changed (${existingMarker.revision.slice(0, 12)} → ${pack.pinnedRevision.slice(0, 12)}): reinstalling at the pin.`)
    await uninstallNodePack(pack, checkout)
  }

  await mkdir(dirname(installDir), { recursive: true })
  const staged = `${installDir}.studio-staging`
  await rm(staged, { recursive: true, force: true }).catch(() => undefined)
  try {
    const weightLinks: string[] = []
    await copyPackTree(sourceRoot, staged, weightLinks)
    if (weightLinks.length) notes.push(`weights linked, never copied: ${weightLinks.map((entry) => entry.split(/[/\\]/).pop()).join(', ')}.`)
    const marker: InstallMarker = { id: pack.id, revision: pack.pinnedRevision, mode: pack.installMode, installedAt: Date.now(), source: sourceLabel }
    await writeFile(join(staged, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    await rename(staged, installDir)
  } catch (installFailure) {
    // The staged tree never became the installed one — discard it whole.
    await rm(staged, { recursive: true, force: true }).catch(() => undefined)
    const status = await checkNodePack(pack, checkout, vendorRoot)
    return { status, installed: false, notes: [installFailure instanceof Error ? installFailure.message : String(installFailure)] }
  }
  return { status: await checkNodePack(pack, checkout, vendorRoot), installed: true, notes }
}

/** Copies the pack tree: code files byte-for-byte, weight files as links
 *  (linkNeverCopy), junk dirs skipped, symlinks replicated as the same kind
 *  of link. A weight that cannot be linked THROWS — the staged tree is then
 *  discarded by the caller's catch, and no half-installed pack survives
 *  (install is staged-then-rename atomic). */
async function copyPackTree(source: string, destination: string, weightLinks: string[]): Promise<void> {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyPackTree(from, to, weightLinks)
      continue
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(from)
      await symlink(target, to).catch((linkFailure: unknown) => { throw new Error(`symlink ${entry.name} could not be replicated (${linkFailure instanceof Error ? linkFailure.message : String(linkFailure)})`) })
      continue
    }
    if (!entry.isFile()) continue
    if (isWeightFile(entry.name)) {
      const linked = await linkNeverCopy(from, to)
      if (!linked.ok) throw new Error(`weight ${entry.name} could not be linked (${linked.reason}) — refusing to copy it instead`)
      weightLinks.push(to)
      continue
    }
    await copyFile(from, to)
  }
}

/** Uninstall = delete the folder (the design's own rule). Removing the
 *  marker-only install never touches anything outside custom_nodes/<name>. */
export async function uninstallNodePack(pack: NodePackDefinition, checkout: string): Promise<{ removed: boolean; reason?: string }> {
  const installDir = nodePackInstallDir(checkout, pack)
  if (!existsSync(installDir)) return { removed: false, reason: `${pack.name} is not installed` }
  await rm(installDir, { recursive: true, force: true })
  await rm(`${installDir}.studio-staging`, { recursive: true, force: true }).catch(() => undefined)
  return { removed: true }
}

/** Availability for every entry in one call (the Settings surface + the
 *  nodes route). */
export async function checkAllNodePacks(checkout: string | null, vendorRoot: string | null): Promise<NodePackStatus[]> {
  return Promise.all(ENGINE_NODE_PACKS.map((pack) => checkNodePack(pack, checkout, vendorRoot)))
}
