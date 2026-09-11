#!/usr/bin/env node
/** Wave 2b visual-regression diff: compares the e2e screenshot loop's output
 *  (test-results/shots) against a stashed baseline directory. Reports, per
 *  view: raw differing-pixel count, the fraction of the frame it is, and the
 *  maximum per-channel delta found — so "imperceptible" is a measured claim,
 *  not an assertion. Usage:
 *    node scripts/css-shot-diff.cjs <baselineDir> [currentDir]   */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
// pngjs ships as playwright's transitive dep (pnpm store) — resolve it from
// wherever pnpm placed it rather than adding a dev dependency.
const pngCandidates = [
  'pngjs',
  path.join(__dirname, '..', 'node_modules', '.pnpm', `pngjs@5.0.0${path.sep}node_modules`, 'pngjs'),
]
let PNG
for (const candidate of pngCandidates) {
  try { PNG = require(candidate).PNG; break } catch { /* try next */ }
}
if (!PNG) {
  console.error('pngjs not found')
  process.exit(1)
}

const baselineDir = process.argv[2] ?? '/tmp/wave2b-baseline/shots'
const currentDir = process.argv[3] ?? path.join(__dirname, '..', 'test-results', 'shots')

const baselineFiles = fs.readdirSync(baselineDir).filter((name) => name.endsWith('.png')).sort()
if (!baselineFiles.length) {
  console.error(`no baseline PNGs in ${baselineDir}`)
  process.exit(1)
}

let totalDiff = 0
let totalPixels = 0
const rows = []
for (const name of baselineFiles) {
  const currentPath = path.join(currentDir, name)
  if (!fs.existsSync(currentPath)) {
    rows.push({ name, missing: true })
    continue
  }
  const before = PNG.sync.read(fs.readFileSync(path.join(baselineDir, name)))
  const after = PNG.sync.read(fs.readFileSync(currentPath))
  if (before.width !== after.width || before.height !== after.height) {
    rows.push({ name, sizeMismatch: `${before.width}x${before.height} -> ${after.width}x${after.height}` })
    continue
  }
  let diffPixels = 0
  let maxChannelDelta = 0
  let firstDiff = null
  const width = before.width
  const height = before.height
  for (let index = 0; index < before.data.length; index += 4) {
    const delta = Math.max(
      Math.abs(before.data[index] - after.data[index]),
      Math.abs(before.data[index + 1] - after.data[index + 1]),
      Math.abs(before.data[index + 2] - after.data[index + 2]),
    )
    if (delta > 0 || before.data[index + 3] !== after.data[index + 3]) {
      diffPixels += 1
      if (delta > maxChannelDelta) maxChannelDelta = delta
      if (!firstDiff) {
        const pixel = index / 4
        firstDiff = { x: pixel % width, y: Math.floor(pixel / width) }
      }
    }
  }
  totalDiff += diffPixels
  totalPixels += width * height
  rows.push({ name, diffPixels, fraction: diffPixels / (width * height), maxChannelDelta, firstDiff, width, height })
}

for (const row of rows) {
  if (row.missing) console.log(`${row.name.padEnd(24)} MISSING in current run`)
  else if (row.sizeMismatch) console.log(`${row.name.padEnd(24)} SIZE MISMATCH ${row.sizeMismatch}`)
  else {
    const fraction = (row.fraction * 100).toFixed(4).padStart(8)
    console.log(`${row.name.padEnd(24)} ${String(row.diffPixels).padStart(9)} px differ (${fraction}%)  maxChannelDelta=${row.maxChannelDelta}${row.firstDiff ? `  first@(${row.firstDiff.x},${row.firstDiff.y})` : ''}`)
  }
}
console.log(`\ntotal: ${totalDiff} / ${totalPixels} pixels differ (${((totalDiff / totalPixels) * 100).toFixed(4)}%)`)
