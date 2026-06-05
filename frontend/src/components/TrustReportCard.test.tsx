import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TrustReportCard } from './TrustReportCard.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ApiClient } from '../api/client.js'

const MD = '# Trust Report — Demo App\n\n**🟡 SIMULATED — demo mode**\n'

function makeApi(md: string | Error = MD): ApiClient {
  return {
    getTrustReportMarkdown: vi.fn(() => md instanceof Error ? Promise.reject(md) : Promise.resolve(md)),
  } as unknown as ApiClient
}

const ui = (api: ApiClient) => render(
  <I18nProvider>
    <TrustReportCard sessionId="s1" api={api} />
  </I18nProvider>,
)

describe('TrustReportCard (client-facing exportable report)', () => {
  it('lazy-loads the markdown on first open and renders it as INERT text', async () => {
    const api = makeApi()
    ui(api)
    expect(api.getTrustReportMarkdown).not.toHaveBeenCalled() // closed ⇒ no fetch
    fireEvent.click(screen.getByRole('button', { name: /Trust report/ }))
    await waitFor(() => expect(screen.getByText(/SIMULATED — demo mode/)).toBeInTheDocument())
    expect(api.getTrustReportMarkdown).toHaveBeenCalledWith('s1')
    // Rendered inside a <pre> as plain text — markdown is NOT interpreted as HTML.
    expect(screen.getByText(/# Trust Report — Demo App/)).toBeInTheDocument()
  })

  it('Copy writes the artifact to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    ui(makeApi())
    fireEvent.click(screen.getByRole('button', { name: /Trust report/ }))
    await waitFor(() => screen.getByRole('button', { name: /Copy Markdown/ }))
    fireEvent.click(screen.getByRole('button', { name: /Copy Markdown/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MD))
  })

  it('a failed fetch shows the error state with a working Retry', async () => {
    const api = makeApi(new Error('boom'))
    ui(api)
    fireEvent.click(screen.getByRole('button', { name: /Trust report/ }))
    await waitFor(() => screen.getByText(/Could not load the report/))
    ;(api.getTrustReportMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(MD)
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(screen.getByText(/# Trust Report — Demo App/)).toBeInTheDocument())
  })
})
