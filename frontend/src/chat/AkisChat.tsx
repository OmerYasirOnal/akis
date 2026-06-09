import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo, type FormEvent, type ReactNode } from 'react'
import type { ApiClient, ProviderInfo, ChatOverrides, UsageInfo } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { getProvidersCached, getModeCached } from '../api/providersCache.js'
import { useI18n } from '../i18n/I18nContext.js'
import { Markdown } from '../components/Markdown.js'
import { CopyButton } from '../components/CopyButton.js'
import { extractBuildSpec, hasTruncatedSpec, extractSuggestions } from './buildSpec.js'
import { SpecCard } from './SpecCard.js'
import { UsageMeter } from './UsageMeter.js'
import { useSmoothText } from './useSmoothText.js'
import { ModelChip, type Effort } from './ModelChip.js'
import { ModelPicker, type ModelSelection } from './ModelPicker.js'
import { loadModelPref, saveModelPref, type ModelPref } from './modelPref.js'
import { loadThread, saveThread, historyForApi, isNearBottom, isMsg, isRun, type AkisMsg, type ThreadNode } from './akisThread.js'
import { RunBlock } from './RunBlock.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'
import type { SessionView } from '../live/types.js'

/**
 * A free-form conversation WITH AKIS, shown before a build starts. AKIS opens with a
 * greeting; the user can ask questions and AKIS replies in persona (POST /api/chat).
 *
 * Replies render as markdown (so **bold**, lists, `code`, --- look right). When a reply
 * carries an `akis-spec` block (the Chat-to-Build contract), the intro renders normally
 * and the spec is promoted to a <SpecCard> with a one-click Approve → `onBuild(spec)`,
 * which reuses the existing build path (no copy-paste).
 *
 * Streaming: the reply is streamed token-by-token (POST /api/chat/stream) into a live
 * assistant PLACEHOLDER that updates as deltas arrive, so the chat feels alive instead
 * of frozen behind one await. Spec detection (extractBuildSpec/hasTruncatedSpec) runs on
 * the ACCUMULATED text every render, so the Build card appears the instant the akis-spec
 * fence closes. If streaming fails (unsupported provider, a mid-stream drop, an SSE error
 * frame), it FALLS BACK to the proven non-stream await path — degrading gracefully.
 *
 * Resilience: a provider 502 / network failure / empty reply renders as a DISTINCT error
 * row (role="alert", rose styling) with a Retry button — never as a faked AK answer — and
 * error rows are EXCLUDED from the history replayed to /api/chat, so a failure can't poison
 * AKIS's context. A 401 clears the session + routes to login (handled in ApiClient). The
 * thread is persisted to localStorage so it survives a build starting (this unmounts) and a
 * page reload. A truncated spec (opening fence, no close) shows an honest "ask AKIS to
 * resend it" notice instead of rendering a half spec as prose with no Build card.
 */
/** The in-flight streaming placeholder carries a transient `streaming` flag — UI-only,
 *  never persisted to localStorage nor replayed as history (stripped before both). */
type ChatMsg = AkisMsg & { streaming?: boolean }
/** A node in the chronological SPINE the chat renders: a chat message (possibly the live
 *  streaming placeholder) OR a run marker that mounts a RunBlock IN PLACE at its slot. */
type ThreadEntry = ChatMsg | ThreadNode

/** True for the live streaming placeholder (only an assistant chat message ever carries it). */
function isStreaming(n: ThreadEntry): boolean {
  return isMsg(n) && (n as ChatMsg).streaming === true
}

/** Whether the user prefers reduced motion — read defensively (a throw / missing matchMedia must
 *  never break a scroll). FAIL CLOSED to `true` here (skip smooth-scroll) so a motion-sensitive
 *  user is never given an animated jump; an env without matchMedia (jsdom) also gets the instant
 *  jump, which keeps the tests deterministic. */
function prefersReducedMotion(): boolean {
  try {
    return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return true
  }
}

/** Drop the live streaming placeholder (used on finalize + on a stream failure). Run markers
 *  and completed messages are untouched. */
function dropPlaceholder(nodes: ThreadEntry[]): ThreadEntry[] {
  return nodes.filter(n => !isStreaming(n))
}

/** Strip the transient `streaming` flag for persistence/history — run markers pass through. */
function forStorage(nodes: readonly ThreadEntry[]): ThreadNode[] {
  return dropPlaceholder([...nodes]).map(n => (isRun(n) ? n : { role: (n as ChatMsg).role, content: (n as ChatMsg).content }))
}

/**
 * One assistant bubble. A component (not inline JSX in the map) so `useSmoothText` sits at a
 * stable hook position regardless of how the thread grows/shrinks. Every extraction runs on
 * the FULL accumulated `content` (spec/suggestion detection must see the authoritative text);
 * only the visible reply text is animated, and only while it's the actively streaming message.
 */
const AssistantMessage = memo(function AssistantMessage({ content, streaming, onBuild, building, isSpecStarted }: {
  content: string
  streaming: boolean
  // Explicit `| undefined` (not `?`) so the call site can forward AkisChat's own optional
  // props straight through under exactOptionalPropertyTypes (which distinguishes absent vs undefined).
  onBuild: ((spec: string) => void) | undefined
  building: boolean | undefined
  /** PER-SPEC started: true iff a run node in the spine ORIGINATED from THIS spec text. Anchoring
   *  on the run markers (not one global builtSpec) means an OLD spec card in the multi-run thread
   *  never mislabels — each card reflects whether ITS build was actually started. */
  isSpecStarted: (spec: string) => boolean
}): ReactNode {
  const { t } = useI18n()
  // A build-ready spec is detected only when onBuild is wired (the studio flow). Detection
  // runs on the ACCUMULATED text, so the SpecCard appears the instant the fence closes mid-stream.
  const detected = onBuild ? extractBuildSpec(content) : null
  // Suppress the "truncated" notice WHILE streaming — an open-but-not-yet-closed fence is
  // normal mid-stream, not a real truncation (avoids a flicker).
  const truncated = onBuild && !streaming ? hasTruncatedSpec(content) : false
  const started = !!detected && isSpecStarted(detected.spec)
  // Strip the suggestion block off the FULL text first (extraction is authoritative), then
  // SMOOTH-reveal that clean reply while streaming. Completed/history bubbles show it instantly.
  const { text: stripped } = extractSuggestions(content)
  const smoothed = useSmoothText(stripped, streaming)
  const displayed = streaming ? smoothed : stripped
  return (
    <div className="flex items-start gap-3">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-[10px] font-black text-slate-950">AK</div>
      {/* Bounded reading measure (~46rem): a long AKIS reply no longer runs edge-to-edge on a wide
          window (the owner's "yazı çizgilere taşıyor"). Slightly wider than an agent bubble so the
          spec-card document preview it can contain isn't cramped. */}
      <div className="min-w-0 max-w-[46rem] flex-1 space-y-3">
        {detected
          ? (
            <>
              {detected.intro && (
                <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] px-4 py-2.5 text-slate-200">
                  <Markdown content={detected.intro} />
                </div>
              )}
              <SpecCard spec={detected.spec} onBuild={onBuild!} building={!!building && !started} started={started} isSpecStarted={isSpecStarted} />
            </>
          )
          : (
            <>
              {/* `group relative` anchors a hover/focus-revealed Copy on the plain reply. It is
                  NOT rendered while streaming (would copy a half-stream) nor when empty; once
                  present it stays in the DOM via opacity so it's RTL-findable + keyboard-reachable.
                  Copies `stripped` (the visible reply, suggestion block already removed). */}
              <div className="group relative rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] px-4 py-2.5 pr-10 text-slate-200">
                <Markdown content={displayed} />
                {!streaming && stripped.trim() && (
                  <CopyButton text={stripped} label={t('copy.reply')}
                    className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100" />
                )}
              </div>
              {truncated && (
                <div role="alert" className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-200">
                  {t('akis.spec.truncated')}
                </div>
              )}
            </>
          )}
      </div>
    </div>
  )
})

export function AkisChat({
  api, onBuild, building, buildStarting, starting,
  activeSessionId, buildContextSessionId, onApprove, onConfirm, onNewBuild, onActiveView, onReactivate, onActionError,
  baseUrl = '', makeClient,
}: {
  api: ApiClient
  /** The Chat-to-Build seam (the ONLY build entry). May return the new session id (sync or async)
   *  so the chat can append the inline run marker IN PLACE; returning void keeps standalone callers
   *  (and the akis-chat tests) working — no run marker is appended then. */
  onBuild?: (spec: string) => void | string | undefined | Promise<string | undefined | void>
  building?: boolean
  /** A BUILD-START is in flight (functional fix): drives the SpecCard Approve disable INSTEAD of the
   *  shared `busy` — so approving a gate / running the preview on the active run no longer greys out
   *  every other spec card's Approve. Only a concurrent build-START disables the cards. */
  buildStarting?: boolean
  /** A transient "Workflow is starting…" card rendered at the tail WHILE a session is being
   *  created (after Approve, before its run marker appears). NOT the run itself — that is an
   *  inline RunBlock at the run marker's slot. */
  starting?: ReactNode
  /** The latest run's session id — the ACTIVE run. Its RunBlock stays live (others fold once);
   *  it reports its view up via onActiveView and shows the Stop control. */
  activeSessionId?: string
  /** BUILD-AWARE CHAT (SACRED, separate from chatOverrides): the active run's session id when it
   *  produced code, forwarded as the trailing sessionId arg to the chat calls so the persona gets a
   *  read-only, owner-scoped, contents-free snapshot. NEVER reaches onBuild/startSession. */
  buildContextSessionId?: string
  /** GATE-SAFE bare callbacks to the existing gated routes (mint nothing). Used by every run-block. */
  onApprove?: () => void
  onConfirm?: () => void
  /** Honest recovery for a 404'd (gone) session inside a run-block (reuses the studio's reset). */
  onNewBuild?: () => void
  /** The ACTIVE run reports its folded view up so the studio rail/header track it. */
  onActiveView?: (view: SessionView) => void
  /** Re-activate a non-active run (a recovery/gate action on an older block makes it live again). */
  onReactivate?: (id: string) => void
  /** Surface a run-block recovery/gate action failure to the studio's error banner. */
  onActionError?: (msg: string) => void
  baseUrl?: string
  makeClient?: () => EventStreamClient
}) {
  const { t } = useI18n()
  const greeting = t('akis.greeting')
  const [nodes, setNodes] = useState<ThreadEntry[]>(() => {
    const saved = loadThread()
    return saved.length ? saved : [{ role: 'assistant', content: greeting }]
  })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // ── Model picker (CHAT-ONLY visibility + selection) ──
  // The user's saved provider/model/effort preference (safe-parsed from localStorage).
  const [modelPref, setModelPref] = useState<ModelPref>(() => loadModelPref())
  // The provider catalog + serving mode, fetched ONCE on mount (mode is session-global, so
  // it is cached here and the chip reads it without refetching per render). Both degrade
  // gracefully: a failed fetch just hides the chip (the chat itself is unaffected).
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [mode, setMode] = useState<'live' | 'demo' | null>(null)
  // The caller's token usage vs. budget (fetched alongside health). null = hidden (401/unlimited
  // or a failed fetch) — the meter is pure observability, never blocks the chat.
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // SCROLL-TO-LATEST (UX feedback): when the user has scrolled UP to read history, a floating
  // "jump to latest" pill appears so new content below is one click away (and the auto-scroll
  // stays paused — we never yank them down mid-read).
  const [atBottom, setAtBottom] = useState(true)
  // The last user message we tried to send — drives Retry (resends it, untouched).
  const lastUser = useRef<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true) // false once the user scrolls up (auto-scroll guard)
  // Each run marker's wrapper <div>, keyed by sessionId — so when a build STARTS we scroll that
  // run's HEADER to the top of the viewport (block:'start') instead of yanking the whole column to
  // its very bottom (the "kayıyor" feeling, H3). The activity then grows DOWNWARD into view, the
  // natural "watch it work" reading order.
  const runRefs = useRef(new Map<string, HTMLDivElement>())
  // The sessionId of a JUST-appended run whose header we want scrolled to the top of the viewport
  // once its wrapper has mounted. Consumed (cleared) by the layout effect below — a ref, not state,
  // so arming it never triggers an extra render.
  const pendingRunScroll = useRef<string | undefined>(undefined)

  // Persist the WHOLE spine on every change so it survives a build start + reload: chat messages
  // AND run markers serialize to the same key. Strip the transient streaming placeholder/flag so a
  // reload never restores a half-streamed "in-flight" bubble (the flag is UI-only state).
  useEffect(() => { saveThread(forStorage(nodes)) }, [nodes])

  // Autofocus the composer on mount so the user can start typing immediately.
  useEffect(() => { inputRef.current?.focus() }, [])

  // Fetch the provider catalog + serving mode ONCE on mount (mode is session-global, cached).
  // Both are best-effort: any failure (offline, route absent in a test) just leaves the chip
  // hidden — the conversation never depends on them. If the saved pref has no provider yet,
  // SEED it from the first provider's defaultModel so the chip shows a concrete model.
  useEffect(() => {
    let alive = true
    // #41: providers + mode are session-stable — read them through a process cache so AkisChat's
    // per-build remounts don't re-fetch /api/providers + /health each time (invalidated on key change).
    void getProvidersCached(api)
      .then(raw => {
        if (!alive) return
        // Defensive: only ever trust an actual array (a misbehaving mock/route could return
        // a non-array, and `first.id` on undefined would crash the whole chat).
        const list = Array.isArray(raw) ? raw : []
        setProviders(list)
        // Seed from the first AVAILABLE provider, not list[0] (functional fix): seeding an
        // UNAVAILABLE provider made every chat request 400 (NoKey) on an instance whose default/
        // shared key is on a DIFFERENT provider. If none is available, leave it empty so
        // chatOverrides() omits provider/model and the server picks its own configured default.
        const first = list.find(p => p.available !== false)
        if (!first) return
        setModelPref(prev => (prev.provider ? prev : { ...prev, provider: first.id, model: first.defaultModel }))
      })
      .catch(() => {/* chip simply stays hidden */})
    void getModeCached(api).then(m => { if (alive && m) setMode(m) }).catch(() => {/* mode badge omitted */})
    // Per-user token-usage meter: best-effort. A 401 (anonymous) or unlimited deployment just
    // hides it (UsageMeter returns null) — the chat never depends on it.
    void api.usage().then(u => { if (alive) setUsage(u) }).catch(() => {/* meter hidden */})
    return () => { alive = false }
  }, [api])

  // Auto-scroll to the latest message/card — UNLESS the user scrolled up to read history, OR a
  // build just started (then the run-header scroll below owns the viewport so we don't yank to the
  // very bottom past the activity, H3).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // NB: on a build-start commit `appendRun` has set stickToBottom=false, so the jump branch below is
    // skipped and the run-header layout effect (block:'start') owns the viewport (H3) — no extra guard needed.
    if (stickToBottom.current) { el.scrollTop = el.scrollHeight; setAtBottom(true) }
    else setAtBottom(isNearBottom(el)) // new content arrived while scrolled up → reveal the pill
  }, [nodes, busy])

  // When a build STARTS, scroll its run HEADER to the TOP of the visible area (block:'start')
  // instead of bottom-pinning the column — the activity then grows downward into view (the
  // "watch it work" reading order). Layout effect so it runs after the wrapper has mounted but
  // before paint (no flash of the old scroll position). Respects reduced motion (no smooth jump).
  useLayoutEffect(() => {
    const id = pendingRunScroll.current
    if (!id) return
    const target = runRefs.current.get(id)
    if (target) {
      // Guard: jsdom (tests) + very old browsers lack scrollIntoView — never let a missing DOM API
      // break a build start. The behavior is intent-driven anyway (the run still renders).
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      }
      pendingRunScroll.current = undefined
    }
  }, [nodes])

  // The set of spec texts that ALREADY started a build — derived from the run markers in the spine
  // (each run marker's `idea` is the exact spec text passed to startBuild). PER-spec started state:
  // an older SpecCard in a multi-run thread reads "started" only if ITS spec spawned a run.
  const startedSpecs = useMemo(() => {
    const s = new Set<string>()
    for (const n of nodes) if (isRun(n)) s.add(n.idea.trim())
    return s
  }, [nodes])
  // useCallback-STABLE so the memoized AssistantMessage (which receives this predicate) is not
  // re-rendered every animation frame while a build streams its view up (the per-frame memo-defeat
  // the rAF coalescer is meant to avoid). The predicate matches a SpecCard's CURRENT (possibly
  // EDITED) text against the run markers — so an edited-then-built card correctly reads "started".
  const isSpecStarted = useCallback((spec: string): boolean => startedSpecs.has(spec.trim()), [startedSpecs])

  // One STABLE no-op for the optional gate/recovery callbacks a standalone caller (or a test) may omit.
  // The fallback used to be an INLINE `?? (() => {})` per prop per render — a fresh function identity each
  // render that defeated React.memo(RunBlock), re-rendering every terminal run-block on each active-run
  // SSE frame. A single shared `noop` keeps onApprove/onConfirm/onNewBuild reference-stable so the memo bails.
  const noop = useCallback(() => {}, [])

  // Append a run marker at the TAIL (the array slot where the SpecCard was approved) so the build
  // renders INLINE, below the chat turns that preceded it — chronology is structural, no timestamp.
  // useCallback-stable (only setNodes + a ref, both stable) so handleBuild below stays stable too.
  // H3: we do NOT re-arm stickToBottom here (that was the bottom-pin "kayıyor"). Instead we arm a
  // run-header scroll so the new build's header lands at the TOP of the viewport — the activity
  // grows downward into view rather than the column jumping to its very bottom past it.
  const appendRun = useCallback((sessionId: string, idea: string): void => {
    pendingRunScroll.current = sessionId
    stickToBottom.current = false // following the bottom would fight the header-to-top scroll
    setNodes(ns => [...ns, { role: 'run', sessionId, idea: idea.trim() }])
  }, [])

  // The Chat-to-Build seam: hand the approved spec to the studio's startBuild (the ONLY mint path),
  // and on a started session append its run marker IN PLACE. SACRED: only the spec string crosses
  // here — chat-only model overrides never reach this build call. useCallback-stable (deps onBuild +
  // appendRun) so the memoized AssistantMessage holds across the per-frame build re-renders. The
  // SpecCard is gated on onBuild presence at the call site (onBuild ? handleBuild : undefined).
  const handleBuild = useCallback((spec: string): void => {
    if (!onBuild) return
    void Promise.resolve(onBuild(spec)).then(id => { if (typeof id === 'string' && id) appendRun(id, spec) })
  }, [onBuild, appendRun])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = isNearBottom(el)
    stickToBottom.current = near // follow only while at the bottom
    setAtBottom(near)
  }

  /** Jump to the newest content + re-arm auto-follow (the scroll-to-latest pill). */
  const scrollToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickToBottom.current = true
    setAtBottom(true)
  }

  // Turn a thrown error into the row text we show (401 routes globally; ApiError vs network).
  const errorText = (err: unknown): string =>
    ApiError.is(err) && err.status === 401
      ? t('akis.error.unauthorized')
      // Quota exceeded (429): a localized, honest "you hit your token quota" sentence — never a
      // faked reply. Append the reset date when known (from the fetched usage state) so the user
      // knows when it frees up. The server fail-closed BEFORE the model; this is the surfacing.
      : ApiError.is(err) && (err.status === 429 || err.code === 'QuotaExceeded')
        ? quotaErrorText()
        // Opus review: NoKey must be a localized, actionable sentence — never the raw
        // English "(NoKey) No API key for provider x" on a user-facing error row.
        : ApiError.is(err) && err.code === 'NoKey'
          ? t('akis.error.noKey')
          : ApiError.is(err)
            ? `(${err.code ?? 'error'}) ${err.message}`
            : t('akis.error.network')

  // The quota row: the localized sentence + the reset date when the usage state knows it.
  const quotaErrorText = (): string => {
    const base = t('akis.error.quota')
    return usage?.resetAt ? `${base} ${t('usage.resets')}: ${new Date(usage.resetAt).toLocaleString()}` : base
  }

  // Finalize a streamed turn: replace the live placeholder with the authoritative full
  // reply (so spec detection runs on the trusted text), or an error row if it came back
  // empty. Drops the placeholder entirely when `reply` is empty so no blank bubble lingers.
  const finalize = (reply: string): void => {
    const clean = (reply ?? '').trim()
    setNodes(m => {
      const next = dropPlaceholder(m)
      return clean
        ? [...next, { role: 'assistant', content: clean }]
        : [...next, { role: 'error', content: t('akis.error.empty') }]
    })
  }

  // The CHAT-ONLY model-picker overrides for a chat request. WARNING (SACRED): these are
  // chat-only. They ride ONLY on api.chatWithAkis[Stream] below. They MUST NEVER be passed
  // to onBuild()/startSession() or any build/workflow call — builds keep their workflow
  // bindings, and leaking {provider, model, effort} into a build would corrupt that contract.
  // Empty provider/model mean "AKIS default", so the body omits them (byte-identical request).
  const chatOverrides = (): ChatOverrides => ({
    ...(modelPref.provider ? { provider: modelPref.provider } : {}),
    ...(modelPref.model ? { model: modelPref.model } : {}),
    // 'balanced' is the server default — omit it so the default request body stays
    // BYTE-identical to the pre-picker wire shape (Opus review).
    ...(modelPref.effort !== 'balanced' ? { effort: modelPref.effort } : {}),
  })

  // Send `text` to AKIS, STREAMING the reply into a live placeholder that updates as
  // deltas arrive. On any stream failure, fall back to the non-stream await path; only
  // if THAT also fails do we append an error ROW (never a faked AK reply). The history
  // replayed to the provider is computed BEFORE the placeholder is added, and `busy`
  // blocks a second send until this resolves — so an in-flight placeholder never leaks
  // into history (and error rows stay excluded, per historyForApi).
  const ask = async (text: string): Promise<void> => {
    if (busy) return
    lastUser.current = text
    setBusy(true)
    const history = historyForApi(nodes as ThreadNode[], greeting)
    // BUILD-AWARE CHAT (SACRED): a non-empty trailing sessionId tells the server to append a
    // read-only, owner-scoped, contents-free build snapshot to the persona. SEPARATE from the
    // chat-only model overrides (which keep their own positional arg) — they never collide.
    const ctxId = buildContextSessionId
    try {
      // Open a placeholder; each delta appends to its content (live incremental render).
      setNodes(m => [...m, { role: 'assistant', content: '', streaming: true }])
      const onDelta = (delta: string): void => {
        if (!delta) return
        setNodes(m => {
          const i = m.findIndex(x => isStreaming(x))
          if (i === -1) return m
          const next = [...m]
          const cur = next[i] as ChatMsg
          next[i] = { ...cur, content: cur.content + delta }
          return next
        })
      }
      // CHAT-ONLY overrides (see chatOverrides above): never forwarded to a build. The trailing
      // sessionId (build-aware context) is a SEPARATE positional arg, so it never collides with them.
      const { reply } = await api.chatWithAkisStream(text, history, onDelta, chatOverrides(), ctxId)
      finalize(reply)
    } catch (streamErr) {
      // Streaming failed (provider lacks it, a mid-stream drop, or an SSE `error` frame):
      // drop the partial placeholder and degrade to the proven non-stream await path.
      setNodes(m => dropPlaceholder(m))
      // A 401 already routed to login (ApiClient fired onUnauthorized) — don't replay the
      // non-stream call (it would just 401 again); show the brief notice row directly.
      // A 429 (QuotaExceeded) is also FINAL: the stream path already threw a typed
      // ApiError(429,'QuotaExceeded') from the pre-hijack JSON, so render it directly rather than
      // falling into the else branch that RE-CALLS the non-stream /api/chat — that second request
      // would just 429 again (a redundant blocked call). Short-circuit removes it.
      if (ApiError.is(streamErr) && (streamErr.status === 401 || streamErr.status === 429)) {
        setNodes(m => [...m, { role: 'error', content: errorText(streamErr) }])
      } else {
        try {
          // Fallback non-stream call carries the CHAT-ONLY overrides (never a build) + the same
          // build-aware sessionId so the fallback path is equally session-aware.
          const { reply } = await api.chatWithAkis(text, history, chatOverrides(), ctxId)
          const clean = (reply ?? '').trim()
          setNodes(m => clean
            ? [...m, { role: 'assistant', content: clean }]
            : [...m, { role: 'error', content: t('akis.error.empty') }])
        } catch (err) {
          setNodes(m => [...m, { role: 'error', content: errorText(err) }])
        }
      }
    } finally { setBusy(false) }
  }

  // Send an arbitrary message (typed, or a tapped suggestion chip) — adds the user bubble and
  // dispatches to AKIS. Shared by the composer and the suggestion chips so a chip sends directly.
  const sendText = (raw: string): void => {
    const text = raw.trim()
    if (!text || busy) return
    stickToBottom.current = true // a fresh send always follows to the bottom
    setNodes(m => [...m, { role: 'user', content: text }])
    void ask(text)
  }

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!input.trim() || busy) return
    const text = input
    setInput('')
    sendText(text)
  }

  // Resend the last user message (after a failure) WITHOUT re-adding a user bubble.
  const retry = (): void => {
    if (busy || lastUser.current === undefined) return
    stickToBottom.current = true
    // Drop trailing error rows so a successful retry doesn't leave a stale failure behind (a run
    // marker is never an error row, so the loop stops at it).
    setNodes(m => { const c = [...m]; while (c.length) { const last = c[c.length - 1]!; if (isMsg(last) && last.role === 'error') c.pop(); else break } return c })
    void ask(lastUser.current)
  }

  // A11Y (#36): the transcript itself is NOT a live region — token-by-token streaming + rapid build
  // bubbles would FLOOD a screen reader. Instead a small polite status region announces a SHORT
  // milestone ("AKIS responded") ONCE when streaming settles — not every token, and NOT the reply
  // text (which would double the transcript). It clears to '' while busy, so each completed reply is
  // a '' → "responded" change that re-announces.
  const repliedReady = !busy && nodes.length > 0 && isMsg(nodes[nodes.length - 1]!) && (nodes[nodes.length - 1] as ChatMsg).role === 'assistant'
  const liveStatus = repliedReady ? t('chat.aria.responded') : ''

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div role="status" aria-live="polite" className="sr-only">{liveStatus}</div>
      <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="akis-scroll h-full space-y-3 overflow-y-auto pr-1">
        {nodes.map((m, i) => {
          // A RUN MARKER renders its build INLINE at this exact slot (the single composition seam):
          // its own RunBlock mounts a per-run useLiveChat, the compact pipeline-strip header, and
          // the chronological agent bubbles. Only the ACTIVE run stays live; older runs fold once.
          if (isRun(m)) {
            const isActive = m.sessionId === activeSessionId
            const runId = m.sessionId
            return (
              // Wrapper carries a ref into runRefs (keyed by sessionId) so a just-started build's
              // HEADER can be scrolled to the top of the viewport (H3) — scroll-margin keeps it a
              // hair below the column edge. The wrapper is layout-neutral (no padding/border).
              <div
                key={runId}
                data-run-id={runId}
                className="scroll-mt-2"
                ref={(el) => { if (el) runRefs.current.set(runId, el); else runRefs.current.delete(runId) }}
              >
                <RunBlock
                  sessionId={runId}
                  idea={m.idea}
                  terminal={!isActive}
                  active={isActive}
                  busy={!!building}
                  api={api}
                  onApprove={onApprove ?? noop}
                  onConfirm={onConfirm ?? noop}
                  onNewBuild={onNewBuild ?? noop}
                  baseUrl={baseUrl}
                  {...(makeClient ? { makeClient } : {})}
                  {...(isActive && onActiveView ? { onView: onActiveView } : {})}
                  {...(onReactivate ? { onReactivate } : {})}
                  {...(onActionError ? { onActionError } : {})}
                />
              </div>
            )
          }
          if (m.role === 'user') {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[42rem] break-words rounded-2xl rounded-br-sm bg-gradient-to-br from-[#07D1AF]/90 to-violet-500/90 px-4 py-3 text-slate-950">{m.content}</div>
              </div>
            )
          }
          if (m.role === 'error') {
            const isLast = i === nodes.length - 1
            return (
              <div key={i} role="alert" className="flex items-start gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-rose-400/40 bg-rose-500/15 text-[11px] font-black text-rose-300" aria-hidden="true">!</div>
                <div className="min-w-0 max-w-[42rem] rounded-2xl rounded-tl-sm border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-200">
                  <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-rose-300/80">{t('akis.error.label')}</div>
                  <div>{m.content}</div>
                  {isLast && lastUser.current !== undefined && (
                    <button type="button" onClick={retry} disabled={busy}
                      className="mt-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-200 hover:border-rose-300/60 disabled:opacity-40">
                      {t('akis.error.retry')}
                    </button>
                  )}
                </div>
              </div>
            )
          }
          // Assistant bubble in its own component so the smoothing hook lives at a STABLE
          // position (one hook per message instance, never inside the map callback — that
          // would violate the Rules of Hooks as the thread grows/shrinks).
          return (
            <AssistantMessage
              key={i}
              content={m.content}
              streaming={isStreaming(m)}
              onBuild={onBuild ? handleBuild : undefined}
              building={buildStarting ?? building}
              isSpecStarted={isSpecStarted}
            />
          )
        })}
        {/* Cold-start starter prompts: when the thread is just AKIS's greeting (no build started
            yet), offer a few tappable example builds so the empty canvas has an answer affordance
            instead of a blank box — reuses the SAME sendText() path + chip styling as the
            akis-suggest chips. Rendered INSIDE the scroll area directly under the greeting bubble
            so the greeting + its answer-affordances read as one onboarding unit (not a far-away
            footer band). Disappears as soon as the user sends anything. */}
        {(() => {
          const first = nodes[0]
          const coldStart = !busy && !activeSessionId && nodes.length === 1 && !!first && isMsg(first) && first.role === 'assistant'
          if (!coldStart) return null
          const starters = [t('akis.starter.1'), t('akis.starter.2'), t('akis.starter.3'), t('akis.starter.4')]
          return (
            <div className="ml-11 flex flex-col gap-2">
              <p className="text-xs text-slate-400">{t('akis.starters.title')}</p>
              <div className="flex flex-wrap gap-2">
                {starters.map((s, i) => (
                  <button key={i} type="button" onClick={() => sendText(s)}
                    className="rounded-full border border-[#07D1AF]/30 bg-[#07D1AF]/[0.06] px-3 py-1.5 text-xs text-teal-200 transition hover:border-[#07D1AF]/60 hover:bg-[#07D1AF]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )
        })()}
        {/* The transient "Workflow is starting…" card (after Approve, before the run marker lands).
            The build ITSELF is an inline RunBlock at its run-marker slot — NOT a trailing injection. */}
        {starting && (
          <div className="ml-11 max-w-[calc(100%-2.75rem)]">
            {starting}
          </div>
        )}
        {busy && <div className="ml-11 text-xs text-teal-300">{t('akis.thinking')}</div>}
      </div>
        {/* SCROLL-TO-LATEST pill — floats over the scroll area only when the user is scrolled up,
            so new content below is one click away (theme: cosmic teal/violet, matches the composer). */}
        {!atBottom && (
          <button type="button" onClick={scrollToLatest} aria-label={t('chat.jumpToLatest')}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-teal-400/30 bg-slate-900/85 px-3 py-1.5 text-xs font-medium text-teal-100 shadow-[0_4px_24px_rgba(7,209,175,0.25)] backdrop-blur hover:border-teal-300/60 hover:bg-slate-800/90">
            <span aria-hidden className="text-sm leading-none">↓</span>{t('chat.jumpToLatest')}
          </button>
        )}
      </div>
      {/* Tappable quick-reply chips parsed from AKIS's latest reply (an `akis-suggest` block):
          the user picks one and it sends DIRECTLY — no typing. Hidden while busy/streaming. */}
      {(() => {
        // The chips come from the LATEST assistant chat reply — skip a trailing run marker so a
        // build never hides the suggestions of the reply that produced it.
        const last = nodes[nodes.length - 1]
        if (busy || !last || isRun(last) || last.role !== 'assistant' || isStreaming(last)) return null
        const { suggestions } = extractSuggestions(last.content)
        if (!suggestions.length) return null
        return (
          <div className="flex flex-wrap gap-2" aria-label={t('akis.suggestions')}>
            {suggestions.map((s, i) => (
              <button key={i} type="button" onClick={() => sendText(s)}
                className="rounded-full border border-[#07D1AF]/30 bg-[#07D1AF]/[0.06] px-3 py-1 text-xs text-teal-200 transition hover:border-[#07D1AF]/60 hover:bg-[#07D1AF]/10">
                {s}
              </button>
            ))}
          </div>
        )
      })()}
      {/* Visibility chip: show WHICH model + effort + mode is active near the composer.
          Opus review M2: NOT hostage to /health — the chip renders once the provider catalog
          loads; a failed health probe only degrades the badge (neutral), never hides the
          picker's sole entry point. Badge honesty: a key-less SELECTION shows "anahtar yok"
          (amber) regardless of the global mode — the badge reflects what THIS request will do. */}
      {/* The model chip + the per-user token meter sit together near the composer. The meter is
          pure observability (hidden on 401/unlimited via UsageMeter's own null) and never gates
          the chat. */}
      <div className="flex flex-wrap items-center gap-2">
        {(() => {
          const active = providers.find(p => p.id === modelPref.provider)
          if (!active) return null
          const modelLabel = active.models.find(m => m.id === modelPref.model)?.label ?? modelPref.model
          return (
            <ModelChip
              provider={active.label}
              model={modelLabel}
              effort={modelPref.effort}
              mode={active.available === false ? 'nokey' : mode}
              onClick={() => setPickerOpen(true)}
            />
          )
        })()}
        <UsageMeter usage={usage} />
      </div>
      {pickerOpen && providers.length > 0 && (
        <ModelPicker
          providers={providers}
          selected={modelPref as ModelSelection}
          onSelect={(sel: ModelSelection) => {
            const next: ModelPref = { provider: sel.provider, model: sel.model, effort: sel.effort as Effort }
            setModelPref(next)
            saveModelPref(next)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <form className="flex gap-2" onSubmit={send} aria-busy={busy}>
        <input ref={inputRef} aria-label={t('akis.ask')} value={input} onChange={e => setInput(e.target.value)} placeholder={t('akis.ask')}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-100 placeholder:text-slate-400 focus:border-[#07D1AF] focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/50" />
        <button type="submit" disabled={busy || input.trim() === ''}
          className="rounded-xl bg-gradient-to-r from-[#07D1AF] to-violet-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-[0_0_22px_rgba(7,209,175,0.35)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-40">{t('akis.send')}</button>
      </form>
    </div>
  )
}
