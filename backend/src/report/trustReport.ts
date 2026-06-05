import type { SessionState, AkisEvent, BuildPassport } from '@akis/shared'

/**
 * The CLIENT-FACING Trust Report — the exportable artifact the GTM plan names as the
 * first commercial build item (§8: "Trust report export/share"). It renders the facts a
 * session ALREADY EARNED through the gates into something an agency can hand to a client.
 *
 * TRUST SEAM (read carefully): this module is a pure PROJECTION. It reads the session +
 * its event log and never computes, grants or upgrades trust — `verified` here can only
 * be true when the session carries REAL evidence (testsRun ≥ 1 && passed) AND the run was
 * not simulated. A demo/simulated run is labeled SIMULATED in capitals everywhere, and an
 * unverified session renders an honest "NOT VERIFIED — push blocked" report (a failure is
 * also a report — that is the product's pitch). The signed BuildPassport is attached as
 * the cryptographic anchor; this module cannot mint one.
 */

export interface TrustReport {
  generatedAt: string
  project: { title: string; sessionId: string }
  spec: { title: string; summary: string; approvedAt?: string }
  agents: { producer: string; verifier: string; provider?: string }
  verification: {
    /** True ONLY for a REAL ≥1-test pass (never for simulated runs). */
    verified: boolean
    /** True when the verification ran in demo mode (mock provider / mock verification). */
    simulated: boolean
    testsRun: number
    passed: boolean
    scenarios: { name: string; passed: boolean; reason?: string }[]
    evidenceDigest?: string
  }
  review?: { approved: boolean; findings: number; critical: boolean }
  delivery: { pushConfirmedAt?: string; status: SessionState['status'] }
  /** The signed, third-party-verifiable anchor (absent when no verified build signed one). */
  passport?: BuildPassport
  disclaimer: string
}

const DISCLAIMER =
  'Verified means: the listed checks ran against this exact build at the recorded timestamp and passed. ' +
  'It is a statement about those checks at that moment — not a guarantee the software is free of all defects.'

/** Last timestamp of a matching event (the log is seq-ordered; later entries win). */
function lastTs(log: readonly { event: AkisEvent }[], match: (e: AkisEvent) => boolean): string | undefined {
  let ts: number | undefined
  for (const { event } of log) if (match(event)) ts = event.ts
  return ts === undefined ? undefined : new Date(ts).toISOString()
}

/** First ~400 chars of the spec body, cut on a line boundary — a summary, not the contract. */
function specSummary(body: string): string {
  if (body.length <= 400) return body
  const cut = body.slice(0, 400)
  const nl = cut.lastIndexOf('\n')
  return (nl > 200 ? cut.slice(0, nl) : cut) + '\n…'
}

export function buildTrustReport(
  session: SessionState,
  log: readonly { event: AkisEvent }[],
  now: () => string = () => new Date().toISOString(),
): TrustReport {
  const ev = session.testEvidence
  // Demo detection — PERSISTED evidence first (durable; review #113: the verify event lives
  // in a capped ring buffer and can be evicted on long sessions), event scan as a secondary
  // for evidence persisted before the demo field existed.
  let simulated = ev?.demo === true
  let reviewState: TrustReport['review']
  let provider: string | undefined
  for (const { event } of log) {
    if (event.kind === 'verify' && event.demo === true) simulated = true
    if (event.kind === 'code_review') reviewState = { approved: event.approved, findings: event.findings, critical: event.critical }
    if (event.kind === 'done') provider = event.provider
  }
  const ran = ev !== undefined
  // REAL verification only: ≥1 test, passed, and NOT a simulated run.
  const verified = ran && ev.testsRun >= 1 && ev.passed === true && !simulated

  return {
    generatedAt: now(),
    project: { title: session.spec?.title ?? session.idea.split('\n')[0] ?? session.id, sessionId: session.id },
    spec: {
      title: session.spec?.title ?? '(no spec)',
      summary: session.spec ? specSummary(session.spec.body).replace(/`/g, '\\`') : '(no approved spec)', // escape fences: the summary must stay INSIDE the report structure
      ...(lastTs(log, e => e.kind === 'gate' && e.gate === 'spec_approval' && e.state === 'satisfied') !== undefined
        ? { approvedAt: lastTs(log, e => e.kind === 'gate' && e.gate === 'spec_approval' && e.state === 'satisfied')! }
        : {}),
    },
    agents: {
      producer: 'Proto (producer — writes code, can never verify)',
      verifier: 'Trace (verifier — runs checks, can never write code)',
      ...(provider !== undefined ? { provider } : {}),
    },
    verification: {
      verified,
      simulated,
      testsRun: ev?.testsRun ?? 0,
      passed: ev?.passed ?? false,
      scenarios: (ev?.scenarios ?? []).map(s => ({
        name: s.name,
        passed: s.passed,
        ...(s.reason !== undefined ? { reason: s.reason } : {}),
      })),
      ...(session.passport?.evidenceDigest !== undefined ? { evidenceDigest: session.passport.evidenceDigest } : {}),
    },
    ...(reviewState !== undefined ? { review: reviewState } : {}),
    delivery: {
      status: session.status,
      ...(lastTs(log, e => e.kind === 'gate' && e.gate === 'push_confirm' && e.state === 'satisfied') !== undefined
        ? { pushConfirmedAt: lastTs(log, e => e.kind === 'gate' && e.gate === 'push_confirm' && e.state === 'satisfied')! }
        : {}),
    },
    ...(session.passport !== undefined ? { passport: session.passport } : {}),
    disclaimer: DISCLAIMER,
  }
}

/** Render the report as a self-contained Markdown artifact (what an agency sends a client). */
export function renderTrustReportMarkdown(r: TrustReport): string {
  const badge = r.verification.verified
    ? '✅ VERIFIED — every listed check ran and passed'
    : r.verification.simulated
      ? '🟡 SIMULATED — demo mode: checks were simulated, NOT real (do not present as verified)'
      : r.verification.testsRun > 0
        ? '❌ NOT VERIFIED — checks ran and FAILED; push stays blocked'
        : '❌ NOT VERIFIED — no checks ran; push stays blocked'
  const scen = r.verification.scenarios.length
    ? r.verification.scenarios.map(s => `| ${s.passed ? '✅' : '❌'} | ${s.name.replace(/\|/g, '\\|')} | ${(s.reason ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n')
    : '| — | (no scenario detail) | |'
  return [
    `# Trust Report — ${r.project.title}`,
    '',
    `**${badge}**`,
    '',
    `Generated ${r.generatedAt} · Session \`${r.project.sessionId}\``,
    '',
    '## Scope (the approved spec)',
    '',
    `**${r.spec.title}**${r.spec.approvedAt ? ` — approved by a human at ${r.spec.approvedAt}` : ' — *no human approval recorded*'}`,
    '',
    r.spec.summary,
    '',
    '## Who did what (separation of duties)',
    '',
    `- Producer: ${r.agents.producer}`,
    `- Verifier: ${r.agents.verifier}`,
    ...(r.agents.provider ? [`- AI provider: ${r.agents.provider}`] : []),
    '',
    '## Verification evidence',
    '',
    `- Checks run: **${r.verification.testsRun}** · Outcome: **${r.verification.passed ? 'passed' : 'failed'}**${r.verification.simulated ? ' · **SIMULATED (demo mode)**' : ''}`,
    ...(r.verification.evidenceDigest ? [`- Evidence digest: \`${r.verification.evidenceDigest}\``] : []),
    '',
    '| Result | Check | Failure reason |',
    '|---|---|---|',
    scen,
    '',
    ...(r.review
      ? ['## Independent review', '', `- Critic verdict: ${r.review.approved ? 'approved' : 'changes requested'} · findings: ${r.review.findings}${r.review.critical ? ' · **critical finding raised**' : ''}`, '']
      : []),
    '## Delivery',
    '',
    `- Status: \`${r.delivery.status}\``,
    r.delivery.pushConfirmedAt
      ? `- Push approved by a human at ${r.delivery.pushConfirmedAt}`
      : '- Push: **not approved** (the human push gate was never satisfied)',
    '',
    ...(r.passport
      ? [
          '## Cryptographic anchor (Build Passport)',
          '',
          'The facts above are anchored by an Ed25519-signed Build Passport. Anyone holding the',
          'publisher public key (GET `/sessions/:id/passport`) can verify it offline:',
          '',
          '```json',
          JSON.stringify(r.passport, null, 2),
          '```',
          '',
        ]
      : []),
    '---',
    '',
    `*${r.disclaimer}*`,
    '',
  ].join('\n')
}
