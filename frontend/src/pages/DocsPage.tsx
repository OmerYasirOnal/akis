import { Card, SectionTitle } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

const SECTIONS = ['what', 'agents', 'gates', 'preview', 'selfhost'] as const

/** Documentation page — explains the AKIS pipeline, the agents, the 4 gates, the live
 *  preview, and self-hosting. Content is i18n-driven so it reads in TR + EN. */
export function DocsPage() {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-6">
      <SectionTitle sub={t('docs.sub')}>{t('docs.title')}</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        {SECTIONS.map(key => (
          <Card key={key} className="p-5">
            <h3 className="mb-1 font-semibold text-[#07D1AF]">{t(`docs.${key}.title`)}</h3>
            <p className="text-sm leading-relaxed text-slate-300">{t(`docs.${key}.body`)}</p>
          </Card>
        ))}
      </div>
    </div>
  )
}
