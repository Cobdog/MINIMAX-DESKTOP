#!/usr/bin/env node
/** Wave 2b design-token codemod. Rewrites src/styles.css and
 *  src/guided-studio.css onto the token layer:
 *    - color literals -> existing tokens / new --color-* tokens (exact
 *      matches, plus near-duplicate folds that are VERIFIED <=2 per channel)
 *    - rgba(...) family literals -> color-mix() over their token base
 *    - font-size literals -> the --text-* scale (exact or +-0.5px only)
 *    - on-grid spacing literals in margin/padding/gap -> --space-* steps
 *    - z-index literals -> the --z-* ladder (values unchanged)
 *  Every fold is verified against its target token value before anything is
 *  written; an out-of-tolerance entry aborts the run. Idempotent-ish: a
 *  second run replaces nothing (var() forms don't match the literal
 *  patterns). Usage: node scripts/css-token-codemod.cjs [--check] */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const CHECK_ONLY = process.argv.includes('--check')
const ROOT = path.join(__dirname, '..')
const FILES = [path.join(ROOT, 'src/styles.css'), path.join(ROOT, 'src/guided-studio.css')]

// ---------------------------------------------------------------------------
// token values (single source of truth for the fold verification)
// ---------------------------------------------------------------------------

const TOKEN_VALUES = {
  '--bg': [11, 14, 13],
  '--surface': [16, 20, 18],
  '--surface-2': [21, 26, 23],
  '--surface-3': [27, 33, 30],
  '--line': [37, 44, 40],
  '--line-strong': [52, 61, 56],
  '--accent': [198, 255, 99],
  '--danger': [255, 127, 127],
  '--warning': [240, 188, 102],
  '--spectrum-red': [255, 102, 138],
  '--spectrum-amber': [255, 200, 87],
  '--spectrum-cyan': [84, 230, 212],
  '--spectrum-blue': [123, 156, 255],
  '--spectrum-violet': [232, 121, 249],
  // new wave-2b tokens
  '--color-surface-sunken': [13, 17, 15],
  '--color-surface-deep': [8, 11, 9],
  '--color-surface-abyss': [5, 7, 6],
  '--color-text-soft': [202, 210, 205],
  '--color-line-accent': [82, 101, 47],
  '--color-accent-alt': [195, 255, 74],
  '--color-danger-strong': [255, 95, 109],
  '--color-warning-bright': [255, 209, 102],
  '--color-info': [141, 184, 255],
  '--color-violet-pale': [215, 166, 255],
  '--color-violet-mist': [233, 165, 210],
  '--color-cyan-glow': [77, 238, 234],
}

/** hex literal -> token. exact:true means the literal IS the token value. */
const HEX_FOLDS = [
  { literal: '#101412', token: '--surface', exact: true },
  { literal: '#151a17', token: '--surface-2', exact: true },
  { literal: '#1b211e', token: '--surface-3', exact: true },
  { literal: '#0b0e0d', token: '--bg', exact: true },
  { literal: '#252c28', token: '--line', exact: true },
  { literal: '#c6ff63', token: '--accent', exact: true },
  { literal: '#142000', token: '--accent-ink', exact: true }, // value verified below
  { literal: '#ff7f7f', token: '--danger', exact: true },
  { literal: '#f0bc66', token: '--warning', exact: true },
  { literal: '#ff668a', token: '--spectrum-red', exact: true },
  { literal: '#ffc857', token: '--spectrum-amber', exact: true },
  { literal: '#54e6d4', token: '--spectrum-cyan', exact: true },
  { literal: '#7b9cff', token: '--spectrum-blue', exact: true },
  { literal: '#e879f9', token: '--spectrum-violet', exact: true },
  // new tokens (anchor literals, exact by construction)
  { literal: '#0d110f', token: '--color-surface-sunken', exact: true },
  { literal: '#080b09', token: '--color-surface-deep', exact: true },
  { literal: '#050706', token: '--color-surface-abyss', exact: true },
  { literal: '#cad2cd', token: '--color-text-soft', exact: true },
  { literal: '#52652f', token: '--color-line-accent', exact: true },
  { literal: '#ff5f6d', token: '--color-danger-strong', exact: true },
  { literal: '#ffd166', token: '--color-warning-bright', exact: true },
  { literal: '#8db8ff', token: '--color-info', exact: true },
  { literal: '#d7a6ff', token: '--color-violet-pale', exact: true },
  { literal: '#e9a5d2', token: '--color-violet-mist', exact: true },
  { literal: '#4deeea', token: '--color-cyan-glow', exact: true },
  // near-duplicate folds (verified <=2 per channel below)
  { literal: '#0b0f0d', token: '--color-surface-sunken' },
  { literal: '#0c100e', token: '--color-surface-sunken' },
  { literal: '#0e1210', token: '--color-surface-sunken' },
  { literal: '#090c0a', token: '--color-surface-deep' },
  { literal: '#0a0d0b', token: '--color-surface-deep' },
  { literal: '#090d0b', token: '--color-surface-deep' },
  { literal: '#060806', token: '--color-surface-abyss' },
  { literal: '#070908', token: '--color-surface-abyss' },
  { literal: '#070907', token: '--color-surface-abyss' },
  { literal: '#262c29', token: '--line' },
  { literal: '#343c38', token: '--line-strong' },
  { literal: '#cbd4ce', token: '--color-text-soft' },
]

const ACCENT_INK = [20, 32, 0] // --accent-ink: #142000 (kept as literal value here)

/** rgba family bases -> token. Verified against TOKEN_VALUES. */
const RGBA_FAMILIES = [
  { base: [198, 255, 99], token: '--accent', exact: true },
  { base: [240, 188, 102], token: '--warning', exact: true },
  { base: [255, 127, 127], token: '--danger', exact: true },
  { base: [255, 200, 87], token: '--spectrum-amber', exact: true },
  { base: [84, 230, 212], token: '--spectrum-cyan', exact: true },
  { base: [232, 121, 249], token: '--spectrum-violet', exact: true },
  { base: [123, 156, 255], token: '--spectrum-blue', exact: true },
  { base: [255, 102, 138], token: '--spectrum-red', exact: true },
  { base: [13, 17, 15], token: '--color-surface-sunken', exact: true },
  { base: [12, 16, 14], token: '--color-surface-sunken' }, // = #0c100e fold, <=2/channel
  { base: [10, 13, 11], token: '--color-surface-deep' },   // = #0a0d0b fold
  { base: [21, 26, 23], token: '--surface-2', exact: true },
  { base: [5, 7, 6], token: '--color-surface-abyss', exact: true },
  { base: [3, 5, 4], token: '--color-surface-abyss' },     // <=2/channel
  { base: [195, 255, 74], token: '--color-accent-alt', exact: true },
  { base: [255, 95, 109], token: '--color-danger-strong', exact: true },
  { base: [141, 184, 255], token: '--color-info', exact: true },
  { base: [215, 166, 255], token: '--color-violet-pale', exact: true },
  { base: [233, 165, 210], token: '--color-violet-mist', exact: true },
  { base: [77, 238, 234], token: '--color-cyan-glow', exact: true },
]

const FONT_SIZES = [
  // [literal, replacement, maxDelta] -- replacement is exact unless noted.
  // 10.5px stays literal ON PURPOSE: mapping it to the 10px step (a 0.5px
  // delta, nominally within tolerance) visibly moved the license banner's
  // line-wrap point — a discrete jump, not an imperceptible delta.
  ['7px', 'var(--text-2xs)'],
  ['8px', 'var(--text-xs)'],
  ['9px', 'var(--text-sm)'],
  ['9.5px', 'var(--text-sm)', 0.5],
  ['10px', 'var(--text-base)'],
  ['11px', 'var(--text-md)'],
  ['12px', 'var(--text-lg)'],
  ['13px', 'var(--text-xl)'],
  ['16px', 'var(--text-2xl)'],
]
const TEXT_SCALE = { '--text-2xs': 7, '--text-xs': 8, '--text-sm': 9, '--text-base': 10, '--text-md': 11, '--text-lg': 12, '--text-xl': 13, '--text-2xl': 16 }

const SPACING_PROPS = /^(margin|padding|gap|row-gap|column-gap|margin-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end)|padding-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))$/
const SPACE_STEPS = { 4: '--space-1', 8: '--space-2', 12: '--space-3', 16: '--space-4', 20: '--space-5', 24: '--space-6', 28: '--space-7', 32: '--space-8', 36: '--space-9', 40: '--space-10' }

const Z_LADDER = { 10: '--z-sticky', 40: '--z-dropdown', 50: '--z-modal', 60: '--z-modal-raised', 70: '--z-overlay', 75: '--z-toast', 80: '--z-overlay-raised', 90: '--z-dialog-top', 100: '--z-max' }

// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const value = hex.replace('#', '')
  return [0, 1, 2].map((index) => parseInt(value.slice(index * 2, index * 2 + 2), 16))
}

function maxChannelDelta(one, two) {
  return Math.max(Math.abs(one[0] - two[0]), Math.abs(one[1] - two[1]), Math.abs(one[2] - two[2]))
}

function verify() {
  const problems = []
  for (const fold of HEX_FOLDS) {
    const target = fold.token === '--accent-ink' ? ACCENT_INK : TOKEN_VALUES[fold.token]
    if (!target) { problems.push(`unknown token ${fold.token}`); continue }
    const delta = maxChannelDelta(hexToRgb(fold.literal), target)
    if (fold.exact && delta !== 0) problems.push(`${fold.literal} claimed exact for ${fold.token} but delta=${delta}`)
    if (delta > 2) problems.push(`${fold.literal} -> ${fold.token} delta=${delta} exceeds tolerance`)
  }
  for (const family of RGBA_FAMILIES) {
    const target = TOKEN_VALUES[family.token]
    if (!target) { problems.push(`unknown token ${family.token}`); continue }
    const delta = maxChannelDelta(family.base, target)
    if (family.exact && delta !== 0) problems.push(`rgba(${family.base}) claimed exact for ${family.token} but delta=${delta}`)
    if (delta > 2) problems.push(`rgba(${family.base}) -> ${family.token} delta=${delta} exceeds tolerance`)
  }
  for (const [literal, replacement, tolerance = 0] of FONT_SIZES) {
    const token = replacement.match(/var\((--[a-z0-9-]+)\)/)?.[1]
    const delta = Math.abs(Number.parseFloat(literal) - TEXT_SCALE[token])
    if (delta > Math.max(tolerance, 0)) problems.push(`font-size ${literal} -> ${token} delta=${delta}px exceeds ${Math.max(tolerance, 0)}px`)
  }
  if (problems.length) {
    console.error('FOLD VERIFICATION FAILED:\n  ' + problems.join('\n  '))
    process.exit(1)
  }
  console.log('fold verification: all deltas within tolerance (exact=0, folds<=2/channel, type<=0.5px)')
}

// ---------------------------------------------------------------------------

const stats = { hex: {}, rgbaFamilies: {}, fontSize: {}, spacing: {}, z: {}, focusRing: 0 }

function percentFromAlpha(alpha) {
  const value = Number((alpha * 100).toFixed(3))
  return String(value)
}

/** Split css into comment / non-comment segments; transforms run on code only. */
function mapCode(css, transform) {
  let out = ''
  let index = 0
  const pattern = /\/\*[\s\S]*?\*\//g
  let match
  while ((match = pattern.exec(css))) {
    out += transform(css.slice(index, match.index))
    out += match[0]
    index = match.index + match[0].length
  }
  out += transform(css.slice(index))
  return out
}

function transformColors(css) {
  return mapCode(css, (code) => {
    let next = code
    // rgba families first (their text doesn't overlap the hex patterns)
    for (const family of RGBA_FAMILIES) {
      const pattern = new RegExp(`rgba?\\(\\s*${family.base[0]}\\s*,\\s*${family.base[1]}\\s*,\\s*${family.base[2]}\\s*,\\s*(\\d*\\.?\\d+)\\s*\\)`, 'gi')
      next = next.replace(pattern, (whole, alpha) => {
        stats.rgbaFamilies[`rgba(${family.base.join(',')})`] = (stats.rgbaFamilies[`rgba(${family.base.join(',')})`] ?? 0) + 1
        return `color-mix(in srgb, var(${family.token}) ${percentFromAlpha(Number(alpha))}%, transparent)`
      })
    }
    for (const fold of HEX_FOLDS) {
      const pattern = new RegExp(`${fold.literal.replace('#', '#')}(?![0-9a-fA-F])`, 'gi')
      next = next.replace(pattern, () => {
        stats.hex[fold.literal] = (stats.hex[fold.literal] ?? 0) + 1
        return `var(${fold.token})`
      })
    }
    return next
  })
}

function transformDeclarations(css, applies, rewrite) {
  return mapCode(css, (code) => code.replace(/([-a-zA-Z]+)\s*:\s*([^;{}]+)/g, (whole, property, value) => {
    if (property.startsWith('--') || !applies(property)) return whole
    const replacement = rewrite(value, property)
    if (replacement === value) return whole
    return `${property}:${replacement}`
  }))
}

function run() {
  verify()
  for (const file of FILES) {
    const original = fs.readFileSync(file, 'utf8')
    let css = original

    // 1) colors (all non-custom-property declarations; the :root custom
    //    property definitions are inserted separately, not regex-rewritten)
    css = transformDeclarations(css, () => true, (value) => transformColors(value))

    // 2) font-size -> --text-* scale
    css = transformDeclarations(css, (property) => property === 'font-size', (value) => {
      let next = value
      for (const [literal, replacement] of FONT_SIZES) {
        next = next.replace(new RegExp(`(?<![\\d.])${literal.replace('.', '\\.')}(?![\\d.])`, 'g'), () => {
          stats.fontSize[literal] = (stats.fontSize[literal] ?? 0) + 1
          return replacement
        })
      }
      return next
    })

    // 3) on-grid spacing in margin/padding/gap -> --space-* (exact values only)
    css = transformDeclarations(css, (property) => SPACING_PROPS.test(property), (value) => {
      let next = value
      for (const [px, token] of Object.entries(SPACE_STEPS)) {
        next = next.replace(new RegExp(`(?<![\\d.])${px}px(?![\\d.])`, 'g'), () => {
          stats.spacing[`${px}px`] = (stats.spacing[`${px}px`] ?? 0) + 1
          return `var(${token})`
        })
      }
      return next
    })

    // 4) z-index -> --z-* ladder
    css = transformDeclarations(css, (property) => property === 'z-index', (value) => {
      let next = value
      for (const [value_, token] of Object.entries(Z_LADDER)) {
        next = next.replace(new RegExp(`(?<![-\\d])${value_}(?![\\d])`, 'g'), () => {
          stats.z[value_] = (stats.z[value_] ?? 0) + 1
          return `var(${token})`
        })
      }
      return next
    })

    // 5) focus ring literals -> token-composed ring
    css = mapCode(css, (code) => code.replace(/outline:\s*2px solid var\(--accent\)/g, () => {
      stats.focusRing += 1
      return 'outline: var(--focus-ring-width) solid var(--focus-ring-color)'
    }))

    if (css !== original) {
      if (!CHECK_ONLY) fs.writeFileSync(file, css)
      console.log(`${path.relative(ROOT, file)}: rewritten${CHECK_ONLY ? ' (check only, not saved)' : ''}`)
    } else {
      console.log(`${path.relative(ROOT, file)}: no changes`)
    }
  }
  const sum = (entries) => Object.values(entries).reduce((total, count) => total + count, 0)
  console.log(`\nreplacements: hex=${sum(stats.hex)} rgba->color-mix=${sum(stats.rgbaFamilies)} font-size=${sum(stats.fontSize)} spacing=${sum(stats.spacing)} z-index=${sum(stats.z)} focus-ring=${stats.focusRing}`)
  const breakdown = (label, entries) => console.log(`${label}:\n` + Object.entries(entries).sort((one, two) => two[1] - one[1]).map(([key, count]) => `  ${String(count).padStart(4)}x ${key}`).join('\n'))
  breakdown('hex', stats.hex)
  breakdown('rgba families', stats.rgbaFamilies)
  breakdown('font-size', stats.fontSize)
  breakdown('spacing', stats.spacing)
  breakdown('z-index', stats.z)
}

run()
