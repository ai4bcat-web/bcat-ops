import { describe, it, expect } from 'vitest'
import { entityFields, driverForTruck } from './entityPacket'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'

const driver = (over: Partial<Driver> = {}): Driver => ({
  id: 'd1', name: 'Zak Mendoza', phone: '+17085550142', active: true,
  cdl: 'CDL-A IL-8823901', cdlExpiration: '2027-03-14',
  createdAt: '', updatedAt: '', ...over,
})

const truck = (over: Partial<Equipment> = {}): Equipment => ({
  id: 't1', type: 'truck', unitNumber: '214', vin: '1FUJGLD55LLAA3391', plate: 'P123456',
  make: 'Freightliner', model: 'Cascadia', year: 2020,
  ownership: 'owned', insured: true, active: true, onTollwayAccount: false,
  createdAt: '', updatedAt: '', ...over,
})

const label = (fields: { label: string; value: string }[], l: string) =>
  fields.find((f) => f.label === l)?.value

describe('driverForTruck', () => {
  it('finds the driver via Equipment.assignedDriverId', () => {
    expect(driverForTruck(truck({ assignedDriverId: 'd1' }), [driver()])?.id).toBe('d1')
  })

  it('also finds it from the driver side via assignedTruckId', () => {
    // The two sides can disagree; a truck packet must still carry the driver.
    expect(driverForTruck(truck(), [driver({ assignedTruckId: 't1' })])?.id).toBe('d1')
  })

  it('prefers the driver side when the two disagree — that is the field the UI writes', () => {
    // Legacy/seeded Equipment.assignedDriverId can point at someone who has since been
    // reassigned; Driver.assignedTruckId is what the assignment controls actually set.
    const current = driver({ id: 'd2', name: 'Chad Rivera', assignedTruckId: 't1' })
    const stale = driver({ id: 'd1', name: 'Zak Mendoza' })
    expect(driverForTruck(truck({ assignedDriverId: 'd1' }), [stale, current])?.id).toBe('d2')
  })

  it('is undefined when no driver is assigned either way', () => {
    expect(driverForTruck(truck(), [driver()])).toBeUndefined()
  })
})

describe('truck packet fields', () => {
  it('includes the assigned driver phone and CDL', () => {
    const fields = entityFields({ kind: 'TRUCK', truck: truck({ assignedDriverId: 'd1' }) }, [driver()], [])
    expect(label(fields, 'Driver')).toBe('Zak Mendoza')
    expect(label(fields, 'Driver phone')).toBe('(708) 555-0142')
    expect(label(fields, 'Driver CDL')).toBe('CDL-A IL-8823901')
  })

  it('keeps the truck identifiers', () => {
    const fields = entityFields({ kind: 'TRUCK', truck: truck() }, [], [])
    expect(label(fields, 'VIN')).toBe('1FUJGLD55LLAA3391')
    expect(label(fields, 'Plate')).toBe('P123456')
    expect(label(fields, 'Make / model')).toBe('Freightliner Cascadia')
  })

  it('omits the driver rows entirely when the truck has no driver', () => {
    const fields = entityFields({ kind: 'TRUCK', truck: truck() }, [driver()], [])
    expect(fields.some((f) => f.label === 'Driver phone')).toBe(false)
    expect(fields.some((f) => f.label === 'Driver CDL')).toBe(false)
  })

  it('leaves the value blank rather than breaking when the driver has no CDL on record', () => {
    const fields = entityFields(
      { kind: 'TRUCK', truck: truck({ assignedDriverId: 'd1' }) },
      [driver({ cdl: undefined, phone: '' })],
      [],
    )
    expect(label(fields, 'Driver CDL')).toBe('')
    expect(label(fields, 'Driver phone')).toBe('')
  })
})

describe('driver packet fields', () => {
  it('shows the assigned truck and trailer', () => {
    const trailer = truck({ id: 'tr1', type: 'trailer', unitNumber: 'T-88' })
    const fields = entityFields(
      { kind: 'DRIVER', driver: driver({ assignedTruckId: 't1', assignedTrailerId: 'tr1' }) },
      [], [truck(), trailer],
    )
    expect(label(fields, 'Phone')).toBe('(708) 555-0142')
    expect(label(fields, 'CDL')).toBe('CDL-A IL-8823901')
    expect(label(fields, 'Truck')).toBe('214')
    expect(label(fields, 'Trailer')).toBe('T-88')
  })

  it('falls back to TBD when no trailer is assigned', () => {
    const fields = entityFields({ kind: 'DRIVER', driver: driver() }, [], [])
    expect(label(fields, 'Trailer')).toBe('TBD')
  })
})

describe('packet picker filtering', () => {
  const items = [{ label: 'CDL', s3Key: 'a' }, { label: 'Medical card', s3Key: 'b' }]
  const fields = [{ label: 'Phone', value: '(708) 555-0142' }, { label: 'CDL', value: 'X' }]

  // Mirrors the filter applied in downloadEntityPacket.
  const apply = (include?: { fieldLabels?: string[]; itemLabels?: string[] }) => ({
    items: items.filter((i) => !include?.itemLabels || include.itemLabels.includes(i.label)),
    fields: fields.filter((f) => !include?.fieldLabels || include.fieldLabels.includes(f.label)),
  })

  it('an unfiltered build is unchanged — the one-click path keeps everything', () => {
    const out = apply(undefined)
    expect(out.items).toHaveLength(2)
    expect(out.fields).toHaveLength(2)
  })

  it('can leave a document out', () => {
    expect(apply({ itemLabels: ['CDL'] }).items.map((i) => i.label)).toEqual(['CDL'])
  })

  it('can leave a cover detail out — e.g. omitting a phone number from an insurer packet', () => {
    expect(apply({ fieldLabels: ['CDL'] }).fields.map((f) => f.label)).toEqual(['CDL'])
  })

  it('an empty selection produces a cover-only packet rather than everything', () => {
    // The dangerous inverse would be treating "none chosen" as "include all".
    const out = apply({ itemLabels: [], fieldLabels: [] })
    expect(out.items).toHaveLength(0)
    expect(out.fields).toHaveLength(0)
  })
})
