/**
 * Consent patch manager for the MANAGED engine (increment 2 of task
 * 3ay7wbz) — the "LongCache-class patch" tier from the resolved delivery
 * policy (Flux comment czxaaub / research §1.2(d)).
 *
 * What this is: a version-gated, layout-detecting, consent-gated patcher for
 * the ONE class of optimization that cannot ride ComfyUI's sanctioned
 * custom_nodes/ seam — a core-file hook. Everything else (VDN-proper
 * included) ships as an in-memory node and never touches this module.
 *
 * The discipline is ported from the maintainer's 24 GB fork installer
 * (tools/install_minimax_block_loop_hook.py, Apache-2.0 — content constants
 * below are a verbatim port with attribution), which is the textbook pattern
 * ComfyUI-Manager expects of anything touching core:
 *
 *   layout-detect  strict regexes against KNOWN block-loop layouts only; an
 *                  unrecognized layout (future ComfyUI refactor) is REFUSED
 *                  with "no file was changed" — never a best-effort patch.
 *   validate       the candidate text is checked before anything lands:
 *                  structural balance always, plus a real `python -c
 *                  "import ast; ast.parse(...)"` when an interpreter is
 *                  resolvable (it is, by construction, in managed mode).
 *   atomic         same-directory temp file + rename — a kill mid-write can
 *                  never leave a partial or empty file behind.
 *   pristine       the backup is refreshed from an UNPATCHED target whenever
 *                  one is seen, so a ComfyUI update that overwrites the file
 *                  re-seeds a clean backup before we re-patch.
 *   revert         --revert restores the pristine backup; a missing or empty
 *                  backup refuses rather than guessing.
 *   version gate   the patch only runs when the checkout's ComfyUI version
 *                  is one whose layout we have VERIFIED (0.33.x per the
 *                  upstream installer, 0.34.0 on our own testbed). Anything
 *                  else degrades: the engine launches unpatched and VDN
 *                  still works — you just lose the LongCache tail cache.
 *
 * CONSENT IS ABSOLUTE: nothing in this module checks consent itself — the
 * RuntimeManager hook path refuses to call apply unless
 * settings.engine.patches[id].consented is true, and no other production
 * path reaches apply. A patch is never applied without that record.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Patch definitions
// ---------------------------------------------------------------------------

export type EnginePatch = {
  id: string
  label: string
  description: string
  /** File touched, relative to the checkout root — exactly one, ever. */
  targetFile: string
  backupSuffix: string
  /** ComfyUI versions whose target layout we have VERIFIED (display). */
  testedComfyVersions: string[]
  /** The gate itself: the detected version must match. */
  versionGate: RegExp
  /** What is lost when this patch refuses/degrades (wording for warnings). */
  degradesTo: string
}

/** The LongCache block-loop hook: creates the ("block_loop", 0) extension
 *  point stock ComfyUI does not expose, needed ONLY by LongCache. Verified
 *  layouts: the current 0.33.x/0.34 loop (matches our 0.34.0 testbed) and
 *  the older malloc_scope="block" variant. */
export const LONGCACHE_PATCH: EnginePatch = {
  id: 'longcache-block-loop',
  label: 'VDN LongCache block-loop hook',
  description: 'Inserts a reversible block-loop dispatch into comfy/ldm/minimax/model.py so LongCache can replace the 50-block loop on selected steps. VDN-proper does not need it; stock behavior is preserved when no replacement is registered.',
  targetFile: join('comfy', 'ldm', 'minimax', 'model.py'),
  backupSuffix: '.studio-longcache.bak',
  testedComfyVersions: ['0.33.x', '0.34.x'],
  versionGate: /^0\.(33|34)\./,
  degradesTo: 'VDN still works — you only lose the LongCache tail cache',
}

export const ENGINE_PATCHES: EnginePatch[] = [LONGCACHE_PATCH]
export const ENGINE_PATCH_IDS = new Set(ENGINE_PATCHES.map((patch) => patch.id))

// ---------------------------------------------------------------------------
// Patch content — verbatim port of the fork's installer (Apache-2.0,
// ComfyUI-VDN-H3-24GB/tools/install_minimax_block_loop_hook.py). The helper
// mirrors the upstream loop exactly but adds a start/end slice; the hook
// preserves patches_replace and ComfyUI prefetch.
// ---------------------------------------------------------------------------

const RUN_BLOCKS = `    def _run_blocks(self, h, t_emb, mod_segments, rope_freqs, transformer_options, start=0, end=None):
        patches_replace = transformer_options.get("patches_replace", {})
        blocks_replace = patches_replace.get("dit", {})
        device = h.device
        start = max(0, int(start))
        end = len(self.blocks) if end is None else min(len(self.blocks), int(end))
        if end <= start:
            return h
        prefetch_queue = comfy.model_prefetch.make_prefetch_queue(list(self.blocks[start:end]), device, transformer_options)
        for i in range(start, end):
            block = self.blocks[i]
            comfy.model_prefetch.prefetch_queue_pop(prefetch_queue, device, block)
            if ("double_block", i) in blocks_replace:
                def block_wrap(args):
                    return {"img": block(args["img"], args["t_emb"], args["mod_segments"], args["rope_freqs"],
                                         transformer_options=args["transformer_options"])}
                h = blocks_replace[("double_block", i)](
                    {"img": h, "t_emb": t_emb, "mod_segments": mod_segments, "rope_freqs": rope_freqs,
                     "transformer_options": transformer_options},
                    {"original_block": block_wrap})["img"]
            else:
                h = block(h, t_emb, mod_segments, rope_freqs, transformer_options=transformer_options)
        if prefetch_queue is not None:
            comfy.model_prefetch.prefetch_queue_pop(prefetch_queue, device, None)
        return h

`

const HOOK_LOOP = `        # blocks (VDN/TE-compatible block-loop hook)
        patches_replace = transformer_options.get("patches_replace", {})
        blocks_replace = patches_replace.get("dit", {})
        cache_ranges = [(a, b) for a, b, kind in layout.segments if kind in ("audio", "video")]
        if ("block_loop", 0) in blocks_replace:
            def block_loop_wrap(args):
                return {"img": self._run_blocks(args["img"], args["t_emb"], args["mod_segments"], args["rope_freqs"],
                                                args["transformer_options"], args.get("start", 0), args.get("end"))}
            h = blocks_replace[("block_loop", 0)](
                {"img": h, "t_emb": t_emb, "mod_segments": mod_segments, "rope_freqs": rope_freqs,
                 "transformer_options": transformer_options, "cache_ranges": cache_ranges,
                 "block_count": len(self.blocks)},
                {"original_block": block_loop_wrap})["img"]
        else:
            h = self._run_blocks(h, t_emb, mod_segments, rope_freqs, transformer_options)
`

/** Current 0.33.x/0.34 block loop (deliberately strict; tolerant of CRLF). */
const LOOP_RE_CURRENT = new RegExp(
  ' {8}# blocks\\r?\\n' +
  ' {8}patches_replace = transformer_options\\.get\\("patches_replace", \\{\\}\\)\\r?\\n' +
  ' {8}blocks_replace = patches_replace\\.get\\("dit", \\{\\}\\)\\r?\\n' +
  ' {8}prefetch_queue = comfy\\.model_prefetch\\.make_prefetch_queue\\(list\\(self\\.blocks\\), device, transformer_options\\)\\r?\\n' +
  ' {8}for i, block in enumerate\\(self\\.blocks\\):\\r?\\n' +
  '[\\s\\S]*?' +
  ' {8}if prefetch_queue is not None:\\r?\\n' +
  ' {12}comfy\\.model_prefetch\\.prefetch_queue_pop\\(prefetch_queue, device, None\\)\\r?\\n',
)

/** Earlier tested build used malloc_scope="block" — kept for compatibility. */
const LOOP_RE_OLD = new RegExp(
  ' {8}# blocks\\r?\\n' +
  ' {8}patches_replace = transformer_options\\.get\\("patches_replace", \\{\\}\\)\\r?\\n' +
  ' {8}blocks_replace = patches_replace\\.get\\("dit", \\{\\}\\)\\r?\\n' +
  ' {8}prefetch_queue = comfy\\.model_prefetch\\.make_prefetch_queue\\(list\\(self\\.blocks\\), device, transformer_options\\)\\r?\\n' +
  '[\\s\\S]*?' +
  ' {12}comfy\\.model_prefetch\\.prefetch_queue_pop\\(prefetch_queue, device, None, malloc_scope="block"\\)\\r?\\n',
)

const FORWARD_ANCHOR = '    def _forward(self, x, timestep, context, transformer_options={}, minimax_payload=None, denoise_mask=None, audio_denoise_mask=None, **kwargs):'

const MARKER_HELPER = 'def _run_blocks(self, h, t_emb'
const MARKER_DISPATCH = '("block_loop", 0) in blocks_replace'

// ---------------------------------------------------------------------------
// Layout detection (pure + testable)
// ---------------------------------------------------------------------------

export type PatchLayout = 'clean-current' | 'clean-old' | 'patched' | 'unknown'

export function detectPatchLayout(text: string): PatchLayout {
  if (text.includes(MARKER_HELPER) && text.includes(MARKER_DISPATCH)) return 'patched'
  if (LOOP_RE_CURRENT.test(text)) return 'clean-current'
  if (LOOP_RE_OLD.test(text)) return 'clean-old'
  return 'unknown'
}

/** Adapts the ported patch content to the file's own line endings so a CRLF
 *  checkout is not silently converted to LF by the patch. */
function patchContentForEol(text: string, content: string): string {
  return text.includes('\r\n') ? content.replace(/\n/g, '\r\n') : content
}

/** The pure transform: strict-layout substitution + helper insertion, with
 *  marker/count validation — no filesystem effects. Unknown layouts refuse
 *  here (nothing to substitute against). */
export function transformPatchedText(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (detectPatchLayout(text) === 'patched') return { ok: true, text }
  const matcher = LOOP_RE_CURRENT.test(text) ? LOOP_RE_CURRENT : LOOP_RE_OLD
  if (!matcher.test(text)) {
    return { ok: false, reason: 'could not safely locate the MiniMax-H3 block loop in this ComfyUI build; no file was changed' }
  }
  const eolHookLoop = patchContentForEol(text, HOOK_LOOP)
  let out = text.replace(matcher, () => eolHookLoop)
  if (!out.includes(MARKER_HELPER)) {
    if (!out.includes(FORWARD_ANCHOR)) {
      return { ok: false, reason: 'MiniMax-H3 _forward anchor not found; no file was changed' }
    }
    out = out.replace(FORWARD_ANCHOR, () => patchContentForEol(text, RUN_BLOCKS) + FORWARD_ANCHOR)
  }
  // Internal validation, ported: both markers must land exactly once.
  if (countOccurrences(out, MARKER_HELPER) !== 1 || countOccurrences(out, MARKER_DISPATCH) !== 1) {
    return { ok: false, reason: 'internal hook validation failed; no file was changed' }
  }
  return { ok: true, text: out }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

// ---------------------------------------------------------------------------
// Structural validation (always-on; approximates the fork's ast.parse gate
// where no interpreter is available: bracket balance outside strings and
// comments, string termination, spaces-only indentation)
// ---------------------------------------------------------------------------

export function structuralBalance(text: string): { ok: true } | { ok: false; problem: string } {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const closers = new Set(Object.values(pairs))
  const stack: string[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '#') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1
      continue
    }
    if (char === '"' || char === "'") {
      const triple = text.slice(i, i + 3)
      if (triple === '"""' || triple === "'''") {
        const end = text.indexOf(triple, i + 3)
        if (end < 0) return { ok: false, problem: 'unterminated triple-quoted string' }
        i = end + 3
        continue
      }
      const quote = char
      i += 1
      while (i < text.length && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\') i += 1
        i += 1
      }
      if (text[i] !== quote) return { ok: false, problem: 'unterminated string literal' }
      i += 1
      continue
    }
    if (char in pairs) {
      stack.push(char)
      i += 1
      continue
    }
    if (closers.has(char)) {
      const open = stack.pop()
      if (!open || pairs[open] !== char) return { ok: false, problem: `unbalanced '${char}'` }
      i += 1
      continue
    }
    if (char === '\t') return { ok: false, problem: 'tab character in a spaces-indented file' }
    i += 1
  }
  if (stack.length) return { ok: false, problem: `unclosed '${stack[stack.length - 1]}'` }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Python AST validation (the real gate, whenever an interpreter answers)
// ---------------------------------------------------------------------------

const AST_PROBE_TIMEOUT_MS = 10_000
const AST_PROBE_SCRIPT = 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())'

/** True when a command name is a python interpreter (python/python3/py/
 *  pypy, with Windows extension shims). The ast gate refuses candidates
 *  only through something that can actually parse Python. */
function looksLikePython(command: string): boolean {
  const name = command.replace(/\\/g, '/').split('/').pop() ?? ''
  return /^(python|python3|python\d+(\.\d+)?|pypy3?|py)(\.(exe|cmd|bat))?$/i.test(name)
}

/** Runs python's ast.parse on a file. Uses shell spawning only for the
 *  Windows .cmd/.bat shim case (EINVAL otherwise), mirroring EngineProcess.
 *  A result with ok:false and interpreterMissing:true means no interpreter
 *  answered at all (the structural fallback applies); ok:false without it
 *  means the parser REJECTED the candidate (a hard refusal). */
function runPythonAstCheck(command: string, file: string): Promise<{ ok: boolean; error?: string; interpreterMissing?: boolean }> {
  return new Promise((resolveCheck) => {
    const useShell = /\.(cmd|bat)$/i.test(command)
    const done = (error: { code?: string | number | null; message?: string } | null, stdout: string, stderr: string) => {
      if (!error) return resolveCheck({ ok: true })
      const interpreterMissing = error.code === 'ENOENT' || (typeof error.code !== 'number' && /spawn/i.test(error.message ?? ''))
      const detail = (stderr || stdout || error.message || 'unknown error').slice(0, 400)
      resolveCheck({ ok: false, error: detail, interpreterMissing })
    }
    if (useShell) {
      execFile('cmd', ['/d', '/s', '/c', `"${command}" -c "${AST_PROBE_SCRIPT}" "${file}"`], { windowsHide: true, timeout: AST_PROBE_TIMEOUT_MS }, done)
    } else {
      execFile(command, ['-c', AST_PROBE_SCRIPT, file], { windowsHide: true, timeout: AST_PROBE_TIMEOUT_MS }, done)
    }
  })
}

// ---------------------------------------------------------------------------
// Version gate
// ---------------------------------------------------------------------------

export type PatchVersionGate = { ok: boolean; version: string | null; source: 'checkout' | 'settings' | 'none' }

/** The checkout's own version (comfyui_version.py is generated from
 *  pyproject at build time); null when the checkout does not state one. */
async function readCheckoutVersion(checkout: string): Promise<string | null> {
  for (const candidate of [join(resolve(checkout), 'comfyui_version.py'), join(resolve(checkout), 'ComfyUI', 'comfyui_version.py')]) {
    try {
      const text = await readFile(candidate, 'utf8')
      const match = /__version__\s*=\s*["']([^"']+)["']/.exec(text)
      if (match?.[1]) return match[1]
    } catch { /* try the next candidate */ }
  }
  return null
}

/** Resolves the version the gate runs against: the checkout's own file
 *  first, the studio's recorded testedComfyVersion as fallback, and NO
 *  version at all means the gate fails closed. */
async function versionGateFor(checkout: string, patch: EnginePatch, fallbackVersion: string | undefined): Promise<PatchVersionGate> {
  const checkoutVersion = await readCheckoutVersion(checkout)
  if (checkoutVersion) {
    return { ok: patch.versionGate.test(checkoutVersion), version: checkoutVersion, source: 'checkout' }
  }
  const fallback = typeof fallbackVersion === 'string' ? fallbackVersion.trim() : ''
  if (fallback) {
    return { ok: patch.versionGate.test(fallback), version: fallback, source: 'settings' }
  }
  return { ok: false, version: null, source: 'none' }
}

// ---------------------------------------------------------------------------
// Filesystem operations (detect / apply / check / revert)
// ---------------------------------------------------------------------------

/** Locates the patch target the same way the fork does: the checkout root
 *  itself, or a ComfyUI/ subdirectory (a workspace-style clone). */
function findPatchTarget(checkoutPath: string, patch: EnginePatch): string | null {
  for (const root of [resolve(checkoutPath), join(resolve(checkoutPath), 'ComfyUI')]) {
    const target = join(root, patch.targetFile)
    if (existsSync(target)) return target
  }
  return null
}

export type PatchCheck = {
  id: string
  label: string
  /** Present-state of the target file. */
  layout: PatchLayout | 'missing'
  /** sha256 of the target text — the recorded layout fingerprint (what a
   *  later --check compares to detect an upstream overwrite). */
  fingerprint: string | null
  versionGate: PatchVersionGate
  backupPresent: boolean
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The --check: everything a launch decision needs, no writes anywhere. */
export async function checkEnginePatch(patch: EnginePatch, checkout: string, fallbackVersion?: string): Promise<PatchCheck> {
  const target = findPatchTarget(checkout, patch)
  const versionGate = await versionGateFor(checkout, patch, fallbackVersion)
  if (!target) {
    return { id: patch.id, label: patch.label, layout: 'missing', fingerprint: null, versionGate, backupPresent: false }
  }
  const text = await readFile(target, 'utf8')
  return {
    id: patch.id,
    label: patch.label,
    layout: detectPatchLayout(text),
    fingerprint: await sha256(text),
    versionGate,
    backupPresent: existsSync(`${target}${patch.backupSuffix}`),
  }
}

export type PatchApplyResult = {
  applied: boolean
  already?: boolean
  layout: PatchLayout | 'missing'
  validation: 'python-ast' | 'structural' | 'none'
  backup?: string
  reason?: string
}

export type ApplyOptions = {
  /** Python executable to ast-validate with (the launch command itself). */
  pythonCommand?: string
}

/** Applies the patch under the full discipline. Returns applied:false with a
 *  reason for every refusal — the target is untouched in every one of those
 *  cases. */
export async function applyEnginePatch(patch: EnginePatch, checkout: string, options: ApplyOptions = {}): Promise<PatchApplyResult> {
  const target = findPatchTarget(checkout, patch)
  if (!target) return { applied: false, layout: 'missing', validation: 'none', reason: `target file not found under the checkout (${patch.targetFile})` }
  const text = await readFile(target, 'utf8')
  const layout = detectPatchLayout(text)
  if (layout === 'patched') return { applied: false, already: true, layout, validation: 'none' }
  if (layout === 'unknown') {
    return { applied: false, layout, validation: 'none', reason: 'could not safely locate the known MiniMax-H3 block loop in this ComfyUI build; no file was changed' }
  }

  const transformed = transformPatchedText(text)
  if (!transformed.ok) return { applied: false, layout, validation: 'none', reason: transformed.reason }
  const structural = structuralBalance(transformed.text)
  if (!structural.ok) {
    return { applied: false, layout, validation: 'structural', reason: `candidate failed structural validation (${structural.problem}); no file was changed` }
  }

  // Stage the candidate beside the target, validate it with the real Python
  // parser when we can, and only then commit (temp+rename, both writes).
  const staged = `${target}.studio-tmp`
  await writeFile(staged, transformed.text, 'utf8')
  let validation: PatchApplyResult['validation'] = 'structural'
  const pythonCommand = options.pythonCommand?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  // The ast gate only runs through an interpreter that IS python — a
  // non-python command answering (a stub, a misconfigured path) is not a
  // parse verdict, and treating it as one would refuse valid candidates.
  if (looksLikePython(pythonCommand)) {
    const ast = await runPythonAstCheck(pythonCommand, staged)
    if (ast.ok) {
      validation = 'python-ast'
    } else if (!ast.interpreterMissing) {
      // An interpreter answered and REJECTED the candidate — a hard refusal.
      await unlink(staged).catch(() => undefined)
      return { applied: false, layout, validation: 'python-ast', reason: `candidate failed python ast.parse (${ast.error}); no file was changed` }
    }
    // interpreterMissing: no usable interpreter — the always-on structural
    // check already passed; proceed with validation: 'structural'.
  }

  // Pristine backup refresh: this path only runs on an UNPATCHED target, so
  // the saved copy is pristine even after a ComfyUI update overwrote the
  // file (ported exactly from the fork's installer). A failed commit cleans
  // the staged file — never a stray temp beside the target.
  const backup = `${target}${patch.backupSuffix}`
  try {
    await atomicWrite(backup, text)
    await rename(staged, target)
  } catch (commitFailure) {
    await unlink(staged).catch(() => undefined)
    throw commitFailure
  }
  return { applied: true, layout, validation, backup }
}

export type PatchRevertResult = { reverted: boolean; reason?: string }

/** --revert: restores the pristine backup. Refuses on a missing or empty
 *  backup (ported), and on a backup that fails structural validation. */
export async function revertEnginePatch(patch: EnginePatch, checkout: string): Promise<PatchRevertResult> {
  const target = findPatchTarget(checkout, patch)
  if (!target) return { reverted: false, reason: `target file not found under the checkout (${patch.targetFile})` }
  const backup = `${target}${patch.backupSuffix}`
  if (!existsSync(backup)) return { reverted: false, reason: `no backup found at ${patch.backupSuffix}` }
  const saved = await readFile(backup, 'utf8')
  if (!saved.trim()) return { reverted: false, reason: `the backup at ${patch.backupSuffix} is empty; refusing to restore` }
  const structural = structuralBalance(saved)
  if (!structural.ok) return { reverted: false, reason: `the backup failed structural validation (${structural.problem}); refusing to restore` }
  await atomicWrite(target, saved)
  return { reverted: true }
}

/** Same-directory temp + rename: a kill mid-write can never leave a partial
 *  or empty file behind (the fork's _atomic_write, ported). */
async function atomicWrite(target: string, text: string): Promise<void> {
  const staged = `${target}.studio-tmp`
  await writeFile(staged, text, 'utf8')
  await rename(staged, target)
}
