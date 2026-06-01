# Real AI Providers + Key Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Make AKIS run on real LLMs (Anthropic, OpenAI, OpenRouter, Gemini) behind a clean `LlmProvider` seam, selected by a `createProvider` factory, with an encrypted key store + minimal HTTP endpoints — while the mock path, the 4 gates, and all existing tests stay green.

**Architecture:** Re-introduce `LlmProvider` (deleted in #1's option-A cleanup) as the provider seam. Each provider is one raw-`fetch` adapter implementing `chat(req) → ChatResult` with tool-calling. `createProvider` picks provider+model from arg > env > key-prefix and **falls back to a mock when no key / NODE_ENV=test** (load-bearing). The critic's existing `generateText(system,user)` DI seam becomes a thin adapter over `provider.chat`. Keys are AES-256-GCM encrypted at rest; a tiny Fastify server exposes `GET /api/providers` + `PUT/DELETE /api/providers/:provider/key`.

**Tech Stack:** TypeScript strict · Node `fetch` + AbortController (no SDK) · Fastify 4 · vitest. No microVM. No streaming yet.

**Spec:** `docs/superpowers/specs/2026-06-01-real-providers-design.md`
**Branch:** `feat/real-providers`

**Reality note (important):** sub-project #1 deleted `backend/src/agent/`. This plan **recreates** `LlmProvider` there; it does not extend an existing file. The only LLM call-site today is `CriticAIDeps.generateText` (in `buildServices`); Scribe/Proto/Trace are deterministic mocks and stay mock in this sub-project (real test execution = the preview/test sub-project). So "route agents through the provider" here means: the critic backend, and the `createProvider` factory feeding it. Sub-agents gain real LLM calls when their behavior is needed, behind the same seam.

---

## File structure

```
backend/src/agent/
  LlmProvider.ts            # the seam: Role-agnostic chat() + tool-calling types
  providers/
    catalog.ts              # model IDs + recommended flags + per-provider baseURL defaults (single source)
    resolve.ts              # detectProviderFromKey (prefix sniff) + provider/model resolution
    http.ts                 # postJson + withRetry + typed AuthError/ModelNotFoundError + redaction
    AnthropicProvider.ts
    OpenAiCompatibleProvider.ts   # openai + openrouter (baseURL/header differ)
    GeminiProvider.ts
    createProvider.ts       # factory: arg>env>key-prefix; mock fallback
    mock/MockProvider.ts    # re-introduced minimal mock (scripted/echo) for fallback + tests
  criticBackend.ts          # generateText(system,user) adapter over an LlmProvider
backend/src/keys/
  crypto.ts                 # AES-256-GCM encrypt/decrypt (scoped AAD)
  KeyStore.ts               # interface + JsonFileKeyStore
backend/src/api/
  server.ts                 # minimal Fastify app
  providers.routes.ts       # GET /api/providers, PUT/DELETE /api/providers/:provider/key
backend/.env.example        # AI var names only
backend/test/unit/...       # adapters, http, crypto, resolve, createProvider
backend/test/integration/providers.routes.test.ts
backend/test/integration/live-provider.smoke.ts   # guarded; skips with no real key
```

---

## Task 1: Re-introduce the `LlmProvider` seam

**Files:** Create `backend/src/agent/LlmProvider.ts`; Test `backend/test/unit/llm-provider.contract.test.ts`.

- [ ] **Step 1: Write the seam**
```ts
export interface ToolSpec { name: string; description: string; schema: unknown }
export interface ToolCall { name: string; args: unknown; id?: string }
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolCallId?: string        // on role:'tool' — correlates to the assistant tool call
  toolCalls?: ToolCall[]      // on role:'assistant' — carries that turn's tool calls
}
export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  model?: string
  maxTokens?: number
  temperature?: number
}
export interface ChatResult {
  text?: string
  toolCalls?: ToolCall[]
  usage?: { inTokens: number; outTokens: number }
  stopReason?: string
}
export interface LlmProvider {
  readonly name: string
  readonly model: string
  chat(req: ChatRequest): Promise<ChatResult>
}
```

- [ ] **Step 2: Contract test (shape only; a tiny inline fake)**
```ts
import { describe, it, expect } from 'vitest'
import type { LlmProvider } from '../../src/agent/LlmProvider.js'

describe('LlmProvider seam', () => {
  it('a minimal provider satisfies the interface and returns a ChatResult', async () => {
    const p: LlmProvider = {
      name: 'fake', model: 'm',
      async chat(req) { return { text: `sys:${req.system.length}`, usage: { inTokens: 1, outTokens: 1 } } },
    }
    const r = await p.chat({ system: 'hi', messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('sys:2')
  })
})
```
Run: `pnpm -C backend test llm-provider` → PASS. `tsc` clean.

- [ ] **Step 3: Commit** — `feat(agent): re-introduce LlmProvider seam (chat + tool-calling types)`

---

## Task 2: Model catalog + provider/model resolution

**Files:** Create `backend/src/agent/providers/catalog.ts`, `backend/src/agent/providers/resolve.ts`; Test `backend/test/unit/resolve.test.ts`.

- [ ] **Step 1: `catalog.ts`**
```ts
export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'google' | 'mock'

export interface ModelInfo { id: string; label: string; recommended?: boolean }
export interface ProviderInfo {
  id: ProviderId
  label: string
  baseUrl: string
  keyEnvVars: string[]      // env vars that supply this provider's key
  defaultModel: string       // the loop default
  models: ModelInfo[]
}

export const CATALOG: Record<Exclude<ProviderId, 'mock'>, ProviderInfo> = {
  anthropic: {
    id: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com',
    keyEnvVars: ['ANTHROPIC_API_KEY'], defaultModel: 'claude-haiku-4-5-20251001',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    ],
  },
  openai: {
    id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    keyEnvVars: ['OPENAI_API_KEY'], defaultModel: 'gpt-4.1-mini',
    models: [
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', recommended: true },
      { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
    ],
  },
  openrouter: {
    id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
    keyEnvVars: ['OPENROUTER_API_KEY'], defaultModel: 'anthropic/claude-haiku-4.5',
    models: [
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (OpenRouter)', recommended: true },
      { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini (OpenRouter)' },
    ],
  },
  google: {
    id: 'google', label: 'Google (Gemini)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', recommended: true },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
}
```

- [ ] **Step 2: failing test for `resolve.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { detectProviderFromKey, resolveModel } from '../../src/agent/providers/resolve.js'

describe('resolve', () => {
  it('detects provider from key prefix', () => {
    expect(detectProviderFromKey('sk-ant-abc')).toBe('anthropic')
    expect(detectProviderFromKey('AIzaSyXXX')).toBe('google')
    expect(detectProviderFromKey('sk-proj-xyz')).toBe('openai')
    expect(detectProviderFromKey('whatever')).toBeUndefined()
  })
  it('resolves the catalog default model when none given', () => {
    expect(resolveModel('anthropic', undefined)).toBe('claude-haiku-4-5-20251001')
    expect(resolveModel('anthropic', 'claude-opus-4-8')).toBe('claude-opus-4-8')
  })
})
```

- [ ] **Step 3: `resolve.ts`**
```ts
import { CATALOG, type ProviderId } from './catalog.js'

/** Prefix sniff. Note: sk-ant- MUST be checked before sk-. */
export function detectProviderFromKey(key: string): Exclude<ProviderId, 'mock'> | undefined {
  if (key.startsWith('sk-ant-')) return 'anthropic'
  if (key.startsWith('AIza')) return 'google'
  if (key.startsWith('sk-or-')) return 'openrouter'
  if (key.startsWith('sk-')) return 'openai'
  return undefined
}

export function resolveModel(provider: Exclude<ProviderId, 'mock'>, model: string | undefined): string {
  return model ?? CATALOG[provider].defaultModel
}
```
Run: `pnpm -C backend test resolve` → PASS.

- [ ] **Step 4: Commit** — `feat(providers): model catalog (single source) + provider/model resolution`

---

## Task 3: Shared HTTP helper (retry + typed errors + redaction)

**Files:** Create `backend/src/agent/providers/http.ts`; Test `backend/test/unit/http.test.ts`.

- [ ] **Step 1: failing test (inject a fake fetch)**
```ts
import { describe, it, expect } from 'vitest'
import { postJson, AuthError, ModelNotFoundError } from '../../src/agent/providers/http.js'

const res = (status: number, body: unknown, headers: Record<string,string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('postJson', () => {
  it('returns parsed json on 200', async () => {
    const fetchFn = async () => res(200, { ok: true })
    expect(await postJson('http://x', {}, {}, { fetchFn })).toEqual({ ok: true })
  })
  it('maps 401 to AuthError', async () => {
    const fetchFn = async () => res(401, { error: 'bad key' })
    await expect(postJson('http://x', {}, {}, { fetchFn })).rejects.toBeInstanceOf(AuthError)
  })
  it('maps 404 to ModelNotFoundError', async () => {
    const fetchFn = async () => res(404, { error: 'no model' })
    await expect(postJson('http://x', {}, {}, { fetchFn })).rejects.toBeInstanceOf(ModelNotFoundError)
  })
  it('retries on 429 then succeeds', async () => {
    let n = 0
    const fetchFn = async () => (++n < 2 ? res(429, {}, { 'retry-after': '0' }) : res(200, { ok: n }))
    expect(await postJson('http://x', {}, {}, { fetchFn, maxRetries: 3, baseDelayMs: 0 })).toEqual({ ok: 2 })
  })
})
```

- [ ] **Step 2: `http.ts`**
```ts
export class AuthError extends Error { constructor(m='auth failed'){ super(m); this.name='AuthError' } }
export class ModelNotFoundError extends Error { constructor(m='model not found'){ super(m); this.name='ModelNotFoundError' } }
export class ProviderHttpError extends Error { constructor(public status: number, m: string){ super(m); this.name='ProviderHttpError' } }

export interface PostOpts {
  fetchFn?: typeof fetch
  maxRetries?: number
  baseDelayMs?: number
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function postJson<T = unknown>(
  url: string, body: unknown, headers: Record<string, string>, opts: PostOpts = {},
): Promise<T> {
  const fetchFn = opts.fetchFn ?? fetch
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 250
  const timeoutMs = opts.timeoutMs ?? 60_000
  let attempt = 0
  for (;;) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    let r: Response
    try {
      r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal })
    } finally { clearTimeout(t) }
    if (r.ok) return (await r.json()) as T
    if (r.status === 401 || r.status === 403) throw new AuthError()
    if (r.status === 404) throw new ModelNotFoundError()
    if ((r.status === 429 || r.status >= 500) && attempt < maxRetries) {
      const ra = Number(r.headers.get('retry-after'))
      const delay = Number.isFinite(ra) ? ra * 1000 : baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs
      attempt++; await sleep(delay); continue
    }
    throw new ProviderHttpError(r.status, `provider HTTP ${r.status}`)
  }
}
```
> Redaction: this module never logs headers/body. Adapters must pass auth via `headers` and never console.log them.

Run: `pnpm -C backend test http` → PASS.

- [ ] **Step 3: Commit** — `feat(providers): shared fetch helper (retry/backoff + typed errors)`

---

## Task 4: MockProvider (re-introduced) for fallback + tests

**Files:** Create `backend/src/agent/providers/mock/MockProvider.ts`; Test `backend/test/unit/mock-provider.test.ts`.

- [ ] **Step 1: failing test**
```ts
import { describe, it, expect } from 'vitest'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'

describe('MockProvider', () => {
  it('echoes a deterministic ChatResult; reports name=mock', async () => {
    const p = new MockProvider()
    expect(p.name).toBe('mock')
    const r = await p.chat({ system: 's', messages: [{ role: 'user', content: 'hello' }] })
    expect(typeof r.text).toBe('string')
  })
  it('can be scripted to return a fixed reply (for critic JSON in tests)', async () => {
    const p = new MockProvider({ reply: '{"approved":true}' })
    const r = await p.chat({ system: 's', messages: [] })
    expect(r.text).toBe('{"approved":true}')
  })
})
```

- [ ] **Step 2: `MockProvider.ts`**
```ts
import type { LlmProvider, ChatRequest, ChatResult } from '../../LlmProvider.js'

export interface MockConfig { reply?: string }

export class MockProvider implements LlmProvider {
  readonly name = 'mock'
  readonly model = 'mock'
  constructor(private cfg: MockConfig = {}) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    const last = req.messages[req.messages.length - 1]?.content ?? ''
    return { text: this.cfg.reply ?? `mock: ${last.slice(0, 40)}`, usage: { inTokens: 0, outTokens: 0 } }
  }
}
```
Run: `pnpm -C backend test mock-provider` → PASS.

- [ ] **Step 3: Commit** — `feat(providers): re-introduce MockProvider (fallback + scriptable for tests)`

---

## Task 5: AnthropicProvider

**Files:** Create `backend/src/agent/providers/AnthropicProvider.ts`; Test `backend/test/unit/anthropic-provider.test.ts`.

Honor: `x-api-key` + `anthropic-version: 2023-06-01`; `system` top-level; `max_tokens` REQUIRED; tools use `input_schema`; tool calls come back as `tool_use` blocks; `input` is already an object.

- [ ] **Step 1: failing test (inject fake fetch returning a captured Anthropic shape)**
```ts
import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../src/agent/providers/AnthropicProvider.js'

const okBody = {
  content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'toolu_1', name: 'do', input: { x: 1 } }],
  stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 7 },
}

describe('AnthropicProvider', () => {
  it('maps request headers + body and parses text + tool_use', async () => {
    let captured: any
    const fetchFn = async (_url: string, init: any) => { captured = { url: _url, init }; return new Response(JSON.stringify(okBody), { status: 200, headers: { 'content-type': 'application/json' } }) }
    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5-20251001', fetchFn })
    const r = await p.chat({ system: 'SYS', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'do', description: 'd', schema: { type: 'object' } }], maxTokens: 100 })
    // request mapping
    expect(captured.url).toContain('/v1/messages')
    expect(captured.init.headers['x-api-key']).toBe('sk-ant-x')
    expect(captured.init.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(captured.init.body)
    expect(body.system).toBe('SYS')
    expect(body.max_tokens).toBe(100)
    expect(body.tools[0].input_schema).toEqual({ type: 'object' })
    // response mapping
    expect(r.text).toBe('hi')
    expect(r.toolCalls).toEqual([{ id: 'toolu_1', name: 'do', args: { x: 1 } }])
    expect(r.usage).toEqual({ inTokens: 5, outTokens: 7 })
  })
})
```

- [ ] **Step 2: `AnthropicProvider.ts`** — implement: build headers `{ 'x-api-key', 'anthropic-version': '2023-06-01' }`; body `{ model, max_tokens: req.maxTokens ?? 4096, system: req.system, messages: mapMessages(req.messages), tools?: req.tools.map(t => ({ name, description, input_schema: t.schema })) }`; `mapMessages`: user→`{role:'user',content}`; assistant→`{role:'assistant',content}` (+ reconstruct `tool_use` blocks from `msg.toolCalls`); tool→`{role:'user',content:[{type:'tool_result',tool_use_id: msg.toolCallId, content: msg.content}]}` (first block, immediately after the assistant tool_use turn). Response: `text` = concat `type==='text'` blocks; `toolCalls` = `type==='tool_use'` blocks → `{id,name,args:input}`; `usage` from `input_tokens/output_tokens`; `stopReason`. Use `postJson` from Task 3. Constructor `{ apiKey, model, baseUrl?, maxTokens?, fetchFn? }`.
Run → PASS.

- [ ] **Step 3: Commit** — `feat(providers): AnthropicProvider (messages API, tools, max_tokens)`

---

## Task 6: OpenAiCompatibleProvider (OpenAI + OpenRouter)

**Files:** Create `backend/src/agent/providers/OpenAiCompatibleProvider.ts`; Test `backend/test/unit/openai-provider.test.ts`.

Honor: `Authorization: Bearer`; `system` as a prepended message; tools `{type:'function',function:{name,description,parameters:schema}}`; response `message.tool_calls[].function.arguments` is a **string** → `JSON.parse` defensively; `tool` messages need `tool_call_id`. One class, `name` and `baseUrl` configurable (openai vs openrouter); OpenRouter optional `HTTP-Referer`/`X-Title` headers.

- [ ] **Step 1: failing test** — fake fetch returns `{ choices:[{ message:{ content:'hi', tool_calls:[{ id:'call_1', function:{ name:'do', arguments:'{"x":1}' } }] } }], usage:{ prompt_tokens:3, completion_tokens:4 } }`; assert `Authorization: Bearer sk-...`, body `messages[0].role==='system'`, `tools[0].function.parameters`, parsed `toolCalls=[{id:'call_1',name:'do',args:{x:1}}]`, usage mapping, and that bad JSON arguments fall back to `{}`.

- [ ] **Step 2: implement** with `postJson`; constructor `{ name:'openai'|'openrouter', apiKey, model, baseUrl, extraHeaders?, fetchFn? }`; `arguments` parse helper `safeJson(s) { try { return JSON.parse(s) } catch { return {} } }`.
Run → PASS.

- [ ] **Step 3: Commit** — `feat(providers): OpenAI-compatible adapter (OpenAI + OpenRouter)`

---

## Task 7: GeminiProvider

**Files:** Create `backend/src/agent/providers/GeminiProvider.ts`; Test `backend/test/unit/gemini-provider.test.ts`.

Honor: `x-goog-api-key`; model in URL path `/models/{model}:generateContent`; `systemInstruction:{parts:[{text}]}`; roles strictly `user`/`model`; tools `{functionDeclarations:[{name,description,parameters:schema}]}`; tool calls = `functionCall` parts (`args` already object); tool results = `{role:'user',parts:[{functionResponse:{name,response:<object>}}]}`; auth failure may be `400 PERMISSION_DENIED`.

- [ ] **Step 1: failing test** — fake fetch returns `{ candidates:[{ content:{ parts:[{ text:'hi' },{ functionCall:{ name:'do', args:{ x:1 } } }] } }], usageMetadata:{ promptTokenCount:2, candidatesTokenCount:3 } }`; assert URL has `:generateContent`, header `x-goog-api-key`, `systemInstruction`, parsed `toolCalls=[{name:'do',args:{x:1}}]`, usage mapping.

- [ ] **Step 2: implement** with `postJson`; constructor `{ apiKey, model, baseUrl?, fetchFn? }`; map a `400` whose body mentions `PERMISSION_DENIED` to `AuthError` (wrap `postJson` or check before).
Run → PASS.

- [ ] **Step 3: Commit** — `feat(providers): GeminiProvider (generateContent, functionDeclarations)`

---

## Task 8: `createProvider` factory (with mock fallback)

**Files:** Create `backend/src/agent/providers/createProvider.ts`; Test `backend/test/unit/create-provider.test.ts`.

- [ ] **Step 1: failing test**
```ts
import { describe, it, expect } from 'vitest'
import { createProvider } from '../../src/agent/providers/createProvider.js'

describe('createProvider', () => {
  it('falls back to mock when no key is configured', () => {
    const p = createProvider({ env: {} })
    expect(p.name).toBe('mock')
  })
  it('falls back to mock when NODE_ENV=test even if a key is present', () => {
    const p = createProvider({ env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-ant-x' } })
    expect(p.name).toBe('mock')
  })
  it('builds anthropic when forced and a key is present (non-test)', () => {
    const p = createProvider({ provider: 'anthropic', env: { ANTHROPIC_API_KEY: 'sk-ant-x', NODE_ENV: 'production' } })
    expect(p.name).toBe('anthropic')
    expect(p.model).toBe('claude-haiku-4-5-20251001')
  })
  it('auto-detects provider from a present key (non-test)', () => {
    const p = createProvider({ env: { OPENAI_API_KEY: 'sk-proj-x', NODE_ENV: 'production' } })
    expect(p.name).toBe('openai')
  })
})
```

- [ ] **Step 2: `createProvider.ts`** — signature `createProvider(opts?: { provider?: ProviderId; model?: string; apiKey?: string; env?: Record<string,string|undefined> }): LlmProvider`. Logic: `env = opts.env ?? process.env`; if `env.NODE_ENV==='test'` → `new MockProvider()`; determine provider = `opts.provider ?? env.AI_PROVIDER ?? detectProviderFromKey(firstPresentKey)`; find the key (opts.apiKey ?? first present `keyEnvVars` for the provider); if no provider or no key → `new MockProvider()`; else construct the matching adapter with `resolveModel(provider, opts.model ?? env.AI_MODEL)` and `baseUrl` from catalog (+ env override). Never log the key.
Run → PASS.

- [ ] **Step 3: Commit** — `feat(providers): createProvider factory (arg>env>key-prefix; mock fallback)`

---

## Task 9: Critic backend adapter (wire the seam into the real path)

**Files:** Create `backend/src/agent/criticBackend.ts`; Modify `backend/src/di/services.ts`; Test `backend/test/unit/critic-backend.test.ts`.

- [ ] **Step 1: failing test**
```ts
import { describe, it, expect } from 'vitest'
import { makeGenerateText } from '../../src/agent/criticBackend.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'

describe('criticBackend', () => {
  it('adapts generateText(system,user) over provider.chat and returns text', async () => {
    const gen = makeGenerateText(new MockProvider({ reply: '{"approved":true,"overallScore":90}' }))
    const out = await gen('SYS', 'USER')
    expect(out).toContain('approved')
  })
})
```

- [ ] **Step 2: `criticBackend.ts`**
```ts
import type { LlmProvider } from './LlmProvider.js'

/** Adapts the critic's generateText(system,user) seam onto an LlmProvider. */
export function makeGenerateText(provider: LlmProvider) {
  return async (system: string, user: string): Promise<string> => {
    const r = await provider.chat({ system, messages: [{ role: 'user', content: user }] })
    return r.text ?? ''
  }
}
```

- [ ] **Step 3: Wire into `buildServices`** — add `provider?: LlmProvider` to `BuildServicesOptions` (default `createProvider()`), and when `mockCriticScore` is NOT set, build the critic with `makeGenerateText(provider)` instead of the inline mock JSON closure. KEEP the `mockCriticScore` deterministic closure as the default path so all existing tests stay green (they pass `mockCriticScore`). Document: real critic is used only when a provider is wired and no mock score is given.
Run full suite → all green (existing tests still pass via `mockCriticScore`).

- [ ] **Step 4: Commit** — `feat(agent): critic backend adapter over LlmProvider; wire into buildServices (mock-preserving)`

---

## Task 10: Crypto + KeyStore (encrypted at rest)

**Files:** Create `backend/src/keys/crypto.ts`, `backend/src/keys/KeyStore.ts`; Test `backend/test/unit/crypto.test.ts`, `backend/test/unit/keystore.test.ts`.

- [ ] **Step 1: crypto failing test**
```ts
import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret } from '../../src/keys/crypto.js'

const MASTER = '0'.repeat(64) // 32 bytes hex

describe('crypto', () => {
  it('round-trips a secret bound to a provider AAD', () => {
    const enc = encryptSecret('sk-ant-secret', 'anthropic', MASTER)
    expect(enc.cipherText).not.toContain('secret')
    expect(decryptSecret(enc, 'anthropic', MASTER)).toBe('sk-ant-secret')
  })
  it('rejects decryption under a different provider AAD', () => {
    const enc = encryptSecret('sk-ant-secret', 'anthropic', MASTER)
    expect(() => decryptSecret(enc, 'openai', MASTER)).toThrow()
  })
})
```

- [ ] **Step 2: `crypto.ts`** — `node:crypto` `createCipheriv('aes-256-gcm', key, iv)`; random 12-byte IV; `setAAD(Buffer.from('akis:ai-key:'+provider))`; return `{ cipherText, iv, authTag, keyVersion: 'v1' }` (base64). `decryptSecret` reverses with `setAuthTag`; wrong AAD/tag throws. Master key parsed from hex (64 chars) or base64.

- [ ] **Step 3: KeyStore failing test** — `JsonFileKeyStore` to a temp path: `set('anthropic','sk-ant-x')` then `get('anthropic')==='sk-ant-x'`; `status('anthropic')` returns `{ provider, configured:true, last4:'nt-x'?, updatedAt }` and NEVER the key; `list()` shows configured providers; `remove` works; survives reload (new instance, same file).

- [ ] **Step 4: `KeyStore.ts`** — interface `{ set, get, remove, status, list }`; `JsonFileKeyStore` stores `{provider:{cipherText,iv,authTag,keyVersion,last4,updatedAt}}` JSON; encrypts on `set`, decrypts on `get`; `status`/`list` expose only non-secret fields. Master key + path injected.
Run both → PASS.

- [ ] **Step 5: Commit** — `feat(keys): AES-256-GCM crypto + JsonFileKeyStore (last4-only status)`

---

## Task 11: Minimal Fastify server + provider endpoints

**Files:** Create `backend/src/api/server.ts`, `backend/src/api/providers.routes.ts`; Test `backend/test/integration/providers.routes.test.ts`.

- [ ] **Step 1: failing integration test (Fastify `inject`, in-memory/temp KeyStore)**
```ts
import { describe, it, expect } from 'vitest'
import { buildServer } from '../../src/api/server.js'

describe('provider endpoints', () => {
  it('GET /api/providers lists catalog + availability; PUT stores a key (last4 only); DELETE removes', async () => {
    const app = buildServer({ /* inject a temp KeyStore + master key */ } as any)
    const list = await app.inject({ method: 'GET', url: '/api/providers' })
    expect(list.statusCode).toBe(200)
    const body = list.json()
    expect(Array.isArray(body)).toBe(true)
    const put = await app.inject({ method: 'PUT', url: '/api/providers/anthropic/key', payload: { apiKey: 'sk-ant-12345' } })
    expect(put.statusCode).toBe(200)
    expect(put.json().last4).toBe('2345')
    expect(JSON.stringify(put.json())).not.toContain('sk-ant-12345') // never echoes the key
    const after = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(after.find((p: any) => p.id === 'anthropic').available).toBe(true)
    const del = await app.inject({ method: 'DELETE', url: '/api/providers/anthropic/key' })
    expect(del.statusCode).toBe(200)
  })
})
```

- [ ] **Step 2: implement** `buildServer(deps)` returning a Fastify instance with the 3 routes; `GET` composes catalog + `available = envKeyPresent(provider) || keyStore.status(provider).configured` + `models`; `PUT` validates a non-empty string, `keyStore.set`, returns `{ last4 }`; `DELETE` `keyStore.remove`. No request-body logging. `server.ts` exports `buildServer` + a `start()` for real runs.
Run → PASS.

- [ ] **Step 3: Commit** — `feat(api): minimal Fastify server + GET/PUT/DELETE provider key endpoints`

---

## Task 12: `.env.example`, threat-model update, guarded live smoke, DoD

**Files:** Create `backend/.env.example`; Modify `THREAT-MODEL.md`; Create `backend/test/integration/live-provider.smoke.ts`.

- [ ] **Step 1: `.env.example` (names only, no values)**
```
# AI provider selection (optional; auto-detected from a present key if unset)
AI_PROVIDER=          # anthropic | openai | openrouter | google | mock
AI_MODEL=             # optional single model for the loop; else catalog default
# Provider keys (set the one(s) you use)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GEMINI_API_KEY=       # or GOOGLE_API_KEY
# Encrypted key store (needed only for the Settings/KeyStore path)
AI_KEY_ENCRYPTION_KEY=        # 32-byte master key (hex or base64)
AI_KEY_ENCRYPTION_KEY_VERSION=v1
# Optional base URL overrides
ANTHROPIC_BASE_URL=
OPENAI_BASE_URL=
OPENROUTER_BASE_URL=
GEMINI_BASE_URL=
```

- [ ] **Step 2: THREAT-MODEL.md** — add a "Provider keys" section: keys encrypted at rest (AES-256-GCM, scoped AAD), never logged/echoed/emitted on the bus, `GET` returns last4 only; plaintext transient (encrypt on PUT, decrypt right before constructing a client); missing master key → clear settings error.

- [ ] **Step 3: guarded live smoke**
```ts
import { describe, it, expect } from 'vitest'
import { createProvider } from '../../src/agent/providers/createProvider.js'

const has = (k: string) => !!process.env[k] && process.env.NODE_ENV !== 'test'
describe.skipIf(!has('ANTHROPIC_API_KEY'))('live anthropic', () => {
  it('does a real one-shot chat', async () => {
    const p = createProvider({ provider: 'anthropic', env: process.env as any })
    const r = await p.chat({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 })
    expect((r.text ?? '').length).toBeGreaterThan(0)
  }, 30_000)
})
```
(One such guarded block per provider; all skip with no key, so CI/no-key stays green.)

- [ ] **Step 4: DoD verification** — `pnpm -C backend test` (tsc + vitest) all green; the #1 gate contract test passes UNCHANGED; mock smoke (`pnpm -C backend smoke`) still correct; `createProvider()` with no env returns mock.

- [ ] **Step 5: Commit** — `feat: .env.example + threat-model key posture + guarded live smoke; providers DoD green`

---

## Self-review notes (carried into execution)
- **Seam was deleted in #1** — Task 1 RE-creates `LlmProvider`; do not assume it exists.
- **Mock fallback is load-bearing** — every existing test runs with `NODE_ENV=test`/no key and must stay on the mock. `createProvider` test asserts this.
- **Gates untouched** — no provider/key file imports a gate minter; the #1 contract test passing unchanged is the proof.
- **Secrets never leak** — crypto/KeyStore/endpoints tested for last4-only + no echo; adapters pass auth via headers only.
- **Adapter arg-shapes** — OpenAI `arguments` string (parse), Anthropic/Gemini args objects (don't); Anthropic `max_tokens` required + tool_result ordering; Gemini 400 PERMISSION_DENIED → AuthError.

