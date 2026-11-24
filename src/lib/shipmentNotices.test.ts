import { describe, it, expect } from 'vitest'
import {
  renderRemittanceTableEmail,
  INVOICE_EMAIL_BODY,
  milestoneRecipients,
  remittanceRecipients,
  renderInvoiceBatchEmail,
  renderInvoiceEmail,
  renderMilestoneEmail,
  renderRemittanceEmail,
  uploadLinkExpiry,
} from './shipmentNotices'
import type { InvoiceEmailInvoice, NoticeStop, RemittanceEmailBill } from './shipmentNotices'
import type {
  CarrierContactRecord,
  CustomerContact,
  CustomerNotification,
  VisibilityPrefs,
} from '../types/tms'

const PREFS: VisibilityPrefs = { milestoneEmails: true, sharedTrackingLink: true, shipperPortal: false }

function contact(id: string, overrides: Partial<CustomerContact> = {}): CustomerContact {
  return {
    id,
    name: `Contact ${id}`,
    email: `${id}@shipper.test`,
    types: ['OPERATIONS'],
    notifications: ['DELIVERED'],
    active: true,
    ...overrides,
  }
}

const CONTACTS: CustomerContact[] = [
  contact('amy'),
  contact('bob', { active: false }),
  contact('cal', { email: null }),
  contact('dee', { notifications: ['PICKED_UP'] }),
]

function recipients(milestone: CustomerNotification, prefs: VisibilityPrefs = PREFS): string[] {
  return milestoneRecipients({ contacts: CONTACTS, visibilityPrefs: prefs }, milestone).map((c) => c.id)
}

const STOPS: NoticeStop[] = [
  { type: 'pickup', name: 'Midwest Cold', city: 'Chicago', state: 'IL', appt: 'Mar 2, 08:00' },
  { type: 'delivery', name: 'Gateway DC', city: 'Dallas', state: 'TX', appt: 'Mar 4, 14:00' },
]

function milestoneEmail(overrides: Partial<Parameters<typeof renderMilestoneEmail>[0]> = {}) {
  return renderMilestoneEmail({
    milestone: 'DELIVERED',
    shipmentNumber: 'S-10042',
    customerName: 'Acme Foods',
    contactName: 'Amy',
    stops: STOPS,
    customerLinkUrl: 'https://track.bcat.test/t/abc123',
    deliveredAt: 'Mar 4, 14:32 CT',
    brokerName: 'BCAT Logistics',
    ...overrides,
  })
}

describe('milestoneRecipients', () => {
  it('writes to the active, subscribed contacts with an address', () => {
    expect(recipients('DELIVERED')).toEqual(['amy'])
  })

  it('writes to nobody until the customer is switched on', () => {
    expect(recipients('DELIVERED', { ...PREFS, milestoneEmails: false })).toEqual([])
    expect(milestoneRecipients({ contacts: CONTACTS, visibilityPrefs: null }, 'DELIVERED')).toEqual([])
  })

  it('writes to nobody when nobody subscribed to that milestone', () => {
    expect(recipients('IN_TRANSIT')).toEqual([])
  })
})

describe('renderMilestoneEmail', () => {
  it('names the carrier only when the caller passed one', () => {
    expect(milestoneEmail().body).not.toMatch(/Carrier/)
    expect(milestoneEmail({ carrierName: 'Blue Line Trucking' }).body).toContain('Blue Line Trucking')
  })

  it('tells the customer nothing about money', () => {
    const { body } = milestoneEmail({
      references: [{ code: 'PO', label: 'PO number', value: 'PO-99812' }],
    })
    expect(body).toContain('PO-99812')
    expect(body).not.toMatch(/\$|\bUSD\b|cents/i)
  })

  it('sends the customer their own wording when it can carry the link', () => {
    const { body } = milestoneEmail({ template: 'Load {number} is {milestone}. See {url}' })
    expect(body).toContain('Load S-10042 is delivered. See https://track.bcat.test/t/abc123')
    expect(body).not.toContain('Track it here')
  })

  it('falls back to the default when the custom wording has no link in it', () => {
    const { body } = milestoneEmail({ template: 'Load {number} has arrived.' })
    expect(body).not.toContain('Load S-10042 has arrived.')
    expect(body).toContain('https://track.bcat.test/t/abc123')
  })
})

describe('uploadLinkExpiry', () => {
  const now = '2026-03-04T18:00:00.000Z'

  it('expires the agreed number of days after delivery', () => {
    expect(uploadLinkExpiry('2026-03-04T14:00:00.000Z', 30, now)).toBe('2026-04-03T14:00:00.000Z')
  })

  it('still gives a day to a link minted for a load that delivered weeks ago', () => {
    expect(uploadLinkExpiry('2026-01-02T14:00:00.000Z', 30, now)).toBe('2026-03-05T18:00:00.000Z')
  })

  it('counts from now when nothing delivered yet', () => {
    expect(uploadLinkExpiry(null, 30, now)).toBe('2026-04-03T18:00:00.000Z')
  })
})

const INVOICE: InvoiceEmailInvoice = {
  number: 'INV-000123',
  shipmentNumber: 'S-10042',
  dueAt: '2026-04-03',
  totalCents: 275_000,
  balanceCents: 275_000,
}

const EXPECTED_INVOICE_BODY = [
  'Your report is attached to this email.',
  '',
  'Please send remittance to billing@bcatcorp.com or provide any questions and',
  'a representative will assist you.',
  '',
  'Please do not reply directly to this email.',
  '',
  'Thank you,',
  '',
  'BCAT Logistics & IVAN Cartage',
].join('\n')

describe('renderInvoiceEmail', () => {
  const email = (overrides: Partial<Parameters<typeof renderInvoiceEmail>[0]> = {}) =>
    renderInvoiceEmail({
      invoice: INVOICE,
      customerName: 'Acme Foods',
      contactName: 'Amy',
      brokerName: 'BCAT Logistics',
      ...overrides,
    })

  it('names the PRO and the company in the subject', () => {
    expect(email().subject).toBe('Invoice for Pro # S-10042 Attached from BCAT Logistics Corporation')
    expect(email({ companyName: 'IVAN Cartage Co' }).subject).toBe('Invoice for Pro # S-10042 Attached from IVAN Cartage Co')
  })

  it('puts the customer reference beside the PRO in the subject, and leaves it alone when there is none', () => {
    expect(email({ po: 'FR-113188-3' }).subject).toBe('Invoice for Pro # S-10042 · Ref # FR-113188-3 Attached from BCAT Logistics Corporation')
    expect(email({ po: 'FR-113188-3', companyName: 'IVAN Cartage Co' }).subject).toBe('Invoice for Pro # S-10042 · Ref # FR-113188-3 Attached from IVAN Cartage Co')
    for (const po of [null, undefined, '', '   ']) {
      expect(email({ po }).subject).toBe('Invoice for Pro # S-10042 Attached from BCAT Logistics Corporation')
    }
  })

  it('collapses blanks in the reference and caps a long one', () => {
    expect(email({ po: ' FR-1\n 2 ' }).subject).toContain('· Ref # FR-1 2 Attached')
    const long = email({ po: 'X'.repeat(80) }).subject
    expect(long).toContain(`${'X'.repeat(37)}... Attached from`)
    expect(long.length).toBeLessThan(120)
  })

  it('leads with the PRO and PO, then the agreed body word for word', () => {
    expect(email({ po: 'FR-113188-3' }).body).toBe(`PRO # S-10042 · PO # FR-113188-3\n\n${EXPECTED_INVOICE_BODY}`)
  })

  it('never carries money: no amount, cost, carrier pay or margin', () => {
    const { subject, body } = email({ po: 'PO-1' })
    for (const text of [subject, body]) {
      expect(text).not.toMatch(/\$|\d+\.\d{2}|carrier pay|cost|margin/i)
    }
  })

  it('is exactly the agreed body, whatever the contact, template or amounts', () => {
    expect(email().body).toBe(`PRO # S-10042\n\n${EXPECTED_INVOICE_BODY}`)
    expect(email({ contactName: null, template: 'Invoice {number} attached.' }).body).toBe(`PRO # S-10042\n\n${EXPECTED_INVOICE_BODY}`)
    expect(INVOICE_EMAIL_BODY).toBe(EXPECTED_INVOICE_BODY)
  })

  it('does not restate the amount, the due date or a greeting', () => {
    const { body } = email()
    expect(body).not.toContain('Amount due')
    expect(body).not.toContain('2026-04-03')
    expect(body.split('\n\n')[1].startsWith('Your report is attached to this email.')).toBe(true)
  })
})

describe('renderInvoiceBatchEmail', () => {
  const INVOICES: InvoiceEmailInvoice[] = [
    INVOICE,
    { number: 'INV-000124', shipmentNumber: 'S-10043', dueAt: '2026-04-10', totalCents: 125_000, balanceCents: 100_000 },
    { number: 'INV-000125', shipmentNumber: null, dueAt: '2026-04-17', totalCents: 50_000, balanceCents: 50_000 },
  ]
  const batch = (invoices = INVOICES, overrides: Partial<Parameters<typeof renderInvoiceBatchEmail>[1]> = {}) =>
    renderInvoiceBatchEmail(invoices, {
      customerName: 'Acme Foods',
      contactName: 'Amy',
      brokerName: 'BCAT Logistics',
      ...overrides,
    })

  it('counts the invoices and totals what is owed in the subject', () => {
    expect(batch().subject).toBe('3 invoices · $4250.00 · BCAT Logistics')
    expect(batch([INVOICE]).subject).toBe('1 invoice · $2750.00 · BCAT Logistics')
  })

  it('carries the same fixed body as a single invoice, not a list of the bills', () => {
    const { body } = batch()
    expect(body).toBe(EXPECTED_INVOICE_BODY)
    expect(body).not.toContain('INV-000124')
  })
})

describe('renderRemittanceEmail', () => {
  const BILLS: RemittanceEmailBill[] = [
    { id: 'cb:lc-1:1', billNumber: 'BL-55012', shipmentNumber: 'BC-1001', loadNumber: 'BC-1001-1', netCents: 247_500 },
    { id: 'cb:lc-2:1', billNumber: null, shipmentNumber: 'BC-1002', loadNumber: 'BC-1002-1', netCents: 150_000 },
  ]
  const remittance = (overrides: Partial<Parameters<typeof renderRemittanceEmail>[0]> = {}) =>
    renderRemittanceEmail({
      payment: {
        id: 'ap-1',
        reference: 'ACH-88120',
        paidAt: '2026-02-10T12:00:00.000Z',
        method: 'ACH',
        amountCents: 392_500,
        applications: [
          { billId: 'cb:lc-1:1', amountCents: 247_500 },
          { billId: 'cb:lc-2:1', amountCents: 145_000, creditCents: 5_000 },
        ],
      },
      bills: BILLS,
      carrierName: 'Blue Line Trucking',
      brokerName: 'BCAT Logistics',
      ...overrides,
    })

  it('names the payment and the broker in the subject', () => {
    expect(remittance().subject).toBe('Remittance ACH-88120 · BCAT Logistics')
  })

  it('substitutes the reference and every other token the caller may use', () => {
    const { body } = remittance({ template: '{reference}|{carrier}|{total}|{date}|{method}|{bills}|{broker}' })
    expect(body).toContain('ACH-88120|Blue Line Trucking|$3925.00|2026-02-10|ACH|2 bills|BCAT Logistics')
  })

  it('states the amount sent and the date whatever the template says', () => {
    const { body } = remittance({ template: 'Remittance {reference} attached.' })
    expect(body).toContain('Amount sent: $3925.00')
    expect(body).toContain('Sent 2026-02-10.')
  })

  it('lists what was actually put against each bill, not the bill net', () => {
    const { body } = remittance()
    expect(body).toContain('  • BC-1001 — $2475.00')
    expect(body).toContain('  • BC-1002 — $1450.00')
  })

  it('never prints the carrier invoice number', () => {
    const { body } = remittance()
    expect(body).not.toContain('BL-55012')
    expect(body).not.toContain('BL-55013')
  })

  it('falls back to the default wording when the template cannot name the payment', () => {
    const { body } = remittance({ template: 'Your money is on its way.' })
    expect(body).not.toContain('Your money is on its way.')
    expect(body).toContain('Payment ACH-88120 for $3925.00 has been sent.')
  })

  it('shows nothing in the reference slot when no check or trace number was typed', () => {
    const { subject, body } = remittance({
      payment: { id: 'ap-1', reference: '  ', paidAt: '2026-02-10T12:00:00.000Z', method: 'CHECK', amountCents: 1_000, applications: [] },
    })
    expect(subject).toBe('Remittance · BCAT Logistics')
    expect(body).not.toContain('ap-1')
    expect(body).toContain('Payment for $10.00 has been sent.')
  })

  it('drops the reference slot from a custom template too', () => {
    const { body } = remittance({
      payment: { id: 'ap-1', reference: null, paidAt: '2026-02-10T12:00:00.000Z', method: 'CHECK', amountCents: 1_000, applications: [] },
      template: 'Ref {reference} / {total} sent.',
    })
    expect(body).toContain('Ref / $10.00 sent.')
    expect(body).not.toContain('ap-1')
  })
})

describe('remittanceRecipients', () => {
  const carrierContact = (id: string, overrides: Partial<CarrierContactRecord> = {}): CarrierContactRecord => ({
    id,
    carrierId: 'car-1',
    name: `Contact ${id}`,
    email: `${id}@blueline.test`,
    types: ['ACCOUNTING'],
    active: true,
    createdBy: 'ryne',
    updatedBy: 'ryne',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  })
  const CARRIER = { email: 'office@blueline.test' }
  const CONTACTS = [
    carrierContact('ann'),
    carrierContact('bob', { active: false }),
    carrierContact('cal', { types: ['DISPATCH'] }),
    carrierContact('dee', { email: null }),
    carrierContact('eve'),
  ]

  it('sends to the payee address on the method ahead of anyone else', () => {
    expect(remittanceRecipients(CARRIER, CONTACTS, { payeeEmail: 'remit@otrcapital.test' })).toEqual([
      'remit@otrcapital.test',
    ])
  })

  it('falls to the active accounting contacts when the method carries no payee address', () => {
    expect(remittanceRecipients(CARRIER, CONTACTS, { payeeEmail: null })).toEqual([
      'ann@blueline.test',
      'eve@blueline.test',
    ])
  })

  it('falls to the carrier address only when no accounting contact can be written to', () => {
    expect(remittanceRecipients(CARRIER, [carrierContact('cal', { types: ['DISPATCH'] })], null)).toEqual([
      'office@blueline.test',
    ])
  })

  it('returns nothing rather than a blank address when there is nobody to write to', () => {
    expect(remittanceRecipients({ email: null }, [], null)).toEqual([])
    expect(remittanceRecipients({ email: '   ' }, [carrierContact('dee', { email: '' })], { payeeEmail: '  ' })).toEqual([])
  })

  it('writes to an address once even when two contacts share it', () => {
    const shared = [carrierContact('ann'), carrierContact('ann2', { email: 'ann@blueline.test' })]
    expect(remittanceRecipients(CARRIER, shared, null)).toEqual(['ann@blueline.test'])
  })
})

describe('renderRemittanceTableEmail', () => {
  const payment = {
    id: 'app-1', reference: 'ACH-77', paidAt: '2026-11-17T12:00:00.000Z', amountCents: 150_000,
    applications: [
      { billId: 'b1', amountCents: 100_000 },
      { billId: 'b2', amountCents: 50_000 },
    ],
  }
  const bills = [
    { id: 'b1', billNumber: 'INV-9', shipmentNumber: '14610', loadNumber: null, netCents: 100_000, carrierName: 'Blue Line Trucking' },
    { id: 'b2', billNumber: null, shipmentNumber: '14611', loadNumber: null, netCents: 50_000, carrierName: 'Cardinal Express' },
  ]

  it('opens with the fixed line and tables PRO #, carrier, pay to and what was paid, with a total and no invoice date', () => {
    const mail = renderRemittanceTableEmail({ payment, bills, brokerName: 'BCAT Logistics' })
    expect(mail.body.startsWith('Please find remittance for the below shipments attached:\n')).toBe(true)
    expect(mail.body).toContain('14610')
    expect(mail.body).not.toContain('INV-9')
    expect(mail.body).not.toContain('Carrier invoice')
    expect(mail.body).toContain('PRO #')
    expect(mail.body).toContain('Pay to')
    expect(mail.body).toContain('Blue Line Trucking')
    expect(mail.body).toContain('Cardinal Express')
    expect(mail.body).not.toMatch(/invoice date|2026-10-1\d|2026-10-20/i)
    expect(mail.html).not.toMatch(/invoice date/i)
    expect(mail.html).toContain('Blue Line Trucking')
    expect(mail.body).toContain('$1000.00')
    expect(mail.body).toMatch(/Total\s+\$1500\.00/)
    expect(mail.subject).toBe('Remittance ACH-77 · BCAT Logistics')
    expect(mail.html).toContain('<table')
    expect(mail.html).toContain('Please find remittance for the below shipments attached:')
  })

  it('shows what was paid on the bill, not the bill net, and never anything of the customer or margin', () => {
    const mail = renderRemittanceTableEmail({ payment: { ...payment, applications: [{ billId: 'b1', amountCents: 40_000 }] }, bills, brokerName: 'BCAT' })
    expect(mail.body).toContain('$400.00')
    expect(mail.body).not.toContain('14611')
    expect(mail.body.toLowerCase()).not.toMatch(/margin|customer|rate/)
  })

  it('names who was paid per bill: the factor on a factored bill, the carrier itself otherwise', () => {
    const mail = renderRemittanceTableEmail({
      payment,
      bills: [{ ...bills[0], remitTo: { name: 'OTR Capital LLC' } }, bills[1]],
      brokerName: 'BCAT',
    })
    expect(mail.body).toMatch(/14610\s+Blue Line Trucking\s+OTR Capital LLC\s+\$1000\.00/)
    expect(mail.body).toMatch(/14611\s+Cardinal Express\s+Cardinal Express\s+\$500\.00/)
    expect(mail.html).toContain('OTR Capital LLC')
  })

  it('falls back to the paid carrier when a bill carries no name, and dashes when there is none', () => {
    const bare = bills.map((b) => ({ ...b, carrierName: null }))
    expect(renderRemittanceTableEmail({ payment, bills: bare, brokerName: 'BCAT', carrierName: 'Blue Line Trucking' }).body).toMatch(/14611\s+Blue Line Trucking/)
    expect(renderRemittanceTableEmail({ payment, bills: bare, brokerName: 'BCAT' }).body).toMatch(/14611\s+—/)
  })

  it('prints the base PRO only, with no leg suffix and no carrier invoice number', () => {
    const mail = renderRemittanceTableEmail({ payment, bills: [{ ...bills[0], billNumber: 'INV-9' }, bills[1]], brokerName: 'BCAT' })
    expect(mail.body).toMatch(/^14610\s/m)
    expect(mail.body).not.toMatch(/14610-\d/)
    expect(mail.html).not.toContain('INV-9')
    expect(mail.html).not.toContain('Carrier invoice')
  })

  it('escapes what is typed into a PRO', () => {
    const mail = renderRemittanceTableEmail({ payment, bills: [{ ...bills[0], shipmentNumber: '<b>x</b>' }, bills[1]], brokerName: 'BCAT' })
    expect(mail.html).not.toContain('<b>x</b>')
    expect(mail.html).toContain('&lt;b&gt;')
  })
})

describe('renderRemittanceTableEmail without a reference', () => {
  it('has no internal id in the subject, text or html, and keeps the reference when there is one', () => {
    const base = {
      id: 'app-3976ef59792c2d35c2f466a293a13f94',
      paidAt: '2026-11-24T12:00:00.000Z',
      amountCents: 115_000,
      applications: [{ billId: 'b1', amountCents: 115_000 }],
    }
    const bills = [{ id: 'b1', billNumber: 'X', billDate: '2026-10-16', shipmentNumber: '14614', loadNumber: '14614', netCents: 115_000 }]
    const none = renderRemittanceTableEmail({ payment: { ...base, reference: null }, bills, brokerName: 'BCAT Logistics' })
    expect(none.subject).toBe('Remittance · BCAT Logistics')
    expect(`${none.subject}${none.body}${none.html}`).not.toContain('app-3976')
    const withRef = renderRemittanceTableEmail({ payment: { ...base, reference: 'TRACE-9' }, bills, brokerName: 'BCAT Logistics' })
    expect(withRef.subject).toBe('Remittance TRACE-9 · BCAT Logistics')
  })
})
