export type ExpenseCategory = 'fuel' | 'maintenance' | 'insurance' | 'tolls' | 'other'

export interface Expense {
  id: string
  truckId: string
  category: ExpenseCategory
  amount: number        // in cents to avoid float math
  date: string          // ISO date YYYY-MM-DD
  vendor?: string
  description?: string
  receiptUrl?: string   // for future upload feature
  createdAt: string
  updatedAt: string
  createdBy: string
}
