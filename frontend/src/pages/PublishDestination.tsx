import { useEffect, useState } from 'react'
import type { ApiClient, PublishProfileStatus } from '../api/client.js'
import { SectionTitle, Button, Input, ErrorNote, Field } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * Per-user "publish destination" card (OCI free-tier). The owner sets the SSH key + host/user/dir/
 * port/url here so a `done` build can deploy to THEIR OWN server. The SSH private key is WRITE-ONLY:
 * it is sent on Save but NEVER returned, populated, or rendered (status carries only metadata + a
 * key fingerprint hint). Mirrors GitHubConnection.tsx.
 */
export function PublishDestination({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<PublishProfileStatus | undefined>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  // The form fields (the key is never seeded from status — write-only).
  const [host, setHost] = useState('')
  const [sshUser, setSshUser] = useState('')
  const [sshPrivateKey, setSshPrivateKey] = useState('')
  const [targetDir, setTargetDir] = useState('')
  const [appPort, setAppPort] = useState('')
  const [publicUrl, setPublicUrl] = useState('')

  // A FAILED status fetch is NOT the same as "encryption not configured" — keep status undefined
  // and surface the real error so a proxy/network problem never masquerades as a server-config one.
  const load = (): void => { void api.publishStatus().then(s => { setErr(undefined); setStatus(s) }).catch((e: unknown) => { setStatus(undefined); setErr(String(e)) }) }
  useEffect(load, [api])

  const save = async (): Promise<void> => {
    setBusy(true); setErr(undefined)
    try {
      const port = appPort.trim() ? Number(appPort.trim()) : undefined
      await api.setPublishProfile({
        host: host.trim(), sshUser: sshUser.trim(), sshPrivateKey, targetDir: targetDir.trim(),
        ...(port !== undefined && Number.isFinite(port) ? { appPort: port } : {}),
        ...(publicUrl.trim() ? { publicUrl: publicUrl.trim() } : {}),
      })
      setSshPrivateKey('') // clear the secret from memory after a successful save
      load()
    } catch (e) { setErr(String(e)) }
    finally { setBusy(false) }
  }

  const remove = async (): Promise<void> => {
    if (typeof window !== 'undefined' && !window.confirm(t('settings.publish.confirmRemove'))) return
    setBusy(true); setErr(undefined)
    try { await api.deletePublishProfile(); load() }
    catch (e) { setErr(String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div>
      <SectionTitle sub={t('settings.publish.sub')}>{t('settings.publish.title')}</SectionTitle>

      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}

      {/* In-flight first fetch (status undefined AND no error yet): an inline spinner row instead of a
          blank gap — mirrors HistoryPage. A failed fetch keeps status undefined but sets `err`, which
          renders above, so the spinner only shows during a genuine load. */}
      {status === undefined && !err ? (
        <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-4 text-sm text-slate-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#07D1AF]/40 border-t-[#07D1AF]" />
          {t('settings.loading')}
        </div>
      ) : status === undefined ? null : !status.configured ? (
        <div className="text-sm text-slate-400">{t('settings.publish.notConfigured')}</div>
      ) : status.present ? (
        <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <span className="text-slate-400">{t('settings.publish.host')}</span>
            <span className="font-mono text-slate-100">{status.host || '—'}</span>
            <span className="text-slate-400">{t('settings.publish.sshUser')}</span>
            <span className="font-mono text-slate-100">{status.sshUser || '—'}</span>
            <span className="text-slate-400">{t('settings.publish.targetDir')}</span>
            <span className="font-mono text-slate-100">{status.targetDir || '—'}</span>
            {status.appPort !== undefined && (<>
              <span className="text-slate-400">{t('settings.publish.appPort')}</span>
              <span className="font-mono text-slate-100">{status.appPort}</span>
            </>)}
            {status.publicUrl && (<>
              <span className="text-slate-400">{t('settings.publish.publicUrl')}</span>
              <span className="font-mono text-slate-100">{status.publicUrl}</span>
            </>)}
            {status.keyFingerprint && (<>
              <span className="text-slate-400">{t('settings.publish.keyFingerprint')}</span>
              <span className="truncate font-mono text-xs text-slate-300" title={status.keyFingerprint}>{status.keyFingerprint}</span>
            </>)}
          </div>
          <div>
            <Button variant="subtle" onClick={() => void remove()} disabled={busy}>{t('settings.publish.remove')}</Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Field label={t('settings.publish.host')} hint={t('settings.publish.hostHint')}>
            <Input aria-label={t('settings.publish.host')} value={host} placeholder="oci.example.com" onChange={e => setHost(e.target.value)} />
          </Field>
          <Field label={t('settings.publish.sshUser')} hint={t('settings.publish.sshUserHint')}>
            <Input aria-label={t('settings.publish.sshUser')} value={sshUser} placeholder="ubuntu" onChange={e => setSshUser(e.target.value)} />
          </Field>
          <Field label={t('settings.publish.targetDir')} hint={t('settings.publish.targetDirHint')}>
            <Input aria-label={t('settings.publish.targetDir')} value={targetDir} placeholder="/home/ubuntu/app" onChange={e => setTargetDir(e.target.value)} />
          </Field>
          <Field label={t('settings.publish.appPort')} hint={t('settings.publish.appPortHint')}>
            <Input aria-label={t('settings.publish.appPort')} value={appPort} placeholder="8080" inputMode="numeric" onChange={e => setAppPort(e.target.value)} />
          </Field>
          <Field label={t('settings.publish.publicUrl')} hint={t('settings.publish.publicUrlHint')}>
            <Input aria-label={t('settings.publish.publicUrl')} value={publicUrl} placeholder="http://oci.example.com:8080" onChange={e => setPublicUrl(e.target.value)} />
          </Field>
          <Field label={t('settings.publish.sshKey')} hint={t('settings.publish.sshKeyHint')}>
            {/* WRITE-ONLY: the key is never seeded from status nor echoed back. */}
            <textarea
              aria-label={t('settings.publish.sshKey')}
              value={sshPrivateKey}
              onChange={e => setSshPrivateKey(e.target.value)}
              rows={5}
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----'}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-[#07D1AF] focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/50"
            />
          </Field>
          <div>
            <Button type="submit" disabled={busy || !host.trim() || !sshUser.trim() || !targetDir.trim() || !sshPrivateKey.trim()}>
              {t('settings.publish.save')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
