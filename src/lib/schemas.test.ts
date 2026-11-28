/**
 * When the MC and ZIP rules apply.
 *
 * They exist so an invoice can be assembled later, which is not a reason to block dispatch
 * work on a load booked before they existed.
 */
import { describe, it, expect } from 'vitest'
import { driverSchema, driverWarnings, loadSchemaFor } from './schemas'


describe('the MC and ZIP rules on an existing load', () => {
  const factored = () => true
  const base = {
    aljexId: '14517', tmsId: 'T1', pickupNumber: 'PU1', readyToInvoice: false,
    customer: 'ACME', customerId: 'c1', miles: null, rate: null, notes: '',
    hot: false, unscheduled: false,
  }
  const stop = (type: 'pickup' | 'delivery', zip?: string) => ({
    id: `${type}-1`, type, appt: '2026-10-06T12:00', apptType: 'exact' as const,
    driverId: null, sequence: type === 'pickup' ? 0 : 1,
    ...(zip ? { address: { zip } } : {}),
  })

  it('requires the ZIPs on a NEW load', () => {
    const r = loadSchemaFor(factored, { isNew: true })
      .safeParse({ ...base, stops: [stop('pickup'), stop('delivery')] })
    expect(r.success).toBe(false)
  })

  it('lets an OLD load without ZIPs be saved, so appointments can move', () => {
    /*
     * The rule arrived after hundreds of loads were booked. Holding them to it meant nobody
     * could move an appointment on any of them, which blocks dispatch to make an invoice
     * assemblable later — the wrong trade.
     */
    const r = loadSchemaFor(factored, {
      isNew: false,
      had: { customerId: true, originZip: false, destinationZip: false },
    }).safeParse({ ...base, stops: [stop('pickup'), stop('delivery')] })
    expect(r.success).toBe(true)
  })

  it('still refuses to let an edit STRIP a ZIP the load already had', () => {
    // Unblocking old loads must not become a way to remove good data from new ones.
    const r = loadSchemaFor(factored, {
      isNew: false,
      had: { customerId: true, originZip: true, destinationZip: true },
    }).safeParse({ ...base, stops: [stop('pickup'), stop('delivery')] })
    expect(r.success).toBe(false)
  })

  it('accepts an old load that is being given its ZIPs', () => {
    const r = loadSchemaFor(factored, {
      isNew: false,
      had: { customerId: true, originZip: false, destinationZip: false },
    }).safeParse({ ...base, stops: [stop('pickup', '60045'), stop('delivery', '60466')] })
    expect(r.success).toBe(true)
  })

  it('never applies any of it to a customer we do not factor', () => {
    const r = loadSchemaFor(() => false, { isNew: true })
      .safeParse({ ...base, customerId: '', stops: [stop('pickup'), stop('delivery')] })
    expect(r.success).toBe(true)
  })

  it('defaults to treating a load as new when no baseline is given', () => {
    // The safe default: a caller that has not thought about it gets the strict rules.
    const r = loadSchemaFor(factored)
      .safeParse({ ...base, stops: [stop('pickup'), stop('delivery')] })
    expect(r.success).toBe(false)
  })
})


describe('the driver profile: problems warn, only unstorable values block', () => {
  const base = { name: 'Daniel Palmer', phone: '', active: true, type: 'driver' as const }

  it('saves a driver with no phone number (Daniel Palmer), and warns about it', () => {
    expect(driverSchema.safeParse(base).success).toBe(true)
    expect(driverWarnings(base)).toEqual([{ field: 'phone', label: 'Phone', message: 'No phone number on file.' }])
  })

  it('saves a short phone and warns it has fewer than 10 digits', () => {
    const v = { ...base, phone: '555-0100' }
    expect(driverSchema.safeParse(v).success).toBe(true)
    expect(driverWarnings(v)[0]).toMatchObject({ field: 'phone', message: 'Phone has fewer than 10 digits.' })
  })

  it('no warning for a complete ten-digit phone however it is punctuated', () => {
    expect(driverWarnings({ ...base, phone: '(847) 293-6704' })).toEqual([])
    expect(driverWarnings({ ...base, phone: '+1 847 293 6704' })).toEqual([])
  })

  it('a mistyped dispatcher or driver e-mail saves, and names the field in the warning', () => {
    const v = { ...base, phone: '(847) 293-6704', email: 'zak@', dispatcherPrimary: 'jenny', dispatcherBackup: 'dennis@bcatcorp.com' }
    expect(driverSchema.safeParse(v).success).toBe(true)
    expect(driverWarnings(v).map((w) => w.label)).toEqual(['E-mail', 'Dispatcher'])
  })

  it('blank optional e-mails are not warned about', () => {
    expect(driverWarnings({ ...base, phone: '(847) 293-6704', email: '', dispatcherPrimary: '', dispatcherBackup: null })).toEqual([])
  })

  it('still refuses what cannot be stored: no name, a bad type, fleet, unit or Motive id', () => {
    expect(driverSchema.safeParse({ ...base, name: '' }).success).toBe(false)
    expect(driverSchema.safeParse({ ...base, type: 'nope' }).success).toBe(false)
    expect(driverSchema.safeParse({ ...base, fleetGroup: 'MOON' }).success).toBe(false)
    expect(driverSchema.safeParse({ ...base, unitType: 'SUBMARINE' }).success).toBe(false)
    expect(driverSchema.safeParse({ ...base, motiveDriverId: -4 }).success).toBe(false)
    expect(driverSchema.safeParse({ ...base, motiveDriverId: 1.5 }).success).toBe(false)
  })
})
