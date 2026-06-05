import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SpecCard } from './SpecCard.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ReactElement } from 'react'

const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

describe('SpecCard', () => {
  it('renders the spec via Markdown (heading + bold)', () => {
    const { container } = renderI18n(<SpecCard spec={'# TODO App\n\nA **simple** list.'} onBuild={() => {}} />)
    expect(container.querySelector('h1')?.textContent).toBe('TODO App')
    expect(screen.getByText('simple').tagName).toBe('STRONG')
  })

  it('Approve calls onBuild with the exact spec text', async () => {
    const spec = '# TODO App\nbody'
    const onBuild = vi.fn()
    renderI18n(<SpecCard spec={spec} onBuild={onBuild} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve & Build' }))
    expect(onBuild).toHaveBeenCalledWith(spec)
  })

  it('lets the user edit the spec before approving the workflow', async () => {
    const onBuild = vi.fn()
    renderI18n(<SpecCard spec={'# TODO App\nbody'} onBuild={onBuild} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit spec' }))
    const editor = screen.getByLabelText('Edit spec')
    await userEvent.clear(editor)
    await userEvent.type(editor, '# Edited App{enter}Better body')
    await userEvent.click(screen.getByRole('button', { name: 'Save edits' }))
    expect(screen.getByRole('heading', { name: 'Edited App' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Approve & Build' }))
    expect(onBuild).toHaveBeenCalledWith('# Edited App\nBetter body')
  })

  it('locks the edited spec once that edited text starts the workflow', async () => {
    const onBuild = vi.fn()
    const { rerender } = renderI18n(<SpecCard spec={'# TODO App\nbody'} onBuild={onBuild} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit spec' }))
    await userEvent.clear(screen.getByLabelText('Edit spec'))
    await userEvent.type(screen.getByLabelText('Edit spec'), '# Edited App{enter}Better body')
    await userEvent.click(screen.getByRole('button', { name: 'Save edits' }))

    rerender(<I18nProvider><SpecCard spec={'# TODO App\nbody'} onBuild={onBuild} startedSpec={'# Edited App\nBetter body'} /></I18nProvider>)
    const btn = screen.getByRole('button', { name: 'Workflow started' })
    expect(btn).toBeDisabled()
  })

  it('while building: shows a disabled "Starting…" button (instant click feedback, no re-fire)', async () => {
    const onBuild = vi.fn()
    renderI18n(<SpecCard spec={'# TODO App\nbody'} onBuild={onBuild} building />)
    const btn = screen.getByRole('button', { name: /Starting/i })
    expect(btn).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Approve & Build' })).toBeNull()
    await userEvent.click(btn) // disabled → no-op
    expect(onBuild).not.toHaveBeenCalled()
  })

  it('after the workflow starts: locks the build action so the same spec cannot re-fire', async () => {
    const onBuild = vi.fn()
    renderI18n(<SpecCard spec={'# TODO App\nbody'} onBuild={onBuild} started />)
    const btn = screen.getByRole('button', { name: 'Workflow started' })
    expect(btn).toBeDisabled()
    await userEvent.click(btn)
    expect(onBuild).not.toHaveBeenCalled()
  })

  describe('Copy spec', () => {
    it('copies the current spec text to the clipboard', async () => {
      const writeText = vi.fn(() => Promise.resolve())
      Object.assign(navigator, { clipboard: { writeText } })
      const spec = '# TODO App\nbody'
      renderI18n(<SpecCard spec={spec} onBuild={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: 'Copy spec' }))
      expect(writeText).toHaveBeenCalledWith(spec)
    })

    it('copies the EDITED spec after a save (not the original)', async () => {
      const writeText = vi.fn(() => Promise.resolve())
      Object.assign(navigator, { clipboard: { writeText } })
      renderI18n(<SpecCard spec={'# TODO App\nbody'} onBuild={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: 'Edit spec' }))
      await userEvent.clear(screen.getByLabelText('Edit spec'))
      await userEvent.type(screen.getByLabelText('Edit spec'), '# Edited App{enter}Better body')
      await userEvent.click(screen.getByRole('button', { name: 'Save edits' }))
      await userEvent.click(screen.getByRole('button', { name: 'Copy spec' }))
      expect(writeText).toHaveBeenCalledWith('# Edited App\nBetter body')
    })
  })

  describe('Download .md', () => {
    let created: string[] = []
    let lastAnchor: HTMLAnchorElement | undefined
    let blobText = ''
    beforeEach(() => {
      created = []
      lastAnchor = undefined
      blobText = ''
      // Capture the Blob URL + the anchor click (jsdom has no real download).
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn((blob: Blob) => { void blob.text().then(t => { blobText = t }); created.push('blob:mock'); return 'blob:mock' }),
        revokeObjectURL: vi.fn(),
      })
      const origCreate = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = origCreate(tag)
        if (tag === 'a') { lastAnchor = el as HTMLAnchorElement; vi.spyOn(lastAnchor, 'click').mockImplementation(() => {}) }
        return el
      })
    })
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it('produces a .md download with the spec content and a slug filename', async () => {
      const spec = '# TODO App\nbody'
      renderI18n(<SpecCard spec={spec} onBuild={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: 'Download .md' }))
      expect(created).toContain('blob:mock')
      expect(lastAnchor?.download).toBe('todo-app.md')
      await Promise.resolve()
      expect(blobText).toBe(spec)
    })

    it('falls back to akis-spec.md when there is no title heading', async () => {
      renderI18n(<SpecCard spec={'just a body, no heading'} onBuild={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: 'Download .md' }))
      expect(lastAnchor?.download).toBe('akis-spec.md')
    })

    it('downloads the saved edited spec, not the original AKIS text', async () => {
      renderI18n(<SpecCard spec={'# TODO App\nbody'} onBuild={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: 'Edit spec' }))
      await userEvent.clear(screen.getByLabelText('Edit spec'))
      await userEvent.type(screen.getByLabelText('Edit spec'), '# Edited App{enter}Better body')
      await userEvent.click(screen.getByRole('button', { name: 'Save edits' }))
      await userEvent.click(screen.getByRole('button', { name: 'Download .md' }))
      expect(lastAnchor?.download).toBe('edited-app.md')
      await Promise.resolve()
      expect(blobText).toBe('# Edited App\nBetter body')
    })
  })
})
