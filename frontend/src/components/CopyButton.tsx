import { useState } from 'react'
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
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard denied — silent no-op */ }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      // aria-label IS the accessible name, so getByRole('button', { name }) resolves by the
      // localized label; it flips to "Copied ✓" on success (no redundant sr-only node needed).
      aria-label={copied ? t('report.copied') : label}
      className={`inline-flex items-center rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-white/[0.06] ${className ?? ''}`}
    >
      <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
    </button>
  )
}
