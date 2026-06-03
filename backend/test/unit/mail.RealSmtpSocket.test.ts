import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { SmtpMailer } from '../../src/mail/SmtpMailer.js'
import { realSmtpConnect } from '../../src/mail/SmtpSocket.js'

/**
 * Exercises the REAL socket (node:net) reply parser end-to-end against a tiny in-process
 * SMTP-ish server on loopback (NO external network). This is the only path that covers
 * RealSmtpSocket's multiline-reply framing (`NNN-` continuation vs `NNN ` final line).
 */
let server: Server | undefined
afterEach(() => { server?.close(); server = undefined })

function startFakeSmtp(script: string[]): Promise<number> {
  return new Promise(resolve => {
    server = createServer(sock => {
      let i = 0
      sock.write(script[i++]!) // greeting
      sock.on('data', data => {
        const line = data.toString()
        if (i < script.length) sock.write(script[i++]!)
        if (/^\.\r\n$/.test(line) || /^QUIT/i.test(line)) { /* keep serving until script ends */ }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

describe('RealSmtpSocket (node:net, loopback only — multiline reply framing)', () => {
  it('completes a no-auth send against a multiline-EHLO fake server', async () => {
    const port = await startFakeSmtp([
      '220 fake ESMTP\r\n',
      '250-fake greets you\r\n250-PIPELINING\r\n250 8BITMIME\r\n', // multiline EHLO → ONE reply
      '250 sender ok\r\n', // MAIL FROM
      '250 recipient ok\r\n', // RCPT TO
      '354 go ahead\r\n', // DATA
      '250 queued\r\n', // end-of-data
      '221 bye\r\n', // QUIT
    ])
    const mailer = new SmtpMailer({ host: '127.0.0.1', port, from: 'noreply@akis.dev', connect: realSmtpConnect })
    await expect(mailer.sendResetLink({ to: 'ada@akis.dev', resetUrl: 'http://x/reset-password?token=t' }))
      .resolves.toBeUndefined()
  })
})
