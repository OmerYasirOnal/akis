import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { STRINGS } from './catalog.js'
import { I18nProvider } from './I18nContext.js'
import { AgentWriteProposals } from '../components/AgentWriteProposals.js'
import type { ApiClient, ExternalWriteSummary } from '../api/client.js'

/**
 * NFR-confirm-cards-7: the agent-write (`aw.*`) confirm-card catalog must have FULL TR↔EN parity — every
 * key present under one locale is present under the other — AND the localized banners must INTERPOLATE
 * {n}/{base} at render (the component's `fill`), so a regressed translation never leaks a literal "{n}".
 */

const awKeys = (loc: 'en' | 'tr'): string[] => Object.keys(STRINGS[loc]).filter(k => k.startsWith('aw.'))

describe('aw.* i18n parity (NFR-confirm-cards-7)', () => {
  it('every EN aw.* key exists in TR (no missing translation)', () => {
    const tr = new Set(awKeys('tr'))
    const missingInTr = awKeys('en').filter(k => !tr.has(k))
    expect(missingInTr).toEqual([])
  })

  it('every TR aw.* key exists in EN (no orphaned / typo TR key)', () => {
    const en = new Set(awKeys('en'))
    const orphanedInTr = awKeys('tr').filter(k => !en.has(k))
    expect(orphanedInTr).toEqual([])
  })

  it('no aw.* value is an empty string in either locale (a blank cell would render nothing)', () => {
    for (const loc of ['en', 'tr'] as const) {
      for (const k of awKeys(loc)) {
        expect((STRINGS[loc] as Record<string, string>)[k], `${loc}:${k} must be non-empty`).not.toBe('')
      }
    }
  })

  it('placeholder parity: an EN aw.* template with {n}/{base} has the SAME placeholders in TR', () => {
    const placeholders = (s: string): string[] => (s.match(/\{(\w+)\}/g) ?? []).sort()
    for (const k of awKeys('en')) {
      const en = (STRINGS.en as Record<string, string>)[k] ?? ''
      const tr = (STRINGS.tr as Record<string, string>)[k] ?? ''
      expect(placeholders(tr), `placeholders for ${k} must match EN`).toEqual(placeholders(en))
    }
  })
})

function mergeProposal(): ExternalWriteSummary[] {
  return [{
    id: 'tr1', provider: 'github', action: 'merge_pull_request', summary: 'TR merge', status: 'proposed',
    target: { owner: 'me', repo: 'app', pullNumber: 42 }, payload: { merge_method: 'squash', base: 'release' },
    digest: 'm'.repeat(64), proposedAt: '2026-06-08T00:00:00Z',
  }]
}

function makeApi(writes: ExternalWriteSummary[]): ApiClient {
  return {
    listExternalWrites: vi.fn(() => Promise.resolve({ writes })),
    confirmExternalWrite: vi.fn(() => Promise.resolve({ ok: true, status: 'executed', result: 'merged' })),
  } as unknown as ApiClient
}

describe('aw.* TR render interpolation (NFR-confirm-cards-7)', () => {
  it('a merge banner under locale="tr" substitutes {n} and {base} — no literal "{n}"/"{base}" leaks', async () => {
    // initial="tr" forces TR because nothing is persisted in this fresh jsdom localStorage.
    render(<I18nProvider initial="tr"><AgentWriteProposals sessionId="s1" api={makeApi(mergeProposal())} pollMs={100000} /></I18nProvider>)
    await waitFor(() => expect(screen.getByText(/TR merge/)).toBeInTheDocument())
    // The TR banner template is 'GERİ ALINAMAZ … PR #{n}’i {base} dalına BİRLEŞTİRİR …'.
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toMatch(/PR #42/)        // {n} -> 42
    expect(banner.textContent).toMatch(/release/)        // {base} -> release
    expect(banner.textContent).not.toMatch(/\{n\}/)      // no un-substituted placeholder
    expect(banner.textContent).not.toMatch(/\{base\}/)
    // And it really is the TR string (not an EN fallback) — TR carries this distinctive word.
    expect(banner.textContent).toMatch(/BİRLEŞTİRİR|GERİ ALINAMAZ/)
  })
})
