/** i18n string catalogue (TR + EN) — F2-AC11. All user-facing strings live here. */
export type Locale = 'en' | 'tr'

export const STRINGS = {
  en: {
    'app.title': 'AKIS · agentic build studio',
    'app.subtitle': 'Describe an app → agents build, verify with real tests, and ship it. Watch it live.',
    'tab.build': 'Build',
    'tab.agents': 'Agents & Workflows',
    'agents.heading': 'Agents & Workflows',
    'agents.roster': 'Core roster',
    'agents.model': 'Model',
    'agents.provider': 'Provider',
    'agents.workflowName': 'Workflow name',
    'agents.save': 'Save workflow',
    'agents.saved': 'Workflow saved',
    'agents.default': '(default)',
    'agents.loading': 'Loading providers…',
  },
  tr: {
    'app.title': 'AKIS · ajan tabanlı geliştirme stüdyosu',
    'app.subtitle': 'Bir uygulama tarif et → ajanlar inşa eder, gerçek testlerle doğrular ve yayınlar. Canlı izle.',
    'tab.build': 'Geliştir',
    'tab.agents': 'Ajanlar & İş Akışları',
    'agents.heading': 'Ajanlar & İş Akışları',
    'agents.roster': 'Çekirdek kadro',
    'agents.model': 'Model',
    'agents.provider': 'Sağlayıcı',
    'agents.workflowName': 'İş akışı adı',
    'agents.save': 'İş akışını kaydet',
    'agents.saved': 'İş akışı kaydedildi',
    'agents.default': '(varsayılan)',
    'agents.loading': 'Sağlayıcılar yükleniyor…',
  },
} as const

export type StringKey = keyof typeof STRINGS['en']
