import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/**
 * Narrow socket surface the SmtpMailer talks to — the line-oriented half of an SMTP
 * connection. Deliberately minimal (write / read-reply / end) so a unit test can drive
 * the whole conversation OFFLINE with a scripted fake, exactly like RealGitHubAdapter's
 * injected `PushFetch`. The real implementation wraps node:net / node:tls.
 */
export interface SmtpSocket {
  /** Write raw bytes to the server (the caller appends CRLF where the protocol needs it). */
  write(data: string): void
  /** Resolve with the next full SMTP reply (one or more `NNN-...`/`NNN ...` lines). */
  readReply(): Promise<string>
  /** Close the connection. */
  end(): void
}

export interface SmtpSocketOpts { host: string; port: number; secure: boolean }
/** A connect function — real TCP/TLS in prod, a scripted fake in tests. */
export type SmtpConnect = (opts: SmtpSocketOpts) => SmtpSocket

/**
 * Real socket: TLS when `secure` (implicit TLS, e.g. port 465), else plain TCP. STARTTLS
 * upgrade is intentionally NOT implemented — for an MVP we support implicit-TLS submission
 * (smtps / 465) and plaintext (typically a localhost relay). Buffers incoming data and
 * hands back one CRLF-terminated reply per `readReply()`.
 */
class RealSmtpSocket implements SmtpSocket {
  private buffer = ''
  private waiters: Array<{ resolve: (line: string) => void; reject: (e: Error) => void }> = []
  private error: Error | undefined
  private ended = false
  private readonly sock: ReturnType<typeof netConnect>

  constructor(opts: SmtpSocketOpts) {
    this.sock = opts.secure
      ? tlsConnect({ host: opts.host, port: opts.port })
      : netConnect({ host: opts.host, port: opts.port })
    this.sock.setEncoding('utf8')
    this.sock.on('data', (chunk: string) => { this.buffer += chunk; this.drain() })
    this.sock.on('error', (e: Error) => { this.error = e; this.failWaiters(e) })
    this.sock.on('close', () => { this.ended = true; this.failWaiters(new Error('SMTP connection closed')) })
  }

  /** A reply ends at the LAST line of a multiline group: `NNN ` (space) vs `NNN-` (dash). */
  private drain(): void {
    while (this.waiters.length > 0) {
      const idx = this.completeReplyEnd()
      if (idx < 0) return
      const reply = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx)
      this.waiters.shift()!.resolve(reply)
    }
  }

  /** Index just past a complete reply in the buffer, or -1 if not yet complete. */
  private completeReplyEnd(): number {
    let offset = 0
    for (;;) {
      const nl = this.buffer.indexOf('\n', offset)
      if (nl < 0) return -1
      const line = this.buffer.slice(offset, nl + 1)
      // Final line of a reply: 3 digits then a SPACE (continuation lines use a dash).
      if (/^\d{3} /.test(line)) return nl + 1
      offset = nl + 1
    }
  }

  private failWaiters(e: Error): void {
    const pending = this.waiters
    this.waiters = []
    for (const w of pending) w.reject(e)
  }

  write(data: string): void {
    if (this.ended) throw new Error('SMTP connection closed')
    this.sock.write(data)
  }

  readReply(): Promise<string> {
    if (this.error) return Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.drain()
    })
  }

  end(): void {
    if (!this.ended) { this.ended = true; this.sock.end() }
  }
}

export const realSmtpConnect: SmtpConnect = opts => new RealSmtpSocket(opts)

/**
 * Scripted, OFFLINE socket for tests. `replies` are dequeued one per `readReply()`; every
 * `write` is appended to `written` so a test can assert the exact SMTP conversation
 * without a real server.
 */
export class FakeSmtpSocket implements SmtpSocket {
  written = ''
  private queue: string[]
  constructor(replies: string[]) { this.queue = [...replies] }
  write(data: string): void { this.written += data }
  async readReply(): Promise<string> {
    const next = this.queue.shift()
    if (next === undefined) throw new Error('SMTP fake: no scripted reply remaining')
    return next
  }
  end(): void { /* no-op */ }
}
