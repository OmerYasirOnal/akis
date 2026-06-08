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

  it('multi-run: the isSpecStarted predicate matches the EDITED current text, not the original fence', async () => {
    // The unified studio anchors started-state on the run markers (a Set of built spec texts) via
    // an isSpecStarted predicate. After editing then building, the run marker carries the EDITED
    // text — so the predicate must be evaluated against the card's CURRENT (edited) text, which is
    // the path the old single-`startedSpec` prop missed (it compared the ORIGINAL fence → re-build).
    const onBuild = vi.fn()
    const builtSpecs = new Set<string>()
    const isSpecStarted = (s: string): boolean => builtSpecs.has(s.trim())
    const { rerender } = renderI18n(<SpecCard spec={'# TODO App\nbody'} onBuild={onBuild} isSpecStarted={isSpecStarted} />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit spec' }))
    await userEvent.clear(screen.getByLabelText('Edit spec'))
    await userEvent.type(screen.getByLabelText('Edit spec'), '# Edited App{enter}Better body')
    await userEvent.click(screen.getByRole('button', { name: 'Save edits' }))
    // Before the build, the predicate matches nothing → still buildable.
    expect(screen.getByRole('button', { name: 'Approve & Build' })).toBeEnabled()
    // The build registers the EDITED text in the run-marker set; the card now reads "started".
    builtSpecs.add('# Edited App\nBetter body')
    rerender(<I18nProvider><SpecCard spec={'# TODO App\nbody'} onBuild={onBuild} isSpecStarted={isSpecStarted} /></I18nProvider>)
    expect(screen.getByRole('button', { name: 'Workflow started' })).toBeDisabled()
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

  describe('collapse once started (H1-Fix-B)', () => {
    it('a NOT-started card shows the full spec body (no Show-spec toggle)', () => {
      renderI18n(<SpecCard spec={'# TODO App\n\nA list.'} onBuild={() => {}} />)
      expect(screen.getByRole('heading', { name: 'TODO App' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Show spec' })).toBeNull()
    })

    it('a STARTED card collapses the body to a summary chip + Show-spec toggle by default', () => {
      renderI18n(<SpecCard spec={'# TODO App\n\nA list.'} onBuild={() => {}} started />)
      // The 60vh markdown body is hidden …
      expect(screen.queryByRole('heading', { name: 'TODO App' })).toBeNull()
      // … replaced by the one-line summary (the spec title) + the collapsed status + a Show toggle.
      expect(screen.getByText('TODO App')).toBeInTheDocument()
      expect(screen.getByText('Spec approved — building')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Show spec' })).toBeInTheDocument()
    })

    it('Show spec reveals the body; Hide spec re-collapses it', async () => {
      renderI18n(<SpecCard spec={'# TODO App\n\nA list.'} onBuild={() => {}} started />)
      await userEvent.click(screen.getByRole('button', { name: 'Show spec' }))
      expect(screen.getByRole('heading', { name: 'TODO App' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Hide spec' }))
      expect(screen.queryByRole('heading', { name: 'TODO App' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Show spec' })).toBeInTheDocument()
    })

    it('auto-collapses when a card TRANSITIONS to started while mounted', () => {
      const { rerender } = renderI18n(<SpecCard spec={'# TODO App\n\nA list.'} onBuild={() => {}} />)
      expect(screen.getByRole('heading', { name: 'TODO App' })).toBeInTheDocument()
      rerender(<I18nProvider><SpecCard spec={'# TODO App\n\nA list.'} onBuild={() => {}} started /></I18nProvider>)
      expect(screen.queryByRole('heading', { name: 'TODO App' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Show spec' })).toBeInTheDocument()
    })
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
