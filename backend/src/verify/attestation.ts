import type { SessionState, BuildPassport } from '@akis/shared'
import { isVerified } from '@akis/shared'

/**
 * BUILD PROVENANCE ATTESTATION (strategy Move 3 — the handable deliverable). A portable,
 * SLSA/in-toto-ALIGNED presentation of what AKIS attests about a build: WHAT was built (subject +
 * code digest), that it passed the structural gates, and the REAL verification behind it — wrapped
 * around the EXISTING Ed25519-signed {@link BuildPassport}, which is the cryptographic core a
 * recipient verifies OFFLINE (no trust in AKIS required).
 *
 * HONESTY (the whole point of a trust artifact):
 *  - The `passport` field is the ONLY cryptographically-signed part (Ed25519 over the passport's
 *    canonical {sessionId,testsRun,codeDigest,evidenceDigest,issuedAt}). The `gates`/`subject`
 *    fields are AKIS-ASSERTED CONTEXT derived from the build's durable session state — `howToVerify`
 *    says so plainly. We do NOT re-sign a wider payload here (no new signing surface, no new key
 *    use), and we do NOT claim full in-toto/SLSA spec conformance — only structural ALIGNMENT.
 *  - This is provenance / verifiable-build EVIDENCE. It is NOT a compliance certificate; it never
 *    claims "EU AI Act compliant" (that would be the trust-theater AKIS exists to refute).
 *  - Read-only + additive: built from already-persisted session state; holds no gate capability and
 *    can mint nothing.
 */
export interface BuildProvenanceAttestation {
  /** Format tag (versioned, so a future field addition stays parseable). NOT an in-toto spec URI. */
  format: 'akis-build-provenance/v1'
  /** WHAT was built — the in-toto-style subject + its content digest. */
  subject: { sessionId: string; idea: string; codeDigest: string }
  /** WHO/HOW built it. */
  builder: { id: 'akis-multi-agent'; pipeline: 'idea → spec → code → verify → push' }
  /** The 4 structural gates' outcomes (AKIS-asserted context, derived from session state). */
  gates: { specApproved: boolean; verified: boolean; deployApproved: boolean }
  /** The REAL verification behind `verified` (mirrors the signed passport's facts). `simulated` is
   *  the DURABLE honesty marker (from TestEvidence.demo): TRUE when the ≥1-test pass came from a
   *  SIMULATED/mock runner, not a real test run — so a handed-off attestation can never silently
   *  over-claim a real verification (the Trust Report + /health badge carry the same marker). */
  verification: { testsRun: number; codeDigest: string; evidenceDigest: string; simulated: boolean }
  /** The Ed25519-SIGNED core — the offline-verifiable part. A recipient verifies THIS. */
  passport: BuildPassport
  /** ISO-8601 issuance time (the passport's). */
  issuedAt: string
  /** Plain instructions: what is signed, and how to verify it independently. */
  howToVerify: string
}

const HOW_TO_VERIFY =
  'CRYPTOGRAPHICALLY SIGNED: the `passport` field only — an Ed25519 signature (passport.signature) ' +
  'over the canonical JSON {sessionId,testsRun,codeDigest,evidenceDigest,issuedAt}, verifiable with ' +
  'passport.publicKey and NO trust in AKIS (see verifyPassport / any Ed25519 verifier). The ' +
  'subject/gates fields are AKIS-asserted context from the build\'s durable session state. This is ' +
  'verifiable build PROVENANCE (SLSA/in-toto-aligned), not a compliance certificate.'

/**
 * Build the attestation for a session, or null when there is nothing to attest (no signed passport
 * ⇒ the build never earned one). Pure (session → attestation); no I/O, no signing.
 */
export function buildAttestation(s: SessionState): BuildProvenanceAttestation | null {
  const passport = s.passport
  if (!passport) return null
  return {
    format: 'akis-build-provenance/v1',
    subject: { sessionId: s.id, idea: s.idea, codeDigest: passport.codeDigest },
    builder: { id: 'akis-multi-agent', pipeline: 'idea → spec → code → verify → push' },
    gates: {
      // Gate 1 (spec approval) — a branded ApprovalToken is present.
      specApproved: !!s.approval,
      // Gate 3 (verified = a REAL ≥1-test pass) — the fail-closed truth, never a bare flag.
      verified: isVerified(s),
      // Gate 4 (push confirm) — a confirmed push lands the build in the terminal `done` state.
      deployApproved: s.status === 'done',
    },
    verification: { testsRun: passport.testsRun, codeDigest: passport.codeDigest, evidenceDigest: passport.evidenceDigest, simulated: s.testEvidence?.demo === true },
    passport,
    issuedAt: passport.issuedAt,
    howToVerify: HOW_TO_VERIFY,
  }
}

/** A human-readable Markdown rendering of the attestation — the artifact a freelancer/agency hands
 *  a client. The signed passport is reproduced verbatim in a fenced block so it stays verifiable. */
export function attestationMarkdown(a: BuildProvenanceAttestation): string {
  const yes = (b: boolean): string => (b ? '✅' : '—')
  return [
    '# AKIS Build Provenance Attestation',
    '',
    `**What:** ${a.subject.idea || a.subject.sessionId}`,
    `**Session:** \`${a.subject.sessionId}\``,
    `**Issued:** ${a.issuedAt}`,
    `**Built by:** ${a.builder.id} (${a.builder.pipeline})`,
    '',
    '## Structural gates',
    `- ${yes(a.gates.specApproved)} Spec approved by a human`,
    `- ${yes(a.gates.verified)} Independently verified — a real ≥1-test pass${a.verification.simulated ? ' (⚠️ SIMULATED — demo mode, NOT a real test run)' : ''}`,
    `- ${yes(a.gates.deployApproved)} Deploy approved by a human`,
    '',
    '## Verification',
    `- Mode: **${a.verification.simulated ? '🟡 SIMULATED (demo mode — mock runner, not a real test run)' : '🟢 REAL test run'}**`,
    `- Tests run: **${a.verification.testsRun}**`,
    `- Code digest: \`${a.verification.codeDigest}\``,
    `- Evidence digest: \`${a.verification.evidenceDigest}\``,
    '',
    '## Signed passport (verify this)',
    '```json',
    JSON.stringify(a.passport, null, 2),
    '```',
    '',
    `> ${a.howToVerify}`,
    '',
  ].join('\n')
}
