import { cwd } from 'node:process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STOCK_GRAPH_CLASSES } from '../src/lib/preflight'

/** A fake engine's full-coverage object_info (Wave 1 R-02): every STOCK
 *  class the factory graphs can emit, served with the REAL captured schemas
 *  from scripts/fixtures/engine-object-info.json (the engine-contract
 *  graduation, task 8dga2dy — a fake that serves synthetic shapes lets a
 *  schema-refusing graph pass e2e and fail on the maintainer's evening; the
 *  T=1 `length: 1` lesson, 2026-09-21), plus the test's own extras (pack
 *  classes like MiniMaxH3HybridLoader, or enum-bearing shapes; later
 *  arguments WIN). Submitting fakes serve this so the R-02 preflight diffs
 *  a graph against a registry that could actually run it — a fake that
 *  serves nothing would refuse every render.
 *
 *  Scope of the real schemas: STOCK classes only. Pack classes stay
 *  extras-driven (call sites already pass `{ MiniMaxH3HybridLoader: {} }`
 *  and their detection lanes expect absence by default). If the fixture is
 *  unreadable (cwd not the repo root, file moved), the explicit fallback is
 *  the Wave-1 lean bare-object shape — key-presence only, the rq0lsax
 *  lean-instance precedent. */
let realSchemasCache: Record<string, unknown> | null = null

function realStockSchemas(): Record<string, unknown> {
  if (realSchemasCache) return realSchemasCache
  let schemas: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(readFileSync(resolve(cwd(), 'scripts/fixtures/engine-object-info.json'), 'utf8'))
    if (raw && typeof raw === 'object' && raw.nodes && typeof raw.nodes === 'object') {
      for (const className of STOCK_GRAPH_CLASSES) {
        const entry = raw.nodes[className]
        if (entry && typeof entry === 'object') schemas[className] = entry
      }
    }
  } catch {
    schemas = {} // explicit fallback: lean bare-object behavior (documented above)
  }
  realSchemasCache = schemas
  return schemas
}

export function stockObjectInfo(...extras: Array<Record<string, unknown>>): Record<string, unknown> {
  const info: Record<string, unknown> = {}
  const real = realStockSchemas()
  for (const className of STOCK_GRAPH_CLASSES) {
    // Real captured schema where the fixture has one; the bare-object floor
    // otherwise — both register the KEY (detection is key-presence only).
    info[className] = real[className] !== undefined ? real[className] : {}
  }
  for (const extra of extras) Object.assign(info, extra)
  return info
}
