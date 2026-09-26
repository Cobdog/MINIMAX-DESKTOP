#!/usr/bin/env node
'use strict'

/**
 * THE E-FS1 ARM RUNNER (task 464xfvd — the Fizgig-H3-Still bake-off;
 * assessment docs/research/fizgig-h3-still-assessment.md §5).
 *
 * Experiment harness, not a feature: builds the four bake-off arms (A
 * incumbent / B swap-isolated / B2 their recipe / C decode-isolated) from
 * ONE matched request, validates each against the engine-contract mirror
 * (scripts/fixtures/engine-object-info.json — or a LIVE object_info
 * capture via --info), and writes submittable prompt JSONs.
 *
 * USAGE (the GPU-window session):
 *   node scripts/experiments/efs1-arms.cjs \
 *     [--prompt "..."] [--width 1344] [--height 768] [--seed 90210] \
 *     [--source uploaded-name.png] [--prefix efs1/domain01] \
 *     [--turbo-fl2v turbo8step.safetensors] [--turbo-v4-600 step600ema.safetensors] \
 *     [--info /tmp/object-info-live.json] [--out test-results/experiments/efs1]
 *   → <out>/A.json … C.json (the /prompt bodies) + manifest.json
 *
 * SUBMIT DISCIPLINE (docs/agent/runbook.md — binding): the 8189 testbed
 * ONLY (127.0.0.1:8189; 8188 is NEVER ours), health-check + nvidia-smi
 * before, POST /free between arms, teardown + nvidia-smi verification
 * after; matched seeds across arms; blind pairs per the assessment; cost
 * rows (end-to-end + decode-segment wall-clock, VRAM peak) land in the
 * Flux task comment. The pack must be INSTALLED on the testbed (clone
 * shootthesound/ComfyUI-Fizgig-H3-Still @ f3252d2 into custom_nodes) —
 * the mirror entries are source-derived, an honest /object_info capture
 * replaces them, and this script refuses to write anything a live capture
 * would reject.
 *
 * No engine, no GPU, no network in this file — graph construction only.
 */

const fs = require('node:fs')
const path = require('node:path')

const { loadTs } = require('../lib/ts-vm.cjs')
const { H3IMG_MODELS } = require('../lib/h3img-matrix.cjs')

const h3image = loadTs('src/lib/graph/h3image.ts')
const contract = loadTs('src/lib/engineContract.ts')

const REPO = path.resolve(__dirname, '..', '..')
const MIRROR = path.join(REPO, 'scripts', 'fixtures', 'engine-object-info.json')

function arg(name, fallback) {
  const argv = process.argv
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === `--${name}`) return argv[index + 1] ?? fallback
    if (current.startsWith(`--${name}=`)) return current.split('=').slice(1).join('=')
  }
  return fallback
}

/** The four arms with their per-arm SELECTION patches: B2 rides the
 *  challenger's own v4-step-600 turbo (the inference ladder targets the
 *  8-step family by design), everything else rides the incumbent stack. */
function armSelections(models) {
  const turboV4 = arg('turbo-v4-600', 'minimax_h3_turbo_v4_step600_ema.safetensors')
  return {
    A: models,
    B: models,
    B2: { ...models, turboLora: turboV4 },
    C: models,
  }
}

/** Builds + validates + writes every arm. Returns [{arm, path}]. Throws on
 *  any contract violation (never writes a graph the engine would refuse)
 *  and lets a builder refusal surface per-arm (an unserved pack is an
 *  experiment-stopper, not a silent arm drop). */
function writeArms({ request, models, info, outDir }) {
  const selections = armSelections(models)
  const written = []
  for (const arm of h3image.EFS1_ARMS) {
    const graph = h3image.buildH3ImageGraph(request, selections[arm.id] ?? models, info, arm.options)
    const violations = contract.validateGraphAgainstSchemas(graph, info)
    if (violations.length > 0) {
      throw new Error(`E-FS1 arm ${arm.id} failed the engine contract:\n${contract.contractVerdict(violations)}`)
    }
    const file = path.join(outDir, `${arm.id}.json`)
    fs.writeFileSync(file, JSON.stringify({ prompt: graph }, null, 2) + '\n')
    written.push({ arm: arm.id, label: arm.label, isolates: arm.isolates, path: file })
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    experiment: 'E-FS1',
    task: '464xfvd',
    request,
    arms: written,
    infoSource: 'engine-contract mirror (source-derived Fizgig entries @ f3252d2) — re-run with --info <live object_info> once the pack is installed on the testbed',
  }, null, 2) + '\n')
  return written
}

module.exports = { writeArms }

function main() {
  const request = {
    family: 'h3img.generate.t1',
    prompt: arg('prompt', 'A finished still for the E-FS1 bake-off: portrait domain, sharp skin detail, natural light.'),
    width: Number(arg('width', '1344')),
    height: Number(arg('height', '768')),
    seed: Number(arg('seed', '90210')),
    tier: 1,
    refs: [],
    loras: [],
    ...(arg('source', '') ? { source: arg('source', '') } : {}),
    filenamePrefix: arg('prefix', 'efs1/arm'),
  }
  const models = { ...H3IMG_MODELS }
  const turboFl2v = arg('turbo-fl2v', '')
  if (turboFl2v) models.turboLora = turboFl2v
  const infoPath = arg('info', MIRROR)
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'))
  const served = info.nodes ?? info
  const outDir = path.resolve(REPO, arg('out', 'test-results/experiments/efs1'))
  fs.mkdirSync(outDir, { recursive: true })
  const written = writeArms({ request, models, info: served, outDir })
  for (const entry of written) {
    console.log(`arm ${entry.arm} (${entry.label}) → ${path.relative(REPO, entry.path)} — ${entry.isolates}`)
  }
  console.log(`\nNext: submit on the 8189 testbed per docs/agent/runbook.md — health-check, matched seeds, POST /free between arms, teardown verified.`)
}

if (require.main === module) main()
