import { describe, it, expect } from 'vitest'
import { driverSmsTarget, normalizeTruckPhone, trucksWithoutPhone, workPhoneFor, type TruckPhoneRecord } from './workPhone'

const TRUCKS: Record<string, TruckPhoneRecord> = {
  t12: { truckId: 't12', unitNumber: '12', phone: '+13125550100', phoneLabel: 'Cab phone' },
  t14: { truckId: 't14', unitNumber: '14', phone: null },
}
const truck = (id: string) => TRUCKS[id]
const driver = { phone: '(312) 555-0199', assignedTruckId: 't12' }

describe('workPhoneFor', () => {
  it("uses the load's truck over the driver's assigned truck", () => {
    const p = workPhoneFor({ driver, loadTruckId: 't14', truck })
    expect(p.truckId).toBe('t14')
    expect(p.work).toBeNull()
  })

  it("never borrows the assigned truck's phone when the load's truck has none", () => {
    const p = workPhoneFor({ driver, loadTruckId: 't14', truck })
    expect(p.work).toBeNull()
    expect(p.truckNumber).toBe('14')
  })

  it('falls back to the driver assigned truck when the load names none', () => {
    const p = workPhoneFor({ driver, truck })
    expect(p.work).toEqual({ number: '+13125550100', label: 'Cab phone' })
    expect(p.truckNumber).toBe('12')
    expect(p.personal).toBe('+13125550199')
  })

  it('has personal only when there is no truck; the leg snapshot is the personal number of a driver with no row', () => {
    const p = workPhoneFor({ driver: { phone: '3125550199' }, truck })
    expect(p).toMatchObject({ truckId: null, work: null, personal: '+13125550199' })
    const brokered = workPhoneFor({ legDriverPhone: '312-555-0142', truck })
    expect(brokered.personal).toBe('+13125550142')
  })

  it('treats a stored non-US number as absent for sending but keeps it for display', () => {
    const p = workPhoneFor({ driver: { phone: '+44 20 7946 0958', assignedTruckId: null }, truck })
    expect(p.personal).toBeNull()
    expect(p.personalRaw).toBe('+44 20 7946 0958')
    const bad = workPhoneFor({ driver: { assignedTruckId: 't12' }, truck: () => ({ truckId: 't12', phone: '555' }) })
    expect(bad.work).toBeNull()
  })
})

describe('driverSmsTarget', () => {
  const withWork = workPhoneFor({ driver, truck })
  const noWork = workPhoneFor({ driver, loadTruckId: 't14', truck })
  const none = workPhoneFor({ loadTruckId: 't14', truck })

  it('WORK_THEN_PERSONAL (and the null default) texts the truck, falling back only when it has none and says so', () => {
    expect(driverSmsTarget(withWork, null)).toMatchObject({ to: '+13125550100', source: 'WORK', reason: null })
    expect(driverSmsTarget(noWork, 'WORK_THEN_PERSONAL')).toMatchObject({
      to: '+13125550199', source: 'PERSONAL', reason: "Truck 14 has no work phone — used the driver's personal number",
    })
    expect(driverSmsTarget(none, null)).toMatchObject({ to: null, source: 'NONE', reason: 'No phone for this driver' })
  })

  it('WORK_ONLY never falls back and names the truck', () => {
    expect(driverSmsTarget(noWork, 'WORK_ONLY')).toMatchObject({ to: null, source: 'NONE', reason: 'Truck 14 has no work phone' })
    expect(driverSmsTarget(withWork, 'WORK_ONLY').to).toBe('+13125550100')
  })

  it('PERSONAL ignores the work phone', () => {
    expect(driverSmsTarget(withWork, 'PERSONAL')).toMatchObject({ to: '+13125550199', source: 'PERSONAL' })
  })

  it('a leg with no truck at all texts the personal number with no complaint (brokered legs are unchanged)', () => {
    const brokered = workPhoneFor({ legDriverPhone: '3125550142', truck })
    expect(driverSmsTarget(brokered, null)).toMatchObject({ to: '+13125550142', source: 'PERSONAL', reason: null })
  })
})

describe('trucksWithoutPhone', () => {
  it('lists trucks missing a valid phone, counts a truck with no config row, and skips trailers and parked trucks', () => {
    const equipment = [
      { id: 't12', unitNumber: '12', type: 'truck', active: true },
      { id: 't14', unitNumber: '14', type: 'truck', active: true, assignedDriverId: 'd1' },
      { id: 't15', unitNumber: '15', type: 'truck', active: true },
      { id: 't16', unitNumber: '16', type: 'truck', active: false },
      { id: 'tr1', unitNumber: 'T1', type: 'trailer', active: true },
    ]
    const configs = new Map(Object.entries(TRUCKS))
    expect(trucksWithoutPhone({ equipment, configs })).toEqual([
      { truckId: 't14', unitNumber: '14', assignedDriverId: 'd1' },
      { truckId: 't15', unitNumber: '15', assignedDriverId: null },
    ])
  })
})

describe('normalizeTruckPhone', () => {
  it.each(['(312) 555-0142', '312-555-0142', '+13125550142', '1 312 555 0142'])('accepts %s', (raw) => {
    expect(normalizeTruckPhone(raw)).toEqual({ ok: true, value: '+13125550142' })
  })
  it.each(['312555014', '312-555-01ab', '+44 20 7946 0958', ''])('rejects %j with a message', (raw) => {
    const r = normalizeTruckPhone(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })
})
