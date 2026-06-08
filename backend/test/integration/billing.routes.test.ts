import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { createHmac } from 'node:crypto'
import { registerBillingRoutes, applyStripeEvent } from '../../src/api/billing.routes.js'
import { UserStore } from '../../src/auth/UserStore.js'
import type { StripeFetch } from '../../src/billing/stripe.js'

const ENV = { PUBLIC_BASE_URL: 'https://akis.app', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_PRO: 'price_pro', STRIPE_WEBHOOK_SECRET: 'whsec_test' }

async function seedUser(store: UserStore): Promise<string> {
  const u = await store.create({ name: 'U', email: 'u@x.dev', passwordHash: '' })
  return u.id
}
function app(opts: { userId?: string; env?: Record<string, string | undefined>; http?: StripeFetch; store?: UserStore } = {}) {
  const store = opts.store ?? new UserStore()
  const f = Fastify({ logger: false })
  registerBillingRoutes(f, { users: store, env: opts.env ?? ENV, userIdOf: async () => opts.userId, ...(opts.http ? { http: opts.http } : {}) })
  return { f, store }
}
const okFetch = (body: unknown): StripeFetch => async () => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) })
function sig(raw: string, secret = 'whsec_test'): string {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`
}

describe('billing routes', () => {
  it('GET /billing/status — 401 anon; free by default; configured reflects env', async () => {
    expect((await app({}).f.inject({ method: 'GET', url: '/billing/status' })).statusCode).toBe(401)
    const { f, store } = app({ userId: 'pending' })
    const id = await seedUser(store); const a = app({ userId: id, store })
    const res = await a.f.inject({ method: 'GET', url: '/billing/status' })
    expect(res.json()).toEqual({ tier: 'free', configured: true, hasSubscription: false })
    void f
  })

  it('GET /billing/status — reports pro after a subscription', async () => {
    const store = new UserStore(); const id = await seedUser(store)
    await store.setSubscription(id, { tier: 'pro', stripeCustomerId: 'cus_1' })
    const res = await app({ userId: id, store }).f.inject({ method: 'GET', url: '/billing/status' })
    expect(res.json()).toMatchObject({ tier: 'pro', hasSubscription: true })
  })

  it('POST /billing/checkout — 401 anon; 503 unconfigured; returns the Stripe URL when configured', async () => {
    expect((await app({}).f.inject({ method: 'POST', url: '/billing/checkout' })).statusCode).toBe(401)
    const store = new UserStore(); const id = await seedUser(store)
    // unconfigured env ⇒ 503
    expect((await app({ userId: id, store, env: { PUBLIC_BASE_URL: 'https://akis.app' } }).f.inject({ method: 'POST', url: '/billing/checkout' })).statusCode).toBe(503)
    // configured ⇒ {url}
    const res = await app({ userId: id, store, http: okFetch({ id: 'cs_1', url: 'https://checkout.stripe.com/c/1' }) }).f.inject({ method: 'POST', url: '/billing/checkout' })
    expect(res.json()).toEqual({ url: 'https://checkout.stripe.com/c/1' })
  })

  it('POST /billing/webhook — rejects a bad signature (400), accepts a valid checkout.completed → user becomes pro', async () => {
    const store = new UserStore(); const id = await seedUser(store)
    const { f } = app({ store })
    // bad signature → 400, nothing changes
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: id, customer: 'cus_9' } } })
    expect((await f.inject({ method: 'POST', url: '/billing/webhook', headers: { 'stripe-signature': 't=1,v1=bad', 'content-type': 'application/json' }, payload: raw })).statusCode).toBe(400)
    expect((await store.findById(id))?.tier).toBeUndefined()
    // valid signature → 200 + the user is upgraded + the customer bound
    const ok = await f.inject({ method: 'POST', url: '/billing/webhook', headers: { 'stripe-signature': sig(raw), 'content-type': 'application/json' }, payload: raw })
    expect(ok.statusCode).toBe(200)
    const u = await store.findById(id)
    expect(u?.tier).toBe('pro')
    expect(u?.stripeCustomerId).toBe('cus_9')
  })
})

describe('applyStripeEvent (idempotent tier transitions)', () => {
  it('checkout.completed → pro+customer; subscription.deleted → free; updated(active) → pro', async () => {
    const store = new UserStore(); const id = await seedUser(store)
    await applyStripeEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: id, customer: 'cus_1' } } }, store)
    expect((await store.findById(id))?.tier).toBe('pro')
    // a cancel arrives keyed only by the customer id → mapped back → free
    await applyStripeEvent({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } }, store)
    expect((await store.findById(id))?.tier).toBe('free')
    // an updated(active) re-activates
    await applyStripeEvent({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1', status: 'active' } } }, store)
    expect((await store.findById(id))?.tier).toBe('pro')
    // re-applying the same completed event is idempotent (still pro, no throw)
    await applyStripeEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: id, customer: 'cus_1' } } }, store)
    expect((await store.findById(id))?.tier).toBe('pro')
  })
})
