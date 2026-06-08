import { createHash } from 'node:crypto'
import type { McpTransport } from '../agent/mcp/McpTransport.js'

/**
 * EXTERNAL-WRITE GATE — the security keystone for agent-initiated writes to an external system
 * (Jira/Confluence pages, issues) via MCP.
 *
 * THE INVARIANT: an agent can only PROPOSE an external write; it can NEVER perform one. A write
 * executes ONLY after an explicit HUMAN confirmation, and only of the EXACT content the human saw.
 * This mirrors the push gate (Gate 4): the model produces, a human approves, the server executes —
 * the model is never autonomous over an outward-facing side effect.
 *
 * Mechanism (same shape as pushGate.ApprovedPush):
 *  - `ExternalWriteProposal` is the agent's intent, recorded (not executed) during the build.
 *  - `ApprovedExternalWrite` is a NOMINAL-branded token (a module-private `unique symbol`) that
 *    cannot be written as a literal or forged with `as`. `mintApprovedExternalWrite` is the ONLY
 *    producer and requires the human-confirmed digest to MATCH the proposal's content digest — so a
 *    payload swapped between display and execution cannot be approved.
 *  - `executeExternalWrite` requires the token AND re-checks the digest, so the bytes that execute
 *    are exactly the bytes that were confirmed. There is no path to a write without the token.
 *  - A POSITIVE write-action allow-list (`ATLASSIAN_WRITE_ACTIONS`, mirroring readOnlyAllowlist) is
 *    enforced at BOTH mint and execute: only an action on the frozen set can be approved or run, so
 *    a proposal naming an off-list (e.g. destructive) tool is refused regardless of its digest.
 *
 * This gate is ORTHOGONAL to the 4 structural BUILD gates (spec-approval, producer≠verifier,
 * verified-real, push) — it neither reads nor mints any of them.
 */

/** The provider an external write targets. Extensible; today Atlassian (Jira/Confluence) + GitHub
 *  (issues/PR reviews via the connected remote MCP). Each provider has its OWN write allow-list
 *  (WRITE_ACTIONS_BY_PROVIDER) — a name valid for one is invalid for the other, so a proposal can
 *  never smuggle an action across providers. */
export type ExternalWriteProvider = 'atlassian' | 'github'

/**
 * An agent's PROPOSED external write — recorded during a build, executed only after human confirm.
 * `action` is the MCP write-tool name (e.g. 'createPage', 'createJiraIssue'); `target` says WHERE
 * (space/project) and `payload` says WHAT (title/body). The id is a handle, NOT part of the digest
 * (the digest binds the CONTENT a human reviews, not the bookkeeping id).
 */
export interface ExternalWriteProposal {
  id: string
  provider: ExternalWriteProvider
  /** Human-readable summary the confirm UI shows (e.g. 'Create Confluence page "Release notes"'). */
  summary: string
  /** The MCP write-tool name to invoke on confirmation. Must be on the provider's write allow-list. */
  action: string
  /** WHERE the write lands (space key, project key, parent id…). */
  target: Record<string, unknown>
  /** WHAT is written (title, body/markdown…). */
  payload: Record<string, unknown>
}

/** Stable content digest of a proposal — what the human confirms is bound to what executes. The id
 *  is excluded (it is a handle, not content); keys are canonicalized so ordering can't change it. */
export function digestExternalWrite(p: Pick<ExternalWriteProposal, 'provider' | 'action' | 'target' | 'payload'>): string {
  const canonical = JSON.stringify({ provider: p.provider, action: p.action, target: sortKeys(p.target), payload: sortKeys(p.payload) })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Deterministic, DEEP key ordering: recursively sorts the keys of every nested plain object so
 *  semantically-equal payloads digest identically regardless of insertion order — at any depth, and
 *  inside arrays. Array element ORDER is preserved (it is content); only object keys are reordered.
 *  Primitives (and null) pass through unchanged. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k])
    return out
  }
  return value
}

export class ExternalWriteDigestMismatchError extends Error {
  constructor() {
    super('Cannot mint/execute ApprovedExternalWrite: confirmed content does not match the proposal')
    this.name = 'ExternalWriteDigestMismatchError'
  }
}

export class ExternalWriteActionNotAllowedError extends Error {
  constructor(action: string) {
    super(`External write action "${action}" is not on the provider's write allow-list`)
    this.name = 'ExternalWriteActionNotAllowedError'
  }
}

export class ExternalWriteKeyCollisionError extends Error {
  constructor(keys: readonly string[]) {
    super(`External write proposal has overlapping target/payload keys: ${keys.join(', ')}`)
    this.name = 'ExternalWriteKeyCollisionError'
  }
}

/** The keys present in BOTH `target` and `payload` (own enumerable keys). The `{...target,...payload}`
 *  merge in executeExternalWrite would let payload SILENTLY override any such key — so we reject a
 *  colliding proposal at mint time rather than discover the ambiguity at the transport.
 *
 *  EXPORTED (as `collidingExternalWriteKeys`) so the PROPOSE side (the route + the agent tool's shared
 *  recorder) can run the SAME disjoint-key pre-check it will be re-checked against at mint — defense
 *  in depth, one predicate. Exporting the check is NOT widening authority: it neither mints nor
 *  executes; the only producer of an ApprovedExternalWrite remains mintApprovedExternalWrite. */
export function collidingExternalWriteKeys(target: Record<string, unknown>, payload: Record<string, unknown>): string[] {
  return Object.keys(target).filter(k => Object.prototype.hasOwnProperty.call(payload, k))
}

/** Local alias kept so the existing mint/execute call-sites read unchanged. */
const collidingKeys = collidingExternalWriteKeys

/**
 * POSITIVE write-action allow-list (mirrors readOnlyAllowlist.frozenReadOnlySet): a FROZEN set of
 * the ONLY MCP write-tool names an external-write proposal may invoke. This is the enforcement the
 * `ExternalWriteProposal.action` doc-comment promises ("Must be on the provider's write allow-list")
 * — without it the gate bound only the CONTENT of a write, not WHICH write tool runs, so a proposal
 * could name any server-advertised tool (e.g. a `deletePage`/destructive mutator) and still reach
 * the transport once its content digest was confirmed. The allow-list is checked at BOTH mint and
 * execute, so an off-list action can neither be approved nor (defense-in-depth) executed.
 *
 * As with the read-only set, `Object.freeze(new Set(...))` does NOT make the CONTENTS immutable —
 * `add`/`delete`/`clear` are prototype mutators — so we neutralize them on THIS instance (they
 * throw) and freeze the object, making the set immutable in fact, not merely by convention.
 */
function frozenWriteActionSet(label: string, names: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>(names)
  const deny = (op: string) => (): never => {
    throw new TypeError(`${label} is immutable: cannot ${op}() the write allow-list`)
  }
  Object.defineProperties(set, {
    add: { value: deny('add'), writable: false, configurable: false },
    delete: { value: deny('delete'), writable: false, configurable: false },
    clear: { value: deny('clear'), writable: false, configurable: false },
  })
  return Object.freeze(set) as ReadonlySet<string>
}

/** The ONLY Atlassian (Jira/Confluence) write-tool names a proposal may invoke. Keep this honest:
 *  add a name ONLY when the provider advertises it AND a human-confirm flow exists for it.
 *  TODO(wiring slice): once the Atlassian MCP bridge lands, pin this set against the tool names the
 *  provider ACTUALLY advertises (snapshot/intersection test, like readOnlyAllowlist's) — a name
 *  mismatch here would silently refuse every legitimate write. */
export const ATLASSIAN_WRITE_ACTIONS: ReadonlySet<string> = frozenWriteActionSet('ATLASSIAN_WRITE_ACTIONS', [
  'createPage',       // Confluence: create a page
  'createJiraIssue',  // Jira: create an issue
])

/**
 * The ONLY GitHub write-tool names a proposal may invoke — PINNED to what the connected GitHub remote
 * MCP (api.githubcopilot.com/mcp) ACTUALLY advertises (verified live 2026-06-08 against the owner's
 * connection via tools/list). CRITICAL: this server does NOT use the flat `github-mcp-server` names
 * (`create_issue`/`update_issue`/`create_pull_request_review`) — those tools DO NOT EXIST here, so
 * pinning them would silently refuse every legitimate write. The real shapes are method-consolidated:
 *  - `issue_write`               → BOTH create AND close/update an issue (payload.method 'create'|'update';
 *                                  close = method:'update' + state:'closed'). Covers 2 of the 4 logical actions.
 *  - `add_issue_comment`         → comment on an issue OR a PR (PR number passed as issue_number).
 *  - `pull_request_review_write` → create/submit a pull-request review (payload.method 'create', event APPROVE/
 *                                  REQUEST_CHANGES/COMMENT).
 * PULL-REQUEST writes (verified live 2026-06-08 against api.githubcopilot.com/mcp): there is NO
 * consolidated `pull_request_write` — these are FIVE separate, real tool names. Each is a distinct
 * logical action a human confirms one at a time; merge is IRREVERSIBLE and called out below.
 *  - `create_pull_request`        → open a PR (target owner/repo; payload title/head/base/body/draft).
 *  - `update_pull_request`        → edit / CLOSE a PR / request reviewers (target owner/repo/pullNumber;
 *                                   payload title/body/state:'closed'/base/draft/reviewers[]).
 *  - `merge_pull_request`         → MERGE a PR — IRREVERSIBLE (target owner/repo/pullNumber; payload
 *                                   merge_method merge|squash|rebase, commit_title, commit_message).
 *  - `update_pull_request_branch` → sync a PR branch with its base (target owner/repo/pullNumber;
 *                                   payload expectedHeadSha).
 *  - `request_copilot_review`     → request a Copilot review (target owner/repo/pullNumber; no payload).
 * The github-mcp-server-standard test (external-write-gate.test.ts) pins these AND records the
 * standard-name divergence so a future server change that reverts to flat names is caught. */
export const GITHUB_WRITE_ACTIONS: ReadonlySet<string> = frozenWriteActionSet('GITHUB_WRITE_ACTIONS', [
  'issue_write',                  // create OR close/update an issue (method: 'create' | 'update')
  'add_issue_comment',            // add an issue/PR comment
  'pull_request_review_write',    // create a pull-request review (method: 'create')
  'create_pull_request',          // open a PR (payload title/head/base/body/draft)
  'update_pull_request',          // edit / CLOSE a PR / request reviewers (payload state:'closed', reviewers[])
  'merge_pull_request',           // MERGE a PR — IRREVERSIBLE (payload merge_method merge|squash|rebase)
  'update_pull_request_branch',   // sync a PR branch with its base (payload expectedHeadSha)
  'request_copilot_review',       // request a Copilot review (no payload)
])

/**
 * The write allow-list PER provider. The gate admits an action ONLY against the set for THAT proposal's
 * provider, so a github tool name is invalid under 'atlassian' and vice-versa — provider and action are
 * bound together, never independently widenable. (`Record<ExternalWriteProvider, …>` makes adding a
 * provider to the union a compile error here until its set is supplied.)
 */
export const WRITE_ACTIONS_BY_PROVIDER: Record<ExternalWriteProvider, ReadonlySet<string>> = {
  atlassian: ATLASSIAN_WRITE_ACTIONS,
  github: GITHUB_WRITE_ACTIONS,
}

/** True iff `action` is on the positive external-write allow-list FOR THAT PROVIDER. The single
 *  predicate the gate uses to admit a proposed write tool — provider-scoped, so an action allowed for
 *  one provider is rejected for another. An unknown provider has no set → rejects everything. */
export function isAllowedExternalWriteAction(provider: ExternalWriteProvider, action: string): boolean {
  return WRITE_ACTIONS_BY_PROVIDER[provider]?.has(action) ?? false
}

/**
 * NOMINAL-branded approval token. The brand is a module-private `unique symbol`, so an
 * `ApprovedExternalWrite` cannot be written as a literal or fabricated with `as` outside this
 * module. `mintApprovedExternalWrite` is the only producer.
 */
declare const externalWriteBrand: unique symbol

export type ApprovedExternalWrite = {
  readonly [externalWriteBrand]: true
  readonly writeId: string
  readonly digest: string
}

/**
 * Mint requires the HUMAN-confirmed digest to equal the proposal's content digest. The confirm
 * route passes the digest the UI displayed to the human; if it doesn't match the stored proposal
 * (a swap/tamper between display and confirm), minting throws and no write can execute.
 */
export function mintApprovedExternalWrite(proposal: ExternalWriteProposal, confirmedDigest: string): ApprovedExternalWrite {
  if (!isAllowedExternalWriteAction(proposal.provider, proposal.action)) throw new ExternalWriteActionNotAllowedError(proposal.action)
  // DISJOINT-key invariant: executeExternalWrite merges `{...target,...payload}`; if a key appears in
  // both, payload would silently override target with no signal to the confirming human. Refuse here
  // so a proposal can only be approved when the merge is unambiguous.
  const collisions = collidingKeys(proposal.target, proposal.payload)
  if (collisions.length > 0) throw new ExternalWriteKeyCollisionError(collisions)
  const digest = digestExternalWrite(proposal)
  if (confirmedDigest !== digest) throw new ExternalWriteDigestMismatchError()
  return { writeId: proposal.id, digest } as unknown as ApprovedExternalWrite
}

/** The normalized outcome of an executed external write. */
export interface ExternalWriteResult { ok: boolean; text: string }

/**
 * Execute a confirmed external write. UNCALLABLE without the branded token → no external write
 * without a human-confirmed approval. Re-checks the digest (defense-in-depth: the bytes executed
 * are exactly the bytes confirmed) before invoking the provider's MCP write tool via the transport.
 */
export async function executeExternalWrite(
  token: ApprovedExternalWrite,
  transport: McpTransport,
  proposal: ExternalWriteProposal,
): Promise<ExternalWriteResult> {
  // NOT redundant with the digest re-check below: the digest binds `action`, so a plain post-mint
  // action swap already fails the comparison. This check defends the remaining case — a proposal
  // whose digest matches but whose action is off-list (e.g. the allow-list shrank after mint, or a
  // colliding digest was found). Defense-in-depth; do not delete as "already covered by the digest".
  if (!isAllowedExternalWriteAction(proposal.provider, proposal.action)) throw new ExternalWriteActionNotAllowedError(proposal.action)
  if (token.writeId !== proposal.id || token.digest !== digestExternalWrite(proposal)) {
    throw new ExternalWriteDigestMismatchError()
  }
  // Same defense-in-depth parity as the allow-list above: mint already refused colliding keys, but
  // re-assert here so the unambiguous-merge property never rests on mint alone.
  const collisions = collidingKeys(proposal.target, proposal.payload)
  if (collisions.length > 0) throw new ExternalWriteKeyCollisionError(collisions)
  const res = await transport.callTool(proposal.action, { ...proposal.target, ...proposal.payload })
  return { ok: !res.isError, text: res.text }
}
