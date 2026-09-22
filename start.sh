#!/bin/sh
# MiniMax Studio launcher (task ukyxwfa).
#
#   ./start.sh                  boot with the saved config (first run seeds defaults)
#   ./start.sh --configure      TUI for every pre-boot setting, then save & run
#   ./start.sh --configure --dev  ...including the dev section (dev pipeline,
#                               pretty logs, source maps, vite port)
#   ./start.sh --print          dry run: resolve + guard + show the boot plan
#   ./start.sh --set key=value  headless single-field save (also repairs one
#                               bad field of an otherwise-invalid config)
#
# Config: .start-config.json next to this script (gitignored; overridable with
# MINIMAX_START_CONFIG). Dated decision 2026-09-19: repo-root, not the studio
# home — each checkout/worktree gets independent ports, and the e2e homes
# (test-home/, mkdtemp) never read the repo root. Dev mode defaults ON while
# the maintainer is in heavy development (flip to OFF at release time).
#
# POSIX sh (dash-clean); works from any CWD (self-locating; every path quoted
# — the repo path contains a space). JSON handling rides an inline node
# program: node is a hard prerequisite of the app the launcher boots.
set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || {
  echo "start.sh: cannot resolve my own directory" >&2
  exit 1
}
cd -- "$SCRIPT_DIR" || { echo "start.sh: cannot cd to $SCRIPT_DIR" >&2; exit 1; }
CONFIG_FILE=${MINIMAX_START_CONFIG:-"$SCRIPT_DIR/.start-config.json"}

PROG=start.sh

die() { echo "$PROG: $*" >&2; exit 1; }
usage_error() { echo "$PROG: $*" >&2; echo >&2; usage >&2; exit 2; }

usage() {
  cat <<'EOF'
usage: ./start.sh [flags]

  (no flags)         load .start-config.json (seeding defaults on first run)
                     and boot the studio
  --configure        open the configuration TUI; save & run
  --configure --dev  ...with the dev section visible (dev pipeline, pretty
                     logs, source maps, vite port)
  --print            dry run: print the resolved config and boot plan without
                     booting (side effect: seeds the config on first run)
  --set key=value    save one field and exit (keys: port, host, https, token,
                     qr-print, data-dir, engine-url, log-level, dev,
                     pretty-logs, source-maps, vite-port)
  -h | --help        this help

Environment already set by the caller wins over the config file
(MINIMAX_STUDIO_HOME, MINIMAX_LAN_PORT, MINIMAX_LAN_HOST, MINIMAX_LAN_TOKEN,
MINIMAX_NO_HTTPS, MINIMAX_LOG_LEVEL, MINIMAX_VITE_PORT).
MINIMAX_START_CONFIG relocates the launcher config; MINIMAX_START_TUI=
prompts|whiptail forces a UI.
EOF
}

# --- the node side of the launcher -----------------------------------------
# Modes (argv): load FILE | save FILE k=v... | engine HOME URL | readengine
# HOME | probe PORT HOST | gentoken HOME. No single quotes appear below (the
# program is embedded in a single-quoted shell string).
LAUNCHER_JS='
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mode = process.argv[1];
const DEFAULTS = {
  port: 4178, host: "0.0.0.0", https: true, token: false, qrPrint: true,
  dataDir: "", engineUrl: "", logLevel: "info",
  dev: true, prettyLogs: true, sourceMaps: true, vitePort: 5173,
  dbg: false,
};
const DEFAULT_ENGINE = "http://127.0.0.1:8188";
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"];
const KEYS = Object.keys(DEFAULTS);
const ALIASES = {
  port: "port", host: "host", https: "https", token: "token",
  "qr-print": "qrPrint", qrprint: "qrPrint", dataDir: "dataDir", "data-dir": "dataDir",
  "engine-url": "engineUrl", engineurl: "engineUrl", "log-level": "logLevel", loglevel: "logLevel",
  dev: "dev", "pretty-logs": "prettyLogs", prettylogs: "prettyLogs",
  "source-maps": "sourceMaps", sourcemaps: "sourceMaps",
  "vite-port": "vitePort", viteport: "vitePort",
  dbg: "dbg",
};
function fail(code, message) { process.stderr.write(message + "\n"); process.exit(code); }
function validate(cfg) {
  const problems = [];
  const intField = (k) => {
    const v = cfg[k];
    if (!Number.isInteger(v) || v < 1024 || v > 65535) problems.push(k + ": expected an integer between 1024 and 65535, got " + JSON.stringify(v));
  };
  intField("port"); intField("vitePort");
  for (const k of ["https", "token", "qrPrint", "dev", "prettyLogs", "sourceMaps", "dbg"]) {
    if (typeof cfg[k] !== "boolean") problems.push(k + ": expected true or false, got " + JSON.stringify(cfg[k]));
  }
  if (typeof cfg.host !== "string" || !/^[A-Za-z0-9._:-]{1,255}$/.test(cfg.host)) {
    problems.push("host: expected a plain hostname or IP, got " + JSON.stringify(cfg.host));
  }
  if (!LOG_LEVELS.includes(cfg.logLevel)) {
    problems.push("logLevel: expected one of " + LOG_LEVELS.join("|") + ", got " + JSON.stringify(cfg.logLevel));
  }
  for (const k of ["dataDir", "engineUrl"]) {
    if (typeof cfg[k] !== "string" || /[\x00-\x1f]/.test(cfg[k])) problems.push(k + ": expected a string without control characters");
  }
  if (problems.length === 0) {
    if (cfg.dataDir !== "" && !cfg.dataDir.startsWith("/")) problems.push("dataDir: must be an absolute path when set, got " + JSON.stringify(cfg.dataDir));
    if (cfg.engineUrl !== "") {
      try { const u = new URL(completeScheme(cfg.engineUrl)); if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol"); }
      catch { problems.push("engineUrl: expected an http(s) URL, got " + JSON.stringify(cfg.engineUrl)); }
    }
    if (cfg.port === cfg.vitePort) problems.push("vitePort: must differ from port (both are " + cfg.port + ")");
  }
  return problems;
}
// Scheme completion (mirrors the server completeServiceScheme helper,
// maintainer question 2026-09-19): `host:port` gets http:// so the URL
// constructor — and the app SSRF guard — see a real protocol. Applied at
// every boundary: validate, the engine write, and save normalization.
function completeScheme(url) {
  const trimmed = String(url).trim();
  if (!trimmed) return trimmed;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : "http://" + trimmed;
}
function readRaw(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    fail(3, file + " is not valid JSON: " + error.message);
  }
}
function coerce(key, value) {
  if (key === "port" || key === "vitePort") {
    const n = Number(value);
    if (!Number.isInteger(n) || String(n) !== value.trim()) fail(2, key + ": expected an integer between 1024 and 65535, got " + JSON.stringify(value));
    return n;
  }
  if (typeof DEFAULTS[key] === "boolean") {
    if (/^(1|true|yes|on)$/i.test(value)) return true;
    if (/^(0|false|no|off)$/i.test(value)) return false;
    fail(2, key + ": expected on or off, got " + JSON.stringify(value));
  }
  return value;
}
if (mode === "load") {
  const file = process.argv[2];
  const raw = readRaw(file);
  const seeded = raw === null;
  const parsed = seeded ? {} : raw;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail(3, file + " must contain a JSON object");
  const unknown = Object.keys(parsed).filter((k) => !KEYS.includes(k));
  if (unknown.length) fail(2, "unknown config field(s): " + unknown.join(", ") + " — valid fields: " + KEYS.join(", "));
  const cfg = {};
  for (const k of KEYS) cfg[k] = k in parsed ? parsed[k] : DEFAULTS[k];
  const problems = validate(cfg);
  if (problems.length) fail(2, "invalid configuration (" + file + "): " + problems.join("; "));
  if (seeded) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  }
  const lines = seeded ? [["__seeded", "1"]] : [];
  for (const k of KEYS) lines.push([k, String(cfg[k])]);
  process.stdout.write(lines.map((pair) => pair.join("\t")).join("\n") + "\n");
} else if (mode === "save") {
  const file = process.argv[2];
  const pairs = process.argv.slice(3);
  const raw = readRaw(file);
  const parsed = raw === null ? {} : raw;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail(3, file + " must contain a JSON object");
  const unknown = Object.keys(parsed).filter((k) => !KEYS.includes(k));
  if (unknown.length) fail(2, "unknown config field(s): " + unknown.join(", ") + " — valid fields: " + KEYS.join(", "));
  const cfg = {};
  for (const k of KEYS) cfg[k] = k in parsed ? parsed[k] : DEFAULTS[k];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) fail(2, "expected key=value, got " + JSON.stringify(pair));
    const alias = pair.slice(0, eq);
    const key = ALIASES[alias] ?? (KEYS.includes(alias) ? alias : null);
    if (!key) fail(2, "unknown key " + JSON.stringify(alias) + " — valid keys: " + Object.keys(ALIASES).join(", "));
    cfg[key] = coerce(key, pair.slice(eq + 1));
  }
  const problems = validate(cfg);
  if (problems.length) fail(2, "invalid configuration (" + file + "): " + problems.join("; "));
  // Normalize the engine URL at save: scheme-less input is completed here so
  // the SAVED config is already http(s):// and every later read (boot banner,
  // app settings write) sees a fully-qualified URL.
  cfg.engineUrl = completeScheme(String(cfg.engineUrl ?? ""));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
} else if (mode === "engine") {
  const home = process.argv[2];
  const url = process.argv[3];
  if (url === "") process.exit(0);
  const completed = completeScheme(url);
  const file = path.join(home, "settings.json");
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") fail(4, file + " is not valid JSON: " + error.message); }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) fail(4, file + " must contain a JSON object");
  if (settings.comfyUrl === completed) process.exit(0);
  settings.comfyUrl = completed;
  fs.mkdirSync(home, { recursive: true });
  const staged = file + ".tmp";
  fs.writeFileSync(staged, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(staged, file);
  process.stdout.write(file + "\n");
} else if (mode === "readengine") {
  const home = process.argv[2];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    if (typeof settings.comfyUrl === "string" && settings.comfyUrl !== "") {
      process.stdout.write(settings.comfyUrl + "\n");
      process.exit(0);
    }
  } catch { /* fall through to the app default */ }
  process.stdout.write(DEFAULT_ENGINE + "\n");
} else if (mode === "probe") {
  const net = require("net");
  const portNumber = Number(process.argv[2]);
  const host = process.argv[3] || "0.0.0.0";
  const server = net.createServer();
  server.once("error", (error) => {
    process.stderr.write(String(error.code || error.message) + "\n");
    process.exit(error.code === "EADDRINUSE" ? 10 : 11);
  });
  server.listen(portNumber, host, () => { server.close(() => process.exit(0)); });
} else if (mode === "gentoken") {
  const home = process.argv[2];
  const token = crypto.randomUUID().replace(/-/g, "");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "lan-access-token.txt"), token, { mode: 0o600 });
  process.stdout.write(token + "\n");
} else {
  fail(2, "internal: unknown mode " + JSON.stringify(mode));
}
'

# --- config state ------------------------------------------------------------
CFG_PORT=""; CFG_HOST=""; CFG_HTTPS=""; CFG_TOKEN=""; CFG_QR=""; CFG_DATA_DIR=""
CFG_ENGINE_URL=""; CFG_LOG_LEVEL=""; CFG_DEV=""; CFG_PRETTY=""; CFG_SMAPS=""
CFG_VITE_PORT=""; CFG_DBG=""
SEEDED=0

config_load() {
  command -v node >/dev/null 2>&1 || die "node is not on PATH — Node 20+ is required"
  LAUNCHER_TSV=$(node -e "$LAUNCHER_JS" load "$CONFIG_FILE") || {
    echo "$PROG: refusing to boot — fix the field named above (./start.sh --set <key>=<value> repairs one field), or edit $CONFIG_FILE" >&2
    exit 1
  }
  LAUNCHER_TMP="${TMPDIR:-/tmp}/minimax-launcher.$$"
  printf '%s\n' "$LAUNCHER_TSV" > "$LAUNCHER_TMP" || die "cannot write $LAUNCHER_TMP (is TMPDIR writable?)"
  while IFS="	" read -r launcher_key launcher_value; do
    case $launcher_key in
      __seeded) SEEDED=1 ;;
      port) CFG_PORT=$launcher_value ;;
      host) CFG_HOST=$launcher_value ;;
      https) CFG_HTTPS=$launcher_value ;;
      token) CFG_TOKEN=$launcher_value ;;
      qrPrint) CFG_QR=$launcher_value ;;
      dataDir) CFG_DATA_DIR=$launcher_value ;;
      engineUrl) CFG_ENGINE_URL=$launcher_value ;;
      logLevel) CFG_LOG_LEVEL=$launcher_value ;;
      dev) CFG_DEV=$launcher_value ;;
      prettyLogs) CFG_PRETTY=$launcher_value ;;
      sourceMaps) CFG_SMAPS=$launcher_value ;;
      vitePort) CFG_VITE_PORT=$launcher_value ;;
      dbg) CFG_DBG=$launcher_value ;;
    esac
  done < "$LAUNCHER_TMP"
  rm -f "$LAUNCHER_TMP"
}

truthy() { case $1 in 1|true|yes|on|TRUE|YES|ON) return 0 ;; *) return 1 ;; esac; }

# --- runtime resolution (an env var set by the caller wins over the config) --
R_PORT=""; R_HOST=""; R_HOME=""; R_TOKEN_ON=0; R_HTTPS_ON=1; R_LOG=""; R_VITE_PORT=""

resolve_runtime() {
  R_PORT=${MINIMAX_LAN_PORT:-$CFG_PORT}
  R_HOST=${MINIMAX_LAN_HOST:-$CFG_HOST}
  R_LOG=${MINIMAX_LOG_LEVEL:-$CFG_LOG_LEVEL}
  R_VITE_PORT=${MINIMAX_VITE_PORT:-$CFG_VITE_PORT}
  if [ -n "${MINIMAX_STUDIO_HOME:-}" ]; then
    R_HOME=$MINIMAX_STUDIO_HOME
  elif [ -n "$CFG_DATA_DIR" ]; then
    R_HOME=$CFG_DATA_DIR
  else
    R_HOME=$(node -e 'console.log(require("os").homedir())')/.minimax-studio ||
      die "cannot resolve the home directory"
  fi
  truthy "${MINIMAX_LAN_TOKEN:-}" && R_TOKEN_ON=1
  [ "${MINIMAX_LAN_TOKEN:-}" = "" ] && truthy "$CFG_TOKEN" && R_TOKEN_ON=1
  R_HTTPS_ON=1
  if truthy "${MINIMAX_NO_HTTPS:-}" ; then R_HTTPS_ON=0
  elif [ "${MINIMAX_NO_HTTPS:-}" = "" ] && [ "$CFG_HTTPS" = "false" ]; then R_HTTPS_ON=0
  fi
}

engine_url_now() { node -e "$LAUNCHER_JS" readengine "$1"; }

# --- guards ------------------------------------------------------------------
port_holder_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -tnP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$1"/tcp 2>/dev/null
  fi
}

guard_port_free() { # $1 port $2 what $3 config key for the fix hint
  PROBE_ERR=$(node -e "$LAUNCHER_JS" probe "$1" "$R_HOST" 2>&1) && return 0
  PROBE_STATUS=$?
  echo "$PROG: the $2 port $1 is not available ($PROBE_ERR)." >&2
  HOLDER=$(port_holder_pid "$1")
  if [ -n "${HOLDER:-}" ]; then
    HOLDER_NAME=$(ps -p "$HOLDER" -o comm= 2>/dev/null || echo unknown)
    echo "  held by PID $HOLDER ($HOLDER_NAME) — the launcher never kills existing processes." >&2
  else
    echo "  the holding PID could not be identified on this machine." >&2
  fi
  echo "  change it with: ./start.sh --set $3=<free-port>  (or ./start.sh --configure)" >&2
  return "$PROBE_STATUS"
}

# Pull-change detection (maintainer 2026-09-19: "should automatically install
# and build if it detects that a pull has happened"): compare the newest
# source mtime against the newest build-output mtime. If any source file
# (src/ server/ scripts/ index.html vite.config.ts package.json
# pnpm-lock.yaml) is NEWER than both dist/ and dist-server/ outputs, a pull
# (or edit) landed after the last build. git-less checkouts work too — it is
# pure mtimes. Cheap: a bounded find over the source roots.
newest_mtime() { # $@ roots — prints the newest file mtime, empty if none
  find "$@" -type f -newer "$SCRIPT_DIR/start.sh" -printf '%T@\n' 2>/dev/null | sort -rn | head -n 1
}
build_stale() {
  [ -f dist/index.html ] && [ -f dist-server/server/index.js ] || return 0 # missing = the existing checks handle it
  SRC_NEWEST=$(find "$SCRIPT_DIR/src" "$SCRIPT_DIR/server" "$SCRIPT_DIR/scripts" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.cjs' \) -printf '%T@\n' 2>/dev/null | sort -rn | head -n 1)
  [ -z "$SRC_NEWEST" ] && return 1
  for marker in "$SCRIPT_DIR/index.html" "$SCRIPT_DIR/vite.config.ts" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/pnpm-lock.yaml"; do
    [ -f "$marker" ] || continue
    M=$(stat -c '%Y' "$marker" 2>/dev/null || echo '')
    [ -n "$M" ] && [ "$M" -gt "${SRC_NEWEST%.*}" ] && SRC_NEWEST="$M.0"
  done
  DIST_NEWEST=$(find "$SCRIPT_DIR/dist" "$SCRIPT_DIR/dist-server" -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -n 1)
  [ -z "$DIST_NEWEST" ] && return 0
  # A source newer than the newest build output = stale build.
  [ "${SRC_NEWEST%.*}" -gt "${DIST_NEWEST%.*}" ]
}

check_pull_freshness() { # $1 = "true" when booting the dev pipeline (server-only refresh)
  FRESH_MODE="${1:-false}"
  # Dependency drift: a pulled lockfile newer than node_modules = re-install.
  if [ -d "$SCRIPT_DIR/node_modules" ] && [ -f "$SCRIPT_DIR/pnpm-lock.yaml" ]; then
    LOCK_MTIME=$(stat -c '%Y' "$SCRIPT_DIR/pnpm-lock.yaml" 2>/dev/null || echo 0)
    NM_MTIME=$(stat -c '%Y' "$SCRIPT_DIR/node_modules" 2>/dev/null || echo 0)
    if [ "$LOCK_MTIME" -gt "$NM_MTIME" ]; then
      echo "$PROG: dependencies changed since the last install (pnpm-lock.yaml is newer than node_modules/) — pulling updated a dependency."
      AUTO_ACT "pnpm install" "install the updated dependencies" || return 1
    fi
  fi
  # Build staleness: sources newer than the built outputs = a pull landed.
  # Dev boots node --watch against dist-server immediately, so a stale
  # dist-server serves the PREVIOUS build through tsc --watch's initial
  # compile window — refresh it first. Dev refreshes the server only (vite
  # serves the UI from source); production does the full build.
  if build_stale; then
    echo "$PROG: sources changed since the last build (a pull or edit landed after dist/ was built)."
    if [ "$FRESH_MODE" = "true" ]; then
      AUTO_ACT "pnpm run build:server" "recompile the server (dev mode)" || return 1
    else
      AUTO_ACT "pnpm build" "rebuild" || return 1
    fi
  fi
  return 0
}

AUTO_ACT() { # $1 command, $2 description — run automatically (maintainer's ask); interactive confirm when a TTY, auto-yes otherwise (CI/scripts). POSIX sh: positional only, no `local`.
  AUTO_CMD="$1"; AUTO_DESC="$2"
  command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH — install it first (https://pnpm.io)"
  if [ -t 0 ]; then
    printf 'Run "%s" to %s now? [Y/n] ' "$AUTO_CMD" "$AUTO_DESC"
    ANSWER=""
    read -r ANSWER || true
    case $ANSWER in n|N|no|No|NO) return 1 ;; esac
  else
    echo "$PROG: running '$AUTO_CMD' automatically to $AUTO_DESC..."
  fi
  (cd "$SCRIPT_DIR" && $AUTO_CMD) || die "$AUTO_CMD failed"
  return 0
}

check_node_and_deps() {
  command -v node >/dev/null 2>&1 || die "node is not on PATH — Node 20+ is required"
  [ -d "$SCRIPT_DIR/node_modules" ] && return 0
  echo "$PROG: dependencies are not installed (node_modules/ is missing in $SCRIPT_DIR)."
  echo "  install them with: pnpm install"
  if [ -t 0 ]; then
    printf 'Run "pnpm install" now? [y/N] '
    ANSWER=""
    read -r ANSWER || true
    case $ANSWER in
      y|Y|yes|Yes|YES)
        command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH — install it first (https://pnpm.io)"
        pnpm install || die "pnpm install failed"
        [ -d "$SCRIPT_DIR/node_modules" ] && return 0
        die "pnpm install finished but node_modules/ is still missing"
        ;;
    esac
  fi
  return 1
}

check_prod_build() {
  { [ -f dist/index.html ] && [ -f dist-server/server/index.js ]; } && return 0
  echo "$PROG: the production build is missing (dist/ or dist-server/)."
  echo "  build it with: pnpm build"
  if [ -t 0 ]; then
    printf 'Run "pnpm build" now? [y/N] '
    ANSWER=""
    read -r ANSWER || true
    case $ANSWER in
      y|Y|yes|Yes|YES)
        command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH — install it first (https://pnpm.io)"
        pnpm build || die "pnpm build failed"
        { [ -f dist/index.html ] && [ -f dist-server/server/index.js ]; } && return 0
        die "pnpm build finished but the build output is still missing"
        ;;
    esac
  fi
  return 1
}

# --- banner ------------------------------------------------------------------
display_host() {
  case $R_HOST in
    ""|0.0.0.0|::) echo 127.0.0.1 ;;
    *) echo "$R_HOST" ;;
  esac
}

print_banner() {
  BANNER_HOST=$(display_host)
  if [ "$R_HTTPS_ON" = 1 ]; then BANNER_SCHEME=https; BANNER_HTTPS=on; else BANNER_SCHEME=http; BANNER_HTTPS=off; fi
  if [ "$R_TOKEN_ON" = 1 ]; then BANNER_TOKEN=on; else BANNER_TOKEN=off; fi
  BANNER_ENGINE=$(engine_url_now "$R_HOME")
  echo "===================================================="
  echo " MiniMax Studio launcher"
  echo "----------------------------------------------------"
  if [ "$CFG_DEV" = "true" ]; then
    echo " mode:    dev — vite dev server + node --watch"
    echo " api:     $BANNER_SCHEME://$BANNER_HOST:$R_PORT"
    echo " ui:      http://127.0.0.1:$R_VITE_PORT"
    echo " pretty:  $([ "$CFG_PRETTY" = "true" ] && echo on || echo off) (pino-pretty)"
  else
    echo " mode:    production (built server)"
    echo " open:    $BANNER_SCHEME://$BANNER_HOST:$R_PORT"
  fi
  echo " home:    $R_HOME"
  echo " engine:  $BANNER_ENGINE"
  echo " https:   $BANNER_HTTPS   token: $BANNER_TOKEN   bind: $R_HOST"
  echo " log:     $R_LOG"
  echo " config:  $CONFIG_FILE$([ "$SEEDED" = 1 ] && echo '  (seeded on first run)')"
  echo "===================================================="
  if [ "$CFG_DEV" = "true" ]; then
    echo "launcher: mode=dev port=$R_PORT vite-port=$R_VITE_PORT home=$R_HOME engine=$BANNER_ENGINE https=$BANNER_HTTPS token=$BANNER_TOKEN bind=$R_HOST log=$R_LOG pretty=$([ "$CFG_PRETTY" = "true" ] && echo on || echo off) config=$CONFIG_FILE$([ "$SEEDED" = 1 ] && echo ' seeded=1')"
  else
    echo "launcher: mode=prod port=$R_PORT home=$R_HOME engine=$BANNER_ENGINE https=$BANNER_HTTPS token=$BANNER_TOKEN bind=$R_HOST log=$R_LOG config=$CONFIG_FILE$([ "$SEEDED" = 1 ] && echo ' seeded=1')"
  fi
}

print_token_block() {
  [ "$R_TOKEN_ON" = 1 ] || return 0
  TOKEN_FILE="$R_HOME/lan-access-token.txt"
  if [ ! -r "$TOKEN_FILE" ]; then
    echo "token:    required — generated on first boot; re-run to print it with its QR"
    return 0
  fi
  TOKEN_VALUE=$(tr -d " \t\r\n" < "$TOKEN_FILE")
  [ -n "$TOKEN_VALUE" ] || return 0
  BANNER_SCHEME=http; [ "$R_HTTPS_ON" = 1 ] && BANNER_SCHEME=https
  BANNER_HOST=$(display_host)
  echo "token:    $TOKEN_VALUE"
  echo "local:    $BANNER_SCHEME://$BANNER_HOST:$R_PORT/?token=$TOKEN_VALUE"
  LAN_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9][0-9.]*\).*/\1/p' | head -n 1)
  # (mobile=1 dropped 2026-09-20 with the Phase-0 mobile-companion removal —
  # every device now gets the full studio, so the token URL points at the app root)
  TOKEN_URL="$BANNER_SCHEME://$BANNER_HOST:$R_PORT/?token=$TOKEN_VALUE"
  if [ -n "$LAN_IP" ]; then
    TOKEN_URL="$BANNER_SCHEME://$LAN_IP:$R_PORT/?token=$TOKEN_VALUE"
    echo "lan:      $TOKEN_URL"
  fi
  if [ "$CFG_QR" = "true" ] && command -v qrencode >/dev/null 2>&1; then
    qrencode -t ANSIUTF8 -m 2 -- "$TOKEN_URL" 2>/dev/null || true
  fi
}

# --- configuration UI --------------------------------------------------------
# whiptail when present and attached to a terminal; plain prompts otherwise
# (force either with MINIMAX_START_TUI=whiptail|prompts). Both renderers share
# the field list and the save path, so the prompts flow doubles as the
# scriptable/CI-testable surface.
pick_tui() {
  TUI=prompts
  case ${MINIMAX_START_TUI:-auto} in
    prompts) return 0 ;;
    whiptail) TUI=whiptail; return 0 ;;
    auto) ;;
    *) die "MINIMAX_START_TUI must be whiptail, prompts, or auto" ;;
  esac
  if command -v whiptail >/dev/null 2>&1 && [ -t 0 ]; then
    TUI=whiptail
  elif command -v whiptail >/dev/null 2>&1 && [ -t 1 ]; then
    TUI=whiptail
  fi
}

prompt_line() { # $1 label+hint (caller formats), $2 default -> PROMPT_VALUE
  printf '%s [%s]: ' "$1" "$2"
  PROMPT_VALUE=""
  read -r PROMPT_VALUE || true
}

prompt_bool() { # $1 label, $2 current (true/false) -> PROMPT_BOOL (true/false), aborts on junk
  CURRENT=$2
  prompt_line "$1 (y/n)" "$( [ "$CURRENT" = "true" ] && echo y || echo n )"
  case $PROMPT_VALUE in
    "") PROMPT_BOOL=$CURRENT ;;
    y|Y|yes|Yes|YES|1|true) PROMPT_BOOL=true ;;
    n|N|no|No|NO|0|false) PROMPT_BOOL=false ;;
    *) die "invalid answer for $1: $PROMPT_VALUE (expected y/n)" ;;
  esac
}

wt_cancel() {
  echo "$PROG: configuration cancelled — nothing was saved."
  exit 0
}

wt_input() { # $1 title $2 prompt $3 default -> WT_VALUE (empty cancels via status)
  WT_VALUE=$(whiptail --title "$1" --inputbox "$2" 10 72 "$3" 3>&1 1>&2 2>&3) || wt_cancel
}

wt_menu() { # $1 title $2 prompt $3 default, then tag/description pairs
  WT_TITLE=$1; WT_PROMPT=$2; WT_DEFAULT=$3; shift 3
  WT_VALUE=$(whiptail --title "$WT_TITLE" --default-item "$WT_DEFAULT" --menu "$WT_PROMPT" 18 72 4 "$@" 3>&1 1>&2 2>&3) || wt_cancel
}

run_configure() { # $1 show_dev (0/1)
  SHOW_DEV=$1
  W_PORT=$CFG_PORT; W_HOST=$CFG_HOST; W_HTTPS=$CFG_HTTPS; W_TOKEN=$CFG_TOKEN; W_QR=$CFG_QR
  W_DATA_DIR=$CFG_DATA_DIR; W_ENGINE_URL=$CFG_ENGINE_URL; W_LOG_LEVEL=$CFG_LOG_LEVEL
  W_DEV=$CFG_DEV; W_PRETTY=$CFG_PRETTY; W_SMAPS=$CFG_SMAPS; W_VITE_PORT=$CFG_VITE_PORT; W_DBG=$CFG_DBG
  REGEN_TOKEN=0

  while :; do
    if [ "$TUI" = "whiptail" ]; then
      wt_input "LAN port" "Port the studio serves on (1024-65535)." "$W_PORT"; W_PORT=$WT_VALUE
      wt_menu "Token mode" "Require a LAN access token?" "$( [ "$W_TOKEN" = "true" ] && echo on || echo off )" \
        off "open on the LAN (as before)" on "require ?token=… on every request"
      W_TOKEN=$( [ "$WT_VALUE" = "on" ] && echo true || echo false )
      if [ "$W_TOKEN" = "true" ]; then
        wt_menu "Token QR" "Print a QR code for the token URL at boot?" "$( [ "$W_QR" = "true" ] && echo on || echo off )" \
          on "print QR (needs qrencode)" off "no QR"
        W_QR=$( [ "$WT_VALUE" = "on" ] && echo true || echo false )
        wt_menu "Regenerate token" "Generate a fresh LAN token now?" off \
          no "keep the existing token" yes "rotate now (written to the studio home)"
        REGEN_TOKEN=$( [ "$WT_VALUE" = "yes" ] && echo 1 || echo 0 )
      fi
      wt_input "Data directory" "MINIMAX_STUDIO_HOME — where settings/data live.\nEmpty = default (~/.minimax-studio). Absolute path." "$W_DATA_DIR"; W_DATA_DIR=$WT_VALUE
      wt_input "Engine URL" "ComfyUI address. Written to <home>/settings.json on save\n(leave as-is to keep the app Settings value)." "$W_ENGINE_URL"; W_ENGINE_URL=$WT_VALUE
      wt_menu "HTTPS" "Serve over HTTPS (self-signed)?" "$( [ "$W_HTTPS" = "true" ] && echo on || echo off )" \
        on "https by default (PWA install, no cleartext tokens)" off "plain http (--no-https)"
      W_HTTPS=$( [ "$WT_VALUE" = "on" ] && echo true || echo false )
      wt_input "Bind host" "0.0.0.0 = reachable on the LAN (default).\n127.0.0.1 = local only." "$W_HOST"; W_HOST=$WT_VALUE
      wt_menu "Log level" "Server log level." "$W_LOG_LEVEL" \
        fatal "failures only" error "errors (server failure path)" warn "warnings" info "normal operation" debug "tolerated swallows + diagnostics" trace "everything"
      W_LOG_LEVEL=$WT_VALUE
      if [ "$SHOW_DEV" = "1" ]; then
        wt_menu "Dev mode" "Boot the dev pipeline (vite + node --watch) instead of the built server?" "$( [ "$W_DEV" = "true" ] && echo on || echo off )" \
          on "pnpm dev pipeline (HMR, no build needed)" off "production build"
        W_DEV=$( [ "$WT_VALUE" = "on" ] && echo true || echo false )
        if [ "$W_DEV" = "true" ]; then
          wt_menu "Pretty logs" "Pipe server logs through pino-pretty?" "$( [ "$W_PRETTY" = "true" ] && echo on || echo off )" \
            on "colorized single-line logs" off "raw JSON (as production)"
          W_PRETTY=$( [ "$WT_VALUE" = "on" ] && echo true || echo false )
          wt_menu "Source maps" "Map stack traces to the TS sources (--enable-source-maps)?" "$( [ "$W_SMAPS" = "true" ] && echo on || echo off )" \
            on "mapped traces" off "compiled-file traces"
          W_SMAPS=$( [ "$WT_VALUE" = "on" ] && echo true || echo false )
          wt_menu "Junction logging" "Start the renderer's dbg() junction logger hot at boot (MINIMAX_DBG=1 — the console becomes a triage transcript)?" "$( [ "$W_DBG" = "true" ] && echo on || echo off )" \
            on "junction logging on at boot" off "off (?dbg=1 still enables per-session)"
          W_DBG=$( [ "$WT_VALUE" = "on" ] && echo true || echo false )
          wt_input "Vite port" "Dev UI port for the vite server (1024-65535, must differ from the LAN port)." "$W_VITE_PORT"; W_VITE_PORT=$WT_VALUE
        fi
      fi
      SUMMARY="Save this configuration?
 port=$W_PORT  token=$W_TOKEN  https=$W_HTTPS  bind=$W_HOST
 home=${W_DATA_DIR:-<default>}  engine=${W_ENGINE_URL:-<keep>}
 log=$W_LOG_LEVEL"
      if [ "$SHOW_DEV" = "1" ]; then
        SUMMARY="$SUMMARY
 dev=$W_DEV  pretty=$W_PRETTY  maps=$W_SMAPS  vite=$W_VITE_PORT  dbg=$W_DBG"
      fi
      if ! whiptail --title "Confirm" --yesno "$SUMMARY" 16 72; then continue; fi
    else
      echo "MiniMax Studio configuration (enter keeps the value in brackets):"
      prompt_line "LAN port" "$W_PORT"; [ -n "$PROMPT_VALUE" ] && W_PORT=$PROMPT_VALUE
      prompt_bool "Require a LAN access token" "$W_TOKEN"; W_TOKEN=$PROMPT_BOOL
      if [ "$W_TOKEN" = "true" ]; then
        prompt_bool "Print a QR code for the token URL at boot" "$W_QR"; W_QR=$PROMPT_BOOL
        prompt_bool "Regenerate the token now" "false"; REGEN_TOKEN=$( [ "$PROMPT_BOOL" = "true" ] && echo 1 || echo 0 )
      fi
      prompt_line "Data directory (empty = default ~/.minimax-studio)" "$W_DATA_DIR"; W_DATA_DIR=$PROMPT_VALUE
      prompt_line "Engine URL (written to <home>/settings.json on save)" "$W_ENGINE_URL"; W_ENGINE_URL=$PROMPT_VALUE
      prompt_bool "HTTPS" "$W_HTTPS"; W_HTTPS=$PROMPT_BOOL
      prompt_line "Bind host (0.0.0.0 = LAN, 127.0.0.1 = local only)" "$W_HOST"; [ -n "$PROMPT_VALUE" ] && W_HOST=$PROMPT_VALUE
      prompt_line "Log level (fatal|error|warn|info|debug|trace)" "$W_LOG_LEVEL"; [ -n "$PROMPT_VALUE" ] && W_LOG_LEVEL=$PROMPT_VALUE
      if [ "$SHOW_DEV" = "1" ]; then
        prompt_bool "Dev mode (vite + node --watch pipeline)" "$W_DEV"; W_DEV=$PROMPT_BOOL
        if [ "$W_DEV" = "true" ]; then
          prompt_bool "Pretty logs (pino-pretty)" "$W_PRETTY"; W_PRETTY=$PROMPT_BOOL
          prompt_bool "Source-map stack traces" "$W_SMAPS"; W_SMAPS=$PROMPT_BOOL
          prompt_bool "Junction logging (renderer dbg() hot at boot)" "$W_DBG"; W_DBG=$PROMPT_BOOL
          prompt_line "Vite dev-server port" "$W_VITE_PORT"; [ -n "$PROMPT_VALUE" ] && W_VITE_PORT=$PROMPT_VALUE
        fi
      fi
      prompt_line "Save this configuration? (y/n)" "y"
      case $PROMPT_VALUE in
        ""|y|Y|yes|Yes|YES) ;;
        *) echo "$PROG: configuration cancelled — nothing was saved."; exit 0 ;;
      esac
    fi

    # One atomic validated save of every field (validate-before-write).
    if SAVE_ERR=$(node -e "$LAUNCHER_JS" save "$CONFIG_FILE" \
        "port=$W_PORT" "host=$W_HOST" "https=$W_HTTPS" "token=$W_TOKEN" "qrPrint=$W_QR" \
        "dataDir=$W_DATA_DIR" "engineUrl=$W_ENGINE_URL" "logLevel=$W_LOG_LEVEL" \
        "dev=$W_DEV" "prettyLogs=$W_PRETTY" "sourceMaps=$W_SMAPS" "vitePort=$W_VITE_PORT" "dbg=$W_DBG" 2>&1); then
      break
    fi
    echo "$SAVE_ERR" >&2
    if [ "$TUI" = "whiptail" ]; then
      whiptail --title "Invalid configuration" --msgbox "$SAVE_ERR" 14 72 || true
      continue
    fi
    die "configuration not saved — fix the field named above and re-run --configure"
  done

  if [ "$REGEN_TOKEN" = "1" ]; then
    node -e "$LAUNCHER_JS" gentoken "$R_HOME" || die "could not write the token file"
    echo "launcher: LAN token regenerated ($R_HOME/lan-access-token.txt)"
  fi
  # A changed non-empty engine URL is written to the app settings (the single
  # source of truth); empty keeps whatever the app already has. BUG FIX
  # (maintainer 2026-09-19: "did not load the config as set previously"):
  # this used $R_HOME, which still reflects the OLD config's data dir at this
  # point (config_load + resolve_runtime re-run only AFTER run_configure
  # returns) — a changed data directory sent the engine URL to the wrong
  # home. Resolve the JUST-SAVED data dir here instead.
  ENGINE_HOME=$W_DATA_DIR
  [ -z "$ENGINE_HOME" ] && ENGINE_HOME=$(node -e 'console.log(require("os").homedir())')/.minimax-studio
  # set -u guard (maintainer hit 2026-09-22: "MINIMAX_STUDIO_HOME: unbound
  # variable" at this line when the env var is simply unset — the defensive
  # :- expansion everywhere else in this script is the pattern; this one
  # slipped through).
  [ -n "${MINIMAX_STUDIO_HOME:-}" ] && ENGINE_HOME="${MINIMAX_STUDIO_HOME}"
  ENGINE_WRITTEN=$(node -e "$LAUNCHER_JS" engine "$ENGINE_HOME" "$W_ENGINE_URL") || die "could not update the engine URL"
  [ -n "$ENGINE_WRITTEN" ] && echo "launcher: engine URL written to $ENGINE_WRITTEN"
}

# --- boot --------------------------------------------------------------------
boot_prod() {
  exec node dist-server/server/index.js
}

boot_dev() {
  if [ ! -f dist-server/server/index.js ]; then
    echo "launcher: compiling the server once for watch mode (pnpm build:server)..."
    command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH — install it first (https://pnpm.io)"
    pnpm run build:server || die "pnpm build:server failed"
  fi
  # Terminal hygiene (maintainer flag 2026-09-19: "Ctrl+C leaves the terminal
  # in a dirty state, key presses become raw unicode; I have to hit enter once
  # more to full quit"): the watch-mode children (vite, tsc, node --watch)
  # each put the tty in raw mode and hold stdin; killing them without waiting
  # leaves the tty raw and a pending read. Snapshot the state before boot,
  # restore it after teardown.
  TTY_SAVED=$(stty -g 2>/dev/null || true)
  node_modules/.bin/tsc -p tsconfig.server.json --watch &
  DEV_TSC_PID=$!
  node_modules/.bin/vite --port "$R_VITE_PORT" --strictPort &
  DEV_VITE_PID=$!
  if [ "$CFG_SMAPS" = "true" ]; then
    node --enable-source-maps --watch dist-server/server/index.js &
  else
    node --watch dist-server/server/index.js &
  fi
  DEV_NODE_PID=$!
  # Teardown: kill the recorded children, give them a beat to actually exit
  # (so none still holds the tty when we restore it), then restore the saved
  # tty state. Idempotent — the trap and the normal-exit path both call it.
  cleanup_dev() {
    kill "$DEV_TSC_PID" "$DEV_VITE_PID" "$DEV_NODE_PID" 2>/dev/null
    _i=0
    while [ "$_i" -lt 20 ]; do
      kill -0 "$DEV_TSC_PID" 2>/dev/null || kill -0 "$DEV_VITE_PID" 2>/dev/null || kill -0 "$DEV_NODE_PID" 2>/dev/null || break
      sleep 0.1
      _i=$((_i + 1))
    done
    if [ -n "$TTY_SAVED" ]; then
      stty "$TTY_SAVED" 2>/dev/null || stty sane 2>/dev/null || true
    else
      stty sane 2>/dev/null || true
    fi
  }
  # All three PIDs are recorded, so a signal to THIS script (Ctrl-C delivers
  # to the whole foreground group anyway; a bare kill targets only the shell)
  # still tears the entire pipeline down. The trap runs cleanup and RETURNS —
  # wait then unblocks with the signal status and the normal path finishes
  # (a second, idempotent cleanup) and exits; exiting inside the trap left a
  # pending stdin read behind (the extra-Enter symptom).
  trap 'cleanup_dev' INT TERM
  wait "$DEV_NODE_PID"
  DEV_STATUS=$?
  cleanup_dev
  exit "$DEV_STATUS"
}

# --- main --------------------------------------------------------------------
DO_CONFIGURE=0 SHOW_DEV=0 DO_PRINT=0 SET_ARG=""
while [ $# -gt 0 ]; do
  case $1 in
    --configure) DO_CONFIGURE=1 ;;
    --dev) SHOW_DEV=1 ;;
    --print|--dry-run) DO_PRINT=1 ;;
    --set)
      [ $# -ge 2 ] || usage_error "--set needs a key=value argument"
      SET_ARG=$2
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown flag: $1" ;;
  esac
  shift
done

if [ -n "$SET_ARG" ]; then
  node -e "$LAUNCHER_JS" save "$CONFIG_FILE" "$SET_ARG" || die "not saved"
  echo "$PROG: saved $SET_ARG -> $CONFIG_FILE (run ./start.sh to boot, or ./start.sh --print to preview)"
  exit 0
fi

[ "$SHOW_DEV" = 1 ] && [ "$DO_CONFIGURE" = 0 ] && usage_error "--dev only applies to --configure (dev mode itself is a saved field: ./start.sh --configure --dev)"

config_load
if [ "$SEEDED" = 1 ]; then
  echo "$PROG: first run — seeded defaults at $CONFIG_FILE (dev mode ON per the 2026-09-19 decision; ./start.sh --configure to adjust)"
fi
resolve_runtime

if [ "$DO_CONFIGURE" = 1 ]; then
  pick_tui
  run_configure "$SHOW_DEV"
  config_load
  resolve_runtime
fi

print_banner
print_token_block

# Guards: everything below states problems honestly and never boots wrong.
check_node_and_deps || {
  [ "$DO_PRINT" = 1 ] && echo "launcher: dry run — boot would fail (dependencies missing)"
  exit 1
}

# Pull freshness (maintainer 2026-09-19; amended 2026-09-20: "the start
# script needs to rebuild even if I am in dev mode — it is starting based on
# the previous build"): after deps exist and before any boot, detect a pulled
# lockfile (re-install) and sources-newer-than-build (rebuild). Dev mode is
# NO LONGER skipped — the watch pipeline boots node --watch against
# dist-server IMMEDIATELY (tsc --watch's initial compile takes seconds), so
# a stale dist serves the previous build through that window; refreshing
# dist-server first closes it. In dev the refresh builds the SERVER only
# (vite serves the UI from source); production does the full build. Dry
# runs stay side-effect free.
if [ "$DO_PRINT" != 1 ]; then
  check_pull_freshness "${CFG_DEV}" || {
    echo "$PROG: refresh declined — booting the EXISTING build/dependencies as-is." >&2
  }
fi

guard_port_free "$R_PORT" "LAN" "port" || {
  [ "$DO_PRINT" = 1 ] && echo "launcher: dry run — boot would fail (port busy)"
  exit 1
}

if [ "$CFG_DEV" = "true" ]; then
  guard_port_free "$R_VITE_PORT" "vite" "vite-port" || {
    [ "$DO_PRINT" = 1 ] && echo "launcher: dry run — boot would fail (vite port busy)"
    exit 1
  }
else
  check_prod_build || {
    [ "$DO_PRINT" = 1 ] && echo "launcher: dry run — boot would fail (build missing)"
    exit 1
  }
fi

if [ "$DO_PRINT" = 1 ]; then
  echo "launcher: dry run (--print) — not booting. Plan:"
  if [ "$CFG_DEV" = "true" ]; then
    [ -f dist-server/server/index.js ] || echo "  [dev] pnpm run build:server   (once, for watch mode)"
    echo "  [dev] node_modules/.bin/tsc -p tsconfig.server.json --watch"
    if [ "$CFG_SMAPS" = "true" ]; then
      echo "  [dev] node --enable-source-maps --watch dist-server/server/index.js"
    else
      echo "  [dev] node --watch dist-server/server/index.js"
    fi
    echo "  [dev] node_modules/.bin/vite --port $R_VITE_PORT --strictPort"
  else
    echo "  [prod] node dist-server/server/index.js"
  fi
  exit 0
fi

mkdir -p -- "$R_HOME" || die "cannot create the data directory: $R_HOME"

export MINIMAX_STUDIO_HOME="$R_HOME"
export MINIMAX_LAN_PORT="$R_PORT"
export MINIMAX_LOG_LEVEL="$R_LOG"
[ "$R_TOKEN_ON" = 1 ] && export MINIMAX_LAN_TOKEN=1
[ "$R_HTTPS_ON" = 0 ] && export MINIMAX_NO_HTTPS=1
[ "$R_HOST" != "0.0.0.0" ] && export MINIMAX_LAN_HOST="$R_HOST"
[ "$CFG_DBG" = "true" ] && export MINIMAX_DBG=1
if [ "$CFG_DEV" = "true" ] && [ "$CFG_PRETTY" = "true" ] && [ -z "${MINIMAX_LOG_PRETTY:-}" ]; then
  export MINIMAX_LOG_PRETTY=1
fi

if [ "$CFG_DEV" = "true" ]; then
  boot_dev
else
  boot_prod
fi
