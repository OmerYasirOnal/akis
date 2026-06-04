import { describe, it, expect } from 'vitest'
import { mergeFiles } from '../../src/orchestrator/mergeFiles.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { ProtoAgent } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { mintApprovedSpec } from '../../src/gates/specGate.js'
import { approveSpec } from '../helpers/tokens.js'
import { initialSession } from '@akis/shared'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { EventBus } from '../../src/events/bus.js'
import type { ChatRequest, ChatResult, LlmProvider } from '../../src/agent/LlmProvider.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

describe('mergeFiles (Phase B.5 edit-mode merge)', () => {
  const f = (filePath: string, content: string) => ({ filePath, content })

  it('no base → emitted files pass through unchanged (fresh build is byte-identical)', () => {
    const emitted = [f('index.html', 'a')]
    expect(mergeFiles(undefined, emitted)).toEqual(emitted)
    expect(mergeFiles([], emitted)).toEqual(emitted)
  })

  it('an emitted file EDITS its base counterpart in place; untouched base files survive', () => {
    const base = [f('index.html', 'old'), f('styles.css', 'css')]
    const out = mergeFiles(base, [f('index.html', 'new')])
    expect(out).toEqual([f('index.html', 'new'), f('styles.css', 'css')])
  })

  it('a genuinely new emitted file is appended after the base', () => {
    const base = [f('index.html', 'a')]
    const out = mergeFiles(base, [f('login.html', 'b')])
    expect(out).toEqual([f('index.html', 'a'), f('login.html', 'b')])
  })

  it('is pure: inputs are not mutated', () => {
    const base = [f('index.html', 'a')]
    const emitted = [f('index.html', 'b')]
    mergeFiles(base, emitted)
    expect(base[0]!.content).toBe('a')
    expect(emitted.length).toBe(1)
  })
})

describe('ProtoAgent — EDIT MODE prompt', () => {
  function bus(): EventBus {
    return { emit: () => {}, recent: () => [], subscribe: () => () => {} } as unknown as EventBus
  }
  function provider(reply: string): LlmProvider & { lastUser?: string } {
    const p: LlmProvider & { lastUser?: string } = {
      name: 'mock',
      model: 'mock-model',
      async chat(req: ChatRequest): Promise<ChatResult> {
        p.lastUser = req.messages[0]?.content ?? ''
        return { text: reply }
      },
    }
    return p
  }
  function approvedFor(): ReturnType<typeof mintApprovedSpec> {
    // The token is minted the legitimate way (approval authority), never fabricated.
    const spec = { title: 'T', body: 'B' }
    const session = { ...initialSession('s1', 'x'), spec, approval: approveSpec(spec) }
    return mintApprovedSpec(session)
  }

  it('renders the base files + edit rules into the user prompt when baseFiles is present', async () => {
    const p = provider('{"files":[{"filePath":"index.html","content":"edited"}]}')
    const proto = new ProtoAgent({ bus: bus(), provider: p })
    await proto.run({
      sessionId: 's1', laneId: 'main', approved: approvedFor(),
      baseFiles: [{ filePath: 'index.html', content: '<html>v1</html>' }],
    })
    expect(p.lastUser).toContain('EDIT MODE')
    expect(p.lastUser).toContain('--- index.html ---')
    expect(p.lastUser).toContain('<html>v1</html>')
    expect(p.lastUser).toContain('Return ONLY the files you CHANGE or ADD')
  })

  it('omits the edit-mode section on a fresh build (no baseFiles)', async () => {
    const p = provider('{"files":[{"filePath":"index.html","content":"x"}]}')
    const proto = new ProtoAgent({ bus: bus(), provider: p })
    await proto.run({ sessionId: 's1', laneId: 'main', approved: approvedFor() })
    expect(p.lastUser).not.toContain('EDIT MODE')
  })
})

describe('Orchestrator — edit-mode round-trip (base app survives a follow-up build)', () => {
  it('a session started with a base merges Proto output over it: untouched base files survive to the stored code', async () => {
    const store = new MockSessionStore()
    const services = buildServices({
      store, skillsDir, mockCriticScore: 90,
      testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    })
    const orch = new Orchestrator(services)
    const base = {
      files: [
        { filePath: 'keep-me.css', content: 'body{color:red}' },
        { filePath: 'index.html', content: '<html>v1</html>' },
      ],
      fromSession: 'prior-session',
    }
    const s = await orch.start({ idea: 'add a login page to the existing app', base })
    expect((await store.get(s.id))!.base?.fromSession).toBe('prior-session')
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const after = (await store.get(s.id))!
    const files = after.code?.files ?? []
    const paths = files.map(f => f.filePath)
    // The untouched base file SURVIVED the follow-up build (the whole point of B.5)...
    expect(paths).toContain('keep-me.css')
    expect(files.find(f => f.filePath === 'keep-me.css')!.content).toBe('body{color:red}')
    // ...and the merged app carries at least the base size (mock Proto's emission merged in).
    expect(files.length).toBeGreaterThanOrEqual(base.files.length)
  })
})
