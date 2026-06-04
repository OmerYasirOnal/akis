import type { VerifyToken } from './verify.js'
import type { ApprovalToken } from './approval.js'
import type { BuildPassport } from './passport.js'

export type SessionStatus =
  | 'composing' | 'awaiting_spec_approval' | 'building'
  | 'awaiting_critic_resolution' | 'awaiting_push_confirm'
  // `verify_failed` is a RETRYABLE state: real verification returned no token (tests
  // failed / zero-test run), so the run is NOT verified and NOT a silent reset to
  // 'building' (a dead-end). The human can retry — which re-enters the iterate loop and
  // RE-RUNS REAL verification (mint still needs a genuine ≥1-test pass; no bypass).
  | 'verify_failed'
  | 'done' | 'push_failed' | 'failed' | 'cancelled'

export interface SpecArtifact { title: string; body: string }
export interface CodeArtifact { files: { filePath: string; content: string }[] }

/**
 * One scenario/test that the verifier ran, captured as STRUCTURED evidence (never
 * free-form prose). On failure, `reason` is a SHORT, bounded, structured label
 * (e.g. a step keyword + the failing step text, or a Playwright outcome) — NOT an
 * LLM narrative — so this evidence can NEVER become trusted RAG grounding nor leak
 * a secret (it carries only test-shaped facts). `step` names the failing step when
 * the source reports one.
 */
export interface ScenarioEvidence {
  /** BDD scenario / E2E test display name. */
  name: string
  /** Which suite produced it — the BDD (cucumber) or E2E (playwright) half. */
  suite: 'bdd' | 'e2e'
  passed: boolean
  /** Structured failure reason (present only when `passed === false`). Bounded label. */
  reason?: string
  /** The failing step (BDD) when the source identifies one. */
  step?: string
}

/** Aggregate counts for the BDD (cucumber) half — mirrors the runner's BddStats. */
export interface BddEvidence {
  built: number
  run: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
}

/** Aggregate counts for the E2E (playwright) half — mirrors the runner's E2eStats. */
export interface E2eEvidence {
  testsRun: number
  passed: boolean
  expected: number
  unexpected: number
  flaky: number
  skipped: number
  durationMs: number
}

/**
 * STRUCTURED failure report (present only when the run did NOT pass). It lists the
 * named failing scenarios + their bounded structured reasons — the future
 * self-repair loop / Trust Report read this. STRUCTURED ONLY (names + bounded
 * labels, never free-form prose), so it can never become trusted RAG grounding
 * (the codebase's ephemeral/injection rule) or carry a secret.
 */
export interface TestFailureReport {
  failedCount: number
  scenarios: ScenarioEvidence[]
  /** A top-level reason for a non-pass that has NO per-scenario failure (timeout / zero tests /
   *  all-skipped) — so the failure signal the self-repair loop + Trust Report read is never empty. */
  reason?: string
}

/**
 * ADDITIVE, NON-GATE test evidence persisted on the normal session-update path so
 * `GET /sessions/:id` can surface the structured detail the verifier computes (and
 * today discards). This is OBSERVABILITY ONLY: it NEVER affects minting, the
 * VerifyToken, or any gate — verification stays the PRESENCE of the branded
 * `verifyToken`. It is written via the generic `update` patch (the SessionStore
 * gate-field allowlist is unchanged), never by a gate method.
 *
 * `passed` here MIRRORS the run outcome for display; it is NOT the gate truth
 * (use `isVerified()` / `verifyToken` for that). `durationMs` is the summed BDD +
 * E2E run time, so a real p95 becomes computable later.
 */
export interface TestEvidence {
  /** Total scenarios/tests run across both suites (bdd.run + e2e.testsRun). */
  testsRun: number
  /** The run's pass outcome (display mirror — NOT the gate). */
  passed: boolean
  /** Summed BDD + E2E run time on this host (enables a later p95; not a benchmark). */
  durationMs: number
  bdd: BddEvidence
  e2e: E2eEvidence
  /** Per-scenario detail (name, passed, structured failure reason/step). */
  scenarios: ScenarioEvidence[]
  /** Structured failure report — present only when the run did NOT pass. */
  failure?: TestFailureReport
}

export interface SessionState {
  id: string
  status: SessionStatus
  idea: string
  /** The user who started this build (for per-user history). Absent for anonymous runs. */
  ownerId?: string
  spec?: SpecArtifact
  /**
   * Gate 1: approval is a branded ApprovalToken (not a plain spec field), so a
   * generic store patch cannot fabricate it. Set only via the store's dedicated
   * approval method, which the orchestrator's approve() calls.
   */
  approval?: ApprovalToken
  code?: CodeArtifact
  /**
   * EDIT MODE (Phase B.5): the prior app this build EDITS, seeded from an earlier session's
   * shipped `code.files` (owner-checked at the API). Proto sees these files and returns only
   * what it changes/adds; the orchestrator merges Proto's output OVER this base so unchanged,
   * already-approved files survive a follow-up build instead of being regenerated or lost.
   * Data only — carries no gate capability; every structural gate applies unchanged.
   */
  base?: { files: CodeArtifact['files']; fromSession: string }
  /**
   * Gate 3: verification is the PRESENCE of a branded VerifyToken (real ≥1-test
   * pass), never a free boolean. The brand cannot be written as a literal, so the
   * store cannot be made to claim verification. Persisted, so it survives restart.
   */
  verifyToken?: VerifyToken
  /**
   * ADDITIVE, NON-GATE structured test evidence (scenarios + counts + durationMs +
   * structured failure detail). Written on the NORMAL session-update path (the
   * generic store patch, NOT a gate method), so it never widens the gate-write
   * surface. Observability/evidence only — it NEVER affects minting or any gate;
   * verification remains the presence of `verifyToken` (see `isVerified`).
   */
  testEvidence?: TestEvidence
  /**
   * ADDITIVE, NON-GATE signed Build Passport — the durable, third-party-verifiable proof of
   * THIS session's verification (Ed25519-signed already-minted facts: sessionId, testsRun,
   * codeDigest, evidenceDigest, issuedAt). Produced AFTER verification and written on the
   * NORMAL (generic-patch) update path, NOT a gate method, so it never widens the gate-write
   * surface. It ATTESTS the gate truth; it can never fabricate it — verification remains the
   * presence of `verifyToken` (see `isVerified`). Absent until a verified build signs one.
   */
  passport?: BuildPassport
  version: number               // optimistic lock
}

/** Derived verification state — the single source of truth the outside world reads. */
export function isVerified(s: SessionState): boolean {
  return s.verifyToken != null && s.verifyToken.sessionId === s.id
}

export function initialSession(id: string, idea: string, ownerId?: string): SessionState {
  return { id, status: 'composing', idea, version: 0, ...(ownerId ? { ownerId } : {}) }
}
