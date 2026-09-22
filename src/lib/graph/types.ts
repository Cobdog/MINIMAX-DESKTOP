/** Core types of the graph factory + optimization registry.
 *
 * A ComfyUI prompt graph is a plain JSON object of nodes keyed by stable
 * string ids; a link is `[nodeId, outputSlot]`. The registry's whole contract
 * hangs on these staying plain data — graphs must serialize deterministically
 * (integer-like key ids keep their numeric sort in JSON.stringify) so the
 * inertness probe can compare golden snapshots byte-for-byte. */
import type { ObjectInfo } from '../comfyInfo'
import type { GenerationOptions, ModelFile } from '../../types'

export type Link = [string, number]
export type ComfyNode = { class_type: string; inputs: Record<string, string | number | boolean | Link> }
export type ComfyPrompt = Record<string, ComfyNode>

/** Engines a registry entry can apply to. The factory only exposes the seam
 * points an engine declares; today only the MiniMax H3 builder is
 * registry-wired, the list exists so future builders adopt the same entries. */
export type EngineId = 'minimax' | 'music3'

/** Factory chain points an entry may insert at. This is the insert-only
 * contract: transforms append nodes at a declared seam and re-point only the
 * factory's own consumers there — they never rewrite foreign nodes. */
export type WrapPoint = 'modelChain' | 'conditioning' | 'decode' | 'sampler' | 'output'

export type DetectionResult = {
  available: boolean
  /** The concrete model file that satisfies the entry, when one is needed. */
  model?: string
  /** Required engine node classes that are absent (install guidance data). */
  missingNodes?: string[]
  /** Optional node-pack enhancements detected on the engine. Availability
   * never depends on these — they only change HOW an entry renders. */
  packs?: { larryvrhTurbo?: boolean }
}

/** Which loader and sampler nodes a turbo render will use. `plain` is the
 * stock LoraLoaderModelOnly + KSamplerSelect path (the community-reported
 * quality path); `dedicated` swaps in the larryvrh
 * ComfyUI-MiniMax-H3-Turbo pack (MiniMaxH3TurboLoRA MODEL→MODEL and
 * MiniMaxH3TurboSampler →SAMPLER) when that pack is installed. */
export type TurboLoaderChoice = 'auto' | 'plain'

export type TurboPlan = {
  entryId: string
  loraName: string
  strength: number
  steps: number
  loader: 'plain' | 'dedicated'
  /** Pack sampler node class that replaces KSamplerSelect (dedicated only). */
  samplerNode?: string
}

/** Facts a transform may read. Built by the factory; entries never reach back
 * into the builder's options object. */
export type TransformOptions = {
  mode: GenerationOptions['mode']
  width: number
  height: number
  duration: number
  filenamePrefix: string
  turbo: GenerationOptions['turbo']
  steps: number
  frameCount: number
  loraStrength?: number
  turboPlan?: TurboPlan
  upscale?: GenerationOptions['upscale']
  previewOverride?: GenerationOptions['previewOverride']
  experimentalSampling?: boolean
  info?: ObjectInfo
}

/** The registry entry schema. Adding an optimization = adding one entry to
 * `src/lib/graph/entries/*` and registering it — no factory changes. See
 * docs/architecture.md "Optimization registry". */
export type OptimizationEntry = {
  id: string
  label: string
  kind: 'turbo' | 'acceleration' | 'upscale' | 'preview'
  appliesTo: EngineId[]
  /** Where in the factory's chain this entry inserts. */
  wraps: WrapPoint
  /** Filename patterns (checked in registry order, first match wins) that
   * classify a LoRA file as this family. Turbo entries only. */
  patterns?: RegExp[]
  /** Declared sampler pairing contract; the factory enforces it unless the
   * user opted into experimental sampling. */
  pairing?: {
    sampler?: string
    scheduler?: string
    /** Node class that replaces KSamplerSelect when its pack is installed. */
    samplerNode?: string
    steps?: number
  }
  detect(info: ObjectInfo | undefined, files: ModelFile[]): DetectionResult
  transform(graph: ComfyPrompt, ctx: GraphContext, opts: TransformOptions): void
  /** `note` = the measured-basis provenance line shown next to a selection
   * (e.g. a family that is a tier default by measurement says so, with the
   * measurement date). Optional; most families have none. */
  ui: { description: string; warning?: string; installHint?: string; note?: string }
}

/** Role-addressed node map + chain-wrap helpers for one graph build. Built by
 * `createGraphContext`; transforms address nodes by ROLE ('samplerSelect'),
 * never by raw id string, so id policy stays a factory concern. */
export type GraphContext = {
  readonly graph: ComfyPrompt
  /** Facts the factory computed (frames, stage steps, …) — read-only for transforms. */
  readonly params: Record<string, string | number | boolean>
  /** Records role → node id. Throws on rebinding a role to a different id. */
  bind(role: string, id: string): void
  /** Node id for a role; undefined when the role is absent from this build. */
  id(role: string): string | undefined
  /** `[id(role), slot]`; throws when the role is unbound. */
  link(role: string, slot?: number): Link
  /** Current MODEL-chain tail the next model-wrap must consume. */
  modelLink(): Link
  /** Inserts `node` after the current model tail and rebinds `role` to it.
   * INSERT-ONLY: the previous tail keeps existing; consumers created after the
   * wrap see the new tail. */
  wrapModel(role: string, id: string, node: ComfyNode): Link
}

export function createGraphContext(graph: ComfyPrompt, unetId: string, params: Record<string, string | number | boolean> = {}): GraphContext {
  const roles: Record<string, string> = {}
  let modelTail: Link = [unetId, 0]
  const ctx: GraphContext = {
    graph,
    params,
    bind(role, id) {
      if (roles[role] !== undefined && roles[role] !== id) throw new Error(`graph role '${role}' already bound to node '${roles[role]}' (rebinding to '${id}' would rewrite the factory chain)`)
      roles[role] = id
    },
    id(role) {
      return roles[role]
    },
    link(role, slot = 0) {
      const id = roles[role]
      if (id === undefined) throw new Error(`graph role '${role}' is not bound in this build`)
      return [id, slot]
    },
    modelLink() {
      return [modelTail[0], modelTail[1]]
    },
    wrapModel(role, id, node) {
      if (graph[id] !== undefined) throw new Error(`graph node '${id}' already exists (transforms are insert-only)`)
      node.inputs.model = [modelTail[0], modelTail[1]]
      graph[id] = node
      modelTail = [id, 0]
      ctx.bind(role, id)
      return [id, 0]
    },
  }
  return ctx
}
