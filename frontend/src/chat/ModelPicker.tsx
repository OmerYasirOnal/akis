import { useState } from 'react'
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

/**
 * A custom (NOT native <select>) model + effort picker, shown as a modal over the chat.
 * Models are grouped by provider with a `recommended` badge on flagged ones; effort is a
 * three-way radio (fast/balanced/deep). The choice is LOCAL until Apply, so the user can
 * cancel without committing. CHAT-ONLY: the parent applies this to chat requests only.
 */
export function ModelPicker({ providers, selected, onSelect, onClose }: ModelPickerProps) {
  const { t } = useI18n()
  const [provider, setProvider] = useState(selected.provider)
  const [model, setModel] = useState(selected.model)
  const [effort, setEffort] = useState<Effort>(selected.effort)

  const apply = (): void => {
    onSelect({ provider, model, effort })
    onClose?.()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('chat.picker.title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      // Click the backdrop to dismiss (no commit). Inner clicks stopPropagation below.
      onClick={() => onClose?.()}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
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
            className="rounded-lg bg-[#07D1AF] px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-[#07D1AF]/90"
          >
            {t('chat.picker.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
