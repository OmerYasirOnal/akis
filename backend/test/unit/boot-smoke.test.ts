import { describe, it, expect, vi } from 'vitest'
import { runBootSmoke, deriveAssetChecks, type BootResult, type ProbeResponse } from '../../src/verify/bootSmoke.js'
import { createBootSmokeRunner } from '../../src/verify/TestRunner.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

// A previewable (vite) file set and an unsupported (pure DB infra, no runnable surface) one.
const VITE_FILES: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'x', devDependencies: { vite: '^5' } }) },
  { filePath: 'index.html', content: '<!doctype html><div id="app"></div>' },
]
const UNSUPPORTED_FILES: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'db', dependencies: { pg: '^8' } }) },
]

/** A fake boot that succeeds with a fixed URL + a spy teardown. */
function okBoot(url = 'http://127.0.0.1:9999'): { boot: () => Promise<BootResult>; teardown: ReturnType<typeof vi.fn> } {
  const teardown = vi.fn(async () => {})
  return { boot: async () => ({ url, teardown }), teardown }
}

/** A fetch fake that returns a fixed response for every URL. */
const constFetch = (res: ProbeResponse) => async (): Promise<ProbeResponse> => res

const OK_RES: ProbeResponse = { status: 200, body: '<html>hello world</html>' }

describe('runBootSmoke', () => {
  it('(a) happy path: 1 smoke + N criteria probes → passed, correct testsRun, STRUCTURED evidence', async () => {
    const { boot, teardown } = okBoot()
    // Each `Given` starts a new criterion → 2 derived probes (render + bodyContains).
    const spec = { title: 'T', body: ['Given the app When I open it Then the page renders', 'Given the page When it loads Then it shows "hello world"'].join('\n') }
    const res = await runBootSmoke(VITE_FILES, { boot, spec, sessionId: 's1', fetchImpl: constFetch(OK_RES) })
    expect(res.passed).toBe(true)
    expect(res.testsRun).toBe(3) // smoke + 2 derived probes
    expect(res.e2e.testsRun).toBe(3)
    expect(res.e2e.expected).toBe(3)
    expect(res.e2e.unexpected).toBe(0)
    // Probes are recorded as STRUCTURED e2e scenarios (names + pass), never prose.
    expect(res.e2eScenarios).toHaveLength(3)
    expect(res.e2eScenarios.every(s => s.passed && typeof s.name === 'string')).toBe(true)
    expect(teardown).toHaveBeenCalledTimes(1) // always torn down after a successful boot
  })

  it('(b) boot FAILURE → testsRun 0, not passed, and NO teardown (nothing booted)', async () => {
    const teardown = vi.fn(async () => {})
    const boot = async (): Promise<BootResult> => ({ failed: 'install failed (code 1)' })
    const res = await runBootSmoke(VITE_FILES, { boot, sessionId: 's2', fetchImpl: constFetch(OK_RES) })
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
    expect(res.e2eScenarios.some(s => /boot failed/i.test(s.outcome ?? ''))).toBe(true)
    expect(teardown).not.toHaveBeenCalled()
  })

  it('(b2) boot SUCCEEDS then a probe THROWS → fail-closed but teardown STILL runs', async () => {
    const { boot, teardown } = okBoot()
    const fetchImpl = async (): Promise<ProbeResponse> => { throw new Error('socket hangup') }
    const res = await runBootSmoke(VITE_FILES, { boot, sessionId: 's3', fetchImpl })
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('(c) unsupported app type → fail-closed (no boot attempted)', async () => {
    const { boot } = okBoot()
    const bootSpy = vi.fn(boot)
    const res = await runBootSmoke(UNSUPPORTED_FILES, { boot: bootSpy, sessionId: 's4', fetchImpl: constFetch(OK_RES) })
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
    expect(bootSpy).not.toHaveBeenCalled()
    expect(res.e2eScenarios.some(s => /unsupported/i.test(s.outcome ?? ''))).toBe(true)
  })

  it('(d) a failing probe (5xx) → not passed, the failing scenario is structured', async () => {
    const { boot, teardown } = okBoot()
    const res = await runBootSmoke(VITE_FILES, { boot, sessionId: 's5', fetchImpl: constFetch({ status: 500, body: '' }) })
    expect(res.passed).toBe(false)
    expect(res.e2e.unexpected).toBeGreaterThanOrEqual(1)
    expect(res.e2eScenarios.some(s => !s.passed && /status 500/.test(s.outcome ?? ''))).toBe(true)
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('(d2) a missing literal → that probe fails closed (not a vacuous pass)', async () => {
    const { boot } = okBoot()
    const spec = { title: 'T', body: 'Then it shows "ABSENT TEXT"' }
    const res = await runBootSmoke(VITE_FILES, { boot, spec, sessionId: 's6', fetchImpl: constFetch(OK_RES) })
    expect(res.passed).toBe(false)
    expect(res.e2eScenarios.some(s => !s.passed && /missing literal/.test(s.outcome ?? ''))).toBe(true)
  })

  it('(e) whole-run TIMEOUT → fail-closed AND teardown runs (booted then exceeded budget)', async () => {
    const { boot, teardown } = okBoot()
    // A fetch slower than the timeout: boot succeeds, the deadline fires first → fail-closed.
    const slowFetch = async (): Promise<ProbeResponse> => { await new Promise(r => setTimeout(r, 50)); return OK_RES }
    const res = await runBootSmoke(VITE_FILES, { boot, sessionId: 's7', fetchImpl: slowFetch, timeoutMs: 5 })
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
    expect(res.e2eScenarios.some(s => /timed out/i.test(s.outcome ?? ''))).toBe(true)
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('(f) the always-on smoke floor guarantees testsRun >= 1 on a probe-less spec', async () => {
    const { boot } = okBoot()
    // No spec → deriveChecks yields []; only the always-on smoke probe runs.
    const res = await runBootSmoke(VITE_FILES, { boot, sessionId: 's8', fetchImpl: constFetch(OK_RES) })
    expect(res.testsRun).toBe(1)
    expect(res.passed).toBe(true)
  })

  it('(f2) a skipped criterion does NOT count as a run test, but the smoke floor still holds', async () => {
    const { boot } = okBoot()
    const spec = { title: 'T', body: 'Given I am logged in When I wait Then everything feels fast' } // → skipped
    const res = await runBootSmoke(VITE_FILES, { boot, spec, sessionId: 's9', fetchImpl: constFetch(OK_RES) })
    expect(res.testsRun).toBe(1) // only the smoke probe ran; the skipped check is not a run test
    expect(res.e2e.skipped).toBe(1)
    expect(res.passed).toBe(true)
  })
})

describe('createBootSmokeRunner (brands in the trusted parent)', () => {
  it('brands a PASSING result over the exact files; testsRun reflects the run', async () => {
    const { boot } = okBoot()
    const runner = createBootSmokeRunner({ boot, sessionId: 's10', fetchImpl: constFetch(OK_RES) })
    const res = await runner.run(VITE_FILES)
    expect(res.passed).toBe(true)
    expect(res.testsRun).toBe(1) // smoke floor, no spec
    expect(res.codeDigest).toBeTruthy()
    expect(res.evidenceDigest).toBeTruthy()
  })

  it('fail-closed: a non-pass ZEROES testsRun (so it can never mint a VerifyToken)', async () => {
    const boot = async (): Promise<BootResult> => ({ failed: 'boot died' })
    const runner = createBootSmokeRunner({ boot, sessionId: 's11', fetchImpl: constFetch(OK_RES) })
    const res = await runner.run(VITE_FILES)
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
  })

  it('forwards the structured evidence to the onEvidence sink (additive, non-gate)', async () => {
    const { boot } = okBoot()
    const onEvidence = vi.fn()
    await createBootSmokeRunner({ boot, sessionId: 's12', fetchImpl: constFetch(OK_RES) }).run(VITE_FILES, { onEvidence })
    expect(onEvidence).toHaveBeenCalledTimes(1)
    const ev = onEvidence.mock.calls[0]![0]
    expect(ev.testsRun).toBe(1)
    expect(ev.scenarios.every((s: { suite: string }) => s.suite === 'e2e')).toBe(true)
  })

  it('a 404 front door FAILS the smoke probe — "verified" never over-claims on a missing route (PR #94 review)', async () => {
    const { boot, teardown } = okBoot()
    // A node-service with no `/` route: 404 + a NON-EMPTY error body. Under a <500 rule
    // this would have "passed" — the exact false-pass the review flagged.
    const res = await runBootSmoke(VITE_FILES, { boot, sessionId: 's13', fetchImpl: constFetch({ status: 404, body: 'Cannot GET /' }) })
    expect(res.passed).toBe(false)
    expect(res.e2eScenarios[0]).toMatchObject({ passed: false, outcome: 'status 404' })
    // …while a redirecting app (3xx) still counts as serving.
    const res2 = await runBootSmoke(VITE_FILES, { boot, sessionId: 's13', fetchImpl: constFetch({ status: 302, body: 'redirect' }) })
    expect(res2.passed).toBe(true)
    expect(teardown).toHaveBeenCalledTimes(2)
  })

  it('a boot that NEVER settles cannot wedge the verifier: the deadline returns fail-closed promptly (PR #94 review)', async () => {
    const hangingBoot = (): Promise<BootResult> => new Promise<BootResult>(() => { /* never resolves */ })
    const started = Date.now()
    const res = await runBootSmoke(VITE_FILES, { boot: hangingBoot, sessionId: 's14', timeoutMs: 150, fetchImpl: constFetch(OK_RES) })
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
    // The finally's grace is 1s — the call returns in ~timeout+grace, NOT forever.
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('asset probes (Phase E: multi-file apps verify their own references)', () => {
  const MULTI: RepoFile[] = [
    { filePath: 'index.html', content: '<!doctype html><link rel="stylesheet" href="./styles.css"><script src="./app.js" defer></script><script src="https://cdn.example/lib.js"></script><div id="app"></div>' },
    { filePath: 'styles.css', content: 'body{}' },
    { filePath: 'app.js', content: 'window.app = 1' },
  ]

  it('derives one pathStatus probe per LOCAL src/href (never CDN/data/anchor), deduped + bounded', () => {
    const checks = deriveAssetChecks(MULTI)
    expect(checks.map(c => c.kind === 'pathStatus' ? c.path : c.kind)).toEqual(['/styles.css', '/app.js'])
    expect(deriveAssetChecks([{ filePath: 'server.js', content: 'no html' }])).toEqual([])
  })

  it('a MISSING referenced asset fails the run honestly (404) — a blank page can never be "verified"', async () => {
    const { boot, teardown } = okBoot()
    // The served index.html references ./app.js, but the "server" 404s it (file never emitted).
    const fetchImpl = async (url: string): Promise<ProbeResponse> =>
      url.endsWith('/app.js') ? { status: 404, body: 'not found' } : OK_RES
    const res = await runBootSmoke(MULTI, { boot, sessionId: 's20', fetchImpl })
    expect(res.passed).toBe(false)
    expect(res.e2eScenarios.find(s => s.name.includes('/app.js'))).toMatchObject({ passed: false, outcome: 'status 404' })
    expect(teardown).toHaveBeenCalledTimes(1)
    // All assets served → the same app passes (smoke + 2 assets = 3 genuine probes).
    const ok = await runBootSmoke(MULTI, { boot, sessionId: 's20', fetchImpl: constFetch(OK_RES) })
    expect(ok.passed).toBe(true)
    expect(ok.testsRun).toBe(3)
  })
})
