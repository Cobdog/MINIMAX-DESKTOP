// Profiler wrapper (task eebh7ah): node's --cpu-prof/--heap-prof only flush
// on a NORMAL exit — default SIGINT/SIGTERM death skips the exit hooks. This
// wrapper installs signal handlers that route into process.exit(0) so the
// profiles land when the driver is killed cleanly, then imports the server.
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
await import('../../../dist-server/server/index.js')
