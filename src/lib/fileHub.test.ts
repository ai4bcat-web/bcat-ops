import { describe, it, expect, afterEach } from 'vitest'
import {
  DRIVER_FILE_SLOTS, TRUCK_FILE_SLOTS, slotsFor, isUnslottedDoc,
  daysUntil, slotState, readyScore, driverExpiry, driverExpiryPatch, slotsForAsset, slotsForDriver,
  isPrivateDoc, visibleSlots, visibleDocs, setPrivateDocTypes, getPrivateDocTypes,
  DEFAULT_PRIVATE_DOC_TYPES, type SlotState,
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
    // lease_agreement is now an Amazon driver slot, so use one that genuinely has none.
    expect(isUnslottedDoc('i9_w4')).toBe(true)
    expect(isUnslottedDoc('mvr_initial')).toBe(true)
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

describe('driverExpiryPatch — keeping the two copies of the date in step', () => {
  it('maps a CDL upload to the driver record field', () => {
    expect(driverExpiryPatch('cdl_copy', '2027-03-14')).toEqual({ cdlExpiration: '2027-03-14' })
  })

  it('maps a medical card upload to its own field', () => {
    expect(driverExpiryPatch('medical_card', '2026-11-01')).toEqual({ medCardExpiration: '2026-11-01' })
  })

  it('trims a full ISO datetime to the calendar day', () => {
    expect(driverExpiryPatch('cdl_copy', '2027-03-14T00:00:00Z')).toEqual({ cdlExpiration: '2027-03-14' })
  })

  it('never blanks out a good record date when no expiration was given', () => {
    expect(driverExpiryPatch('cdl_copy', null)).toBeNull()
    expect(driverExpiryPatch('cdl_copy', '')).toBeNull()
    expect(driverExpiryPatch('cdl_copy', undefined)).toBeNull()
  })

  it('ignores document types the driver record has no date for', () => {
    expect(driverExpiryPatch('mvr_initial', '2027-01-01')).toBeNull()
    expect(driverExpiryPatch('insurance_cert', '2027-01-01')).toBeNull()
  })

  it('after syncing, the record and document no longer report a conflict', () => {
    const uploaded = '2027-03-14'
    const patch = driverExpiryPatch('cdl_copy', uploaded)!
    const info = driverExpiry(patch.cdlExpiration, { expirationDate: uploaded }, TODAY)
    expect(info.conflict).toBe(false)
    expect(info.date).toBe(uploaded)
  })
})

describe('driver documents by fleet', () => {
  const keys = (g: Parameters<typeof slotsForDriver>[0]) => slotsForDriver(g).map((s) => s.key)

  it('every driver carries CDL and medical card whatever the fleet', () => {
    for (const g of [undefined, null, 'LOCAL', 'AMAZON', 'BOX_TRUCK'] as const) {
      expect(keys(g)).toContain('cdl_copy')
      expect(keys(g)).toContain('medical_card')
    }
  })

  it('Ivan (Local) drivers carry a job application and employment agreement', () => {
    expect(keys('LOCAL')).toContain('employment_application')
    expect(keys('LOCAL')).toContain('employment_agreement')
    expect(keys('LOCAL')).not.toContain('lease_agreement')
  })

  it('Box Truck drivers carry the same paperwork as Ivan', () => {
    expect(keys('BOX_TRUCK')).toEqual(keys('LOCAL'))
  })

  it('Amazon drivers carry a lease agreement instead', () => {
    expect(keys('AMAZON')).toContain('lease_agreement')
    expect(keys('AMAZON')).not.toContain('employment_agreement')
    expect(keys('AMAZON')).not.toContain('employment_application')
  })

  it('an unclassified driver is only asked for the base documents', () => {
    expect(keys(null)).toEqual(['cdl_copy', 'medical_card'])
  })

  it('every fleet-specific key is still recognised as slotted', () => {
    for (const key of ['employment_application', 'employment_agreement', 'lease_agreement']) {
      expect(isUnslottedDoc(key)).toBe(false)
    }
  })
})

describe('I-PASS photo is Local and Box Truck only', () => {
  const truckKeys = (g: 'LOCAL' | 'AMAZON' | 'BOX_TRUCK' | null) => slotsForAsset('truck', g).map((s) => s.key)

  it('appears for Local and Box Truck trucks', () => {
    expect(truckKeys('LOCAL')).toContain('photo_ipass')
    expect(truckKeys('BOX_TRUCK')).toContain('photo_ipass')
  })

  it('does not appear for Amazon trucks', () => {
    expect(truckKeys('AMAZON')).not.toContain('photo_ipass')
  })

  it('still appears on a truck with no fleet set, so it is never silently hidden', () => {
    expect(truckKeys(null)).toContain('photo_ipass')
  })

  it('never appears on a trailer', () => {
    expect(slotsForAsset('trailer', 'LOCAL').map((s) => s.key)).not.toContain('photo_ipass')
  })

  it('is a photo, so it asks for no expiration', () => {
    expect(slotsForAsset('truck', 'LOCAL').find((s) => s.key === 'photo_ipass')?.expires).toBe(false)
  })
})

describe('private documents are admin-only', () => {
  it('marks the pay-term documents private and nothing else', () => {
    expect(isPrivateDoc('employment_agreement')).toBe(true)
    expect(isPrivateDoc('lease_agreement')).toBe(true)
    for (const key of ['cdl_copy', 'medical_card', 'employment_application', 'insurance_cert', 'photo_ipass']) {
      expect(isPrivateDoc(key)).toBe(false)
    }
  })

  it('hides the employment agreement from a non-admin Ivan driver file', () => {
    const keys = visibleSlots(slotsForDriver('LOCAL'), false).map((s) => s.key)
    expect(keys).not.toContain('employment_agreement')
    // The job application is NOT private and must still be visible.
    expect(keys).toContain('employment_application')
    expect(keys).toContain('cdl_copy')
  })

  it('hides the lease agreement from a non-admin Amazon driver file', () => {
    expect(visibleSlots(slotsForDriver('AMAZON'), false).map((s) => s.key)).not.toContain('lease_agreement')
  })

  it('shows both to an admin', () => {
    expect(visibleSlots(slotsForDriver('LOCAL'), true).map((s) => s.key)).toContain('employment_agreement')
    expect(visibleSlots(slotsForDriver('AMAZON'), true).map((s) => s.key)).toContain('lease_agreement')
  })

  it('a hidden document does not count as MISSING, so it leaves no trace in the dots', () => {
    // If it counted, a non-admin would see "3 of 4" and know something is there.
    const nonAdmin = readyScore(visibleSlots(slotsForDriver('AMAZON'), false), () => 'VALID')
    const admin = readyScore(visibleSlots(slotsForDriver('AMAZON'), true), () => 'VALID')
    expect(nonAdmin.required).toBe(admin.required - 1)
    expect(nonAdmin.missing).toBe(0)
  })

  it('filters private documents out of a document list', () => {
    const docs = [
      { documentType: 'cdl_copy' },
      { documentType: 'lease_agreement' },
      { documentType: 'employment_agreement' },
    ]
    expect(visibleDocs(docs, false).map((d) => d.documentType)).toEqual(['cdl_copy'])
    expect(visibleDocs(docs, true)).toHaveLength(3)
  })
})

describe('configurable private document types', () => {
  afterEach(() => setPrivateDocTypes(null))   // back to defaults between cases

  it('defaults to the pay-term documents when settings have not loaded', () => {
    setPrivateDocTypes(null)
    expect(isPrivateDoc('employment_agreement')).toBe(true)
    expect(isPrivateDoc('lease_agreement')).toBe(true)
  })

  it('a failed or missing settings load errs toward HIDING, not exposing', () => {
    setPrivateDocTypes(undefined)
    expect([...getPrivateDocTypes()].sort()).toEqual([...DEFAULT_PRIVATE_DOC_TYPES].sort())
  })

  it('honours a configured list, including types that were not private before', () => {
    setPrivateDocTypes(['medical_card'])
    expect(isPrivateDoc('medical_card')).toBe(true)
    expect(isPrivateDoc('employment_agreement')).toBe(false)   // no longer listed
  })

  it('an explicitly empty list makes nothing private', () => {
    setPrivateDocTypes([])
    expect(isPrivateDoc('employment_agreement')).toBe(false)
    expect(getPrivateDocTypes().size).toBe(0)
  })

  it('the configured list drives what a non-admin actually sees', () => {
    setPrivateDocTypes(['cdl_copy'])
    const keys = visibleSlots(slotsForDriver('LOCAL'), false).map((s) => s.key)
    expect(keys).not.toContain('cdl_copy')
    expect(keys).toContain('employment_agreement')   // not configured private any more
  })
})

describe('documents awaiting review', () => {
  it('reports PENDING_REVIEW rather than passing as valid', () => {
    // An uploaded-but-unapproved document is not a gap, but it is not verified either —
    // showing it as "On file" would imply someone had checked it.
    expect(slotState({ status: 'PENDING_REVIEW', s3Key: 'k', expirationDate: null }, TODAY)).toBe('PENDING_REVIEW')
  })

  it('still counts toward the ready score as on-file needing attention', () => {
    const score = readyScore(slotsForDriver('LOCAL'), (k) => (k === 'cdl_copy' ? 'PENDING_REVIEW' : 'VALID'))
    expect(score.missing).toBe(0)
    expect(score.attention).toBe(1)
  })

  it('a waived document still wins over pending review', () => {
    expect(slotState({ status: 'WAIVED', s3Key: 'k' }, TODAY)).toBe('WAIVED')
  })
})
