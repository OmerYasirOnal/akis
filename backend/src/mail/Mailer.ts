/**
 * P5-OPS-1 — the pluggable Mailer seam.
 *
 * The password-reset flow mints a short-lived token; today it is only DEV-echoed in the
 * HTTP response (no email). This seam lets a self-host deployment deliver the reset LINK
 * by email instead, without changing the enumeration-safe response shape.
 *
 * Two implementations sit behind this interface, selected purely by env (`selectMailer`):
 *  - `NoopMailer` (DEFAULT) — does nothing. Boot with no SMTP config is byte-for-byte
 *    unchanged: the route keeps today's dev-echo behavior and never reaches a mailer.
 *  - `SmtpMailer` (OPT-IN) — a minimal built-in SMTP client (no new dependency), enabled
 *    only when SMTP env is configured.
 *
 * Mirrors the GitHubAdapter seam (`MockGitHubAdapter` default + opt-in `RealGitHubAdapter`
 * selected by env): a no-op/mock default, a real network impl behind the SAME shape, and
 * a `select*` switch. The reset URL carries the token, so it is treated as a SECRET — it
 * is never logged by any implementation.
 */

/** A password-reset email: the recipient and the absolute reset LINK (carries the token). */
export interface ResetMail {
  /** Recipient address (the account email). */
  to: string
  /** Absolute reset URL the user clicks — `<base>/reset-password?token=...`. SECRET; never logged. */
  resetUrl: string
}

export interface Mailer {
  /** Deliver a password-reset link. Resolves on success; rejects on a delivery failure
   *  (the caller swallows the rejection so a mail outage never breaks the
   *  enumeration-safe response). Implementations MUST NOT log the resetUrl/token. */
  sendResetLink(mail: ResetMail): Promise<void>
}

/**
 * The default mailer: a no-op. Selected whenever SMTP is unconfigured (and always under
 * NODE_ENV=test). With this in place the forgot-password route falls back to today's
 * dev-echo, so the default boot is unchanged. Never logs anything.
 */
export class NoopMailer implements Mailer {
  async sendResetLink(_mail: ResetMail): Promise<void> {
    // Intentionally does nothing — no network, no logging.
  }
}
