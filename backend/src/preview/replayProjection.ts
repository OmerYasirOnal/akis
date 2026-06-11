import type { AkisEvent } from '@akis/shared'
import type { SeqEvent } from '../events/bus.js'

/** The minimal registry view the projection needs (PreviewEntry satisfies it structurally) —
 *  the session routes depend on THIS seam, not on the PreviewRegistry class. */
export interface PreviewLivenessEntry {
  status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'
  reason?: string
}

/**
 * A3.2 + A3.4 — REPLAY-TIME preview-liveness projection.
 *
 * `preview_status` frames are persisted (dev-events snapshot) and replayed from the bus
 * buffers, but the PreviewRegistry — the actual child processes — is in-memory only. After
 * a backend restart (or a ring-buffer eviction of the terminal frame) a replay can claim a
 * liveness the registry can't back: a 'ready' frame whose /preview/:id/ url is dead (the
 * iframe 502s with no Run affordance) or a ghost 'starting' (a spinner nothing will ever
 * resolve). This rewrites the LAST replayed `preview_status` frame — in the OUTGOING copy,
 * never the shared bus buffer — to the registry's ground truth:
 *
 *   - no entry, or entry 'stopped'            → `stopped` (url stripped; the FE's existing
 *     stopped branch shows the muted pause + ▶ Run — a working affordance, no new strings)
 *   - entry 'failed' / 'unsupported'          → that status (+ its reason): the FE shows the
 *     existing localized Retry card
 *   - entry 'ready' / 'starting'              → genuinely live: pass through UNCHANGED
 *
 * Scope rules (deliberate):
 *   - Only the LAST `preview_status` frame is considered — earlier frames are history and
 *     the FE fold is last-wins, so rewriting them would be both useless and dishonest.
 *   - Only frames CLAIMING liveness ('ready'/'starting') are ever rewritten — a replay that
 *     already ends 'stopped'/'failed'/'unsupported' needs no correction.
 *   - The lookup uses the frame's PLAIN sessionId: verify-boot entries live under a
 *     '#verify'-suffixed registry key (PreviewRegistry VERIFY_SESSION_SUFFIX), so they can
 *     never make a dead session frame look live.
 *   - The transport `seq` is preserved — this is a content projection, never a re-numbering.
 *   - Pure: events[] + lookup in, events[] out. Callers apply it ONLY to replayed/buffered
 *     slices (GET /log + the SSE replay), never to live-tapped frames (those ARE ground truth).
 */
export function projectPreviewLiveness(
  events: SeqEvent[],
  lookup: (sessionId: string) => PreviewLivenessEntry | undefined,
): SeqEvent[] {
  let idx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.event.kind === 'preview_status') { idx = i; break }
  }
  if (idx === -1) return events
  const frame = events[idx]!
  const e = frame.event
  if (e.kind !== 'preview_status') return events // type narrowing (unreachable by construction)
  if (e.status !== 'ready' && e.status !== 'starting') return events // no liveness claimed
  const entry = lookup(e.sessionId)
  if (entry && (entry.status === 'ready' || entry.status === 'starting')) return events // genuinely live

  const dead: { status: 'stopped' | 'failed' | 'unsupported'; reason?: string } =
    entry && (entry.status === 'failed' || entry.status === 'unsupported')
      ? { status: entry.status, ...(entry.reason !== undefined ? { reason: entry.reason } : {}) }
      : { status: 'stopped' }
  const projected: AkisEvent = {
    kind: 'preview_status',
    status: dead.status,
    // url deliberately STRIPPED — only a live 'ready' may carry an embeddable url.
    ...(dead.reason !== undefined ? { reason: dead.reason } : {}),
    ...(e.demo ? { demo: true } : {}),
    agent: e.agent, laneId: e.laneId, sessionId: e.sessionId, ts: e.ts,
  }
  // Copy-on-write: replace ONLY that frame in a new array — the bus buffer objects are shared.
  return events.map((s, i) => (i === idx ? { seq: s.seq, event: projected } : s))
}
