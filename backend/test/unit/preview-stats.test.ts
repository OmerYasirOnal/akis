import { describe, it, expect } from 'vitest'
import { generateFeature } from '../../src/bdd/featureGen.js'
import { parseCucumberMessages } from '../../src/bdd/messageStats.js'
import { parsePlaywrightReport } from '../../src/e2e/playwrightStats.js'

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
