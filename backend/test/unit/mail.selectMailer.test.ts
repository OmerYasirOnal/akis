import { describe, it, expect } from 'vitest'
import { selectMailer } from '../../src/mail/selectMailer.js'
import { NoopMailer } from '../../src/mail/Mailer.js'
import { SmtpMailer } from '../../src/mail/SmtpMailer.js'

describe('selectMailer (env-driven mailer seam)', () => {
  it('returns the NoopMailer when SMTP is unconfigured (default)', () => {
    expect(selectMailer({})).toBeInstanceOf(NoopMailer)
    expect(selectMailer(undefined)).toBeInstanceOf(NoopMailer)
  })

  it('returns the NoopMailer when only a URL is set but AKIS_MAIL_FROM is missing', () => {
    // A from-address is mandatory; without it we can't send a valid envelope, so fall
    // back to the no-op default rather than booting a half-configured mailer.
    expect(selectMailer({ AKIS_SMTP_URL: 'smtp://localhost:25' })).toBeInstanceOf(NoopMailer)
  })

  it('returns the NoopMailer when only AKIS_MAIL_FROM is set but no SMTP host/url', () => {
    expect(selectMailer({ AKIS_MAIL_FROM: 'akis@example.com' })).toBeInstanceOf(NoopMailer)
  })

  it('builds an SmtpMailer from AKIS_SMTP_URL + AKIS_MAIL_FROM', () => {
    const m = selectMailer({ AKIS_SMTP_URL: 'smtps://user:pass@smtp.example.com:465', AKIS_MAIL_FROM: 'akis@example.com' })
    expect(m).toBeInstanceOf(SmtpMailer)
  })

  it('builds an SmtpMailer from discrete host/port/user/pass + AKIS_MAIL_FROM', () => {
    const m = selectMailer({
      AKIS_SMTP_HOST: 'smtp.example.com',
      AKIS_SMTP_PORT: '587',
      AKIS_SMTP_USER: 'u',
      AKIS_SMTP_PASS: 'p',
      AKIS_MAIL_FROM: 'akis@example.com',
    })
    expect(m).toBeInstanceOf(SmtpMailer)
  })

  it('falls back to the NoopMailer on a garbage SMTP URL (never a broken boot)', () => {
    expect(selectMailer({ AKIS_SMTP_URL: 'not a url', AKIS_MAIL_FROM: 'a@b.com' })).toBeInstanceOf(NoopMailer)
  })
})
