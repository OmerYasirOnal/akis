import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select } from './kit.js'

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
    // Shared design-system teal focus state (matches Input).
    expect(cls).toContain('focus:border-[#07D1AF]')
    expect(cls).toContain('focus:ring-[#07D1AF]/40')
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
