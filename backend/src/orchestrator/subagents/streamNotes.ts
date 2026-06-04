import type { Role } from '@akis/shared'
import type { EventBus } from '../../events/bus.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../agent/LlmProvider.js'
import { nextTs } from '../../events/clock.js'

/**
 * Run a provider chat while STREAMING live "working" notes onto the bus — so a build agent
 * (Proto writing the app, Scribe writing the spec) is NOT a frozen pulsing dot for the bulk
 * of the run, but visibly produces output the way the AKIS chat does.
 *
 * Uses `provider.chatStream` when available (falling back to plain `chat` — byte-identical
 * result otherwise), and emits at most `cap` EPHEMERAL `text` events, throttled to ~`everyMs`,
 * each a trimmed tail of the new output. Ephemeral = shown live but NEVER ingested into RAG
 * (the IngestionSink ingests only non-ephemeral text), so this is pure observability and
 * cannot affect any gate, the spec, or retrieval. The returned ChatResult is the SAME as
 * `chat()` would return (full assembled text), so all downstream parsing is unchanged.
 */
export async function chatWithLiveNotes(
  deps: { bus: EventBus; provider: LlmProvider },
  req: ChatRequest,
  who: { agent: Role; laneId: string; sessionId: string },
  opts: { everyMs?: number; cap?: number } = {},
): Promise<ChatResult> {
  const { provider } = deps
  if (!provider.chatStream) return provider.chat(req) // no streaming seam → unchanged behavior

  const everyMs = opts.everyMs ?? 900
  const cap = opts.cap ?? 12
  let full = ''
  let emittedLen = 0
  let lastAt = 0
  let emitted = 0
  const onDelta = (d: string): void => {
    if (!d) return
    full += d
    const now = Date.now()
    // Throttle by time AND by a minimum new-chars threshold, and hard-cap the count, so a long
    // code-gen surfaces a handful of live lines (not a token-by-token flood).
    if (emitted < cap && now - lastAt >= everyMs && full.length - emittedLen >= 24) {
      const tail = full.slice(emittedLen).replace(/\s+/g, ' ').trim().slice(-90)
      if (tail) {
        deps.bus.emit({ kind: 'text', text: `› ${tail}`, ephemeral: true, agent: who.agent, laneId: who.laneId, sessionId: who.sessionId, ts: nextTs() })
        emitted++; lastAt = now; emittedLen = full.length
      }
    }
  }
  return provider.chatStream(req, onDelta)
}
