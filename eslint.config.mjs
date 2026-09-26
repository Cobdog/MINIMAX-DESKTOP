import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // .claude/worktrees holds OTHER agents' in-flight linked worktrees (the
  // shared-tree discipline: foreign edits are never touched, never linted —
  // each worktree's owner runs its own gate).
  { ignores: ['dist', 'dist-electron', 'dist-server', 'release', 'node_modules', '.claude/worktrees'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/**/*.cjs', 'tests/lib/**/*.cjs'], languageOptions: { globals: { ...globals.node, WebSocket: 'readonly', fetch: 'readonly' } }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
  // Vitest suites (z7ogmig, 2026-09-20): ESM files whose ported cjs bodies
  // keep their require() lines through a createRequire shim — same node
  // globals as the scripts/*.cjs suites.
  { files: ['tests/**/*.test.js'], languageOptions: { globals: { ...globals.node, WebSocket: 'readonly', fetch: 'readonly' } }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
  // Perf-profile harness (task eebh7ah): node .mjs modules with top-level
  // await; same node globals as the .cjs suites. harness.js is the IN-PAGE
  // browser instrument (installed via navigate initScript) — browser globals.
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
  // The environment-mirror fake engine (reality audit 2026-09-25, jf53fb8):
  // a node .mjs server under e2e/mirror/ — same node globals as the other
  // harness CLIs.
  { files: ['e2e/mirror/**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
  { files: ['scripts/perf-profile/harness.js'], languageOptions: { globals: { ...globals.browser } } },
  // Benchmark harness CLI (task cp96zdM): node CLI modules with top-level
  // await; same node globals as the scripts/*.cjs suites.
  { files: ['benchmarks/**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
)
