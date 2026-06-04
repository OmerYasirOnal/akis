import { describe, it, expect } from 'vitest'
import { backendRequirementGap } from '../../src/orchestrator/backendRequirement.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'
import type { ChatRequest, ChatResult, LlmProvider } from '../../src/agent/LlmProvider.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

const STATIC: RepoFile[] = [{ filePath: 'index.html', content: '<html>login form simulated</html>' }]
const NODE_SERVICE: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'x', main: 'server.js' }) },
  { filePath: 'server.js', content: 'require("node:http").createServer(() => {}).listen(process.env.PORT)' },
]

describe('backendRequirementGap (the live-caught Potemkin-backend guard)', () => {
  it('flags a STATIC emission when the spec explicitly demands accounts/backend', () => {
    const spec = { title: 'Team voting', body: 'Users sign up and log in; real backend with user accounts.' }
    expect(backendRequirementGap(spec, STATIC)).toMatch(/BACKEND REQUIRED BUT MISSING/)
  })
  it('passes a node-service emission for the same spec', () => {
    const spec = { title: 'Team voting', body: 'Users sign up and log in; real backend.' }
    expect(backendRequirementGap(spec, NODE_SERVICE)).toBeUndefined()
  })
  it('never blocks a legitimately client-only spec (no explicit backend demand)', () => {
    const spec = { title: 'QR generator', body: 'A single-page QR code generator for users.' }
    expect(backendRequirementGap(spec, STATIC)).toBeUndefined()
  })
  it('ignores demands inside "Out of scope" / "Non-goals" sections (the mock-spec false positive)', () => {
    const spec = { title: 'Todo app', body: '# Todo\n\n## Acceptance criteria\n- core action works\n\n## Out of scope\n- Authentication, deployment.' }
    expect(backendRequirementGap(spec, STATIC)).toBeUndefined()
    // …but an IN-SCOPE demand above the section still flags.
    const spec2 = { title: 'Voting', body: 'Users sign up and log in.\n\n## Out of scope\n- deployment.' }
    expect(backendRequirementGap(spec2, STATIC)).toMatch(/BACKEND REQUIRED/)
  })
})

describe('Orchestrator — the guard drives the iterate loop (tighten-only)', () => {
  /** Scribe reply 1 (spec demanding a backend), then Proto replies: static FIRST (the
   *  Potemkin miss), node-service SECOND (after the gap feedback). */
  function scriptedProvider(): LlmProvider & { protoPrompts: string[] } {
    const protoPrompts: string[] = []
    let protoCalls = 0
    return {
      name: 'fake', model: 'fake', protoPrompts,
      async chat(req: ChatRequest): Promise<ChatResult> {
        const user = req.messages[0]?.content ?? ''
        if (user.startsWith('SPEC:')) {
          protoPrompts.push(user)
          protoCalls++
          return protoCalls === 1
            ? { text: JSON.stringify({ files: STATIC }) }
            : { text: JSON.stringify({ files: NODE_SERVICE }) }
        }
        // Scribe: a spec that EXPLICITLY demands accounts + a real backend.
        return { text: JSON.stringify({ kind: 'spec', title: 'Team voting app', body: 'Users sign up and log in with email+password. Real backend with user accounts required.' }) }
      },
    }
  }

  it('a static emission against a backend-demanding spec ITERATES with the gap feedback, then the node-service emission ships', async () => {
    const store = new MockSessionStore()
    const provider = scriptedProvider()
    const services = buildServices({
      store, skillsDir, provider, mockCriticScore: 90,
      testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'team voting app with accounts' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const after = (await store.get(s.id))!
    // The SHIPPED code is the node-service (round 2), never the Potemkin static app.
    const paths = (after.code?.files ?? []).map(f => f.filePath)
    expect(paths).toContain('server.js')
    expect(paths).toContain('package.json')
    // Proto was called twice; the second prompt carried the ACTIONABLE gap feedback.
    expect(provider.protoPrompts.length).toBe(2)
    expect(provider.protoPrompts[1]).toMatch(/BACKEND REQUIRED BUT MISSING/)
  })
})
