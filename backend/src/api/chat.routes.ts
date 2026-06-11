import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SessionState, ChatTurn } from '@akis/shared'
import { isVerified } from '@akis/shared'
import type { LlmProvider } from '../agent/LlmProvider.js'
import { sseControl } from './sse.js'
import { CATALOG, type ProviderId } from '../agent/providers/catalog.js'
import { createProvider, ProviderConfigError, type KeyLookup } from '../agent/providers/createProvider.js'
import type { UsageStorePort } from '../usage/UsageStore.js'
import { checkQuota, ANON_OWNER, type QuotaPolicy } from '../usage/quota.js'
import { extractSpecRequest, stripSpecRequest } from './specRequest.js'

/**
 * AKIS's conversational persona — the orchestrator talking to the user directly.
 *
 * Chat → Scribe HANDOFF contract (Option A, owner decision 2026-06-11): AKIS does NOT author
 * the build-ready spec — the REAL Scribe agent does. When the user is genuinely ready to build,
 * AKIS emits a COMPACT FOUR-backtick ````akis-spec-request fenced block carrying a one-line
 * brief / requirements summary (four so a brief can contain ordinary ```code examples without
 * closing early). The chat ROUTE detects that fence after the reply completes, hands the brief
 * (+ the conversation) to the real Scribe, and emits Scribe's spec as the standard `akis-spec`
 * block the FE renders as the one-click Build card. So AKIS must NEVER write the full spec itself
 * and NEVER ask the user to copy-paste anything. Exported so a contract test can assert the
 * instruction can't drift.
 */
export const AKIS_PERSONA = [
  'You are AKIS, the friendly orchestrator of the AKIS agentic build studio.',
  'You help people shape an app idea and explain how your agents build it: Scribe writes the spec,',
  'Proto writes the code, Trace verifies with REAL tests, and Critic reviews quality — behind structural gates.',
  'Be warm, concise, and encouraging. Reply in the user\'s language.',
  'Keep chatting normally — answer questions, clarify scope — and use markdown when it helps.',
  'Scribe — a separate, dedicated agent — is the ONE who writes the build-ready spec; YOU never write the full spec yourself.',
  'WHEN (and only when) the user is genuinely ready to build, write a brief sentence handing off to Scribe (e.g. "Scribe spec\'i hazırlıyor…" / "Scribe is drafting the spec…"), then emit a COMPACT request inside a code block fenced with FOUR backticks whose info string is exactly `akis-spec-request`, like:',
  '````akis-spec-request',
  'A one-line brief of the app to build (the idea + the must-have features/screens the user agreed on).',
  '````',
  'Use four backticks for that fence so any ```code``` examples in the brief do not close it early. Put ONLY the brief inside the block — a short summary of what to build, NOT a full spec, NOT acceptance criteria; Scribe expands it into the real spec.',
  'That `akis-spec-request` block triggers Scribe to draft the real spec, which then appears as a one-click "Approve & Build" spec card — the user reviews it and approves it to run the pipeline behind the structural gates.',
  'There is NO separate "Build" button and no idea box: the user starts the build ONLY by approving the spec card Scribe produces, so describe it that way (e.g. "approve the spec to build it") — never tell them to "press Build". And NEVER tell the user to copy-paste a spec or retype it in a box; the akis-spec-request handoff IS the build action.',
  'Never write the full build spec yourself and never claim to have built or run anything in this chat — Scribe drafts the spec, and the Build flow runs it.',
  'When you have been given the CURRENT BUILD context below and the user asks to CHANGE the current app (e.g. "make the button red", "add a settings page"), do NOT claim you changed it — you cannot edit the app from this chat. Instead, emit an `akis-spec-request` block whose brief describes the EDITED app (the prior app PLUS the requested change), so Scribe drafts a fresh spec the user can approve to run an edit build. The edit happens only when they approve that card.',
  'When your reply asks the user a question or offers choices (e.g. tweaks, options, next steps), you MAY end the reply with a fenced block whose info string is exactly `akis-suggest`, containing 2–4 SHORT tappable quick-replies (one per line, ≤6 words each), like:',
  '```akis-suggest',
  '- Yes, build it',
  '- Change the color scheme',
  '```',
  'Each line becomes a chip the user taps to send that exact text — so phrase each as something the user would say. Put ONLY suggestions inside the block; keep your prose outside it. Omit the block entirely when there is no natural choice to offer.',
].join('\n')

const isStr = (v: unknown): v is string => typeof v === 'string'
const ROLES = new Set(['user', 'assistant'])
const MAX_HISTORY = 12

type ChatMsg = { role: 'user' | 'assistant'; content: string }

/**
 * Collapse consecutive same-role turns so the payload is STRICTLY ALTERNATING — the Anthropic
 * (default) + Gemini Messages APIs reject two consecutive `user` (or `assistant`) turns with a
 * 400. This happens whenever the client's history ends in an unanswered `user` turn (a failed
 * turn whose error row is excluded from history) and we then append the new `user` message, or
 * on a Retry that re-sends the same text. Identical adjacent content is de-duplicated (the
 * Retry case); distinct content is joined with a blank line (an unanswered turn + the new one).
 */
export function alternating(messages: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content = last.content === m.content ? last.content : `${last.content}\n\n${m.content}`
    else out.push({ ...m })
  }
  return out
}

/**
 * Token budget for an AKIS chat turn. Generous (8k) so a sizeable build-ready `akis-spec`
 * block is emitted in full — a truncated reply would cut the spec mid-fence, leaving the UI
 * unable to detect/promote it to a Build card. (The agents have their own budgets; this is
 * only the conversational persona.)
 */
export const CHAT_MAX_TOKENS = 8192

/**
 * Effort → maxTokens for a CHAT turn (the "effort level" picker). The three named tiers
 * map to a token budget; `balanced` is the default and equals CHAT_MAX_TOKENS so an
 * absent/invalid effort keeps the EXACT byte-identical budget chat uses today (no drift).
 *
 * FAIL-OPEN (not fail-closed): an unknown/misspelled effort silently degrades to
 * `balanced` rather than 400ing — an invalid effort is harmless (it only sizes the
 * reply), so the conversation must never break over a typo. (Contrast provider/model,
 * which 400 because a wrong provider would talk to the wrong API or leak the wrong key.)
 */
export const EFFORT_TOKENS = { fast: 2048, balanced: 8192, deep: 16384 } as const
export type Effort = keyof typeof EFFORT_TOKENS

export function mapEffortToTokens(effort: string | undefined): number {
  switch (effort?.toLowerCase()) {
    case 'fast': return EFFORT_TOKENS.fast
    case 'deep': return EFFORT_TOKENS.deep
    default: return EFFORT_TOKENS.balanced // 'balanced' OR absent/invalid → the chat default
  }
}

/**
 * The chat route can resolve a DIFFERENT provider/model PER REQUEST (the model picker),
 * so it needs the same env + KeyStore createProvider consults. Absent both, every request
 * uses `deps.provider` unchanged (byte-identical to before the picker existed).
 *
 * SACRED: these per-request overrides are CHAT-ONLY. They never touch builds — the build
 * flow (startSession/workflows) keeps its workflow bindings and never sees {provider,model,
 * effort}. The route resolves a throwaway provider for the single chat turn and discards it.
 */
export interface ChatDeps {
  provider: LlmProvider
  env?: Record<string, string | undefined>
  keyStore?: KeyLookup
  /** Per-user token-quota PRE-CHECK + accounting (multi-tenant safety). When usage + quota are
   *  injected, each chat turn is gated (429 BEFORE the provider call) and its REAL token spend is
   *  accumulated AFTER a successful turn — the SOLE chat-accounting path (chat never emits
   *  agent_end, so no overlap with the bus tap). `ownerOf` resolves the authenticated user
   *  (undefined ⇒ anonymous → the shared __anon__ bucket). Absent ⇒ no check (byte-identical). */
  usage?: UsageStorePort
  quota?: QuotaPolicy
  /** TIER-AWARE quota (paid tier): resolves the per-owner policy (free vs pro budget). When given it
   *  takes precedence over the fixed `quota`; absent ⇒ the fixed `quota` (byte-unchanged). */
  quotaFor?: (ownerId: string | undefined) => Promise<QuotaPolicy>
  ownerOf?: (req: FastifyRequest) => Promise<string | undefined>
  /** BUILD-AWARE CHAT (read-only, owner-scoped). Resolves a session the CALLER may access — the
   *  SAME accessibleSession semantics as the gated routes (an owned session is returned only to
   *  its owner; a foreign/unknown id resolves to undefined → the route silently falls back to a
   *  stateless turn). STRICTLY CONVERSATIONAL: this is a read-only `store.get` + ownership compare,
   *  it holds NO orchestrator handle and can never approve/run/verify/push/mint/write — it only
   *  lets the persona SEE the current build (a contents-free snapshot) so it can route an edit
   *  request to a fresh akis-spec card. Absent ⇒ no build-awareness (byte-identical to today). */
  sessionRead?: (req: FastifyRequest, id: string) => Promise<SessionState | undefined>
  /** PERSISTED CONVERSATION (the F5 fix): append the turn's {user, assistant} pair to the
   *  session's ADDITIVE, NON-GATE `chat` field AFTER a successful reply, so the thread survives a
   *  refresh/another device. The implementation is owner-scoped EXACTLY like `sessionRead` (a
   *  foreign/unknown id is a silent no-op) and writes through the generic patch — which
   *  structurally excludes every gate column — so the chat route STAYS strictly conversational:
   *  it can record text but never approve/run/verify/push/mint. Failures are swallowed at the
   *  call site (persistence must never break a successful turn). Absent ⇒ byte-identical. */
  chatAppend?: (req: FastifyRequest, sessionId: string, turns: ChatTurn[]) => Promise<void>
  /** REAL SCRIBE HANDOFF (Option A): when the persona emits an `akis-spec-request` fence, the
   *  route calls the REAL Scribe to author the build-ready spec — using its skill-injected system
   *  prompt + the configured scribe provider/model (the SAME `services.scribe` the default
   *  orchestrator's pipeline uses, so the chat-time draft matches the build-time resolution). It is
   *  DATA-ONLY (provider.chat + parse, bus-free) — it mints/approves/verifies/pushes NOTHING; the
   *  human SpecCard click remains the sole approve path. Returns the parsed spec + whether it
   *  parsed + Scribe's REAL usage. Throws on a provider error (the route surfaces an honest chat
   *  error row, never a persona-authored spec). Absent ⇒ the request fence is simply not expanded
   *  (the reply renders as prose) — graceful degradation. */
  draftSpec?: (input: { brief: string; conversation?: { role: 'user' | 'assistant'; content: string }[] }) =>
    Promise<{ spec: { title: string; body: string }; parsed: boolean; usage?: { inTokens: number; outTokens: number } }>
}

/**
 * Hard char cap on the build-context block as a whole — a single bounded extra SYSTEM block, never
 * history. Spec body is truncated near 600 chars; the file list is paths only (never contents); the
 * total is clamped so a huge spec/file list can never blow the token budget.
 */
export const BUILD_CONTEXT_MAX_CHARS = 2400
const SPEC_BODY_MAX_CHARS = 600
const MAX_CONTEXT_FILES = 40

/** Truncate to `max` chars on a soft boundary, appending an ellipsis marker when cut. Reserve one
 *  char for the ellipsis so the result is ALWAYS <= max (the ellipsis is 1 UTF-16 unit), keeping
 *  the BUILD_CONTEXT_MAX_CHARS clamp an exact upper bound rather than max+1. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}

/**
 * PURE: build the read-only, owner-scoped, CONTENTS-FREE snapshot of the current build, appended
 * after AKIS_PERSONA as one extra SYSTEM block so the persona can answer questions about — and
 * route edits to — the app the user just built. It leaks NOTHING sensitive:
 *   - spec title + spec body TRUNCATED near 600 chars (never the whole spec),
 *   - the file PATH LIST only — never file CONTENTS,
 *   - the verify OUTCOME (verified / not-yet / simulated), never code/secrets.
 * The whole block is clamped to BUILD_CONTEXT_MAX_CHARS. It mints/writes nothing — it is a string.
 */
export function buildSessionContext(s: SessionState): string {
  const lines: string[] = []
  lines.push('--- CURRENT BUILD (read-only context, do not claim you can edit it directly) ---')
  lines.push(`Idea: ${truncate(s.idea, 200)}`)
  if (s.spec?.title) lines.push(`Spec title: ${truncate(s.spec.title, 200)}`)
  if (s.spec?.body) lines.push(`Spec:\n${truncate(s.spec.body, SPEC_BODY_MAX_CHARS)}`)
  const files = s.code?.files ?? []
  if (files.length) {
    const shown = files.slice(0, MAX_CONTEXT_FILES).map(f => `- ${f.filePath}`)
    const extra = files.length > MAX_CONTEXT_FILES ? `\n- …and ${files.length - MAX_CONTEXT_FILES} more` : ''
    lines.push(`Files (paths only, contents withheld):\n${shown.join('\n')}${extra}`)
  }
  // Verify OUTCOME only (never the token/digest/code): verified, simulated, failed, or not-yet.
  // The branded verifyToken is the gate truth (isVerified); testEvidence is the display mirror that
  // survives in the snapshot and carries the honest `demo` (simulated-run) marker.
  const demo = s.testEvidence?.demo === true
  const testsRun = s.testEvidence?.testsRun
  const testsSuffix = testsRun !== undefined ? ` (${testsRun} tests)` : ''
  const verifyLine = isVerified(s)
    ? `Verification: ${demo ? 'SIMULATED (demo) pass — NOT real verification' : 'verified by real tests'}${testsSuffix}`
    : demo && s.testEvidence?.passed === true
      ? `Verification: SIMULATED (demo) pass — NOT real verification${testsSuffix}`
      : s.testEvidence?.passed === true
        ? `Verification: tests passed${testsSuffix}`
        : s.status === 'verify_failed' || s.testEvidence?.passed === false
          ? 'Verification: tests did NOT pass yet'
          : 'Verification: not yet verified'
  lines.push(verifyLine)
  lines.push('If the user asks to CHANGE this app, emit a fresh full akis-spec block for the edited app (never claim you changed it).')
  return truncate(lines.join('\n'), BUILD_CONTEXT_MAX_CHARS)
}

/** A typed 4xx the route catches and maps to a clean reply.code(status).send({error,code}). */
class ChatRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ChatRequestError'
  }
}

function isRealProviderId(p: string): p is Exclude<ProviderId, 'mock'> {
  return Object.prototype.hasOwnProperty.call(CATALOG, p)
}

/**
 * Resolve the provider for ONE chat turn from the optional {provider, model} overrides.
 *
 * - Both absent → return `defaultProvider` UNCHANGED (byte-identical; no createProvider call).
 * - `provider` given → validate it is a known CATALOG provider (unknown → 400 BadRequest),
 *   and if `model` is given, validate it belongs to that provider (unknown → 400 BadRequest).
 *   Then build a throwaway provider via createProvider. A missing key surfaces as 400 NoKey
 *   (never 500, never echoes the key); any other ProviderConfigError → 400 BadRequest.
 * - `model` without `provider` → 400 BadRequest (a model alone is ambiguous).
 *
 * Validation is done HERE (against the pure CATALOG, env-independent) BEFORE createProvider,
 * so a bad provider/model is a deterministic 400 even under the test mock — and createProvider
 * is only reached for a genuinely-named override.
 */
export function resolvePerRequestProvider(
  defaultProvider: LlmProvider,
  provider: string | undefined,
  model: string | undefined,
  env?: Record<string, string | undefined>,
  keyStore?: KeyLookup,
): LlmProvider {
  if (!provider && !model) return defaultProvider
  if (!provider) throw new ChatRequestError(400, 'BadRequest', 'model requires a provider')
  if (!isRealProviderId(provider)) throw new ChatRequestError(400, 'BadRequest', `Unknown provider '${provider}'`)
  if (model && !CATALOG[provider].models.some(m => m.id === model)) {
    throw new ChatRequestError(400, 'BadRequest', `Unknown model '${model}' for provider '${provider}'`)
  }
  try {
    // A genuinely-named provider/model: build a throwaway provider for THIS turn only.
    // createProvider is fail-closed — missing key throws ProviderConfigError (never a mock
    // in production), which we translate to a clean 400 NoKey below (never a 500, never the key).
    return createProvider({ provider, ...(model ? { model } : {}), ...(env ? { env } : {}), ...(keyStore ? { keyStore } : {}) })
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      // "No API key" → NoKey; everything else (misconfig) → BadRequest. The message NEVER
      // contains the key (createProvider never logs/embeds it), so it is safe to echo.
      const noKey = /no api key|no key|key found|key configured/i.test(err.message)
      throw new ChatRequestError(400, noKey ? 'NoKey' : 'BadRequest', noKey ? `No API key for provider ${provider}` : err.message)
    }
    throw err
  }
}

/**
 * Sanitize + assemble the provider messages for an AKIS chat turn. SHARED by the
 * stream + non-stream routes so both apply the SAME guards: drop malformed entries,
 * keep only user/assistant roles (no injected `system`), cap to the last MAX_HISTORY
 * turns, append the new user message, then `alternating()` to keep the payload
 * STRICTLY alternating (Anthropic/Gemini 400 on two consecutive same-role turns).
 */
function assembleMessages(message: string, rawHistoryInput: unknown): ChatMsg[] {
  const rawHistory = Array.isArray(rawHistoryInput) ? rawHistoryInput : []
  const history = rawHistory
    .filter((m): m is { role: string; content: string } => !!m && typeof m === 'object' && isStr((m as { role?: unknown }).role) && isStr((m as { content?: unknown }).content))
    .filter(m => ROLES.has(m.role))
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  return alternating([...history, { role: 'user', content: message }])
}

/** Hard cap on a single brief char length handed to Scribe — a prompt-injected request fence can't
 *  smuggle an unbounded blob through the handoff. The conversation is already MAX_HISTORY-bounded. */
const SCRIBE_BRIEF_MAX_CHARS = 4000

/** Render Scribe's authored spec as the standard build `akis-spec` block the FE promotes to a
 *  SpecCard. FOUR backticks (the FE contract) so the spec body's own ```code``` blocks never close
 *  the fence early. The `intro` (the persona's brief handoff prose, request fence already stripped)
 *  renders above the card under the SAME Scribe identity the FE already keys on extractBuildSpec for. */
function renderSpecBlock(intro: string, spec: { title: string; body: string }): string {
  const block = ['````akis-spec', spec.body.trim(), '````'].join('\n')
  return intro ? `${intro}\n\n${block}` : block
}

/**
 * The HANDOFF expansion (Option A): given the persona's assembled reply + the turn's conversation,
 * if the persona emitted an `akis-spec-request` fence, invoke the REAL Scribe (draftSpec) and return
 * the final reply with Scribe's spec as the standard `akis-spec` block — plus Scribe's REAL usage so
 * the seeded start can report honest synthetic-Scribe metrics. The request fence is an INTERNAL
 * marker, stripped from the visible reply in every branch (it must never render raw).
 *
 * Branches:
 *  - no request fence → return the reply UNCHANGED (byte-identical ordinary turn), no Scribe call.
 *  - request fence but NO draftSpec dep → strip the fence and return the prose (graceful degrade).
 *  - request fence + draftSpec → call Scribe; on a parsed spec, return prose+akis-spec block + usage;
 *    on an UNPARSEABLE draft, throw ScribeError (honest error, NEVER a persona-authored spec).
 *  - draftSpec THROWS (provider error) → propagates as ScribeError (the route surfaces it honestly).
 *
 * SACRED: this mints/approves/verifies/pushes NOTHING — it produces a SpecCard the human still must
 * click to approve. A prompt-injected request fence at most causes another draftable card.
 */
async function expandSpecRequest(
  reply: string,
  conversation: { role: 'user' | 'assistant'; content: string }[],
  draftSpec: ChatDeps['draftSpec'],
): Promise<{ reply: string; scribeUsage?: { inTokens: number; outTokens: number } }> {
  const request = extractSpecRequest(reply)
  if (!request) return { reply } // ordinary turn — byte-identical, no Scribe call
  if (!draftSpec) return { reply: stripSpecRequest(reply) } // no Scribe wired → degrade to prose
  // Per-turn clamp (review LOW): MAX_HISTORY bounds the COUNT, this bounds each turn's SIZE — a
  // client sending 12 huge turns must not inflate Scribe's prompt (mirrors /sessions' TURN_MAX_CHARS).
  const bounded = conversation.map(t => ({ role: t.role, content: t.content.slice(0, SCRIBE_BRIEF_MAX_CHARS) }))
  let drafted: Awaited<ReturnType<NonNullable<ChatDeps['draftSpec']>>>
  try {
    drafted = await draftSpec({ brief: request.brief.slice(0, SCRIBE_BRIEF_MAX_CHARS), conversation: bounded })
  } catch (err) {
    // Provider error → honest error row; NEVER fall back to a persona-authored spec.
    throw new ChatRequestError(502, 'ScribeError', err instanceof Error ? err.message : 'Scribe failed to draft the spec')
  }
  // A non-parsed draft is a DEGRADED result (the model didn't return a real spec) — surface it as an
  // honest error rather than rendering the fallback `Spec for: …` text as if it were a real spec.
  if (!drafted.parsed) throw new ChatRequestError(502, 'ScribeError', 'Scribe could not draft a build-ready spec')
  return { reply: renderSpecBlock(request.intro, drafted.spec), ...(drafted.usage ? { scribeUsage: drafted.usage } : {}) }
}

/**
 * POST /api/chat — a free-form conversation WITH AKIS (distinct from the build flow).
 * Stateless: the client sends the recent history; AKIS replies in persona via the
 * same provider that powers the agents. Caps history to bound token use.
 *
 * POST /api/chat/stream is the SSE sibling — same persona/assembly/budget, but text
 * deltas are pushed as they arrive so the UI feels alive. Both routes coexist; the FE
 * uses the stream and falls back to /api/chat on any stream error / unsupported provider.
 */
export function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): void {
  // Per-turn quota PRE-CHECK shared by both routes. Returns the owner key to charge AFTER a
  // successful turn (so the caller accumulates the real spend), or a {blocked} signal carrying
  // the 429 resetAt. When usage/quota are not injected, it never blocks and never charges.
  const quotaGate = async (req: FastifyRequest): Promise<{ blocked: true; resetAt: string } | { blocked: false; ownerKey: string }> => {
    const ownerId = deps.ownerOf ? await deps.ownerOf(req) : undefined
    const policy = deps.quotaFor ? await deps.quotaFor(ownerId) : deps.quota
    if (deps.usage && policy) {
      const decision = await checkQuota(deps.usage, policy, ownerId)
      if (!decision.allowed) return { blocked: true, resetAt: decision.resetAt }
    }
    return { blocked: false, ownerKey: ownerId ?? ANON_OWNER }
  }
  // Accumulate a turn's REAL spend (the SOLE chat-accounting path; {0,0}/absent ⇒ no add). Fire-
  // and-forget: a store error is best-effort observability and must never break the reply.
  const chargeUsage = (ownerKey: string, usage: { inTokens: number; outTokens: number } | undefined): void => {
    if (!deps.usage || !usage) return
    const tok = usage.inTokens + usage.outTokens
    if (tok > 0) void Promise.resolve(deps.usage.add(ownerKey, tok)).catch(() => { /* best-effort */ })
  }

  // BUILD-AWARE system prompt for ONE turn. Absent a sessionId (or no sessionRead dep, or a
  // foreign/unknown id) the system is AKIS_PERSONA BYTE-IDENTICAL to today — the build-awareness
  // is purely ADDITIVE and owner-scoped. When the caller owns the session, append the read-only,
  // contents-free context block AFTER the persona. This is the ONLY new read: a string assembly
  // over a read-only store.get — it mints/writes/gates NOTHING (SACRED: strictly conversational).
  const resolveSystem = async (req: FastifyRequest, sessionId: string | undefined): Promise<string> => {
    if (!sessionId || !deps.sessionRead) return AKIS_PERSONA
    const s = await deps.sessionRead(req, sessionId)
    if (!s) return AKIS_PERSONA // foreign/unknown id → stateless fallback (never confirms it exists)
    return `${AKIS_PERSONA}\n\n${buildSessionContext(s)}`
  }

  /** The persisted {user, assistant} pair for one completed turn (see ChatDeps.chatAppend).
   *  One shared timestamp — the pair is atomic; ordering inside the array carries the sequence. */
  const turnPair = (userMsg: string, assistantReply: string): ChatTurn[] => {
    const at = new Date().toISOString()
    return [
      { role: 'user', content: userMsg, at },
      { role: 'assistant', content: assistantReply, at },
    ]
  }

  app.post<{ Body: { message?: unknown; history?: unknown; provider?: unknown; model?: unknown; effort?: unknown; sessionId?: unknown } }>('/api/chat', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const provider = isStr(req.body?.provider) ? req.body.provider.trim() || undefined : undefined
    const model = isStr(req.body?.model) ? req.body.model.trim() || undefined : undefined
    const effort = isStr(req.body?.effort) ? req.body.effort.trim() || undefined : undefined
    const sessionId = isStr(req.body?.sessionId) ? req.body.sessionId.trim() || undefined : undefined
    const messages = assembleMessages(message, req.body?.history)
    // Per-user token-quota PRE-CHECK — BEFORE resolving/calling any provider (SACRED: a blocked
    // turn never reaches the model). No-op when usage/quota aren't injected (byte-identical).
    const gate = await quotaGate(req)
    if (gate.blocked) return reply.code(429).send({ error: 'token quota exceeded', code: 'QuotaExceeded', resetAt: gate.resetAt })
    // Resolve the per-request provider FIRST so a bad provider/model/key is a clean 4xx (400
    // BadRequest / 400 NoKey) — never a 502. Absent overrides → deps.provider, byte-identical.
    let resolved: LlmProvider
    try {
      resolved = resolvePerRequestProvider(deps.provider, provider, model, deps.env, deps.keyStore)
    } catch (err) {
      if (err instanceof ChatRequestError) return reply.code(err.status).send({ error: err.message, code: err.code })
      throw err
    }
    // Build-aware system (owner-scoped, read-only); absent/foreign sessionId ⇒ AKIS_PERSONA byte-identical.
    const system = await resolveSystem(req, sessionId)
    try {
      const res = await resolved.chat({ system, messages, maxTokens: mapEffortToTokens(effort) })
      // Account the persona turn's REAL spend (the sole chat path; {0,0}/absent adds nothing).
      chargeUsage(gate.ownerKey, res.usage)
      const personaReply = (res.text ?? '').trim()
      // REAL Scribe HANDOFF (Option A): if the persona emitted an `akis-spec-request` fence, the REAL
      // Scribe drafts the spec and the reply carries the standard `akis-spec` block. A Scribe error
      // throws ChatRequestError(502, ScribeError) — surfaced as an honest error below, never a fake
      // spec. No fence ⇒ replyText === personaReply (byte-identical ordinary turn).
      const { reply: replyText, scribeUsage } = await expandSpecRequest(personaReply, messages, deps.draftSpec)
      // Account Scribe's REAL token spend too (the handoff's second model call is part of this turn).
      chargeUsage(gate.ownerKey, scribeUsage)
      // PERSISTED CONVERSATION (the F5 fix): record the pair on the bound session AFTER the
      // successful turn. Awaited so a refresh right after the reply still finds it persisted;
      // errors swallowed — persistence must never break a turn the user already paid for.
      if (sessionId && deps.chatAppend) await deps.chatAppend(req, sessionId, turnPair(message, replyText)).catch(() => {})
      // Return the reply verbatim (trimmed). An empty reply is surfaced HONESTLY as '' so the
      // UI can show a real "empty reply" notice — never disguised as a friendly '…' answer.
      return reply.send({ reply: replyText })
    } catch (err) {
      // ScribeError (502) is honest + localized on the FE; other provider errors stay ProviderError.
      if (err instanceof ChatRequestError) return reply.code(err.status).send({ error: err.message, code: err.code })
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'chat failed', code: 'ProviderError' })
    }
  })

  // POST /api/chat/stream — token-by-token SSE. Frames: `delta` ({text}) per chunk,
  // a terminal `done` ({reply}) carrying the full assembled reply (so the FE re-runs
  // spec detection on the authoritative text), or `error` ({message,code}) on failure.
  app.post<{ Body: { message?: unknown; history?: unknown; provider?: unknown; model?: unknown; effort?: unknown; sessionId?: unknown } }>('/api/chat/stream', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const provider = isStr(req.body?.provider) ? req.body.provider.trim() || undefined : undefined
    const model = isStr(req.body?.model) ? req.body.model.trim() || undefined : undefined
    const effort = isStr(req.body?.effort) ? req.body.effort.trim() || undefined : undefined
    const sessionId = isStr(req.body?.sessionId) ? req.body.sessionId.trim() || undefined : undefined
    const messages = assembleMessages(message, req.body?.history)
    // Per-user token-quota PRE-CHECK — BEFORE reply.hijack() (after hijack only SSE frames can be
    // written, so a 429 would be impossible). Mirrors the existing pre-hijack 4xx for a bad
    // provider/model below: a blocked turn returns a clean JSON 429 (the FE renders it directly,
    // no redundant non-stream fallback). No-op when usage/quota aren't injected (byte-identical).
    const gate = await quotaGate(req)
    if (gate.blocked) return reply.code(429).send({ error: 'token quota exceeded', code: 'QuotaExceeded', resetAt: gate.resetAt })
    // Resolve the per-request provider BEFORE hijacking the socket — a bad provider/model/key
    // must surface as a clean JSON 4xx (the FE then falls back to /api/chat); after reply.hijack()
    // only SSE frames can be written, so a 400 here would be impossible.
    let resolvedProvider: LlmProvider
    try {
      resolvedProvider = resolvePerRequestProvider(deps.provider, provider, model, deps.env, deps.keyStore)
    } catch (err) {
      if (err instanceof ChatRequestError) return reply.code(err.status).send({ error: err.message, code: err.code })
      throw err
    }
    // Build-aware system — resolved BEFORE hijack (the owner-scoped read can't run once we own the
    // socket). Absent/foreign sessionId ⇒ AKIS_PERSONA byte-identical; read-only, mints nothing.
    const system = await resolveSystem(req, sessionId)
    const chatReq = { system, messages, maxTokens: mapEffortToTokens(effort) }

    // Take over the socket and stream on reply.raw (mirrors the agent live stream).
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering so deltas flush immediately
    })
    let aborted = false
    raw.on('close', () => { aborted = true }) // client navigated away — stop pushing
    // An async socket error (EPIPE/ECONNRESET when the client drops mid-stream) with NO listener
    // becomes an UNCAUGHT exception that crashes the process — mirror the agent live stream's guard.
    raw.on('error', () => { aborted = true })
    const safeWrite = (chunk: string): void => { if (!aborted) { try { raw.write(chunk) } catch { aborted = true } } }

    try {
      let full = ''
      const onDelta = (delta: string): void => {
        if (aborted || !delta) return
        full += delta
        safeWrite(sseControl('delta', { text: delta }))
      }
      // Use the streaming seam when the provider supports it; otherwise fall back to
      // chat() and emit its whole reply as a single delta (graceful degradation).
      let res
      if (resolvedProvider.chatStream) {
        res = await resolvedProvider.chatStream(chatReq, onDelta)
      } else {
        res = await resolvedProvider.chat(chatReq)
        onDelta((res.text ?? ''))
      }
      // Account the persona turn's REAL spend (sole chat path; {0,0}/absent adds nothing). Even when
      // the client dropped (aborted) the tokens were still spent, so charge regardless.
      chargeUsage(gate.ownerKey, res.usage)
      // Prefer the assembled stream text; fall back to the result text (single-shot path).
      const personaReply = (full || res.text || '').trim()
      // REAL Scribe HANDOFF (Option A): the persona's reply may end with an `akis-spec-request` fence.
      // Detect it on the AUTHORITATIVE assembled text (the request fence already streamed by as deltas;
      // the `done` reply is what the FE finalizes to, so the transient marker is replaced). Invoke the
      // REAL Scribe; on success the done reply carries the standard `akis-spec` block + we charge
      // Scribe's real usage. A Scribe error throws ChatRequestError(502, ScribeError) → an honest SSE
      // error frame below (NEVER a persona-authored spec). No fence ⇒ finalReply === personaReply.
      const hasRequest = extractSpecRequest(personaReply) !== null
      // F1(b) — LIVE DRAFTING SIGNAL: when (and only when) a REAL Scribe call is about to start, emit
      // an ADDITIVE control frame so the FE can replace the generic "AKIS düşünüyor…" cue with an
      // honest "Scribe spec'i hazırlıyor…" status (and lift Scribe to 'çalışıyor' in the header
      // roster). It is data-only, never the final reply; old/other clients IGNORE the unknown `scribe`
      // event entirely (the FE parser only acts on delta/done/error — see api/client.ts handleFrame),
      // so it is backward-tolerant. Emitted before the interim `…` cue below.
      if (hasRequest && deps.draftSpec) safeWrite(sseControl('scribe', { scribe: 'drafting' }))
      // Optional interim cue so the brief Scribe latency isn't a frozen stream (data-only, not the
      // final reply). The FE animates it; the `done` reply REPLACES it, so it never lingers.
      if (hasRequest && deps.draftSpec) onDelta('\n\n…')
      const { reply: finalReply, scribeUsage } = await expandSpecRequest(personaReply, messages, deps.draftSpec)
      chargeUsage(gate.ownerKey, scribeUsage)
      safeWrite(sseControl('done', { reply: finalReply }))
      // PERSISTED CONVERSATION (the F5 fix): record the pair with the FINAL reply (the akis-spec block,
      // not the transient request fence) — so a reload rehydrates the SpecCard. After the `done` frame
      // so persistence never delays the UI; errors swallowed (best-effort, never breaks the turn).
      if (sessionId && deps.chatAppend) await deps.chatAppend(req, sessionId, turnPair(message, finalReply)).catch(() => {})
    } catch (err) {
      // ScribeError carries its own code so the FE localizes it honestly; other failures → ProviderError.
      const code = err instanceof ChatRequestError ? err.code : 'ProviderError'
      safeWrite(sseControl('error', { message: err instanceof Error ? err.message : 'chat failed', code }))
    } finally {
      if (!aborted) { try { raw.end() } catch { /* socket already gone */ } }
    }
  })
}
