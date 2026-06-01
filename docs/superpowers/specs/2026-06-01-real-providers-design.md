# Design — Sub-project #2: Real AI Providers + Key Management

> **Status:** design, awaiting user review.
> **Date:** 2026-06-01.
> **Scope:** make AKIS run on real LLMs behind the existing `LlmProvider` seam — Anthropic, OpenAI, OpenRouter, Gemini — with tool-calling, a provider/model selection factory, and an encrypted key store + minimal HTTP endpoints. The mock provider, the 4 gates, and the contract test stay intact and green.
> **Inputs:** the 2026-06-01 provider research workflow (Anthropic/OpenAI/OpenRouter/Gemini APIs + v1 reference, no code copy) and `docs/superpowers/specs/2026-06-01-agentic-core-gates-design.md` (sub-project #1).

---

## 0. Context & non-negotiables

Sub-project #1 built the agentic core on a narrow seam: `LlmProvider.chat(req) → ChatResult`, with only a deterministic `MockProvider`. The 4 gates (spec-approval, producer≠verifier, verified=real-test, push) live entirely in the orchestrator/gates/verify modules — **not** in the provider — so adding real providers must not touch them.

**Carried-over invariants (must remain true):**
- The 4 structural gates and `THREAT-MODEL.md` posture are unchanged. No provider code imports a gate minter.
- `npm test` = `tsc --noEmit && vitest run`; all existing tests + the mock smoke stay green **with zero env / no real keys**.
- Branded tokens, capability encapsulation (Verifier / ApprovalAuthority), fail-closed verification — untouched.

## 1. Locked decisions (this session)

| Topic | Decision |
|---|---|
| Providers | **All four**: Anthropic, OpenAI, OpenRouter, Gemini. (OpenAI + OpenRouter share one OpenAI-compatible adapter; Anthropic + Gemini separate.) |
| Key management | **Encrypted KeyStore (AES-256-GCM) + minimal Fastify server + 3 endpoints** (`GET /api/providers`, `PUT/DELETE /api/providers/:provider/key`). FE ModelPicker component is deferred to the FE sub-project; these endpoints unblock it. |
| Loop default model | **`claude-haiku-4-5-20251001`** (cheapest/fastest; protects the user's Max quota). The catalog may badge a different model "recommended" for the future picker. |
| Seam change | **Additive only** — add optional `ToolCall.id?`, `ChatMessage.toolCallId?`, `ChatMessage.toolCalls?`. No breaking change; MockProvider ignores them. |
| HTTP client | **Raw `fetch` + AbortController**, no SDK (zero deps, one path). Revisit `@anthropic-ai/sdk` only when streaming lands. |
| KeyStore backend | **JSON file** (survives restart, no new dep, single-user MVP). SQLite when auth lands. |
| Streaming | **Deferred** — `chat()` returns a full `ChatResult`; add optional `chatStream?` in the live-UI sub-project. |
| Model-selection persistence | **Deferred** — per-session `createProvider({provider, model})` is enough until the picker exists. |
| Fallback | `createProvider` falls back to `MockProvider` when no key is configured **or** `NODE_ENV==='test'` (load-bearing: keeps tests/smoke green). |

## 2. The seam extension (additive, the one real impedance point)

The only mismatch with real APIs is **tool-call ID correlation**: OpenAI and Anthropic both reject a tool result that lacks an id whose preceding assistant turn carries the matching tool call. Fix = 3 optional fields + thread them through the loop.

`backend/src/agent/LlmProvider.ts` (add optionals only):
```ts
export interface ToolCall { name: string; args: unknown; id?: string }
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolCallId?: string        // on role:'tool' — correlates to the assistant tool call
  toolCalls?: ToolCall[]      // on role:'assistant' — carries the tool calls made that turn
}
export interface ChatResult { text?: string; toolCalls?: ToolCall[]; usage?: { inTokens: number; outTokens: number }; stopReason?: string }
```
`backend/src/agent/AgentLoop.ts` (3 surgical edits, termination contract unchanged — loop still ends when `toolCalls` is empty/undefined): attach `res.toolCalls` to the assistant message push; set `toolCallId: call.id` on the tool-result and permission-denied pushes; synthesize an id when a provider omits one.

> Note: sub-project #1 deleted `AgentLoop` (option A — the orchestrator drives sub-agents imperatively). **This sub-project re-introduces the provider seam at the sub-agent level**, not a full agent loop: each sub-agent that calls an LLM does so through `provider.chat()`. The tool-call threading applies wherever a sub-agent does multi-turn tool use (Proto/Trace in the real path). For the MVP we keep sub-agents single-call where possible; the seam fields exist so multi-turn tool use is correct when added. (If no sub-agent does tool use yet, the fields are dormant but present — no fragile retrofit later.)

## 3. Architecture

```
backend/src/agent/
  LlmProvider.ts            # seam (extended additively)
  providers/
    catalog.ts              # single source of truth: model IDs + recommended flags + per-provider baseURL defaults
    resolve.ts              # detectProviderFromKey (prefix sniff) + provider/model resolution
    createProvider.ts       # THE factory: arg > env > key-prefix; mock fallback (no key / NODE_ENV=test)
    http.ts                 # shared fetch wrapper: withRetry (429/5xx + Retry-After), AbortController timeout, typed AuthError/ModelNotFoundError, header redaction
    AnthropicProvider.ts    # /v1/messages; x-api-key + anthropic-version; system top-level; input_schema tools; tool_use/tool_result; max_tokens required
    OpenAiCompatibleProvider.ts  # /chat/completions; Bearer; system message; function tools; tool_call_id; JSON.parse(arguments) defensively. 2 instances: openai + openrouter
    GeminiProvider.ts       # /models/{model}:generateContent; x-goog-api-key; systemInstruction; functionDeclarations; role 'model'; functionResponse object
  mock/                     # MockProvider (unchanged)
backend/src/keys/
  crypto.ts                 # AES-256-GCM encryptSecret/decryptSecret, scoped AAD, 12-byte IV, authTag, keyVersion
  KeyStore.ts               # interface + JsonFileKeyStore: {provider, cipherText, iv, authTag, keyVersion, last4, updatedAt}
backend/src/api/
  server.ts                 # minimal Fastify app (first server in the repo)
  providers.routes.ts       # GET /api/providers · PUT/DELETE /api/providers/:provider/key
backend/.env.example        # names only (created; .env stays gitignored)
backend/test/integration/live-provider.smoke.ts  # guarded: skips when no real key (CI stays green)
```

### 3.1 Adapters — shared request/response mapping
- **Request:** `system` → top-level (Anthropic `system`, Gemini `systemInstruction`), prepended `{role:'system'}` message (OpenAI). Tools → each provider's shape, passing `ToolSpec.schema` straight through (`function.parameters` / `input_schema` / `functionDeclarations`). Messages → reconstruct the assistant tool-call turn from `ChatMessage.toolCalls`; tool results per provider (OpenAI `{role:'tool',tool_call_id}`, Anthropic `{role:'user',content:[{type:'tool_result',tool_use_id}]}` **first block, immediately after the tool_use turn**, Gemini `{role:'user',parts:[{functionResponse:{response:<object>}}]}`).
- **Response → `ChatResult`:** text (concat text blocks/parts); `toolCalls` (OpenAI `arguments` is a **string** → `JSON.parse` with `{}` fallback; Anthropic `input` / Gemini `args` are **objects**); usage from the provider's token fields. Empty `toolCalls` ⇒ loop terminates.
- **Errors (typed):** 401/403 (Gemini: 400 `PERMISSION_DENIED`) → `AuthError`; 404 → `ModelNotFoundError`; 429/5xx → retry with backoff+jitter honoring `Retry-After`.

### 3.2 `createProvider` — the single swap point
`createProvider(opts?: { provider?, model?, apiKey? }): LlmProvider` — provider from `opts > AI_PROVIDER > detectProviderFromKey`; model from `opts > AI_MODEL > catalog default`; **falls back to `MockProvider`** when no key or `NODE_ENV==='test'`. `buildServices` already accepts any `LlmProvider`, so wiring is: real critic backend = `createProvider().chat(...)` replacing the mock `generateText` closure (behind the same interface). The verifier's `TestRunner` stays mock in this sub-project (real test execution = the sandbox sub-project).

### 3.3 Key security (encrypted at rest)
- AES-256-GCM, 32-byte master key from `AI_KEY_ENCRYPTION_KEY` (hex/base64), random 12-byte IV per encrypt, scoped AAD `akis:ai-key:<provider>` (replay-binding). Persist `{provider, cipherText, iv, authTag, keyVersion, last4, updatedAt}`.
- Plaintext exists only transiently (encrypt on PUT, decrypt right before constructing a provider). `GET` returns only `{provider, configured, last4, updatedAt}` — **never** the key/ciphertext. No key in logs, EventBus payloads, or error strings (errors reference provider name only). Missing master key → clear `ENCRYPTION_NOT_CONFIGURED` error, not a stack trace.

## 4. Endpoints
- `GET /api/providers` → `[{ id, label, available, selectedModelId?, models: [{id,label,recommended}], last4? }]`. `available = env key present OR KeyStore has a decryptable key`. Adding a 5th provider is a backend-only change.
- `PUT /api/providers/:provider/key { apiKey }` → trim, validate shape, encrypt, store, return `{ last4 }`. No body logging.
- `DELETE /api/providers/:provider/key` → remove.

## 5. Catalog (single source of truth, June-2026 IDs)
- **Anthropic:** `claude-haiku-4-5-20251001` (loop default), `claude-sonnet-4-6` (recommended badge), `claude-opus-4-8`.
- **OpenAI:** `gpt-4.1-mini` (recommended), `gpt-4.1-nano`, `gpt-5-mini`.
- **OpenRouter:** a curated tool-calling-capable set (no `:free` slugs on the agentic path — unreliable for tools).
- **Gemini:** `gemini-2.5-flash` (recommended), plus a pro option.
Pinned dated IDs where available for reproducibility; the catalog is the only place model strings live.

## 6. What stays out (deferred, designed not to require a rewrite)
Streaming (`chatStream?`), the FE ModelPicker component + Vite/React scaffold, server-side model-selection persistence, per-turn model override UI, real sandboxed test execution (the verifier's TestRunner stays mock here), multi-user auth (KeyStore scope becomes `<userId>:<provider>` with no other change).

## 7. Testing strategy
- **Unchanged green:** all 56 existing tests + mock smoke, with zero env (the mock fallback is load-bearing — a test asserts `createProvider()` with no key returns a mock).
- **Adapter unit tests (no network):** request-mapping + response-parsing for each adapter against captured/representative JSON fixtures (tool-call id threading, OpenAI string-args parse, Anthropic tool_result ordering, Gemini object-response). `withRetry` (429 → retry, 401 → AuthError, 404 → ModelNotFoundError).
- **Crypto/KeyStore:** round-trip encrypt/decrypt, wrong-AAD rejection, `GET` never leaks key, missing-master-key error.
- **Endpoints:** `GET /api/providers` availability matrix; `PUT` returns last4 only + persists; `DELETE`.
- **Guarded live smoke:** `live-provider.smoke.ts` runs a real one-shot `chat()` per provider **only if** that provider's key is in env; otherwise skips (CI/no-key stays green).
- **Gate regression:** the §1-#1 contract test must pass unchanged — proof no provider code touched the gates.

## 8. Build order (each step: TDD where applicable, then independent review → fix)
1. Additive seam extension (`LlmProvider` optionals) + thread ids in the loop/sub-agent call sites; existing tests stay green.
2. `catalog.ts` + `resolve.ts` (`detectProviderFromKey`) + `createProvider` with mock fallback; unit tests incl. the no-key→mock assertion.
3. `http.ts` (withRetry + typed errors + header redaction) + unit tests.
4. `AnthropicProvider` + unit tests (fixtures).
5. `OpenAiCompatibleProvider` (openai + openrouter) + unit tests.
6. `GeminiProvider` + unit tests.
7. `crypto.ts` + `JsonFileKeyStore` + unit tests.
8. Minimal Fastify `server.ts` + `providers.routes.ts` (3 endpoints) + endpoint tests.
9. `.env.example` (names only) + guarded `live-provider.smoke.ts`.
10. Wire `createProvider` into `buildServices` (real critic backend behind the same interface; mock fallback preserved); full suite + mock smoke + gate contract test green.

## 9. Risks (from the research)
- **Tool-id threading** is the top correctness risk (both OpenAI + Anthropic 400 without it) → the additive seam de-risks it.
- **Anthropic traps:** `max_tokens` required; `tool_result` must be the first block immediately after the tool_use turn.
- **Arg-shape divergence:** OpenAI `arguments` is a string (parse), Anthropic/Gemini args are objects (don't); Gemini `functionResponse.response` must be an object; Gemini roles are strictly `user`/`model`.
- **Gemini auth = 400 PERMISSION_DENIED** (not 401) — error mapping must handle it.
- **Secret leakage** — explicit redaction guard, not discipline; tested.
- **Mock fallback is load-bearing** — if `createProvider` doesn't fall back, the whole suite breaks.
- **Model-ID drift** — pin dated IDs; catalog is the single edit point.

## 10. Definition of done
- All 4 providers implement `LlmProvider` behind `createProvider`; raw-fetch, typed errors, retry.
- Encrypted KeyStore + 3 endpoints; `GET` never leaks a key; keys never logged/emitted.
- `tsc` strict clean; the full existing suite + new adapter/crypto/endpoint tests green; mock smoke + the #1 gate contract test pass **unchanged**; guarded live smoke skips cleanly with no keys.
- `.env.example` documents every AI var by name; `THREAT-MODEL.md` updated with the key-handling posture.
- On its own branch `feat/real-providers`; reviewed by fresh-context subagents; must-fix findings closed before merge.
