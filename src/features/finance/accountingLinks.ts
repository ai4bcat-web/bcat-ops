/**
 * Links into the Invoicing page's Receivable and Payable views, used by the Operations Dashboard's
 * Accounting cards: a row opens the same view, tab and filter the page would show for it.
 */
import { writeOwedFilter, type DueBucket } from '@/features/ar/owedFilters'

export interface AccountingLink {
  tab?: string
  /** A customer (Receivable) or carrier (Payable) id. */
  party?: string | null
  division?: string | null
  due?: DueBucket | null
}

function link(path: string, partyKey: string, l: AccountingLink): string {
  const params = writeOwedFilter(new URLSearchParams(), {
    parties: l.party ? [l.party] : [],
    divisions: l.division ? [l.division] : [],
    due: l.due ?? null,
  }, partyKey)
  if (l.tab) params.set('tab', l.tab)
  const q = params.toString()
  return q ? `${path}?${q}` : path
}

export const receivableLink = (l: AccountingLink = {}) => link('/tms/invoicing', 'customer', l)
export const factoredLink = (tab?: string) => (tab ? `/tms/invoicing/factored?tab=${tab}` : '/tms/invoicing/factored')
export const payableLink = (l: AccountingLink = {}) => link('/tms/invoicing/payable', 'carrier', l)

/** The `?tab=` the page was opened on, when it is one of `tabs`. */
export function tabFromUrl<T extends string>(tabs: readonly T[], fallback: T): T {
  try {
    const tab = new URLSearchParams(window.location.search).get('tab')
    return tab && (tabs as readonly string[]).includes(tab) ? (tab as T) : fallback
  } catch {
    return fallback
  }
}
