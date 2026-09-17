#!/usr/bin/env bash
# Boots the app server under node --cpu-prof/--heap-prof on port 5302 (the
# profiler's assigned range) against the profile-scratch studio home. Profiles
# land in test-results/perf-profile/profiles/. Kill by the PID recorded in
# artifacts/server-prof.pid — never by pattern (agent-resources.md rules).
set -euo pipefail
cd "$(dirname "$0")/../.."   # worktree root
export MINIMAX_STUDIO_HOME="$PWD/test-results/perf-profile/home-prof"
export MINIMAX_LAN_PORT=5302
export MINIMAX_NO_HTTPS=1
exec node \
  --cpu-prof \
  --cpu-prof-dir="$PWD/test-results/perf-profile/profiles" \
  --cpu-prof-name=server-cpu.cpuprofile \
  --heap-prof \
  --heap-prof-dir="$PWD/test-results/perf-profile/profiles" \
  --heap-prof-name=server-heap.heapprofile \
  test-results/perf-profile/scripts/prof-wrapper.mjs
