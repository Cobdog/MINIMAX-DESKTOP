/**
 * Submit-time graph preflight (remediation Wave 1, R-02 — audit C F2).
 *
 * The built graph's class_types are diffed against the connected engine's
 * object_info BEFORE the prompt is submitted: a render that needs a class
 * the instance does not serve refuses at the studio with a readable,
 * action-mapped list — never a mangled engine 400 after the fact (that
 * failure class is R-03's to make readable; this makes the common case not
 * happen at all).
 *
 * Pure and engine-free by design (VM-harness testable): the graph and the
 * object_info snapshot arrive as data. The class → pack row mapping reads
 * the SAME registry the server's node-pack board renders
 * (nodePackRegistry.ts) — one source of truth.
 */
import type { ObjectInfo } from './comfyInfo'
import { dbg } from './dbg'
import { ENGINE_NODE_PACKS } from './nodePackRegistry'
import type { ComfyPrompt } from './graph'

/** Stock ComfyUI classes our factory graphs can emit (workflow.ts + the
 *  optimization registry's entries + the audio/workbench builders). A
 *  missing STOCK class means the instance's ComfyUI itself is older than
 *  the graph — the advice says UPDATE COMFYUI, not install a pack. Family
 *  classes (MiniMax H3 native nodes) are stock since ComfyUI's H3 release;
 *  PACK classes (the hybrid loader, the turbo pair, the form adapter, the
 *  Motion-Context set, the LBH upscalers) are deliberately NOT here — they
 *  map to their registry pack rows (or the generic advice) instead. */
export const STOCK_GRAPH_CLASSES: readonly string[] = [
  // workflow.ts H3 video base + loaders + save tail
  'UNETLoader', 'CLIPLoader', 'DualCLIPLoader', 'VAELoader', 'LoraLoaderModelOnly',
  'LoadImage', 'LoadVideo', 'LoadAudio', 'GetVideoComponents',
  'MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo', 'MiniMaxH3AddGuide', 'MiniMaxH3SigmaShift',
  'RandomNoise', 'BasicGuider', 'CFGGuider', 'KSamplerSelect', 'BasicScheduler', 'SamplerCustomAdvanced',
  'VAEDecode', 'VAEDecodeTiled', 'VAEDecodeAudio', 'VAEDecodeAudioTiled', 'VAEEncode',
  'CreateVideo', 'SaveVideo', 'SaveImage', 'SaveAudioAdvanced', 'ImageFromBatch', 'PreviewImage',
  // upscale registry entries (the RTX path — stock; LBH is a pack)
  'UpscaleModelLoader', 'ImageUpscaleWithModel', 'ImageScale', 'ImageScaleToTotalPixels',
  'SplitSigmas', 'ManualSigmas', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent',
  // h3image workbench stock classes (the hybrid loader is the h3-hybrid-loader PACK)
  'ReferenceLatent', 'ConditioningZeroOut', 'CLIPTextEncode', 'KSampler',
  'GetImageSize', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'ModelSamplingAuraFlow',
  // krea2 edit t2i canvas (stock since ComfyUI's SD3 nodes; found missing from
  // this list by the engine-contract fixture's coverage walk, 8dga2dy)
  'EmptySD3LatentImage',
  // the music3 audio engine (native ComfyUI music nodes; the acestep classes
  // went with the ACE-Step cut, 2026-09-21 — nn5ld47)
  'EmptyMiniMaxMusic3LatentAudio', 'MiniMaxMusic3TextEncode',
]

const STOCK_SET: ReadonlySet<string> = new Set(STOCK_GRAPH_CLASSES)

/** The studio's CORE render classes (R-29, audit C F7) — the compact set a
 * healthy engine must serve for the canonical render paths to work AT ALL:
 * the H3 video natives (stock since ComfyUI's H3 release), the advanced
 * sampler ladder they run on, and the music3 audio natives. An instance
 * missing these is older than the studio's graphs — it passes file-based
 * checks and fails only at render. Loaders and ancient stock are deliberately
 * NOT here: the check stays a tight signal, not a stock-class census. The
 * family tag scopes the check (the doctor asks for everything; the H3 stack
 * report asks only for the h3-video family — music3 readiness is not the H3
 * stack's verdict). */
export const CORE_RENDER_CLASSES: readonly { className: string; family: 'h3-video' | 'audio' }[] = [
  { className: 'MiniMaxH3ImageToVideo', family: 'h3-video' },
  { className: 'MiniMaxH3ReferenceToVideo', family: 'h3-video' },
  { className: 'KSamplerSelect', family: 'h3-video' },
  { className: 'SamplerCustomAdvanced', family: 'h3-video' },
  { className: 'EmptyMiniMaxMusic3LatentAudio', family: 'audio' },
  { className: 'MiniMaxMusic3TextEncode', family: 'audio' },
]

/** Which core render classes one object_info snapshot does not serve, in the
 * same action-mapped shape as the submit-time preflight (stock classes get
 * the update-ComfyUI advice through preflightRefusal). Pass a family to
 * scope the check; undefined asks for every core class. An ABSENT or EMPTY
 * snapshot means "no registry data" — the check stays silent (the connection
 * rung owns that refusal), exactly like preflightGraph. */
export function missingCoreNodeClasses(info: ObjectInfo | Record<string, unknown> | undefined, family?: 'h3-video' | 'audio'): MissingNodeClass[] {
  if (!info || typeof info !== 'object' || Object.keys(info).length === 0) return []
  const missing: MissingNodeClass[] = []
  for (const entry of CORE_RENDER_CLASSES) {
    if (family && entry.family !== family) continue
    if (info[entry.className] !== undefined) continue
    const packId = CLASS_TO_PACK.get(entry.className)
    missing.push({ className: entry.className, ...(packId ? { packId } : {}), stock: STOCK_SET.has(entry.className) })
  }
  return missing
}

/** Class → pack row (any-match is the pack board's own detection rule). */
const CLASS_TO_PACK: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const pack of ENGINE_NODE_PACKS) {
    for (const className of pack.instanceNodeClasses) map.set(className, pack.id)
  }
  return map
})()

export type MissingNodeClass = {
  className: string
  /** The registry pack that provides this class, when one does. */
  packId?: string
  /** True when this is a stock ComfyUI class our factories emit — a missing
   *  one means the instance's ComfyUI is too old, not that a pack is absent. */
  stock: boolean
}

/** Diffs one built graph against one object_info snapshot. A class the
 *  instance does not serve (key absent) is MISSING — shape-tolerant on the
 *  info side exactly like comfyInfo.choices (an exotic instance serving a
 *  bare object still counts as serving the class). An ABSENT or EMPTY
 *  snapshot means "no registry data" (engine never served it, test fakes):
 *  preflight stays silent rather than refusing everything — the
 *  connection/readiness rungs own that refusal. */
export function preflightGraph(graph: ComfyPrompt | Record<string, { class_type: string }>, info: ObjectInfo | Record<string, unknown> | undefined): MissingNodeClass[] {
  if (!info || typeof info !== 'object' || Object.keys(info).length === 0) return []
  const seen = new Set<string>()
  const missing: MissingNodeClass[] = []
  for (const node of Object.values(graph)) {
    const className = node?.class_type
    if (typeof className !== 'string' || !className || seen.has(className)) continue
    seen.add(className)
    if (info[className] !== undefined) continue
    const packId = CLASS_TO_PACK.get(className)
    missing.push({ className, ...(packId ? { packId } : {}), stock: STOCK_SET.has(className) })
  }
  missing.sort((a, b) => (a.packId === b.packId ? a.className.localeCompare(b.className) : (a.packId ?? '').localeCompare(b.packId ?? '')))
  return missing
}

/** The readable, action-mapped refusal for a missing-class list. Null when
 *  the list is empty (the render may proceed). */
export function preflightRefusal(missing: MissingNodeClass[]): string | null {
  if (!missing.length) return null
  const lines: string[] = []
  for (const item of missing.slice(0, 6)) {
    if (item.packId) {
      const pack = ENGINE_NODE_PACKS.find((entry) => entry.id === item.packId)
      const how = pack?.installMode === 'vendor' || pack?.installMode === 'first-party' ? 'install it from Settings → Node packs (no network needed)' : `fetch or install it from Settings → Node packs (${pack?.name ?? item.packId})`
      lines.push(`${item.className} — the ${pack?.name ?? item.packId} pack is not active on this engine; ${how}, then restart ComfyUI if you installed it yourself.`)
    } else if (item.stock) {
      lines.push(`${item.className} — a stock ComfyUI node this engine does not serve; your ComfyUI install is older than this graph needs. Update ComfyUI, then refresh the connection.`)
    } else {
      lines.push(`${item.className} — not in this engine's node registry; the node pack that provides it is missing (or the engine needs a restart to load it).`)
    }
  }
  if (missing.length > 6) lines.push(`(+${missing.length - 6} more missing node classes)`)
  return `The engine is missing ${missing.length === 1 ? 'a node class' : `${missing.length} node classes`} this render needs — nothing was submitted:\n${lines.map((line) => `• ${line}`).join('\n')}`
}

/** Fired with the missing-class payload whenever a submit-time preflight
 *  refuses (R-17, Wave 3): the RemediationDock listens and opens the
 *  per-item-consented remediation surface — the refusal toast stays the
 *  immediate feedback, the panel is the action surface. Window-guarded so
 *  the VM harness stays silent. */
export const PREFLIGHT_REFUSAL_EVENT = 'minimax:preflight-refusal'

/** The submit-core seam: run the diff, log the junction, refuse loudly.
 *  Returns the refusal message or null. */
export function preflightOrFail(graph: ComfyPrompt | Record<string, { class_type: string }>, info: ObjectInfo | Record<string, unknown> | undefined, junction = 'preflight'): string | null {
  const missing = preflightGraph(graph, info)
  if (!missing.length) {
    dbg(junction, { verdict: 'pass', classes: Object.keys(graph).length })
    return null
  }
  dbg(junction, { verdict: 'refuse', missing: missing.map((item) => item.className) })
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try { window.dispatchEvent(new CustomEvent(PREFLIGHT_REFUSAL_EVENT, { detail: { missing } })) } catch { /* never block the refusal on the surface */ }
  }
  return preflightRefusal(missing)
}
