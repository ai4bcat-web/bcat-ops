/**
 * Payments Received → the customer search (Ryne 2026-11-16: "work on one customer at a time when receiving payments").
 *
 * Type-ahead over the directory: a name that STARTS with what is typed first, then a name or alias that contains it, then the
 * fuzzy matches the shipment picker uses (`findCustomerMatches`: "&" = "and", Inc/LLC/Co ignored, merged aliases). Customers with
 * open invoices come before the rest within a rank, since that is who a payment is being received for. Pure; the page renders it.
 */
import { customerMatchKey, findCustomerMatches, isActiveDirectoryRecord } from '@/lib/tmsDirectory'
import type { CustomerRecord } from '@/types/tms'

export interface CustomerSuggestion {
  customer: CustomerRecord
  openCents: number
}

const LIMIT = 8

export function searchCustomers(query: string, customers: readonly CustomerRecord[], openByCustomer: ReadonlyMap<string, number>): CustomerSuggestion[] {
  const q = query.trim().toLowerCase()
  const open = (c: CustomerRecord) => openByCustomer.get(c.id) ?? 0
  const live = customers.filter((c) => c.name && isActiveDirectoryRecord(c))
  const byOpenThenName = (a: CustomerRecord, b: CustomerRecord) => Number(open(b) > 0) - Number(open(a) > 0) || a.name.localeCompare(b.name)
  const wrap = (list: CustomerRecord[]) => list.slice(0, LIMIT).map((customer) => ({ customer, openCents: open(customer) }))
  if (!q) return wrap(live.filter((c) => open(c) > 0).sort(byOpenThenName))

  const names = (c: CustomerRecord) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())
  const key = customerMatchKey(query)
  const ranked = new Map<string, { c: CustomerRecord; rank: number; score: number }>()
  const put = (c: CustomerRecord, rank: number, score = 0) => {
    const cur = ranked.get(c.id)
    if (!cur || rank < cur.rank || (rank === cur.rank && score > cur.score)) ranked.set(c.id, { c, rank, score })
  }
  for (const c of live) {
    const n = names(c)
    if (n.some((v) => v.startsWith(q)) || (key && n.some((v) => customerMatchKey(v).startsWith(key)))) put(c, 0)
    else if (n.some((v) => v.includes(q))) put(c, 1)
  }
  for (const m of findCustomerMatches(query, live as CustomerRecord[])) put(m.record, 2, m.score)
  return [...ranked.values()]
    .sort((a, b) => a.rank - b.rank || Number(open(b.c) > 0) - Number(open(a.c) > 0) || b.score - a.score || a.c.name.localeCompare(b.c.name))
    .slice(0, LIMIT)
    .map(({ c }) => ({ customer: c, openCents: open(c) }))
}
