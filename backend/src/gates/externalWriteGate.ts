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
 *
 * This gate is ORTHOGONAL to the 4 structural BUILD gates (spec-approval, producer≠verifier,
 * verified-real, push) — it neither reads nor mints any of them.
 */

/** The provider an external write targets. Extensible; today only Atlassian (Jira/Confluence). */
export type ExternalWriteProvider = 'atlassian'

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

/** Deterministic key ordering for a plain object (one level deep is enough for our flat payloads;
 *  nested objects are stringified by JSON in insertion order but we sort the top level which is
 *  where target/payload keys live). */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

export class ExternalWriteDigestMismatchError extends Error {
  constructor() {
    super('Cannot mint/execute ApprovedExternalWrite: confirmed content does not match the proposal')
    this.name = 'ExternalWriteDigestMismatchError'
  }
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
  if (token.writeId !== proposal.id || token.digest !== digestExternalWrite(proposal)) {
    throw new ExternalWriteDigestMismatchError()
  }
  const res = await transport.callTool(proposal.action, { ...proposal.target, ...proposal.payload })
  return { ok: !res.isError, text: res.text }
}
