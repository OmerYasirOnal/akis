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

  /**
   * IMPOSSIBLE-PROBE literals (the live "missing literal" failure class): a client-rendered
   * app injects typed/listed content via JS, so the SERVED `/` body can never contain it —
   * asserting it is an impossible probe, not a real verification. Such criteria fall through
   * to the next derivable signal (path → render → skipped) — never to a pass.
   */
  it('a literal the user TYPES is not asserted on the body — falls through to render', () => {
    const body = 'Given an empty task list When I type "Kahvaltı yap" in the input Then the task "Kahvaltı yap" appears in the list'
    const checks = deriveChecks({ title: 'X', body })
    expect(checks).toEqual([{ kind: 'render', name: expect.any(String), path: '/' }])
  })

  it('a literal naming a dynamic data item (task/note/item "X") is not asserted on the body', () => {
    const body = 'Given a task "Kahvaltı yap" in the list When I click its checkbox Then it is shown with a strikethrough'
    const checks = deriveChecks({ title: 'X', body })
    // No impossible bodyContains probe; no active render verb either → honest skip.
    expect(checks).toEqual([{ kind: 'skipped', name: expect.any(String), reason: 'no mechanical check derivable' }])
  })

  it('a literal offered as an ALTERNATIVE (icon or "Sil" button) is not asserted on the body', () => {
    // "trash icon or \"Sil\" button" — the spec allows EITHER; a substring assertion on one
    // branch of an or-alternation is not a faithful mechanical reduction of the criterion.
    const body = 'Given a task in the list When I click the delete button (trash icon or "Sil" button) next to it Then the task is removed'
    const checks = deriveChecks({ title: 'X', body })
    expect(checks).toEqual([{ kind: 'skipped', name: expect.any(String), reason: 'no mechanical check derivable' }])
  })

  it('a dynamic-data criterion with no render verb either → skipped (never an impossible probe)', () => {
    const body = 'Given a task "Kahvaltı yap" in the list When I click the delete button Then the task "Kahvaltı yap" is removed'
    const checks = deriveChecks({ title: 'X', body })
    expect(checks).toEqual([{ kind: 'skipped', name: expect.any(String), reason: 'no mechanical check derivable' }])
  })

  it('a static CHROME literal (a clicked button label) is still asserted on the body', () => {
    const body = 'Given the form When I click "Ekle" button with empty input Then nothing is added'
    const checks = deriveChecks({ title: 'X', body })
    expect(checks).toEqual([{ kind: 'bodyContains', name: expect.any(String), path: '/', literal: 'Ekle' }])
  })

  it('bounds the check name to 60 chars', () => {
    const long = 'a'.repeat(200)
    const checks = deriveChecks({ title: 'X', body: `Given the page renders ${long}` })
    expect(checks[0]!.name.length).toBeLessThanOrEqual(60)
  })
})

describe('criteria: a DevTools/fetch code-call literal is not a bodyContains (false-RED guard, caught live)', () => {
  it('skips the JS-call literal and falls through to the /api path check, never a bodyContains', () => {
    const spec = { title: 'Notes', body: "- Given the page has loaded, When I open browser DevTools and call `fetch('/api/notes')`, Then I receive JSON" }
    const checks = deriveChecks(spec)
    // The inner '/api/notes' must NOT become a bodyContains the served HTML can never contain
    // (the false-RED). With no statically-assertable literal, it falls through to the render
    // signal ('page has loaded') — a probe a genuinely-served app PASSES, not a wrong-reason fail.
    expect(checks.some(c => c.kind === 'bodyContains')).toBe(false)
    expect(checks.every(c => c.kind === 'render' || c.kind === 'skipped' || c.kind === 'pathStatus')).toBe(true)
  })
})

describe('criteria: an auth-protected-route criterion is skipped, not a pathStatus (false-RED fix)', () => {
  it('a "401 without logging in" criterion does NOT become a pathStatus that 401 would false-fail', () => {
    const checks = deriveChecks({ title: 'T', body: '- Given a user, When I GET /api/secret without logging in, Then I receive 401 unauthorized' })
    expect(checks.some(c => c.kind === 'pathStatus')).toBe(false)
    expect(checks.every(c => c.kind === 'skipped')).toBe(true)
  })
})

describe('criteria: tightened AUTH_SIGNAL keeps coverage on benign page copy (gate-keeper note)', () => {
  it('a bare "403"/"unauthorized" as page TEXT is NOT treated as an auth route (keeps its probe)', () => {
    const checks = deriveChecks({ title: 'T', body: '- Given the error page, When it loads, Then it shows "403 Forbidden" and the page renders' })
    // No strong unauth phrase ⇒ not skipped-as-auth; it still derives a real check (render/bodyContains).
    expect(checks.every(c => c.kind === 'skipped')).toBe(false)
  })
})
