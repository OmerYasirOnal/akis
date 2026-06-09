import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../i18n/I18nContext.js'
import type { ProviderInfo } from '../api/client.js'
import type { Effort } from './ModelChip.js'

export interface ModelSelection {
  provider: string
  model: string
  effort: Effort
}

export interface ModelPickerProps {
  providers: ProviderInfo[]
  /** The currently-applied selection (defaults the radios). */
  selected: ModelSelection
  /** Apply the chosen {provider, model, effort}. The parent persists + closes. */
  onSelect: (selection: ModelSelection) => void
  onClose?: () => void
}

const EFFORTS: Effort[] = ['fast', 'balanced', 'deep']

/** The dom id the popover carries so the trigger chip can point aria-controls at it. */
export const MODEL_POPOVER_ID = 'akis-model-popover'

/**
 * A custom (NOT native <select>) model + effort picker, shown as an ANCHORED POPOVER inside the
 * composer (P1.3 — was a full-screen modal). Models are grouped by provider with a `recommended`
 * badge on flagged ones; effort is a three-way radio (fast/balanced/deep). The choice is LOCAL
 * until Apply, so the user can cancel without committing. CHAT-ONLY: the parent applies this to
 * chat requests only. The parent renders this inside a `relative` wrapper that also holds the
 * trigger chip, so the absolute panel anchors to that chip.
 */
export function ModelPicker({ providers, selected, onSelect, onClose }: ModelPickerProps) {
  const { t } = useI18n()
  const [provider, setProvider] = useState(selected.provider)
  const [model, setModel] = useState(selected.model)
  const [effort, setEffort] = useState<Effort>(selected.effort)

  // Don't let a stale/unavailable provider selection be committed (functional fix): applying one
  // would make every request 400 (NoKey). The Apply button is disabled when the chosen provider is
  // unavailable, and apply() guards as a backstop.
  const chosenAvailable = providers.find(p => p.id === provider)?.available !== false
  const apply = (): void => {
    if (!chosenAvailable) return
    onSelect({ provider, model, effort })
    onClose?.()
  }

  // POPOVER A11Y (#10, kept through the modal→popover move): Escape closes; focus moves INTO the
  // dialog on open + is RESTORED to the prior element (the trigger chip) on close; Tab is TRAPPED
  // inside the dialog; an OUTSIDE pointerdown dismisses (no commit). role=dialog markup — no lib.
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = dialogRef.current
    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')) : []
    focusables()[0]?.focus() // focus the first control on open
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      if (f.length === 0) return
      const first = f[0]!, last = f[f.length - 1]!
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    // Outside-click dismiss: a pointerdown OUTSIDE the panel closes it. Guard for the trigger chip —
    // it lives OUTSIDE the panel but its own onClick toggles open, so closing here AND toggling there
    // would re-open; the chip carries [aria-haspopup="dialog"], so we skip the dismiss for it and let
    // its toggle own the transition.
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (!panel || !target) return
      if (panel.contains(target)) return
      if (target instanceof Element && target.closest('[aria-haspopup="dialog"]')) return
      onClose?.()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
      prevFocus?.focus()
    }
  }, [onClose])

  return (
    <div
      ref={dialogRef}
      id={MODEL_POPOVER_ID}
      role="dialog"
      aria-modal="false"
      aria-label={t('chat.picker.title')}
      // ANCHORED POPOVER: absolutely positioned just ABOVE the composer toolbar (the composer sits at
      // the bottom of the chat column, so the panel opens UPWARD), left-aligned to the trigger chip.
      // The parent wraps the chip + this in a `relative` container. Bounded height with its own scroll.
      className="absolute bottom-full left-0 z-50 mb-2 flex max-h-[60vh] w-[min(36rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl akis-fade-in"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-100">{t('chat.picker.title')}</h2>
            <p className="mt-0.5 text-xs text-slate-400">{t('chat.picker.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            aria-label={t('chat.picker.close')}
            className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-sm text-slate-300 hover:border-white/30"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-teal-300">{t('chat.picker.providersTitle')}</h3>
            <div className="space-y-4">
              {providers.map(p => (
                <div key={p.id}>
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
                    {p.label}
                    {/* Opus review M1: an unconfigured provider must be VISIBLY unavailable —
                        offering choices that silently 400 (NoKey) is the opposite of "neyle
                        çalışıyoruz görünsün". Disabled + localized hint instead of a dead end. */}
                    {p.available === false && (
                      <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-medium text-amber-200/90">
                        {t('chat.picker.noKey')}
                      </span>
                    )}
                    {/* #18 managed-key honesty: show WHOSE key backs an available provider so a
                        user knows they're on the instance's shared key (vs their own). */}
                    {p.available !== false && p.keySource && p.keySource !== 'none' && (
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-slate-400">
                        {t(p.keySource === 'user' ? 'chat.picker.keySource.user' : 'chat.picker.keySource.shared')}
                      </span>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {p.models.map(m => {
                      const checked = provider === p.id && model === m.id
                      return (
                        <label
                          key={m.id}
                          className={
                            'flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition ' +
                            (p.available === false
                              ? 'cursor-not-allowed border-white/5 opacity-45'
                              : checked ? 'cursor-pointer border-[#07D1AF]/60 bg-[#07D1AF]/[0.08]' : 'cursor-pointer border-white/10 hover:border-white/25')
                          }
                        >
                          <input
                            type="radio"
                            name="akis-model"
                            value={`${p.id}::${m.id}`}
                            // Explicit label = the model name ONLY, so the `recommended` badge
                            // text below doesn't pollute the radio's accessible name.
                            aria-label={m.label}
                            checked={checked}
                            disabled={p.available === false}
                            onChange={() => { setProvider(p.id); setModel(m.id) }}
                            className="accent-[#07D1AF]"
                          />
                          <span className="flex-1 text-slate-100">{m.label}</span>
                          {m.recommended && (
                            <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                              {t('chat.picker.recommended')}
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="border-t border-white/10 pt-5">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-teal-300">{t('chat.picker.effort.title')}</h3>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              {EFFORTS.map(e => {
                const checked = effort === e
                return (
                  <label
                    key={e}
                    className={
                      'flex cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 text-sm transition ' +
                      (checked ? 'border-[#07D1AF]/60 bg-[#07D1AF]/[0.08]' : 'border-white/10 hover:border-white/25')
                    }
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="akis-effort"
                        value={e}
                        // Explicit label = the tier name ONLY (the hint text below stays visual).
                        aria-label={t(`chat.picker.effort.${e}`)}
                        checked={checked}
                        onChange={() => setEffort(e)}
                        className="accent-[#07D1AF]"
                      />
                      <span className="font-semibold text-slate-100">{t(`chat.picker.effort.${e}`)}</span>
                    </span>
                    <span className="pl-6 text-[11px] text-slate-400">{t(`chat.picker.effort.${e}.hint`)}</span>
                  </label>
                )
              })}
            </div>
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 px-6 py-4">
          <button
            type="button"
            onClick={() => onClose?.()}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-white/30"
          >
            {t('chat.picker.cancel')}
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!chosenAvailable}
            title={chosenAvailable ? undefined : t('chat.picker.noKey')}
            className="rounded-lg bg-[#07D1AF] px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-[#07D1AF]/90 disabled:opacity-40"
          >
            {t('chat.picker.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
