/**
 * Preflight remediation rows (remediation R-17, Wave 3 — tg52kaq): the
 * R-02 refusal's missing-class list as ONE-ACTION-PER-ROW remediation data.
 *
 * The audit's finding: every automation piece existed (the class→pack map,
 * the consent-gated fetcher with auto-install, the live chip) but was
 * unassembled at the point of need — the burden sat on prose-reading. This
 * module is the assembly point as PURE DATA over the SAME registries the
 * Settings board renders (nodePackRegistry + the fetch catalog's pack
 * entries): the RemediationDock renders the rows, the Settings board stays
 * the audit/override view.
 *
 * Row semantics (the per-item consent contract):
 *   fetch   — a user-fetch pack row: the Library surface opens focused on
 *             its catalog entry; the license verdict is stated ON the row
 *             and the consent dialog is the fetcher's own explicit step.
 *   install — a vendored/first-party payload: installs from the studio's
 *             own tree, NO network (the row says so — that is the consent:
 *             there is nothing else to consent to).
 *   stock   — a stock ComfyUI class the instance does not serve: nothing to
 *             fetch; the advice is update-ComfyUI (the graph-compat view).
 *   unknown — a class no registry row provides: the honest dead end with
 *             the restart note (a pack the engine has not loaded yet).
 */
import type { MissingNodeClass } from './preflight'
import { ENGINE_NODE_PACKS } from './nodePackRegistry'

export type RemediationAction =
  | { kind: 'fetch'; packId: string; packName: string; licenseSpdx: string; catalogEntryId: string }
  | { kind: 'install'; packId: string; packName: string; note: string }
  | { kind: 'stock'; className: string }
  | { kind: 'unknown'; className: string }

export type RemediationRow = {
  /** The class the render needs. */
  className: string
  /** One-line state of the world for this row. */
  label: string
  /** Exactly one action (or none, for the honest dead ends). */
  action: RemediationAction
}

/** One row per missing class (deduplicated — preflight already dedupes;
 *  multiple classes of one pack collapse into per-class rows sharing the
 *  pack's action; the dock renders them grouped by pack). */
export function remediationRows(missing: MissingNodeClass[]): RemediationRow[] {
  const rows: RemediationRow[] = []
  for (const item of missing) {
    if (item.packId) {
      const pack = ENGINE_NODE_PACKS.find((entry) => entry.id === item.packId)
      if (!pack) {
        rows.push({ className: item.className, label: `the registry names the ${item.packId} pack but it is not in the catalog`, action: { kind: 'unknown', className: item.className } })
        continue
      }
      if (pack.installMode === 'vendor' || pack.installMode === 'first-party') {
        rows.push({
          className: item.className,
          label: `${pack.name} — install from the studio's own payload (no network, no fetch)`,
          action: { kind: 'install', packId: pack.id, packName: pack.name, note: pack.installMode === 'first-party' ? 'first-party code (MIT) — the studio\'s own node payload' : `vendored at a pinned revision (${pack.licenseSpdx})` },
        })
      } else {
        rows.push({
          className: item.className,
          label: `${pack.name} — fetch with consent (${pack.licenseSpdx})`,
          action: { kind: 'fetch', packId: pack.id, packName: pack.name, licenseSpdx: pack.licenseSpdx, catalogEntryId: `pack:${pack.id}` },
        })
      }
      continue
    }
    if (item.stock) {
      rows.push({ className: item.className, label: 'a stock ComfyUI node this engine does not serve — update ComfyUI', action: { kind: 'stock', className: item.className } })
      continue
    }
    rows.push({ className: item.className, label: 'no registry row provides this class — a pack may be installed but not loaded (restart the engine)', action: { kind: 'unknown', className: item.className } })
  }
  return rows
}
