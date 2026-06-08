import { randomUUID } from 'node:crypto'
import type { ExternalWriteRecord } from '@akis/shared'
import type { SessionStore } from '../store/SessionStore.js'
import { digestExternalWrite, isAllowedExternalWriteAction, collidingExternalWriteKeys } from './externalWriteGate.js'
import { appendExternalWrite } from './appendExternalWrite.js'

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
 *    a model's loop turns / a double-submit). This dedupe is passed to the shared appender so it is
 *    re-evaluated on every retry attempt (exactly the prior in-loop behavior).
 *  - the capped append + the version-conflict retry are DELEGATED to the shared `appendExternalWrite`
 *    (used by the Atlassian propose route too), which evicts only the OLDEST TERMINAL record — never a
 *    still-in-flight 'proposed'/'executing' one — and refuses with TooManyPending if none is terminal.
 */

/** Hardcoded provider: a GitHub proposal is ALWAYS provider:'github'. Not a parameter, so neither
 *  the route nor the model can record a proposal under a different provider through this recorder. */
const GITHUB: 'github' = 'github'

/** True for a positive integer (or a string that is exactly one) — used to require a real PR number
 *  on an irreversible merge so the confirm UI's typed-PR-number friction (§5.4) can never be skipped. */
function isPositiveInt(v: unknown): boolean {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isInteger(n) && n > 0
}

export interface GithubProposalInput {
  action: string
  summary: string
  target: Record<string, unknown>
  payload: Record<string, unknown>
}

export type RecordGithubProposalResult = { writeId: string; digest: string } | { error: string; code?: 'TooManyPending' }

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
  // 1b. Fail-closed: a MERGE is irreversible and the confirm UI gates it behind typing the exact
  //     pullNumber (§5.4) — refuse a merge proposal that lacks a numeric pullNumber so that strongest
  //     friction can never be silently dropped for a malformed/ambiguous merge.
  if (action === 'merge_pull_request' && !isPositiveInt(target.pullNumber)) {
    return { error: 'merge_pull_request requires a numeric target.pullNumber' }
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

  // 4. Build the fresh proposal, then DELEGATE the capped append + version-conflict retry to the
  //    shared appender. Its `dedupe` is the github content-digest idempotency check (re-evaluated on
  //    every retry against the latest read): a 'proposed' record with this exact content ⇒ reuse it,
  //    no second append. The appender evicts only the OLDEST TERMINAL record when full (never an
  //    in-flight 'proposed'/'executing' one) and surfaces TooManyPending as an error string here.
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
  const out = await appendExternalWrite(store, sessionId, rec, {
    dedupe: writes => writes.find(
      w => w.status === 'proposed' && digestExternalWrite({ provider: GITHUB, action: w.action, target: w.target, payload: w.payload }) === digest,
    ),
  })
  if ('ok' in out) return { writeId: out.id, digest }
  // Propagate the appender's TooManyPending code so the route can return 409 (parity with atlassian),
  // not a generic 400 — a full row of in-flight proposals is a state conflict, not a bad action.
  return 'code' in out ? { error: out.error, code: out.code } : { error: out.error }
}
