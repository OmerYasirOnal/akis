import { describe, it, expect } from 'vitest'
import { CriticAgent } from '../../src/orchestrator/subagents/critic/CriticAgent.js'

// Minimal fake generateText that returns a JSON review the CriticAgent parses.
const approvedJson = async () => JSON.stringify({
  approved: true, overallScore: 90, summary: 'ok', findings: [],
  reviewType: 'code_review', iteration: 1, hasCriticalFinding: false, maxSeverity: 'info',
})

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
