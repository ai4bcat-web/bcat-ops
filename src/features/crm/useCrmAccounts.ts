import { useCallback, useEffect, useMemo, useState } from 'react'
import { crmAction, graphqlErrorText } from '@/lib/apiClient'
import type { CrmListAccountRow } from '@/lib/crm/types'

/**
 * The CRM columns of the Customers list (`CRM_LIST_ACCOUNTS`). The server returns one row
 * per account the caller may see, so `byCustomer` doubles as the visibility set (§5.6).
 * `loaded` stays false until the first answer; a failed call leaves it false and the page
 * keeps its unfiltered list (the raw Customer table is readable by every signed-in user).
 * `withActivity` adds openArCents + lastShipmentAt per row (extra server queries, so only
 * while a grid column shows them); flipping it refetches.
 */
export function useCrmAccounts(scope: 'mine' | 'all', withActivity = false) {
  const [rows, setRows] = useState<CrmListAccountRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Promise chain, not async/await: every state write sits in a callback (react-hooks/set-state-in-effect).
  const refresh = useCallback(() => crmAction<{ rows: CrmListAccountRow[] }>('CRM_LIST_ACCOUNTS', withActivity ? { scope, withActivity } : { scope })
    .then((out) => {
      setRows(out.rows ?? [])
      setLoaded(true)
      setError(null)
    })
    .catch((e: unknown) => {
      setLoaded(false)
      setError(graphqlErrorText(e) || 'Could not load CRM columns')
    }), [scope, withActivity])

  useEffect(() => { void refresh() }, [refresh])

  const byCustomer = useMemo(() => new Map(rows.map((r) => [r.customerId, r])), [rows])
  return { rows, byCustomer, loaded, error, refresh }
}
