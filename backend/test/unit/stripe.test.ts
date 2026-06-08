import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { stripeConfigured, createProCheckout, createPortal, verifyWebhook, StripeError, type StripeFetch } from '../../src/billing/stripe.js'

const ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_PRO: 'price_pro', STRIPE_WEBHOOK_SECRET: 'whsec_test' }

/** A fake StripeFetch capturing the request + returning a scripted response. */
function fakeFetch(status: number, body: unknown): { http: StripeFetch; calls: { url: string; body?: string; headers: Record<string, string> }[] } {
  const calls: { url: string; body?: string; headers: Record<string, string> }[] = []
  const http: StripeFetch = async (url, init) => { calls.push({ url, ...(init.body !== undefined ? { body: init.body } : {}), headers: init.headers }); return { status, json: async () => body, text: async () => JSON.stringify(body) } }
  return { http, calls }
}

function sign(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${v1}`
}

describe('stripeConfigured', () => {
  it('true only with BOTH a secret key and a pro price', () => {
    expect(stripeConfigured(ENV)).toBe(true)
    expect(stripeConfigured({ STRIPE_SECRET_KEY: 'sk' })).toBe(false)
    expect(stripeConfigured({ STRIPE_PRICE_PRO: 'price' })).toBe(false)
    expect(stripeConfigured({})).toBe(false)
  })
})

describe('createProCheckout', () => {
  it('POSTs a subscription checkout with the price + client_reference_id, returns the URL; the secret rides only as Bearer', async () => {
    const { http, calls } = fakeFetch(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })
    const out = await createProCheckout(ENV, { userId: 'u1', email: 'u1@x.dev', successUrl: 'https://app/s', cancelUrl: 'https://app/c' }, http)
    expect(out).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })
    const c = calls[0]!
    expect(c.url).toBe('https://api.stripe.com/v1/checkout/sessions')
    expect(c.headers.authorization).toBe('Bearer sk_test_x')
    expect(c.body).toContain('mode=subscription')
    expect(c.body).toContain(`${encodeURIComponent('line_items[0][price]')}=price_pro`)
    expect(c.body).toContain('client_reference_id=u1')
    expect(c.body).toContain('customer_email=u1%40x.dev')
  })
  it('reuses an existing customer id (no customer_email) when known', async () => {
    const { http, calls } = fakeFetch(200, { id: 'cs', url: 'u' })
    await createProCheckout(ENV, { userId: 'u1', email: 'u1@x.dev', customerId: 'cus_1', successUrl: 's', cancelUrl: 'c' }, http)
    expect(calls[0]!.body).toContain('customer=cus_1')
    expect(calls[0]!.body).not.toContain('customer_email')
  })
  it('throws StripeError (short, non-secret) on a Stripe 4xx', async () => {
    const { http } = fakeFetch(400, { error: { message: 'No such price' } })
    await expect(createProCheckout(ENV, { userId: 'u1', successUrl: 's', cancelUrl: 'c' }, http)).rejects.toThrow(StripeError)
  })
})

describe('createPortal', () => {
  it('POSTs the customer + return_url, returns the portal URL', async () => {
    const { http, calls } = fakeFetch(200, { url: 'https://billing.stripe.com/p/1' })
    const out = await createPortal(ENV, { customerId: 'cus_1', returnUrl: 'https://app/settings' }, http)
    expect(out.url).toBe('https://billing.stripe.com/p/1')
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions')
    expect(calls[0]!.body).toContain('customer=cus_1')
  })
})

describe('verifyWebhook (SECURITY — only a valid signature grants Pro)', () => {
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'u1' } } })
  it('accepts a correctly-signed, in-tolerance event', () => {
    const ev = verifyWebhook(payload, sign(payload, 'whsec_test'), 'whsec_test')
    expect(ev?.type).toBe('checkout.session.completed')
  })
  it('REJECTS a forged/wrong-secret signature', () => {
    expect(verifyWebhook(payload, sign(payload, 'whsec_test'), 'whsec_OTHER')).toBeUndefined()
    expect(verifyWebhook(payload, 't=123,v1=deadbeef', 'whsec_test')).toBeUndefined()
  })
  it('REJECTS a tampered body (signature no longer matches)', () => {
    const sig = sign(payload, 'whsec_test')
    expect(verifyWebhook(payload + ' ', sig, 'whsec_test')).toBeUndefined()
  })
  it('REJECTS a stale timestamp (>5 min skew — replay guard)', () => {
    const old = Math.floor(Date.now() / 1000) - 3600
    expect(verifyWebhook(payload, sign(payload, 'whsec_test', old), 'whsec_test')).toBeUndefined()
  })
  it('REJECTS when the secret or header is absent (fail-closed)', () => {
    expect(verifyWebhook(payload, sign(payload, 'whsec_test'), undefined)).toBeUndefined()
    expect(verifyWebhook(payload, undefined, 'whsec_test')).toBeUndefined()
  })
})
