import type { AkisEvent } from '@akis/shared'

/**
 * Server-Sent-Events frame builders. The `id:` line carries the per-session
 * transport `seq` — the browser's EventSource echoes the last one back as
 * `Last-Event-ID` on reconnect, which is what makes the stream resumable
 * (F2-AC12). Event content is JSON-encoded, so any newlines inside it are
 * escaped (`\n`) and can never split a frame.
 */
export function sseEvent(seq: number, event: AkisEvent): string {
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`
}

/** A named control frame (e.g. `reset` to tell the client to re-sync). */
export function sseControl(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A comment line — used as a keep-alive ping; ignored by EventSource. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`
}
