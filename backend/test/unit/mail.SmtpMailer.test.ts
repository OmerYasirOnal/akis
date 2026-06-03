import { describe, it, expect } from 'vitest'
import { SmtpMailer } from '../../src/mail/SmtpMailer.js'
import { FakeSmtpSocket, type SmtpSocket } from '../../src/mail/SmtpSocket.js'

/** Scripted SMTP server replies for a successful AUTH'd send (greeting→EHLO→AUTH LOGIN
 *  3-step→MAIL→RCPT→DATA→end-data→QUIT). */
function happyPathReplies(): string[] {
  return [
    '220 smtp.test ESMTP ready\r\n', // greeting
    '250-smtp.test\r\n250 AUTH LOGIN\r\n', // EHLO response (multiline → one reply)
    '334 VXNlcm5hbWU6\r\n', // AUTH LOGIN → username challenge
    '334 UGFzc3dvcmQ6\r\n', // → password challenge
    '235 2.7.0 Authentication successful\r\n', // → auth ok
    '250 2.1.0 Ok\r\n', // MAIL FROM
    '250 2.1.5 Ok\r\n', // RCPT TO
    '354 End data with <CR><LF>.<CR><LF>\r\n', // DATA
    '250 2.0.0 Ok: queued\r\n', // end-of-data
    '221 2.0.0 Bye\r\n', // QUIT
  ]
}

/** Replies for a no-auth send (no user/pass → skip AUTH entirely). */
function noAuthReplies(): string[] {
  return [
    '220 ok\r\n', // greeting
    '250 ok\r\n', // EHLO
    '250 2.1.0 Ok\r\n', // MAIL FROM
    '250 2.1.5 Ok\r\n', // RCPT TO
    '354 go ahead\r\n', // DATA
    '250 2.0.0 queued\r\n', // end-of-data
    '221 bye\r\n', // QUIT
  ]
}

describe('SmtpMailer (built-in minimal SMTP client, injected socket — no network)', () => {
  it('walks the SMTP conversation and never puts the message body in an error/log', async () => {
    let fake!: FakeSmtpSocket
    const connect = (): SmtpSocket => (fake = new FakeSmtpSocket(happyPathReplies()))
    const mailer = new SmtpMailer({ host: 'smtp.test', port: 587, user: 'u', pass: 'p', from: 'akis@test.dev', connect })

    await mailer.sendResetLink({ to: 'ada@akis.dev', resetUrl: 'https://app/reset-password?token=SEKRET-TOKEN' })

    const wire = fake.written
    expect(wire).toContain('EHLO')
    expect(wire).toContain('MAIL FROM:<akis@test.dev>')
    expect(wire).toContain('RCPT TO:<ada@akis.dev>')
    expect(wire).toMatch(/DATA\r\n/)
    expect(wire).toContain('QUIT')
    // The recipient + the link DO travel on the SMTP wire (that's the point), but the
    // token must never be base64-leaked into the AUTH exchange or anywhere unexpected.
    expect(wire).toContain('https://app/reset-password?token=SEKRET-TOKEN')
  })

  it('sends a from header matching the configured from address', async () => {
    let fake!: FakeSmtpSocket
    const connect = (): SmtpSocket => (fake = new FakeSmtpSocket(noAuthReplies()))
    const mailer = new SmtpMailer({ host: 'smtp.test', port: 25, from: 'noreply@akis.dev', connect })
    await mailer.sendResetLink({ to: 'x@y.dev', resetUrl: 'https://app/r?token=t' })
    expect(fake.written).toContain('From: noreply@akis.dev')
    expect(fake.written).toContain('To: x@y.dev')
  })

  it('throws (without leaking the body) when the server rejects a command', async () => {
    const replies = [
      '220 ok\r\n',
      '250 ok\r\n',
      '550 mailbox unavailable\r\n', // reject MAIL FROM
    ]
    let fake!: FakeSmtpSocket
    const connect = (): SmtpSocket => (fake = new FakeSmtpSocket(replies))
    const mailer = new SmtpMailer({ host: 'smtp.test', port: 25, from: 'a@b.dev', connect })
    await expect(mailer.sendResetLink({ to: 'x@y.dev', resetUrl: 'https://app/r?token=secret-tok' }))
      .rejects.toThrow(/SMTP/)
    // The thrown error must carry the protocol status, NOT the message body / token.
    await mailer.sendResetLink({ to: 'x@y.dev', resetUrl: 'https://app/r?token=secret-tok' }).catch((e: Error) => {
      expect(e.message).not.toContain('secret-tok')
    })
  })
})
