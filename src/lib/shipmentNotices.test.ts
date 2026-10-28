import { describe, it, expect } from 'vitest'
import {
  milestoneRecipients,
  renderMilestoneEmail,
  uploadLinkExpiry,
} from './shipmentNotices'
import type { NoticeStop } from './shipmentNotices'
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
