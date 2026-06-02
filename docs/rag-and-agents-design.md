# AKIS MVP — Auto-RAG & Agents/Workflows Design (agentic-core revision)

> **Status:** design-direction, NOT yet implemented. Companion to `HANDOFF.md`.
> **⚠️ Revised 2026-06-01** to sit on the **agentic core** actually being built (PR #1 `feat/agentic-core-gates`, PR #2 `feat/real-providers`) — NOT the FSM the original handoff assumed. See §0.
> **Scope:** two additive features — (1) zero-touch **auto-RAG**, (2) an **Agents & Workflows** tab (roster + workflow presets + model picker + live preview). Both sit *inside* the agentic-core's structural guarantees, never bending the 4 gates.
> **Branch:** `claude/akis-agents-rag-system-NDTAH`.

---

## 🇹🇷 Özet (bu ne?)

İki özelliği, MVP'nin **agentic** çekirdeğine (PR #1/#2) oturtuyoruz:

1. **Otomatik RAG.** Kullanıcı elle hiçbir şey eklemez. Konuşma, ajan çıktıları (spec/kod), Critic/verify sonuçları, GitHub repo ve doküman yüklemeleri **AkisEvent stream'ine abone olarak** otomatik ingest edilir. Embedding + arama **sunucu tarafında (pgvector)**. RAG, FSM'e değil — **orchestrator/alt-ajanların çağırabildiği bir `retrieve_knowledge` tool'u** + bir DI port'u olarak takılır. 4 gate'e dokunmaz.
2. **Agents & Workflows tabı.** Ana orchestrator ajanı **"AKIS"** + Scribe/Proto/Trace/Critic çekirdek rolleri görünür/yapılandırılır; **ekstra/özel ajanlar** (roster "config+prompt ile genişletilebilir") eklenebilir ama yapısal yetenekleri (verifier olma, push token üretme) **alamaz**. Bir **"workflow"** = agentic akışı *tohumlayan/kısıtlayan* adlandırılmış preset: hangi ajanlar/araçlar açık, hangi skill'ler ön-seçili, **ajan başına model** (PR #2 catalog + KeyStore + model picker), gate politikası, RAG ayarları. **Model picker** PR #2'nin endpoint'lerini tüketir (senin "kendi/başka provider key'leri" isteğin). **Canlı preview** ekranı AkisEvent `preview` + per-lane stream'i tüketir; UI/UX düzgün tasarlanır.

**Zamanlama:** Savunma sonrası. v1 dokunulmaz.

---

## 0. ⚠️ The substrate changed — what we now build on

The original `HANDOFF.md` locked an **explicit FSM + transition table**. The team's sub-project #1 **consciously reversed that** (documented in `docs/superpowers/specs/2026-06-01-agentic-core-gates-design.md §0`): flow is now **agentic** — a main orchestrator agent decides which sub-agents/skills to dispatch — and the thesis ("quality trust") is preserved by **4 structural gates**, not a fixed sequence. This design is rebased onto that reality.

**Seams already built that we consume (do NOT rebuild):**

| Seam | Where | We use it for |
|---|---|---|
| Main orchestrator agent + sub-agents (`orchestrator`/`scribe`/`proto`/`trace`/`critic`) | `backend/src/orchestrator/` | The roster the Agents tab displays/configures; "AKIS" = the orchestrator's display name. |
| `Role` union + `ToolName` + verifier-only matrix | `shared/src/roles.ts` | Workflow validation surface (replaces "transition table"). |
| 4 structural gates (branded tokens) | `backend/src/gates/`, `shared/src/{approval,verify,session}.ts` | The inviolable invariants a workflow can never disable. |
| `AkisEvent` stream (per-agent/lane, backend-stamped `ts`) | `shared/src/events.ts`, `backend/src/events/bus.ts` | RAG auto-ingestion trigger **and** the live-preview feed. |
| Skill registry (`.md`+frontmatter, select+inject) | `backend/src/skills/` | A workflow's pre-selected skill set. |
| `LlmProvider` + `createProvider` + `catalog.ts` + encrypted `KeyStore` + `GET/PUT/DELETE /api/providers` | `backend/src/agent/`, `backend/src/keys/`, `backend/src/api/providers.routes.ts` | The **model picker** (per-agent model + user/other-provider keys). FE picker was explicitly deferred — the Agents tab is its home. |
| `OrchestratorServices` DI container | `backend/src/di/services.ts` | Where the RAG `KnowledgePort` is injected (NOT into the orchestrator god-file). |

**The one conceptual remap:** "workflow = config validated against the FSM transition table" → **"workflow = a preset that seeds the orchestrator's enabled agents/tools/skills/models + gate policy, validated against the role/tool permission matrix + the 4 gate invariants."** The gates stay structural; a workflow can only operate *within* them.

---

## PART A — Auto-RAG on the agentic core

### A.1 Goal (unchanged)
Always-on, never-hand-configured retrieval that improves agent outputs. The user never clicks "add to knowledge base."

### A.2 How it plugs in — a tool + an event subscriber (NOT an FSM hook)

- **Retrieval = a tool.** Add `retrieve_knowledge` to the tool registry, available to `orchestrator`, `scribe`, and the `ask`/`chat` path. Agents *choose* to call it (agentic), exactly like every other tool. It is read-only and holds no gate capability, so it is safe to expose widely.
- **Ingestion = an AkisEvent subscriber.** A `knowledge/` module subscribes to `events/bus.ts`. The event stream is already the single, backend-stamped source of truth (`ts` stamped at emit) — so ingestion reuses it instead of re-deriving state. Mapped triggers:

| Source | AkisEvent / state | Ingested content |
|---|---|---|
| Conversation | `text` events (+ user input) | message text + `agent` + `laneId` |
| Agent outputs | `SessionState.spec` / `.code` on `agent_end` / artifact commit | Scribe spec, Proto code files |
| Verification | `verify` event, Critic results | test outcomes, critic findings |
| GitHub repo | repo connect / push (via MockGitHubAdapter → real later) | repo file tree + contents, incremental by commit |
| Uploads | upload endpoint persist | parsed PDF/markdown/text |

### A.3 Module shape (DI-injected, decoupled)

```
backend/src/knowledge/
  ingestion/
    sources/{conversationSource,agentOutputSource,repoSource,uploadSource}.ts  # each implements IngestSource
    eventSubscriber.ts   # bridges events/bus.ts → ingestQueue
    ingestQueue.ts       # async, idempotent (content-hash), ≤3 retries + dead-letter
    chunker.ts           # structure-aware (code/spec/prose)
    embedder.ts          # EmbeddingProvider port (+ adapters)
  retrieval/{retrieve.ts, reranker.ts}   # hybrid vector+BM25, optional rerank
  store/{knowledgeSchema.ts, knowledgeRepo.ts}   # pgvector (Drizzle)
  knowledgePort.ts       # { ingest(record), retrieve(query, ctx) } — the only surface
  knowledgeTool.ts       # registers `retrieve_knowledge` in the tool registry
  index.ts
```

`knowledgePort` is registered in `di/services.ts` and handed to the tool layer + the event subscriber. The orchestrator never imports the knowledge internals — same decoupling discipline the rest of the core uses.

### A.4 Embedding provider — reuse the #2 pattern
Embeddings need a model too, but `LlmProvider` is a chat seam. Add a sibling **`EmbeddingProvider`** port and let it **reuse PR #2's `KeyStore` + a catalog entry** so the user's existing keys (e.g. OpenAI/Voyage) double as embedding keys — no second key-management system. Default provider = open decision #1; pluggable.

### A.5 Quality, provenance, tenancy, failure (carried from the reviewed spec)
Hybrid vector + BM25 + optional rerank; structure-aware chunking; golden eval set with a top-5 ≥80% CI gate; provenance `{source, sourceId, userId, sessionId, agent?, commitSha?, createdAt}`; tenancy filtered by `user_id` in the query (negative test); `≤3` retries + dead-letter; secret/binary exclusion before embedding; deletion + observability + re-index path. (Full ACs in `specs/rag-and-agents-spec.md`.)

### A.6 Data model
```
knowledge_chunks
  id uuid pk · user_id uuid (tenancy filter) · session_id uuid (scope)
  source text · source_id text · agent text null · commit_sha text null
  content text · content_hash text (dedup) · embedding vector(N) · tsv tsvector
  created_at timestamptz (backend-stamped)
```
`session_id` replaces the old `workflow_id` (the unit of work in the agentic core is a session). Migration index reserved per `HANDOFF.md §7`.

---

## PART B — Agents & Workflows tab

### B.1 Three things the tab does (all the user's asks)
1. **Agent roster** — show + configure **AKIS** (the orchestrator) and **Scribe/Proto/Trace/Critic**, plus **add extra/custom agents**.
2. **Workflow presets** — compose, name, version, and select a workflow (a preset that seeds an agentic run).
3. **Model picker** — per-agent model + provider/key management, consuming PR #2.
Plus a **live preview** pane consuming the AkisEvent stream.

### B.2 Agent roster (core + extensible)
- **Core roles** (`orchestrator`/`scribe`/`proto`/`trace`/`critic`) are **structural, defined in code** — the gates key on them (`roles.ts`). Displayed with their thin base prompt + selectable skills + assigned model. "AKIS" is the orchestrator's display name.
- **Extra/custom agents** are added by **config + base prompt + skills** (sub-project #1's locked "roster extensible by config + prompt"). **Hard constraint:** a custom agent is a non-core role; it can be dispatched and given read/compose tools, but **cannot** be granted the verifier capability, cannot mint approval/push tokens, and cannot receive `run_tests`/`push_to_github`. The 4 gates remain code-defined and unreachable by config. This is what lets "extra agents + extra things I want" stay safe.

### B.3 What a "workflow" is here
A typed, versioned **`WorkflowConfig`**: a saved bundle of
- **enabled agents/tools** (subset of the roster + tool registry),
- **pre-selected skills** per agent (drives `skills/registry.ts` selection),
- **per-agent model** (`{providerId, modelId}` from `catalog.ts`),
- **gate policy** (only tightening is allowed — e.g. "always require critic resolution"; the 4 structural gates can never be loosened/removed),
- **iterate budget** + **RAG settings** (which sources, rerank on/off).

The orchestrator still decides *flow* agentically at runtime; the workflow only **seeds and bounds** its toolset/skills/models. This is the honest "Claude-Code-like workflow builder" on an agentic core.

### B.4 Validation (replaces "validate against transition table")
On save, a `WorkflowConfig` is validated against:
- the **role/tool permission matrix** (`roles.ts`) — it cannot grant a producer a verifier-only tool;
- the **gate invariants** — it cannot disable spec-approval, producer≠verifier, verified=real-test, or push;
- the **catalog** — every `{providerId, modelId}` must exist.
An invalid config is **rejected at save time** with a clear error — never a runtime surprise.

### B.5 Model picker (the explicit ask — built on PR #2)
- Reads `GET /api/providers` → `[{id,label,available,defaultModel,models[],last4?}]`.
- Lets the user **add/replace/remove keys** via `PUT/DELETE /api/providers/:provider/key` (encrypted at rest; `last4`-only display; key never echoed).
- Assigns a **model per agent** (e.g. AKIS=Opus 4.8, Proto=Sonnet 4.6, Trace=Haiku 4.5) persisted in the `WorkflowConfig`.
- This is exactly the FE ModelPicker that #2 deferred; it lands here.

### B.6 Live preview screen (the explicit UI/UX ask)
- Consume the `AkisEvent` stream: render a **live, possibly-parallel step tree** (per `agent` + `laneId`), the **gate moments** (`gate` events = the trust UI), `verify` results, and the `preview` event (`{kind:'preview'; url}`) in a dedicated pane.
- This is sub-project #1's deferred "top-right live preview." Design it cleanly: agentic timeline on one side, live preview on the other; gates surfaced as first-class approve/confirm cards (not buried).
- i18n catalogue for every string (TR+EN), CI lint gate; feature-sliced contexts (no prop-drilling) — the bug-classes from `HANDOFF.md §6` still apply to new FE.

### B.7 Module shape
```
backend/src/workflows/
  workflowConfig.ts    # typed WorkflowConfig + AgentConfig (+ custom-agent shape)
  workflowStore.ts     # versioned persistence (Drizzle); in-flight runs pin their version
  validateWorkflow.ts  # vs roles matrix + gate invariants + catalog
  customAgents.ts      # register non-core agents (config+prompt+skills, no gate caps)
  index.ts
frontend/src/features/agents/
  AgentsTab.tsx · agentCard/ · modelPicker/ (consumes /api/providers)
  workflows/{WorkflowList,WorkflowBuilder,WorkflowPreview}.tsx
  preview/LivePreview.tsx + thread/ (AkisEvent step tree) + gates/
  state/  # contexts, not a prop bag
  index.ts
```
The orchestrator consumes a resolved `WorkflowConfig` (enabled tools/skills/models) at session start; it gains **no new control flow**; the gates and `roles.ts` matrix are unchanged.

---

## PART C — Parallel-session ownership lanes (additive)
- **Lane D — BE `knowledge/`** (auto-RAG): owns ingestion/retrieval/store + the `retrieve_knowledge` tool. Shared surface = `KnowledgePort` + one tool registration + an `events/bus.ts` subscription (read-only).
- **Lane E — BE `workflows/` + FE `features/agents/`**: owns config/validation, the tab, model picker, live preview. Shared surface = reads `roles.ts`/`catalog.ts`/gates (read-only) + supplies a `WorkflowConfig` to the orchestrator + consumes `/api/providers` + the event stream.
Frozen contracts before dispatch: `KnowledgePort`, `IngestRecord`, `RetrievalResult`, `EmbeddingProvider`, `WorkflowConfig`, `AgentConfig`, `CustomAgentSpec`. BE/FE separate PRs.

---

## PART D — Phasing (post-defense)
1. **M0 — Frozen contracts** (above) + `knowledge_chunks` migration (with `user_id`/`session_id`). Depends on #1+#2 merged.
2. **M1 — Auto-RAG core:** store + `EmbeddingProvider` (reusing KeyStore) + `ingestQueue` + `conversationSource`/`agentOutputSource` + hybrid `retrieve` + `retrieve_knowledge` tool wired to orchestrator/Scribe/ASK behind a flag; golden-eval + round-trip tests.
3. **M2 — Remaining RAG sources + rerank:** `repoSource` (real GitHub later), `uploadSource`, reranker, dedup/tenancy hardening.
4. **M3 — Agents tab (read-only) + model picker:** roster view + per-agent model assignment consuming `/api/providers` (delivers the deferred #2 ModelPicker).
5. **M4 — Workflow config + validation:** `WorkflowConfig`, `validateWorkflow` (roles matrix + gates + catalog), versioned store, custom-agent registration (no gate caps).
6. **M5 — Workflow builder + live preview UI:** compose/save/select; `WorkflowPreview`; the live AkisEvent preview pane + gate cards.

Each milestone behind a flag, own BE/FE PR, demo path untouched.

---

## PART E — Open decisions (before M1 code)
1. **Embedding provider default** (Voyage / OpenAI `text-embedding-3` / self-hosted) → fixes `vector(N)`; reuse KeyStore for its key. (Privacy: a 3rd-party processor receives ingested content.)
2. **Rerank budget** — orchestrator/Scribe path vs ASK-only (must fit retrieval p95 < 300 ms).
3. **Repo ingestion guardrails** — full vs changed-files; max size. (Secret/binary exclusion mandated, not optional.)
4. **Custom-agent capability surface** — exactly which read/compose tools a non-core agent may hold (never gate caps).
5. **Workflow gate policy** — confirm it is *tighten-only* (can add required gates, never remove the 4 structural ones).
6. **Model-selection persistence** — per-workflow (recommended) vs per-session override (PR #2 deferred this).

---

_Revised 2026-06-01 onto the agentic core (PR #1/#2). The 4 structural gates — not an FSM — are now the invariant everything sits inside._
