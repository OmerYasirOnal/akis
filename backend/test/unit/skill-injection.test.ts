/**
 * P3-AGENT-1 — selected skills are injected into the core producers' system prompts.
 *
 * buildServices resolves a workflow's per-agent skill NAMES against the loaded skill
 * registry and folds their text onto each producer's BASE prompt (buildSystemPrompt).
 * These tests drive the REAL buildServices wiring through a recording provider so the
 * exact `system` string each agent sends is observable.
 *
 *  - a selected skill's text is present in that agent's composed system prompt;
 *  - NO selected skills ⇒ the system prompt is BYTE-IDENTICAL to the base (parity);
 *  - per-agent selection is honored: Scribe's skill never leaks into Proto's prompt.
 */
import { describe, it, expect } from 'vitest'
import { buildServices } from '../../src/di/services.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { SCRIBE_SYSTEM } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { PROTO_SYSTEM } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { mintApprovedSpec } from '../../src/gates/specGate.js'
import { initialSession } from '@akis/shared'
import { approveSpec } from '../helpers/tokens.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

/** A provider that records every system prompt it is asked to chat with. */
function recordingProvider(): LlmProvider & { systems: string[] } {
  const systems: string[] = []
  return {
    name: 'rec', model: 'rec', systems,
    async chat(req: ChatRequest): Promise<ChatResult> {
      systems.push(req.system)
      // Valid spec AND valid files so both Scribe and Proto parse successfully.
      return { text: '{"kind":"spec","title":"T","body":"# T","files":[{"filePath":"index.html","content":"<x>"}]}' }
    },
  }
}

const APPROVED = (() => {
  const spec = { title: 't', body: 'b' }
  const session = { ...initialSession('s1', 'i'), spec, approval: approveSpec(spec) }
  return mintApprovedSpec(session)
})()

function build(agentSkills?: Record<string, string[]>): { provider: ReturnType<typeof recordingProvider>; services: ReturnType<typeof buildServices> } {
  const provider = recordingProvider()
  const services = buildServices({
    store: new MockSessionStore(),
    skillsDir,
    provider,
    ...(agentSkills ? { agentSkills } : {}),
  })
  return { provider, services }
}

describe('P3-AGENT-1: skill injection wiring (buildServices)', () => {
  it('a selected Scribe skill is present in Scribe\'s composed system prompt', async () => {
    const { provider, services } = build({ scribe: ['web-app-spec'] })
    await services.scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    expect(provider.systems).toHaveLength(1)
    const sys = provider.systems[0]!
    expect(sys.startsWith(SCRIBE_SYSTEM)).toBe(true)
    expect(sys).toContain('# Injected skills')
    expect(sys).toContain('## Skill: web-app-spec')
  })

  it('a selected Proto skill is present in Proto\'s composed system prompt', async () => {
    const { provider, services } = build({ proto: ['react-spa-scaffold'] })
    await services.proto.run({ sessionId: 's1', laneId: 'main', approved: APPROVED })
    const sys = provider.systems[0]!
    expect(sys.startsWith(PROTO_SYSTEM)).toBe(true)
    expect(sys).toContain('## Skill: react-spa-scaffold')
  })

  it('NO skills selected ⇒ Scribe + Proto prompts are BYTE-IDENTICAL to the base (parity)', async () => {
    const { provider, services } = build() // no agentSkills at all
    await services.scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    await services.proto.run({ sessionId: 's1', laneId: 'main', approved: APPROVED })
    expect(provider.systems[0]).toBe(SCRIBE_SYSTEM)
    expect(provider.systems[1]).toBe(PROTO_SYSTEM)
  })

  it('an EMPTY skill list ⇒ byte-identical base (parity; no "# Injected skills" header)', async () => {
    const { provider, services } = build({ scribe: [] })
    await services.scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    expect(provider.systems[0]).toBe(SCRIBE_SYSTEM)
  })

  it('an UNKNOWN skill name is dropped (never a throw) ⇒ byte-identical base (parity)', async () => {
    const { provider, services } = build({ scribe: ['does-not-exist'] })
    await services.scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    expect(provider.systems[0]).toBe(SCRIBE_SYSTEM)
  })

  it('per-agent selection is honored: Scribe\'s skill does NOT leak into Proto\'s prompt', async () => {
    const { provider, services } = build({ scribe: ['web-app-spec'] })
    await services.scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    await services.proto.run({ sessionId: 's1', laneId: 'main', approved: APPROVED })
    const scribeSys = provider.systems[0]!
    const protoSys = provider.systems[1]!
    expect(scribeSys).toContain('## Skill: web-app-spec')
    // Proto got NO skills selected ⇒ its prompt is the unchanged base, with no leak.
    expect(protoSys).toBe(PROTO_SYSTEM)
    expect(protoSys).not.toContain('web-app-spec')
  })
})
