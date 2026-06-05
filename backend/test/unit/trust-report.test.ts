import { describe, it, expect } from 'vitest'
import { buildTrustReport, renderTrustReportMarkdown } from '../../src/report/trustReport.js'
import type { SessionState, AkisEvent, BuildPassport } from '@akis/shared'

const base = (over: Partial<SessionState> = {}): SessionState => ({
  id: 's1', status: 'done', idea: 'team voting app', version: 3,
  spec: { title: 'Team Voting App', body: '# Team Voting App\n\nUsers sign up and vote.' },
  ...over,
})
const E = (e: Partial<AkisEvent> & { kind: string }): { event: AkisEvent } =>
  ({ event: { agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 1749000000000, ...e } as AkisEvent })

const REAL_EVIDENCE = {
  testsRun: 3, passed: true, durationMs: 900,
  bdd: { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 }, e2e: { testsRun: 3, passed: true, expected: 3, unexpected: 0, flaky: 0, skipped: 0, durationMs: 900 },
  scenarios: [
    { name: 'app boots and serves /', suite: 'e2e' as const, passed: true },
    { name: 'signup creates a user', suite: 'e2e' as const, passed: true },
    { name: 'vote is recorded once', suite: 'e2e' as const, passed: true },
  ],
}

describe('buildTrustReport (pure projection — grants nothing)', () => {
  it('a REAL verified run: verified=true, timestamps from gate events, passport attached', () => {
    const session = base({
      testEvidence: REAL_EVIDENCE,
      passport: { v: 1, sessionId: 's1', testsRun: 3, codeDigest: 'c'.repeat(16), evidenceDigest: 'e'.repeat(16), issuedAt: '2026-06-05T00:00:00Z', alg: 'Ed25519', publicKey: 'pk', signature: 'sig' } as BuildPassport,
    })
    const log = [
      E({ kind: 'gate', gate: 'spec_approval', state: 'satisfied', ts: 1749000001000 } as Partial<AkisEvent> & { kind: string }),
      E({ kind: 'verify', testsRun: 3, passed: true } as Partial<AkisEvent> & { kind: string }),
      E({ kind: 'code_review', approved: true, findings: 2, critical: false, iteration: 1 } as Partial<AkisEvent> & { kind: string }),
      E({ kind: 'gate', gate: 'push_confirm', state: 'satisfied', ts: 1749000002000 } as Partial<AkisEvent> & { kind: string }),
      E({ kind: 'done', verified: true, provider: 'anthropic' } as Partial<AkisEvent> & { kind: string }),
    ]
    const r = buildTrustReport(session, log, () => '2026-06-05T01:00:00Z')
    expect(r.verification.verified).toBe(true)
    expect(r.verification.simulated).toBe(false)
    expect(r.spec.approvedAt).toBe(new Date(1749000001000).toISOString())
    expect(r.delivery.pushConfirmedAt).toBe(new Date(1749000002000).toISOString())
    expect(r.review).toEqual({ approved: true, findings: 2, critical: false })
    expect(r.agents.provider).toBe('anthropic')
    expect(r.passport?.sessionId).toBe('s1')
    const md = renderTrustReportMarkdown(r)
    expect(md).toContain('✅ VERIFIED')
    expect(md).toContain('approved by a human at')
    expect(md).toContain('Build Passport')
  })

  it('a SIMULATED (demo) run can NEVER read verified — labeled SIMULATED everywhere', () => {
    const session = base({ testEvidence: REAL_EVIDENCE })
    const log = [E({ kind: 'verify', testsRun: 3, passed: true, demo: true } as Partial<AkisEvent> & { kind: string })]
    const r = buildTrustReport(session, log)
    expect(r.verification.verified).toBe(false) // evidence passed, but simulated ⇒ NOT verified
    expect(r.verification.simulated).toBe(true)
    const md = renderTrustReportMarkdown(r)
    expect(md).toContain('🟡 SIMULATED')
    expect(md).toContain('do not present as verified')
    expect(md).not.toContain('✅ VERIFIED')
  })

  it('an UNVERIFIED session renders the honest blocked report (a failure is also a report)', () => {
    const session = base({
      status: 'verify_failed',
      testEvidence: { ...REAL_EVIDENCE, passed: false, scenarios: [{ name: 'app boots and serves /', suite: 'e2e' as const, passed: false, reason: 'status 500' }] },
    })
    const r = buildTrustReport(session, [])
    expect(r.verification.verified).toBe(false)
    const md = renderTrustReportMarkdown(r)
    expect(md).toContain('❌ NOT VERIFIED')
    expect(md).toContain('push stays blocked')
    expect(md).toContain('status 500')
    expect(md).toContain('not approved')
  })

  it('no evidence at all: testsRun 0, no-checks wording, no approval timestamps invented', () => {
    const r = buildTrustReport(base({ status: 'building' }), [])
    expect(r.verification.testsRun).toBe(0)
    expect(r.spec.approvedAt).toBeUndefined()
    expect(r.delivery.pushConfirmedAt).toBeUndefined()
    const md = renderTrustReportMarkdown(r)
    expect(md).toContain('no checks ran')
    expect(md).toContain('no human approval recorded')
  })

  it('markdown survives hostile scenario names (pipes/newlines escaped, table intact)', () => {
    const session = base({
      testEvidence: { ...REAL_EVIDENCE, scenarios: [{ name: 'evil | name', suite: 'e2e' as const, passed: false, reason: 'line1\nline2 | x' }] },
    })
    const md = renderTrustReportMarkdown(buildTrustReport(session, []))
    expect(md).toContain('evil \\| name')
    expect(md).toContain('line1 line2 \\| x')
  })

  it('the disclaimer is always present and scoped to listed checks at a timestamp', () => {
    const md = renderTrustReportMarkdown(buildTrustReport(base(), []))
    expect(md).toContain('not a guarantee')
  })
})
