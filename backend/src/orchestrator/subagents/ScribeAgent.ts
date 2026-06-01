import type { SpecArtifact } from '@akis/shared'
import type { EventBus } from '../../events/bus.js'
import { nextTs } from '../../events/clock.js'

export interface ScribeInput {
  sessionId: string
  laneId: string
  idea: string
}

export type ScribeOutcome =
  | { type: 'spec'; spec: SpecArtifact }
  | { type: 'clarify'; questions: string[] }

/**
 * Scribe — idea → spec. A producer role. In the MVP it produces a deterministic
 * spec; `needsClarification` (explicit config, not a provider cast) drives the
 * clarify branch. The real prompt (CLARIFICATION + SPEC_GENERATION) is injected
 * via the skill layer on the real-AI path.
 */
export class ScribeAgent {
  constructor(private deps: { bus: EventBus; needsClarification?: boolean }) {}

  async run(input: ScribeInput): Promise<ScribeOutcome> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId, sessionId, ts: nextTs() })

    if (this.deps.needsClarification) {
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
