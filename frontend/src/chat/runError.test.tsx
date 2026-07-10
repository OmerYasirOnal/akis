import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { runErrorKey } from './runError.js'
import { ErrorBubble } from './ChatThread.js'
import { foldRunBubbles } from './chatModel.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { AkisEvent } from '@akis/shared'

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

describe('runErrorKey (pure code → catalog-key mapping, B6-ii)', () => {
  it('maps the orchestrator error codes; CRITIC_* codes share one key; unknown/absent stays unmapped', () => {
    expect(runErrorKey('PushFailed')).toBe('run.error.pushFailed')
    expect(runErrorKey('RunFailed')).toBe('run.error.runFailed')
    expect(runErrorKey('CRITIC_AI_ERROR')).toBe('run.error.critic')
    expect(runErrorKey('CRITIC_PARSE_ERROR')).toBe('run.error.critic')
    expect(runErrorKey('SomethingNew')).toBeUndefined()
    expect(runErrorKey(undefined)).toBeUndefined()
  })
})

describe('chatModel — the error fold carries the machine code through (B6-ii)', () => {
  it('an error event with a code folds into an ErrorMsg with that code; a code-less one stays code-less', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'error', message: 'push failed: HTTP 502', code: 'PushFailed' }),
      ev({ kind: 'error', message: 'legacy boom' }),
    ])
    const errs = msgs.filter(m => m.kind === 'error') as Array<{ text: string; code?: string }>
    expect(errs).toHaveLength(2)
    expect(errs[0]).toMatchObject({ text: 'push failed: HTTP 502', code: 'PushFailed' })
    expect(errs[1]!.code).toBeUndefined()
  })
})

describe('ErrorBubble — localized headline for a coded error, raw detail kept (B6-ii)', () => {
  it("code 'PushFailed' renders the catalog headline plus the raw transport line as secondary detail", () => {
    render(<I18nProvider><ErrorBubble m={{ id: 'e1', kind: 'error', text: 'push failed: HTTP 502', code: 'PushFailed' }} /></I18nProvider>)
    // EN default locale in tests: the localized headline, not only the raw line…
    expect(screen.getByText(/The push to GitHub failed/)).toBeInTheDocument()
    // …with the raw technical detail still visible (honesty — nothing is hidden).
    expect(screen.getByText('push failed: HTTP 502')).toBeInTheDocument()
  })

  it('an unknown/absent code keeps today’s raw-only rendering (no invented copy)', () => {
    render(<I18nProvider><ErrorBubble m={{ id: 'e2', kind: 'error', text: 'weird one-off' }} /></I18nProvider>)
    expect(screen.getByText('weird one-off')).toBeInTheDocument()
    expect(screen.queryByText(/The push to GitHub failed/)).toBeNull()
  })
})
