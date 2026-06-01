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

/**
 * Deep-freeze so the read view is immutable at runtime too (not just by type).
 * Cycle-safe: a `tool_result.result`/`tool_call.args` is typed `unknown` and a
 * KnowledgePort chunk is unvalidated, so the graph CAN contain a cycle — without
 * the visited set this would stack-overflow and DoS the dispatch.
 */
function deepFreeze<T>(o: T, seen = new WeakSet<object>()): T {
  if (o && typeof o === 'object') {
    if (seen.has(o as object)) return o
    seen.add(o as object)
    for (const v of Object.values(o)) deepFreeze(v, seen)
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
  // Grounding is best-effort: a retrieval failure (RAG timeout/outage) must NOT
  // fail the whole dispatch — an ungrounded prompt still works. (NullKnowledgePort
  // never throws; this matters once the real RAG layer lands.)
  const knowledge = await deps.knowledge
    .retrieve({
      query: opts.query,
      sessionId,
      ...(opts.knowledgeLimit !== undefined ? { limit: opts.knowledgeLimit } : {}),
    })
    .catch(() => [])

  // Snapshot the session so freezing the read view never freezes the store's LIVE
  // nested objects (store.get() returns a shallow copy, so spec/code are shared by
  // reference; freezing them in place would silently mutate the source of truth).
  // Events are write-once bus log objects — freezing them in place is safe and also
  // prevents a dispatched agent from tampering with the event log (F2-AC17).
  return deepFreeze({ session: structuredClone(session), events, scratchpad, knowledge })
}
