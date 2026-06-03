import type { Mailer } from './Mailer.js'
import { NoopMailer } from './Mailer.js'
import { SmtpMailer } from './SmtpMailer.js'

/**
 * P5-OPS-1 — mailer selection (OPT-IN). Mirrors `selectGitHubAdapter`: the REAL
 * (SmtpMailer) is returned ONLY when SMTP is fully configured; otherwise — and ALWAYS
 * under NODE_ENV=test — the `NoopMailer` is returned, so the default boot is byte-for-byte
 * identical (the forgot-password route keeps today's dev-echo and never sends mail). A
 * misconfigured opt-in (e.g. a garbage URL) falls back to the NoopMailer rather than
 * throwing, so a bad config can never break boot.
 *
 * Config (a from-address is always required; the relay is either a single URL or the
 * discrete host/port/user/pass set):
 *  - AKIS_MAIL_FROM  — REQUIRED. Envelope + header From, e.g. "AKIS <noreply@you.dev>".
 *  - AKIS_SMTP_URL   — one-line relay, e.g. smtps://user:pass@smtp.host:465 (smtps ⇒ TLS).
 *    OR the discrete set:
 *  - AKIS_SMTP_HOST / AKIS_SMTP_PORT / AKIS_SMTP_USER / AKIS_SMTP_PASS
 *    (AKIS_SMTP_SECURE=1 forces implicit TLS; otherwise inferred from port 465).
 *
 * The SMTP password is read here and handed to the SmtpMailer only for the AUTH exchange.
 * It is NEVER logged and never surfaced in any return value or error.
 */
export function selectMailer(env: Record<string, string | undefined> | undefined): Mailer {
  if (env?.NODE_ENV === 'test') return new NoopMailer() // tests/CI never send real mail
  const from = env?.AKIS_MAIL_FROM?.trim()
  if (!from) return new NoopMailer() // DEFAULT OFF — no from-address ⇒ zero behavior change

  const cfg = resolveSmtp(env)
  if (!cfg) return new NoopMailer() // no/garbled relay → no-op default, never a broken boot
  return new SmtpMailer({ ...cfg, from })
}

interface SmtpConn { host: string; port: number; secure?: boolean; user?: string; pass?: string }

/** Resolve the relay from AKIS_SMTP_URL, else the discrete host/port/user/pass set. */
function resolveSmtp(env: Record<string, string | undefined> | undefined): SmtpConn | undefined {
  const url = env?.AKIS_SMTP_URL?.trim()
  if (url) return fromUrl(url)

  const host = env?.AKIS_SMTP_HOST?.trim()
  if (!host) return undefined
  const port = portOf(env?.AKIS_SMTP_PORT, 587)
  const secure = env?.AKIS_SMTP_SECURE === '1' || env?.AKIS_SMTP_SECURE === 'true' || port === 465
  return {
    host, port, secure,
    ...(env?.AKIS_SMTP_USER?.trim() ? { user: env.AKIS_SMTP_USER.trim() } : {}),
    ...(env?.AKIS_SMTP_PASS ? { pass: env.AKIS_SMTP_PASS } : {}),
  }
}

/** Parse a smtp(s)://[user:pass@]host[:port] URL. Returns undefined on anything malformed. */
function fromUrl(raw: string): SmtpConn | undefined {
  let u: URL
  try { u = new URL(raw) } catch { return undefined }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') return undefined
  if (!u.hostname) return undefined
  const secure = u.protocol === 'smtps:'
  const port = u.port ? portOf(u.port, secure ? 465 : 587) : (secure ? 465 : 587)
  return {
    host: u.hostname,
    port,
    secure,
    ...(u.username ? { user: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { pass: decodeURIComponent(u.password) } : {}),
  }
}

function portOf(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback
}
