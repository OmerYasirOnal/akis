import { describe, it, expect } from 'vitest'
import { CriticAgent } from '../../src/orchestrator/subagents/critic/CriticAgent.js'
import { buildSpecReviewSystemPrompt } from '../../src/orchestrator/subagents/critic/prompts/spec-review.js'
import { buildCodeReviewSystemPrompt } from '../../src/orchestrator/subagents/critic/prompts/code-review.js'
import type { Skill } from '../../src/skills/registry.js'

// Minimal fake generateText that returns a JSON review the CriticAgent parses.
const approvedJson = async () => JSON.stringify({
  approved: true, overallScore: 90, summary: 'ok', findings: [],
  reviewType: 'code_review', iteration: 1, hasCriticalFinding: false, maxSeverity: 'info',
})

/** A generateText that records every system prompt it is asked to review with, then
 *  returns a parseable approved review so the CriticAgent flow completes. */
function recordingGenerateText(): { fn: (s: string, u: string) => Promise<string>; systems: string[] } {
  const systems: string[] = []
  return {
    systems,
    fn: async (system: string): Promise<string> => {
      systems.push(system)
      return JSON.stringify({
        approved: true, overallScore: 90, summary: 'ok', findings: [],
        reviewType: 'code_review', iteration: 1, hasCriticalFinding: false, maxSeverity: 'info',
      })
    },
  }
}

const fakeCriticSkill: Skill = {
  name: 'security-review',
  description: 'd',
  appliesToRole: 'critic',
  triggers: [],
  status: 'draft',
  version: '0.0.0',
  body: 'CRITIC SKILL BODY',
}

describe('CriticAgent (ported)', () => {
  it('parses an approved code review', async () => {
    const critic = new CriticAgent({ generateText: approvedJson }, 75)
    const res = await critic.reviewCode({ reviewType: 'code_review', artifact: 'x', originalIdea: 'y', referenceSpec: { title: 't' } })
    expect(res.type).toBe('review')
    if (res.type === 'review') {
      expect(res.data.approved).toBe(true)
      expect(res.data.overallScore).toBe(90)
    }
  })

  it('derives maxSeverity + approval from a low-score review with a critical finding', async () => {
    const criticalJson = async () => JSON.stringify({
      overallScore: 40, summary: 'bad',
      findings: [{ severity: 'critical', category: 'security', description: 'd', suggestion: 's' }],
    })
    const critic = new CriticAgent({ generateText: criticalJson }, 75)
    const res = await critic.reviewCode({ reviewType: 'code_review', artifact: 'x', originalIdea: 'y', referenceSpec: {} })
    expect(res.type).toBe('review')
    if (res.type === 'review') {
      expect(res.data.approved).toBe(false)
      expect(res.data.hasCriticalFinding).toBe(true)
      expect(res.data.maxSeverity).toBe('critical')
    }
  })

  it('errors when reviewCode is missing referenceSpec', async () => {
    const critic = new CriticAgent({ generateText: approvedJson }, 75)
    const res = await critic.reviewCode({ reviewType: 'code_review', artifact: 'x', originalIdea: 'y' })
    expect(res.type).toBe('error')
  })
})

describe('CriticAgent — skill injection (P3-AGENT-1B)', () => {
  it('NO skills ⇒ the spec-review system prompt is BYTE-IDENTICAL to the base (parity)', async () => {
    const rec = recordingGenerateText()
    const critic = new CriticAgent({ generateText: rec.fn }, 75)
    await critic.reviewSpec({ reviewType: 'spec_review', artifact: 'x', originalIdea: 'y' })
    expect(rec.systems).toHaveLength(1)
    expect(rec.systems[0]).toBe(buildSpecReviewSystemPrompt(75))
  })

  it('NO skills ⇒ the code-review system prompt is BYTE-IDENTICAL to the base (parity)', async () => {
    const rec = recordingGenerateText()
    const critic = new CriticAgent({ generateText: rec.fn }, 75)
    await critic.reviewCode({ reviewType: 'code_review', artifact: 'x', originalIdea: 'y', referenceSpec: {} })
    expect(rec.systems).toHaveLength(1)
    expect(rec.systems[0]).toBe(buildCodeReviewSystemPrompt(75))
  })

  it('an EMPTY skill list ⇒ byte-identical base for BOTH prompts (no "# Injected skills" header)', async () => {
    const rec = recordingGenerateText()
    const critic = new CriticAgent({ generateText: rec.fn }, 75, [])
    await critic.reviewSpec({ reviewType: 'spec_review', artifact: 'x', originalIdea: 'y' })
    await critic.reviewCode({ reviewType: 'code_review', artifact: 'x', originalIdea: 'y', referenceSpec: {} })
    expect(rec.systems[0]).toBe(buildSpecReviewSystemPrompt(75))
    expect(rec.systems[1]).toBe(buildCodeReviewSystemPrompt(75))
    expect(rec.systems[0]).not.toContain('# Injected skills')
    expect(rec.systems[1]).not.toContain('# Injected skills')
  })

  it('a selected skill is folded into the spec-review prompt (base preserved as prefix)', async () => {
    const rec = recordingGenerateText()
    const critic = new CriticAgent({ generateText: rec.fn }, 75, [fakeCriticSkill])
    await critic.reviewSpec({ reviewType: 'spec_review', artifact: 'x', originalIdea: 'y' })
    const sys = rec.systems[0]!
    expect(sys.startsWith(buildSpecReviewSystemPrompt(75))).toBe(true)
    expect(sys).toContain('# Injected skills')
    expect(sys).toContain('## Skill: security-review')
    expect(sys).toContain('CRITIC SKILL BODY')
  })

  it('a selected skill is folded into the code-review prompt (base preserved as prefix; threshold unchanged)', async () => {
    const rec = recordingGenerateText()
    const critic = new CriticAgent({ generateText: rec.fn }, 75, [fakeCriticSkill])
    await critic.reviewCode({ reviewType: 'code_review', artifact: 'x', originalIdea: 'y', referenceSpec: {} })
    const sys = rec.systems[0]!
    expect(sys.startsWith(buildCodeReviewSystemPrompt(75))).toBe(true)
    expect(sys).toContain('# Injected skills')
    expect(sys).toContain('## Skill: security-review')
    expect(sys).toContain('CRITIC SKILL BODY')
    // The threshold is still folded into the code-review base (gate behavior untouched).
    expect(sys).toContain('overallScore >= 75')
  })

  it('skills are inert: injecting them does NOT change parsing, approval, or the threshold', async () => {
    const critic = new CriticAgent({ generateText: approvedJson }, 75, [fakeCriticSkill])
    expect(critic.getApprovalThreshold()).toBe(75)
    const res = await critic.reviewCode({ reviewType: 'code_review', artifact: 'x', originalIdea: 'y', referenceSpec: {} })
    expect(res.type).toBe('review')
    if (res.type === 'review') {
      expect(res.data.approved).toBe(true)
      expect(res.data.overallScore).toBe(90)
    }
  })
})
