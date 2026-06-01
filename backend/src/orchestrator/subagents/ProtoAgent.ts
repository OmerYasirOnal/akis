import type { EventBus } from '../../events/bus.js'
import type { RepoFile } from '../../di/MockGitHubAdapter.js'
import type { ApprovedSpec } from '../../gates/specGate.js'
import { nextTs } from '../../events/clock.js'

export interface ProtoInput {
  sessionId: string
  laneId: string
  /** Gate 1: Proto cannot run without an ApprovedSpec token (only approve() mints it). */
  approved: ApprovedSpec
  feedback?: string
}

/**
 * Proto — spec → code. A producer role. It REQUIRES an ApprovedSpec token, so
 * code-write cannot even be called without human approval (Gate 1, compile-time).
 *
 * Proto returns files only — it does NOT push to the repo. The actual GitHub
 * write happens once, behind the push gate, at confirmPush. This removes the
 * old "every iteration appends to the repo" bug and keeps the push surface
 * reachable only through the ApprovedPush token.
 */
export class ProtoAgent {
  constructor(private deps: { bus: EventBus }) {}

  async run(input: ProtoInput): Promise<{ files: RepoFile[] }> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId, sessionId, ts: nextTs() })

    const note = input.feedback ? `\n// addressed feedback: ${input.feedback}` : ''
    const files: RepoFile[] = [
      { filePath: 'index.ts', content: `// ${input.approved.spec.title}${note}\nexport const app = (): string => 'ok'\n` },
    ]

    this.deps.bus.emit({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId, sessionId, ts: nextTs() })
    return { files }
  }
}
