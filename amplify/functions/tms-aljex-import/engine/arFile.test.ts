import { describe, expect, it } from 'vitest'
import { AR_BUCKETS } from '../../../../src/lib/aljex/layouts/arReport'
import { parseArReportCsv } from '../../../../src/lib/aljex/layouts/arReport'
import {
  arCsv,
  FIXTURE_AR_ACCOUNTS,
  FIXTURE_AR_AS_OF,
  FIXTURE_AR_BILL_TO_DIFFERS,
  FIXTURE_AR_DANISCO_COUNT,
  FIXTURE_AR_FACTORED_ACCOUNT,
  FIXTURE_AR_FACTORED_COUNT,
  FIXTURE_AR_INVOICES,
  FIXTURE_AR_PAID_CENTS,
  FIXTURE_AR_TOTAL_CENTS,
  fixtureArInvoices,
} from '../../../../src/lib/aljex/layouts/arReportFixture'
import { addDays, runArFile } from './arFile'
import type { MemoryStore } from './memoryStore'
import { reconcileAr } from './reconcile'
import { makeStore } from './testKit'
import { IMPORT_ACTOR } from './types'

const CUTOFF = FIXTURE_AR_AS_OF
const sum = (rows: Array<Record<string, unknown>>, k: string) => rows.reduce((n, r) => n + (r[k] as number), 0)

/** A target holding the customers (one FACTOR, the rest MANUAL), and an order + load for every fixture PRO. */
function seeded(opts: { skipPros?: string[]; skipCustomers?: string[] } = {}): MemoryStore {
  const store = makeStore()
  store.seed(
    'customer',
    FIXTURE_AR_ACCOUNTS.filter((a) => !opts.skipCustomers?.includes(a)).map((a) => ({ id: `cus-${a}`, name: `ZZ CUSTOMER ${a}`, aljexCode: a, billingMethod: a === FIXTURE_AR_FACTORED_ACCOUNT ? 'FACTOR' : 'MANUAL' })),
  )
  for (const f of fixtureArInvoices()) {
    if (opts.skipPros?.includes(f.pro)) continue
    store.seed('order', [{ id: `ord-${f.pro}`, shipmentId: `shp-${f.pro}`, customerId: `cus-${f.customerAccount}` }])
    store.seed('load', [{ id: `lod-${f.pro}`, aljexId: f.pro, orderId: `ord-${f.pro}`, shipmentId: `shp-${f.pro}` }])
  }
  return store
}

const apply = (store: MemoryStore, runId = 'run1') => runArFile(store, { runId, text: arCsv(), cutoff: CUTOFF })

describe('AR report import', () => {
  it('writes 296 carried-over open invoices that total $357,753.44 and never queue factoring', async () => {
    const store = seeded()
    const { report } = await apply(store)
    expect(report).toMatchObject({ invoices: FIXTURE_AR_INVOICES, totalCents: FIXTURE_AR_TOTAL_CENTS, created: FIXTURE_AR_INVOICES, unresolved: [], partialCount: 3, billToDiffers: FIXTURE_AR_BILL_TO_DIFFERS, billToNameDiffers: FIXTURE_AR_BILL_TO_DIFFERS })

    const invoices = store.own('invoice')
    expect(invoices).toHaveLength(FIXTURE_AR_INVOICES)
    expect(sum(invoices, 'balanceCents')).toBe(FIXTURE_AR_TOTAL_CENTS)
    expect(invoices.every((i) => i.arOpen === 'OPEN' && i.markedSentNote === `Carried over from Aljex (cutoff ${CUTOFF})` && i.markedSentBy === IMPORT_ACTOR && i.markedSentAt && !i.sentAt)).toBe(true)
    expect(invoices.filter((i) => i.status === 'PARTIAL')).toHaveLength(3)
    expect(invoices.filter((i) => i.status === 'ISSUED')).toHaveLength(FIXTURE_AR_INVOICES - 3)
    for (const i of invoices) expect(i.totalCents).toBe((i.balanceCents as number) + (i.paidCents as number))

    // Partial payments: one ArPayment of the amount paid, applied to its invoice.
    const payments = store.own('arPayment')
    expect(payments).toHaveLength(3)
    expect(sum(payments, 'amountCents')).toBe(FIXTURE_AR_PAID_CENTS)
    expect(payments.every((p) => p.method === 'OTHER' && p.reference === 'prior payment' && p.unappliedCents === 0 && (p.applications as unknown[]).length === 1)).toBe(true)

    // Linked to the order / shipment of the PRO, invoice number = PRO.
    const first = invoices.find((i) => i.number === '900001')!
    expect(first).toMatchObject({ id: '900001', orderId: 'ord-900001', shipmentId: 'shp-900001', customerId: `cus-${FIXTURE_AR_FACTORED_ACCOUNT}`, factored: true })
    expect(store.own('order').find((o) => o.id === 'ord-900001')).toMatchObject({ invoiceId: '900001', arBalanceCents: first.balanceCents })

    // Factored vs manual by the customer's billing method; no factoring-queue row is created.
    expect(invoices.filter((i) => i.factored === true)).toHaveLength(FIXTURE_AR_FACTORED_COUNT)
    expect(report.split.factored.count).toBe(FIXTURE_AR_FACTORED_COUNT)
    expect(report.split.factored.cents + report.split.manual.cents).toBe(FIXTURE_AR_TOTAL_CENTS)
    expect(store.own('factoringItem')).toHaveLength(0)
  })

  it('keeps Aljex due dates and the bill-to party; redates every Danisco invoice to invoice date + 120 with an audit line', async () => {
    const store = seeded()
    const { report } = await apply(store)
    const fixture = new Map(fixtureArInvoices().map((f) => [f.pro, f]))
    const invoices = store.own('invoice')
    const danisco = invoices.filter((i) => ['100338', '100629'].some((a) => i.customerId === `cus-${a}`))
    expect(danisco).toHaveLength(FIXTURE_AR_DANISCO_COUNT)
    for (const i of danisco) {
      const f = fixture.get(i.number as string)!
      expect(i).toMatchObject({ dueAt: addDays(f.invoiceDate, 120), termsDays: 120, termsText: 'Net 120', aljexDueDate: f.dueDate, aljexTerms: 90 })
    }
    for (const i of invoices.filter((x) => !danisco.includes(x))) {
      const f = fixture.get(i.number as string)!
      expect(i.dueAt).toBe(f.dueDate)
      expect(i.aljexDueDate).toBeUndefined()
    }
    const redates = store.own('auditLog').filter((a) => a.action === 'ALJEX_AR_REDATE')
    expect(redates).toHaveLength(FIXTURE_AR_DANISCO_COUNT)
    expect(redates[0].changes).toMatchObject({ reason: 'Danisco 120-day redate, Ryne round 4' })
    expect((redates[0].changes as { beforeDueAt: string }).beforeDueAt).not.toBe((redates[0].changes as { afterDueAt: string }).afterDueAt)
    expect(report.redated.count).toBe(FIXTURE_AR_DANISCO_COUNT)
    expect(report.redated.openCents).toBe(sum(danisco, 'balanceCents'))

    // The bill-to party is preserved with its Aljex account.
    const differs = invoices.filter((i) => (i.billTo as { aljexAccount: string }).aljexAccount === '920001')
    expect(differs).toHaveLength(FIXTURE_AR_BILL_TO_DIFFERS)
    expect(differs.every((i) => (i.billTo as { name: string }).name === 'ZZ BILLING PARTY')).toBe(true)
    // The report's bucket total is the Aljex one; the BCAT total after the redate is the same money.
    expect(AR_BUCKETS.reduce((n, b) => n + report.byBucketBcat[b], 0)).toBe(FIXTURE_AR_TOTAL_CENTS)
  })

  it('is idempotent: re-applying changes nothing', async () => {
    const store = seeded()
    await apply(store, 'run1')
    const snap = () => JSON.stringify(['invoice', 'arPayment', 'order'].map((t) => store.own(t as 'invoice').sort((a, b) => String(a.id).localeCompare(String(b.id)))))
    const before = snap()
    const audits = store.own('auditLog').length
    const { report } = await apply(store, 'run2')
    expect(report).toMatchObject({ created: 0, enrichedExisting: 0, matchedExisting: FIXTURE_AR_INVOICES, priorPaymentsCreated: 0 })
    expect(snap()).toBe(before)
    expect(store.own('auditLog')).toHaveLength(audits)
  })

  it('reports an unknown PRO or customer account instead of writing or inventing it', async () => {
    const store = seeded({ skipPros: ['900010'], skipCustomers: ['910002'] })
    const { report, files } = await apply(store)
    const noCustomer = fixtureArInvoices().filter((f) => f.customerAccount === '910002' && f.pro !== '900010')
    expect(report.unresolved.find((u) => u.proKey === '900010')?.reason).toBe('PRO_NOT_IN_BCAT')
    expect(report.unresolved.filter((u) => u.reason === 'CUSTOMER_NOT_IN_BCAT')).toHaveLength(noCustomer.length)
    expect(report.created).toBe(FIXTURE_AR_INVOICES - report.unresolved.length)
    expect(store.own('invoice').some((i) => i.number === '900010')).toBe(false)
    expect(files['ar-unresolved.csv'].split('\n')).toHaveLength(report.unresolved.length + 1)
  })

  it('brings an invoice the big-export import already wrote in line instead of duplicating it', async () => {
    const store = seeded()
    const f = fixtureArInvoices().find((x) => x.customerAccount === '100338')!
    store.seed('order', [{ id: `ord-${f.pro}`, shipmentId: `shp-${f.pro}`, invoiceId: f.pro }])
    store.seed('invoice', [{ id: f.pro, number: f.pro, orderId: `ord-${f.pro}`, customerId: 'cus-100338', status: 'ISSUED', invoiceDate: f.invoiceDate, issuedAt: `${f.invoiceDate}T12:00:00.000Z`, issuedBy: IMPORT_ACTOR, dueAt: addDays(f.invoiceDate, 30), termsDays: 30, invoiceMonth: f.invoiceDate.slice(0, 7), subtotalCents: f.openCents, totalCents: f.openCents, paidCents: 0, writtenOffCents: 0, balanceCents: f.openCents, arOpen: 'OPEN', billTo: { name: 'ZZ CUSTOMER 100338' }, factored: false, createdBy: IMPORT_ACTOR, updatedBy: IMPORT_ACTOR, version: 1 }])
    const { report } = await apply(store)
    expect(report).toMatchObject({ created: FIXTURE_AR_INVOICES - 1, enrichedExisting: 1 })
    expect(store.own('invoice').filter((i) => i.number === f.pro)).toHaveLength(1)
    expect(store.own('invoice').find((i) => i.id === f.pro)).toMatchObject({ dueAt: addDays(f.invoiceDate, 120), aljexDueDate: f.dueDate, aljexTerms: 90 })
    expect(store.own('auditLog').filter((a) => a.entityId === f.pro && a.action === 'ALJEX_AR_REDATE')).toHaveLength(1)
  })
})

describe('AR reconciliation', () => {
  it('ties by invoice, customer, bill-to, bucket and split to the cent; Danisco redates are approved differences', async () => {
    const store = seeded()
    await apply(store)
    const rec = await reconcileAr(store, 'run1', parseArReportCsv(arCsv()), { asOf: CUTOFF, customerListBalanceDueCents: FIXTURE_AR_TOTAL_CENTS })
    expect(rec.counts).toEqual({ MATCHED: FIXTURE_AR_INVOICES - FIXTURE_AR_DANISCO_COUNT, APPROVED: FIXTURE_AR_DANISCO_COUNT, MISMATCH: 0, ALJEX_ONLY: 0, BCAT_ONLY: 0 })
    expect(rec.allMatched).toBe(true)
    expect(rec.fileCents).toBe(FIXTURE_AR_TOTAL_CENTS)
    expect(rec.bcatMatchedCents).toBe(FIXTURE_AR_TOTAL_CENTS)
    expect(rec.bcatOpenAllCents).toBe(FIXTURE_AR_TOTAL_CENTS)
    expect(rec.bridge.every((l) => l.diffCents === 0)).toBe(true)
    expect(rec.bridge.map((l) => l.key)).toEqual(expect.arrayContaining(['arTotal', 'arPreviousPayments', 'arFactored', 'arManual', 'arCustomerList']))
    for (const g of [...rec.byCustomer, ...rec.byBillTo, ...rec.bySplit]) expect(g.diffCents).toBe(0)
    expect(rec.byCustomer).toHaveLength(FIXTURE_AR_ACCOUNTS.length)
    expect(rec.byBillTo.find((g) => g.key === '920001')?.fileCents).toBeGreaterThan(0)
    // The Danisco redate moves money between buckets: every bucket difference is the approved shift.
    expect(rec.byBucket.some((g) => g.diffCents !== 0)).toBe(true)
    expect(rec.byBucket.every((g) => g.unexplainedCents === 0)).toBe(true)
    expect(rec.byBucket.reduce((n, g) => n + g.diffCents, 0)).toBe(0)
    const approved = rec.rows.filter((r) => r.outcome === 'APPROVED')
    expect(approved.every((r) => r.approval?.approver === 'POLICY: Ryne round 4' && r.approval.note === 'Danisco 120-day redate (Ryne decision, round 4)' && r.notes.some((n) => n.startsWith('due date redated')))).toBe(true)
    expect(rec.redated.count).toBe(FIXTURE_AR_DANISCO_COUNT)
  })

  it('shows a changed balance, a stray due date and a BCAT-only invoice as open differences', async () => {
    const store = seeded()
    await apply(store)
    const bump = (id: string, patch: Record<string, unknown>) => store.update('invoice', id, patch)
    await bump('900002', { balanceCents: 1 })
    await bump('900003', { dueAt: '2030-01-01' })
    store.seed('invoice', [{ id: '777', number: '777', orderId: 'ord-x', customerId: `cus-${FIXTURE_AR_FACTORED_ACCOUNT}`, balanceCents: 5_000, paidCents: 0, arOpen: 'OPEN', invoiceDate: '2026-10-01', dueAt: '2026-10-31', factored: false, billTo: { name: 'ZZ' } }])
    const rec = await reconcileAr(store, 'run1', parseArReportCsv(arCsv()), { asOf: CUTOFF })
    expect(rec.counts.MISMATCH).toBe(2)
    expect(rec.counts.BCAT_ONLY).toBe(1)
    expect(rec.rows.find((r) => r.pro === '900002')?.notes).toContain('amount')
    expect(rec.rows.find((r) => r.pro === '900003')?.notes).toContain('due date')
    expect(rec.allMatched).toBe(false)
    expect(rec.bridge.find((l) => l.key === 'arOpenAll')?.diffCents).not.toBe(0)
  })
})
