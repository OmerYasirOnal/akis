import type { SpecArtifact } from '@akis/shared'
import type { LlmProvider } from '../../agent/LlmProvider.js'
import type { EventBus } from '../../events/bus.js'
import type { MockGitHubAdapter, RepoFile } from '../../di/MockGitHubAdapter.js'
import { nextTs } from '../../events/clock.js'

export interface ProtoInput {
  sessionId: string
  laneId: string
  spec: SpecArtifact
  feedback?: string
}

/**
 * Proto — spec → code. Thin role over the provider. In the MVP (mock), produces
 * a small deterministic scaffold and pushes it to the in-memory GitHub adapter
 * so Trace can read it. The real SCAFFOLD prompt is injected by the skill layer
 * on the real-AI path. Proto is a producer — it may NOT run tests.
 */
export class ProtoAgent {
  constructor(private deps: { provider: LlmProvider; bus: EventBus; github: MockGitHubAdapter }) {}

  async run(input: ProtoInput): Promise<{ files: RepoFile[] }> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId, sessionId, ts: nextTs() })

    const note = input.feedback ? `\n// addressed feedback: ${input.feedback}` : ''
    const files: RepoFile[] = [
      { filePath: 'index.ts', content: `// ${input.spec.title}${note}\nexport const app = (): string => 'ok'\n` },
    ]

    await this.deps.github.createRepo(sessionId) // idempotent
    await this.deps.github.pushFiles(sessionId, files)

    this.deps.bus.emit({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId, sessionId, ts: nextTs() })
    return { files }
  }
}
