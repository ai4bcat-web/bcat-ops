// Reader of the per-rep Brokerage figures. The rep split is not in DashboardRollup (every signed-in user can
// read that table); it is served by the tmsFinanceActions BROKERAGE_REP_ROLLUP action, which filters it by
// caller on the server. A rep gets back only their own rep key; a caller with no access gets a rejection.
import { financeAction } from '@/lib/apiClient'
import type { BrokerageRepMonth, BrokerageScope } from '@/lib/brokerageAccess'

export interface BrokerageRepRollup {
  scope: Exclude<BrokerageScope, 'NONE'>
  /** `i:<profile id>` for an OWN caller, null for ALL. */
  repKey: string | null
  months: BrokerageRepMonth[]
  /** Months in the range with no stored rollup yet (never zero-filled). */
  missing: string[]
}

/** `from`..`to` are `YYYY-MM`, at most 36 months. Rejects with the server's refusal text when the caller has no access. */
export function fetchBrokerageRepRollup(from: string, to: string): Promise<BrokerageRepRollup> {
  return financeAction<BrokerageRepRollup>('BROKERAGE_REP_ROLLUP', { from, to })
}
