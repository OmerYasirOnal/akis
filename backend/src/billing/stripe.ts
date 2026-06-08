import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Minimal RAW-HTTP Stripe client — NO `stripe` npm dependency (mirrors how githubConnect talks to the
 * GitHub REST API with plain fetch, keeping the clean zero-extra-dep story). Everything is env-driven so
 * the paid tier is DORMANT until the owner configures Stripe (exactly like the OAuth providers):
 *   - STRIPE_SECRET_KEY   (sk_test_… / sk_live_…) — Bearer auth; absent ⇒ billing is "not configured".
 *   - STRIPE_PRICE_PRO    (price_…)               — the recurring Price the Pro checkout subscribes to.
 *   - STRIPE_WEBHOOK_SECRET (whsec_…)             — verifies the Stripe-Signature on the webhook.
 * The secret key is sent only as a Bearer header to api.stripe.com — never logged, never echoed.
 */
const STRIPE_API = 'https://api.stripe.com/v1'

export type StripeFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>

const realFetch: StripeFetch = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<StripeFetch>

/** True iff the owner has configured Stripe (a secret key AND a Pro price) — gates the UI + routes. */
export function stripeConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_PRO)
}

function form(params: Record<string, string>): string {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

async function post(env: Record<string, string | undefined>, path: string, params: Record<string, string>, http: StripeFetch): Promise<Record<string, unknown>> {
  const res = await http(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY ?? ''}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form(params),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.status < 200 || res.status >= 300) {
    // Surface a SHORT, non-secret reason; never include the request (which carries no secret anyway).
    const msg = (body.error as { message?: string } | undefined)?.message ?? `stripe ${res.status}`
    throw new StripeError(msg)
  }
  return body
}

export class StripeError extends Error { constructor(m: string) { super(m); this.name = 'StripeError' } }

/** Create a Checkout Session for the Pro subscription. `client_reference_id` = our userId so the
 *  webhook can map the completed checkout back to the user. Returns the hosted-checkout URL. */
export async function createProCheckout(
  env: Record<string, string | undefined>,
  opts: { userId: string; email?: string; customerId?: string; successUrl: string; cancelUrl: string },
  http: StripeFetch = realFetch,
): Promise<{ id: string; url: string }> {
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': env.STRIPE_PRICE_PRO ?? '',
    'line_items[0][quantity]': '1',
    client_reference_id: opts.userId,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    allow_promotion_codes: 'true',
  }
  // Reuse an existing Stripe customer when known (so a user doesn't accumulate duplicate customers);
  // else let Stripe create one from the email.
  if (opts.customerId) params.customer = opts.customerId
  else if (opts.email) params.customer_email = opts.email
  const body = await post(env, '/checkout/sessions', params, http)
  return { id: String(body.id ?? ''), url: String(body.url ?? '') }
}

/** Create a Billing Portal session so a Pro user can manage/cancel their subscription on Stripe. */
export async function createPortal(
  env: Record<string, string | undefined>,
  opts: { customerId: string; returnUrl: string },
  http: StripeFetch = realFetch,
): Promise<{ url: string }> {
  const body = await post(env, '/billing_portal/sessions', { customer: opts.customerId, return_url: opts.returnUrl }, http)
  return { url: String(body.url ?? '') }
}

export interface StripeEvent { type: string; data: { object: Record<string, unknown> } }

/**
 * Verify the `Stripe-Signature` header against the RAW request body + the webhook secret, then parse the
 * event. Returns the event ONLY if the signature is valid + within the 5-min tolerance (replay guard);
 * else undefined. HMAC-SHA256 over `${t}.${payload}`, timing-safe compared — identical discipline to the
 * JWT/OAuth-state verifiers in this codebase. NEVER trust an unverified webhook (it grants Pro access).
 */
export function verifyWebhook(rawBody: string, sigHeader: string | undefined, secret: string | undefined, nowMs = Date.now()): StripeEvent | undefined {
  if (!secret || !sigHeader) return undefined
  const parts = sigHeader.split(',').map(p => p.split('=', 2) as [string, string])
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  // Stripe may send MULTIPLE v1 signatures during a webhook-secret rotation — accept if ANY matches.
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!Number.isFinite(t) || v1s.length === 0) return undefined
  if (Math.abs(nowMs / 1000 - t) > 300) return undefined // >5 min skew ⇒ reject (replay guard)
  const a = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'))
  const valid = v1s.some(v1 => { const b = Buffer.from(v1); return a.length === b.length && timingSafeEqual(a, b) })
  if (!valid) return undefined
  try {
    const ev = JSON.parse(rawBody) as StripeEvent
    return ev && typeof ev.type === 'string' && ev.data && typeof ev.data === 'object' ? ev : undefined
  } catch { return undefined }
}
