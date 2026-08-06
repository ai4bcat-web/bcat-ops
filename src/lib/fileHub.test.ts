import { describe, it, expect } from 'vitest'
import {
  DRIVER_FILE_SLOTS, TRUCK_FILE_SLOTS, slotsFor, isUnslottedDoc,
  daysUntil, slotState, readyScore, driverExpiry, slotsForAsset, type SlotState,
} from './fileHub'
import { TRUCK_DOC_SPECS, evaluateTruckDoc } from './truckDocs'
import { ALL_REQUIREMENTS } from './complianceRequirements'

const TODAY = new Date(2026, 7, 5) // 2026-08-05

describe('file hub slots reuse existing document keys', () => {
  it('the Files truck slots and Asset Documents specs are the SAME list', () => {
    // Derived from one catalog — if these ever diverge, the two pages would show
    // different documents for the same truck.
    expect(TRUCK_FILE_SLOTS.map((s) => s.key)).toEqual(TRUCK_DOC_SPECS.map((s) => s.key))
  })

  it('covers both the original Asset Documents paperwork and the truck photos', () => {
    const keys = TRUCK_FILE_SLOTS.map((s) => s.key)
    for (const key of ['insurance_cert', 'ifta_decals', 'irp_cab_card', 'annual_dot_inspection']) {
      expect(keys).toContain(key)
    }
    for (const key of ['photo_front', 'photo_driver_side', 'photo_passenger_side', 'photo_rear', 'photo_plate']) {
      expect(keys).toContain(key)
    }
  })

  it('driver slots match the compliance requirement catalog keys', () => {
    const catalogKeys = new Set(ALL_REQUIREMENTS.map((r) => r.key))
    for (const s of DRIVER_FILE_SLOTS) expect(catalogKeys.has(s.key)).toBe(true)
  })

  it('slot keys are unique across both entity types', () => {
    const keys = [...DRIVER_FILE_SLOTS, ...TRUCK_FILE_SLOTS].map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('selects the right slot list per entity type', () => {
    expect(slotsFor('DRIVER')).toBe(DRIVER_FILE_SLOTS)
    expect(slotsFor('TRUCK')).toBe(TRUCK_FILE_SLOTS)
  })

  it('flags document types with no slot so they still surface as "other"', () => {
    expect(isUnslottedDoc('cdl_copy')).toBe(false)
    expect(isUnslottedDoc('photo_plate')).toBe(false)
    expect(isUnslottedDoc('lease_agreement')).toBe(true)
  })

  it('photos never expire; paperwork does', () => {
    for (const s of TRUCK_FILE_SLOTS) {
      if (s.kind === 'photo') expect(s.expires).toBe(false)
    }
    expect(TRUCK_FILE_SLOTS.find((s) => s.key === 'insurance_cert')?.expires).toBe(true)
  })

  it('every photo slot is marked photo in the shared catalog, so neither page asks for an expiry', () => {
    const photoKeys = ['photo_front', 'photo_driver_side', 'photo_passenger_side', 'photo_rear', 'photo_plate']
    for (const key of photoKeys) {
      expect(TRUCK_DOC_SPECS.find((s) => s.key === key)?.photo).toBe(true)
      expect(TRUCK_FILE_SLOTS.find((s) => s.key === key)?.kind).toBe('photo')
    }
  })

  it('a photo on file is VALID with no expiration date at all', () => {
    const truck = { id: 't1', fleetGroup: 'LOCAL' } as Parameters<typeof evaluateTruckDoc>[0]
    const spec = TRUCK_DOC_SPECS.find((s) => s.key === 'photo_front')!
    const withPhoto = evaluateTruckDoc(truck, spec, { s3Key: 'k', expirationDate: null } as never)
    expect(withPhoto.state).toBe('VALID')
    expect(withPhoto.expiration).toBeNull()
    expect(evaluateTruckDoc(truck, spec, undefined).state).toBe('MISSING')
  })
})

describe('truck vs trailer slots', () => {
  const truckKeys = slotsForAsset('truck').map((s) => s.key)
  const trailerKeys = slotsForAsset('trailer').map((s) => s.key)

  it('module initialises without a temporal-dead-zone crash', () => {
    // TRUCK_FILE_SLOTS is built at module load from a helper defined in the same file;
    // if that helper is declared after its use, importing this module throws.
    expect(TRUCK_FILE_SLOTS.length).toBeGreaterThan(0)
    expect(TRUCK_FILE_SLOTS.every((s) => !!s.key && !!s.label)).toBe(true)
  })

  it('gives trucks the inside-VIN photo and not the trailer plate photo', () => {
    expect(truckKeys).toContain('photo_vin_inside')
    expect(truckKeys).not.toContain('photo_trailer_plate')
  })

  it('gives trailers the trailer+plate photo and not the inside-VIN photo', () => {
    expect(trailerKeys).toContain('photo_trailer_plate')
    expect(trailerKeys).not.toContain('photo_vin_inside')
  })

  it('keeps every pre-existing document on BOTH asset types', () => {
    // Adding appliesTo must not quietly drop paperwork trailers used to show.
    for (const key of ['insurance_cert', 'ifta_decals', 'irp_cab_card', 'annual_dot_inspection',
                       'photo_front', 'photo_driver_side', 'photo_passenger_side', 'photo_rear', 'photo_plate']) {
      expect(truckKeys).toContain(key)
      expect(trailerKeys).toContain(key)
    }
  })

  it('both new photos are photo slots, so neither asks for an expiration', () => {
    for (const key of ['photo_vin_inside', 'photo_trailer_plate']) {
      const spec = TRUCK_DOC_SPECS.find((s) => s.key === key)
      expect(spec?.photo).toBe(true)
      expect(TRUCK_FILE_SLOTS.find((s) => s.key === key)?.expires).toBe(false)
    }
  })

  it('the full catalog still contains every asset-specific slot', () => {
    const all = TRUCK_FILE_SLOTS.map((s) => s.key)
    expect(all).toContain('photo_vin_inside')
    expect(all).toContain('photo_trailer_plate')
  })

  it('neither new key collides with an existing document type', () => {
    const keys = TRUCK_DOC_SPECS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('slot state', () => {
  it('counts days to an expiration date', () => {
    expect(daysUntil('2026-08-05', TODAY)).toBe(0)
    expect(daysUntil('2026-08-15', TODAY)).toBe(10)
    expect(daysUntil('2026-08-01', TODAY)).toBe(-4)
  })

  it('missing when there is no document', () => {
    expect(slotState(undefined, TODAY)).toBe('MISSING')
  })

  it('a document with no expiration (a photo) is valid', () => {
    expect(slotState({ expirationDate: null }, TODAY)).toBe('VALID')
  })

  it('expiring within 30 days, expired past the date', () => {
    expect(slotState({ expirationDate: '2026-12-01' }, TODAY)).toBe('VALID')
    expect(slotState({ expirationDate: '2026-08-20' }, TODAY)).toBe('EXPIRING_SOON')
    expect(slotState({ expirationDate: '2026-09-04' }, TODAY)).toBe('EXPIRING_SOON') // day 30
    expect(slotState({ expirationDate: '2026-09-05' }, TODAY)).toBe('VALID')         // day 31
    expect(slotState({ expirationDate: '2026-08-04' }, TODAY)).toBe('EXPIRED')
  })
})

describe('driver expiry columns (CDL / medical card)', () => {
  it('uses the driver record date — what the Drivers page edits and alerts read', () => {
    const info = driverExpiry('2027-03-14', { expirationDate: '2027-03-14' }, TODAY)
    expect(info.date).toBe('2027-03-14')
    expect(info.state).toBe('VALID')
    expect(info.conflict).toBe(false)
  })

  it('falls back to the uploaded document when the record has no date', () => {
    const info = driverExpiry(null, { expirationDate: '2026-08-20' }, TODAY)
    expect(info.date).toBe('2026-08-20')
    expect(info.state).toBe('EXPIRING_SOON')
    expect(info.conflict).toBe(false)
  })

  it('flags a conflict when record and document disagree, preferring the record', () => {
    const info = driverExpiry('2027-03-14', { expirationDate: '2026-01-01' }, TODAY)
    expect(info.date).toBe('2027-03-14')
    expect(info.conflict).toBe(true)
    expect(info.recordDate).toBe('2027-03-14')
    expect(info.documentDate).toBe('2026-01-01')
  })

  it('reports MISSING when neither side has a date', () => {
    const info = driverExpiry(null, undefined, TODAY)
    expect(info.date).toBeNull()
    expect(info.state).toBe('MISSING')
    expect(info.conflict).toBe(false)
  })

  it('colour-codes an expired licence', () => {
    expect(driverExpiry('2026-08-04', undefined, TODAY).state).toBe('EXPIRED')
  })

  it('tolerates full ISO datetimes on either side', () => {
    const info = driverExpiry('2027-03-14T00:00:00Z', { expirationDate: '2027-03-14' }, TODAY)
    expect(info.conflict).toBe(false)
    expect(info.date).toBe('2027-03-14')
  })
})

describe('ready score', () => {
  const N = TRUCK_FILE_SLOTS.length

  it('is all-missing for an entity with nothing on file', () => {
    const s = readyScore(TRUCK_FILE_SLOTS, () => 'MISSING')
    expect(s.required).toBe(N)
    expect(s.onFile).toBe(0)
    expect(s.missing).toBe(N)
    expect(s.attention).toBe(0)
  })

  it('counts documents on file and flags the ones needing attention', () => {
    const states: Record<string, SlotState> = {
      insurance_cert: 'EXPIRING_SOON',
      irp_cab_card:   'EXPIRED',
      photo_front:    'VALID',
    }
    const s = readyScore(TRUCK_FILE_SLOTS, (k) => states[k] ?? 'MISSING')
    expect(s.onFile).toBe(3)
    expect(s.missing).toBe(N - 3)
    expect(s.attention).toBe(2)
  })

  it('a fully documented truck has no gaps', () => {
    const s = readyScore(TRUCK_FILE_SLOTS, () => 'VALID')
    expect(s.onFile).toBe(s.required)
    expect(s.missing).toBe(0)
    expect(s.attention).toBe(0)
  })

  it('a waived document drops out of the count instead of reading as a gap', () => {
    const s = readyScore(TRUCK_FILE_SLOTS, (k) => (k === 'ifta_decals' ? 'WAIVED' : 'VALID'))
    expect(s.required).toBe(N - 1)
    expect(s.onFile).toBe(N - 1)
    expect(s.missing).toBe(0)
  })
})
