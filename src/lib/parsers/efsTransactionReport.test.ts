import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    expect(tx!.itemCategory).toBe('FUEL')
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
    // Both are fuel items
    expect(defd!.itemCategory).toBe('FUEL')
    expect(ulsd!.itemCategory).toBe('FUEL')
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

  it('all 11 transactions have itemCategory set to FUEL', () => {
    expect(transactions.every((t) => t.itemCategory === 'FUEL')).toBe(true)
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

// ── SCLE (scale fee) synthetic report ─────────────────────────────────────────

const SCLE_REPORT = [
  '      00007               2026-05-18        0093283     685       Driver A                 100000        STATION A                CITY A               IL               ULSD     5.000                100.00               500.00  N  USD/Gallon',
  '      00007               2026-05-18        0093283     685       Driver A                 100000        STATION A                CITY A               IL               SCLE                           1                10.00  N  USD/Gallon',
  '      00023               2026-05-19        59983       780       Driver B                 200000        STATION B                CITY B               IL               SCLE                           1                 9.75  N  USD/Gallon',
  '',
  '                                                                                            Grand Totals',
  '',
  '                                                                                         Amount         Quantity          Avg PPU',
  '                                                             ULSD                           500.00            100.00            5.000',
  '                                                             SCLE                            19.75              2',
  '',
  '                                                             Fees                             0.00',
  '                                                             Totals                         519.75',
  '',
  '                                                             Total Fuel                     500.00           100.00',
].join('\n')

describe('SCLE (scale fee) transactions', () => {
  const result = parseEfsTransactionReport(SCLE_REPORT)
  const { transactions: txs } = result

  it('parses 3 transactions total (1 ULSD + 2 SCLE)', () => {
    expect(txs).toHaveLength(3)
  })

  it('SCLE transactions have itemCategory SCALE', () => {
    const scle = txs.filter((t) => t.fuelType === 'SCLE')
    expect(scle).toHaveLength(2)
    expect(scle.every((t) => t.itemCategory === 'SCALE')).toBe(true)
  })

  it('2 SCLE transactions total $19.75', () => {
    const scle = txs.filter((t) => t.fuelType === 'SCLE')
    const total = scle.reduce((s, t) => s + t.amount, 0)
    expect(total).toBeCloseTo(19.75, 2)
  })

  it('SCLE transactions have pricePerUnit of 0', () => {
    const scle = txs.filter((t) => t.fuelType === 'SCLE')
    expect(scle.every((t) => t.pricePerUnit === 0)).toBe(true)
  })

  it('ULSD transaction has itemCategory FUEL', () => {
    const ulsd = txs.find((t) => t.fuelType === 'ULSD')
    expect(ulsd).toBeDefined()
    expect(ulsd!.itemCategory).toBe('FUEL')
  })

  it('grand-total validation passes (no errors thrown)', () => {
    expect(() => parseEfsTransactionReport(SCLE_REPORT)).not.toThrow()
  })
})

// ── Mixed categories (ULSD, FUEL, DEFD, SCLE, CDSL) ──────────────────────────

const MIXED = readFileSync(
  resolve(__dirname, '../../../tests/fixtures/fuel-mixed-categories.txt'),
  'utf-8',
)

describe('mixed-categories report (ULSD + FUEL + DEFD + SCLE + CDSL)', () => {
  let result: ReturnType<typeof parseEfsTransactionReport>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    result = parseEfsTransactionReport(MIXED)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('parses exactly 5 transactions (group subtotals not counted)', () => {
    expect(result.transactions).toHaveLength(5)
  })

  it('FUEL item type is categorized as FUEL', () => {
    const fuel = result.transactions.find((t) => t.fuelType === 'FUEL')
    expect(fuel).toBeDefined()
    expect(fuel!.itemCategory).toBe('FUEL')
  })

  it('DEFD item type is categorized as FUEL', () => {
    const defd = result.transactions.find((t) => t.fuelType === 'DEFD')
    expect(defd).toBeDefined()
    expect(defd!.itemCategory).toBe('FUEL')
  })

  it('ULSD item type is categorized as FUEL', () => {
    const ulsd = result.transactions.find((t) => t.fuelType === 'ULSD')
    expect(ulsd).toBeDefined()
    expect(ulsd!.itemCategory).toBe('FUEL')
  })

  it('SCLE item type is categorized as SCALE', () => {
    const scle = result.transactions.find((t) => t.fuelType === 'SCLE')
    expect(scle).toBeDefined()
    expect(scle!.itemCategory).toBe('SCALE')
  })

  it('CDSL item type is categorized as OTHER without a console.warn', () => {
    const cdsl = result.transactions.find((t) => t.fuelType === 'CDSL')
    expect(cdsl).toBeDefined()
    expect(cdsl!.itemCategory).toBe('OTHER')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('fuel total (ULSD + FUEL + DEFD) equals $315.95', () => {
    const fuelTotal = result.transactions
      .filter((t) => t.itemCategory === 'FUEL')
      .reduce((s, t) => s + t.amount, 0)
    expect(fuelTotal).toBeCloseTo(315.95, 2)
  })

  it('non-fuel charges (SCLE + CDSL) are excluded from fuel total', () => {
    const nonFuel = result.transactions
      .filter((t) => t.itemCategory !== 'FUEL')
      .reduce((s, t) => s + t.amount, 0)
    expect(nonFuel).toBeCloseTo(80.00, 2)
  })

  it('grand-total validation passes without errors', () => {
    expect(() => parseEfsTransactionReport(MIXED)).not.toThrow()
  })

  it('continuation rows inherit card number and date from primary row', () => {
    expect(result.transactions.every((t) => t.cardNumber === '00031')).toBe(true)
    expect(result.transactions.every((t) => t.transactionDate === '2026-01-15')).toBe(true)
  })
})

// ── Unknown item type ──────────────────────────────────────────────────────────

const UNKNOWN_TYPE_REPORT = [
  '      00007               2026-05-18        0093283     685       Driver A                 100000        STATION A                CITY A               IL               ULSD     5.000                100.00               500.00  N  USD/Gallon',
  '      00007               2026-05-18        0093283     685       Driver A                 100000        STATION A                CITY A               IL               XYZW                           1                 5.00  N  USD/Gallon',
  '',
  '                                                                                            Grand Totals',
  '',
  '                                                                                         Amount         Quantity          Avg PPU',
  '                                                             ULSD                           500.00            100.00            5.000',
  '                                                             XYZW                             5.00              1',
  '',
  '                                                             Fees                             0.00',
  '                                                             Totals                         505.00',
  '',
  '                                                             Total Fuel                     500.00           100.00',
].join('\n')

describe('unknown item type', () => {
  it('logs a warning and assigns itemCategory OTHER without crashing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { transactions: txs } = parseEfsTransactionReport(UNKNOWN_TYPE_REPORT)
    const unknown = txs.find((t) => t.fuelType === 'XYZW')
    expect(unknown).toBeDefined()
    expect(unknown!.itemCategory).toBe('OTHER')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('XYZW'))
    warnSpy.mockRestore()
  })
})
