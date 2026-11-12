import { describe, expect, it } from 'vitest'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'
import { assetBasicsErrors, assetDates, assetDocsSummary, assetFleetLabel, assignedTo, makeModel, nextPmMileage, slotAsksExpiry } from './assetProfileModel'

const truck = { id: 't1', type: 'truck', unitNumber: '214', make: 'Volvo', model: 'VNL', year: 2022, ownership: 'owned', insured: true, active: true, onTollwayAccount: false, dotInspectionDate: '2026-05-01', insuranceExpirationDate: '2027-01-01', createdAt: '', updatedAt: '' } as Equipment
const trailer = { ...truck, id: 'r1', type: 'trailer', unitNumber: 'T-9' } as Equipment
const noDocs = () => undefined

describe('asset profile model', () => {
  it('labels fleets and builds make / model / year', () => {
    expect(assetFleetLabel('BOX_TRUCK')).toBe('Box truck')
    expect(assetFleetLabel(null)).toBe('Unassigned')
    expect(makeModel(truck)).toBe('2022 Volvo VNL')
  })
  it('reads dates from the record; IFTA and IRP only exist for trucks', () => {
    expect(assetDates({ ...truck, iftaExpirationDate: '2026-12-31' }, noDocs)).toMatchObject({ dot: '2026-05-01', ins: '2027-01-01', ifta: '2026-12-31' })
    expect(assetDates({ ...trailer, iftaExpirationDate: '2026-12-31' }, noDocs).ifta).toBeUndefined()
  })
  it('summarises documents: a truck with nothing uploaded is missing its required set', () => {
    const s = assetDocsSummary(truck, noDocs, true)
    expect(s.tone).toBe('red')
    expect(s.label).toMatch(/^Missing \d+/)
  })
  it('knows who has a truck (its driver) and a trailer (drivers pulling it)', () => {
    const drivers = [{ id: 'd1', name: 'Zak', assignedTruckId: 't1', assignedTrailerId: 'r1' }, { id: 'd2', name: 'Amy' }] as Driver[]
    expect(assignedTo(truck, drivers).map((d) => d.id)).toEqual(['d1'])
    expect(assignedTo(trailer, drivers).map((d) => d.id)).toEqual(['d1'])
  })
  it('PM is due 25,000 miles after the last one', () => {
    expect(nextPmMileage({ lastPmMileage: 100000 })).toBe(125000)
    expect(nextPmMileage({})).toBeNull()
  })
  it('DOT is not asked for at upload; other dated slots are', () => {
    expect(slotAsksExpiry({ key: 'annual_dot_inspection', label: 'DOT', sub: '', kind: 'document', required: true, expires: true })).toBe(false)
    expect(slotAsksExpiry({ key: 'insurance_cert', label: 'Insurance', sub: '', kind: 'document', required: true, expires: true })).toBe(true)
  })
  it('wizard basics: unit required and unique (case-insensitive), 4-digit year, 17-character VIN, dates', () => {
    const base = { unitNumber: '777', make: '', model: '', year: '', vin: '', plate: '' }
    expect(assetBasicsErrors(base, ['214'])).toEqual({})
    expect(assetBasicsErrors({ ...base, unitNumber: ' ' }, []).unitNumber).toBeTruthy()
    expect(assetBasicsErrors({ ...base, unitNumber: 't-9' }, ['T-9']).unitNumber).toMatch(/already/)
    expect(assetBasicsErrors({ ...base, year: '22' }, []).year).toBeTruthy()
    expect(assetBasicsErrors({ ...base, vin: '123' }, []).vin).toBeTruthy()
    expect(assetBasicsErrors({ ...base, dotInspectionDate: 'x' }, []).dotInspectionDate).toBeTruthy()
  })
})
