#!/usr/bin/env node
/** Wave 2b design-token audit: enumerates color literals, font sizes, spacing
 *  values and z-index layers across the studio stylesheets, clusters
 *  near-duplicate colors, and reports the distributions that the token
 *  codemod decisions are made against. Throwaway analysis tooling — safe to
 *  run any time; writes nothing. Usage: node scripts/css-token-audit.cjs */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = __dirname
const FILES = ['src/styles.css', 'src/guided-studio.css'].map((relative) =>
  path.join(ROOT, '..', relative))

// ---------------------------------------------------------------------------
// color parsing
// ---------------------------------------------------------------------------

const NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
])

const NAMED_COLOR_RGB = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  orange: [255, 165, 0], purple: [128, 0, 128], pink: [255, 192, 203], yellow: [255, 255, 0],
  cyan: [0, 255, 255], magenta: [255, 0, 255], lime: [0, 255, 0], teal: [0, 128, 128],
  navy: [0, 0, 128], ivory: [255, 255, 240], gold: [255, 215, 0], crimson: [220, 20, 60],
  salmon: [250, 128, 114], tomato: [255, 99, 71], violet: [238, 130, 238], indigo: [75, 0, 130],
  turquoise: [64, 224, 208], khaki: [240, 230, 140], beige: [245, 245, 220], tan: [210, 180, 140],
  brown: [165, 42, 42], dimgray: [105, 105, 105], dimgrey: [105, 105, 105],
  lightgray: [211, 211, 211], lightgrey: [211, 211, 211], whitesmoke: [245, 245, 245],
  gainsboro: [220, 220, 220], ghostwhite: [248, 248, 255], aliceblue: [240, 248, 255],
  snow: [255, 250, 250], seashell: [255, 245, 238], honeydew: [240, 255, 240], mintcream: [245, 255, 250],
  azure: [240, 255, 255], lavender: [230, 230, 250], linen: [250, 240, 230], cornsilk: [255, 248, 220],
  floralwhite: [255, 250, 240],
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360
  s /= 100
  l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let rgb
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return rgb.map((value) => Math.round((value + m) * 255))
}

/** Parse one color literal into { r, g, b, a, normalized } or null. */
function parseColor(literal) {
  const value = literal.trim().toLowerCase()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0, normalized: 'transparent' }
  if (value === 'currentcolor' || value === 'inherit') return null
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const expand = (character) => parseInt(character + character, 16)
      return { r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]), a: hex.length === 4 ? expand(hex[3]) / 255 : 1, normalized: value }
    }
    if (hex.length === 6 || hex.length === 8) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1, normalized: value }
    }
    return null
  }
  const fnMatch = value.match(/^(rgba?|hsla?)\(([^)]+)\)$/)
  if (fnMatch) {
    const parts = fnMatch[2].split(/[,/\s]+/).filter(Boolean).map((part) => part.trim())
    const numbers = parts.map((part) => {
      const percent = part.endsWith('%')
      const numeric = Number(percent ? part.slice(0, -1) : part)
      return { numeric, percent }
    })
    if (fnMatch[1].startsWith('rgb')) {
      const channel = (entry) => Math.round(entry.percent ? (entry.numeric / 100) * 255 : entry.numeric)
      const alpha = numbers.length > 3 ? Math.min(1, Math.max(0, numbers[3].percent ? numbers[3].numeric / 100 : numbers[3].numeric)) : 1
      return { r: channel(numbers[0]), g: channel(numbers[1]), b: channel(numbers[2]), a: alpha, normalized: value }
    }
    const hue = numbers[0].numeric
    const saturation = numbers[1].numeric
    const lightness = numbers[2].numeric
    const alpha = numbers.length > 3 ? Math.min(1, Math.max(0, numbers[3].percent ? numbers[3].numeric / 100 : numbers[3].numeric)) : 1
    const [r, g, b] = hslToRgb(hue, saturation, lightness)
    return { r, g, b, a: alpha, normalized: value }
  }
  if (NAMED_COLORS.has(value)) {
    if (NAMED_COLOR_RGB[value]) return { ...fromArray(NAMED_COLOR_RGB[value]), a: 1, normalized: value }
    return { r: -1, g: -1, b: -1, a: 1, normalized: value }
  }
  return null
}

function fromArray([r, g, b]) {
  return { r, g, b }
}

function channelDistance(one, two) {
  return Math.max(Math.abs(one.r - two.r), Math.abs(one.g - two.g), Math.abs(one.b - two.b), Math.abs(one.a - two.a) * 255)
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
}

/** Which CSS properties a color literal is used in (color: vs background: vs
 *  border: matters for naming decisions). */
function findColorUsages(css) {
  const usages = [] // { literal, property }
  const propertyMatches = [...css.matchAll(/([-a-zA-Z]+)\s*:\s*([^;{}]+)/g)]
  for (const declaration of propertyMatches) {
    const property = declaration[1]
    // Skip custom property definitions — token definitions themselves.
    if (property.startsWith('--')) continue
    const value = declaration[2]
    for (const hex of value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) usages.push({ literal: hex[0], property })
    for (const fn of value.matchAll(/\b(?:rgba?|hsla?)\(/gi)) {
      const start = fn.index
      const end = value.indexOf(')', start)
      if (end < 0) continue
      usages.push({ literal: value.slice(start, end + 1), property })
    }
    // Named colors: only as a standalone token in a color-position.
    for (const token of value.split(/[\s,()]+/)) {
      const cleaned = token.trim().toLowerCase()
      if (NAMED_COLORS.has(cleaned)) usages.push({ literal: cleaned, property })
    }
  }
  return usages
}

function countBy(items, key) {
  const counts = new Map()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return counts
}

function formatDistribution(counts) {
  return [...counts.entries()].sort((one, two) => two[1] - one[1] || String(one[0]).localeCompare(String(two[0])))
}

// ---------------------------------------------------------------------------

for (const file of FILES) {
  const css = stripComments(fs.readFileSync(file, 'utf8'))
  const label = path.basename(file)
  console.log(`\n================ ${label} ================`)

  // --- colors ---
  const usages = findColorUsages(css)
  const byLiteral = new Map()
  for (const usage of usages) {
    if (!byLiteral.has(usage.literal)) byLiteral.set(usage.literal, { count: 0, properties: new Set() })
    const entry = byLiteral.get(usage.literal)
    entry.count += 1
    if (usage.property) entry.properties.add(usage.property)
  }
  const literalEntries = [...byLiteral.entries()].map(([literal, entry]) => {
    const parsed = parseColor(literal)
    return { literal, count: entry.count, properties: [...entry.properties].sort(), parsed }
  })
  console.log(`\ncolor literals: ${literalEntries.length} distinct, ${usages.length} usages`)
  for (const entry of literalEntries.slice().sort((one, two) => two.count - one.count || one.literal.localeCompare(two.literal))) {
    const rgb = entry.parsed ? `rgb(${entry.parsed.r},${entry.parsed.g},${entry.parsed.b}) a=${entry.parsed.a.toFixed(2)}` : 'unparsed'
    console.log(`  ${String(entry.count).padStart(4)}x  ${entry.literal.padEnd(28)} ${rgb.padEnd(30)} [${entry.properties.join(', ')}]`)
  }

  // --- near-duplicate clustering (<=2 per channel, alpha within 0.01) ---
  const parsedEntries = literalEntries.filter((entry) => entry.parsed && entry.parsed.r >= 0)
  const clusters = []
  for (const entry of parsedEntries) {
    const cluster = clusters.find((candidate) => channelDistance(candidate.anchor.parsed, entry.parsed) <= 2)
    if (cluster) cluster.members.push(entry)
    else clusters.push({ anchor: entry, members: [entry] })
  }
  clusters.sort((one, two) => two.members.length - one.members.length)
  const multiClusters = clusters.filter((cluster) => cluster.members.length > 1)
  console.log(`\nnear-duplicate color clusters (<=2/channel): ${multiClusters.length} multi-member clusters out of ${clusters.length} total`)

  // --- font sizes ---
  const fontSizes = countBy([...css.matchAll(/font-size:\s*([^;{}]+)/g)].map((match) => match[1].trim()), (value) => value)
  console.log(`\nfont-size values: ${fontSizes.size} distinct, ${[...fontSizes.values()].reduce((sum, value) => sum + value, 0)} usages`)
  for (const [value, count] of formatDistribution(fontSizes)) console.log(`  ${String(count).padStart(4)}x  ${value}`)

  // --- spacing (margin/padding/gap + their longhand/inline forms) ---
  const spacingDeclarations = [...css.matchAll(/(?:^|[{;])\s*(margin|padding|gap|row-gap|column-gap|margin-[a-z]+|padding-[a-z]+|inset|top|right|bottom|left)\s*:\s*([^;{}]+)/g)].map((match) => ({ property: match[1], value: match[2].trim() }))
  const pxValues = new Map()
  for (const declaration of spacingDeclarations) {
    for (const match of declaration.value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      const numeric = Number(match[1])
      pxValues.set(numeric, (pxValues.get(numeric) ?? 0) + 1)
    }
  }
  console.log(`\nspacing declarations: ${spacingDeclarations.length} (${[...pxValues.values()].reduce((sum, value) => sum + value, 0)} px values)`)
  for (const [value, count] of formatDistribution(pxValues)) console.log(`  ${String(count).padStart(4)}x  ${value}px ${value % 4 === 0 ? '' : '  (off-grid)'}`)

  // --- z-index ---
  const zIndexes = countBy([...css.matchAll(/z-index:\s*([^;{}]+)/g)].map((match) => match[1].trim()), (value) => value)
  console.log(`\nz-index values: ${zIndexes.size} distinct, ${[...zIndexes.values()].reduce((sum, value) => sum + value, 0)} usages`)
  for (const [value, count] of formatDistribution(zIndexes)) console.log(`  ${String(count).padStart(4)}x  ${value}`)
}
