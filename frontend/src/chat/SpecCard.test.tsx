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

  describe('Download .md', () => {
    let created: string[] = []
    let lastAnchor: HTMLAnchorElement | undefined
    let blobText = ''
    beforeEach(() => {
      created = []
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
  })
})
