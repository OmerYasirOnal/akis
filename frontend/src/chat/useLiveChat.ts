import { useEffect, useRef, useState } from 'react'
import type { AkisEvent } from '@akis/shared'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import { foldSessionView, emptyView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import { foldChat, type ChatMessage } from './chatModel.js'

export interface LiveChat { messages: ChatMessage[]; view: SessionView }

/** Max manual reconnect attempts for a CLOSED (non-auto-retrying) SSE stream before giving up. */
const MAX_RECONNECT = 6

/**
 * Subscribe a session's live stream once and project it into BOTH a chat thread
 * (chronological) and the aggregated SessionView (for the side rail + gate state).
 * Events are keyed by transport seq → idempotent across replay/reconnect; on a
 * `reset` it re-syncs from GET /sessions/:id/log (F2-AC12).
 *
 * `terminal` (multi-run anchored transcript): a run-block whose run is already OVER
 * (a non-active, terminal run in the spine) must NOT hold a live SSE subscription open —
 * only the ACTIVE run stays live (perf mitigation: N run-blocks ≠ N forever-live streams).
 * For a terminal run it does a single one-shot GET /sessions/:id/log, folds ONCE, and stops:
 * no EventSource, no rAF coalescer, no reconnect/give-up — a static, replayed transcript.
 */
export function useLiveChat(sessionId: string | undefined, idea: string, api: ApiClient, baseUrl = '', makeClient?: () => EventStreamClient, terminal = false): LiveChat {
  const [state, setState] = useState<LiveChat>({ messages: [], view: emptyView(sessionId ?? '') })
  const bySeq = useRef<Map<number, AkisEvent>>(new Map())
  // TRANSPORT state, overlaid onto the folded view (so foldSessionView stays pure): the SSE
  // stream dropped and the resumable EventSource is reconnecting (Last-Event-ID/seq, no double
  // counting). Drives the subtle "reconnecting" banner; cleared on the next delivered event.
  const lostRef = useRef(false)
  // TERMINAL transport state: every manual reconnect of a CLOSED source is exhausted — the
  // banner must switch from "reconnecting…" to an honest "live updates stopped + Reload"
  // (the audit's frozen-view gap: the old subtle banner span pulsed forever).
  const goneRef = useRef(false)

  // TERMINAL run (static transcript): fold the persisted /log ONCE and stop. No EventSource is
  // opened, so an older/reopened run never multiplies live subscriptions nor flickers — it reads
  // as a settled block. Re-runs only if the session id (or its terminal-ness) changes.
  useEffect(() => {
    if (!terminal) return
    if (!sessionId) { setState({ messages: [], view: emptyView('') }); return }
    let cancelled = false
    bySeq.current = new Map(); lostRef.current = false; goneRef.current = false
    void api.getSessionLog(sessionId)
      .then(log => {
        if (cancelled) return
        for (const { seq, event } of log) bySeq.current.set(seq, event)
        const ordered = [...bySeq.current.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)
        setState({ messages: foldChat(idea, ordered), view: foldSessionView(sessionId, ordered) })
      })
      // A gone session (404) folds to the empty view; the run-block's own getSession-404 probe
      // is what surfaces the honest "session gone" card, so this just leaves a clean empty block.
      .catch(() => { if (!cancelled) setState({ messages: [], view: emptyView(sessionId) }) })
    return () => { cancelled = true }
  }, [terminal, sessionId, idea, api])

  useEffect(() => {
    if (terminal) return
    if (!sessionId) { setState({ messages: [], view: emptyView('') }); return }
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let client: EventStreamClient | undefined
    bySeq.current = new Map()
    lostRef.current = false
    goneRef.current = false
    let rafId: number | undefined
    const refold = (): void => {
      if (cancelled) return
      const ordered = [...bySeq.current.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)
      const view = foldSessionView(sessionId, ordered)
      setState({ messages: foldChat(idea, ordered), view: { ...view, ...(lostRef.current ? { connectionLost: true } : {}), ...(goneRef.current ? { connectionGone: true } : {}) } })
    }
    // High-frequency event path coalescer: a fast build streams ~100 ephemeral notes/sec, and
    // folding the WHOLE log per event (O(n) sort+fold each → O(n²) over the run) plus a full
    // setState/re-render per token was the studio's jank source. Batch bursts into ONE fold+render
    // per animation frame. Transport-state changes (reset/error/give-up) still refold IMMEDIATELY
    // so the reconnecting/stopped banners stay responsive.
    const scheduleRefold = (): void => {
      if (cancelled || rafId !== undefined) return
      rafId = requestAnimationFrame(() => { rafId = undefined; refold() })
    }
    // Re-sync from GET /sessions/:id/log, MERGING by seq (overlays any replay-projected frame onto a
    // stale live-tapped one at the same seq — e.g. a dead 'ready' preview projected to 'stopped'). The
    // re-sync must not fail SILENTLY (audit gap): one retry after 2s; if that fails too, surface the
    // transient banner so the partial thread stays honest. Reused by onReset AND the F10 re-open path.
    const resyncFromLog = (retry: boolean): void => {
      void api.getSessionLog(sessionId).then(log => { if (cancelled) return; for (const { seq, event } of log) bySeq.current.set(seq, event); refold() })
        .catch(() => { if (cancelled) return; if (retry) { timer = setTimeout(() => resyncFromLog(false), 2000) } else { lostRef.current = true; refold() } })
    }
    // F10 — a LIVE tab that survives a backend restart auto-reconnects via Last-Event-ID, so the
    // server's replaySince returns ONLY post-cursor frames — a preview_status BEFORE the cursor is
    // never replayed, the replay-time liveness projection has no frame to correct, and a dead 'ready'
    // iframe persists (proxy 502, no Run affordance). On a RE-open (an open AFTER a prior successful
    // open) we re-fetch the FULL /log, which DOES run through the backend projection (the same door
    // GET /log uses), so the dead 'ready' folds in as the projected 'stopped' truth. The FIRST open is
    // skipped (initial connect already folds the empty view; events stream in normally).
    let opened = false
    const connect = (): void => {
      client = (makeClient ?? (() => new EventStreamClient()))()
      client.connect(`${baseUrl}/sessions/${sessionId}/events`, {
        // A delivered event means the stream is live again → clear the reconnecting flag + reset
        // the backoff. The event is keyed by seq, so a resumed/replayed event is deduped.
        onEvent: (e, seq) => { attempts = 0; lostRef.current = false; goneRef.current = false; bySeq.current.set(seq, e); scheduleRefold() },
        // A successful (re)connect clears the reconnecting banner even when NO event/reset follows —
        // the quiescent-gate case: a build parked awaiting approval emits nothing after the resume,
        // so without this the "reconnecting…" banner pulsed forever despite a healthy stream.
        // F10: on a RE-open, also re-fetch /log so a projected (post-restart) preview truth folds in.
        onOpen: () => {
          attempts = 0
          if (lostRef.current || goneRef.current) { lostRef.current = false; goneRef.current = false; refold() }
          if (opened) resyncFromLog(true)
          opened = true
        },
        onReset: () => {
          lostRef.current = false; bySeq.current = new Map()
          resyncFromLog(true)
        },
        // SSE dropped: mark reconnecting (subtle banner). A CONNECTING source the browser auto-
        // resumes via Last-Event-ID (the next onEvent clears the flag). A CLOSED source will NOT
        // retry (e.g. a 404), so reconnect it manually with capped backoff — a fresh connection
        // + the server's reset/log re-syncs — instead of leaving the banner stuck forever.
        onError: ({ closed }) => {
          if (cancelled) return
          if (!lostRef.current) { lostRef.current = true; refold() }
          if (closed && attempts < MAX_RECONNECT) {
            attempts++
            timer = setTimeout(() => { if (cancelled) return; client?.close(); connect() }, Math.min(1500 * attempts, 8000))
          } else if (closed) {
            // Give-up is now VISIBLE (audit gap): flip the terminal flag exactly once.
            if (!goneRef.current) { goneRef.current = true; refold() }
          }
        },
      })
    }
    connect()
    refold() // render the known (empty) view immediately, before the first event arrives
    return () => { cancelled = true; if (timer) clearTimeout(timer); if (rafId !== undefined) cancelAnimationFrame(rafId); client?.close() }
  }, [terminal, sessionId, idea, api, baseUrl, makeClient])

  return state
}
