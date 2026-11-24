import { describe, it, expect } from 'vitest'
import {
  isManualFuelTx, manualMethodOf, manualFuelFields, manualNotes, parseDollars, validateManualExpense,
  expenseTypeCategoryFor, canManageManualExpenses, canDeleteManualExpenses, type ManualExpenseInput,
} from './manualExpense'

const base: ManualExpenseInput = {
  category: 'fuel', date: '2026-11-24', amount: 667.81, payee: 'Josh Kly (Zelle)', method: 'Zelle', reference: 'JPM99d49lk49',
  note: 'fuel 11.24.26', truckId: 'equip-1', unitNumber: '3114', driverName: 'Joshua Kly', proNumber: '',
}

describe('manual fuel rows', () => {
  it('are marked by the source file and carry no gallons or price', () => {
    const f = manualFuelFields(base)
    expect(isManualFuelTx(f)).toBe(true)
    expect(manualMethodOf(f)).toBe('Zelle')
    expect(f.quantity).toBe(0)
    expect(f.pricePerUnit).toBe(0)
    expect(f.itemCategory).toBe('FUEL')
    expect(f.cardNumber).toBe('MANUAL')
    expect(f.invoiceNumber).toBe('JPM99d49lk49')
    expect(f.locationName).toBe('Josh Kly (Zelle) — fuel 11.24.26')
  })
  it('are not confused with card imports', () => {
    expect(isManualFuelTx({ sourceFile: 'TransactionReport-1.txt' })).toBe(false)
    expect(isManualFuelTx({ sourceFile: undefined })).toBe(false)
    expect(isManualFuelTx({ sourceFile: 'manual-entry' })).toBe(true)
  })
})

describe('validation and parsing', () => {
  it('needs a date, an amount above zero and a truck', () => {
    expect(validateManualExpense(base)).toBeNull()
    expect(validateManualExpense({ ...base, date: '' })?.field).toBe('date')
    expect(validateManualExpense({ ...base, amount: 0 })?.field).toBe('amount')
    expect(validateManualExpense({ ...base, truckId: '' })?.field).toBe('truck')
  })
  it('reads typed dollars', () => {
    expect(parseDollars('$1,234.5')).toBe(1234.5)
    expect(parseDollars('667.81')).toBe(667.81)
    expect(parseDollars('abc')).toBeNaN()
  })
  it('writes a readable one-line note', () => {
    expect(manualNotes({ ...base, category: 'tolls', proNumber: '14588' }))
      .toBe('Tolls · Paid to Josh Kly (Zelle) · Zelle · Ref JPM99d49lk49 · Driver Joshua Kly · PRO 14588 · fuel 11.24.26')
  })
  it('books non-fuel categories to the expense types that exist', () => {
    expect(expenseTypeCategoryFor('maintenance')).toBe('MAINTENANCE')
    expect(expenseTypeCategoryFor('tolls')).toBe('TOLLS')
    expect(expenseTypeCategoryFor('lumper')).toBe('OTHER')
    expect(expenseTypeCategoryFor('parking')).toBe('OTHER')
  })
})

describe('who may add, edit and delete', () => {
  const ryne = { email: 'ryne@bcatcorp.com', groups: [] as string[] }
  const jason = { email: 'jason@bcatcorp.com', groups: [] as string[] }
  const jenny = { email: 'jenny@bcatcorp.com', groups: [] as string[] }
  it('adds and edits for the owner, admins and Finances holders', () => {
    expect(canManageManualExpenses(ryne, true, false)).toBe(true)
    expect(canManageManualExpenses(jenny, false, true)).toBe(true)
    expect(canManageManualExpenses(jenny, false, false)).toBe(false)
    expect(canManageManualExpenses(null, true, true)).toBe(false)
  })
  it('never for Jason, even with a Finances grant', () => {
    expect(canManageManualExpenses(jason, false, true)).toBe(false)
    expect(canDeleteManualExpenses(jason, false)).toBe(false)
  })
  it('deletes for the owner and admins only', () => {
    expect(canDeleteManualExpenses(ryne, true)).toBe(true)
    expect(canDeleteManualExpenses({ email: 'a@bcatcorp.com', groups: ['ADMIN'] }, true)).toBe(true)
    expect(canDeleteManualExpenses(jenny, false)).toBe(false)
  })
})
