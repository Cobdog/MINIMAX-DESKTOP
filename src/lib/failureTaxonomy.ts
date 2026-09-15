/**
 * Failure taxonomy: maps a structural failure reason (node id/class + the
 * SANITIZED exception text that already passed through logSanitize) to a
 * human cause bucket. The doctrine is "we care that it failed on a node
 * because of a comma — not what they asked for"; this module adds the last
 * mile: which KNOWN cause class that node/reason pair belongs to, so the
 * Queue and the diagnostic report can say "GPU memory exhausted — see the
 * VRAM tier guidance", not just a traceback.
 *
 * Pure and dependency-free by design (loads in the repo's VM-transpiled
 * unit-test harness). Matching is case-insensitive over the structural
 * fragments the sanitizer keeps (class names, error kinds, numbers) — never
 * over free-form prose, which is already [redacted] by the time it arrives.
 */

/** Stable bucket ids — the report's failure histogram counts by these. */
export type FailureBucketId =
  | 'out-of-memory'
  | 'engine-unreachable'
  | 'timeout'
  | 'node-missing'
  | 'validation'
  | 'output-missing'
  | 'cancelled'
  | 'unknown'

export type FailureBucket = {
  id: FailureBucketId
  /** Short label for the histogram + queue rows. */
  label: string
  /** The human cause — what to DO about this class of failure. */
  cause: string
}

export const FAILURE_BUCKETS: Record<FailureBucketId, FailureBucket> = {
  'out-of-memory': {
    id: 'out-of-memory',
    label: 'GPU memory exhausted',
    cause: 'The engine ran out of VRAM mid-render. Lower resolution or duration, use a smaller quant of the diffusion model, or let the automatic engine-reset + tiled-VAE retry absorb it — see the GPU tier guidance in Settings.',
  },
  'engine-unreachable': {
    id: 'engine-unreachable',
    label: 'Engine unreachable',
    cause: 'The generation engine was not reachable. Verify ComfyUI is running (or the managed engine started) and re-check the connection in Settings.',
  },
  timeout: {
    id: 'timeout',
    label: 'Timed out or hit the deadline',
    cause: 'The render exceeded its time budget — the engine may have stalled or is queueing behind other work. Check the engine queue before retrying.',
  },
  'node-missing': {
    id: 'node-missing',
    label: 'Custom node missing',
    cause: 'A node class this graph needs is not installed on this engine (or a ComfyUI update renamed it). Install or refresh the node pack, then re-run the H3 Quality Test in Settings.',
  },
  validation: {
    id: 'validation',
    label: 'Graph validation rejected',
    cause: 'The engine rejected the graph before rendering — typically a sampler/model value this engine build does not offer, or an updated node changed its inputs. The Graph compatibility row in Settings explains version drift.',
  },
  'output-missing': {
    id: 'output-missing',
    label: 'Output never appeared',
    cause: 'The render reported completion but its file never landed in the output directory — a slow disk or an output-path mismatch, not a generation failure.',
  },
  cancelled: {
    id: 'cancelled',
    label: 'Cancelled',
    cause: 'The generation was cancelled by request.',
  },
  unknown: {
    id: 'unknown',
    label: 'Unclassified',
    cause: 'No known cause class matched. The structural reason above is what the engine reported.',
  },
}

/** Ordered matchers over SANITIZED structural text. First match wins; the
 *  most specific classes sit above their generic parents (a CUDA OOM is an
 *  out-of-memory failure, not a generic runtime error). */
const MATCHERS: Array<{ id: FailureBucketId; pattern: RegExp }> = [
  { id: 'out-of-memory', pattern: /\b(oom|outofmemoryerror|memoryerror|out of memory|cuda out of memory|allocat\w* (?:memory|vram)|vram)\b/i },
  { id: 'engine-unreachable', pattern: /\b(econnrefused|connection refused|fetch failed|not reachable|unreachable|offline|econnreset|socket hang up)\b/i },
  { id: 'timeout', pattern: /\b(timeout|timed out|deadline|still rendering after)\b/i },
  { id: 'node-missing', pattern: /\b(returned type missing|missing node|is not a registered|node type not found|cannot find module|no module named|importerror|modulenotfounderror)\b/i },
  { id: 'validation', pattern: /\b(validation|value not in list|required input|invalid (?:value|prompt)|node errors|returned error)\b/i },
  { id: 'output-missing', pattern: /\b(output file never appeared|no output|completed but)\b/i },
  { id: 'cancelled', pattern: /\b(cancelled|canceled|interrupted|aborted)\b/i },
]

/** Classifies one structural failure into a bucket. `text` is the already
 *  sanitized reason (or the job's error message); unknown text lands in
 *  'unknown' — never a crash, never a guess beyond the ordered matchers. */
export function classifyFailure(text: string): FailureBucket {
  if (typeof text === 'string' && text.length > 0) {
    for (let index = 0; index < MATCHERS.length; index += 1) {
      if (MATCHERS[index].pattern.test(text)) return FAILURE_BUCKETS[MATCHERS[index].id]
    }
  }
  return FAILURE_BUCKETS.unknown
}
