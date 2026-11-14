/**
 * Payment facts for the customers on screen: each invoice's receipts (date, ACH/check, ref #)
 * and each customer's average days to pay (`@/lib/daysToPay`).
 *
 * Read per customer — their invoices and cash rows — a few at a time, and kept for five
 * minutes so flipping tabs does not re-read everybody. `refreshKey` drops the cache (after a
 * payment is posted).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { listArPaymentsByCustomer, listInvoicesByCustomer } from '@/lib/apiClient'
import { customerDaysToPay, paymentLinesByInvoice, type CustomerDaysToPay, type InvoicePaymentLine } from '@/lib/daysToPay'

const TTL_MS = 5 * 60_000
const CONCURRENCY = 4

interface Facts {
  lines: Map<string, InvoicePaymentLine[]>
  daysToPay: CustomerDaysToPay
  at: number
}

const cache = new Map<string, Facts>()

async function factsFor(customerId: string): Promise<Facts> {
  const hit = cache.get(customerId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit
  const [invoices, payments] = await Promise.all([listInvoicesByCustomer(customerId), listArPaymentsByCustomer(customerId)])
  const facts = { lines: paymentLinesByInvoice(payments), daysToPay: customerDaysToPay(invoices, payments), at: Date.now() }
  cache.set(customerId, facts)
  return facts
}

export interface CustomerPaymentFacts {
  linesByInvoice: Map<string, InvoicePaymentLine[]>
  daysToPayByCustomer: Map<string, CustomerDaysToPay>
  loading: boolean
}

export function useCustomerPaymentFacts(customerIds: string[], refreshKey = 0): CustomerPaymentFacts {
  const key = useMemo(() => [...new Set(customerIds.filter(Boolean))].sort().join(','), [customerIds])
  const [state, setState] = useState<{ key: string; facts: Map<string, Facts> }>({ key: '', facts: new Map() })
  const seenRefresh = useRef(refreshKey)

  useEffect(() => {
    if (seenRefresh.current !== refreshKey) {
      seenRefresh.current = refreshKey
      cache.clear()
    }
    if (!key) return
    let alive = true
    const ids = key.split(',')
    const out = new Map<string, Facts>()
    let next = 0
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++]
        try { out.set(id, await factsFor(id)) } catch { /* a customer that fails to read shows no facts */ }
      }
    }
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker)).then(() => {
      if (alive) setState({ key, facts: out })
    })
    return () => { alive = false }
  }, [key, refreshKey])

  return useMemo(() => {
    const linesByInvoice = new Map<string, InvoicePaymentLine[]>()
    const daysToPayByCustomer = new Map<string, CustomerDaysToPay>()
    for (const [id, f] of state.facts) {
      daysToPayByCustomer.set(id, f.daysToPay)
      for (const [inv, lines] of f.lines) linesByInvoice.set(inv, lines)
    }
    return { linesByInvoice, daysToPayByCustomer, loading: key !== '' && state.key !== key }
  }, [state, key])
}
