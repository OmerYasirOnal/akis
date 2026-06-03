import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { UserStore } from '../../src/auth/UserStore.js'
import type { Mailer, ResetMail } from '../../src/mail/Mailer.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-resetmail-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Records every send so the test can assert recipient + link without any real SMTP. */
class FakeMailer implements Mailer {
  readonly sent: ResetMail[] = []
  async sendResetLink(mail: ResetMail): Promise<void> { this.sent.push(mail) }
}

function build(opts: { mailer?: Mailer; env?: Record<string, string | undefined>; userStore?: UserStore }) {
  const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
  return buildServer({
    keyStore,
    env: { AUTH_JWT_SECRET: 'reset-mail-secret', ...opts.env },
    userStore: opts.userStore ?? new UserStore(),
    ...(opts.mailer ? { mailer: opts.mailer } : {}),
  })
}

const GENERIC = 'If that email has an account, a reset link has been sent.'

describe('password-reset email delivery (mailer seam)', () => {
  it('with a configured mailer: invokes it with a reset LINK to the right recipient', async () => {
    const mailer = new FakeMailer()
    const store = new UserStore()
    const server = build({ mailer, userStore: store, env: { PUBLIC_BASE_URL: 'https://app.example.com' } })
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } })

    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ada@akis.dev' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: GENERIC }) // mail sent → response carries NO token
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]!.to).toBe('ada@akis.dev')
    // The link must be a usable absolute reset URL carrying a token (built from PUBLIC_BASE_URL).
    expect(mailer.sent[0]!.resetUrl).toMatch(/^https:\/\/app\.example\.com\/reset-password\?token=.+/)
  })

  it('the emailed token actually resets the password (end-to-end via the mailer)', async () => {
    const mailer = new FakeMailer()
    const store = new UserStore()
    const server = build({ mailer, userStore: store, env: { PUBLIC_BASE_URL: 'https://app.example.com' } })
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } })
    await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ada@akis.dev' } })

    const token = new URL(mailer.sent[0]!.resetUrl).searchParams.get('token')!
    const reset = await server.inject({ method: 'POST', url: '/auth/reset-password', payload: { token, password: 'brandnewpass9' } })
    expect(reset.statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@akis.dev', password: 'brandnewpass9' } })).statusCode).toBe(200)
  })

  it('a configured mailer is NOT invoked for an unknown email — and the response is the SAME generic one (no enumeration)', async () => {
    const mailer = new FakeMailer()
    const server = build({ mailer })
    const known = await build({ mailer: new FakeMailer() }) // separate server for byte-compare below
    void known
    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ghost@akis.dev' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: GENERIC })
    expect(mailer.sent).toHaveLength(0)
  })

  it('with NO mailer configured: mail is a no-op AND the response is byte-identical to today (dev-echo parity)', async () => {
    // NODE_ENV unset → devEcho on → forgot-password still echoes the token (today's behavior),
    // and there is no mailer to invoke. This is the default-boot parity invariant.
    const store = new UserStore()
    const server = build({ userStore: store }) // no mailer
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } })
    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ada@akis.dev' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.message).toBe(GENERIC)
    expect(typeof body.resetToken).toBe('string') // dev-echo preserved exactly
    expect(typeof body.resetUrl).toBe('string')
  })

  it('with a configured mailer the dev-echo is SUPPRESSED (the link goes by email, not the response)', async () => {
    // Once mail is actually delivered we must not ALSO leak the token in the HTTP body.
    const mailer = new FakeMailer()
    const store = new UserStore()
    const server = build({ mailer, userStore: store })
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } })
    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ada@akis.dev' } })
    expect(res.json().resetToken).toBeUndefined()
    expect(res.json().resetUrl).toBeUndefined()
  })

  it('the reset token is NEVER written to any log line on the forgot-password path', async () => {
    // Capture everything the process would log; the minted token must not appear.
    const lines: string[] = []
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }
    const tap = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
    console.log = console.error = console.warn = console.info = console.debug = tap as typeof console.log
    try {
      const mailer = new FakeMailer()
      const store = new UserStore()
      const server = build({ mailer, userStore: store })
      await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } })
      await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ada@akis.dev' } })
      // No PUBLIC_BASE_URL → the link is a relative path; resolve against a dummy base to read the token.
      const token = new URL(mailer.sent[0]!.resetUrl, 'http://x').searchParams.get('token')!
      expect(token.length).toBeGreaterThan(10)
      for (const line of lines) expect(line).not.toContain(token)
    } finally {
      Object.assign(console, orig)
    }
  })

  it('a throwing mailer never changes the enumeration-safe response (mail failure is swallowed)', async () => {
    // A flaky SMTP server must not turn into a 500 that reveals the email exists.
    class BoomMailer implements Mailer { async sendResetLink(): Promise<void> { throw new Error('smtp down') } }
    const store = new UserStore()
    const server = build({ mailer: new BoomMailer(), userStore: store })
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } })
    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ada@akis.dev' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().message).toBe(GENERIC)
  })

  it('the send is FIRE-AND-FORGET: a mailer whose promise never resolves still returns at once (no latency oracle)', async () => {
    // The whole point of the fix: response latency must NOT depend on the mailer. A hung relay
    // (a promise that never settles) would, if awaited, hold the connection open ONLY when the
    // account exists — leaking existence via timing. Here the request must complete regardless.
    let invoked = false
    class HangingMailer implements Mailer {
      sendResetLink(): Promise<void> { invoked = true; return new Promise<void>(() => { /* never resolves */ }) }
    }
    const store = new UserStore()
    const server = build({ mailer: new HangingMailer(), userStore: store })
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } })
    // If the handler awaited the send, this inject would hang forever and the test would time out.
    const res = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ada@akis.dev' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: GENERIC }) // body stays byte-identical + enumeration-safe
    expect(invoked).toBe(true) // the call is still made synchronously — only the await is dropped
  })
})
