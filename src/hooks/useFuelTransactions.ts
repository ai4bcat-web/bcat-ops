import { useState, useEffect, useCallback } from 'react'
import { listFuelTransactions, updateFuelTransaction } from '@/lib/apiClient'
import type { FuelTransaction } from '@/lib/apiClient'

export type { FuelTransaction }

export function useFuelTransactions() {
  const [transactions, setTransactions] = useState<FuelTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() =>
    listFuelTransactions()
      .then((data) => {
        setTransactions(data)
        setError(null)

        // Duplicate detection — visible in browser console
        const seen = new Map<string, string[]>()
        for (const t of data) {
          const k = `${t.transactionDate}|${t.cardNumber}|${t.invoiceNumber ?? ''}|${t.fuelType}`
          if (!seen.has(k)) seen.set(k, [])
          seen.get(k)!.push(t.id)
        }
        const dupes = [...seen.entries()].filter(([, ids]) => ids.length > 1)
        if (dupes.length > 0) {
          console.warn('[fuel] DUPLICATE TRANSACTIONS FOUND:', dupes.length, 'keys affected')
          for (const [k, ids] of dupes) console.warn(' dup key:', k, '→ ids:', ids)
        } else {
          console.log(`[fuel] loaded ${data.length} transactions — no duplicates`)
        }
      })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => setLoading(false)),
  [])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { void load() }, [load])

  const addTransactions = useCallback((added: FuelTransaction[]) => {
    setTransactions((prev) => [...prev, ...added])
  }, [])

  const patchTransaction = useCallback(async (id: string, patch: Partial<Omit<FuelTransaction, 'id' | 'createdAt' | 'updatedAt'>>) => {
    const updated = await updateFuelTransaction(id, patch)
    setTransactions((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    return updated
  }, [])

  return { transactions, loading, error, refresh, addTransactions, patchTransaction }
}
