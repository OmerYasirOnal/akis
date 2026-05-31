import { describe, it, expect } from 'vitest'
import { canUseTool } from '../../src/tools/permission.js'
import { initialSession } from '@akis/shared'

const base = initialSession('s1', 'idea')

describe('canUseTool — Gate 2 (producer≠verifier)', () => {
  it('only the verifier (trace) may run_tests', () => {
    expect(canUseTool('trace', 'run_tests', base).ok).toBe(true)
    for (const r of ['orchestrator', 'proto', 'scribe', 'critic'] as const) {
      const v = canUseTool(r, 'run_tests', base)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.reason).toMatch(/verifier/i)
    }
  })
})

describe('canUseTool — Gate 1 (spec approval)', () => {
  it('dispatch_proto denied until approvedSpec exists', () => {
    expect(canUseTool('orchestrator', 'dispatch_proto', base).ok).toBe(false)
    const approved = { ...base, approvedSpec: { title: 't', body: 'b' } }
    expect(canUseTool('orchestrator', 'dispatch_proto', approved).ok).toBe(true)
  })
})

describe('canUseTool — push needs a token (Gate 4 handoff)', () => {
  it('push_to_github denied without an ApprovedPush in ctx', () => {
    expect(canUseTool('orchestrator', 'push_to_github', base).ok).toBe(false)
  })
})
