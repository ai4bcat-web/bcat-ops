import { useState, useEffect, useCallback } from 'react'
import {
  listExpenseTypes,
  listAllocations,
  listExpenseRecords,
  listRecurringExpenses,
  createExpenseType, updateExpenseType, deleteExpenseType,
  createAllocation, updateAllocation, deleteAllocation,
  createExpenseRecord, updateExpenseRecord, deleteExpenseRecord,
  createRecurringExpense, updateRecurringExpense, deleteRecurringExpense,
} from '@/lib/apiClient'
import type {
  ExpenseTypeData,
  TruckExpenseAllocationData,
  ExpenseRecordData,
  RecurringExpenseData,
} from '@/lib/apiClient'

export type { ExpenseTypeData, TruckExpenseAllocationData, ExpenseRecordData, RecurringExpenseData }

export interface ExpenseDataState {
  expenseTypes:  ExpenseTypeData[]
  allocations:   TruckExpenseAllocationData[]
  records:       ExpenseRecordData[]
  recurring:     RecurringExpenseData[]
  loading:       boolean
  error:         string | null
  refresh:       () => void
  // ExpenseType CRUD
  createType:    (input: Omit<ExpenseTypeData, 'id' | 'createdAt' | 'updatedAt'>) => Promise<ExpenseTypeData>
  updateType:    (id: string, patch: Partial<Omit<ExpenseTypeData, 'id' | 'createdAt'>>) => Promise<ExpenseTypeData>
  deleteType:    (id: string) => Promise<void>
  // Allocation CRUD
  createAlloc:   (input: Omit<TruckExpenseAllocationData, 'id' | 'createdAt' | 'updatedAt'>) => Promise<TruckExpenseAllocationData>
  updateAlloc:   (id: string, patch: Partial<Omit<TruckExpenseAllocationData, 'id' | 'createdAt'>>) => Promise<TruckExpenseAllocationData>
  deleteAlloc:   (id: string) => Promise<void>
  // ExpenseRecord CRUD
  createRecord:  (input: Omit<ExpenseRecordData, 'id' | 'createdAt' | 'updatedAt'>) => Promise<ExpenseRecordData>
  updateRecord:  (id: string, patch: Partial<Omit<ExpenseRecordData, 'id' | 'createdAt'>>) => Promise<ExpenseRecordData>
  deleteRecord:  (id: string) => Promise<void>
  // RecurringExpense CRUD
  createRecur:   (input: Omit<RecurringExpenseData, 'id' | 'createdAt' | 'updatedAt'>) => Promise<RecurringExpenseData>
  updateRecur:   (id: string, patch: Partial<Omit<RecurringExpenseData, 'id' | 'createdAt'>>) => Promise<RecurringExpenseData>
  deleteRecur:   (id: string) => Promise<void>
}

export function useExpenseData(): ExpenseDataState {
  const [expenseTypes, setExpenseTypes] = useState<ExpenseTypeData[]>([])
  const [allocations,  setAllocations]  = useState<TruckExpenseAllocationData[]>([])
  const [records,      setRecords]      = useState<ExpenseRecordData[]>([])
  const [recurring,    setRecurring]    = useState<RecurringExpenseData[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [types, allocs, recs, recur] = await Promise.all([
        listExpenseTypes(),
        listAllocations(),
        listExpenseRecords(),
        listRecurringExpenses(),
      ])
      setExpenseTypes(types)
      setAllocations(allocs)
      setRecords(recs)
      setRecurring(recur)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ── ExpenseType ──────────────────────────────────────────────────────────────

  const createType = useCallback(async (input: Omit<ExpenseTypeData, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createExpenseType(input)
    setExpenseTypes((prev) => [...prev, created])
    return created
  }, [])

  const updateType = useCallback(async (id: string, patch: Partial<Omit<ExpenseTypeData, 'id' | 'createdAt'>>) => {
    const updated = await updateExpenseType(id, patch)
    setExpenseTypes((prev) => prev.map((t) => t.id === id ? updated : t))
    return updated
  }, [])

  const deleteType = useCallback(async (id: string) => {
    await deleteExpenseType(id)
    setExpenseTypes((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // ── Allocation ───────────────────────────────────────────────────────────────

  const createAlloc = useCallback(async (input: Omit<TruckExpenseAllocationData, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createAllocation(input)
    setAllocations((prev) => [...prev, created])
    return created
  }, [])

  const updateAlloc = useCallback(async (id: string, patch: Partial<Omit<TruckExpenseAllocationData, 'id' | 'createdAt'>>) => {
    const updated = await updateAllocation(id, patch)
    setAllocations((prev) => prev.map((a) => a.id === id ? updated : a))
    return updated
  }, [])

  const deleteAlloc = useCallback(async (id: string) => {
    await deleteAllocation(id)
    setAllocations((prev) => prev.filter((a) => a.id !== id))
  }, [])

  // ── ExpenseRecord ────────────────────────────────────────────────────────────

  const createRecord = useCallback(async (input: Omit<ExpenseRecordData, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createExpenseRecord(input)
    setRecords((prev) => [...prev, created])
    return created
  }, [])

  const updateRecord = useCallback(async (id: string, patch: Partial<Omit<ExpenseRecordData, 'id' | 'createdAt'>>) => {
    const updated = await updateExpenseRecord(id, patch)
    setRecords((prev) => prev.map((r) => r.id === id ? updated : r))
    return updated
  }, [])

  const deleteRecord = useCallback(async (id: string) => {
    await deleteExpenseRecord(id)
    setRecords((prev) => prev.filter((r) => r.id !== id))
  }, [])

  // ── RecurringExpense ─────────────────────────────────────────────────────────

  const createRecur = useCallback(async (input: Omit<RecurringExpenseData, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createRecurringExpense(input)
    setRecurring((prev) => [...prev, created])
    return created
  }, [])

  const updateRecur = useCallback(async (id: string, patch: Partial<Omit<RecurringExpenseData, 'id' | 'createdAt'>>) => {
    const updated = await updateRecurringExpense(id, patch)
    setRecurring((prev) => prev.map((r) => r.id === id ? updated : r))
    return updated
  }, [])

  const deleteRecur = useCallback(async (id: string) => {
    await deleteRecurringExpense(id)
    setRecurring((prev) => prev.filter((r) => r.id !== id))
  }, [])

  return {
    expenseTypes, allocations, records, recurring,
    loading, error, refresh: load,
    createType, updateType, deleteType,
    createAlloc, updateAlloc, deleteAlloc,
    createRecord, updateRecord, deleteRecord,
    createRecur, updateRecur, deleteRecur,
  }
}
