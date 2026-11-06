import { describe, expect, it } from 'vitest'
import {
  AP_PAYMENTS_HEADERS, AR_PAYMENTS_HEADERS, CARRIER_BILLS_HEADERS, INVOICES_HEADERS,
  buildAccountingFiles, openInvoiceBalanceCents, type AccountingFile, type AccountingInput,
} from './accounting'

// Synthetic data only.
function parseCsv(content: string): string[][] {
  const text = content.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r') { /* part of CRLF */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  return rows
}

const inv = (over: Record<string, unknown>) => ({
  orderId: 'O1', shipmentId: 'S1', customerId: 'C1', invoiceDate: '2026-02-01', dueAt: '2026-03-03', termsDays: 30,
  totalCents: 100000, paidCents: 0, writtenOffCents: 0, balanceCents: 100000, status: 'ISSUED', arOpen: 'OPEN',
  factored: false, issuedBy: 'a@x.test', createdBy: 'a@x.test', ...over,
})

const fixture: AccountingInput = {
  customers: [{ id: 'C1', name: 'Synthetic Freight Co' }, { id: 'C2', name: '=HYPERLINK("x")' }],
  carriers: [{ id: 'K1', name: 'Fake Haul LLC', mcNumber: '123456' }],
  shipments: [{ id: 'S1', number: 'S000001' }, { id: 'S2', number: 'S000002' }],
  loads: [
    { id: 'L2', aljexId: '90002', orderId: 'O1', shipmentId: 'S1', leg: 2, loadNumber: 'S000001-2' },
    { id: 'L1', aljexId: '90001', orderId: 'O1', shipmentId: 'S1', leg: 1, loadNumber: 'S000001-1' },
    { id: 'L3', aljexId: '90003', orderId: 'O3', shipmentId: 'S2', leg: 1, loadNumber: 'S000002-1' },
  ],
  invoices: [
    inv({ id: '5002', number: '5002', invoiceDate: '2026-02-05', customerId: 'C2', orderId: 'O3', shipmentId: 'S2', status: 'PARTIAL', paidCents: 10000, balanceCents: 25050, totalCents: 35050, createdBy: 'aljex-import' }),
    inv({ id: '5001', number: '5001', status: 'ISSUED', termsText: 'Net 30' }),
    inv({ id: '5003', number: '5003', status: 'PAID', paidCents: 100000, balanceCents: 0, arOpen: undefined, paidAt: '2026-02-20T12:00:00.000Z' }),
    inv({ id: '5004', number: '5004', status: 'VOID', balanceCents: 0, arOpen: undefined, voidedAt: '2026-02-02T10:00:00.000Z', voidReason: '-bad reason' }),
    inv({ id: '5005', number: '5005', invoiceDate: '2026-03-10', status: 'ISSUED', balanceCents: 7777 }),
  ],
  arPayments: [
    { id: 'P1', customerId: 'C1', kind: 'PAYMENT', receivedAt: '2026-02-20T12:00:00.000Z', method: 'ACH', reference: 'REF,1', amountCents: 130000, appliedCents: 130000, unappliedCents: 0, createdBy: 'a@x.test',
      applications: JSON.stringify([{ invoiceId: '5003', amountCents: 100000 }, { invoiceId: '5001', amountCents: 30000 }]) },
    { id: 'P2', customerId: 'C1', kind: 'PAYMENT', receivedAt: '2026-02-21T12:00:00.000Z', method: 'CHECK', amountCents: 5000, appliedCents: 0, unappliedCents: 5000, createdBy: 'a@x.test' },
    { id: 'P3', customerId: 'C1', kind: 'REVERSAL', receivedAt: '2026-02-22T12:00:00.000Z', amountCents: -5000, appliedCents: 0, unappliedCents: -5000, reversesPaymentId: 'P2', createdBy: 'aljex-import' },
  ],
  carrierBills: [
    { id: 'cb:1:1', billNumber: 'INV-9', loadId: 'L1', shipmentId: 'S1', carrierId: 'K1', billDate: '2026-02-10', dueAt: '2026-03-12', termsDays: 30, grossCents: 80000, quickPayFeeCents: 0, netCents: 80000, billedCents: 80000, varianceCents: 0, paidCents: 30000, creditedCents: 0, balanceCents: 50000, status: 'PARTIAL', createdBy: 'a@x.test', approvedAt: '2026-02-11T00:00:00.000Z', approvedBy: 'b@x.test', payeeKind: 'CARRIER' },
    { id: 'cb:3:1', loadId: 'L3', shipmentId: 'S2', carrierId: 'K1', billDate: '2026-03-12', dueAt: '2026-04-11', termsDays: 30, grossCents: 1000, quickPayFeeCents: 0, netCents: 1000, billedCents: 1000, varianceCents: 0, paidCents: 0, creditedCents: 0, balanceCents: 1000, status: 'VOID', createdBy: 'aljex-import' },
  ],
  apPayments: [
    { id: 'A1', carrierId: 'K1', kind: 'PAYMENT', paidAt: '2026-02-15T12:00:00.000Z', method: 'ACH', amountCents: 30000, appliedCents: 30000, unappliedCents: 0, createdBy: 'a@x.test', applications: JSON.stringify([{ billId: 'cb:1:1', amountCents: 30000 }]) },
    { id: 'A2', carrierId: 'K1', kind: 'CREDIT_MEMO', paidAt: '2026-02-16T12:00:00.000Z', amountCents: 2000, appliedCents: 0, unappliedCents: 2000, createdBy: 'a@x.test' },
  ],
}

const byName = (files: AccountingFile[], name: string): string[][] =>
  parseCsv(files.find((f) => f.name === name)!.content)

describe('accountant CSVs', () => {
  const files = buildAccountingFiles(fixture)

  it('keeps the published headers byte for byte', () => {
    expect(INVOICES_HEADERS.join(',')).toBe(
      'invoice_number,pro,shipment_number,customer_id,customer_name,invoice_date,due_date,terms_days,terms_text,total,paid,written_off,balance,status,factored,factoring_item_id,division_key,issued_by,paid_date,voided_date,void_reason,source',
    )
    expect(AR_PAYMENTS_HEADERS.join(',')).toBe(
      'payment_id,kind,received_date,customer_id,customer_name,method,reference,payment_amount,applied_amount,unapplied_amount,applied_to_invoice_number,applied_to_pro,application_amount,reverses_payment_id,reversed_by_payment_id,note,source',
    )
    expect(CARRIER_BILLS_HEADERS.join(',')).toBe(
      'bill_id,bill_number,pro,shipment_number,load_number,carrier_id,carrier_name,carrier_mc,bill_date,due_date,terms_days,gross,quick_pay_fee,net,billed,variance,paid,credited,balance,status,approved_date,approved_by,payee_kind,voided_date,void_reason,source',
    )
    expect(AP_PAYMENTS_HEADERS.join(',')).toBe(
      'payment_id,kind,paid_date,carrier_id,carrier_name,carrier_mc,method,reference,payment_amount,applied_amount,unapplied_amount,applied_to_bill_id,applied_to_bill_number,applied_to_pro,application_amount,reverses_payment_id,reversed_by_payment_id,note,source',
    )
    for (const f of files) expect(f.content.startsWith('\uFEFF')).toBe(true)
    expect(files.map((f) => f.name)).toEqual(['invoices.csv', 'ar-payments.csv', 'carrier-bills.csv', 'ap-payments.csv'])
  })

  it('writes one invoice row per invoice, sorted by date then id, voided rows included', () => {
    const rows = byName(files, 'invoices.csv')
    expect(rows[0]).toEqual([...INVOICES_HEADERS])
    expect(rows.slice(1).map((r) => r[0])).toEqual(['5001', '5003', '5004', '5002', '5005'])
    const row = rows.find((r) => r[0] === '5001')!
    // pro = the order's first leg; money is decimal dollars; source distinguishes the import
    expect(row[1]).toBe('90001')
    expect(row[2]).toBe('S000001')
    expect(row[9]).toBe('1000.00')
    expect(row[12]).toBe('1000.00')
    expect(row[21]).toBe('BCAT')
    expect(rows.find((r) => r[0] === '5002')![21]).toBe('ALJEX_IMPORT')
    expect(rows.find((r) => r[0] === '5003')![18]).toBe('2026-02-20')
    expect(rows.find((r) => r[0] === '5004')![13]).toBe('VOID')
  })

  it('defuses formula text but not money', () => {
    const rows = byName(files, 'invoices.csv')
    expect(rows.find((r) => r[0] === '5002')![4]).toBe(`'=HYPERLINK("x")`)
    expect(rows.find((r) => r[0] === '5004')![20]).toBe("'-bad reason")
    expect(byName(files, 'ar-payments.csv').find((r) => r[0] === 'P3')![7]).toBe('-50.00')
  })

  it('reconciles: open invoice balances equal the arOpen index total', () => {
    const rows = byName(files, 'invoices.csv').slice(1)
    const csvOpen = rows
      .filter((r) => ['ISSUED', 'PARTIAL'].includes(r[13]))
      .reduce((s, r) => s + Math.round(Number(r[12]) * 100), 0)
    const indexTotal = fixture.invoices.filter((i) => i.arOpen === 'OPEN').reduce((s, i) => s + (i.balanceCents as number), 0)
    expect(csvOpen).toBe(indexTotal)
    expect(openInvoiceBalanceCents(fixture.invoices)).toBe(indexTotal)
  })

  it('emits one AR row per application and one blank-application row for an unapplied credit', () => {
    const rows = byName(files, 'ar-payments.csv').slice(1)
    const p1 = rows.filter((r) => r[0] === 'P1')
    expect(p1.map((r) => r[10])).toEqual(['5001', '5003'])
    expect(p1.map((r) => r[12])).toEqual(['300.00', '1000.00'])
    expect(p1[0][6]).toBe('REF,1')
    expect(p1[0][11]).toBe('90001')
    // the applications add up to the payment's applied amount
    expect(p1.reduce((s, r) => s + Math.round(Number(r[12]) * 100), 0)).toBe(Math.round(Number(p1[0][8]) * 100))
    const p2 = rows.filter((r) => r[0] === 'P2')
    expect(p2).toHaveLength(1)
    expect(p2[0].slice(10, 13)).toEqual(['', '', ''])
    expect(p2[0][9]).toBe('50.00')
    expect(rows.find((r) => r[0] === 'P3')![13]).toBe('P2')
    expect(rows.find((r) => r[0] === 'P3')![16]).toBe('ALJEX_IMPORT')
  })

  it('joins carriers and loads onto bills and AP payments', () => {
    const bills = byName(files, 'carrier-bills.csv').slice(1)
    expect(bills[0].slice(0, 9)).toEqual(['cb:1:1', 'INV-9', '90001', 'S000001', 'S000001-1', 'K1', 'Fake Haul LLC', '123456', '2026-02-10'])
    expect(bills[0].slice(11, 19)).toEqual(['800.00', '0.00', '800.00', '800.00', '0.00', '300.00', '0.00', '500.00'])
    expect(bills[1][19]).toBe('VOID')
    const ap = byName(files, 'ap-payments.csv').slice(1)
    expect(ap[0].slice(0, 3)).toEqual(['A1', 'PAYMENT', '2026-02-15'])
    expect(ap[0].slice(11, 15)).toEqual(['cb:1:1', 'INV-9', '90001', '300.00'])
    expect(ap[1].slice(11, 15)).toEqual(['', '', '', ''])
  })

  it('applies the date window per file and the status filter to invoices and bills only', () => {
    const windowed = buildAccountingFiles(fixture, { from: '2026-02-05', to: '2026-02-20' })
    expect(byName(windowed, 'invoices.csv').slice(1).map((r) => r[0])).toEqual(['5002'])
    expect([...new Set(byName(windowed, 'ar-payments.csv').slice(1).map((r) => r[0]))]).toEqual(['P1'])
    expect(byName(windowed, 'ap-payments.csv').slice(1).map((r) => r[0])).toEqual(['A1', 'A2'])
    const open = buildAccountingFiles(fixture, { status: ['ISSUED', 'PARTIAL'] })
    expect(byName(open, 'invoices.csv').slice(1).map((r) => r[13])).not.toContain('VOID')
    expect(byName(open, 'ar-payments.csv').length).toBe(byName(files, 'ar-payments.csv').length)
  })
})

describe('a load with two carriers (Step AT)', () => {
  // One load, one PRO, two carriers, one bill each. The CSV is one row per bill; the shipment is not counted twice.
  const twoCarriers: AccountingInput = {
    ...fixture,
    carriers: [...fixture.carriers, { id: 'K2', name: 'Second Haul Inc', mcNumber: '654321' }],
    carrierBills: [
      { id: 'cb:1:1', billNumber: 'A-1', loadId: 'L1', shipmentId: 'S1', carrierId: 'K1', billDate: '2026-02-10', dueAt: '2026-03-12', termsDays: 30, grossCents: 60000, quickPayFeeCents: 0, netCents: 60000, billedCents: 60000, varianceCents: 0, paidCents: 0, creditedCents: 0, balanceCents: 60000, status: 'IN_REVIEW', createdBy: 'a@x.test' },
      { id: 'cb:9:1', billNumber: 'B-1', loadId: 'L1', shipmentId: 'S1', carrierId: 'K2', billDate: '2026-02-10', dueAt: '2026-03-12', termsDays: 30, grossCents: 20000, quickPayFeeCents: 500, netCents: 19500, billedCents: 20000, varianceCents: 0, paidCents: 0, creditedCents: 0, balanceCents: 19500, status: 'TO_BE_PAID', createdBy: 'a@x.test' },
    ],
    apPayments: [],
  }
  const rows = byName(buildAccountingFiles(twoCarriers), 'carrier-bills.csv')

  it('writes one row per bill on the same PRO, each with its own carrier and money', () => {
    expect(rows[0]).toEqual([...CARRIER_BILLS_HEADERS])
    const bills = rows.slice(1)
    expect(bills).toHaveLength(2)
    expect(bills.map((r) => r[2])).toEqual(['90001', '90001'])
    expect(bills.map((r) => r[0]).sort()).toEqual(['cb:1:1', 'cb:9:1'])
    const a = bills.find((r) => r[0] === 'cb:1:1')!
    const b = bills.find((r) => r[0] === 'cb:9:1')!
    expect([a[5], a[6], a[11], a[13]]).toEqual(['K1', 'Fake Haul LLC', '600.00', '600.00'])
    expect([b[5], b[6], b[7], b[11], b[12], b[13]]).toEqual(['K2', 'Second Haul Inc', '654321', '200.00', '5.00', '195.00'])
  })

  it('does not double count: the rows add up to the sum of the bills, not the load twice', () => {
    const gross = rows.slice(1).reduce((s, r) => s + Math.round(Number(r[11]) * 100), 0)
    expect(gross).toBe(80000)
  })
})
