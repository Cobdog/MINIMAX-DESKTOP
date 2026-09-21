import { STOCK_GRAPH_CLASSES } from '../src/lib/preflight'

/** A fake engine's full-coverage object_info (Wave 1 R-02): every STOCK
 *  class the factory graphs can emit, served as the lean bare-object shape
 *  (detection is key-presence only — the rq0lsax lean-instance precedent),
 *  plus the test's own extras (pack classes like MiniMaxH3HybridLoader, or
 *  enum-bearing shapes; later arguments WIN). Submitting fakes serve this
 *  so the R-02 preflight diffs a graph against a registry that could
 *  actually run it — a fake that serves nothing would refuse every render.
 */
export function stockObjectInfo(...extras: Array<Record<string, unknown>>): Record<string, unknown> {
  const info: Record<string, unknown> = {}
  for (const className of STOCK_GRAPH_CLASSES) info[className] = {}
  for (const extra of extras) Object.assign(info, extra)
  return info
}
