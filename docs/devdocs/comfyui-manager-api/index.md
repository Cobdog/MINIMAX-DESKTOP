# ComfyUI-Manager API — devdocs capture

> **DEVDOCS CAPTURE — internal reference. Never shipped, never vendored.**
> - **Source (primary):** upstream tag `4.2.2` of https://github.com/Comfy-Org/ComfyUI-Manager — files read verbatim: `comfyui_manager/__init__.py` (middleware + feature flag), `comfyui_manager/glob/manager_server.py` (the v4 route table, 2177 lines), `comfyui_manager/glob/manager_core.py` (referenced), `comfyui_manager/legacy/manager_server.py` (legacy route table), `comfyui_manager/data_models/generated_models.py` (request models), `comfyui_manager/common/manager_security.py`, `openapi.yaml` at the same tag. Cross-checked against the canonical shared install `/home/agent/comfyui` (v0.34.0, `a87667f`) — its root `manager_requirements.txt` pins `comfyui_manager==4.2.2`, and `server.py`/`comfy/cli_args.py` carry the `--enable-manager` integration points.
> - **Fetched:** 2026-09-20 (A-DOCS round 1, Flux qvofckv). **A newer tag `4.3` exists (2026-09-18, two days before this capture) — not yet diffed; treat 4.2.2 as the verified surface.**
> - **Pinned/verified revision:** Manager `4.2.2` (PyPI `comfyui-manager==4.2.2`, matching the shared install's pin) against ComfyUI core `0.34.0` / `a87667f`.
> - **License:** ComfyUI-Manager is **GPL-3.0**. API semantics documented for integration; no upstream source copied. Internal reference only.
> - **Local reliance:** directive ffcff765 (epic 4lphxv8) makes Manager-first the preferred node-pack install path for Wave 2's registry-only work — detection stays object_info-driven, installation prefers Manager when present, our consent-gated fetcher (`server/fetcher.ts`) second. NOTHING in our tree calls the Manager HTTP API today (verified by grep: no `/v2/manager`, `/customnode/install`, or manager-port references in `server/` or `src/`) — this capture is the forward-looking contract for that build. `server/enginePatch.ts` additionally follows Manager's core-file discipline (layout-detect/atomic/pristine) without calling its API.
> - **Verify-on triggers:** Manager version bump (4.2.2 → anything, 4.3 already out), ComfyUI core version change, BEFORE the Wave 2 Manager-first install build, any install-path symptom.

---

## 0. The distribution model (this changed upstream — read first)

ComfyUI-Manager 4.x is **a pip package, not a custom node**: `pip install comfyui_manager==4.2.2` (the shared install's root `manager_requirements.txt` is exactly this pin), activated with **`--enable-manager`** on the ComfyUI command line (`comfy/cli_args.py:161`; `--enable-manager-legacy-ui` implies it, `cli_args.py:297-299`). When enabled, `server.py:244-245` inserts `comfyui_manager.create_middleware()` into the aiohttp middleware stack, and the package's server module registers its routes via `routes = PromptServer.instance.routes` (`glob/manager_server.py:101`) — i.e. **on the same port as core, dual-mounted bare + `/api`-prefixed like every core route** (`server.py:1228-1240`).

Facts that matter to us:
- **`should_be_disabled`** (`__init__.py:71-84`): when the pip Manager is enabled it AUTO-DISABLES any legacy custom-node ComfyUI-Manager found in `custom_nodes/` (any directory containing "comfyui-manager"). One Manager per instance, the pip one wins.
- The shared install has the requirements pin but the package is **not installed in its venv** (site-packages verified 2026-09-20) and the maintainer's launcher does not pass `--enable-manager` — so **Manager endpoints are absent there today**. Presence must be PROBED, never assumed (see §5).
- The Manager sets the server feature flag `extension.manager.supports_csrf_post = true` (`__init__.py:9-21`, Manager ≥ 4.2.1) — i.e. **the core `/features` endpoint (and the WS `feature_flags` reply) is the presence probe**: `features.extension.manager` present ⇒ Manager middleware active.

## 1. Route surface (v4 / "glob" server — the default at 4.2.2)

All under the ComfyUI origin. Security-gated routes may 403 (see §4).

### Task queue — the install/uninstall mechanism
- **`POST /v2/manager/queue/task`** — queue ANY operation. Body = `QueueTaskItem` (pydantic-validated; 400 on validation error):
  ```jsonc
  {
    "ui_id": "<client-minted task id>",           // required
    "client_id": "<ws clientId>",                 // required — progress is WS-routed to it
    "kind": "install" | "uninstall" | "update" | "update-comfyui" | "fix" | "disable" | "enable" | "install-model",
    "params": { ...per-kind, below... }
  }
  ```
  Returns bare `200` (empty body) on queueing — the RESULT arrives via WS + history, not the response.
  - `install` params (`InstallPackParams` extends `ManagerPackInfo`): `{id: "<cnr registry name | github owner/repo>", version: "<semver | git sha | latest | nightly>", selected_version, repository?: "<git url, required for nightly>", pip?: [..], mode: "local"|"remote"|"cache", channel, skip_post_install?}` → executor `do_install` accepts actions `skip|enable|install-git|install-cnr|switch-cnr` as success.
  - `uninstall` params: `{node_name, is_unknown?: false}`.
  - `install-model` params (`ModelMetadata`): `{name, type, url, filename, base?, save_path?, ui_id?}` (also exposed directly as `POST /v2/manager/queue/install_model`, security-gated).
- **`GET /v2/manager/queue/status?client_id=`** — current queue state (`TaskStateMessage`: history, running/pending queues, installed packs).
- **`GET /v2/manager/queue/history?id=&client_id=&ui_id=&max_items=&offset=`** and **`GET /v2/manager/queue/history_list`** — batch history ids (newest first) + filtered task history (`TaskHistoryItem`: `{ui_id, client_id, kind, timestamp, result, status: {status_str: success|error, completed, messages}, batch_id, end_time, params}`).
- **`POST /v2/manager/queue/start`** / **`POST /v2/manager/queue/reset`** — drive the worker manually (queueing a task auto-starts it).
- **`POST /v2/manager/queue/update_all?mode=&client_id=&ui_id=`** (security-gated), **`POST /v2/manager/queue/update_comfyui`**.

### Installed-state + failure introspection
- **`GET /v2/customnode/installed?mode=default|imported`** — installed node packs (`core.get_installed_node_packs()`; `imported` = frozen at startup). Useful as install-verification; detection of record stays object_info per ffcff765.
- **`GET /v2/customnode/getmappings?mode=local|remote|cache`** — unified node→package mapping.
- **`GET /v2/customnode/fetch_updates?mode=`** — 200 = no updates, **201 = updates found**.
- **`POST /v2/customnode/import_fail_info`** body `{cnr_id? | url?}` (400 if neither) / **`..._bulk`** body `{cnr_ids?: [], urls?: []}` — WHY a node failed to import (maps to `cm_global.error_dict`).

### Snapshots, versions, config
- `GET /v2/snapshot/getlist` · `POST /v2/snapshot/remove?target=` · `POST /v2/snapshot/restore?target=` (both security-gated) · `GET /v2/snapshot/get_current` · `POST /v2/snapshot/save` — full custom-node-state snapshots for rollback around risky installs.
- `GET /v2/comfyui_manager/comfyui_versions` → `{versions: [], current}`; `POST /v2/comfyui_manager/comfyui_switch_version` body `{ver, client_id, ui_id}` (gated `high+`).
- `GET|POST /v2/manager/db_mode` `{value: "channel"|"local"|"remote"}` · `GET|POST /v2/manager/policy/update` `{value: "stable"|"nightly"|"nightly-comfyui"}` · `GET|POST /v2/manager/channel_url_list` `{value: "<channel>"}` · `POST /v2/manager/reboot` (restarts the whole server — security-gated) · `GET /v2/manager/version` (plain text) · `GET /v2/manager/is_legacy_manager_ui`.

### WS events pushed through the core socket
- **`cm-queue-status`** — task progress; `{status: "all-done"}` broadcast when the queue drains (`glob/manager_server.py:1140`, `:2100`). Per-client `TaskStateMessage` updates are also `send_sync`'d to the task's `client_id`.
- **`cm-api-try-install-customnode`** — remote-triggered install prompt (`cm_global.register_api("cm.try-install-custom-node", ...)`); a consent-relevant surface: foreign senders can ASK the UI to install — sanitize/verify before acting.

## 2. Legacy route table (`--enable-manager-legacy-ui` only)

The legacy server keeps the older direct verbs the internet mostly documents: `POST /v2/customnode/install/git_url` (body = bare URL text; 403 unless the dedicated `allow_git_url_install` config flag AND loopback/personal-cloud), `POST /v2/customnode/install/pip` (same pattern under `allow_pip_install`), `GET /v2/customnode/getlist`, `GET /v2/customnode/versions/{node_name}`, `GET /customnode/alternatives`, `GET /v2/externalmodel/getlist`. **Build against the v4 task-queue surface, not these** — the dedicated-flag gates are deliberately stricter and the legacy UI is opt-in.

## 3. Cache + versioning behavior (startup and beyond)

On boot (background thread, `default_cache_update`): fetches and locally caches five channel JSONs — `custom-node-list.json` (1.8 MB at this tag), `extension-node-map.json`, `model-list.json`, `alter-list.json`, `github-stats.json` — from the configured channel (default registry) into its cache dir keyed `hash(uri)_filename`; then `unified_manager.reload(...)` builds the CNR map. Implications: **first-boot and post-install Manager answers can lag the channel** (issue #2916 documents stale-cache confusion), `db_mode` `channel|local|remote` selects which database answers list calls, and offline mode still reloads without CNR updates. Pack identity is CNR registry name or `github-owner/repo`; versions are semver, git sha, `latest`, or `nightly` (nightly requires `repository`).

## 4. Security / consent-relevant notes

- **Middleware policy** (`create_middleware`, `__init__.py:87-130` + `common/manager_security.py`): tracks distinct client IPs; once MORE THAN ONE client has connected, a loopback-listening instance BANS further requests on handlers tagged `MULTIPLE_REMOTE_BAN_NON_LOCAL` (and `..._NOT_PERSONAL_CLOUD` unless `network_mode=personal_cloud`) — 403 "This request is banned." **Practical consequence for us: our server-side proxy sharing one loopback origin is the single-client case and is fine; a second LAN client appearing mid-session can trip remote-ban policies on marked routes.**
- **CSRF hardening** (`reject_simple_form_post`): mutation endpoints reject `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain` bodies (forces preflight-requiring content types). Use `application/json`.
- **OpenAPI security scheme:** sensitive routes (update_all, install_model, snapshot remove/restore, switch_version, reboot) declare an API-key `Security-Level` header; under default security config several of these answer 403 — the task queue (`POST /v2/manager/queue/task`) is the ungated install path of record.
- **Installs execute git clones + pip installs inside the engine process** and typically require a restart to take effect (the Manager broadcasts "After restarting ComfyUI, please refresh the browser" and offers `/v2/manager/reboot`). Our integration must treat Manager installs as *eventually-consistent*: queue → watch `cm-queue-status`/history → restart/refresh → re-pull object_info.

## 5. Integration recipe for the Wave 2 Manager-first path (per ffcff765)

1. **Probe presence:** `GET /features` → `extension.manager` flag set (≥4.2.1) ⇒ Manager active; absent ⇒ fall back to our fetcher. (Manager version via `GET /v2/manager/version`, plain text.)
2. **Install:** mint a `ui_id`, pass our engine-bridge `client_id`, `POST /v2/manager/queue/task` with `kind: "install"` and `{id, selected_version, mode, channel}`; correlate via `ui_id` on `GET /v2/manager/queue/history` and the `cm-queue-status` WS stream.
3. **Verify (not detect):** after the engine restarts, `/v2/customnode/installed` + the object_info class check together confirm the pack; detection of record remains object_info.
4. **Never** auto-accept `cm-api-try-install-customnode` prompts; route anything install-shaped through our own consent gate.

## 6. Source-of-truth check

Triggers listed in the header. Priority diffs on re-check: `glob/manager_server.py` route table vs this list, the `QueueTaskItem` model in `data_models/generated_models.py`, the presence probe (`extension.manager` feature flag), and the middleware remote-ban policy. Record dated addenda, never silent replacement.

---

## 7. Dated addendum — 2026-09-21 (the Manager-first build, task 0pktw5h)

Re-verified before/during the Wave 2 Manager-first build (tag reads of 4.2.2
via raw.githubusercontent + the compare range; local cross-checks against
`/home/agent/comfyui` at v0.34.0 / `a87667f`). Three findings, one of them
a correction to §5.1's shorthand:

1. **PRESENCE PROBE — §5.1's shorthand is corrected (§0's precise form
   stands).** Core ComfyUI 0.34.0 itself unconditionally answers
   `features.extension.manager.supports_v4 = true`
   (`comfy_api/feature_flags.py:105`, read from the shared install) — so
   "extension.manager present ⇒ Manager active" is FALSE at this pairing.
   The Manager-added key is the signal: 4.2.2's `__init__.py` does
   `_core_feature_flags.SERVER_FEATURE_FLAGS.setdefault('extension', {}).setdefault('manager', {})['supports_csrf_post'] = True`
   (an ImportError on older cores is swallowed). **The probe this repo
   builds with: `features.extension.manager.supports_csrf_post === true`.**
   The shared install serves only `supports_v4` (the pip Manager is absent
   from its venv) — the honest-absent test case is the DEFAULT state here.

2. **PIN LIMITATION — a git SHA is not expressible through the v2 queue for
   GitHub packs.** `glob/manager_core.py` `install_by_id` at 4.2.2: only
   `selected_version` `nightly`/`unknown` takes the git path — a clone of
   the default-branch HEAD, NO commit checkout (commit pinning exists only
   in the legacy `gitclone_install` `url@sha` form). Any other spec routes
   to the CNR branches: `'latest'` for a non-CNR pack is refused
   ("is not a CNR node"), and a 40-hex SHA cannot resolve. Consequence for
   the studio: Manager installs of our GitHub-hosted packs land at the
   repository's CURRENT HEAD — the studio's pinned SHA is honored only by
   the consent-gated fetcher. The Manager-first path states this caveat on
   every install (the pack board's version ladder attributes the landed
   folder "managed by ComfyUI" and relates its HEAD to the pin).

3. **The 4.3 diff (tag 2026-09-18, 4 commits) — no contract-surface
   changes.** Verified per commit: `69bc3ef` (flagged-CNR installs
   restricted to loopback-only listeners or the new
   `allow_flagged_nodepack_install` opt-in — inside the install executor,
   no route/model/event changes; our engines are loopback by the SSRF
   guard, so unaffected); `4ad94b2` (legacy-UI XSS hardening + a
   merged-config writer — `glob/manager_server.py` sees only a +4/−2
   import refactor, `data_models` and the probe flag untouched);
   `a0d89e9` (uv conflict attribution); `f764cc0` (version bump). Building
   against 4.2.2 semantics remains valid for 4.3.

Also verified while building (all at 4.2.2): the exact WS event-name
values (`ManagerMessageName`: `cm-task-started`, `cm-task-completed`,
`cm-queue-status` — targeted per-task events carry `ui_id` + the
`TaskExecutionStatus` verdict; `cm-queue-status` broadcasts
`{status:"all-done"}` on drain); `TaskHistoryItem` = `{ui_id, client_id,
kind, timestamp, result, status?: {status_str, completed, messages[]}}`;
`OperationResult` ∈ success|failed|skipped|error|skip; `ManagerChannel`
∈ default|recent|legacy|forked|dev|tutorial and `ManagerDatabaseSource` ∈
remote|local|cache (str-Enums); and the official UI itself posts to
`/v2/manager/queue/batch` with row data + `selected_version`/`channel`/
`mode`/`ui_id`/`skip_post_install` — the per-task `/queue/task` verb this
repo uses is the same QueueTaskItem model (route table confirmed at the
tag). `cm-api-try-install-customnode` remains remote-prompt-only: the
studio logs it and never surfaces an install affordance.
