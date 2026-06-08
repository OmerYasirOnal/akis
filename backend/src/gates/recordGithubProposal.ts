import { randomUUID } from 'node:crypto'
import { type ExternalWriteRecord, EXTERNAL_WRITES_MAX } from '@akis/shared'
import type { SessionStore } from '../store/SessionStore.js'
import { digestExternalWrite, isAllowedExternalWriteAction, collidingExternalWriteKeys } from './externalWriteGate.js'

/**
 * The SINGLE place that RECORDS a GitHub external-write PROPOSAL onto a session — shared by the
 * propose route AND the agent-facing `propose_github_write` tool so route + tool produce a
 * byte-identical record and one digest function. It EXECUTES NOTHING: it only appends (or returns
 * an existing) `status:'proposed'` ExternalWriteRecord. The propose→confirm→executeExternalWrite
 * boundary is unchanged — this module holds NO reference to mintApprovedExternalWrite /
 * executeExternalWrite / the ApprovedExternalWrite token, so there is no code path from a recorded
 * proposal to execution (only the human-hit confirm route reaches the executor).
 *
 * GATE-SAFE, fail-closed, in order:
 *  - provider is HARD-CODED 'github' (never a caller arg) — a caller cannot smuggle 'atlassian'.
 *  - the action must be on the GitHub external-write allow-list (the gate's own predicate), else error.
 *  - target/payload keys must be disjoint (the {...target,...payload} execute-merge would otherwise
 *    silently override), else error.
 *  - IDEMPOTENCY: the content digest dedupes — if a 'proposed' record with the same digest already
 *    exists, return the EXISTING {writeId,digest} instead of appending (one card per content across
 *    a model's loop turns / a double-submit).
 *  - append via the store's GENERIC version-checked `update` patch (NOT a gate method), capped at
 *    EXTERNAL_WRITES_MAX (oldest dropped), with a small read-modify-write retry on a version
 *    conflict (concurrent chat turns / a second propose bump the version mid-record).
 */

/** Hardcoded provider: a GitHub proposal is ALWAYS provider:'github'. Not a parameter, so neither
 *  the route nor the model can record a proposal under a different provider through this recorder. */
const GITHUB: 'github' = 'github'

/** Max read-modify-write retries on an optimistic-lock conflict before giving up (matches the
 *  confirm route's patchExternalWrite retry budget). */
const MAX_RETRY = 5

export interface GithubProposalInput {
  action: string
  summary: string
  target: Record<string, unknown>
  payload: Record<string, unknown>
}

export type RecordGithubProposalResult = { writeId: string; digest: string } | { error: string }

export async function recordGithubProposal(
  store: SessionStore,
  sessionId: string,
  input: GithubProposalInput,
): Promise<RecordGithubProposalResult> {
  const { action, summary, target, payload } = input
  // 1. Allow-list (authoritative): provider is fixed 'github'; an off-list action is refused here —
  //    the gate's OWN predicate, so a name the gate would reject at mint never becomes a proposal.
  if (!isAllowedExternalWriteAction(GITHUB, action)) {
    return { error: 'action is not on the GitHub external-write allow-list' }
  }
  // 2. Disjoint-key pre-check (mint re-checks — defense in depth): a key in BOTH target and payload
  //    would let payload silently override target at the execute merge.
  const collisions = collidingExternalWriteKeys(target, payload)
  if (collisions.length > 0) {
    return { error: `target/payload keys overlap: ${collisions.join(', ')}` }
  }
  // 3. The content digest — the same value the human confirm binds, computed over the SAME narrowed
  //    provider/action/target/payload, so record/route/digest can never diverge.
  const digest = digestExternalWrite({ provider: GITHUB, action, target, payload })

  for (let attempt = 0; ; attempt++) {
    const cur = await store.get(sessionId)
    if (!cur) return { error: `session ${sessionId} not found` }
    // 4. IDEMPOTENCY: a 'proposed' record with this exact content already exists ⇒ reuse it (one card
    //    per content, even if the model re-emits the same call across loop turns).
    const existing = (cur.externalWrites ?? []).find(
      w => w.status === 'proposed' && digestExternalWrite({ provider: GITHUB, action: w.action, target: w.target, payload: w.payload }) === digest,
    )
    if (existing) return { writeId: existing.id, digest }

    // 5. Append a fresh proposal, capped (oldest dropped) at EXTERNAL_WRITES_MAX.
    const rec: ExternalWriteRecord = {
      id: randomUUID(),
      provider: GITHUB,
      action,
      summary: summary.slice(0, 200),
      target,
      payload,
      status: 'proposed',
      proposedAt: new Date().toISOString(),
    }
    const next = [...(cur.externalWrites ?? []), rec].slice(-EXTERNAL_WRITES_MAX)
    try {
      await store.update(sessionId, { externalWrites: next }, cur.version)
      return { writeId: rec.id, digest }
    } catch (e) {
      // Only an optimistic-lock conflict is retryable (a live chat turn / a second propose bumped
      // the version between our read and write). Any other failure propagates as an error string —
      // the recorder never throws to the tool loop (it would otherwise be swallowed as a tool error).
      if (attempt >= MAX_RETRY || !/version conflict/.test(e instanceof Error ? e.message : '')) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
      // else: re-read + retry the optimistic update.
    }
  }
}
