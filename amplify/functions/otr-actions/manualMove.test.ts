import { describe, it, expect, beforeEach } from 'vitest'
import { StaleError, manualInvoiceMove, returnToFactoring, type MoveStore, type Row } from './manualMove'

const jenny = { email: 'jenny@bcatcorp.com', groups: ['page-billingRelease'] }
const admin = { email: 'admin@bcatcorp.com', groups: ['ADMIN'] }

interface Fake extends MoveStore {
  item: Row
  invoice: Row
  customer: Row
  writes: string[]
  audits: Array<{ entityType: string; action: string; user: string; changes: Row }>
  failCustomer: boolean
}

function fake(over: { item?: Row; invoice?: Row; customer?: Row } = {}): Fake {
  const f: Fake = {
    item: { id: '14538', proNumber: '14538', status: 'PENDING_WITH_OTR', invoiceId: 'inv1', customerId: 'c1', otrInvoiceId: '99', otrStatus: 6, otrError: null, ...over.item },
    invoice: { id: 'inv1', status: 'ISSUED', factored: true, customerId: 'c1', version: 3, ...over.invoice },
    customer: { id: 'c1', name: 'ACME Freight', billingMethod: 'FACTOR', apEmail: 'ap@acme.com', ...over.customer },
    writes: [],
    audits: [],
    failCustomer: false,
    getItem: async () => ({ ...f.item }),
    getInvoice: async () => ({ ...f.invoice }),
    getCustomer: async () => ({ ...f.customer }),
    getLoadCustomerId: async () => null,
    async writeItemAndInvoice(w) {
      if (w.itemId && Object.keys(w.itemPatch).length && f.item.status !== w.expectItemStatus) throw new StaleError('status moved')
      if (Object.keys(w.itemPatch).length) { Object.assign(f.item, w.itemPatch); f.writes.push(`item:${String(w.itemPatch.status)}`) }
      if (w.invoice) { f.invoice.factored = w.invoice.factored; f.writes.push(`invoice.factored=${w.invoice.factored}`) }
    },
    async writeCustomer(w) {
      if (f.failCustomer) throw new Error('ddb down')
      if ((f.customer.billingMethod ?? null) !== w.expectMethod) throw new StaleError('customer changed')
      f.customer.billingMethod = w.method
      f.customer.apEmail = w.apEmail
      f.writes.push(`customer:${w.method}`)
    },
    async audit(entityType, _id, action, user, changes) { f.audits.push({ entityType, action, user, changes }) },
    now: () => '2026-11-09T12:00:00.000Z',
  }
  return f
}

let f: Fake
beforeEach(() => { f = fake() })

describe('No buy -> Invoice manually (item and customer default)', () => {
  it('moves the invoice first, then the customer, and audits both with who/when/invoice/customer/old->new/OTR reason', async () => {
    f.item.otrError = 'OTR will not buy from MC 592002 (No Buy): not approved'
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true }, jenny)
    expect(r.ok && r.data).toMatchObject({ status: 'MANUAL_INVOICE', reason: 'NO_BUY', customerChanged: true, alreadyDone: false })
    expect(f.writes).toEqual(['item:MANUAL_INVOICE', 'invoice.factored=false', 'customer:MANUAL'])
    expect(f.item.manualReason).toBe('NO_BUY')
    expect(f.invoice.factored).toBe(false)
    expect(f.customer.billingMethod).toBe('MANUAL')
    const item = f.audits.find((a) => a.entityType === 'FactoringItem')!
    expect(item).toMatchObject({ action: 'MANUAL_INVOICE', user: jenny.email })
    expect(item.changes).toMatchObject({ invoiceId: 'inv1', otrReason: expect.stringContaining('not approved'), at: '2026-11-09T12:00:00.000Z', invoiceFactoredBefore: true, invoiceFactoredAfter: false })
    const cust = f.audits.find((a) => a.entityType === 'Customer')!
    expect(cust).toMatchObject({ action: 'BILLING_METHOD_CHANGED', user: jenny.email })
    expect(cust.changes).toMatchObject({ customerName: 'ACME Freight', oldMethod: 'FACTOR', newMethod: 'MANUAL', invoiceId: 'inv1', otrReason: expect.stringContaining('not approved') })
  })

  it('refuses without a valid customer AP e-mail, writing nothing', async () => {
    f.customer.apEmail = ''
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true }, jenny)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no valid AP e-mail/) })
    expect(f.writes).toEqual([])
    expect(f.audits).toEqual([])
    const bad = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true, customerApEmail: 'nope' }, jenny)
    expect(bad.ok).toBe(false)
    expect(f.writes).toEqual([])
  })

  it('saves a typed AP e-mail to the customer in the same step, audited, and never overwrites a valid one', async () => {
    f.customer.apEmail = 'not-an-email'
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true, customerApEmail: 'AP@Acme.com' }, jenny)
    expect(r.ok).toBe(true)
    expect(f.customer).toMatchObject({ billingMethod: 'MANUAL', apEmail: 'ap@acme.com' })
    expect(f.audits.find((a) => a.action === 'AP_EMAIL_SET')?.changes).toMatchObject({ oldApEmail: 'not-an-email', newApEmail: 'ap@acme.com' })

    const g = fake()
    await manualInvoiceMove(g, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true, customerApEmail: 'other@x.com' }, jenny)
    expect(g.customer.apEmail).toBe('ap@acme.com')
    expect(g.audits.some((a) => a.action === 'AP_EMAIL_SET')).toBe(false)
  })

  it('is idempotent: a repeat changes and audits nothing', async () => {
    await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true }, jenny)
    const writes = [...f.writes]
    const audits = f.audits.length
    const again = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true }, jenny)
    expect(again.ok && again.data.alreadyDone).toBe(true)
    expect(f.writes).toEqual(writes)
    expect(f.audits).toHaveLength(audits)
  })

  it('finishes the invoice/customer sync on a No buy row the automatic move already filed', async () => {
    f.item.status = 'MANUAL_INVOICE'
    f.item.manualReason = 'NO_BUY'
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true }, jenny)
    expect(r.ok).toBe(true)
    expect(f.writes).toEqual(['invoice.factored=false', 'customer:MANUAL'])
  })

  it('needs the billing release grant for the customer default: ADMIN is not enough, and nothing is written', async () => {
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true }, admin)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/billing release permission/) })
    expect(f.writes).toEqual([])
    expect(f.item.status).toBe('PENDING_WITH_OTR')
  })

  it('puts the invoice back when the customer write fails (no half state) and audits the rollback', async () => {
    f.failCustomer = true
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true }, jenny)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/left where it was/) })
    expect(f.item).toMatchObject({ status: 'PENDING_WITH_OTR', manualReason: null })
    expect(f.invoice.factored).toBe(true)
    expect(f.customer.billingMethod).toBe('FACTOR')
    expect(f.audits.some((a) => a.action === 'MANUAL_INVOICE_ROLLED_BACK')).toBe(true)
    expect(f.audits.some((a) => a.entityType === 'Customer')).toBe(false)
  })

  it('does not overwrite a customer someone else changed meanwhile', async () => {
    const stale = f.getCustomer
    f.getCustomer = async () => { const c = await stale('c1'); f.customer.billingMethod = 'MANUAL'; return c ? { ...c, billingMethod: 'FACTOR' } : c }
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'NO_BUY', changeCustomerDefault: true }, jenny)
    expect(r.ok).toBe(false)
    expect(f.item.status).toBe('PENDING_WITH_OTR')
  })
})

describe('Invoice manually on any other row', () => {
  it('leaves the customer alone unless the box is ticked, but still syncs Invoice.factored', async () => {
    f.item = { ...f.item, status: 'NEED_TO_FACTOR', otrInvoiceId: undefined, otrStatus: undefined }
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'MANUAL' }, admin)
    expect(r.ok && r.data).toMatchObject({ status: 'MANUAL_INVOICE', reason: 'MANUAL', customerChanged: false })
    expect(f.customer.billingMethod).toBe('FACTOR')
    expect(f.invoice.factored).toBe(false)
    expect(f.audits.map((a) => a.entityType)).toEqual(['FactoringItem'])
  })

  it('changes the customer when the box is ticked', async () => {
    f.item = { ...f.item, status: 'NEED_TO_FACTOR', otrInvoiceId: undefined }
    await manualInvoiceMove(f, { id: '14538', reason: 'MANUAL', changeCustomerDefault: true }, jenny)
    expect(f.customer.billingMethod).toBe('MANUAL')
  })

  it('guards an invoice OTR is still working on until confirmed', async () => {
    f.item.otrStatus = 1
    const r = await manualInvoiceMove(f, { id: '14538', reason: 'MANUAL' }, admin)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already submitted to OTR/) })
    expect(f.writes).toEqual([])
    const ok = await manualInvoiceMove(f, { id: '14538', reason: 'MANUAL', confirmSubmitted: true }, admin)
    expect(ok.ok).toBe(true)
  })

  it('refuses a paid-by-OTR row', async () => {
    f.item.status = 'FACTORED'
    expect((await manualInvoiceMove(f, { id: '14538' }, admin)).ok).toBe(false)
  })
})

describe('return to factoring', () => {
  it('puts the row and Invoice.factored back (Pending with OTR derivation stays correct) and audits', async () => {
    await manualInvoiceMove(f, { id: '14538', reason: 'MANUAL', confirmSubmitted: true }, admin)
    const r = await returnToFactoring(f, { id: '14538' }, admin)
    expect(r.ok && r.data.status).toBe('PENDING_WITH_OTR')
    expect(f.invoice.factored).toBe(true)
    expect(f.item.manualReason).toBeNull()
    expect(f.audits[f.audits.length - 1]).toMatchObject({ action: 'RETURN_TO_FACTORING', user: admin.email })
    const again = await returnToFactoring(f, { id: '14538' }, admin)
    expect(again.ok && again.data.alreadyDone).toBe(true)
    expect(f.audits.filter((a) => a.action === 'RETURN_TO_FACTORING')).toHaveLength(1)
  })

  it('a row never submitted goes back to Need to factor', async () => {
    f.item = { ...f.item, status: 'MANUAL_INVOICE', otrInvoiceId: undefined }
    const r = await returnToFactoring(f, { id: '14538' }, admin)
    expect(r.ok && r.data.status).toBe('NEED_TO_FACTOR')
  })

  it('is refused once the invoice was e-mailed or sent', async () => {
    f.item.status = 'MANUAL_INVOICE'
    f.item.manualSteps = { emailed: { at: 'x', by: 'y' } }
    expect(await returnToFactoring(f, { id: '14538' }, admin)).toMatchObject({ ok: false, error: expect.stringMatching(/already been sent/) })
    f.item.manualSteps = null
    f.invoice.sentAt = '2026-11-01T00:00:00Z'
    expect((await returnToFactoring(f, { id: '14538' }, admin)).ok).toBe(false)
    f.invoice.sentAt = undefined
    f.item.status = 'INVOICED_MANUALLY'
    expect((await returnToFactoring(f, { id: '14538' }, admin)).ok).toBe(false)
    expect(f.item.status).toBe('INVOICED_MANUALLY')
  })
})
