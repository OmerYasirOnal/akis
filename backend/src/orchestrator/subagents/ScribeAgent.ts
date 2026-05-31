import type { SpecArtifact } from '@akis/shared'
import type { LlmProvider } from '../../agent/LlmProvider.js'
import type { EventBus } from '../../events/bus.js'
import { nextTs } from '../../events/clock.js'
import { getKnobs } from './knobs.js'

export interface ScribeInput {
  sessionId: string
  laneId: string
  idea: string
}

export type ScribeOutcome =
  | { type: 'spec'; spec: SpecArtifact }
  | { type: 'clarify'; questions: string[] }

/**
 * Scribe — idea → spec. Thin role over the provider. In the MVP (mock), the
 * spec is produced deterministically; the `mockNeedsClarification` knob drives
 * the clarify branch. Real prompt (CLARIFICATION + SPEC_GENERATION) is injected
 * by the orchestrator's skill layer and used on the real-AI path.
 */
export class ScribeAgent {
  constructor(private deps: { provider: LlmProvider; bus: EventBus }) {}

  async run(input: ScribeInput): Promise<ScribeOutcome> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId, sessionId, ts: nextTs() })

    const knobs = getKnobs(this.deps.provider)
    if (knobs.mockNeedsClarification) {
      this.deps.bus.emit({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId, sessionId, ts: nextTs() })
      return { type: 'clarify', questions: ['Who is the primary user?', 'What is the single most important feature?'] }
    }

    const spec: SpecArtifact = {
      title: `Spec for: ${input.idea}`,
      body: [
        `# ${input.idea}`,
        '',
        '## Problem',
        input.idea,
        '',
        '## Acceptance criteria',
        '- Given the app is open, When the user performs the core action, Then the expected result is shown.',
        '',
        '## Out of scope',
        '- Authentication, deployment.',
      ].join('\n'),
    }

    this.deps.bus.emit({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId, sessionId, ts: nextTs() })
    return { type: 'spec', spec }
  }
}
