# Agentic captioning harness — technology survey (the lane-1 research pass)

> Flux task `6niii1p` (epic xng2pk8) · 2026-09-18. Feeds the standalone
> captioning/dataset-wrangling service spec (MCP server + webUI + Postgres/pgvector);
> the maintainer's six architecture decisions (task directive, 2026-09-18) are the
> binding frame. Sibling research: [video-dataset-prep-tools.md](video-dataset-prep-tools.md)
> (dataset managers, llama.cpp captioning mechanics, curation — 2026-09-17; not
> duplicated here), [ecosystem-2026-09.md](ecosystem-2026-09.md) (H3 ecosystem).
>
> METHOD: primary-source code-read of the **reply MCP** on this box
> (`~/work/VS Proj/reply` @ git `8a0e67c2` — the RLM/trace/sandbox evidence is
> **[DOC-local]**, quoted from shipped code); web fetches of official sources
> (Cloudflare blog, Anthropic engineering, pgvector README, Ollama api.md,
> OpenTelemetry GenAI spec repo — **[DOC]**, fetched this session); framework docs
> via Context7 indexed current releases (OpenRouter, LiteLLM, MCP spec, pydantic-ai
> v2, Mastra, LangGraph — **[DOC-C7]**, snippet-level from the indexed docs);
> community claims from search coverage — **[COMM]**; plausible-unverified —
> **[SPEC]**; nobody knows — **[UNK]**. Freshness: verified 2026-09-18; the agent-
> framework space moves monthly — re-verify §6 rows before the spec locks.

---

## 0. What this survey answers (the spec-round questions it feeds)

| Spec question | Section | One-line answer |
|---|---|---|
| Trace/KB schema (the load-bearing wall) | §2 | Two-representation discipline: full-fidelity append-only event log in Postgres + curated digest in context; KB entries are distilled, provenance-linked, promoted by evidence — never raw trace replay |
| Provider-capability contract | §3 | Registry row = reply's `ModelSpec` shape extended with OpenRouter/LiteLLM field vocabulary; the loop adapts via declared caps, never probed assumptions |
| Stack choice (Python vs TS vs split) | §6 | Evidence leans Python core + TS webUI with MCP as the seam (the box already runs this split), but the table is presented for the spec round, not picked here |
| Pass taxonomy / cost model | §5 | Formalized: the chain amortizes perception tokens across k text iterations; sampled verification rate `s` is the knob that decides cost vs naive multi-pass |
| Code Mode applicability | §1 | Adopt for dataset-wrangling surface (batch ops, filters, exports), keep perception/scoring as tool SKUs |

---

## 1. Code Mode mechanics (Cloudflare's pattern and successors)

### 1.1 The pattern, from the primary source

Cloudflare's Code Mode (pattern introduced late 2025, community implementations from
Oct 2025; productized as the **Code Mode MCP server**, blog 2026-02-20, updated
2026-07-15) **[DOC]**:

- The MCP server exposes exactly **two tools**, `search()` and `execute()`, each taking
  a single `code` string — a "JavaScript async arrow function".
- `search()` hands the model a `spec` object (the full Cloudflare OpenAPI spec with
  `$refs` pre-resolved); the model writes JS to *filter* endpoints. **The spec never
  enters model context.**
- `execute()` runs code that makes API requests, handles pagination, checks responses,
  and chains operations via a `cloudflare.request()` client — one tool call does what
  a dozen discrete tool round-trips would.
- Execution environment: a **Dynamic Worker V8 isolate** — "no file system, no
  environment variables to leak through prompt injection and external fetches disabled
  by default"; outbound requests controlled via outbound fetch handlers **[DOC]**.
- Authorization: OAuth 2.1 with **downscoping to user-approved permissions** — the
  generated code can only exercise explicitly granted capabilities **[DOC]**.

Numbers, quoted exact **[DOC]** / **[COMM]**:

| Metric | Value | Source |
|---|---|---|
| Cloudflare API surface | 2,500+ endpoints | [DOC] blog |
| Tool-definition footprint | 2 tools, ~1,000 tokens — fixed regardless of API size | [DOC] blog |
| Equivalent native MCP tool defs | ~1.17M input tokens (tiktoken-measured) | [DOC] blog |
| Tool-definition reduction | 99.9% | [DOC] blog |
| Task-token reduction (measured tasks) | 32% simple / 81% complex | [COMM] WorkOS analysis 2025-12-11 |
| Worked example (DDoS protection) | 4 total tool calls (2 search + 2 execute) | [DOC] blog |
| Community ceiling claim | "98–99% vs standard tool calling" | [COMM] tianpan.co — treat as marketing-grade |
| Why it matters at all | 50+ tool defs ≈ 7% of context burned before the first message | [COMM] LeanIX via Towards AI |

### 1.2 Tool-SKU vs code composition (what stays a tool)

The pattern is not "code replaces tools". The composition that emerges across
Cloudflare's own post and successors:

- **Stay as discrete tool SKUs**: small, stable, high-frequency, safety-relevant
  operations — the ones you want schema-validated, permission-gated, and individually
  observable. For this harness: `perceive(item)`, `score(caption, rubric)`,
  `commit_caption`, `query_dataset`.
- **Become code**: the long tail — batch operations, pagination, filtering, chained
  transformations, ad-hoc analysis ("all items where the motion clause is missing and
  duration > 8s"). Code Mode's fixed ~1k-token cost makes the *entire* wrangling
  surface affordable; discrete tools would not scale to dataset-shaped operations.
- **Search-before-execute** is the progressive-discipline discovery pattern: the model
  finds what it needs in a structured spec (or our KB/dataset catalog) instead of
  carrying it in context.

### 1.3 Successors (2026 state)

- **Anthropic**: code execution with MCP; community-reported "Ultra Code mode" in
  Claude Code alongside sub-agent first-class primitives **[COMM]** (ThursdAI
  coverage — verify in the spec round if load-bearing). Claude Code's *dynamic tool
  search* is the non-code cousin: tools found on demand, each match still paying
  tokens **[DOC]** (compared in Cloudflare's post).
- **Pydantic**: "CodeMode harness" named by NVIDIA's OO-agents survey as among the
  newest generation **[COMM]**; pydantic-ai now ships an official
  **pydantic-ai-harness** capability library (tools, hooks, sub-agents) **[DOC-C7]**.
- **OpenAI**: sandbox agents / Codex code mode **[COMM]**.
- **Client-side variants**: Goose and the Claude SDK's **Programmatic Tool Calling**
  implement Code Mode client-side (requires the agent runtime to ship a sandbox)
  **[DOC]** (Cloudflare's comparison). UTCP ships a plug-and-play code-mode library
  **[COMM]**.
- **NVIDIA OO Agents** (arXiv, Jul 2026): native Python object-oriented agents,
  surveying this whole generation **[COMM]** — the academic anchor if the spec wants
  a citation.

### 1.4 Failure modes and guardrails for generated tool-code

Cloudflare's post is candid about what it does NOT specify: no described static
analysis or validation of generated JS, and no described error semantics when the
code fails **[DOC]**. The guardrails it does ship: sandbox (no fs, no env, fetch
disabled), OAuth downscoping, spec-mediated discovery. The harness-side discipline
comes from the RLM tradition — the reply MCP's sandbox is the strongest local prior
art **[DOC-local]**:

- **AST-level escape-vector closure**: a `NodeTransformer` rejects *all* attribute
  access on names starting with `_` (`__class__`, `__globals__`, `__subclasses__()`
  chains) — closing the entire class of traversal escapes, not a blocklist of known
  ones.
- **Builtins whitelist** with dangerous primitives (`eval`, `exec`, `compile`,
  `globals`, `locals`, `input`) set to `None` so misuse raises a clear TypeError.
- **Resource limits as data** (`SandboxLimits`): max_iterations 50, 300 s/iteration,
  512 MB, 200 sub-calls, fanout 8, 50k output chars — budget knobs, not vibes.
- **Capability tiers** (`PermissionTier` 0–4: SANDBOXED/READONLY/EXECUTE/WRITE/
  UNRESTRICTED) gating what the code may do at all; file tools additionally
  path-scoped (`_assert_within_working_dir`).
- **Observed-but-corrected failure mode**: reply's git history shows a dead nsjail
  sandbox *removed* (commit 86025dbf) — heavyweight OS jails are operationally
  fragile next to AST+builtins+limits for trusted-local workloads **[DOC-local]**.

Verdict for the harness: adopt Code Mode composition for the wrangling surface; the
perception/scoring SKUs stay tools; sandbox discipline = AST dunder-block +
builtins whitelist + resource caps + capability tiers (reply pattern), with
OAuth-style downscoping mapped to "the run may only touch its own item's rows".

---

## 2. RLM/trace formats — and the captioning trace/KB schema proposal

### 2.1 The strongest local implementation: reply (code-read) **[DOC-local]**

The reply MCP (this box, `~/work/VS Proj/reply`) structures persistence around one
load-bearing split: **the sandbox `traces` list is the source of truth for execution
history; compaction compresses only the steering channel (conversation messages)**.
Concretely:

- **Trace record** (appended per code block, in-sandbox, survives resets):
  `{iteration, block, code[:1000], stdout[:2000], error[:500], success, summary,
  variables}` — previews with per-field caps, a one-line summary, a variable
  snapshot. Ring-buffered at **200 entries** (oldest trimmed). Caps are the bloat
  discipline: full fidelity is never needed *in context*, only *addressable*.
- **Compaction contract** (`compaction.py`): when cumulative tokens exceed budget,
  history is cut at an **iteration boundary** (pairs stay paired), the early portion
  is LLM-summarized under an explicit prompt: first-person narrative, "reference
  trace iterations by number (e.g. 'In iterations 1–5 I explored X, see
  traces[0:5]'), do NOT reproduce stdout/code" — **references, not reproductions**.
  keep-recent default 20k tokens; a `force_concise` escalation re-summarizes at
  ≤500 chars if the first pass didn't shrink enough.
- **Re-injection**: the continuation message embeds a reorientation one-liner
  (`for t in traces[-10:]: print(t['iteration'], t['summary'])`) plus a factual
  variable snapshot — the model re-derives detail on demand from the persistent
  store instead of carrying it.
- **Ledgers that survive compaction as accumulating state**: a file-ops ledger
  (read/modified sets, modified-wins) is unioned across compactions.
- **Context strategies as an enum** (`ContextStrategy.RESET | COMPACT | NONE`):
  RESET preserves the original task + a terse metadata message; variables and
  traces survive in the sandbox either way; NONE = halt. Token estimation is
  chars/4 throughout.
- **Observability events** (typed frozen dataclasses): `execution_start` (tier,
  model), `iteration_start`, `llm_response` (prompt/completion tokens,
  finish_reason), `coherence_check` (confidence, issues, passed), `code_execute`
  (block index, code preview, success, error), `compaction` (tokens before/after),
  `branch` (from_iteration, reason), `steering_applied`, `final_detected`
  (verified flag), `execution_end` (iterations, halted_reason, elapsed,
  **cost_total**, has_answer).
- **Execution tree**: append-only JSONL, one line per entry, `parent_id`-linked
  (branching by rewinding the leaf), crash-safe per-entry persist, replayable by
  load.

### 2.2 The wider prior art

- **Anthropic, "Effective context engineering for AI agents"** (2025-09-29)
  **[DOC]**: compaction = summarize + restart window; Claude Code's compact
  preserves *architectural decisions, unresolved bugs, implementation details* and
  re-injects the 5 most recently accessed files; tune for **recall first, precision
  second**. Structured note-keeping to external storage (the file-based memory
  tool). **Just-in-time retrieval**: keep lightweight references (paths, queries)
  and load at runtime — slower per item but the context stays minimal; hybrid
  (CLAUDE.md up front + glob/grep exploration) is often best. **Sub-agents**: clean
  context windows for focused work, "tens of thousands of tokens" of internal
  exploration, returning ~1,000–2,000-token summaries to the lead. **Tool-result
  clearing** — "one of the safest, lightest-touch forms of compaction". Governing
  principle: *find the smallest set of high-signal tokens*; recall degrades as
  tokens grow (attention n² — "context rot" is a gradient, not a cliff). Bigger
  windows won't fix it.
- **Claude Platform docs** (2026-03-20) formalize the trio — memory, compaction,
  tool clearing — and how they compose **[COMM]** (search-verified; fetch if the
  spec leans on it).
- **OpenTelemetry GenAI semantic conventions** (relocated 2026 to
  `open-telemetry/semantic-conventions-genai`) **[DOC]**: spans `create_agent`,
  `invoke_agent` (client/internal), `invoke_workflow`, `plan`; correlation via
  `gen_ai.conversation.id`; token family `gen_ai.usage.input_tokens /
  output_tokens / cache_read.input_tokens`; opt-in `gen_ai.input.messages`,
  `gen_ai.output.messages`, `gen_ai.tool.definitions`; inference spans nest inside
  agent spans inside workflow spans. Status: **Development** — adopt the
  *vocabulary*, don't hard-depend on the spec.
- **Mastra** **[DOC-C7]**: `createDurableAgent` runs the agent loop inside a
  durable workflow; suspended runs (awaiting tool-call **approval** or explicit
  `suspend()`) are listable/resumable (`approveToolCall`, `resumeStream`), with
  storage domains (Postgres among them) for memory/workflows/observability — the
  strongest framework-native prior art for **human-gated passes**.
- **LangGraph** (1.0.x) **[DOC-C7]**: durable execution + checkpoint savers +
  human-in-the-loop interrupts as first-class runtime features (Python and JS).

### 2.3 Proposed captioning-pass trace/KB schema (the load-bearing wall)

Synthesis of the above into a shape for THIS service. Core principle inherited from
reply and Anthropic: **two representations** — full fidelity in Postgres (cheap,
permanent, for audit + replay + KB mining) and a curated digest in context
(expensive, small, references the store). Never replay the store into context.

```text
runs           (one captioning job over an item or batch)
  id, item_id (fk), plan (jsonb: the pass spine + extensions invoked),
  status, started_at, ended_at, tokens_in, tokens_out, cost_usd,
  halted_reason, compacted_count
passes         (one structured pass inside a run)
  id, run_id fk, pass_type (taxonomy key), model_id, model_caps (jsonb
  snapshot of the capability declaration AT RUN TIME), prompt_ref,
  tokens_in, tokens_out, latency_ms, verdict (jsonb: scores, confidence,
  issues), created_at
trace_events   (append-only, bigserial seq — the execution tree, flat)
  id, run_id fk, pass_id fk, seq, type, ts, data jsonb
  types: llm_response{usage, finish_reason} · perception{item_ref, frames,
  sampling, tokens} · tool_call{name, args_preview, result_ref} ·
  code_execute{code_preview, success, error} · score{dimension, value,
  issues} · compaction{tokens_before, tokens_after} · steering{source} ·
  branch{from_seq, reason} · final{verified}
kb_entries     (the persistent self-knowledge — distilled, not raw)
  id, key, kind (model_quirk | template_finding | vocabulary | rubric_note),
  body (capped ~500 words), provenance (jsonb: run_ids[], pass_ids[] that
  produced it), confidence, status (candidate → promoted → retired),
  created_at, updated_at
```

Rules that make it a wall and not a swamp:

1. **Caps on everything in-context** (reply's numbers as defaults): code preview
   ≤1000 chars, stdout ≤2000, error ≤500; summaries not payloads; media NEVER in
   traces — a perception event references `{item_id, frame_idx, phash}` and the
   token count, never bytes.
2. **Ground truth is versioned in its own table, referenced by version** — trace
   events point at `captions.version_n`, so refinement history is diffable without
   carrying prose copies per event.
3. **Compaction contract**: summary references event `seq` ranges (reply's
   trace-index discipline); the working set is task + current pass + summary tail +
   KB refs; re-injection is a one-liner reorientation + variable/GT-version
   snapshot.
4. **KB promotion gate**: an entry is `promoted` only with ≥2 corroborating runs
   and a confidence threshold; contradicting evidence retires it (dated, never
   silently deleted — the repo's addendum doctrine applies to the KB too). KB
   entries are fetched by key just-in-time (Anthropic JIT pattern), never inlined
   wholesale into every pass.
5. **`model_caps` snapshot per pass** — the audit trail answers "what did we
   believe this model could do when it ran", which is exactly what the measured
   capability profiles (lane 2) will be revising.
6. **Vocabulary**: name trace event types and the usage fields after OTel GenAI
   (`gen_ai.usage.*` ↔ our `llm_response.usage`) so an OTel exporter is a mapping,
   not a rewrite, if we ever want standard observability tooling.

What a captioning trace must NOT carry (bloat discipline, from measured failure
modes): image/frame bytes or base64 anywhere; per-event tool schemas (Code Mode
discipline — definitions are fixed and tiny); whole-dataset query results
(aggregate + reference); full VLM outputs beyond the current GT version; KB bodies
duplicated into events (reference by id).

---

## 3. Provider-capability contracts

### 3.1 Prior art, field by field

| System | Capability declaration | Evidence |
|---|---|---|
| **reply `ModelSpec`** (YAML registry) | `context_window`, **`effective_context`** (separate field!), `max_output`, `supports_tools`, `supports_vision`, `supports_streaming`, `supports_thinking`, `cost_input`, `cost_output`, `endpoints` **per protocol** (anthropic/openai), `aliases`, `category` (fast/precise) | [DOC-local] `models/types.py` + `models.yaml` |
| **LiteLLM** | `model_info`: `max_input_tokens`, `max_output_tokens`, `input_cost_per_token`, `output_cost_per_token`, `cache_creation_input_token_cost`, `cache_read_input_token_cost`, per-audio-token costs, `mode`, `supports_function_calling`, `supports_tool_choice`, `litellm_provider`, `aliases`; declarable per-deployment in proxy YAML or via `register_model` | [DOC-C7] docs.litellm.ai custom pricing / provider registration |
| **OpenRouter** | `context_length`, `architecture.{input_modalities, output_modalities, modality, tokenizer, instruct_type}`, `pricing.{prompt, completion, image, request, input_cache_read}` (USD strings per token), `supported_parameters`, `supported_features` (tools, json_mode, structured_outputs, web_search, reasoning), `reasoning.{default_effort, supported_efforts, mandatory}`, `top_provider.{context_length, max_completion_tokens, is_moderated}`, per-endpoint **latency/throughput percentiles + uptime** | [DOC-C7] API reference schema; live `/api/v1/models` now returns `{max_input_tokens, max_tokens, capabilities}` with `capabilities` still null — a schema migration in flight, worth re-checking before the spec pins anything |
| **Ollama** (the local runtime we actually have) | `/api/tags` → `details.{family, families, parameter_size, quantization_level, format}`; `/api/show` → **`capabilities: ["completion", "vision"]`**, `model_info.llama.context_length` | [DOC] docs/api.md |
| **MCP servers themselves** | initialize result `capabilities`: `tools{listChanged}`, `resources{listChanged, subscribe}`, `prompts{listChanged}`, `logging{}`, `completions{}` (spec dated 2026-07-28) | [DOC-C7] spec schema |
| **llama.cpp server** | capability discovery via `/v1/models` + the mtmd path; vision token budgets per family (Gemma 4 fixed budgets 70/140/280/560/1120 via `--image-min/max-tokens`) | [DOC] via video-dataset-prep §2 |

### 3.2 The two design lessons

**Lesson 1 — `effective_context` ≠ `context_window`.** reply carries both fields
because thinking tokens, tool definitions, and output reservation consume the
nominal window; a loop that plans against the raw ceiling overflows **[DOC-local]**.
OpenRouter makes the same distinction structurally (`context_length` vs
`top_provider.max_completion_tokens`).

**Lesson 2 — capabilities are *adaptive routing inputs*, not documentation.** The
strongest 2026 pattern is pydantic-ai's capability objects **[DOC-C7]**: `MCP(url,
native=True)` uses provider-native MCP **and automatically falls back to local
execution when the model doesn't support it**; `WebSearch(local='duckduckgo')`,
`ImageGeneration(fallback_image_model=...)`, `XSearch(fallback_subagent_model=...)`
— every capability declares native-vs-local behavior *per model*, with a declared
fallback. That is decision 3 ("providers DECLARE capabilities and the loop adapts")
as it already exists in the wild. The harness's pass router should look like this:
each pass declares its requirements (vision? tools? prose strength? context floor?)
and the router assigns from the measured registry, with a declared fallback chain —
never an assumption that the assigned model can do it.

### 3.3 Local-first-now → API-later transition pattern

The composition that falls out of the prior art (all pieces already proven on this
box or in these codebases):

1. **One registry, provider-agnostic rows** (reply's YAML is the minimal skeleton;
   extend with OpenRouter/LiteLLM field vocabulary — §3.1 — so API-model rows are
   seedable from their published metadata without inventing a second schema).
2. **Local rows carry cost 0.0** (reply's convention **[DOC-local]**) — the cost
   ledger stays on (tokens/latency always; dollars when present), so turning on an
   API provider changes data, not code.
3. **The transport seam is already normalized**: reply declares endpoints per
   protocol (anthropic + openai shapes) **[DOC-local]**; LiteLLM's entire value is
   the uniform OpenAI-shape layer over 100+ providers **[DOC-C7]**; the Studio's
   own LLM layer is router-primary with Ollama fallback **[DOC-local
   architecture.md]** — the same seam at smaller scale.
4. **Nothing assumes local latency/limits** (binding decision): async everywhere,
   compaction always armed (a 200k-token local model and a 1M-token API model are
   two registry rows, not two loop designs), hard per-run budget caps + cost
   estimates surfaced before submit (the ecosystem doc's API-billing-surprise
   lesson: "show estimated cost before submit and hard caps" **[DOC]
   ecosystem-2026-09 lane 8**).

---

## 4. Postgres/pgvector service patterns

### 4.1 Engine facts (current) **[DOC]** (pgvector README @ v0.8.6, fetched 2026-09-18)

- Postgres 13+; index types: **HNSW** (better query perf, slower build, more
  memory, buildable on empty tables) vs **IVFFlat** (faster build, less memory,
  needs data present first, recall-sensitive to lists/probes).
- Dimensions: `vector` 16,000 stored / **2,000 indexable**; `halfvec` 16,000 stored
  / 4,000 indexable; `sparsevec` 1,000 indexable (HNSW only); `bit` 64,000.
- **Half-precision via expression index**: `CREATE INDEX ... USING hnsw
  ((embedding::halfvec(768)) halfvec_cosine_ops)` — half the memory, index vectors
  that exceed the 2,000-dim limit.
- **Iterative index scans** (0.8.0+): filtering happens *after* the ANN scan, so
  filtered queries can come back thin; iterative scans auto-extend until enough
  rows pass the filter — `strict_order` (exact ordering) or `relaxed_order` (better
  recall, slightly unordered). This is the feature that makes metadata-filtered
  vector queries (per-dataset, per-class, exclude-already-picked) actually work.
- Tuning defaults: HNSW `m=16`, `ef_construction=64` ("use the defaults unless
  seeing low recall"), `ef_search=40`; IVFFlat `lists ≈ rows/1000` up to 1M rows
  then `sqrt(rows)`, `probes ≈ sqrt(lists)`.
- Operators: `<->` L2, `<#>` negative inner product, **`<=>` cosine**, `<+>` L1;
  for normalized embeddings inner product performs best.
- Ops: upgrade via `ALTER EXTENSION vector UPDATE`; official Docker tags for
  pg13–pg18; source/APT/Yum/brew/PKGXN install paths.

### 4.2 Schema shape for dataset analytics (embeddings + metadata + provenance)

```sql
-- items: the media inventory (mirrors the dataset-manager's needs)
items(id, path, kind, duration_s, fps, width, height, phash,        -- tier-1 dedup
      provenance jsonb,        -- source, license posture, ai_generated, consent
      created_at, ...)
-- one row per (item, embedding model) — models change; old vectors age out by model
item_embeddings(item_id fk, model_id, dim, embedding vector(768),
                embedding_half halfvec(768) GENERATED ALWAYS AS (embedding::halfvec(768)) STORED,
                embedded_at)
CREATE INDEX ON item_embeddings USING hnsw ((embedding_half::halfvec(768)) halfvec_cosine_ops);
-- captions: versioned, authored (hand-written never silently overwritten — LDS lesson)
captions(id, item_id fk, version, body, author_kind (human|model|agent),
         author_model, pass_ref, status (draft|scored|accepted), created_at)
-- runs/passes/trace_events/kb_entries: §2.3
-- dataset_views: named export layers (the non-destructive layer model)
```

Design notes, each anchored: per-model embedding rows because embeddings are model-
bound artifacts, not item properties; `provenance jsonb` per item extends the
Studio's catalog/consent discipline to dataset items (gap #12 in the dataset-prep
survey); caption authorship + preserve-hand-written-on-recap is LoRA Dataset
Studio's verified pattern **[DOC] video-dataset-prep §1.1**.

### 4.3 Near-dup / diversity / gap as vector math

- **Near-dup (tier 2, advisory)**: incremental — on ingest, ANN top-k for the new
  item (`ORDER BY embedding_half <=> $1 LIMIT k`), threshold `similarity > θ`, store
  edges; cluster view = connected components over edges computed in the app, cached
  as `cluster_id`. Cross-ratio variants land in the same cluster *by design* (the
  maintainer's bucket-diversity call — dataset-prep §3.1): tier-1 `phash` catches
  re-encodes cheaply first. Never auto-delete.
- **Diversity selection (MMR)**: maximal-marginal-relevance is a greedy re-rank —
  fetch `k × candidates` via ANN **with the iterative scan honoring the "exclude
  already-picked ids" filter**, then re-rank in the service layer
  (argmax[λ·sim(q,d) − (1−λ)·max sim(d, picked)]). pgvector does the candidate
  generation; the greedy loop belongs in code (this is also exactly how LangChain's
  PGVector store does MMR — client-side re-rank over fetched candidates
  **[COMM]**).
- **Gap analysis**: distribution gaps are metadata SQL (bucket-map coverage per the
  envelope walls — dataset-prep §3.4); *semantic* gaps ride the embeddings — e.g.
  nearest-centroid density: sample cluster representatives, report buckets where
  mean intra-cluster similarity is high but item count is low (dense-but-thin =
  under-populated region), and distance of a *query caption for the dataset you
  wish you had* to the nearest existing item (the "what to add more of" answer as
  pure vector math). Both are [SPEC] compositions of [DOC] primitives — flag for
  measurement in the spec's test arms, not blind adoption.

### 4.4 Single-box operational notes

- **Migration story**: schema-as-code from day one (Alembic for a Python core,
  Drizzle/Prisma migrations for TS — both support raw SQL DDL for vector DDL that
  ORMs don't model natively **[COMM]**); pgvector upgrades are `ALTER EXTENSION
  vector UPDATE` per database **[DOC]** — cheap and contained.
- **Backup**: `pg_dump` includes vector data as ordinary types (restore then
  rebuild HNSW indexes; for 5→100k-item scale, index rebuilds are minutes, not
  hours **[SPEC]** at our scale — measure at 1k items). Nightly pg_dump +
  weekly `pg_dump -Fc` to a second disk is the honest single-box story; no
  PITR/WAL archiving complexity until the dataset outgrows it.
- **Watchlist**: pgvectorscale (StreamingDiskANN, Timescale) reports large speedups
  at higher dims **[COMM]** — license situation changed with Timescale's 2025
  relicensing; do NOT adopt before an SPDX check through the license gate.
  At 768–1024 dims and ≤100k items, stock HNSW is comfortably sufficient
  **[SPEC]** (size for it, verify in test arms).

---

## 5. The ground-truth-chain cost model

### 5.1 Formalization

Per item, one-shot baseline (VLM does everything in a single pass):

```
C_oneshot = V_dense = T_img + T_out_dense        (perception tokens dominate)
```

Naive multi-pass (the VLM sits in the refine loop, k iterations):

```
C_naive(k) = k · (T_img + T_out)                 perception re-paid every iteration
```

The ground-truth chain (perceive once → text-only refine → VLM returns only to
score/verify, at sampling rate s):

```
C_chain(k, s) = V_dense + k·T_text + s·k·V_score
T_text  ≈ τ·V_dense    (text pass: GT in + instruction + revision out; no image tokens)
V_score = T_img + ε·T_img   (verification re-pays perception input, emits only a
                             short score; ε = score-output/image-tokens, small)
```

Break-even against naive multi-pass: the chain wins while
`1 + k·τ + s·k·(1+ε) < k`, i.e. `s < (k − 1 − k·τ) / (k·(1+ε))`. With
image-dominant tokens and mid-density captions (τ ≈ 0.1–0.15, ε ≈ 0.05):

| k (refine iters) | τ | break-even s | chain cost at s=0.1 (vs naive) |
|---|---|---|---|
| 3 | 0.15 | ~0.47 | ~1.45/3 ≈ 48% |
| 5 | 0.15 | ~0.62 | ~2.25/5 = 45% |
| 8 | 0.10 | ~0.74 | ~2.6/8 ≈ 33% |

**The honest edges**: (1) at full re-verification (s→1) and high k the chain can
cost *more* tokens than naive — the sampling rate is the control knob and the
quality case (prose-strong refiners, no re-perception hallucination) is what
justifies the chain, not tokens alone; (2) τ shrinks as captions get shorter
relative to image tokens — the chain's economics improve exactly where VLM
perception is most expensive (video).

**The GPU/throughput axis (the directive's "throughput answer")**: vision passes
are the only ones needing the VLM (VRAM-contended; on this box the maintainer's
workload preempts — CLAUDE.md). Vision-pass count per item: naive = k, chain =
1 + s·k (e.g. 1.5 at k=5, s=0.1). Text passes run on any prose-strong text model
(router slot, CPU-class, or API). So the contended resource's queue shrinks ~3–5×
at the same k — the chain converts VLM-hours into text-model-hours.

### 5.2 Anchor numbers (why the constants are believable)

- **Perception dominance**: H3 ingests ~4096 vision tokens per reference
  (2048-px short edge) **[DOC ecosystem-2026-09 lane 3]**; llama-video's client
  measured ~200 tokens (4 frames @ 280×280) → 200k+ (64 frames @ 1080p)
  **[DOC video-dataset-prep §2.2** — the token-budget bar exists because this
  axis is the budget**]**; Gemma 4's fixed visual budgets 70/140 = "fast video
  understanding" **[DOC]**. Mid-density captions are O(100–300) tokens — so
  T_img/T_gt ratios of 3–1000× depending on frame sampling: τ ≪ 1 is the norm,
  not an assumption.
- **Text-only refinement is the established multi-pass shape**: dense capture →
  condense, with pass 2 running on caption TEXT alone (no vision) — Wolf
  (arXiv 2407.18908) chains dense per-segment captions into a summarization pass;
  Scale AI's production pipeline stages similarly **[DOC-papers via
  video-dataset-prep §2.5]**.
- **Sub-agent return economics**: Anthropic's sub-agents explore "tens of
  thousands of tokens" internally and return ~1,000–2,000-token summaries
  **[DOC]** — the same perception-once/decisions-are-small shape at the agent
  level.
- **Context-side savings compound it**: Code Mode's 32–81% task-token reductions
  **[COMM]** apply to the wrangling calls around the passes.

### 5.3 Pass-budget UX patterns (what other tools show the user)

| Pattern | Source | What it is |
|---|---|---|
| Live token-budget bar | llama-video Gradio WebUI **[DOC video-dataset-prep §2.2]** | shows the perception token cost of the current frame-sampling choice before submit — the single most transferable widget |
| Per-shot QA measures + coverage advice | LoRA Dataset Studio **[DOC §1.1]** | per-item quality telemetry feeding "what's missing" guidance |
| Budget ceilings as data | reply `SandboxLimits` **[DOC-local]** | iterations/time/memory/output caps declared per execution, not buried in code — the run-level analogue of a pass budget |
| Human-gated suspension | Mastra suspended runs + `approveToolCall` **[DOC-C7]** | a pass can park itself awaiting approval; budget UX extends naturally ("this batch will cost ~X, approve?") |
| Estimate-before-submit + hard caps | the ecosystem doc's API-billing lesson **[DOC ecosystem lane 8]** | show estimated cost before submit; hard caps — mandatory once API providers exist |
| Dense→condense as the default 2-pass plan | Wolf/Scale lineage + guide §4.4 templates **[DOC-papers]** | the minimal profitable multi-pass shape; deeper spines extend it |

### 5.4 The scout-model pattern (small-fast scouts, big-model final drafts)

Prior art, strongest first: reply ships `category: fast` vs `category: precise`
(GLM-5-turbo 450B vs GLM-5.2 1M-context) as first-class registry categories with
aliases `fast`/`best` **[DOC-local]**; llama-video ships `default` vs `precise`
presets **[DOC]**; pydantic-ai capabilities declare `fallback_subagent_model`
per-capability (delegate XSearch to grok when the primary can't) **[DOC-C7]**;
Claude Code's Haiku-class scout sub-agents are the canonical product example
**[COMM]**. The token-level cousin is speculative decoding (draft-verify), which
formalizes cheap-draft/expensive-verify as a decoding algorithm **[COMM]** — the
agent-level version swaps decode steps for passes.

For the harness: scouts draft (dense capture, clustering, triage, first-pass
condense), the big model finishes (final caption draft per class template), VLM
scores. This maps 1:1 onto decision 5's "any model slottable into any pass, the
router assigns by measured strength" — the capability registry (§3) is what makes
the assignment declarative.

---

## 6. Stack evidence — Python vs TypeScript vs split

What the current ecosystem actually favors, per half. No premature pick — this is
the evidence table for the spec round.

### 6.1 The agent-loop + provider + KB core

| Dimension | Python | TypeScript |
|---|---|---|
| Agent frameworks | **pydantic-ai v2.0.0** (provider-adaptive capabilities w/ native→local fallback — the closest existing implementation of decision 3; official `-harness` capability library; tool-approval hooks) **[DOC-C7]**; LangGraph 1.0.x (durable execution, checkpoints, HITL) **[DOC-C7]** | **Mastra** (durable agents, suspended runs/approvals, MCP client, Postgres storage) **[DOC-C7]**; LangGraph.js **[DOC-C7]**; Vercel AI SDK (interop proven — Mastra ships AI-SDK-UI adapters) **[DOC-C7]** |
| Provider abstraction | **LiteLLM** (uniform OpenAI shape over 100+ providers, cost maps, budgets) **[DOC-C7]**; reply itself (protocol-per-endpoint) **[DOC-local]** | AI SDK provider registry / direct OpenAI-compatible clients; thinner than LiteLLM's cost-map machinery **[COMM]** |
| MCP server SDKs | Official; **FastMCP ships inside the official `mcp` package** (`from mcp.server.fastmcp import FastMCP` — as used in pydantic-ai's own docs) **[DOC-C7]** | Official; the TS SDK is the spec's reference implementation (schema authored in TS) **[DOC-C7]** |
| KB / embeddings tooling | Native: sentence-transformers/local embedding models, numpy, the whole dataset-side adopt-list (videohash, PySceneDetect, whisper.cpp bindings) **[DOC video-dataset-prep §5.1]** | transformers.js exists but is a thin second-class citizen for this **[COMM]** |
| Trace/eval tooling | OTel GenAI conventions language-agnostic; LangSmith/Phoenix Python-first **[COMM]** | Mastra built-in observability with storage domains **[DOC-C7]** |
| On this box | jcodemunch, jdocmunch, **reply** — all Python MCP servers already running **[DOC-local]** | The Studio (the future MCP client) is Node 20+/TS/React **[DOC-local architecture.md]** |

### 6.2 The webUI

TS/React is the Studio's lineage (component patterns, the person maintaining it);
Python-side UIs in this exact domain (LDS: Flask+JS) are the exception, not the
pattern **[DOC video-dataset-prep §1.1**. Mastra's AI-SDK-UI adapters show the TS
framework path for agent UIs **[DOC-C7]**.

### 6.3 The split option (and what the box already proves)

Decision 1 makes the Studio *one client via MCP* — the seam already exists and
already crosses languages on this box (TS Studio ↔ Python MCP servers). A split
(Python harness core as the MCP service + Postgres owner; TS/React webUI speaking
MCP/HTTP to it) adds a second runtime to ship, but the MCP boundary forces the API
discipline the standalone project wants anyway, and the dual-use deliverable
(per-model doctrines consumed by the Studio's caption surfaces) is an MCP contract
either way.

Honest costs of each: **All-Python** — one runtime, the strongest loop/provider/KB
library bench; UI is the weak half (React-in-Python or a second TS island anyway).
**All-TS** — one language with the Studio's skills; the capability-adaptive and
cost-map machinery gets rebuilt by hand (Mastra covers more of it than expected —
approvals, durable runs, storage — but LiteLLM-class provider economics has no TS
peer) **[COMM]**. **Split** — best-half-of-each; two runtimes, one contract; the
box's established pattern.

What the evidence *leans* (not picks): Python for the core (the decision-3 pattern
exists off-the-shelf there; the dataset-side dependencies are Python; reply's
battle-tested conventions port 1:1), TS for the webUI, MCP as the seam — i.e. the
split, with the explicit caveat that the spec round should price the two-runtime
operational cost against how much of Mastra+AI-SDK would cover the TS-full-stack
alternative.

---

## Verdict table

| Question | Verdict | Confidence |
|---|---|---|
| Adopt Code Mode for the harness? | Yes, for the dataset-wrangling surface (batch/filter/paginate/export as generated code over a spec/catalog); keep perception/scoring/commit as tool SKUs; adopt reply's sandbox discipline (AST dunder-block, builtins whitelist, `SandboxLimits`, capability tiers) | [DOC]+[DOC-local] synthesis |
| Code Mode numbers to plan against | Tool-def footprint fixed ~1k tokens vs 1.17M native (99.9%); task tokens −32% simple / −81% complex; "50+ tools ≈ 7% context" is the trigger threshold | [DOC]+[COMM] |
| Trace format | Two-representation discipline: append-only `trace_events` in Postgres (full fidelity, capped previews, media by reference) + curated in-context digest; summaries reference seq ranges; KB entries promoted by ≥2 corroborating runs, fetched JIT — §2.3 schema | [DOC-local]+[DOC] synthesis |
| Trace vocabulary | Name fields after OTel GenAI (`gen_ai.usage.*`, `conversation.id`) — conventions are Development status, adopt vocabulary not dependency | [DOC] |
| Provider contract | Registry row = reply `ModelSpec` ∪ OpenRouter/LiteLLM field vocabulary; carry `effective_context` separately from `context_window`; capabilities drive routing with declared fallbacks (pydantic-ai pattern); cost ledger always on (0.0 local) | [DOC-local]+[DOC-C7] |
| Local→API transition | Same registry, API rows seeded from OpenRouter/LiteLLM metadata; async + compaction always armed + estimate-before-submit + hard caps; nothing assumes local latency | [DOC]+[DOC-local] |
| pgvector engine | v0.8.6, HNSW + halfvec expression indexes, iterative scans for filtered queries, `<=>` cosine; MMR re-ranks client-side over ANN candidates; near-dup = incremental ANN-threshold edges + connected components | [DOC] + [SPEC] composition |
| Single-box ops | Schema-as-code from day one; `ALTER EXTENSION vector UPDATE` upgrades; pg_dump nightly (rebuild HNSW on restore); pgvectorscale watchlisted behind the license gate | [DOC]+[COMM]+[SPEC] |
| Cost model | Chain wins while `s < (k − 1 − k·τ)/(k·(1+ε))`; at τ≈0.1–0.15, s=0.1: ~33–48% of naive multi-pass at k=3–8, and vision-GPU passes drop from k to 1+s·k per item — the throughput answer; full re-verify (s→1) can exceed naive: sampling is the knob, quality is the justification | formalization over [DOC] anchors |
| Pass-budget UX | Adopt: live token-budget bar (llama-video), estimate-before-submit + hard caps (billing lesson), approval-suspended runs (Mastra pattern), budget ceilings as data (reply `SandboxLimits`) | [DOC]+[DOC-C7] |
| Scout pattern | Registry categories fast/precise (reply), default/precise presets (llama-video), per-capability fallback subagent models (pydantic-ai); scouts draft, big model finishes, VLM scores | [DOC-local]+[DOC-C7]+[COMM] |
| Stack | Evidence leans Python core (capability-adaptive framework, LiteLLM economics, dataset-side deps, reply conventions, the box's Python MCP fleet) + TS webUI + MCP seam; TS-full-stack via Mastra is the credible alternative; spec round prices two-runtimes-vs-rebuild | [DOC-C7]+[DOC-local], honest [COMM] gaps |

## Sources (all fetched/verified 2026-09-18 unless noted)

**Primary code reads [DOC-local]** — reply MCP @ `8a0e67c2` (`~/work/VS Proj/reply`):
`reply/repl/{compaction,context,events,execution_tree,capabilities,sandbox,executor}.py`,
`reply/models/{types,registry}.py`, `models.yaml`, `reply/permissions.py`;
architecture.md (Studio stack, LLM layer); CLAUDE.md (box rules).

**Fetched official [DOC]**: blog.cloudflare.com/code-mode-mcp (2026-02-20,
mod. 2026-07-15); anthropic.com/engineering/effective-context-engineering-for-ai-agents
(2025-09-29); raw.githubusercontent.com/pgvector/pgvector README (v0.8.6);
raw.githubusercontent.com/ollama/ollama docs/api.md; live openrouter.ai/api/v1/models;
open-telemetry/semantic-conventions-genai (README + docs/gen-ai/gen-ai-agent-spans.md,
Development status).

**Context7-indexed current docs [DOC-C7]**: OpenRouter API reference (models
schema, legacy provider schema); docs.litellm.ai (custom pricing, provider
registration, register_model); modelcontextprotocol spec 2026-07-28 (server
capabilities) + pydantic-ai docs (FastMCP in official SDK); pydantic/pydantic-ai
v2 (capabilities, MCP native/local, harness package); mastra-ai/mastra (durable
agents, storage, suspended runs, MCPClient); LangGraph resolve listing (v1.0.x,
durable execution/HITL/memory).

**Community [COMM]**: WorkOS Code Mode analysis (2025-12-11, 32%/81%);
tianpan.co (98–99% claim, 2026-01-29); Towards AI "Is MCP Dead?" (2026-04-02,
LeanIX 7%-context figure); ThursdAI (Anthropic code-execution/Ultra Code claims);
NVIDIA OO Agents arXiv (Jul 2026); LangChain PGVector MMR client-side re-rank;
pgvectorscale claims; transformers.js thinness.

**Internal cross-refs**: video-dataset-prep-tools.md (2026-09-17 — managers,
llama.cpp mechanics, curation, the adopt-list); ecosystem-2026-09.md (H3 vision
tokens, API-billing lesson); h3-lora-training-guide.md §4 (caption doctrine
precedent); task 6niii1p directive (the six binding decisions).
