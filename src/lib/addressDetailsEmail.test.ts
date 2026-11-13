import { describe, expect, it } from 'vitest'
import { addressDetailsAppt, buildAddressDetailsEmail, type AddressDetailsInput } from './addressDetailsEmail'

const input: AddressDetailsInput = {
  pro: '20058',
  carrierName: 'ARCTIC HORIZON INC',
  carrierRef: 'TRIP-77',
  equipment: 'Flatbed',
  commodity: 'Engines',
  weightLbs: 37000,
  pieces: 4,
  piecesUnit: 'skids',
  stops: [
    {
      type: 'pickup', name: 'WHIMSY INTERMODAL',
      address: { street: '5100 70th Pl A', city: 'Chicago', state: 'IL', zip: '60638' },
      appt: '2026-11-16T15:00:00.000Z', apptType: 'exact',
      refs: [
        { code: 'PU', label: 'PU #', value: '1090324', visibility: 'ALL' },
        { code: 'COST', label: 'Internal', value: 'do-not-send', visibility: 'INTERNAL' },
      ],
      contact: { name: 'Dock', phone: '(708) 555-0100', hours: '07:00-16:00' },
      instructions: 'Check in at gate 2',
    },
    {
      type: 'delivery', name: 'GENERAC',
      address: { street: '3300 Medalist Dr', city: 'Oshkosh', state: 'WI', zip: '54902' },
      appt: '2026-11-16T16:00:00.000Z', apptType: 'fcfs', apptEnd: '2026-11-16T20:00:00.000Z',
      refs: [{ code: 'PO', label: 'PO #', value: '1496763', visibility: 'CARRIER' }],
    },
  ],
}

describe('buildAddressDetailsEmail', () => {
  const email = buildAddressDetailsEmail(input, 'Ryne, BCAT Tracking')

  it('names the PRO in the subject', () => {
    expect(email.subject).toBe('PRO 20058 — Pickup & delivery details')
  })

  it('lists every stop in order with its address, appointment and carrier-visible refs', () => {
    const t = email.text
    expect(t.indexOf('PICKUP: WHIMSY INTERMODAL')).toBeLessThan(t.indexOf('DELIVERY: GENERAC'))
    expect(t).toContain('5100 70th Pl A')
    expect(t).toContain('Chicago, IL 60638')
    expect(t).toContain('Appointment: 11/16/2026 09:00')
    expect(t).toContain('3300 Medalist Dr')
    expect(t).toContain('Oshkosh, WI 54902')
    expect(t).toContain('Appointment: FCFS 11/16/2026 10:00–14:00')
    expect(t).toContain('PU # 1090324')
    expect(t).toContain('PO # 1496763')
    expect(t).toContain('Hours: 07:00-16:00')
    expect(t).toContain('Contact: Dock · (708) 555-0100')
    expect(t).toContain('Notes: Check in at gate 2')
    expect(t).toContain('Carrier ref #: TRIP-77')
    expect(t).toContain('Equipment: Flatbed')
    expect(t).toContain('Pieces: 4 skids')
    expect(email.html).toContain('GENERAC')
  })

  it('never carries money or internal references', () => {
    for (const body of [email.text, email.html]) {
      expect(body).not.toMatch(/\$|rate|charge|linehaul|line haul|total/i)
      expect(body).not.toContain('do-not-send')
    }
  })

  it('escapes HTML in stop text', () => {
    const e = buildAddressDetailsEmail({ pro: '1', stops: [{ type: 'pickup', name: '<b>X</b>', appt: null }] })
    expect(e.html).not.toContain('<b>X</b>')
    expect(e.html).toContain('&lt;b&gt;X&lt;/b&gt;')
  })
})

describe('addressDetailsAppt', () => {
  it('formats exact, FCFS, TBD and missing appointments in Chicago 24-hour time', () => {
    expect(addressDetailsAppt('2026-11-16T15:00:00.000Z', 'exact')).toBe('11/16/2026 09:00')
    expect(addressDetailsAppt('2026-11-16T14:00:00.000Z', 'fcfs', '2026-11-16T20:00:00.000Z')).toBe('FCFS 11/16/2026 08:00–14:00')
    expect(addressDetailsAppt('2026-11-16T06:00:00.000Z', 'tbd')).toBe('11/16/2026 (time TBD)')
    expect(addressDetailsAppt(null)).toBe('Not set')
  })
})
