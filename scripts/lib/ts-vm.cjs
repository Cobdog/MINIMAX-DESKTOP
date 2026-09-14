'use strict'
/** Shared VM-harness loader for the .cjs test scripts: transpiles a TS module
 * and runs it in a fresh context, resolving RELATIVE imports transitively
 * (each dependency transpiled+cached). Node built-ins and node_modules pass
 * through to the host require. Needed since src/lib modules started importing
 * each other for value (workflow → graph, modelSelection → graph).
 *
 * ES3-target discipline still applies: modules must avoid iterator spreads
 * and matchAll (the transpile target predates them at runtime semantics). */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..', '..')
const cache = new Map()

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
}

function resolveRelative(fromDir, name) {
  const base = path.resolve(fromDir, name)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`cannot resolve relative import '${name}'`)
}

/** Loads <repoRelativeFile> (e.g. 'src/lib/workflow.ts') with the standard
 * context. extraContext keys are merged in for modules needing browser-ish
 * globals (localStorage, CustomEvent, …). */
function loadTs(file, extraContext = {}) {
  const resolved = path.resolve(ROOT, file)
  if (cache.has(resolved)) return cache.get(resolved)
  const moduleExports = {}
  cache.set(resolved, moduleExports)
  const dir = path.dirname(resolved)
  const relativeRequire = (name) => {
    if (name.startsWith('.')) return loadTs(path.relative(ROOT, resolveRelative(dir, name)))
    return require(name)
  }
  vm.runInNewContext(transpile(resolved), { exports: moduleExports, require: relativeRequire, URLSearchParams, URL, console, ...extraContext })
  return moduleExports
}

module.exports = { loadTs, transpile, ROOT }
