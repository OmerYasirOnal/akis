import type { ApiClient } from '../api/client.js'
import { AgentsTab } from '../agents/AgentsTab.js'
import { ProviderKeys } from './ProviderKeys.js'
import { AccountSettings } from './AccountSettings.js'
import { useAuth } from '../auth/AuthContext.js'
import { Card, SectionTitle, Button } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

/** Settings — account profile (with logout) above the agents/workflow + provider config.
 *  Reuses the existing AgentsTab so model/provider/workflow editing stays in one place. */
export function SettingsPage({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const { user, logout } = useAuth()
  return (
    <div className="flex flex-col gap-6">
      <SectionTitle sub={t('settings.sub')}>{t('settings.title')}</SectionTitle>

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

      <Card className="p-5">
        <AccountSettings api={api} />
      </Card>

      <Card className="p-5">
        <ProviderKeys api={api} />
      </Card>

      <Card className="p-5">
        <AgentsTab api={api} />
      </Card>
    </div>
  )
}
