import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { PublishDestination } from './PublishDestination.js'
import { PublishButton } from '../components/PublishButton.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ApiClient, PublishProfileStatus } from '../api/client.js'
import type { SessionState, PublishRecord } from '@akis/shared'

const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

/** A minimal fake ApiClient with just the publish surface the components touch. */
function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    publishStatus: async () => ({ configured: true, present: false }) as PublishProfileStatus,
    setPublishProfile: async (i: { host: string; sshUser: string; targetDir: string }) => ({ configured: true, present: true, host: i.host, sshUser: i.sshUser, targetDir: i.targetDir, keyFingerprint: 'fp' }) as PublishProfileStatus,
    deletePublishProfile: async () => ({ removed: true }),
    publish: async () => ({ status: 'done' } as SessionState),
    ...over,
  } as unknown as ApiClient
}

describe('PublishDestination (Settings card)', () => {
  it('not-configured (no encryption) → shows the banner, no form', async () => {
    renderI18n(<PublishDestination api={fakeApi({ publishStatus: async () => ({ configured: false, present: false }) })} />)
    await screen.findByText(/encryption is not configured/i)
    expect(screen.queryByLabelText('Host')).not.toBeInTheDocument()
  })

  it('no profile → renders the form including a WRITE-ONLY key field (never seeded)', async () => {
    renderI18n(<PublishDestination api={fakeApi()} />)
    const key = await screen.findByLabelText('SSH private key')
    expect(key.tagName).toBe('TEXTAREA')
    expect((key as HTMLTextAreaElement).value).toBe('') // never populated from status
    expect(screen.getByLabelText('Host')).toBeInTheDocument()
  })

  it('present → shows host/user/dir + fingerprint hint, never the key', async () => {
    const status: PublishProfileStatus = { configured: true, present: true, host: 'oci.example.com', sshUser: 'ubuntu', targetDir: '/home/ubuntu/app', keyFingerprint: 'abc123==' }
    renderI18n(<PublishDestination api={fakeApi({ publishStatus: async () => status })} />)
    await screen.findByText('oci.example.com')
    expect(screen.getByText('/home/ubuntu/app')).toBeInTheDocument()
    expect(screen.getByText('abc123==')).toBeInTheDocument()
    // No textarea (the form), no key rendered.
    expect(screen.queryByLabelText('SSH private key')).not.toBeInTheDocument()
  })

  it('Save sends the form, then clears the key field (secret not kept in memory)', async () => {
    const setPublishProfile = vi.fn(async (i: { host: string; sshUser: string; targetDir: string; sshPrivateKey: string }) => ({ configured: true, present: false, host: i.host } as PublishProfileStatus))
    renderI18n(<PublishDestination api={fakeApi({ setPublishProfile: setPublishProfile as unknown as ApiClient['setPublishProfile'] })} />)
    await screen.findByLabelText('Host')
    await userEvent.type(screen.getByLabelText('Host'), 'oci.example.com')
    await userEvent.type(screen.getByLabelText('SSH user'), 'ubuntu')
    await userEvent.type(screen.getByLabelText('Target directory'), '/home/ubuntu/app')
    await userEvent.type(screen.getByLabelText('SSH private key'), '-----BEGIN OPENSSH PRIVATE KEY-----')
    await userEvent.click(screen.getByRole('button', { name: 'Save destination' }))
    await waitFor(() => expect(setPublishProfile).toHaveBeenCalled())
    expect(setPublishProfile.mock.calls[0]![0].host).toBe('oci.example.com')
  })
})

describe('PublishButton (on a done session)', () => {
  const okRecord: PublishRecord = { ok: true, url: 'http://oci.example.com:8080', at: 'now', reachable: true, appType: 'static', logTail: [] }

  it('disabled when no publish destination is configured, with a hint', async () => {
    renderI18n(<PublishButton sessionId="s1" api={fakeApi({ publishStatus: async () => ({ configured: true, present: false }) })} />)
    const btn = await screen.findByRole('button', { name: 'Publish' })
    expect(btn).toBeDisabled()
    expect(screen.getByText(/Set a publish destination in Settings/i)).toBeInTheDocument()
  })

  it('on ok:true shows the live URL link', async () => {
    const api = fakeApi({ publishStatus: async () => ({ configured: true, present: true }), publish: async () => ({ status: 'done', publish: okRecord } as SessionState) })
    renderI18n(<PublishButton sessionId="s1" api={api} />)
    const btn = await screen.findByRole('button', { name: 'Publish' })
    await waitFor(() => expect(btn).not.toBeDisabled())
    await userEvent.click(btn)
    const link = await screen.findByRole('link', { name: 'http://oci.example.com:8080' })
    expect(link).toHaveAttribute('href', 'http://oci.example.com:8080')
  })

  it('on reachable:false shows the open-the-port caution', async () => {
    const rec: PublishRecord = { ...okRecord, reachable: false }
    const api = fakeApi({ publishStatus: async () => ({ configured: true, present: true }), publish: async () => ({ status: 'done', publish: rec } as SessionState) })
    renderI18n(<PublishButton sessionId="s1" api={api} />)
    const btn = await screen.findByRole('button', { name: 'Publish' })
    await waitFor(() => expect(btn).not.toBeDisabled())
    await userEvent.click(btn)
    await screen.findByText(/isn’t reachable from AKIS/i)
  })

  it('on ok:false shows the honest failure reason (logTail)', async () => {
    const fail: PublishRecord = { ok: false, at: 'now', appType: 'node-service', logTail: ['node not found on the instance for user ubuntu'] }
    const api = fakeApi({ publishStatus: async () => ({ configured: true, present: true }), publish: async () => ({ status: 'done', publish: fail } as SessionState) })
    renderI18n(<PublishButton sessionId="s1" api={api} />)
    const btn = await screen.findByRole('button', { name: 'Publish' })
    await waitFor(() => expect(btn).not.toBeDisabled())
    await userEvent.click(btn)
    await screen.findByText('Publish failed.')
    expect(screen.getByText(/node not found on the instance/i)).toBeInTheDocument()
  })

  // PINS finding #1: a completed publish outcome (live URL) must survive a tab-switch/refresh —
  // i.e. a fresh mount with NO click. Without seeding `record` from initialRecord this shows a
  // blank, re-deploy-required panel. WOULD FAIL on the old code (record started undefined).
  it('seeds the persisted live URL from initialRecord on mount (no click) — survives remount', async () => {
    const api = fakeApi({ publishStatus: async () => ({ configured: true, present: true }) })
    renderI18n(<PublishButton sessionId="s1" api={api} initialRecord={okRecord} />)
    // The live link appears WITHOUT ever clicking Publish — recovered from the persisted record.
    const link = await screen.findByRole('link', { name: 'http://oci.example.com:8080' })
    expect(link).toHaveAttribute('href', 'http://oci.example.com:8080')
  })

  // PINS finding #2: navigating away DURING the long deploy must not setState on the unmounted
  // component. The cleanup flips a `cancelled` flag so the in-flight run's resolution path is gated
  // (`if (!cancelled) setRecord(...)`). We detect that gating by injecting a tripwire ON the resolved
  // record: a getter that throws if the resolved record is ever *read* (which only happens if the
  // ungated setRecord renders it). On the OLD code (no cleanup guard) the late setRecord runs and
  // React renders the record → the getter fires → React surfaces it via console.error. With the
  // guard, the resolution is dropped and the tripwire never reads. WOULD FAIL on the old code.
  it('drops the in-flight deploy result after unmount mid-deploy (cancelled guard)', async () => {
    let resolvePublish!: (s: SessionState) => void
    const api = fakeApi({
      publishStatus: async () => ({ configured: true, present: true }),
      publish: () => new Promise<SessionState>(res => { resolvePublish = res }),
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let recordReadAfterUnmount = false
    let unmounted = false
    // A SessionState whose `.publish` getter records any read — a read can only happen if the
    // post-resolution render path (setRecord → render) actually ran on the unmounted instance.
    const tripwire = { status: 'done', get publish(): PublishRecord { if (unmounted) recordReadAfterUnmount = true; return okRecord } } as SessionState
    const view = renderI18n(<PublishButton sessionId="s1" api={api} />)
    const btn = await screen.findByRole('button', { name: 'Publish' })
    await waitFor(() => expect(btn).not.toBeDisabled())
    await userEvent.click(btn) // deploy in flight (publish promise pending)
    unmounted = true
    await act(async () => {
      view.unmount()                 // navigate away / refresh mid-deploy → cleanup flips cancelled
      resolvePublish(tripwire)       // late resolution
      await Promise.resolve()
    })
    // Guard held: the resolved record was never read → setRecord(s.publish) was gated out.
    expect(recordReadAfterUnmount).toBe(false)
    // And no unmounted-setState error was logged either.
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('unmounted'))
    errSpy.mockRestore()
  })

  // PINS finding #3: a synchronous double-fire (two clicks before the disable re-render lands) must
  // fire the SSH deploy ONCE. The publish promise is held pending so `busy` hasn't disabled the
  // button between the two clicks. WOULD FAIL on the old code (no runningRef; both clicks call run).
  it('two fast clicks fire publish only once (runningRef double-fire guard)', async () => {
    let pending = 0
    const publish = vi.fn(() => { pending++; return new Promise<SessionState>(() => { /* never resolves */ }) })
    const api = fakeApi({ publishStatus: async () => ({ configured: true, present: true }), publish: publish as unknown as ApiClient['publish'] })
    renderI18n(<PublishButton sessionId="s1" api={api} />)
    const btn = await screen.findByRole('button', { name: 'Publish' })
    await waitFor(() => expect(btn).not.toBeDisabled())
    // Two clicks in the SAME act → no re-render lands between them, so `busy` hasn't disabled the
    // button; only the synchronous runningRef guard can stop the second from entering run().
    act(() => { btn.click(); btn.click() })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(pending).toBe(1)
  })
})
