import { useState } from 'react'
import type { WorkflowConfig, WorkflowConfigInput } from '@akis/shared'
import type { ApiClient } from '../api/client.js'
import { Button } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import { WorkflowList } from './WorkflowList.js'
import { WorkflowBuilder } from './WorkflowBuilder.js'
import { WorkflowPreview } from './WorkflowPreview.js'

/** The page-local view: the saved-list, or the builder editing an existing workflow
 *  (`initial` set) / composing a new one (`initial` undefined). */
type View = { kind: 'list' } | { kind: 'edit'; initial?: WorkflowConfig }

/** An empty draft so the live preview can render before the builder pushes its first
 *  draft up — the 4 structural gates are always shown regardless of the (empty) config. */
const EMPTY_DRAFT: WorkflowConfigInput = { name: '', agents: [], gatePolicy: {} }

/**
 * WorkflowsPage (F2 builder UI) — the /workflows shell. It composes the three pieces with
 * local view state, matching the SettingsPage layout (stacked glass cards under a section
 * title): the saved-workflow LIST by default, and on New/Edit the BUILDER beside a LIVE
 * PREVIEW (the preview reflects the in-progress draft so the always-enforced gates and the
 * config summary update as you edit). Saving returns to the list and refreshes it.
 */
export function WorkflowsPage({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [view, setView] = useState<View>({ kind: 'list' })
  // Bumped after a save so the list remounts and re-fetches the latest-per-id set.
  const [listKey, setListKey] = useState(0)
  // The builder's live draft, mirrored here to drive the preview pane.
  const [draft, setDraft] = useState<WorkflowConfigInput>(EMPTY_DRAFT)

  const toList = (): void => { setView({ kind: 'list' }); setListKey(k => k + 1) }

  if (view.kind === 'list') {
    return (
      <div className="flex flex-col gap-6">
        <WorkflowList
          key={listKey}
          api={api}
          onNew={() => { setDraft(EMPTY_DRAFT); setView({ kind: 'edit' }) }}
          onEdit={wf => { setDraft(wf); setView({ kind: 'edit', initial: wf }) }}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" onClick={toList}>
          <span aria-hidden="true">←</span> {t('workflows.page.back')}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <WorkflowBuilder
          api={api}
          {...(view.initial ? { initial: view.initial } : {})}
          onDraftChange={setDraft}
          onSaved={() => toList()}
        />
        <div className="lg:sticky lg:top-6 lg:self-start">
          <WorkflowPreview draft={draft} />
        </div>
      </div>
    </div>
  )
}
