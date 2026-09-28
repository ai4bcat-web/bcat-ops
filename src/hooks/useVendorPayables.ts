import { useState, useEffect, useRef, useCallback } from 'react'
import {
  listVendorPayables,
  getVendorPayable,
  updateVendorPayable,
  completeVendorPayable,
  reopenVendorPayable,
  deleteVendorPayable,
  getVendorApAttachmentUrl,
} from '@/lib/apiClient'
import { useAppStore } from '@/store/useAppStore'
import type { VendorPayable, VendorPayableDetails, VendorPayment } from '@/types/vendorAp'

const POLL_MS = 30_000

export interface UseVendorPayablesResult {
  items: VendorPayable[]
  loading: boolean
  error: string | null
  pendingIds: Set<string>
  refresh: () => void
  getPayableDetails: (id: string) => Promise<VendorPayable>
  updateDetails: (id: string, patch: VendorPayableDetails) => Promise<VendorPayable>
  recordPayment: (id: string, payment: VendorPayment) => Promise<VendorPayable>
  reopenPayable: (id: string) => Promise<VendorPayable>
  removePayable: (id: string) => Promise<void>
  getAttachmentUrl: (key: string) => Promise<string>
}

function addPending(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev)
  next.add(id)
  return next
}

function removePending(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev)
  next.delete(id)
  return next
}

function syncMaintenanceInvoice(payable: VendorPayable) {
  if (!payable.sourceInvoiceId) return
  const sourceId = payable.sourceInvoiceId
  const patch = {
    paymentMethod: payable.paymentMethod ?? undefined,
    paymentDate: payable.paymentDate ?? undefined,
  }
  useAppStore.setState((state) => ({
    maintenanceInvoices: state.maintenanceInvoices.map((inv) =>
      inv.id === sourceId ? { ...inv, ...patch } : inv,
    ),
  }))
}

export function useVendorPayables(): UseVendorPayablesResult {
  const [items, setItems] = useState<VendorPayable[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const pendingIdsRef = useRef<Set<string>>(new Set())
  const snapshotRef = useRef<Map<string, VendorPayable>>(new Map())
  const deletedAtRef = useRef<Map<string, string>>(new Map())

  const syncPending = useCallback((next: Set<string>) => {
    pendingIdsRef.current = next
    setPendingIds(next)
  }, [])

  const reconcile = useCallback((next: VendorPayable[]) => {
    setItems((prev) => {
      const pending = pendingIdsRef.current
      const deleted = deletedAtRef.current
      const prevMap = new Map(prev.map((i) => [i.id, i]))
      const nextMap = new Map(next.map((i) => [i.id, i]))
      const merged: VendorPayable[] = []

      // Merge by updatedAt so:
      // 1. Pending rows keep their in-flight state during polls.
      // 2. A poll that started before a completed mutation cannot clobber the confirmed
      //    new state (its updatedAt is older than the mutation result).
      // 3. Brand-new rows arriving via direct inserts are preserved.
      // 4. A poll that started before a successful delete cannot resurrect the row.
      // 5. A genuinely recreated invoice with the same source data gets a new id and
      //    updatedAt, so it is allowed through even if an earlier row was deleted.
      for (const id of new Set([...prevMap.keys(), ...nextMap.keys()])) {
        if (pending.has(id)) {
          merged.push(prevMap.get(id)!)
          continue
        }
        const incoming = nextMap.get(id)
        const current = prevMap.get(id)
        if (!incoming) continue
        const deletedAt = deleted.get(id)
        if (deletedAt && incoming.updatedAt <= deletedAt) continue
        if (!current || incoming.updatedAt > current.updatedAt) {
          merged.push(incoming)
        } else {
          merged.push(current)
        }
      }
      return merged
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await listVendorPayables()
      reconcile(next)
      setError(null)
    } catch (err) {
      console.error('[useVendorPayables] fetch error', err)
      setError(err instanceof Error ? err.message : 'Failed to load vendor payables')
    } finally {
      setLoading(false)
    }
  }, [reconcile])

  useEffect(() => {
    const immediate = setTimeout(load, 0)
    const id = setInterval(load, POLL_MS)
    return () => {
      clearTimeout(immediate)
      clearInterval(id)
    }
  }, [load])

  const updateDetails = useCallback(
    async (id: string, patch: VendorPayableDetails) => {
      const current = items.find((i) => i.id === id)
      if (!current) throw new Error('Payable not found')

      snapshotRef.current.set(id, current)
      syncPending(addPending(pendingIdsRef.current, id))

      try {
        const updated = await updateVendorPayable(id, patch, current.updatedAt)
        setItems((all) => all.map((i) => (i.id === id ? updated : i)))
        snapshotRef.current.delete(id)
        syncPending(removePending(pendingIdsRef.current, id))
        return updated
      } catch (err) {
        const snapshot = snapshotRef.current.get(id)
        if (snapshot) {
          setItems((all) => all.map((i) => (i.id === id ? snapshot : i)))
        }
        snapshotRef.current.delete(id)
        syncPending(removePending(pendingIdsRef.current, id))
        throw err
      }
    },
    [items, syncPending],
  )

  const recordPayment = useCallback(
    async (id: string, payment: VendorPayment) => {
      const current = items.find((i) => i.id === id)
      if (!current) throw new Error('Payable not found')

      snapshotRef.current.set(id, current)
      syncPending(addPending(pendingIdsRef.current, id))

      try {
        const updated = await completeVendorPayable(id, payment, current.updatedAt)
        setItems((all) => all.map((i) => (i.id === id ? updated : i)))
        syncMaintenanceInvoice(updated)
        snapshotRef.current.delete(id)
        syncPending(removePending(pendingIdsRef.current, id))
        return updated
      } catch (err) {
        const snapshot = snapshotRef.current.get(id)
        if (snapshot) {
          setItems((all) => all.map((i) => (i.id === id ? snapshot : i)))
        }
        snapshotRef.current.delete(id)
        syncPending(removePending(pendingIdsRef.current, id))
        throw err
      }
    },
    [items, syncPending],
  )

  const reopenPayable = useCallback(
    async (id: string) => {
      const current = items.find((i) => i.id === id)
      if (!current) throw new Error('Payable not found')

      snapshotRef.current.set(id, current)
      syncPending(addPending(pendingIdsRef.current, id))

      try {
        const updated = await reopenVendorPayable(id, current.updatedAt)
        setItems((all) => all.map((i) => (i.id === id ? updated : i)))
        syncMaintenanceInvoice(updated)
        snapshotRef.current.delete(id)
        syncPending(removePending(pendingIdsRef.current, id))
        return updated
      } catch (err) {
        const snapshot = snapshotRef.current.get(id)
        if (snapshot) {
          setItems((all) => all.map((i) => (i.id === id ? snapshot : i)))
        }
        snapshotRef.current.delete(id)
        syncPending(removePending(pendingIdsRef.current, id))
        throw err
      }
    },
    [items, syncPending],
  )

  const removePayable = useCallback(
    async (id: string) => {
      const target = items.find((i) => i.id === id)
      if (!target) throw new Error('Payable not found')

      syncPending(addPending(pendingIdsRef.current, id))

      try {
        await deleteVendorPayable(id)
        setItems((all) => all.filter((i) => i.id !== id))
        deletedAtRef.current.set(id, target.updatedAt)
        syncPending(removePending(pendingIdsRef.current, id))
      } catch (err) {
        syncPending(removePending(pendingIdsRef.current, id))
        throw err
      }
    },
    [items, syncPending],
  )

  const getAttachmentUrl = useCallback(async (key: string) => {
    return getVendorApAttachmentUrl(key)
  }, [])

  const getPayableDetails = useCallback(async (id: string) => {
    return getVendorPayable(id)
  }, [])

  return {
    items,
    loading,
    error,
    pendingIds,
    refresh: load,
    getPayableDetails,
    updateDetails,
    recordPayment,
    reopenPayable,
    removePayable,
    getAttachmentUrl,
  }
}
