import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * One shared copy-to-clipboard icon button. Used wherever a surface holds user-visible text
 * the user might want to lift out (a code block, a chat reply, the spec, a file, the trust
 * digest) — single style, single behavior, single success label.
 *
 * The success state reuses the existing `report.copied` string ("Copied ✓") so we never add a
 * second "Copied" key. Because this calls `useI18n()`, every render site MUST be under an
 * <I18nProvider> (useI18n throws with no provider — intentional, see I18nContext).
 *
 * Clipboard failure (denied permission, no clipboard API) is a SILENT no-op — it never throws
 * into render and never leaves an unhandled rejection. The copied `text` is always already
 * user-visible content (spec/reply/code/evidence), so copying carries no new exposure; and the
 * button itself is inert chrome — it renders text via React children, never innerHTML.
 */
export function CopyButton({ text, label, className, chromeless = false }: { text: string; label: string; className?: string; chromeless?: boolean }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  // Cleared on unmount (Opus review): a streaming bubble or re-keyed card can unmount within
  // the 1.5s window — the timer must never set state on a dead component.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard denied — silent no-op */ }
  }
  // `chromeless` drops the standalone border/radius/padding/text-size so the button can sit INSIDE an
  // already-bordered cluster (e.g. the preview header action group) and inherit that container's one
  // border + radius scale — keeping "one border width" intact. Standalone call sites keep the default.
  const base = chromeless
    ? 'inline-flex items-center text-slate-200 transition hover:bg-white/[0.06]'
    : 'inline-flex items-center rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-white/[0.06]'
  return (
    <button
      type="button"
      onClick={() => void copy()}
      // aria-label IS the accessible name, so getByRole('button', { name }) resolves by the
      // localized label; it flips to "Copied ✓" on success (no redundant sr-only node needed).
      aria-label={copied ? t('report.copied') : label}
      className={`${base} ${className ?? ''}`}
    >
      <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
    </button>
  )
}
