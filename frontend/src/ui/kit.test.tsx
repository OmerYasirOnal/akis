import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select, Button } from './kit.js'

describe('Select (design-system)', () => {
  it('renders a real, keyboard-accessible <select> carrying its options', () => {
    render(
      <Select aria-label="provider" defaultValue="b">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    )
    const el = screen.getByLabelText('provider')
    expect(el.tagName).toBe('SELECT')
    // A native <select> is inherently focusable/keyboard-navigable (no tabIndex hack).
    expect(el).not.toHaveAttribute('tabindex')
    expect((el as HTMLSelectElement).value).toBe('b')
  })

  it('applies the design-system surface + teal focus ring and drops the default browser chrome', () => {
    render(
      <Select aria-label="model">
        <option value="x">X</option>
      </Select>,
    )
    const el = screen.getByLabelText('model')
    const cls = el.className
    // Custom chevron requires hiding the native one.
    expect(cls).toContain('appearance-none')
    // Shared design-system teal focus state (matches Input): a 2px /50 ring so keyboard
    // focus is clearly visible on the dark surface (WCAG 2.4.7), not a faint 1px hint.
    expect(cls).toContain('focus:border-[#07D1AF]')
    expect(cls).toContain('focus:ring-2')
    expect(cls).toContain('focus:ring-[#07D1AF]/50')
    expect(cls).toContain('focus:outline-none')
  })

  it('merges caller className and forwards change events', async () => {
    const onChange = vi.fn()
    render(
      <Select aria-label="role" className="w-full" onChange={onChange}>
        <option value="p">P</option>
        <option value="q">Q</option>
      </Select>,
    )
    const el = screen.getByLabelText('role')
    expect(el.className).toContain('w-full')
    await userEvent.selectOptions(el, 'q')
    expect(onChange).toHaveBeenCalled()
  })
})

describe('Button (design-system)', () => {
  it('carries a keyboard-only focus-visible ring so keyboard users see focus (a11y)', () => {
    // Icon-only / text buttons across the studio share this primitive; without a
    // focus-visible state keyboard users get no visible focus indicator. Use
    // focus-visible (not focus:) so the ring shows for keyboard nav, not mouse clicks.
    render(<Button>Build</Button>)
    const cls = screen.getByRole('button', { name: 'Build' }).className
    expect(cls).toContain('focus-visible:outline-none')
    expect(cls).toContain('focus-visible:ring-2')
    // Pin the EXACT ring token (incl. the /60 opacity) and the offset that makes the ring
    // visible on the dark surface — a substring-only check would let either silently weaken.
    expect(cls).toContain('focus-visible:ring-[#07D1AF]/60')
    expect(cls).toContain('ring-offset-slate-950')
  })

  it('keeps the focus-visible ring across every variant', () => {
    for (const variant of ['primary', 'ghost', 'subtle'] as const) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>)
      const cls = screen.getByRole('button', { name: variant }).className
      expect(cls).toContain('focus-visible:ring-2')
      unmount()
    }
  })
})
