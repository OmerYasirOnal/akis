import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { HistoryMenu } from './HistoryMenu.js'
import { HistoryPage } from '../pages/HistoryPage.js'
import { ChatStudio } from './ChatStudio.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import type { AkisEvent } from '@akis/shared'

const wrap = (ui: ReactNode) => <I18nProvider><RouterProvider>{ui}</RouterProvider></I18nProvider>

describe('HistoryMenu', () => {
  it('is visible and opens a dropdown of builds; clicking one calls onOpen', async () => {
    const onOpen = vi.fn()
    const builds = [{ id: 's1', idea: 'a todo app', ts: 0 }, { id: 's2', idea: 'a QR generator', ts: 0 }]
    render(<I18nProvider><HistoryMenu builds={builds} onOpen={onOpen} /></I18nProvider>)
    await userEvent.click(screen.getByRole('button', { name: /Builds/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'a QR generator' }))
    expect(onOpen).toHaveBeenCalledWith(builds[1])
  })
  it('shows an empty state when there are no builds', async () => {
    render(<I18nProvider><HistoryMenu builds={[]} onOpen={() => {}} /></I18nProvider>)
    await userEvent.click(screen.getByRole('button', { name: /Builds/ }))
    expect(screen.getByText(/No builds yet/)).toBeInTheDocument()
  })
  // P1-7: the menu carries the SAME minimal signal as the History page (localized status + ✓).
  it('shows a localized status pill + verified mark per build (not the raw enum)', async () => {
    const builds = [{ id: 's1', idea: 'a todo app', ts: 0, status: 'done', verified: true }]
    render(<I18nProvider><HistoryMenu builds={builds} onOpen={() => {}} /></I18nProvider>)
    await userEvent.click(screen.getByRole('button', { name: /Builds/ }))
    expect(screen.getByText('Shipped')).toBeInTheDocument()   // localized, not "done"
    expect(screen.queryByText('done')).toBeNull()
    expect(screen.getByText(/verified/)).toBeInTheDocument()
  })
  it('omits the status pill for a legacy build with no status (no crash)', async () => {
    const builds = [{ id: 's1', idea: 'a todo app', ts: 0 }]
    render(<I18nProvider><HistoryMenu builds={builds} onOpen={() => {}} /></I18nProvider>)
    await userEvent.click(screen.getByRole('button', { name: /Builds/ }))
    expect(screen.getByRole('menuitem', { name: /a todo app/ })).toBeInTheDocument()
  })

  // RESPONSIVE HEADER (mobile-first): below `sm` the trigger collapses to a compact icon button — the
  // visible "Builds" label is hidden (so the studio header fits one row at 320px) but the accessible
  // name is preserved via aria-label, and the tap box is a ≥44px square (WCAG 2.5.5).
  it('collapses to an icon-only ≥44px trigger below sm but keeps its accessible name (aria-label)', () => {
    render(<I18nProvider><HistoryMenu builds={[]} onOpen={() => {}} /></I18nProvider>)
    const trigger = screen.getByRole('button', { name: 'Builds' }) // accessible name still resolves
    expect(trigger).toHaveAttribute('aria-label', 'Builds')
    // The visible label is hidden below sm (returns at sm:inline), so the small-screen header stays tidy.
    const label = Array.from(trigger.querySelectorAll('span')).find(s => s.textContent === 'Builds')
    expect(label?.className).toContain('hidden')
    expect(label?.className).toContain('sm:inline')
    // ≥44px square tap target on mobile.
    expect(trigger.className).toContain('h-11')
    expect(trigger.className).toContain('min-w-11')
  })

  // MENU A11Y: roving keyboard nav (mirrors ModelPicker's focus-on-open + focus-restore).
  it('opens with the first item focused, ArrowDown moves focus, Escape closes + restores the trigger', async () => {
    const builds = [{ id: 's1', idea: 'a todo app', ts: 0 }, { id: 's2', idea: 'a QR generator', ts: 0 }]
    render(<I18nProvider><HistoryMenu builds={builds} onOpen={() => {}} /></I18nProvider>)
    const trigger = screen.getByRole('button', { name: /Builds/ }) // in-studio recent-builds dropdown trigger
    await userEvent.click(trigger)
    // On open, focus lands on the first menuitem (not left on the trigger / <body>).
    expect(screen.getByRole('menuitem', { name: /a todo app/ })).toHaveFocus()
    // ArrowDown rovers to the next item; ArrowUp clamps back to the first.
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: /a QR generator/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: /a todo app/ })).toHaveFocus()
    // End → last item; Home → first item.
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: /a QR generator/ })).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: /a todo app/ })).toHaveFocus()
    // Escape closes the menu AND returns focus to the trigger (keyboard users aren't dropped).
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })
})

describe('HistoryPage', () => {
  it('lists builds with idea + status and opens one via /?s=<id>', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => ([{ id: 's1', idea: 'a todo app', status: 'done', verified: true }]), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(wrap(<HistoryPage api={api} />))
    await waitFor(() => expect(screen.getByText('a todo app')).toBeInTheDocument())
    // P1-7: the status pill is now a localized human label ("Shipped"), not the raw enum "done".
    expect(screen.getByText('Shipped')).toBeInTheDocument()
    expect(screen.queryByText('done')).toBeNull()
    await userEvent.click(screen.getByText('a todo app'))
    expect(window.location.search).toBe('?s=s1')
  })
  it('renders a graceful empty state', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ([]), text: async () => '' } as unknown as Response))
    render(wrap(<HistoryPage api={new ApiClient('', fetchFn)} />))
    await waitFor(() => expect(screen.getByText(/No builds yet/)).toBeInTheDocument())
  })
})

/** A controllable fake stream client (EventStreamClient-shaped). */
class FakeStream {
  connectedUrl?: string
  private onEvent?: (e: AkisEvent, seq: number) => void
  connect(url: string, h: { onEvent: (e: AkisEvent, seq: number) => void }): void { this.connectedUrl = url; this.onEvent = h.onEvent }
  close(): void {}
  emit(e: AkisEvent, seq: number): void { this.onEvent?.(e, seq) }
}

describe('ChatStudio AKIS transcript persistence', () => {
  beforeEach(() => { window.history.replaceState({}, '', '/'); localStorage.clear() })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  it('keeps the persisted conversation visible in chat once the workflow starts', async () => {
    // Seed a prior "Ask AKIS" conversation (as AkisChat would have persisted it).
    localStorage.setItem('akis_chat_thread', JSON.stringify([
      { role: 'assistant', content: 'Hi, I’m AKIS.' },
      { role: 'user', content: 'a habit tracker' },
      { role: 'assistant', content: 'Great — here is the plan.' },
    ]))
    const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => ([]), text: async () => '' } as unknown as Response
      // Force the stream to fail → AkisChat falls back to the non-stream reply with the spec block.
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: 'Here is your spec 👇\n\n````akis-spec\n# Habit Tracker\nTrack daily habits.\n````' }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions') && (init as RequestInit | undefined)?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 's9', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(<I18nProvider><RouterProvider><ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} /></RouterProvider></I18nProvider>)

    // The only way to build is to talk to AKIS: it returns a spec card → approve it. The chat
    // stays mounted, and the workflow starts inside the same conversation context.
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build it{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Workflow started' })).toBeDisabled())
    await waitFor(() => expect(screen.getByText('Great — here is the plan.')).toBeInTheDocument())
    expect(screen.getAllByText('a habit tracker').length).toBeGreaterThan(0)
    expect(screen.getByLabelText(/ask akis/i)).toBeInTheDocument()
  })
})

describe('ChatStudio ?s= deep-link', () => {
  beforeEach(() => { window.history.replaceState({}, '', '/?s=s1') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  it('opens the deep-linked session on mount and connects to its event stream', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => ([{ id: 's1', idea: 'deep linked app', status: 'done', verified: true }]), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(<I18nProvider><RouterProvider><ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} /></RouterProvider></I18nProvider>)
    // The deep-linked session loads: its idea bubble appears and the live stream connects.
    await waitFor(() => expect(screen.getByText('deep linked app')).toBeInTheDocument())
    expect(fake.connectedUrl).toBe('/sessions/s1/events')
  })
})
