import { describe, it, expect } from 'vitest'
import {
  milestoneRecipients,
  renderInvoiceBatchEmail,
  renderInvoiceEmail,
  renderMilestoneEmail,
  uploadLinkExpiry,
} from './shipmentNotices'
import type { InvoiceEmailInvoice, NoticeStop } from './shipmentNotices'
import type { CustomerContact, CustomerNotification, VisibilityPrefs } from '../types/tms'

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
