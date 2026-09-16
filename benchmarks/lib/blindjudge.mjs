// Blind-judge arm (AC: each suite emits a sealed-mapping vision bundle as the
// standard perceptual arm). The bundle reuses the repo's vision-harness shapes
// (manifest.json / verdicts.json / JUDGE protocol) so `pnpm vision:report
// <bundle>` gates it unchanged, with the benchmark additions:
//   - candidates are LETTERED (P/Q/R/S...); the letter->candidate mapping is
//     sealed in sealed-mapping.json and must NOT be read before the judgment
//     is recorded
//   - each checkpoint carries the SUITE's rubric (not a UI rubric)
//   - after judgment, `--unblind <bundle>` writes the perceptual row into the
//     results registry
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { nowIso, REPO_ROOT } from './util.mjs'

export const LETTERS = ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W']

/** Emit a vision-compatible bundle from a run's blind artifacts.
 * inputs: { suite, runId, items: [{label, candidateId, image}], rubricText }
 * The image files are copied in as <runId>--blind-<label>.png (unique names by
 * design — the vision harness reads them natively, never cached). */
export function emitBundle({ suite, runId, items, rubricText, outRoot }) {
  if (!items?.length) throw new Error('blind bundle needs at least one item')
  const bundleDir = path.join(outRoot, `${runId}`)
  fs.mkdirSync(bundleDir, { recursive: true })
  // deterministic-but-unpredictable letter assignment
  const shuffled = [...items]
  const rng = crypto.randomInt.bind(crypto) // seed-free: sealed per emission
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = rng(0, i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const mapping = {}
  const checkpoints = []
  shuffled.forEach((item, idx) => {
    const letter = LETTERS[idx] ?? `X${idx}`
    mapping[letter] = item.candidateId
    const image = `${runId}--blind-${letter}${path.extname(item.image) || '.png'}`
    fs.copyFileSync(item.image, path.join(bundleDir, image))
    checkpoints.push({
      id: `blind-${letter}`,
      image,
      label: `Candidate ${letter} — ${suite} blind quality read (identity unknown)`,
      rubric: rubricText,
    })
  })
  const manifest = {
    runId,
    createdAt: nowIso(),
    kind: 'benchmark-blind-judge',
    suite,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    scenarios: [{ id: suite, checkpoints }],
  }
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  // the sealed mapping lives in the bundle but the judge is forbidden to read it
  fs.writeFileSync(path.join(bundleDir, 'sealed-mapping.json'), JSON.stringify(mapping, null, 2))
  fs.writeFileSync(path.join(bundleDir, 'JUDGE-INSTRUCTIONS.md'),
    judgeInstructions(suite, rubricText, bundleDir), 'utf8')
  return { bundleDir, manifest, mapping }
}

function judgeInstructions(suite, rubricText, bundleDir) {
  return [
    `# Blind judgment — ${suite} benchmark bundle`,
    '',
    'Read the rubric below; apply it to EVERY checkpoint image in manifest.json.',
    'Protocol (hard constraints):',
    '- NEVER read sealed-mapping.json (or any file that names candidates) before',
    '  your verdicts are written. If you accidentally learn a mapping, say so in',
    '  the verdict notes and stop — the bundle must be re-emitted.',
    '- Write verdicts.json in exactly the shape scripts/vision-e2e/JUDGE.md',
    '  defines (two-pass rule on fails, confidence, issues[]).',
    `- After judgment, the orchestrator unblinds with: node benchmarks/run.mjs --unblind ${bundleDir}`,
    '',
    '## Rubric',
    '',
    rubricText,
    '',
    '## Additional benchmark honesty rules',
    '',
    '- Rank relative to the OTHER labeled candidates in this bundle when the',
    '  rubric asks for a ranking; state clearly vs marginal.',
    '- Do not infer methods/steps from appearance ("this looks like fewer steps")',
    '  — measured blindness failures have come from confident wrong inferences.',
    '',
  ].join('\n')
}

/** Unblind a judged bundle -> a registry perceptual row (returned, not
 * appended — the caller appends). Validates verdicts.json first. */
export function unblindBundle(bundleDir) {
  const manifestPath = path.join(bundleDir, 'manifest.json')
  const verdictsPath = path.join(bundleDir, 'verdicts.json')
  const mappingPath = path.join(bundleDir, 'sealed-mapping.json')
  for (const f of [manifestPath, verdictsPath, mappingPath]) {
    if (!fs.existsSync(f)) throw new Error(`bundle incomplete (missing ${path.basename(f)}): ${bundleDir}`)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const verdicts = JSON.parse(fs.readFileSync(verdictsPath, 'utf8'))
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'))
  if (verdicts.runId !== manifest.runId) throw new Error('verdicts/manifest runId mismatch')
  const per = {}
  for (const scenario of manifest.scenarios ?? []) {
    for (const cp of scenario.checkpoints ?? []) {
      const letter = cp.id.replace(/^blind-/, '')
      const v = verdicts.checkpoints?.[cp.id]
      if (!v) throw new Error(`no verdict for ${cp.id} — judge every checkpoint first`)
      per[mapping[letter] ?? letter] = {
        verdict: v.verdict, confidence: v.confidence, summary: v.summary,
        issues: v.issues ?? [],
      }
    }
  }
  const failed = Object.values(per).filter((p) => p.verdict !== 'pass').length
  return {
    suite: manifest.suite,
    runId: manifest.runId,
    judgedAt: verdicts.judgedAt,
    mapping,
    perCandidate: per,
    summary: `${Object.keys(per).length} blind reads (${failed} non-pass) — ` +
      Object.entries(per).map(([k, v]) => `${k}: ${v.verdict}`).join(', '),
  }
}

export function visionReportHint(bundleDir) {
  return `pnpm vision:report "${path.relative(REPO_ROOT, bundleDir) || bundleDir}"`
}
