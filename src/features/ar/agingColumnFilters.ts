/** Which Aging column filters are on, and how to clear one: the pure half of the column funnels. */
import type { AgingFilters, AgingRangeKey } from './agingReport'

export type AgingFilterColumn = 'customer' | 'terms' | 'lastPaid' | 'lastStatement' | AgingRangeKey


/** True when this column's filter has something set. */
export function columnFilterActive(col: AgingFilterColumn, f: AgingFilters): boolean {
  switch (col) {
    case 'customer': return f.customer.trim() !== ''
    case 'terms': return f.terms !== ''
    case 'lastPaid': return Boolean(f.lastPaidFrom || f.lastPaidTo || f.lastPaidBlank)
    case 'lastStatement': return f.statement !== '' || f.statementWithinDays != null || f.statementOlderDays != null
    default: {
      const r = f.ranges[col]
      return r != null && (r.min != null || r.max != null)
    }
  }
}

/** The filters with this column's filter cleared. */
export function clearColumnFilter(col: AgingFilterColumn, f: AgingFilters): AgingFilters {
  switch (col) {
    case 'customer': return { ...f, customer: '' }
    case 'terms': return { ...f, terms: '' }
    case 'lastPaid': return { ...f, lastPaidFrom: '', lastPaidTo: '', lastPaidBlank: false }
    case 'lastStatement': return { ...f, statement: '', statementWithinDays: null, statementOlderDays: null }
    default: {
      const { [col]: _gone, ...rest } = f.ranges
      void _gone
      return { ...f, ranges: rest }
    }
  }
}

