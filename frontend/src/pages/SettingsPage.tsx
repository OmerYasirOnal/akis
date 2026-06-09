import type { ApiClient } from '../api/client.js'
import { AgentsTab } from '../agents/AgentsTab.js'
import { ProviderKeys } from './ProviderKeys.js'
import { BillingPlan } from './BillingPlan.js'
import { GitHubConnection } from './GitHubConnection.js'
import { McpConnections } from './McpConnections.js'
import { PublishDestination } from './PublishDestination.js'
import { AccountSettings } from './AccountSettings.js'
import { useAuth } from '../auth/AuthContext.js'
import { Card, SectionTitle, Button } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import { Link } from '../router/router.js'
import type { ReactNode } from 'react'

/** A labelled settings group — an uppercase caption over its cards — so the page reads as a
 *  designed control panel (Account / AI keys / Integrations / Agents) rather than a flat,
 *  equal-weight river of eight cards. Cards within a group sit closer (gap-4) than the gap
 *  BETWEEN groups (gap-8 on the page). */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="px-1 text-xs font-semibold uppercase tracking-widest text-slate-400">{label}</h3>
      {children}
    </section>
  )
}

/** Settings — account profile (with logout) above the agents/workflow + provider config.
 *  Reuses the existing AgentsTab so model/provider/workflow editing stays in one place. */
export function SettingsPage({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const { user, logout } = useAuth()
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <SectionTitle sub={t('settings.sub')}>{t('settings.title')}</SectionTitle>

      <Group label={t('settings.group.account')}>
        <Card className="flex items-center justify-between gap-4 p-5">
          <div className="flex items-center gap-4">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-base font-black text-slate-950">
              {(user?.name ?? '?').slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="font-semibold text-slate-100">{user?.name ?? '—'}</div>
              <div className="text-sm text-slate-400">{user?.email ?? ''}</div>
            </div>
          </div>
          <Button variant="ghost" onClick={() => void logout()}>{t('nav.logout')}</Button>
        </Card>
        <Card className="p-5"><AccountSettings api={api} /></Card>
        <BillingPlan api={api} />
      </Group>

      <Group label={t('settings.group.providers')}>
        <Card className="p-5"><ProviderKeys api={api} /></Card>
      </Group>

      <Group label={t('settings.group.integrations')}>
        <Card className="p-5"><GitHubConnection api={api} /></Card>
        <Card className="p-5"><McpConnections api={api} /></Card>
        <Card className="p-5"><PublishDestination api={api} /></Card>
      </Group>

      <Group label={t('settings.group.agents')}>
        <Card className="flex items-center justify-between gap-4 p-5">
          <div>
            <div className="font-semibold text-slate-100">{t('settings.workflows.title')}</div>
            <div className="text-sm text-slate-400">{t('settings.workflows.sub')}</div>
          </div>
          <Link
            to="/workflows"
            className="rounded-xl bg-gradient-to-r from-[#07D1AF] to-violet-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-[0_0_22px_rgba(7,209,175,0.35)] transition hover:brightness-110"
          >
            {t('settings.workflows.open')}
          </Link>
        </Card>
        <Card className="p-5"><AgentsTab api={api} /></Card>
      </Group>
    </div>
  )
}
