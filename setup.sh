#!/bin/sh
# Monoka setup — everything a fresh checkout needs to be ready, out of the box.
#
#   ./setup.sh            check prerequisites, install deps, build, verify tooling
#   ./setup.sh --check    dry run: report what's present/missing, do nothing
#
# Idempotent: safe to re-run (install is cached, build is incremental, the
# tool checks just re-probe). POSIX sh; works from any CWD (self-locating;
# the repo path contains a space — everything quoted).
#
# What "ready" means here (and what is deliberately NOT done):
#   - node >= 20 + pnpm present, dependencies installed, app built
#   - a system Chrome/Chromium for the e2e/vision suites (the house contract
#     resolves the MACHINE'S browser — playwright's own downloads are not used;
#     google-chrome is preferred because Debian/Ubuntu chromium lacks H.264)
#   - ffmpeg present (runtime: dataset clip extraction; some e2e arms)
#   - python3+numpy noted if absent (benchmark suites only — optional)
#   - NO model downloads, NO engine fetch, NO network beyond pnpm itself:
#     the studio is local-first and consent-gated by design (start.sh, the
#     fetch catalog) — setup never bypasses that.
set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || {
  echo "setup.sh: cannot resolve my own directory" >&2; exit 1;
}
cd -- "$SCRIPT_DIR" || { echo "setup.sh: cannot cd to $SCRIPT_DIR" >&2; exit 1; }
PROG=setup.sh
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

say() { echo "$PROG: $*"; }
warn() { echo "$PROG: [warn] $*" >&2; }

# --- node --------------------------------------------------------------------
NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
fi
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  warn "node >= 20 is required (found: ${NODE_MAJOR:-none}) — install Node 20+ first: https://nodejs.org"
  exit 1
fi
say "node $(node --version) ok"

# --- pnpm --------------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm is not on PATH. Enable it with:  corepack enable  (or: npm install -g pnpm)"
  exit 1
fi
say "pnpm $(pnpm --version) ok"

# --- dependencies ------------------------------------------------------------
if [ "$CHECK" = 1 ]; then
  [ -d node_modules ] && say "deps: node_modules present (would skip install)" || say "deps: MISSING (would run pnpm install)"
else
  say "installing dependencies (pnpm install)…"
  pnpm install || { warn "pnpm install failed"; exit 1; }
fi

# --- build -------------------------------------------------------------------
if [ "$CHECK" = 1 ]; then
  if [ -f dist/index.html ] && [ -f dist-server/server/index.js ]; then
    say "build: outputs present (would skip build)"
  else
    say "build: MISSING (would run pnpm build)"
  fi
else
  say "building (pnpm build)…"
  pnpm build || { warn "pnpm build failed"; exit 1; }
fi

# --- system browser (the e2e/vision contract: the machine's own browser) ------
BROWSER=""
if [ -n "${MINIMAX_TEST_BROWSER:-}" ] && [ -x "$MINIMAX_TEST_BROWSER" ]; then
  BROWSER="$MINIMAX_TEST_BROWSER (MINIMAX_TEST_BROWSER)"
else
  # The same preference order playwright.config.ts uses: google-chrome first
  # (H.264), then chromium, then a PATH scan.
  for candidate in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$candidate" ]; then BROWSER="$candidate"; break; fi
  done
  if [ -z "$BROWSER" ]; then
    for name in google-chrome-stable google-chrome chromium chromium-browser chrome; do
      if command -v "$name" >/dev/null 2>&1; then BROWSER="$(command -v "$name") (PATH)"; break; fi
    done
  fi
fi
if [ -n "$BROWSER" ]; then
  say "browser: $BROWSER ok (e2e/vision suites)"
else
  warn "no system Chrome/Chromium found — the e2e/vision suites need one (google-chrome preferred: Debian/Ubuntu chromium lacks H.264)."
  warn "  install e.g.:  sudo apt install google-chrome-stable   (or set MINIMAX_TEST_BROWSER to an existing binary)"
fi

# --- ffmpeg (runtime: dataset clips; some e2e arms) --------------------------
if command -v ffmpeg >/dev/null 2>&1; then
  say "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}') ok"
else
  warn "ffmpeg not found — dataset clip extraction and some e2e arms need it. install e.g.:  sudo apt install ffmpeg"
fi

# --- python3 + numpy (benchmark suites only — optional) ----------------------
if command -v python3 >/dev/null 2>&1 && python3 -c 'import numpy' >/dev/null 2>&1; then
  say "python3+numpy ok (benchmark suites)"
else
  say "note: python3+numpy not found — only the benchmark suites need them; everything else is fine without."
fi

echo
if [ "$CHECK" = 1 ]; then
  say "check complete (dry run — nothing was installed or built)."
else
  say "setup complete."
fi
echo "  boot the studio:   ./start.sh                 (or ./start.sh --configure for every option)"
echo "  run the full gate: pnpm gate                  (build → unit → smoke → e2e → vision)"
echo "  junction console:  boot with ?dbg=1           (the triage transcript)"
