import { describe, it, expect } from 'vitest'
import { ScribeAgent } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { EventBus } from '../../src/events/bus.js'
import type { LlmProvider, ChatResult } from '../../src/agent/LlmProvider.js'

const spec = { title: 'Pomodoro Timer', body: '- 25-min work session\n- 5-min break\n- Start/Pause/Reset buttons' }
const files = [{ filePath: 'index.html', content: '<html>...</html>' }, { filePath: 'app.js', content: 'const t = 25;' }]

function provider(text: string | undefined, opts: { throws?: boolean } = {}): LlmProvider {
  return {
    name: 'fake', model: 'fake',
    async chat(): Promise<ChatResult> {
      if (opts.throws) throw new Error('provider down')
      return text === undefined ? {} : { text } // omit (not undefined) under exactOptionalPropertyTypes
    },
  }
}
const scribe = (p: LlmProvider): ScribeAgent => new ScribeAgent({ bus: new EventBus(), provider: p })

describe('ScribeAgent.writeDocs (additive, fail-soft)', () => {
  it('returns a README.md authored from the provider output', async () => {
    const doc = await scribe(provider('# Pomodoro Timer\n\nA focus timer. Run: open index.html in a browser.')).writeDocs({ spec, files })
    expect(doc?.filePath).toBe('README.md')
    expect(doc?.content).toContain('Pomodoro Timer')
  })

  it('strips a single wrapping ```markdown fence the model may add', async () => {
    const doc = await scribe(provider('```markdown\n# Title\n\nSome body text here that is long enough.\n```')).writeDocs({ spec, files })
    expect(doc?.content).toBe('# Title\n\nSome body text here that is long enough.')
  })

  it('returns undefined on empty/trivial output (mock/keyless → no fabricated docs file)', async () => {
    expect(await scribe(provider('')).writeDocs({ spec, files })).toBeUndefined()
    expect(await scribe(provider('   x   ')).writeDocs({ spec, files })).toBeUndefined()
    expect(await scribe(provider(undefined)).writeDocs({ spec, files })).toBeUndefined()
  })

  it('returns undefined on a provider throw — documentation NEVER blocks a build', async () => {
    expect(await scribe(provider('whatever', { throws: true })).writeDocs({ spec, files })).toBeUndefined()
  })

  it('handles an empty file list (TODO-grounded) without throwing', async () => {
    const doc = await scribe(provider('# App\n\nTODO: describe the files once present.')).writeDocs({ spec, files: [] })
    expect(doc?.filePath).toBe('README.md')
  })

  it('does NOT strip a README that starts AND ends with a bare ``` fence (only explicit ```markdown is unwrapped)', async () => {
    const readme = '```\nconst x = 1\n```\n\nMiddle prose explaining the app.\n\n```\nmore code\n```'
    const doc = await scribe(provider(readme)).writeDocs({ spec, files })
    expect(doc?.content).toBe(readme) // bare fences preserved (the LOW-fix: language tag now required)
  })
})
