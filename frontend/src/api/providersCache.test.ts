import { describe, it, expect, vi } from 'vitest'
import { getProvidersCached, getModeCached, invalidateProvidersCache } from './providersCache.js'
import type { ApiClient, ProviderInfo } from './client.js'

const PROVIDERS: ProviderInfo[] = [{ id: 'anthropic', label: 'Anthropic', available: true, defaultModel: 'claude-haiku-4-5-20251001', models: [] }]

function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    listProviders: vi.fn(() => Promise.resolve(PROVIDERS)),
    health: vi.fn(() => Promise.resolve({ ok: true, mode: 'live' } as Awaited<ReturnType<ApiClient['health']>>)),
    ...over,
  } as unknown as ApiClient
}

describe('providersCache (audit #41 — no per-remount refetch)', () => {
  it('fetches providers at most once per client across repeated reads (the remount win)', async () => {
    const api = fakeApi()
    const a = await getProvidersCached(api)
    const b = await getProvidersCached(api)
    expect(a).toBe(b) // same cached array
    expect(api.listProviders).toHaveBeenCalledTimes(1) // not re-fetched on the second mount
  })

  it('a DIFFERENT client never reuses another client\'s cache (per-instance isolation)', async () => {
    const a = fakeApi(); const b = fakeApi()
    await getProvidersCached(a)
    await getProvidersCached(b)
    expect(a.listProviders).toHaveBeenCalledTimes(1)
    expect(b.listProviders).toHaveBeenCalledTimes(1) // b fetched its own, did not reuse a's
  })

  it('invalidate forces a refetch (key change flips availability → must not stay stale)', async () => {
    const api = fakeApi()
    await getProvidersCached(api)
    invalidateProvidersCache(api)
    await getProvidersCached(api)
    expect(api.listProviders).toHaveBeenCalledTimes(2)
  })

  it('a rejected fetch clears its slot so the next read RETRIES (no poisoned cache)', async () => {
    const listProviders = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(PROVIDERS)
    const api = fakeApi({ listProviders })
    await expect(getProvidersCached(api)).rejects.toThrow('network')
    const ok = await getProvidersCached(api) // retries, succeeds
    expect(ok).toEqual(PROVIDERS)
    expect(listProviders).toHaveBeenCalledTimes(2)
  })

  it('getModeCached maps a known /health mode and caches it', async () => {
    const api = fakeApi()
    expect(await getModeCached(api)).toBe('live')
    await getModeCached(api)
    expect(api.health).toHaveBeenCalledTimes(1)
  })

  it('getModeCached returns undefined when /health reports no usable mode', async () => {
    const api = fakeApi({ health: vi.fn(() => Promise.resolve({ ok: true } as Awaited<ReturnType<ApiClient['health']>>)) })
    expect(await getModeCached(api)).toBeUndefined()
  })
})
