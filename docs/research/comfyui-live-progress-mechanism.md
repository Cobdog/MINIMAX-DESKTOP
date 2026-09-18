# ComfyUI live progress + preview wiring — the exact upstream mechanism (2026-09-18)

> Task: Design-decision implementations (2hbv2ib). Epic: the studio core (xng2pk8).
> Method: **CODE-READ** against the installed ComfyUI source at
> `/home/agent/comfyui` on 2026-09-18 (the canonical shared install the 8189
> testbed runs), cross-checked with the HF API for the weight pin and a live
> offline fake-engine proving the contract end to end (test-realtime (g)).
> Evidence tags: **[DOC]** verified in the engine source shipped on this box,
> **[MEAS]** observed through our fake-engine seam, **[COMM]** community
> claim, **[API]** Hugging Face API metadata. This capture exists because the
> F6 fix depended on four load-bearing facts that no local doc recorded.

## The four facts

### 1. clientId registration and event targeting [DOC]

- `server.py:273-281` — a WS connect to `/ws?clientId=<sid>` registers that
  sid in the engine's socket map (`self.sockets[sid] = ws`); without the
  query param the engine mints a random sid nothing else knows.
- `server.py:1117-1118` — the `/prompt` POST body's `client_id` lands in
  `extra_data["client_id"]`; `execution.py:737` sets
  `self.server.client_id = extra_data["client_id"]`.
- **Targeting + the silent drop**: `send_json`/`send_bytes`
  (`server.py:1372-1390`) deliver to the given sid ONLY when it is in the
  socket map — `elif sid in self.sockets:` and nothing in the else branch.
  Every lifecycle/progress event from `add_message` (broadcast=False) and
  every progress-bar hook event goes to `self.server.client_id`
  (`main.py:471`). A submission whose client_id owns no WS session gets its
  events silently dropped — exactly the overnight audit's frozen-at-4% F6
  root cause (submissions carried page-generated ids owning no session;
  WS-probe evidence in junllxf comment zh3nkuo).
- Consequence (the fix, maintainer decision 1a): ONE stable server-side
  clientId on the shared upstream (`/ws?clientId=<id>`, stable across
  reconnects — a fresh id would orphan prompts submitted before the
  reconnect) + every submission carrying it. Implemented in
  `server/realtime.ts` (`hubClientId`) + `server/core.ts` `/api/lan/prompt`.

### 2. Progress events still exist and now carry prompt_id [DOC]

`main.py:458-476` (the hijacked global progress hook) sends
`{"type":"progress","data":{value,max,prompt_id,node}}` to the submitting
client. The fabric's normalizer also keeps its server-side
active-prompt-id correlation for events without one. This engine ALSO emits
a combined `progress_state` event (multi-node, `comfy_execution/progress.py`)
— the fabric deliberately ignores unknown types (typed by design); plain
`progress` drives our UI.

### 3. Per-prompt sampler previews are requested via extra_data.preview_method [DOC]

- `execution.py:731` — `execute_async` calls
  `set_preview_method(extra_data.get("preview_method"))`; values are the
  `LatentPreviewMethod` strings `none | auto | latent2rgb | taesd`
  (`comfy/cli_args.py:122-126`; default `none`).
- `latent_preview.py get_previewer` — with method `taesd`, the previewer
  loads the FIRST `vae_approx` file whose name starts with the latent
  format's `taesd_decoder_name`; `taeh3` is in `VIDEO_TAES`, so it loads via
  `comfy.sd.VAE` and decodes one frame per step (TAEHVPreviewerImpl).
  Missing weight → warning + fallback to the latent's `latent_rgb_factors`
  2D projection (H3 has factors — crude-but-working previews). **[COMM]**
  Kijai's note: the TAE is quickly trained, preview-grade only.
- Our graphs' sampler is `SamplerCustomAdvanced`
  (`comfy_extras/nodes_custom_sampler.py:1020`) — it calls
  `latent_preview.prepare_callback(...)` itself, so native previews fire for
  the canvas H3 graphs with no graph changes.
- Wire format of a preview frame [DOC]: binary
  `[u32 event=1][u32 type 1=JPEG|2=PNG][image bytes]` (`send_image`,
  `server.py:1311-1333`) — already parsed by the fabric's
  `parseUpstreamBinary`. A NEWER framing `PREVIEW_IMAGE_WITH_METADATA` (4)
  is only sent when the client negotiates the `supports_preview_metadata`
  feature flag after connect (`comfy_execution/progress.py:213-227`) — we
  never negotiate, so we stay on the legacy path (worth knowing if upstream
  ever removes it).

### 4. The H3 preview decoder weight + its source [API][DOC]

- The H3 latent format names `taesd_decoder_name = "taeh3"`
  (`comfy/latent_formats.py:627`) → any `vae_approx/taeh3*` file matches
  (prefix match, `latent_preview.py`).
- Two shipping names exist: Kijai's original `taeh3.safetensors`
  (HF `Kijai/MiniMax-H3-TAE`, Apache-2.0, repo `a213ac8b`, file
  `vae_approx/taeh3.safetensors` 9,791,388 B, LFS sha256
  `f0f60fa072089997f817402098c2fd90777cb2660dd79cf5df42fc1e3e08e527`)
  **[API]** and the preview-override pack's `taeh3_decoder.safetensors`
  (same class of weight, the graph-side override node's file) **[COMM]**.
- Catalog entry `taeh3-preview-decoder` (server/fetchCatalog.ts) pins the
  Kijai file; the app's `previewVae` selection accepts both names
  (src/lib/modelSelection.ts). The weight was fetched through the consent
  flow into `/home/agent/models/vae_approx/` (central home; engine resolves
  it through `extra_model_paths.yaml`).

## Verdict table

| Question | Verdict | Basis |
| --- | --- | --- |
| Why were targeted events dropped? | Submitting client_id owned no WS session; engine's `elif sid in sockets` drops silently | [DOC] + 3 overnight WS probes (junllxf) |
| How to make every client see progress? | Pin ONE stable server-side clientId on the shared upstream; submit with it | [DOC] + [MEAS] (test-realtime (g)) |
| How are sampler previews requested per prompt? | `extra_data.preview_method: "taesd"` on the /prompt POST | [DOC] + [MEAS] |
| Which decoder for H3 previews? | vae_approx class, name starting `taeh3`; Kijai's `taeh3.safetensors` (Apache-2.0) fetched via the catalog | [DOC][API] |
| Do previews need graph changes? | No — SamplerCustomAdvanced wires prepare_callback itself | [DOC] |
| Preview frame wire format? | `[u32 1][u32 1|2][image]` (legacy path; metadata framing only with negotiated feature flags) | [DOC] |
