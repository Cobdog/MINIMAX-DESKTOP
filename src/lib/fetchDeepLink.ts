/**
 * Missing-dependency → fetch-catalog mapping (QOL wave, rrxlw2r, 2026-09-18;
 * the approved nits item idg8ui4): when an option row is unavailable because
 * weights or node packs are missing, the guidance deep-links into the
 * FetchBrowser with the satisfying entries pre-highlighted. Missing pieces
 * WITHOUT a catalog entry get the honest "install manually" wording instead
 * (see options.ts) — this module is the single place that decides which is
 * which.
 *
 * Safety: every mapped id is intersected with the LIVE catalog at call time —
 * a stale or wrong id in the tables below simply never surfaces (no dead
 * links), and entries already on disk ('present'/'placed') are never offered:
 * the missing piece is then something else, and fetching it again would not
 * fix the row.
 *
 * The consent flow is untouched by design: the deep-link OPENS the browser on
 * the entry; the fetch itself still goes through its own consent dialog.
 */
import { KJNODES_USED, LTXVIDEO_NODES, RADIANCE_NODES } from './graph/ltx23'
import type { FetchEntryStatus } from '../types'

export type FetchTarget = { id: string; name: string }

/** LTX-2.3 model-selection slots (keyof Ltx23ModelSelection) → the fetch
 * catalog entries that satisfy them (ids from server/fetchCatalog.ts — an
 * intersection with the live catalog, so drift here degrades to "no link",
 * never a broken one). Multiple ids = legitimate alternatives (official /
 * fp8 / community cuts). Dated: 2026-09-18. */
const SLOT_CATALOG: Record<string, string[]> = {
  checkpoint: ['ltx23-dev-checkpoint', 'ltx23-dev-fp8'],
  transformer: ['ltx23-kijai-transformer'],
  textEncoder: ['ltx23-gemma-encoders'],
  textProjection: ['ltx23-kijai-projection'],
  videoVae: ['ltx23-kijai-vaes'],
  audioVae: ['ltx23-kijai-vaes'],
  latentUpscaler: ['ltx23-latent-upscaler'],
  distilledLora: ['ltx23-distilled-loras', 'ltx23-distilled-rank111'],
  subtitlesRemoveLora: ['ltx23-icedit-remove-pair'],
  watermarkRemoveLora: ['ltx23-icedit-remove-pair'],
  archivalLora: ['ltx23-dearchive'],
  obscuraLora: ['ltx23-obscura-remova'],
  outpaintLora: ['ltx23-ic-outpaint'],
}

/** Node class → the node-pack catalog entry that ships it. Ownership is
 * single-sourced from the constants in src/lib/graph/ltx23.ts (their header
 * documents which pack each node family lives in — all three are fetch
 * catalog `pack:` entries assembled from ENGINE_NODE_PACKS). */
const NODE_PACK: Record<string, string> = {}
for (const node of LTXVIDEO_NODES) NODE_PACK[node] = 'pack:ltxvideo'
for (const node of KJNODES_USED) NODE_PACK[node] = 'pack:kjnodes'
for (const node of RADIANCE_NODES) NODE_PACK[node] = 'pack:radiance'

/** An entry is fetch-offerable only when nothing is on disk yet. */
function fetchable(entry: FetchEntryStatus | undefined): boolean {
  return Boolean(entry) && (entry!.state === 'absent' || entry!.state === 'cached')
}

/** The catalog entries that would satisfy the given missing slots + node
 * classes, in catalog order (stable UI). Empty when the catalog is not
 * loaded or nothing fetchable covers the gap → "install manually". */
export function fetchTargetsForMissing(
  missing: { slots: ReadonlyArray<string>; nodes: ReadonlyArray<string> },
  catalog: ReadonlyArray<FetchEntryStatus> | null | undefined,
): FetchTarget[] {
  if (!catalog || catalog.length === 0) return []
  const byId: Record<string, FetchEntryStatus> = {}
  for (const entry of catalog) byId[entry.id] = entry
  const wanted: Record<string, boolean> = {}
  for (const slot of missing.slots) {
    const ids = SLOT_CATALOG[slot]
    if (!ids) continue
    for (const id of ids) if (fetchable(byId[id])) wanted[id] = true
  }
  for (const node of missing.nodes) {
    const id = NODE_PACK[node]
    if (id && fetchable(byId[id])) wanted[id] = true
  }
  const ordered: FetchTarget[] = []
  for (const entry of catalog) {
    if (wanted[entry.id]) ordered.push({ id: entry.id, name: entry.name })
  }
  return ordered
}
