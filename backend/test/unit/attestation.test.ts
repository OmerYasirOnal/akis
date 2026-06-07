import { describe, it, expect } from 'vitest'
import type { SessionState, VerifyToken, ApprovalToken } from '@akis/shared'
import { buildAttestation, attestationMarkdown } from '../../src/verify/attestation.js'
import { signPassport, generatePassportKeypair, verifyPassport } from '../../src/verify/passport.js'

/**
 * Move 3 — the Build Provenance Attestation. It wraps the EXISTING Ed25519-signed passport (the
 * verifiable core) with the build's gate/verification context, and stays HONEST: only the passport
 * is signed; the gate/subject fields are AKIS-asserted context. Pure + read-only — mints nothing.
 */
const keypair = generatePassportKeypair()
function sessionWithPassport(over: Record<string, unknown> = {}): SessionState {
  const facts = { sessionId: 's1', testsRun: 3, codeDigest: 'codedig', evidenceDigest: 'evdig' }
  const passport = signPassport(facts, keypair)
  return {
    id: 's1', status: 'done', idea: 'A notes API', version: 5,
    approval: { spec: { title: 'T', body: 'B' }, specDigest: 'd' } as unknown as ApprovalToken,
    verifyToken: { sessionId: 's1', testsRun: 3, codeDigest: 'codedig' } as unknown as VerifyToken,
    passport,
    ...over,
  } as SessionState
}

describe('buildAttestation', () => {
  it('returns null when the build has no signed passport (nothing to attest)', () => {
    const { passport: _p, ...noPass } = sessionWithPassport()
    void _p
    expect(buildAttestation(noPass as SessionState)).toBeNull()
  })

  it('attests a fully-gated build: subject, gates, verification + the SIGNED passport verbatim', () => {
    const a = buildAttestation(sessionWithPassport())!
    expect(a).not.toBeNull()
    expect(a.format).toBe('akis-build-provenance/v1')
    expect(a.subject).toEqual({ sessionId: 's1', idea: 'A notes API', codeDigest: 'codedig' })
    expect(a.gates).toEqual({ specApproved: true, verified: true, deployApproved: true })
    expect(a.verification).toEqual({ testsRun: 3, codeDigest: 'codedig', evidenceDigest: 'evdig', simulated: false })
    // The embedded passport is the ORIGINAL signed artifact — still offline-verifiable.
    expect(verifyPassport(a.passport)).toBe(true)
  })

  it('HONESTY: a SIMULATED (demo) run is marked simulated in the attestation + its markdown (no silent over-claim)', () => {
    const s = sessionWithPassport()
    const a = buildAttestation({ ...s, testEvidence: { ...(s.testEvidence ?? {}), demo: true } } as SessionState)!
    expect(a.verification.simulated).toBe(true)
    expect(attestationMarkdown(a)).toMatch(/SIMULATED/)
  })

  it('gates reflect reality: a verified-but-not-pushed build is NOT deployApproved', () => {
    const a = buildAttestation(sessionWithPassport({ status: 'awaiting_push_confirm' }))!
    expect(a.gates.verified).toBe(true)
    expect(a.gates.deployApproved).toBe(false)
  })

  it('gates reflect reality: no approval ⇒ specApproved false; mismatched verifyToken ⇒ verified false', () => {
    const a = buildAttestation(sessionWithPassport({
      approval: undefined,
      verifyToken: { sessionId: 'OTHER', testsRun: 3, codeDigest: 'x' } as unknown as VerifyToken,
    }))!
    expect(a.gates.specApproved).toBe(false)
    expect(a.gates.verified).toBe(false) // a token bound to another session never counts (no false green)
  })

  it('markdown carries the facts + the verbatim signed passport (the handable artifact)', () => {
    const a = buildAttestation(sessionWithPassport())!
    const md = attestationMarkdown(a)
    expect(md).toContain('# AKIS Build Provenance Attestation')
    expect(md).toContain('A notes API')
    expect(md).toContain('Tests run: **3**')
    // The signed passport is reproduced verbatim (its base64url signature + the PEM key header).
    expect(md).toContain(a.passport.signature)
    expect(md).toContain('-----BEGIN PUBLIC KEY-----')
    expect(md).toContain('CRYPTOGRAPHICALLY SIGNED')
  })
})
