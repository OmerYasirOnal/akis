import type { ReactNode } from 'react'
import { Card } from '../ui/kit.js'

/** Centered, branded container for the Login/Signup flows (logo + title over the
 *  cosmic backdrop). Keeps both auth pages visually identical. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-[80vh] place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="/akis-logo.png" alt="AKIS" className="mb-3 h-14 w-14 rounded-2xl shadow-[0_0_40px_rgba(7,209,175,0.45)]" />
          <h1 className="bg-gradient-to-r from-[#07D1AF] via-cyan-200 to-violet-300 bg-clip-text text-2xl font-extrabold text-transparent">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
        </div>
        <Card glow className="p-6">{children}</Card>
        {footer && <div className="mt-4 text-center text-sm text-slate-400">{footer}</div>}
      </div>
    </div>
  )
}
