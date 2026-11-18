import { describe, it, expect } from 'vitest'
import type { CarrierBillRecord } from '@/types/tms'
import type { CarrierPaymentInfo } from '@/lib/apiClient'
import type { BillFactsIndex } from './apQueue'
import {
  exportDay, selectedExportRows, selectedPayablesCsv, selectedPayablesFilename, selectedPayeeTotals,
  SELECTED_EXPORT_HEADERS, PAYEE_TOTAL_HEADERS,
} from './apSelectedExport'

const ASOF = '2026-11-18'

function bill(patch: Partial<CarrierBillRecord> = {}): CarrierBillRecord {
  return {
    id: 'b1', loadCarrierId: 'lc1', loadId: 'l1', shipmentId: 's1', shipmentNumber: '20001',
    carrierId: 'car1', carrierName: 'Blue Line Trucking', payeeKind: 'CARRIER',
    remitTo: { name: 'Blue Line Trucking', method: 'ACH', payeeEmail: 'ap@blueline.test' },
    status: 'TO_BE_PAID', billNumber: 'BL-1', billDate: '2026-10-01', billMonth: '2026-10',
    recordedAt: '2026-10-02T12:00:00.000Z', recordedBy: 'ap@example.test',
    dueAt: '2026-11-08', termsDays: 30, grossCents: 150_000, quickPayFeeCents: 0, netCents: 150_000,
    billedCents: 150_000, varianceCents: 0, paidCents: 0, creditedCents: 0, balanceCents: 150_000, apOpen: 'OPEN',
    createdBy: 'ap@example.test', updatedBy: 'ap@example.test', version: 1,
    ...patch,
  } as CarrierBillRecord
}

const facts: BillFactsIndex = new Map([
  ['s1', { shipmentNumber: '20001', po: 'PO-1', deliveredAt: '2026-10-30T03:30:00.000Z', delivered: true, customerName: 'Acme Foods' }],
  ['s2', { shipmentNumber: '20002', po: null, deliveredAt: '2026-11-10T18:00:00.000Z', delivered: true, customerName: 'Beta, "Inc"' }],
]) as unknown as BillFactsIndex

const run = (bills: CarrierBillRecord[], extra: Partial<Parameters<typeof selectedExportRows>[0]> = {}) => ({
  bills, facts, infos: [] as CarrierPaymentInfo[], review: new Map(), asOf: ASOF, ticked: new Set<string>(), ...extra,
})

describe('exportDay', () => {
  it('writes MM/DD/YYYY and reads a timestamp in Chicago time', () => {
    expect(exportDay('2026-11-08')).toBe('11/08/2026')
    // 03:30 UTC on Oct 30 is still Oct 29 in Chicago.
    expect(exportDay('2026-10-30T03:30:00.000Z')).toBe('10/29/2026')
    expect(exportDay(null)).toBe('')
    expect(exportDay('garbage')).toBe('')
  })
})

describe('selectedExportRows', () => {
  it('carries the payee, customer, dates, days past due, money and the ticked flag for each bill', () => {
    const [row] = selectedExportRows(run([bill()], { ticked: new Set(['b1']) }))
    expect(row).toMatchObject({
      payee: 'Blue Line Trucking', carrier: 'Blue Line Trucking', pro: '20001', po: 'PO-1', customer: 'Acme Foods',
      delivered: '10/29/2026', invoiceDate: '10/01/2026', dueDate: '11/08/2026', daysPastDue: 10,
      netCents: 150_000, paidCents: 0, balanceCents: 150_000, payMethod: 'ACH', remitEmail: 'ap@blueline.test',
      factorName: '', status: 'To be paid', quickPay: false, ticked: true,
    })
  })

  it('names the factor and the factor remit address for a factor-paid bill, and reads the method name only', () => {
    const [row] = selectedExportRows(run([bill({
      payeeKind: 'FACTOR',
      remitTo: { name: 'Blue Line', factorName: 'Triumph Capital', method: 'WIRE', payeeEmail: 'remit@triumph.test', accountLast4: '1234' },
    })]))
    expect(row.payee).toBe('Triumph Capital')
    expect(row.factorName).toBe('Triumph Capital')
    expect(row.payMethod).toBe('Wire')
    expect(row.remitEmail).toBe('remit@triumph.test')
    expect(JSON.stringify(row)).not.toContain('1234')
  })

  it('puts the Needs review text and the quick pay flag on the bill', () => {
    const [row] = selectedExportRows(run([bill({ quickPay: true, quickPayDays: 2, quickPayFeeBps: 600 })], {
      review: new Map([['s1', { financeReviewReason: 'Missing delivered date', financeReviewApNote: 'Carrier says Nov 2' }]]),
    }))
    expect(row.needsReview).toBe('Missing delivered date · Carrier says Nov 2')
    expect(row.quickPay).toBe(true)
  })

  it('leaves days past due blank for a bill still waiting on its dates, and negative before the due date', () => {
    const rows = selectedExportRows(run([
      bill({ id: 'b1', datesPending: true }),
      bill({ id: 'b2', shipmentId: 's2', dueAt: '2026-11-20', billNumber: 'BL-2' }),
    ]))
    expect(rows.find((r) => r.bill === 'BL-1')?.daysPastDue).toBeNull()
    expect(rows.find((r) => r.bill === 'BL-2')?.daysPastDue).toBe(-2)
  })

  it('orders by payee, then due date, then PRO', () => {
    const rows = selectedExportRows(run([
      bill({ id: 'a', carrierName: 'Zed Freight', remitTo: { name: 'Zed Freight' }, dueAt: '2026-11-01' }),
      bill({ id: 'b', dueAt: '2026-11-09', billNumber: 'BL-9' }),
      bill({ id: 'c', dueAt: '2026-11-02', billNumber: 'BL-2' }),
    ]))
    expect(rows.map((r) => `${r.payee}|${r.dueDate}`)).toEqual([
      'Blue Line Trucking|11/02/2026', 'Blue Line Trucking|11/09/2026', 'Zed Freight|11/01/2026',
    ])
  })
})

describe('selectedPayeeTotals', () => {
  it('adds up what each payee is owed, and what is ticked', () => {
    const rows = selectedExportRows(run([
      bill({ id: 'a', billNumber: 'A', balanceCents: 100_000 }),
      bill({ id: 'b', billNumber: 'B', balanceCents: 25_050 }),
      bill({ id: 'c', billNumber: 'C', carrierName: 'Red Line', remitTo: { name: 'Red Line', method: 'CHECK', payeeEmail: 'ap@red.test' }, balanceCents: 80_000 }),
    ], { ticked: new Set(['a', 'c']) }))
    const totals = selectedPayeeTotals(rows)
    expect(totals).toEqual([
      expect.objectContaining({ payee: 'Blue Line Trucking', bills: 2, totalCents: 125_050, tickedBills: 1, tickedCents: 100_000, payMethod: 'ACH', flags: '' }),
      expect.objectContaining({ payee: 'Red Line', bills: 1, totalCents: 80_000, tickedBills: 1, tickedCents: 80_000, payMethod: 'Check' }),
    ])
  })

  it('flags a payee with no remit e-mail and one with no payment method', () => {
    const rows = selectedExportRows(run([
      bill({ id: 'a', remitTo: { name: 'Blue Line Trucking', method: 'ACH' } }),
      bill({ id: 'b', carrierId: 'car2', carrierName: 'Red Line', remitTo: { name: 'Red Line', payeeEmail: 'ap@red.test' } }),
    ]))
    const totals = selectedPayeeTotals(rows)
    expect(totals.find((t) => t.payee === 'Blue Line Trucking')?.flags).toBe('No remit e-mail')
    expect(totals.find((t) => t.payee === 'Red Line')?.flags).toBe('No payment method')
  })

  it('says Mixed when one payee is paid two ways', () => {
    const rows = selectedExportRows(run([
      bill({ id: 'a' }),
      bill({ id: 'b', remitTo: { name: 'Blue Line Trucking', method: 'CHECK', payeeEmail: 'ap@blueline.test' } }),
    ]))
    expect(selectedPayeeTotals(rows)[0].payMethod).toBe('Mixed')
  })
})

describe('selectedPayablesCsv', () => {
  const lines = (csv: string) => csv.split('\r\n')

  it('has the bill rows, then the totals by payee, then a grand total', () => {
    const csv = selectedPayablesCsv(run([
      bill({ id: 'a', billNumber: 'A', balanceCents: 100_000, netCents: 100_000 }),
      bill({ id: 'b', billNumber: 'B', shipmentId: 's2', shipmentNumber: '20002', balanceCents: 25_050, netCents: 25_050 }),
    ], { ticked: new Set(['a']) }))
    const all = lines(csv)
    expect(all[0]).toBe(SELECTED_EXPORT_HEADERS.map((h) => (/[",]/.test(h) ? `"${h}"` : h)).join(','))
    expect(all).toContain('PAY RUN TOTALS BY PAYEE')
    expect(all[all.indexOf('PAY RUN TOTALS BY PAYEE') + 1]).toBe(PAYEE_TOTAL_HEADERS.join(','))
    const grand = all[all.length - 1]
    expect(grand.startsWith('GRAND TOTAL,2,1250.50,1,1000.00')).toBe(true)
    // Money is a plain number with two decimals, never a currency string.
    expect(csv).toContain('1000.00')
    expect(csv).not.toContain('$')
  })

  it('quotes a customer name with a comma and a quote in it', () => {
    const csv = selectedPayablesCsv(run([bill({ shipmentId: 's2', shipmentNumber: '20002' })]))
    expect(csv).toContain('"Beta, ""Inc"""')
  })

  it('names the file by the day', () => {
    expect(selectedPayablesFilename(ASOF)).toBe('selected-payables-2026-11-18.csv')
  })

  it('writes just the headers and a zero grand total for an empty list', () => {
    const all = lines(selectedPayablesCsv(run([])))
    expect(all[0].startsWith('Payee (remit to)')).toBe(true)
    expect(all[all.length - 1].startsWith('GRAND TOTAL,0,0.00,0,0.00')).toBe(true)
  })
})
