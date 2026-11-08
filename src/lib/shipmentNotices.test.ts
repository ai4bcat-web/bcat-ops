import { describe, it, expect } from 'vitest'
import {
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

describe('renderInvoiceEmail', () => {
  const email = (overrides: Partial<Parameters<typeof renderInvoiceEmail>[0]> = {}) =>
    renderInvoiceEmail({
      invoice: INVOICE,
      customerName: 'Acme Foods',
      contactName: 'Amy',
      brokerName: 'BCAT Logistics',
      ...overrides,
    })

  it('names the invoice and the broker in the subject', () => {
    expect(email().subject).toBe('Invoice INV-000123 · BCAT Logistics')
  })

  it('states the amount due and the due date whatever the template says', () => {
    const { body } = email({ template: 'Invoice {number} attached.' })
    expect(body).toContain('Amount due: $2750.00')
    expect(body).toContain('Due 2026-04-03.')
  })

  it('substitutes every token the caller may use', () => {
    const { body } = email({
      template: '{number}|{customer}|{contact}|{total}|{due}|{shipment}|{broker}',
    })
    expect(body).toContain(
      'INV-000123|Acme Foods|Amy|$2750.00|2026-04-03|S-10042|BCAT Logistics',
    )
  })

  it('leaves a token it does not know alone rather than blanking it', () => {
    expect(email({ template: 'Invoice {number} — {mystery}' }).body).toContain(
      'Invoice INV-000123 — {mystery}',
    )
  })

  it('falls back to the default wording when the template cannot name the invoice', () => {
    const { body } = email({ template: 'Your bill is attached.' })
    expect(body).not.toContain('Your bill is attached.')
    expect(body).toContain('Invoice INV-000123 for shipment S-10042 is attached.')
  })

  it('greets the customer by name only when there is one', () => {
    expect(email().body.startsWith('Amy,')).toBe(true)
    expect(email({ contactName: null }).body.startsWith('Hello,')).toBe(true)
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

  it('lists every invoice with its shipment, due date and amount', () => {
    const { body } = batch()
    expect(body).toContain('  • INV-000123 — shipment S-10042 — due 2026-04-03 — $2750.00')
    expect(body).toContain('  • INV-000124 — shipment S-10043 — due 2026-04-10 — $1000.00')
    expect(body).toContain('  • INV-000125 — due 2026-04-17 — $500.00')
    expect(body).toContain('Total due: $4250.00')
  })

  it('joins the numbers into a per-invoice template so a configured one still reads', () => {
    const { body } = batch(INVOICES, { template: 'Invoice {number} is attached.' })
    expect(body).toContain('Invoice INV-000123, INV-000124, INV-000125 is attached.')
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
    expect(body).toContain('  • BL-55012 — shipment BC-1001 — $2475.00')
    expect(body).toContain('  • BC-1002-1 — shipment BC-1002 — $1450.00')
  })

  it('falls back to the default wording when the template cannot name the payment', () => {
    const { body } = remittance({ template: 'Your money is on its way.' })
    expect(body).not.toContain('Your money is on its way.')
    expect(body).toContain('Payment ACH-88120 for $3925.00 has been sent.')
  })

  it('falls back to the payment id when no check or trace number was typed', () => {
    const { subject, body } = remittance({
      payment: { id: 'ap-1', reference: '  ', paidAt: '2026-02-10T12:00:00.000Z', method: 'CHECK', amountCents: 1_000, applications: [] },
    })
    expect(subject).toBe('Remittance ap-1 · BCAT Logistics')
    expect(body).toContain('Payment ap-1')
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
