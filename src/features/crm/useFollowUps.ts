import { useCallback, useEffect, useState } from 'react'
import { crmAction, graphqlErrorText } from '@/lib/apiClient'
import type { CrmFollowUpRow } from '@/lib/crm/types'

/** `CRM_LIST_FOLLOWUPS`: accounts whose next step is due within a week plus the caller's open tasks, overdue first. */
export function useFollowUps(scope: 'mine' | 'all') {
  const [rows, setRows] = useState<CrmFollowUpRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Promise chain, not async/await: every state write sits in a callback (react-hooks/set-state-in-effect).
  const refresh = useCallback(() => crmAction<{ rows: CrmFollowUpRow[] }>('CRM_LIST_FOLLOWUPS', { scope })
    .then((out) => {
      setRows(out.rows ?? [])
      setError(null)
    })
    .catch((e: unknown) => { setError(graphqlErrorText(e) || 'Could not load follow-ups') })
    .finally(() => setLoading(false)), [scope])

  useEffect(() => { void refresh() }, [refresh])

  return { rows, loading, error, refresh }
}
