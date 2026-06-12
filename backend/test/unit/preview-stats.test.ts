import { describe, it, expect } from 'vitest'
import { generateFeature } from '../../src/bdd/featureGen.js'
import { parseCucumberMessages, parseCucumberScenarios } from '../../src/bdd/messageStats.js'
import { parsePlaywrightReport, parsePlaywrightScenarios } from '../../src/e2e/playwrightStats.js'
import { buildTestEvidence } from '../../src/verify/evidence.js'

describe('generateFeature', () => {
  it('turns Given/When/Then acceptance criteria into scenarios', () => {
    const body = [
      '## Acceptance criteria',
      '- Given the list is empty When I add "milk" Then it appears',
      'Given a todo exists',
      'When I check it',
      'Then it is marked done',
    ].join('\n')
    const feature = generateFeature({ title: 'Todo app', body })
    expect(feature).toContain('Feature: Todo app')
    expect((feature.match(/Scenario:/g) ?? []).length).toBe(2)
    expect(feature).toContain('Given the list is empty')
    expect(feature).toContain('Then it is marked done')
  })
  it('falls back to a smoke scenario when there are no G/W/T', () => {
    const feature = generateFeature({ title: 'X', body: 'no criteria here' })
    expect((feature.match(/Scenario:/g) ?? []).length).toBe(1)
    expect(feature).toContain('Given the app is running')
  })
})

describe('parseCucumberMessages', () => {
  const env = (o: object): string => JSON.stringify(o)
  it('counts built/run/passed/failed from message NDJSON', () => {
    const nd = [
      env({ pickle: { id: 'p1' } }),
      env({ pickle: { id: 'p2' } }),
      env({ testCaseStarted: { id: 'tc1' } }),
      env({ testStepFinished: { testCaseStartedId: 'tc1', testStepResult: { status: 'PASSED', duration: { seconds: 0, nanos: 5_000_000 } } } }),
      env({ testCaseFinished: { testCaseStartedId: 'tc1' } }),
      env({ testCaseStarted: { id: 'tc2' } }),
      env({ testStepFinished: { testCaseStartedId: 'tc2', testStepResult: { status: 'FAILED' } } }),
      env({ testCaseFinished: { testCaseStartedId: 'tc2' } }),
    ].join('\n')
    const s = parseCucumberMessages(nd)
    expect(s.built).toBe(2)
    expect(s.run).toBe(2)
    expect(s.passed).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.durationMs).toBe(5)
  })
  it('ignores malformed lines (partial stream)', () => {
    const s = parseCucumberMessages('{bad json\n' + JSON.stringify({ pickle: {} }))
    expect(s.built).toBe(1)
  })
})

describe('parsePlaywrightReport', () => {
  it('passes when expected>=1 and unexpected==0', () => {
    const s = parsePlaywrightReport(JSON.stringify({ stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 1, duration: 1234.7 } }))
    expect(s.testsRun).toBe(3)
    expect(s.passed).toBe(true)
    expect(s.durationMs).toBe(1235)
  })
  it('fails when any unexpected', () => {
    const s = parsePlaywrightReport(JSON.stringify({ stats: { expected: 2, unexpected: 1, flaky: 0 } }))
    expect(s.testsRun).toBe(3)
    expect(s.passed).toBe(false)
  })
  it('fail-closed on garbage / missing stats', () => {
    expect(parsePlaywrightReport('not json').passed).toBe(false)
    expect(parsePlaywrightReport('{}').testsRun).toBe(0)
    expect(parsePlaywrightReport(JSON.stringify({ stats: { expected: 0, unexpected: 0, flaky: 0 } })).passed).toBe(false)
  })
})

describe('parseCucumberScenarios (ADDITIVE per-scenario detail)', () => {
  const env = (o: object): string => JSON.stringify(o)
  it('resolves scenario NAMES via the pickle→testCase→testCaseStarted chain and marks failure with a structured reason', () => {
    const nd = [
      env({ pickle: { id: 'p1', name: 'user logs in' } }),
      env({ pickle: { id: 'p2', name: 'user logs out' } }),
      env({ testCase: { id: 'c1', pickleId: 'p1' } }),
      env({ testCase: { id: 'c2', pickleId: 'p2' } }),
      env({ testCaseStarted: { id: 'tc1', testCaseId: 'c1' } }),
      env({ testStepFinished: { testCaseStartedId: 'tc1', testStepResult: { status: 'PASSED' } } }),
      env({ testCaseFinished: { testCaseStartedId: 'tc1' } }),
      env({ testCaseStarted: { id: 'tc2', testCaseId: 'c2' } }),
      env({ testStepFinished: { testCaseStartedId: 'tc2', testStepResult: { status: 'FAILED' } } }),
      env({ testCaseFinished: { testCaseStartedId: 'tc2' } }),
    ].join('\n')
    const scs = parseCucumberScenarios(nd)
    expect(scs).toEqual([
      { name: 'user logs in', passed: true },
      { name: 'user logs out', passed: false, failedStatus: 'FAILED', failedStep: 'step reported FAILED' },
    ])
  })
  it('falls back to a stable name and tolerates partial/garbage streams', () => {
    const nd = ['{bad', env({ testCaseStarted: { id: 'tc9', testCaseId: 'missing' } }), env({ testStepFinished: { testCaseStartedId: 'tc9', testStepResult: { status: 'PASSED' } } }), env({ testCaseFinished: { testCaseStartedId: 'tc9' } })].join('\n')
    const scs = parseCucumberScenarios(nd)
    expect(scs).toHaveLength(1)
    expect(scs[0]!.passed).toBe(true)
    expect(typeof scs[0]!.name).toBe('string')
  })
  // P0-3a (review LOW) — a finished-but-all-SKIPPED scenario is UNMEASURED, not a hard failure. It
  // must carry the bounded reason 'skipped' (the SAME label the e2e/boot-smoke half uses) so the
  // shared summarizer counts it as unmeasured on the full-cucumber path. Without the stamp it had no
  // reason and was mis-reported as a hard failure.
  it('marks an all-SKIPPED scenario as UNMEASURED with reason "skipped" (not a hard failure)', () => {
    const nd = [
      env({ pickle: { id: 'p1', name: 'auth-gated route' } }),
      env({ testCase: { id: 'c1', pickleId: 'p1' } }),
      env({ testCaseStarted: { id: 'tc1', testCaseId: 'c1' } }),
      env({ testStepFinished: { testCaseStartedId: 'tc1', testStepResult: { status: 'SKIPPED' } } }),
      env({ testStepFinished: { testCaseStartedId: 'tc1', testStepResult: { status: 'SKIPPED' } } }),
      env({ testCaseFinished: { testCaseStartedId: 'tc1' } }),
    ].join('\n')
    const scs = parseCucumberScenarios(nd)
    expect(scs).toEqual([{ name: 'auth-gated route', passed: false, failedStatus: 'skipped', failedStep: 'all steps skipped' }])
  })
  it('a FAILED step still wins over a SKIPPED one (a partial-skip scenario is a hard failure, not unmeasured)', () => {
    const nd = [
      env({ pickle: { id: 'p1', name: 'mixed' } }),
      env({ testCase: { id: 'c1', pickleId: 'p1' } }),
      env({ testCaseStarted: { id: 'tc1', testCaseId: 'c1' } }),
      env({ testStepFinished: { testCaseStartedId: 'tc1', testStepResult: { status: 'FAILED' } } }),
      env({ testStepFinished: { testCaseStartedId: 'tc1', testStepResult: { status: 'SKIPPED' } } }),
      env({ testCaseFinished: { testCaseStartedId: 'tc1' } }),
    ].join('\n')
    const scs = parseCucumberScenarios(nd)
    expect(scs).toEqual([{ name: 'mixed', passed: false, failedStatus: 'FAILED', failedStep: 'step reported FAILED' }])
  })
})

describe('parsePlaywrightScenarios (ADDITIVE per-spec detail)', () => {
  it('walks nested suites/specs, recording titles + a bounded outcome on failure', () => {
    const report = JSON.stringify({
      stats: { expected: 1, unexpected: 1, flaky: 0 },
      suites: [
        { title: 'home', specs: [{ title: 'renders', ok: true, tests: [{ results: [{ status: 'passed' }] }] }] },
        { title: 'outer', suites: [{ title: 'inner', specs: [{ title: 'submits form', ok: false, tests: [{ results: [{ status: 'failed' }] }] }] }] },
      ],
    })
    expect(parsePlaywrightScenarios(report)).toEqual([
      { name: 'renders', passed: true },
      { name: 'submits form', passed: false, outcome: 'failed' },
    ])
  })
  it('returns [] on garbage / missing suites', () => {
    expect(parsePlaywrightScenarios('not json')).toEqual([])
    expect(parsePlaywrightScenarios('{}')).toEqual([])
  })
})

describe('buildTestEvidence', () => {
  const bdd = { built: 2, run: 2, passed: 1, failed: 1, skipped: 0, durationMs: 30 }
  const e2e = { testsRun: 1, passed: false, expected: 0, unexpected: 1, flaky: 0, skipped: 0, durationMs: 12 }
  it('combines counts + scenarios; a non-pass produces a STRUCTURED failure report', () => {
    const ev = buildTestEvidence({
      passed: false, bdd, e2e,
      bddScenarios: [{ name: 'a', passed: true }, { name: 'b', passed: false, failedStatus: 'FAILED', failedStep: 'step reported FAILED' }],
      e2eScenarios: [{ name: 'c', passed: false, outcome: 'unexpected' }],
    })
    expect(ev.testsRun).toBe(bdd.run + e2e.testsRun)
    expect(ev.durationMs).toBe(bdd.durationMs + e2e.durationMs)
    expect(ev.scenarios.map(s => s.suite)).toEqual(['bdd', 'bdd', 'e2e'])
    expect(ev.failure).toBeDefined()
    expect(ev.failure!.failedCount).toBe(2)
    expect(ev.failure!.scenarios.every(s => !s.passed)).toBe(true)
  })
  it('a passing run has NO failure report', () => {
    const ev = buildTestEvidence({
      passed: true,
      bdd: { built: 1, run: 1, passed: 1, failed: 0, skipped: 0, durationMs: 5 },
      e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
      bddScenarios: [{ name: 'a', passed: true }], e2eScenarios: [],
    })
    expect(ev.passed).toBe(true)
    expect(ev.failure).toBeUndefined()
  })
  it('a non-pass with NO per-scenario failure (all-skipped / zero tests) still carries a top-level reason — never an empty failure signal', () => {
    // All-skipped: a real failure (passed:false) with no captured failing scenario — the
    // self-repair loop / Trust Report must still get a non-empty signal.
    const allSkipped = buildTestEvidence({
      passed: false,
      bdd: { built: 1, run: 1, passed: 0, failed: 0, skipped: 1, durationMs: 9 },
      e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
      bddScenarios: [], e2eScenarios: [],
    })
    expect(allSkipped.failure).toBeDefined()
    expect(allSkipped.failure!.failedCount).toBe(0)
    expect(allSkipped.failure!.reason).toBeTruthy()
    // Zero tests executed → an explicit reason.
    const noTests = buildTestEvidence({
      passed: false,
      bdd: { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
      e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
      bddScenarios: [], e2eScenarios: [],
    })
    expect(noTests.failure!.reason).toContain('no tests')
  })
})
