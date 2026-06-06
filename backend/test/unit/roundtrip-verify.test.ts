import { describe, it, expect, vi } from 'vitest'
import { runBootSmoke, deriveRoundTripChecks, type BootResult, type ProbeResponse, type ProbeInit } from '../../src/verify/bootSmoke.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

/**
 * Move 2 — BEHAVIORAL round-trip verification. `verified` must mean more than "the app served a
 * GET": for a node-service app with an /api path, Trace POSTs a marker then GETs it back and passes
 * ONLY if the write persisted (catches the "Potemkin backend"). CONSERVATIVE: a non-2xx POST (we
 * couldn't form a valid write) self-skips — a healthy app is NEVER false-RED'd. Flag-gated
 * (roundTrip) so the default boot is byte-identical. The mint path is untouched (additive probe).
 */
const NODE_SERVICE_FILES: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'api', main: 'server.js' }) },
  { filePath: 'server.js', content: 'require("http").createServer((req,res)=>res.end("[]")).listen(3000)' },
]
const VITE_FILES: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'x', devDependencies: { vite: '^5' } }) },
  { filePath: 'index.html', content: '<!doctype html><div id="app">hello</div>' },
]
const API_SPEC = { title: 'Todos API', body: 'Given the API When I POST to /api/todos Then GET /api/todos returns it' }

function okBoot(): { boot: () => Promise<BootResult>; teardown: ReturnType<typeof vi.fn> } {
  const teardown = vi.fn(async () => {})
  return { boot: async () => ({ url: 'http://127.0.0.1:9999', teardown }), teardown }
}

/** A stateful fake API: GET returns the store; POST optionally appends the posted payload (which
 *  carries the probe's unique marker). `persist:false` models a Potemkin backend (accepts the write
 *  but stores nothing); `postStatus` lets a strict API reject the synthetic body. */
function fakeApi(opts: { persist?: boolean; postStatus?: number } = {}) {
  let store = ''
  return async (_url: string, init?: ProbeInit): Promise<ProbeResponse> => {
    if (init?.method === 'POST') {
      const status = opts.postStatus ?? 201
      if (status >= 200 && status < 300 && opts.persist) store += init.body ?? ''
      return { status, body: '{}' }
    }
    return { status: 200, body: store ? `[${store}]` : '[]' }
  }
}

describe('deriveRoundTripChecks (pure spec scan)', () => {
  it('derives one round-trip check per distinct /api path the spec names', () => {
    const checks = deriveRoundTripChecks({ title: 'T', body: 'POST /api/todos and also GET /api/notes' })
    expect(checks.map(c => c.kind)).toEqual(['roundTrip', 'roundTrip'])
    expect(checks.map(c => (c as { path: string }).path)).toEqual(['/api/todos', '/api/notes'])
  })
  it('dedupes a repeated path and yields NOTHING when no /api path is named (conservative)', () => {
    expect(deriveRoundTripChecks({ title: 'T', body: 'use /api/x then /api/x again' })).toHaveLength(1)
    expect(deriveRoundTripChecks({ title: 'T', body: 'a plain static page that renders' })).toEqual([])
    expect(deriveRoundTripChecks(undefined)).toEqual([])
  })
})

describe('round-trip behavioral probe via runBootSmoke', () => {
  it('PERSISTS: POST→GET reflects the marker → the round-trip is a genuine extra passing test', async () => {
    const { boot } = okBoot()
    const res = await runBootSmoke(NODE_SERVICE_FILES, { boot, spec: API_SPEC, sessionId: 's', roundTrip: true, fetchImpl: fakeApi({ persist: true }) })
    expect(res.passed).toBe(true)
    expect(res.e2eScenarios.some(s => s.name.startsWith('round-trip') && s.passed)).toBe(true)
    expect(res.testsRun).toBeGreaterThanOrEqual(2) // smoke + the round-trip both ran
  })

  it('POTEMKIN: POST 201 but GET never reflects it → the run FAILS (no token can mint)', async () => {
    const { boot } = okBoot()
    const res = await runBootSmoke(NODE_SERVICE_FILES, { boot, spec: API_SPEC, sessionId: 's', roundTrip: true, fetchImpl: fakeApi({ persist: false }) })
    expect(res.passed).toBe(false)
    expect(res.e2eScenarios.some(s => s.name.startsWith('round-trip') && !s.passed && s.outcome === 'not persisted')).toBe(true)
  })

  it('CONSERVATIVE: a strict API that 400s the synthetic POST SKIPS the round-trip — never false-RED', async () => {
    const { boot } = okBoot()
    const res = await runBootSmoke(NODE_SERVICE_FILES, { boot, spec: API_SPEC, sessionId: 's', roundTrip: true, fetchImpl: fakeApi({ postStatus: 400 }) })
    expect(res.passed).toBe(true) // the smoke probe still passes; the round-trip is skipped, not failed
    expect(res.e2eScenarios.some(s => s.name.startsWith('round-trip') && s.outcome === 'skipped')).toBe(true)
  })

  it('DEFAULT OFF: without the flag, no round-trip check is added (byte-identical boot)', async () => {
    const { boot } = okBoot()
    const res = await runBootSmoke(NODE_SERVICE_FILES, { boot, spec: API_SPEC, sessionId: 's', fetchImpl: fakeApi({ persist: true }) })
    expect(res.e2eScenarios.some(s => s.name.startsWith('round-trip'))).toBe(false)
  })

  it('GATED to node-service: a static/vite app gets NO round-trip even with the flag + an /api path', async () => {
    const { boot } = okBoot()
    const res = await runBootSmoke(VITE_FILES, { boot, spec: API_SPEC, sessionId: 's', roundTrip: true, fetchImpl: fakeApi({ persist: true }) })
    expect(res.e2eScenarios.some(s => s.name.startsWith('round-trip'))).toBe(false)
  })
})
