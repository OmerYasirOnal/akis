import type { SessionState } from './session.js'
import type { AkisEvent } from './events.js'

/** A unit of grounding retrieved from the knowledge layer (RAG). */
export interface KnowledgeChunk {
  id: string
  text: string
  source: string          // file path / session id / url
  score: number           // retrieval score, 0..1
}

export type GateState = 'awaiting' | 'satisfied' | 'rejected'

/**
 * Typed cross-agent scratchpad — DERIVED from the event log, never free-form.
 * Deliberately NOT a `Record<string, unknown>` (v1's `intermediateState`
 * mistake): every field is named and typed, so the shared context cannot be
 * mutated through an untyped side channel. It is a pure projection of the
 * AkisEvent log (see `foldScratchpad`).
 */
export interface Scratchpad {
  gates: { specApproval?: GateState; pushConfirm?: GateState }
  verification?: { testsRun: number; passed: boolean }
  previewUrl?: string
  notes: string[]         // orchestrator narration (`text` events), capped
  errors: string[]        // `error` events + failed tool_results, capped
}

/**
 * The single typed, read-only context every agent reads (F2-AC16). A pure
 * projection of the session's existing single sources of truth — SessionState +
 * the AkisEvent log + retrieved knowledge — plus the derived scratchpad. It has
 * NO setters and carries NO capability (no verifier/minter/runner/store), so a
 * dispatched agent can read context but cannot reach a gate through it (F2-AC17).
 */
export interface SharedContext {
  readonly session: Readonly<SessionState>
  readonly events: readonly AkisEvent[]
  readonly scratchpad: Readonly<Scratchpad>
  readonly knowledge: readonly KnowledgeChunk[]
}
