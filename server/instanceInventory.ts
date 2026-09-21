/**
 * THE model inventory, registry-only (remediation Wave 2, R-12 — maintainer
 * directive 2987ef3e): the connected ComfyUI instance is the app's ONLY
 * model source of truth. **Instance-invisible = nonexistent** — there is no
 * local scan, no local/instance merge, and no fallback that could feed a
 * graph a file the engine cannot load. The studio asks the instance what it
 * serves and uses exactly that.
 *
 * Two instance surfaces, most-authoritative first:
 *   GET /models            the folder types the instance serves
 *   GET /models/{kind}     the filenames for one folder (subpaths included)
 * Older/leaner instances without the /models routes fall back to the
 * loader-node enums inside /object_info — the same payload the app already
 * consumes for availability detection (UNETLoader.unet_name and friends
 * list exactly the files each folder serves).
 *
 * Everything here is PURE: the HTTP fetches live in core.ts, the parsing is
 * exercised directly by tests/instance.test.js against crafted payloads
 * (the /models response shape is verified against the reference ComfyUI
 * server.py — docs/devdocs/comfyui-api/index.md §4: a JSON array of
 * filename strings, 404 for an unknown folder).
 */
import type { ModelFile, ModelKind } from '../src/types'

/** The folder types the studio tracks (ComfyUI folder names verbatim). */
export const INVENTORY_MODEL_KINDS: readonly ModelKind[] = ['diffusion_models', 'text_encoders', 'vae', 'loras', 'vae_approx', 'clip_vision']

/** Loader-node enums that list a folder's files inside object_info, per
 *  kind. Several kinds have no stock loader node (vae_approx) — those are
 *  /models-endpoint-only. Multiple probes are OR'd: a file any of them
 *  offers is a file the instance serves for that kind. */
const OBJECT_INFO_PROBES: Record<ModelKind, Array<{ node: string; field: string }>> = {
  diffusion_models: [{ node: 'UNETLoader', field: 'unet_name' }],
  text_encoders: [{ node: 'CLIPLoader', field: 'clip_name' }, { node: 'CLIPLoaderGGUF', field: 'clip_name' }],
  vae: [{ node: 'VAELoader', field: 'vae_name' }],
  loras: [{ node: 'LoraLoader', field: 'lora_name' }],
  vae_approx: [],
  clip_vision: [{ node: 'CLIPVisionLoader', field: 'clip_name' }],
}

/** The value shape object_info uses for enum inputs: either
 *  [ ['a','b'], {...} ] (combo) or [ value, { options: [...] } ] — the same
 *  two forms src/lib/comfyInfo.ts's choices() handles; mirrored here so the
 *  server never imports renderer code. */
function enumValues(input: unknown[]): string[] {
  const first = input[0]
  if (Array.isArray(first)) return first.filter((v): v is string => typeof v === 'string')
  const options = (input[1] as { options?: unknown[] } | undefined)?.options
  return options?.filter((v): v is string => typeof v === 'string') ?? []
}

/** Model names per kind, read from a fetched /object_info payload. Unknown
 *  shapes degrade to empty lists — never to a thrown error (an exotic
 *  instance must not blank the whole inventory). */
export function inventoryFromObjectInfo(info: unknown): Record<ModelKind, string[]> {
  const result = emptyInventory()
  if (!info || typeof info !== 'object') return result
  const nodes = info as Record<string, unknown>
  for (const kind of INVENTORY_MODEL_KINDS) {
    const names = new Set<string>()
    for (const probe of OBJECT_INFO_PROBES[kind]) {
      const node = nodes[probe.node]
      if (!node || typeof node !== 'object') continue
      const required = (node as { input?: { required?: Record<string, unknown[]> } }).input?.required
      const input = required?.[probe.field]
      if (Array.isArray(input)) for (const name of enumValues(input)) names.add(name)
    }
    result[kind] = Array.from(names)
  }
  return result
}

/** Parse one fetched /models/{kind} body. The reference server answers a
 *  JSON array of filename strings; anything else (an error object, a string,
 *  a 404 body the caller could not pre-detect) is NOT an inventory — empty
 *  list, so the object_info fallback stays in play. */
export function parseModelsEndpointList(body: unknown): string[] | null {
  if (!Array.isArray(body)) return null
  const names = body.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  return names
}

/** Decide one kind's instance listing: the /models endpoint when the
 *  instance served one (it is folder-truth — files with no loader node
 *  included), else the object_info enums, else nothing. A null/empty
 *  endpoint result never masks a non-empty object_info fallback. */
export function instanceNamesForKind(kind: ModelKind, endpointList: string[] | null, objectInfoNames: string[]): string[] {
  if (endpointList && endpointList.length > 0) return endpointList
  if (endpointList && endpointList.length === 0 && objectInfoNames.length === 0) return []
  return objectInfoNames
}

export function emptyInventory(): Record<ModelKind, string[]> {
  return {
    diffusion_models: [], text_encoders: [], vae: [], loras: [], vae_approx: [], clip_vision: [],
  }
}

/** The instance registry AS the app's whole inventory (R-12): every kind's
 *  resolved listing becomes ModelFile rows, engine-relative names verbatim —
 *  subpaths included, exactly what the graph loaders accept. Rows carry
 *  bytes: 0 (the /models contract reports no sizes — the Settings surface
 *  renders that honestly) and no header-derived tags: the registry lists
 *  filenames only, so nothing about a file's internals is claimed. */
export function registryInventoryFiles(inventory: Record<ModelKind, string[]>): ModelFile[] {
  const files: ModelFile[] = []
  for (const kind of INVENTORY_MODEL_KINDS) {
    for (const name of inventory[kind] ?? []) files.push({ name, kind, bytes: 0 })
  }
  return files.sort((a, b) => a.name.localeCompare(b.name))
}
