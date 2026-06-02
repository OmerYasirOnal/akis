import type { Role, ToolName } from './roles.js'

export interface BaseEvent {
  sessionId: string
  agent: Role
  laneId: string          // distinguishes parallel branches
  ts: number              // backend-stamped at emit time
}

export type AkisEvent =
  | (BaseEvent & { kind: 'session'; status: 'started' | 'failed' | 'done' })
  | (BaseEvent & { kind: 'text'; text: string; ephemeral?: boolean })   // ephemeral=true → shown live but NOT ingested into RAG (free-form/untrusted narration)
  | (BaseEvent & { kind: 'agent_start'; role: Role })
  | (BaseEvent & { kind: 'agent_end'; role: Role; ok: boolean })
  | (BaseEvent & { kind: 'tool_call'; tool: ToolName; args: unknown })
  | (BaseEvent & { kind: 'tool_result'; tool: ToolName; ok: boolean; result?: unknown })
  | (BaseEvent & { kind: 'gate'; gate: 'spec_approval' | 'push_confirm'; state: 'awaiting' | 'satisfied' | 'rejected' })
  | (BaseEvent & { kind: 'verify'; testsRun: number; passed: boolean })   // verifier-only — FROZEN (gate source of truth)
  // Critic's READ-ONLY code-review verdict (Orchestrator.reviewCode). It is automatic
  // (NOT a human gate) and surfaced as a status card. STRUCTURED ONLY — booleans +
  // bounded counts, never free-form LLM prose — so it can never become trusted RAG
  // grounding (IngestionSink ingests only non-ephemeral `text`).
  | (BaseEvent & { kind: 'code_review'; approved: boolean; findings: number; critical: boolean; iteration: number })
  | (BaseEvent & { kind: 'preview'; url: string })
  // Rich preview/test telemetry (the dashboard renders these; `verify` stays the gate's truth).
  | (BaseEvent & { kind: 'preview_status'; status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'; url?: string; reason?: string })
  | (BaseEvent & { kind: 'test_progress'; phase: 'bdd' | 'e2e'; built?: number; running?: number; passed?: number; failed?: number })
  | (BaseEvent & { kind: 'test_stats'; built: number; running: number; passed: number; failed: number; durationMs: number })
  | (BaseEvent & { kind: 'done'; verified: boolean; provider: string })
  | (BaseEvent & { kind: 'error'; message: string; code?: string })
