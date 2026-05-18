import { useAppStore } from '@/store/useAppStore'
import type { Expense } from '@/types/expense'

export function useExpenses() {
  const expenses      = useAppStore((s) => s.expenses)
  const addExpense    = useAppStore((s) => s.addExpense)
  const updateExpense = useAppStore((s) => s.updateExpense)
  const deleteExpense = useAppStore((s) => s.deleteExpense)

  function getExpensesByTruck(truckId: string): Expense[] {
    return expenses.filter((e) => e.truckId === truckId)
  }

  function getExpensesByPeriod(start: string, end: string): Expense[] {
    return expenses.filter((e) => e.date >= start && e.date <= end)
  }

  return { expenses, addExpense, updateExpense, deleteExpense, getExpensesByTruck, getExpensesByPeriod }
}
