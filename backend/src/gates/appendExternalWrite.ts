import { type ExternalWriteRecord, EXTERNAL_WRITES_MAX } from '@akis/shared'
import type { SessionStore } from '../store/SessionStore.js'

/**
 * The SINGLE place that APPENDS an ExternalWriteRecord onto a session's `externalWrites` — shared by
 * the Atlassian propose route AND the GitHub recorder (recordGithubProposal), so both grow the
 * capped row through ONE status-aware, version-resilient seam. It EXECUTES NOTHING: it only appends a
 * caller-built record (any status) and persists via the store's GENERIC version-checked `update`
 * patch (NOT a gate method) — there is no code path from here to an external write.
 *
 * It fixes a STATUS-BLIND eviction bug: the previous `[...writes, rec].slice(-EXTERNAL_WRITES_MAX)`
 * dropped index 0 regardless of status. If a still-in-flight ('proposed'/'executing') record was the
 * oldest, a 51st propose silently evicted it — losing a confirm's record (no executed/failed outcome
 * could be patched) and, worse, removing the at-most-once ledger so a re-proposed identical write
 * could execute a SECOND time. This helper NEVER evicts a non-terminal record:
 *
 *  - inside a `/version conflict/`-ONLY read-modify-write retry loop (MAX_RETRY=5): re-read the
 *    session each attempt (a live chat turn / a concurrent propose bumps the version mid-record);
 *  - if `externalWrites.length >= EXTERNAL_WRITES_MAX`, drop the OLDEST record whose status is
 *    TERMINAL ('executed' || 'failed'). If NONE is terminal (every slot is 'proposed'/'executing'),
 *    REFUSE with `{ code: 'TooManyPending' }` — a non-terminal record is never silently dropped;
 *  - else append and `store.update(..., version)`; retry only on an optimistic-lock conflict.
 *
 * The caller owns the record's identity/content (id/provider/action/target/payload/digest semantics
 * are unchanged) — this helper is purely the capped, status-aware append + persist.
 */

/** Max read-modify-write retries on an optimistic-lock conflict before giving up (matches the
 *  confirm route's patchExternalWrite + the github recorder's prior retry budget). */
const MAX_RETRY = 5

/** Terminal statuses — the ONLY records this helper may evict to make room for a new proposal. */
function isTerminal(s: ExternalWriteRecord['status']): boolean {
  return s === 'executed' || s === 'failed'
}

export type AppendExternalWriteResult =
  | { ok: true; id: string }
  | { error: string; code: 'TooManyPending' }
  | { error: string }

export interface AppendExternalWriteOptions {
  /** OPTIONAL idempotency hook (the github recorder's content-digest dedupe). Re-evaluated against the
   *  FRESHLY-read `externalWrites` on EVERY retry attempt — exactly like the recorder's prior in-loop
   *  check — so a record matching it is reused (returns its id, no append) instead of duplicated. */
  dedupe?: (writes: readonly ExternalWriteRecord[]) => ExternalWriteRecord | undefined
}

export async function appendExternalWrite(
  store: SessionStore,
  sessionId: string,
  record: ExternalWriteRecord,
  opts: AppendExternalWriteOptions = {},
): Promise<AppendExternalWriteResult> {
  for (let attempt = 0; ; attempt++) {
    const cur = await store.get(sessionId)
    if (!cur) return { error: `session ${sessionId} not found` }
    const writes = cur.externalWrites ?? []

    // IDEMPOTENCY (re-checked each attempt against the latest read): a record matching the caller's
    // dedupe predicate already exists ⇒ reuse it, no append (one card per content across loop turns
    // / a concurrent identical propose that won a prior version).
    const dup = opts.dedupe?.(writes)
    if (dup) return { ok: true, id: dup.id }

    // Capacity: when full, make room by dropping the OLDEST TERMINAL record. If none is terminal,
    // every slot is an in-flight ('proposed'/'executing') record we must NOT evict — refuse instead,
    // so the at-most-once ledger / a pending confirm's record can never be silently lost.
    let kept = writes
    if (writes.length >= EXTERNAL_WRITES_MAX) {
      const idx = writes.findIndex(w => isTerminal(w.status))
      if (idx === -1) {
        return { error: 'too many pending external-write proposals — resolve or confirm some first', code: 'TooManyPending' }
      }
      kept = [...writes.slice(0, idx), ...writes.slice(idx + 1)]
    }
    const next = [...kept, record]

    try {
      await store.update(sessionId, { externalWrites: next }, cur.version)
      return { ok: true, id: record.id }
    } catch (e) {
      // Only an optimistic-lock conflict is retryable (a live chat turn / a second propose bumped the
      // version between our read and write). Any other failure propagates as an error string — this
      // helper never throws (a github tool error would otherwise be swallowed by the tool loop).
      if (attempt >= MAX_RETRY || !/version conflict/.test(e instanceof Error ? e.message : '')) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
      // else: re-read + retry the optimistic update.
    }
  }
}
