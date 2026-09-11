/**
 * Server-side entry for the pure error sanitizer. The implementation lives
 * in src/lib/logSanitize.ts (zero imports) so the VM-transpiled unit-test
 * harness can load it directly; the server tree already imports from ../src
 * (see src/types in server/core.ts), so this re-export keeps one source of
 * truth for both tsconfigs and both build outputs.
 */
export * from '../src/lib/logSanitize'
