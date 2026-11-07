import { describe, expect, it } from 'vitest'
import { compareActiveShipment, parseActiveShipmentsCsv, type BcatShipmentSnapshot } from './activeShipments'
import { activeCsv } from './apFilesFixture'

const same: BcatShipmentSnapshot = {
  customerName: 'ZZ Customer, Inc.',
  carrierName: 'ZZ VENDOR 0',
  customerRateCents: 175_000,
  carrierRateCents: 130_000,
  firstStop: { name: 'zz shipper', city: 'ZZTOWN, WI', zip: '53089' },
  lastStop: { name: 'ZZ CONSIGNEE', city: 'zzville, ny', zip: '' },
}

describe('ACTIVE_SHIPMENTS layout', () => {
  const p = parseActiveShipmentsCsv(activeCsv([{ pro: '900201', customer: 'ZZ CUSTOMER' }, { pro: '900202', carrier: '', carrierRate: '0.0', status: 'OPEN' }]))

  it('reads rates as exact cents and keeps a blank carrier blank', () => {
    expect(p.shipments).toHaveLength(2)
    expect(p.shipments[0]).toMatchObject({ customerRateCents: 175_000, carrierRateCents: 130_000, firstStopZip: '53089' })
    expect(p.shipments[1]).toMatchObject({ carrierName: '', carrierRateCents: 0, status: 'OPEN' })
  })

  it('agrees when customer, carrier, rates and stops match (case/punctuation and an unrecorded zip are not differences)', () => {
    expect(compareActiveShipment(p.shipments[0], same)).toEqual([])
  })

  it('names each field that differs', () => {
    const diffs = compareActiveShipment(p.shipments[0], { ...same, carrierName: 'ZZ OTHER', customerRateCents: 170_000, lastStop: { name: 'ZZ CONSIGNEE', city: 'ELSEWHERE, NY', zip: '' } })
    expect(diffs.map((d) => d.field)).toEqual(['carrier', 'customerRate', 'lastStop'])
  })

  it('treats a missing stop on the BCAT side as a difference and a different zip as a difference', () => {
    expect(compareActiveShipment(p.shipments[0], { ...same, firstStop: null }).map((d) => d.field)).toEqual(['firstStop'])
    expect(compareActiveShipment(p.shipments[0], { ...same, firstStop: { ...same.firstStop!, zip: '60601' } }).map((d) => d.field)).toEqual(['firstStop'])
  })
})
