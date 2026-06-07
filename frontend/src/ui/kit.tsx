import type { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react'

/** One shared visual language for the whole studio so every page/component matches:
 *  glass surfaces, the AKIS teal→violet gradient, consistent inputs/buttons. */

export function Card({ children, className = '', glow = false }: { children: ReactNode; className?: string; glow?: boolean }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-sm ${glow ? 'shadow-[0_0_60px_rgba(7,209,175,0.10)]' : ''} ${className}`}>
      {children}
    </div>
  )
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold text-slate-100">{children}</h2>
      {sub && <p className="text-sm text-slate-400">{sub}</p>}
    </div>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'subtle'; full?: boolean }
export function Button({ variant = 'primary', full, className = '', ...rest }: ButtonProps) {
  // focus-visible (keyboard-only) teal ring so keyboard users get a visible focus indicator
  // on every button across the studio, without showing the ring on mouse clicks.
  const base = 'rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950'
  const styles = {
    primary: 'bg-gradient-to-r from-[#07D1AF] to-violet-500 text-slate-950 shadow-[0_0_22px_rgba(7,209,175,0.35)] hover:brightness-110',
    ghost: 'border border-white/15 bg-white/[0.03] text-slate-200 hover:border-white/30',
    subtle: 'text-slate-400 hover:text-slate-200',
  }[variant]
  return <button className={`${base} ${styles} ${full ? 'w-full' : ''} ${className}`} {...rest} />
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  // The hint lives OUTSIDE the <label> so it doesn't pollute the control's accessible
  // name (the label text alone names the input).
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">{label}</span>
        {children}
      </label>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </div>
  )
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-slate-100 placeholder:text-slate-500 focus:border-[#07D1AF] focus:outline-none focus:ring-1 focus:ring-[#07D1AF]/40 ${className}`}
      {...rest}
    />
  )
}

// An inline SVG chevron (teal-tinted), used as the custom dropdown indicator so we can drop
// the default browser arrow via `appearance-none`. Kept as a data-URI background so it needs
// no extra DOM and inherits the control's padding.
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2307D1AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")"

/** A native <select> dressed in the shared design language (glass surface + teal focus ring,
 *  custom chevron). It stays a real <select>, so keyboard/AT navigation is unchanged.
 *  `color-scheme:'dark'` keeps the native option popup readable on our dark surface. */
export function Select({ className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={`w-full appearance-none rounded-xl border border-white/10 bg-white/[0.04] bg-no-repeat py-2.5 pl-3 pr-9 text-slate-100 focus:border-[#07D1AF] focus:outline-none focus:ring-1 focus:ring-[#07D1AF]/40 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      // Merge AFTER the spread so a caller's `style` augments rather than clobbers the chevron +
      // dark color-scheme (mirrors the `className` merge contract above).
      style={{
        colorScheme: 'dark',
        backgroundImage: CHEVRON,
        backgroundPosition: 'right 0.75rem center',
        ...rest.style,
      }}
    />
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{children}</div>
}

/** A stat tile used across Analytics / Settings for a unified dashboard look. */
export function Stat({ label, value, accent = false }: { label: ReactNode; value: ReactNode; accent?: boolean }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${accent ? 'text-[#07D1AF]' : 'text-slate-100'}`}>{value}</div>
    </Card>
  )
}
