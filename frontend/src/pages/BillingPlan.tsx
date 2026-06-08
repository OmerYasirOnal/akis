import { useEffect, useState } from 'react'
import type { ApiClient, BillingStatus } from '../api/client.js'
import { SectionTitle, Button, ErrorNote } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

/** Settings → Plan. Shows the caller's tier (Free/Pro). When Stripe is configured, a Free user gets an
 *  "Upgrade to Pro" button (→ hosted Stripe Checkout) and a Pro user gets "Manage" (→ Stripe portal).
 *  When billing is NOT configured the actions are hidden — the card just shows the current (Free) plan,
 *  so a self-host deployment with no Stripe never sees a dead button. Reads the ?billing= post-redirect
 *  signal once and strips it. */
export function BillingPlan({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<BillingStatus | undefined>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  const [banner, setBanner] = useState<'success' | 'cancel' | undefined>()

  const load = (): void => { void api.billingStatus().then(setStatus).catch(() => setStatus({ tier: 'free', configured: false, hasSubscription: false })) }
  useEffect(load, [api])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const b = new URLSearchParams(window.location.search).get('billing')
    if (b === 'success' || b === 'cancel') {
      setBanner(b)
      const url = new URL(window.location.href); url.searchParams.delete('billing'); window.history.replaceState({}, '', url.toString())
    }
  }, [])

  const go = async (which: 'checkout' | 'portal'): Promise<void> => {
    setBusy(true); setErr(undefined)
    try {
      const { url } = which === 'checkout' ? await api.startCheckout() : await api.billingPortal()
      if (url) window.location.href = url
    } catch (e) { setErr(String(e)); setBusy(false) }
  }

  const tier = status?.tier ?? 'free'
  return (
    <div>
      <SectionTitle sub={t('billing.sub')}>{t('billing.title')}</SectionTitle>
      {banner && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-sm ${banner === 'success' ? 'border-[#07D1AF]/30 bg-[#07D1AF]/10 text-[#07D1AF]' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`} role="status">
          {t(banner === 'success' ? 'billing.ok.success' : 'billing.ok.cancel')}
        </div>
      )}
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="min-w-0">
          <div className="font-semibold text-slate-100">
            {t('billing.plan')}: <span className={tier === 'pro' ? 'text-[#07D1AF]' : 'text-slate-300'}>{t(tier === 'pro' ? 'billing.tier.pro' : 'billing.tier.free')}</span>
          </div>
          <div className="truncate text-sm text-slate-400">{t(tier === 'pro' ? 'billing.blurb.pro' : 'billing.blurb.free')}</div>
        </div>
        {status?.configured && tier === 'free' && (
          <Button onClick={() => void go('checkout')} disabled={busy}>{busy ? '…' : t('billing.upgrade')}</Button>
        )}
        {status?.configured && tier === 'pro' && status.hasSubscription && (
          <Button variant="ghost" onClick={() => void go('portal')} disabled={busy}>{busy ? '…' : t('billing.manage')}</Button>
        )}
      </div>
    </div>
  )
}
