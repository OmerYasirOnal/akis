import type { Mailer, ResetMail } from './Mailer.js'
import { realSmtpConnect, type SmtpConnect, type SmtpSocket } from './SmtpSocket.js'

/**
 * Minimal SMTP-submission client (P5-OPS-1) — the OPT-IN counterpart to `NoopMailer`,
 * selected only when SMTP env is configured (`selectMailer`). No new dependency: it
 * speaks just enough SMTP (EHLO → optional AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT)
 * to submit a single plaintext message through a relay, mirroring the codebase's
 * no-bcrypt / hand-rolled-JWT discipline.
 *
 * Supports implicit TLS (`smtps://` / port 465) and plaintext (a localhost relay).
 * STARTTLS is not implemented — for any non-local relay use an implicit-TLS submission
 * endpoint. The credential (pass) is sent only inside the AUTH exchange and is NEVER
 * logged; the reset URL/token is written to the DATA body (its whole purpose) but never
 * logged and never placed in a thrown error.
 */
export interface SmtpMailerConfig {
  host: string
  port: number
  /** Implicit TLS (true for port 465 / smtps). Default inferred from port by selectMailer. */
  secure?: boolean
  user?: string
  pass?: string
  /** Envelope + header From address (AKIS_MAIL_FROM). */
  from: string
  /** Injected connect — real net/tls in prod, a scripted fake in tests (no network). */
  connect?: SmtpConnect
}

/** Throws a status-only error (never the message body/token) when a reply isn't 2xx/3xx. */
function expect(reply: string, okPrefixes: string[]): void {
  const code = reply.slice(0, 3)
  if (!okPrefixes.some(p => code.startsWith(p))) {
    // Surface ONLY the SMTP status line, never the body we were sending.
    throw new Error(`SMTP command rejected (status ${reply.trim().split('\n')[0] ?? code})`)
  }
}

export class SmtpMailer implements Mailer {
  private readonly cfg: SmtpMailerConfig
  private readonly connect: SmtpConnect

  constructor(cfg: SmtpMailerConfig) {
    this.cfg = cfg
    this.connect = cfg.connect ?? realSmtpConnect
  }

  async sendResetLink(mail: ResetMail): Promise<void> {
    const sock = this.connect({ host: this.cfg.host, port: this.cfg.port, secure: this.cfg.secure ?? this.cfg.port === 465 })
    try {
      expect(await sock.readReply(), ['2']) // greeting
      await this.cmd(sock, `EHLO ${hostLabel(this.cfg.from)}`, ['2'])
      if (this.cfg.user && this.cfg.pass) await this.auth(sock)
      await this.cmd(sock, `MAIL FROM:<${this.cfg.from}>`, ['2'])
      await this.cmd(sock, `RCPT TO:<${mail.to}>`, ['2'])
      await this.cmd(sock, 'DATA', ['3'])
      const body = this.message(mail)
      sock.write(body)
      // The end-of-data terminator (".") MUST follow a CRLF, so guarantee the body ends with one
      // before writing the dot (append if the template ever loses its trailing blank element).
      if (!body.endsWith('\r\n')) sock.write('\r\n')
      await this.cmd(sock, '.', ['2'])
      // Best-effort QUIT — a server hiccup AFTER the message is queued must not "fail" the send.
      try { await this.cmd(sock, 'QUIT', ['2']) } catch { /* already queued */ }
    } finally {
      sock.end()
    }
  }

  private async cmd(sock: SmtpSocket, line: string, ok: string[]): Promise<void> {
    sock.write(`${line}\r\n`)
    expect(await sock.readReply(), ok)
  }

  /** AUTH LOGIN — base64 username then password. The password is sent ONLY here; never logged. */
  private async auth(sock: SmtpSocket): Promise<void> {
    await this.cmd(sock, 'AUTH LOGIN', ['3'])
    await this.cmd(sock, Buffer.from(this.cfg.user!).toString('base64'), ['3'])
    await this.cmd(sock, Buffer.from(this.cfg.pass!).toString('base64'), ['2'])
  }

  /** A minimal RFC-5322 message. The reset link is the body; plain text only. */
  private message(mail: ResetMail): string {
    const lines = [
      `From: ${this.cfg.from}`,
      `To: ${mail.to}`,
      'Subject: Reset your AKIS password',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Someone requested a password reset for your AKIS account.',
      '',
      `Reset it here (link expires shortly): ${mail.resetUrl}`,
      '',
      'If you did not request this, you can safely ignore this email.',
      '', // trailing blank → ends with CRLF before the dot terminator
    ]
    // Dot-stuff any line that begins with '.', then terminate with <CRLF>.<CRLF>.
    return lines.map(l => (l.startsWith('.') ? `.${l}` : l)).join('\r\n')
  }
}

/** A safe EHLO label derived from the from-address domain (no spaces; localhost fallback). */
function hostLabel(from: string): string {
  const domain = from.split('@')[1]?.trim()
  return domain && /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'localhost'
}
