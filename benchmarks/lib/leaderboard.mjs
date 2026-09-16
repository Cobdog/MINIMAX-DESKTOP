// LEADERBOARD.md regeneration — the human view is ALWAYS generated from the
// registry (never hand-edited; the header says so).
import fs from 'node:fs'
import path from 'node:path'
import { loadRegistry, suiteIncumbents } from './registry.mjs'
import { LEADERBOARD_PATH } from './util.mjs'

function fmtMetricValue(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  if (typeof v === 'object') {
    const nested = Object.values(v).filter((x) => typeof x === 'number')
    if (nested.length) {
      const mean = nested.reduce((a, b) => a + b, 0) / nested.length
      return `~${mean.toFixed(2)} (${nested.length} pts)`
    }
    return JSON.stringify(v).slice(0, 40)
  }
  return String(v).slice(0, 60)
}

function pickHeadlineMetrics(suite, metrics) {
  // per-suite headline metric keys (fall back to the first numeric keys)
  const HEADLINE = {
    'ref2va-bakeoff': ['arcface_mean', 'wall_s'],
    'tier-ladder': ['wall_s', 'arcface_mean'],
    'hybrid-ab': ['thirds_psnr_whole_mean', 'arcface_mean'],
    'movement-md1': ['checkpoint_err_max_abs_pct', 'bg_psnr_min'],
    'nonhuman-fc1': ['err_px_mean', 'detected_ratio'],
    'preservation-k1': ['outside_psnr_db', 'outside_de76', 'arcface'],
    'transitions-e1e4': ['seam_psnr_db_min', 'anchor_mean_db'],
  }
  const keys = HEADLINE[suite] ?? []
  const numeric = Object.entries(metrics ?? {})
    .filter(([, v]) => typeof v === 'number')
    .map(([k]) => k)
  const chosen = keys.filter((k) => k in (metrics ?? {}))
  if (chosen.length === 0 && numeric.length) return numeric.slice(0, 3)
  return chosen.length ? chosen : numeric.slice(0, 2)
}

function suiteSection(reg, cfg, suite) {
  const rows = reg.rows.filter((r) => r.suite === suite)
  if (rows.length === 0) return ''
  const inc = suiteIncumbents(reg, suite, reg.baselineEnvironmentId)
  const lines = []
  lines.push(`## ${suite} — ${cfg.family}`)
  lines.push('')
  lines.push(`**Measures:** ${cfg.measures}`)
  lines.push('')
  lines.push(`**Incumbent${inc.length === 1 ? '' : 's'} (golden baseline, env \`${reg.baselineEnvironmentId}\`):** ` +
    (inc.length ? inc.map((r) => `${r.candidate.label ?? r.candidate.id} (\`${r.id}\`)`).join('; ')
      : '_none recorded yet_'))
  lines.push('')
  lines.push('| row | candidate | incumbent | headline metrics | verdict |')
  lines.push('|---|---|---|---|---|')
  for (const row of rows) {
    const heads = pickHeadlineMetrics(suite, row.metrics)
      .map((k) => `${k}: ${fmtMetricValue(row.metrics[k])}`).join('; ')
    const verdict = row.verdict?.text ?? (row.verdict ?? '—')
    lines.push(`| \`${row.id}\` | ${row.candidate.label ?? row.candidate.id} | ` +
      `${row.incumbent ? 'YES' : 'no'} | ${heads || '—'} | ${String(verdict).slice(0, 220)} |`)
  }
  lines.push('')
  lines.push(`**Known limits:**`)
  for (const limit of cfg.limits) lines.push(`- ${limit}`)
  lines.push('')
  return lines.join('\n')
}

export function renderLeaderboard(reg, suites) {
  const out = []
  out.push('# Benchmark leaderboard — GENERATED, do not edit')
  out.push('')
  out.push('Regenerated from `benchmarks/results/registry.json` by ' +
    '`node benchmarks/run.mjs --regen-leaderboard`. Never hand-edit; the ' +
    'registry is append-only and this file is a view of it.')
  out.push('')
  out.push(`- Rows: **${reg.rows.length}** across **${new Set(reg.rows.map((r) => r.suite)).size}** suites`)
  out.push(`- Baseline environment: \`${reg.baselineEnvironmentId}\`` +
    (reg.environments.length ? ` (${reg.environments.map((e) => `\`${e.id}\`: ${e.gpu}, driver ${e.driver}, ComfyUI ${e.comfyui}`).join(' · ')})` : ''))
  out.push('')
  const baselineEnv = reg.environments.find((e) => e.id === reg.baselineEnvironmentId)
  out.push('')
  out.push(`Baseline environment detail: ${baselineEnv ? `${baselineEnv.gpu}, driver ${baselineEnv.driver}, ComfyUI ${baselineEnv.comfyui}` : '(none)'}`)
  for (const name of Object.keys(suites).sort()) {
    out.push(suiteSection(reg, suites[name], name))
  }
  const blind = reg.rows.filter((r) => r.blind)
  if (blind.length) {
    out.push('## Blind-judge perceptual rows')
    out.push('')
    for (const row of blind) {
      out.push(`- \`${row.id}\` — ${row.blind.summary ?? JSON.stringify(row.blind).slice(0, 200)}`)
    }
    out.push('')
  }
  return out.join('\n') + '\n'
}

export function regenerateLeaderboard(registryPath, leaderboardPath = LEADERBOARD_PATH, suitesLoader) {
  const reg = loadRegistry(registryPath)
  const suites = suitesLoader()
  const md = renderLeaderboard(reg, suites)
  fs.mkdirSync(path.dirname(leaderboardPath), { recursive: true })
  fs.writeFileSync(leaderboardPath, md, 'utf8')
  return md
}
