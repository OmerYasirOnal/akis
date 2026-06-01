import type { SharedContext } from '@akis/shared'
import type { SessionStore } from '../store/SessionStore.js'
import type { EventBus } from '../events/bus.js'
import type { KnowledgePort } from '../knowledge/KnowledgePort.js'
import { foldScratchpad } from './scratchpad.js'

export interface AssembleDeps {
  store: SessionStore
  bus: EventBus
  knowledge: KnowledgePort
}

export interface AssembleOpts {
  query: string
  knowledgeLimit?: number
}

/** Deep-freeze so the read view is immutable at runtime too (not just by type). */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}

/**
 * Assemble the typed, read-only SharedContext every agent reads (F2-AC16). It is a
 * pure projection of the session's existing single sources of truth — SessionState
 * + the AkisEvent log — plus the derived scratchpad and retrieved knowledge. The
 * returned object is deep-frozen and carries no capability, so a dispatched agent
 * can read it but cannot reach a gate through it (F2-AC17).
 */
export async function assembleSharedContext(
  sessionId: string,
  deps: AssembleDeps,
  opts: AssembleOpts,
): Promise<SharedContext> {
  const session = await deps.store.get(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const events = deps.bus.recent(sessionId)
  const scratchpad = foldScratchpad(events)
  const knowledge = await deps.knowledge.retrieve({
    query: opts.query,
    sessionId,
    ...(opts.knowledgeLimit !== undefined ? { limit: opts.knowledgeLimit } : {}),
  })
  return deepFreeze({ session, events, scratchpad, knowledge })
}
