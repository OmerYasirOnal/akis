import type { Role, ToolName } from './roles.js'

export interface BaseEvent {
  sessionId: string
  agent: Role
  laneId: string          // distinguishes parallel branches
  ts: number              // backend-stamped at emit time
}

export type AkisEvent =
  // `cancelled` is a clean, user-requested TERMINAL abandon (Orchestrator.cancel) — NOT a
  // failure and NOT a ship. It lets the live view stop driving an in-flight run without
  // ever touching a gate (cancel never verifies/pushes; see Orchestrator.cancel).
  | (BaseEvent & { kind: 'session'; status: 'started' | 'failed' | 'done' | 'cancelled' })
  | (BaseEvent & { kind: 'text'; text: string; ephemeral?: boolean })   // ephemeral=true → shown live but NOT ingested into RAG (free-form/untrusted narration)
  | (BaseEvent & { kind: 'agent_start'; role: Role })
  | (BaseEvent & { kind: 'agent_end'; role: Role; ok: boolean })
  | (BaseEvent & { kind: 'tool_call'; tool: ToolName; args: unknown })
  | (BaseEvent & { kind: 'tool_result'; tool: ToolName; ok: boolean; result?: unknown })
  | (BaseEvent & { kind: 'gate'; gate: 'spec_approval' | 'push_confirm'; state: 'awaiting' | 'satisfied' | 'rejected' })
  // A RECOVERABLE run state the human can act on so the run is never a silent dead-end.
  // This is DELIBERATELY NOT a `gate` event: the 4 STRUCTURAL gates are spec_approval +
  // push_confirm (+ producer≠verifier, verified=real-test-pass) and stay untouched. A
  // recovery `kind` un-parks an AUTOMATIC verdict or a failed verify; it NEVER bypasses a
  // structural gate — resolving `critic_resolution` continues to the REAL verify + push
  // gates (which still apply), and retrying `verify_failed` re-runs REAL verification.
  //   - critic_resolution: the AUTOMATIC critic did not approve and the iterate budget was
  //     exhausted → the human may `proceed` (continue to verify+push) or `abandon` (cancel).
  //   - verify_failed: real verification produced no token (tests failed / 0-test run) →
  //     the human may retry (re-enter the iterate loop + RE-RUN real verification).
  //   - push_failed: a VERIFIED run's push to GitHub failed (network/adapter) → the run is
  //     parked retryable; the human may retry the push. The retry re-runs the GATED confirmPush
  //     (which STILL requires a valid ApprovedPush minted from the persisted VerifyToken), so
  //     this surfaces a retry affordance WITHOUT ever bypassing Gate 4.
  // `state` is the lifecycle: `awaiting` (action needed) → `resolved` (the human chose) so a
  // resumed/replayed stream shows whether the card is still actionable. STRUCTURED ONLY.
  | (BaseEvent & { kind: 'recovery'; recovery: 'critic_resolution' | 'verify_failed' | 'push_failed'; state: 'awaiting' | 'resolved' })
  // verifier-only — FROZEN (gate source of truth). `demo` is an ADDITIVE, optional, PURELY
  // INFORMATIONAL annotation: true ⇔ the result was produced by the mock/injected test runner
  // (simulated verification), so the UI can mark it as not-a-real-pass AT THE RESULT. It never
  // affects minting, the VerifyToken, or any gate semantics, and it is ABSENT (undefined) on a
  // live run — a real verify event stays byte-identical to before this field existed.
  | (BaseEvent & { kind: 'verify'; testsRun: number; passed: boolean; demo?: boolean })
  // Critic's READ-ONLY code-review verdict (Orchestrator.reviewCode). It is automatic
  // (NOT a human gate) and surfaced as a status card. STRUCTURED ONLY — booleans +
  // bounded counts, never free-form LLM prose — so it can never become trusted RAG
  // grounding (IngestionSink ingests only non-ephemeral `text`).
  | (BaseEvent & { kind: 'code_review'; approved: boolean; findings: number; critical: boolean; iteration: number })
  | (BaseEvent & { kind: 'preview'; url: string })
  // Rich preview/test telemetry (the dashboard renders these; `verify` stays the gate's truth).
  // `demo` mirrors the verify annotation for the live-preview lifecycle: true ⇔ the boot is in
  // demo mode (mock provider and/or mock verification), so the embedded "running app" is a demo,
  // not a real-verified build. Additive, optional, informational; absent on a live boot.
  | (BaseEvent & { kind: 'preview_status'; status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'; url?: string; reason?: string; demo?: boolean })
  | (BaseEvent & { kind: 'test_progress'; phase: 'bdd' | 'e2e'; built?: number; running?: number; passed?: number; failed?: number })
  | (BaseEvent & { kind: 'test_stats'; built: number; running: number; passed: number; failed: number; durationMs: number })
  | (BaseEvent & { kind: 'done'; verified: boolean; provider: string })
  | (BaseEvent & { kind: 'error'; message: string; code?: string })
