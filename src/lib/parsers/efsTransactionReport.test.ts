import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, it, expect } from 'vitest'
import { parseEfsTransactionReport, fuelTxDedupKey } from './efsTransactionReport'

const SAMPLE = readFileSync(
  resolve(__dirname, '../../../tests/fixtures/fuel-sample.txt'),
  'utf-8',
)

describe('parseEfsTransactionReport', () => {
  const result = parseEfsTransactionReport(SAMPLE)
  const { transactions, grandTotals } = result

  it('parses exactly 11 transactions', () => {
    expect(transactions).toHaveLength(11)
  })

  it('grand total ULSD amount matches', () => {
    expect(grandTotals.byFuelType['ULSD'].amount).toBeCloseTo(3757.82, 1)
  })

  it('grand total ULSD quantity matches', () => {
    expect(grandTotals.byFuelType['ULSD'].quantity).toBeCloseTo(681.01, 1)
  })

  it('grand total DEFD amount matches', () => {
    expect(grandTotals.byFuelType['DEFD'].amount).toBeCloseTo(30.44, 1)
  })

  it('grand total DEFD quantity matches', () => {
    expect(grandTotals.byFuelType['DEFD'].quantity).toBeCloseTo(6.09, 1)
  })

  it('grand total fees matches', () => {
    expect(grandTotals.fees).toBeCloseTo(4.00, 2)
  })

  it('card 00007 transaction resolves correctly', () => {
    const tx = transactions.find((t) => t.cardNumber === '00007')
    expect(tx).toBeDefined()
    expect(tx!.unitNumber).toBe('685')
    expect(tx!.fuelType).toBe('ULSD')
    expect(tx!.driverName).toBe('Armando Arando')
    expect(tx!.transactionDate).toBe('2026-05-18')
    expect(tx!.amount).toBeCloseTo(597.92, 2)
    expect(tx!.quantity).toBeCloseTo(99.67, 2)
    expect(tx!.fees).toBe(0)
  })

  it('card 00023 has fee of $2.00', () => {
    const tx = transactions.find((t) => t.cardNumber === '00023')
    expect(tx).toBeDefined()
    expect(tx!.fees).toBeCloseTo(2.00, 2)
    expect(tx!.driverName).toBe('John Nelson')
  })

  it('card 00031 has blank driver name', () => {
    const tx = transactions.find((t) => t.cardNumber === '00031')
    expect(tx).toBeDefined()
    expect(tx!.driverName).toBe('')
    expect(tx!.unitNumber).toBe('0530')
  })

  it('card 00049 produces 6 transactions', () => {
    const txs = transactions.filter((t) => t.cardNumber === '00049')
    expect(txs).toHaveLength(6)
    // all are ULSD
    expect(txs.every((t) => t.fuelType === 'ULSD')).toBe(true)
    // fee only on the LOVES stop
    const feeRow = txs.find((t) => t.invoiceNumber === '73234')
    expect(feeRow).toBeDefined()
    expect(feeRow!.fees).toBeCloseTo(2.00, 2)
  })

  it('card 00056 continuation row inherits card, date, invoice', () => {
    const txs = transactions.filter((t) => t.cardNumber === '00056')
    expect(txs).toHaveLength(2)
    const defd = txs.find((t) => t.fuelType === 'DEFD')
    const ulsd = txs.find((t) => t.fuelType === 'ULSD')
    expect(defd).toBeDefined()
    expect(ulsd).toBeDefined()
    // Continuation row inherits same invoice and date
    expect(ulsd!.invoiceNumber).toBe(defd!.invoiceNumber)
    expect(ulsd!.transactionDate).toBe(defd!.transactionDate)
    expect(ulsd!.cardNumber).toBe('00056')
    // ULSD amount
    expect(ulsd!.amount).toBeCloseTo(685.14, 2)
    // DEFD
    expect(defd!.amount).toBeCloseTo(30.44, 2)
    expect(defd!.quantity).toBeCloseTo(6.09, 2)
  })

  it('parsed ULSD sum matches grand total (validator passes)', () => {
    const ulsdSum = transactions
      .filter((t) => t.fuelType === 'ULSD')
      .reduce((s, t) => s + t.amount, 0)
    expect(ulsdSum).toBeCloseTo(3757.82, 1)
  })

  it('parsed fees sum matches grand total', () => {
    const feesSum = transactions.reduce((s, t) => s + t.fees, 0)
    expect(feesSum).toBeCloseTo(4.00, 2)
  })

  it('dedup key is unique per transaction', () => {
    const keys = transactions.map(fuelTxDedupKey)
    const unique = new Set(keys)
    expect(unique.size).toBe(transactions.length)
  })
})
