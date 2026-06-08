import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { UserStorePort } from '../auth/UserStore.js'
import { baseUrl } from './oauth.routes.js'
import { stripeConfigured, createProCheckout, createPortal, verifyWebhook, StripeError, type StripeFetch, type StripeEvent } from '../billing/stripe.js'

export interface BillingDeps {
  users: UserStorePort
  env: NodeJS.ProcessEnv
  /** Resolve the authenticated user id (cookie session). */
  userIdOf: (req: FastifyRequest) => Promise<string | undefined>
  /** Injectable Stripe HTTP for tests; defaults to the real fetch inside the client. */
  http?: StripeFetch
}

/** Apply a verified Stripe event to the user's tier. Idempotent (re-applying the same tier is a no-op).
 *  checkout.session.completed → Pro + bind the customer; subscription.deleted → Free; .updated → by status. */
export async function applyStripeEvent(ev: StripeEvent, users: UserStorePort): Promise<void> {
  const obj = ev.data.object
  const customer = obj.customer ? String(obj.customer) : undefined
  if (ev.type === 'checkout.session.completed') {
    const userId = obj.client_reference_id ? String(obj.client_reference_id) : ''
    if (userId) await users.setSubscription(userId, { tier: 'pro', ...(customer ? { stripeCustomerId: customer } : {}) })
    return
  }
  if (ev.type === 'customer.subscription.deleted') {
    const u = customer ? await users.findByStripeCustomerId(customer) : undefined
    if (u) await users.setSubscription(u.id, { tier: 'free' })
    return
  }
  if (ev.type === 'customer.subscription.updated') {
    const status = String(obj.status ?? '')
    const u = customer ? await users.findByStripeCustomerId(customer) : undefined
    if (u) await users.setSubscription(u.id, { tier: status === 'active' || status === 'trialing' ? 'pro' : 'free' })
  }
}

/**
 * Paid-tier billing routes. DORMANT until Stripe is configured (STRIPE_SECRET_KEY + STRIPE_PRICE_PRO):
 * /status reports configured:false and the FE hides the Upgrade button, so nothing breaks unconfigured.
 * The secret key never leaves the Stripe client (Bearer only); routes return only non-secret data.
 */
export function registerBillingRoutes(app: FastifyInstance, deps: BillingDeps): void {
  const unauthorized = (reply: import('fastify').FastifyReply): import('fastify').FastifyReply => reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })

  // Owner-scoped tier + whether billing is even configured (so the UI never shows a dead Upgrade button).
  app.get('/billing/status', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return unauthorized(reply)
    const user = await deps.users.findById(userId)
    return { tier: user?.tier === 'pro' ? 'pro' : 'free', configured: stripeConfigured(deps.env), hasSubscription: !!user?.stripeCustomerId }
  })

  // Start the Pro checkout — returns the hosted Stripe Checkout URL the FE redirects to.
  app.post('/billing/checkout', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return unauthorized(reply)
    if (!stripeConfigured(deps.env)) return reply.code(503).send({ error: 'billing not configured', code: 'BillingNotConfigured' })
    const user = await deps.users.findById(userId)
    if (!user) return unauthorized(reply)
    const base = baseUrl(req, deps.env)
    try {
      const { url } = await createProCheckout(deps.env, {
        userId, email: user.email, ...(user.stripeCustomerId ? { customerId: user.stripeCustomerId } : {}),
        successUrl: `${base}/settings?billing=success`, cancelUrl: `${base}/settings?billing=cancel`,
      }, deps.http)
      return { url }
    } catch (e) {
      return reply.code(502).send({ error: e instanceof StripeError ? e.message : 'checkout failed', code: 'StripeError' })
    }
  })

  // Stripe Billing Portal — a Pro user manages/cancels their subscription.
  app.post('/billing/portal', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return unauthorized(reply)
    const user = await deps.users.findById(userId)
    if (!user?.stripeCustomerId) return reply.code(400).send({ error: 'no subscription', code: 'NoSubscription' })
    const base = baseUrl(req, deps.env)
    try {
      const { url } = await createPortal(deps.env, { customerId: user.stripeCustomerId, returnUrl: `${base}/settings` }, deps.http)
      return { url }
    } catch (e) {
      return reply.code(502).send({ error: e instanceof StripeError ? e.message : 'portal failed', code: 'StripeError' })
    }
  })

  // Webhook — encapsulated scope with a RAW-string body parser so the Stripe-Signature can be verified
  // over the exact bytes. NEVER trust an unverified webhook (it grants Pro). No auth cookie (Stripe→us).
  void app.register(async scope => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))
    scope.post('/billing/webhook', async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : ''
      const ev = verifyWebhook(raw, req.headers['stripe-signature'] as string | undefined, deps.env.STRIPE_WEBHOOK_SECRET)
      if (!ev) return reply.code(400).send({ error: 'invalid signature' })
      try { await applyStripeEvent(ev, deps.users) } catch { /* a store hiccup must not 500 Stripe into infinite retries on a handled event */ }
      return { received: true }
    })
  })
}
