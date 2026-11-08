/**
 * Workflows — everything that is stuck, and the agents that produced some of it.
 *
 * Two tabs over one idea: Errors is the dispatcher's queue of work the system could not
 * finish by itself, AI Agents is the log of what the agents actually did. The tab lives
 * in `?tab=` rather than in component state so a Slack link can point at either one, the
 * same way a shipment link points at a detail tab.
 */
import { useSearchParams } from 'react-router-dom'
import { TmsPage, TmsTabs } from '@/features/tms/kit'
import { AgentsTab } from './AgentsTab'
import { ErrorsTab } from './ErrorsTab'

const WORKFLOW_TAB_KEYS = ['errors', 'agents'] as const
type WorkflowTabKey = (typeof WORKFLOW_TAB_KEYS)[number]

const WORKFLOW_TABS: readonly { key: WorkflowTabKey; label: string }[] = [
  { key: 'errors', label: 'Errors' },
  { key: 'agents', label: 'AI Agents' },
]

/**
 * A `?tab=` value as a tab. Errors is the default because it is the only one with work
 * in it: the agents log is something a person goes looking for.
 */
function normalizeWorkflowTab(value: string | null | undefined): WorkflowTabKey {
  return WORKFLOW_TAB_KEYS.find((key) => key === value) ?? 'errors'
}

export function WorkflowsPage() {
  const [params, setParams] = useSearchParams()
  const tab = normalizeWorkflowTab(params.get('tab'))

  return (
    <TmsPage title="Workflows">
      <TmsTabs
        tabs={[...WORKFLOW_TABS]}
        active={tab}
        onSelect={(key) => {
          // `replace` so stepping through tabs does not fill the back button with them.
          const next = new URLSearchParams(params)
          next.set('tab', key)
          setParams(next, { replace: true })
        }}
      />
      {tab === 'errors' ? <ErrorsTab /> : <AgentsTab />}
    </TmsPage>
  )
}

export default WorkflowsPage
