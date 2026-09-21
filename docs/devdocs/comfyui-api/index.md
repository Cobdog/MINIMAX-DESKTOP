# ComfyUI HTTP + WebSocket API — devdocs capture

> **DEVDOCS CAPTURE — internal reference. Never shipped, never vendored.**
> - **Source (primary):** the canonical shared install's own code — `/home/agent/comfyui` (`server.py`, `execution.py`, `comfy_execution/progress.py`, `comfy_execution/jobs.py`, `app/model_manager.py`, `main.py`, `comfy/cli_args.py`), read verbatim. Upstream mirror: https://github.com/comfyanonymous/ComfyUI
> - **Fetched (read against):** 2026-09-20 (A-DOCS round 1, Flux qvofckv)
> - **Pinned/verified revision:** `a87667f72f5fad094b74b10dc9c9f82faea728ef` on `master` (commit dated 2026-09-02, "chore: update workflow templates to v0.11.54 (#16045)"); `__version__ = "0.34.0"` (`comfyui_version.py`)
> - **License:** ComfyUI is **GPL-3.0**. This file documents API *semantics* (endpoint shapes, event names) needed to integrate against it; no ComfyUI source is copied. Internal reference only — never redistributed as our docs product, never vendored.
> - **Local reliance:** the ENTIRE engine integration — `server/core.ts` (`comfyFetch` funnel: `/prompt`, `/queue`, `/interrupt`, `/history/{id}`, `/upload/image`, `/system_stats`, `/object_info`, `/models/{kind}`, `/free`), `server/realtime.ts` (the `/ws?clientId=` bridge and every normalized event type), `server/runtime.ts:501` (`/system_stats` adopt-probe), `server/instanceInventory.ts`, `server/engineNodes.ts` (object_info-driven inventory), `src/hooks/useGenerationQueue.ts` (history landing). The registry-only directive (epic 4lphxv8, 2987ef3e) rests on `/object_info` + `/models` semantics; A-8's incremental strategy rests on `/object_info/{node}`.
> - **Verify-on triggers:** any ComfyUI checkout/version change (the managed runtime nominates a user checkout — there is NO app-side pin; this capture's revision is the canonical shared install's), calendar quarter (this API moves constantly), any integration symptom (validation-shape drift, WS event changes, history/outputs shape changes).

---

This is a factual reference, quoted from the code at the revision above — signatures, not vibes. `server.py:LINE` references are against `a87667f`.

## 0. Base mechanics (everything else hangs off these)

- **Dual mounting:** every non-static route registered on the core route table is served at BOTH the bare path (`/prompt`) and the `/api`-prefixed path (`/api/prompt`) — `server.py:1228-1240` iterates `self.routes` and re-registers each under `"/api" + route.path`. Either form reaches the same handler.
- **Default CORS posture:** with no `--enable-cors-header`, the `origin_only_middleware` (`server.py:154-197`) answers `OPTIONS` freely but rejects requests whose `Host` and `Origin` domains mismatch (403) when the host is loopback. Our server-side `comfyFetch` funnel is unaffected (no browser Origin).
- **JSON responses:** aiohttp `web.json_response` everywhere; errors use `{"error": ..., "node_errors": ...}` bodies with 4xx status (see `/prompt`).
- **No auth of any kind** on core routes — the API assumes a trusted network. (Our app's SSRF/local-only guard lives on OUR side: `server/core.ts:164` `comfyFetch` refuses non-local service URLs.)

## 1. Prompt submission — `POST /prompt` (`server.py:1072-1144`)

Request body (JSON):

```jsonc
{
  "prompt": { "<node_id>": { "class_type": "...", "inputs": {...}, "_meta": {...} } },
  "client_id": "<uuid>",              // optional; copied into extra_data["client_id"] → becomes the WS targeting id
  "prompt_id": "<uuid>",              // OPTIONAL client-minted id; must be canonical lowercase hyphenated UUID
  "extra_data": { ... },              // arbitrary; server adds create_time (ms epoch) + client_id
  "number": 1.0,                      // optional explicit priority; else server counter (negated if front:true)
  "front": true,
  "partial_execution_targets": ["<node_id>", ...]   // optional; only these OUTPUT_NODEs execute
}
```

Server-side flow: `trigger_on_prompt` hooks → id resolution (`prompt_id` absent/null ⇒ server mints `uuid4`; present but not a canonical lowercase-hyphenated UUID ⇒ **400** `{"error": {"type": "invalid_prompt_id", "message": "prompt_id must be a valid UUID", ...}, "node_errors": {}}`, `server.py:1096-1104`) → `node_replace_manager.apply_replacements` → `execution.validate_prompt` → queue put.

**Success 200:** `{"prompt_id": "<uuid>", "number": <n>, "node_errors": {...}}` — note `node_errors` is present and NON-empty when validation passed with per-node warnings (valid[3]).

**Validation failure 400:** `{"error": <error>, "node_errors": <node_errors>}` (`server.py:1136`). The `error` object shape (`execution.py:1128-1174`):

```jsonc
{
  "type": "missing_node_type" | "prompt_no_outputs" | "prompt_has_validation_errors" | ...,
  "message": "Node '<title>' not found. The custom node may not be installed.",
  "details": "Node ID '#<id>'",
  "extra_info": { "node_id": "...", "class_type": "...", "node_title": "..." }
}
```

`node_errors` maps `node_id → { errors: [ {type, message, details, extra_info} ], ... }` per validated node (validation reasons include `value_not_in_list`-class input mismatches, `dependency_cycle` with `cycle_nodes`, `exception_during_validation` with traceback — `execution.py:846-870, 1183-1199`).

`extra_data` keys listed in `execution.SENSITIVE_EXTRA_DATA_KEYS` are stripped from the queue/history surface into a separate sensitive store (`server.py:1126-1129`).

## 2. Queue management

- **`GET /queue`** (`server.py:1064-1070`) → `{"queue_running": [[number, prompt_id, prompt, extra_data, outputs_to_execute], ...], "queue_pending": [...]}` — volatile read, sensitive keys already removed.
- **`POST /queue`** (`server.py:1146-1158`) — body `{"clear": true}` wipes pending; `{"delete": ["<prompt_id>", ...]}` dequeues by id. Always `200` empty body.
- **`POST /interrupt`** (`server.py:1160-1190`) — body optional; `{"prompt_id": "<id>"}` interrupts ONLY if that id is currently running (no-op otherwise); no/empty body ⇒ global interrupt. Always `200` empty.
- **`GET /prompt`** (`server.py:747-749`) → `{"exec_info": {"queue_remaining": <int>}}`.

## 3. History — the outputs shape job landing parses

- **`GET /history?max_items=N&offset=N`** and **`GET /history/{prompt_id}`** (`server.py:1045-1062`) → map of:

```jsonc
{
  "<prompt_id>": {
    "prompt":   [number, prompt_id, prompt_graph, extra_data, outputs_to_execute],   // tuple-as-array; sensitive stripped
    "outputs":  { "<node_id>": [ {"filename": "...", "subfolder": "...", "type": "output", ...}, ... ] },
    "meta":     { "<node_id>": { "node_id": "...", "display_node": "...", "parent_node": "...", "real_node_id": "..." } },
    "status":   { "status_str": "success" | "error", "completed": true, "messages": [...] }   // ExecutionStatus._asdict(); null while running
  }
}
```

Written by `PromptQueue.task_done` (`execution.py:1286-1305`): history starts as `{"prompt": ..., "outputs": {}, "status": status_dict}` then `.update(history_result)` merges `{"outputs": ui_outputs, "meta": meta_outputs}`. **Eviction:** when `len(history) > MAXIMUM_HISTORY_SIZE` the OLDEST entry is popped on every insert — long sessions lose early prompt_ids; pollers must land takes before eviction.
- **`POST /history`** (`server.py:1203-1214`) — `{"clear": true}` or `{"delete": ["<prompt_id>", ...]}` → `200` empty.

## 4. System / inventory

- **`GET /system_stats`** (`server.py:686-737`) → `{"system": {"os", "ram_total", "ram_free", "comfyui_version", "required_frontend_version", "installed_templates_version", "required_templates_version", "comfy_package_versions", "python_version", "pytorch_version", "embedded_python", "deploy_environment", "argv"}, "devices": [{"name", "type", "index", "vram_total", "vram_free", "torch_vram_total", "torch_vram_free"}]}` — primary device first. This is the health/adopt probe (`runtime.ts:501`, `core.ts:3212`).
- **`GET /object_info`** (`server.py:800-811`) → full `{node_class: node_info}` map. `node_info` fields (`server.py:751-798`): `input`, `input_order`, `is_input_list`, `output`, `output_is_list`, `output_name`, `name`, `display_name`, `description`, `python_module`, `category`, `output_node`, `has_intermediate_output`, optional `output_tooltips`/`deprecated`/`experimental`/`dev_only`/`api_node`/`search_aliases`/`essentials_category`. Combo (`[["choice", ...], {"tooltip": ...}]`) input values are the model-list enums the registry-only inventory reads.
- **`GET /object_info/{node_class}`** (`server.py:813-819`) → `{ "<node_class>": node_info }` — **an unknown node_class returns HTTP 200 with `{}`, NOT 404.** Absence must be detected by key-miss, never by status. (A-8's incremental strategy: targeted per-node pulls + cache; full pull only on refresh/version change.)
- **`GET /models`** (`server.py:342-346`) → list of folder names (`folder_paths.folder_names_and_paths` keys). **`GET /models/{folder}`** (`server.py:348-354`) → flat filename list (relative paths, extensions stripped per folder config); **404** if folder unknown.
- **`GET /experiment/models`** and **`/experiment/models/{folder}`** (`app/model_manager.py:28-52`) — the richer built-in listing (explicitly "an experiment to replace /models"): folders → `[{name, folders[], extensions[]}]`; files → `[{name, pathIndex, modified, created, size}]`, mtime-cached per folder. Preview companion: `GET /experiment/models/preview/{folder}/{path_index}/{filename}` (path-traversal guarded, 403 on escape).
- **`GET /embeddings`** (`server.py:337-340`) → embedding names (extension-stripped).
- **`GET /features`** (`server.py:739-745`) → server feature-flag map (env overrides merged).
- **`GET /view_metadata/{folder_name}?filename=`** (`server.py:663-684`) → safetensors `__metadata__` dict; 404 unless `.safetensors` with metadata present.

## 5. Files: view / upload

- **`GET /view?filename=&subfolder=&type=input|output|temp&preview=&channel=`** (`server.py:516-661`) → binary. Guards: leading-`/` and `..` rejected (400); subfolder commonpath escape rejected (403). `preview=webp|jpeg[;quality]` transcodes (default quality 90); `channel=rgb` flattens to PNG, `channel=a` returns alpha as PNG. Unknown file ⇒ 404.
- **`POST /upload/image`** (multipart `image`, `overwrite`, `type`, `subfolder`) (`server.py:464-467` + `image_upload`) → `{"name": "<filename>", "subfolder": "...", "type": "input"}`. `overwrite` honored only as the strings `"true"`/`"1"`.
- **`POST /upload/mask`** (adds `original_ref` JSON referencing the original image) (`server.py:470-514`) — alpha-copies the mask onto the original.

## 6. The async Jobs API (new surface in this revision)

- **`GET /api/jobs?status=pending,in_progress,completed,failed&workflow_id=&sort_by=created_at|execution_duration&sort_order=asc|desc&limit=&offset=`** (`server.py:821-917`) → `{"jobs": [...], "pagination": {offset, limit, total, has_more}}`. Job record (`comfy_execution/jobs.py:205-265`): `{id (= prompt_id), status, priority, create_time, execution_start_time, execution_end_time, execution_error, outputs_count, previewable_outputs_count, preview_output, workflow_id}` (+ `outputs`, `execution_status`, `workflow` on single-job GET).
- **`GET /api/jobs/{job_id}`** (`server.py:919-942`) → single job or `404 {"error": "Job not found"}`.
- **`POST /api/jobs/{job_id}/cancel`** (`server.py:971-987`) → `{"cancelled": true|false}` — idempotent; running ⇒ interrupt, pending ⇒ dequeue, terminal/unknown ⇒ no-op.
- **`POST /api/jobs/cancel`** body `{"job_ids": [...]}` (`server.py:989-1043`) → `{"cancelled": bool}` (true if ANY fired); malformed ids ⇒ 400 with `invalid_ids`.

## 7. WebSocket — `GET /ws?clientId=<id>` (`server.py:269-327`)

**Handshake:** `clientId` query param reuses/replaces that session id (an old socket with the same sid is dropped); absent ⇒ server mints `sid = uuid4().hex`. On connect the server immediately sends `status` (`{"status": get_queue_info(), "sid": sid}`) and, if this sid is the currently-executing client, a catch-up `executing` with the last node.

**Feature negotiation:** the FIRST client→server text message MAY be `{"type": "feature_flags", "data": {...}}`; the server stores it per-socket and replies with its own server feature flags (`feature_flags` event). Declaring `supports_preview_metadata` switches preview frames to the metadata-carrying binary form (below).

**Event routing (critical):** `PromptExecutor` sets `server.client_id = extra_data["client_id"]` of the prompt being executed (`execution.py:733-736`); non-broadcast events (`executing`, `executed`, `progress`, binary previews, `execution_start`/`_cached`/`_success`/`_error`) are sent ONLY to that sid — **and are DROPPED entirely if the prompt was submitted without a `client_id`** (`add_message`, `execution.py:677-684`: `if self.server.client_id is not None or broadcast`). `execution_interrupted` and queue `status` are broadcast to all sockets regardless. Every executor-emitted event carries `timestamp` (ms). Consequence: a submitter that omits `client_id` gets no per-prompt events at all — our bridge always sends it (`server/core.ts:2374`).

**Text events (JSON `{"type": ..., "data": ...}`, `send_json`, `server.py:1382-1390`):**

| type | data | emitted at |
| --- | --- | --- |
| `status` | `{status: {exec_info: {queue_remaining}}, sid?}` | connect (with `sid`) + every queue change (broadcast, no `sid`) — `server.py:287`, `queue_updated` |
| `execution_start` | `{prompt_id, timestamp}` | prompt starts (`execution.py:742`) |
| `executing` | `{node, display_node, prompt_id}` | each node start (`execution.py:496`) |
| `progress` | `{value, max, prompt_id, node}` | the tqdm global hook — `main.py:460-471` `hijack_progress`, still live in 0.34.0 |
| `progress_state` | `{prompt_id, nodes: {node_id: {value, max, state: pending\|running\|finished\|error, node_id, prompt_id, display_node_id, parent_node_id, real_node_id}}}` | combined per-node map on every progress change — `comfy_execution/progress.py:160-185` (NEW in this class of revision; coarse `progress` still exists in parallel) |
| `executed` | `{node, display_node, output: [ui...], prompt_id}` | each node with UI outputs (`execution.py:578`) + cached-UI replay for intermediate nodes (`execution.py:436`) |
| `execution_cached` | `{nodes: [...], prompt_id}` | after cache check (`execution.py:770`) |
| `execution_error` | `{prompt_id, node_id, node_type, executed, exception_message, exception_type, traceback, current_inputs, current_outputs}` | failure (`execution.py:699-712`; ExecutionBlocker variant at `execution.py:510-527` with `exception_type: "ExecutionBlocked"`) |
| `execution_interrupted` | `{prompt_id, node_id, node_type, executed}` | user interrupt — **broadcast** (`execution.py:693-699`) |
| `execution_success` | `{prompt_id}` | clean completion (NEW signal; `execution.py:824`) |
| `feature_flags` | server feature map | in reply to client flags (`server.py:302-312`) |

**Binary events** (`send_bytes`, `server.py:1311-1379`; `protocol.py:BinaryEventTypes`): message = 4-byte big-endian event code + payload.
- `1 PREVIEW_IMAGE`: 4-byte image type (1=JPEG, 2=PNG) + encoded bytes (quality 95). Sent when the client did NOT declare `supports_preview_metadata`.
- `4 PREVIEW_IMAGE_WITH_METADATA`: 4-byte metadata-length + UTF-8 JSON metadata (`node_id`, `prompt_id`, `display_node_id`, `parent_node_id`, `real_node_id`, `image_type`) + image bytes. Sent when it did (`comfy_execution/progress.py:207-237`, `server.py:1335-1370`).
- `3 TEXT` (`send_progress_text`, `server.py:1469-1479`): 4-byte node_id length + node_id bytes + text — node-emitted status text.
- `2 UNENCODED_PREVIEW_IMAGE`: internal (PIL image tuple), never hits the wire as-is.

## 8. Memory management — `POST /free` (`server.py:1192-1201`)

Body `{"unload_models": bool, "free_memory": bool}` — sets queue FLAGS consumed between prompts; response `200` empty. (The 8189 testbed's between-phase unload convention.)

## 9. Adjacent surfaces (present, currently unused by us)

- `/internal/*` subapp (`api_server/routes/internal/internal_routes.py`): `/internal/logs`, `/logs/raw`, PATCH `/logs/subscribe` (clientId), `/folder_paths`, `/files/{output|input|temp}` — header comment: "The endpoints here should NOT be depended upon. It is for ComfyUI frontend use only."
- User system (`app/user_manager.py`): `/users`, `/userdata` (+`/v2/userdata`), per-file CRUD — multi-user mode only.
- `/workflow_templates`, `/i18n` (`app/custom_node_manager.py`), `/node_replacements` (`app/node_replace_manager.py`), assets API (`app/assets/`), subgraphs (`app/subgraph_manager.py`).

## 10. Divergence notes (what our code assumes vs what the pinned revision does)

1. **No terminal `executing {"node": null}` event.** Classic ComfyUI signaled prompt completion with an `executing` event whose `node` was `null`; in `a87667f` the only `executing` emissions are per-node starts (`execution.py:496`) and the reconnect catch-up (`server.py:290`). Completion is `execution_success` / `execution_error` / `execution_interrupted` + the broadcast `status`. **Our bridge already treats it this way** (`server/realtime.ts` derives `job_done` from the terminal events, not from node-null) — verified aligned, recorded so nobody re-adds the assumption.
2. **`progress` still exists** (via `main.py`'s tqdm-hook hijack) alongside the new `progress_state` — an initial code read that missed `main.py` suggested otherwise; the hook is the load-bearing emitter. Our bridge listens to `progress` (`server/realtime.ts:127`) and keeps working; `progress_state` remains unhandled (its per-node detail is available if wanted).
3. **Client-minted `prompt_id` is now honored** (validated UUID ⇒ used; older cores ignored it). We let the server mint — fine — but the `invalid_prompt_id` 400 is a new failure shape to keep out of the sanitized-error path's blind spots.
4. **`/object_info/{node}` unknown-node answer is `200 {}`** — key-miss is the absence signal, never HTTP status (matters for A-8 incremental pulls and F6 preflight diffs).
5. **History eviction is size-based** (`MAXIMUM_HISTORY_SIZE`, oldest popped first) — the server-side job watcher (A-1) must land takes from events/WS or poll promptly; a completion that outlives the history window has no retrievable outputs.

## 11. Source-of-truth check (run on the triggers above)

The three questions from the library protocol apply verbatim: (1) did the endpoint/event shapes change against this capture? (2) was anything superseded (e.g. `/experiment/models` graduating, the jobs API absorbing queue+history)? (3) did an impossibility lift (e.g. targeted interrupt semantics, partial execution, per-node object_info caching hints)? Record dated addenda here, never silent replacement.

### Addendum 2026-09-20 (Wave 2 R-12, task 5zxr7ke) — there is NO /refresh route at the pinned revision

The remediation plan's "user-requested refresh affordance (ComfyUI /api/refresh semantics)" was checked against the canonical checkout at `a87667f` (v0.34.0) before building: **no `/refresh` route exists there** — no handler in `server.py`, `main.py`, `api_server/`, or `app/` (the only "refresh"-shaped hit is unrelated, in `app/assets/services/ingest.py`; `folder_paths` is imported by `server.py:344/351` only for the `/models` folder listing). Directive 2987ef3e's own wording carries the out: "ComfyUI's own /api/refresh **or re-fetch semantics**". Consequence, as built: the studio's Refresh affordance = a **best-effort `POST /refresh`** (harmless 404 at revisions without the route; a real engine-side folder re-scan at revisions that serve it) **followed by a mandatory re-fetch** of `/models/{kind}` + object_info — the re-fetch is the whole semantics at this pin. Re-verify on the next ComfyUI version bump: if a refresh route returns, the best-effort POST starts doing real work with zero code change.
