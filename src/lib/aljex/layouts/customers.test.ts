import { describe, expect, it } from 'vitest'
import { CUSTOMER_COLUMNS, detectCustomersLayout, parseCustomerRows, type CustomerColumnKey } from './customers'

// Synthetic rows only. 'CANARY' marks a value that must never travel anywhere.
const HEADERS = [...Object.values(CUSTOMER_COLUMNS), 'Web Password', 'Salesrep']

function row(over: Partial<Record<CustomerColumnKey, string>> & { pw?: string } = {}): string[] {
  const base: Record<CustomerColumnKey, string> = {
    name: 'Northwind Foods', address: '1 Main St', address2: '', city: 'Springfield', state: 'IL', zip: '62701', zip4: '', phone: '555-0100', fax: '',
    contact: 'Pat Doe', contactExt: '', contactEmail: 'pat@example.com', contact2: '', contact2Ext: '', contact2Email: '',
    account: '900001', status: 'Y', customerType: '', termsDays: '', revType: 'B', creditLimit: '5000.00', balanceDue: '12.50', invoiceBy: '1',
    eBillingEmail: 'ap@example.com', firstShipment: '01/05/24', lastShipment: '10/01/26', totalShipments: '12', ...over,
  }
  return [...(Object.keys(CUSTOMER_COLUMNS) as CustomerColumnKey[]).map((k) => base[k]), over.pw ?? 'CANARY-PW', 'AB']
}

describe('customers layout', () => {
  it('recognises the layout by header text, in any column order', () => {
    expect(detectCustomersLayout(HEADERS).matches).toBe(true)
    expect(detectCustomersLayout([...HEADERS].reverse()).matches).toBe(true)
    const broken = detectCustomersLayout(HEADERS.filter((h) => h !== 'Account #'))
    expect(broken.matches).toBe(false)
    expect(broken.missing).toEqual(['Account #'])
  })

  it('never lists the portal password column as mapped and never copies its value', () => {
    expect(Object.values(CUSTOMER_COLUMNS)).not.toContain('Web Password')
    const parsed = parseCustomerRows(HEADERS, [row()])
    expect(JSON.stringify(parsed)).not.toContain('CANARY')
  })

  it('keys on Account #: same name under two accounts stays two customers, grouped as possible duplicates', () => {
    const parsed = parseCustomerRows(HEADERS, [row({ account: '900001', name: 'Fox Logistics LLC' }), row({ account: '900002', name: 'FOX LOGISTICS, INC.' }), row({ account: '900003', name: 'Other Co' })])
    expect(parsed.customers.map((c) => c.account)).toEqual(['900001', '900002', '900003'])
    expect(parsed.duplicateGroups).toEqual([{ key: 'fox logistics', accounts: ['900001', '900002'] }])
  })

  it('rejects a repeated or missing Account # instead of merging on name', () => {
    const parsed = parseCustomerRows(HEADERS, [row(), row({ name: 'Different' }), row({ account: '' })])
    expect(parsed.customers).toHaveLength(1)
    expect(parsed.rejected.map((r) => r.reason)).toEqual(['repeated Account # 900001', 'no Account #'])
  })

  it('excludes TEST CUSTOMER 100003 and ZZ/test names but imports GUEST SUPPLY', () => {
    const parsed = parseCustomerRows(HEADERS, [
      row({ account: '100003', name: 'TEST CUSTOMER' }), row({ account: '900010', name: 'ZZ Demo' }), row({ account: '900011', name: 'Guest Supply' }),
    ])
    expect(parsed.excluded.map((e) => e.account)).toEqual(['100003', '900010'])
    expect(parsed.customers.map((c) => c.account)).toEqual(['900011'])
  })

  it('Status N becomes a Location candidate, never a customer, and gets no billing method', () => {
    const parsed = parseCustomerRows(HEADERS, [row({ status: 'N' })])
    expect(parsed.customers).toHaveLength(0)
    expect(parsed.locations).toHaveLength(1)
    expect(parsed.locations[0].billing.billingMethod).toBeNull()
  })

  it('seeds billing from the e-billing address (factor / manual / internal) and counts it', () => {
    const parsed = parseCustomerRows(HEADERS, [
      row({ account: '900021', eBillingEmail: 'ivanfactoring@bcatcorp.com' }),
      row({ account: '900022', eBillingEmail: 'invoicefactoring@bcatcorp.com' }),
      row({ account: '900023', eBillingEmail: 'invoices@bcatcorp.com' }),
      row({ account: '900024', eBillingEmail: 'AP@Example.com' }),
      row({ account: '900025', eBillingEmail: '' }),
    ])
    const by = Object.fromEntries(parsed.customers.map((c) => [c.account, c.billing]))
    expect(by['900021'].billingMethod).toBe('FACTOR')
    expect(by['900022'].billingMethod).toBe('FACTOR')
    expect(by['900023']).toMatchObject({ billingMethod: 'MANUAL', apEmail: null })
    expect(by['900023'].billingNeedsReview).toBeTruthy()
    expect(by['900024']).toMatchObject({ billingMethod: 'MANUAL', apEmail: 'ap@example.com' })
    expect(by['900025'].billingMethod).toBeNull()
    expect(parsed.counts).toMatchObject({ factor: 2, manual: 2, unset: 1, needsReview: 2 })
  })

  it('terms: Danisco accounts and name variants get 120, an explicit Aljex value is kept, blank stays unset', () => {
    const parsed = parseCustomerRows(HEADERS, [
      row({ account: '100338', name: 'DANISCO US INC.' }),
      row({ account: '100629', name: 'DANISCO USA INC.', termsDays: '30' }),
      row({ account: '900031', name: 'DANISCO US, INC.' }),
      row({ account: '900032', termsDays: '15' }),
      row({ account: '900033', termsDays: '30' }),
      row({ account: '900034' }),
    ])
    expect(parsed.customers.map((c) => c.paymentTermsDays)).toEqual([120, 120, 120, 15, 30, null])
  })

  it('maps Rev Type to the default division, keeps credit limit, never takes Balance Due as a customer field', () => {
    const parsed = parseCustomerRows(HEADERS, [
      row({ account: '900041', revType: 'I' }), row({ account: '900042', revType: 'A' }), row({ account: '900043', revType: 'S' }), row({ account: '900044', creditLimit: '.00' }),
    ])
    expect(parsed.customers.map((c) => c.defaultDivisionKey)).toEqual(['ASSETS', 'CAR_SHIPPING', null, 'BROKERAGE'])
    expect(parsed.customers[0].creditLimitCents).toBe(500000)
    expect(parsed.customers[3].creditLimitCents).toBeNull()
    expect(parsed.customers[0].balanceDueCents).toBe(1250)
    expect(parsed.counts.revTypeUnmapped).toBe(1)
  })
})
