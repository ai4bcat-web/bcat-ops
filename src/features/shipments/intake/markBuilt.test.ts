import { describe, expect, it } from 'vitest'
import { isAlreadyLinkedError, markBuiltWarnings, pickShipmentForPro, recentlyBuilt } from './markBuilt'
import { emptyIntakeFields } from '@/lib/intakeLoad'
import type { IntakeLoadRecord } from '@/types/intake'
import type { ShipmentRecord } from '@/types/tms'

const ship = (over: Partial<ShipmentRecord>): ShipmentRecord => ({ id: 's1', number: '20061', status: 'BOOKED', customerId: 'cus-1', customerName: 'ACME', originCity: 'CHICAGO, IL', destinationCity: 'DALLAS, TX', ...over } as ShipmentRecord)

function row(): IntakeLoadRecord {
  const fields = emptyIntakeFields()
  fields.customerId = 'cus-1'
  fields.customerName = 'Acme'
  fields.stops = [
    { type: 'pickup', name: null, street: null, city: 'Chicago', state: 'IL', zip: null, date: null, time: null, instructions: null },
    { type: 'delivery', name: null, street: null, city: 'Dallas', state: 'TX', zip: null, date: null, time: null, instructions: null },
  ]
  return { id: 'il:1', fields } as IntakeLoadRecord
}

describe('pickShipmentForPro', () => {
  it('finds the live shipment, refuses a voided-only PRO and says when there is none', () => {
    expect(pickShipmentForPro('', [])).toEqual({ kind: 'empty' })
    expect(pickShipmentForPro('20061', [])).toEqual({ kind: 'notFound' })
    expect(pickShipmentForPro('20061', [ship({ voidedAt: '2026-11-01T00:00:00Z' })])).toEqual({ kind: 'voided' })
    const live = ship({ id: 's2', voidedAt: null })
    expect(pickShipmentForPro(' 20061 ', [ship({ voidedAt: '2026-11-01T00:00:00Z' }), live])).toEqual({ kind: 'found', shipment: live })
  })
})

describe('markBuiltWarnings', () => {
  it('is quiet for a matching customer and lane, and warns on either mismatch', () => {
    expect(markBuiltWarnings(row(), ship({}))).toEqual([])
    expect(markBuiltWarnings(row(), ship({ customerId: 'cus-9', customerName: 'OTHER CO' }))[0]).toMatch(/customer/)
    expect(markBuiltWarnings(row(), ship({ destinationCity: 'MEMPHIS, TN' }))[0]).toMatch(/lane/)
  })
})

describe('isAlreadyLinkedError / recentlyBuilt', () => {
  it('spots the server refusal and keeps only linked rows from the last 14 days, newest first', () => {
    expect(isAlreadyLinkedError('ALREADY_LINKED: x')).toBe(true)
    expect(isAlreadyLinkedError('nope')).toBe(false)
    const now = Date.parse('2026-11-16T12:00:00Z')
    const rows = [
      { id: 'a', shipmentId: 's', updatedAt: '2026-11-15T00:00:00Z' },
      { id: 'b', shipmentId: 's', updatedAt: '2026-10-01T00:00:00Z' },
      { id: 'c', shipmentId: null, updatedAt: '2026-11-16T00:00:00Z' },
      { id: 'd', shipmentId: 's', updatedAt: '2026-11-16T01:00:00Z' },
    ] as IntakeLoadRecord[]
    expect(recentlyBuilt(rows, now).map((r) => r.id)).toEqual(['d', 'a'])
  })
})
