import { describe, it, expect } from 'vitest'
import { deriveChecks } from '../../src/verify/criteria.js'

/**
 * deriveChecks maps acceptance criteria → MECHANICAL boot-smoke checks (PURE). It only decides
 * WHICH probes to run — it is upstream of the fail-closed mint and can never relax the gate.
 */
describe('deriveChecks', () => {
  it('happy path: maps render / literal / explicit-path criteria to their mechanical checks', () => {
    // Each `Given` starts a new scenario (the parseScenarios contract), so these are 3 criteria.
    const body = [
      'Given the app is running When I open the home page Then the page renders',
      'Given the home page When it loads Then the page shows "Welcome back"',
      'Given a request When I GET /about Then the about page loads',
    ].join('\n')
    const checks = deriveChecks({ title: 'X', body })
    expect(checks).toEqual([
      { kind: 'render', name: expect.any(String), path: '/' },
      { kind: 'bodyContains', name: expect.any(String), path: '/', literal: 'Welcome back' },
      { kind: 'pathStatus', name: expect.any(String), path: '/about' },
    ])
  })

  it('a quoted literal WINS over the generic "renders" verb (most specific signal)', () => {
    const checks = deriveChecks({ title: 'X', body: 'Given the page When it renders Then it shows the text "Total: 42"' })
    expect(checks).toEqual([{ kind: 'bodyContains', name: expect.any(String), path: '/', literal: 'Total: 42' }])
  })

  it('skips a criterion with no derivable mechanical check (bounded reason)', () => {
    const body = 'Given I am logged in When I wait a while Then everything feels fast'
    const checks = deriveChecks({ title: 'X', body })
    expect(checks).toEqual([{ kind: 'skipped', name: expect.any(String), reason: 'no mechanical check derivable' }])
  })

  it('empty / criterion-less spec → no checks (the runner adds its own smoke floor)', () => {
    expect(deriveChecks({ title: 'X', body: 'just a paragraph, no Given/When/Then here' })).toEqual([])
    expect(deriveChecks({ title: 'X', body: '' })).toEqual([])
    expect(deriveChecks(undefined)).toEqual([])
  })

  it('bounds the check name to 60 chars', () => {
    const long = 'a'.repeat(200)
    const checks = deriveChecks({ title: 'X', body: `Given the page renders ${long}` })
    expect(checks[0]!.name.length).toBeLessThanOrEqual(60)
  })
})
