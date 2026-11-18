import { describe, expect, it } from 'vitest'
import { driverDocAccessorials, driverDocFlagNote, stopTypeForDriverDoc } from './driverDocAccessorials'

describe('driverDocAccessorials', () => {
  it('reads detention from the driver note, in any case and wording the drivers use', () => {
    expect(driverDocAccessorials('Detention pay')).toEqual(['DETENTION'])
    expect(driverDocAccessorials('detention sheet')).toEqual(['DETENTION'])
    expect(driverDocAccessorials('DETENTION - waited 4 hrs')).toEqual(['DETENTION'])
    expect(driverDocAccessorials('detn pay')).toEqual(['DETENTION'])
    expect(driverDocAccessorials('  Detention  ')).toEqual(['DETENTION'])
  })

  it('reads TONU, and both when the note names both', () => {
    expect(driverDocAccessorials('TONU')).toEqual(['TONU'])
    expect(driverDocAccessorials('truck order not used')).toEqual(['TONU'])
    expect(driverDocAccessorials('TONU and detention')).toEqual(['DETENTION', 'TONU'])
  })

  it('does nothing for a blank or unrelated note', () => {
    expect(driverDocAccessorials(null)).toEqual([])
    expect(driverDocAccessorials(undefined)).toEqual([])
    expect(driverDocAccessorials('   ')).toEqual([])
    expect(driverDocAccessorials('seal number 4471')).toEqual([])
    expect(driverDocAccessorials('damaged pallet, gate pass')).toEqual([])
    expect(driverDocAccessorials('lumper receipt')).toEqual([])
  })

  it('does not match inside another word', () => {
    expect(driverDocAccessorials('retention policy')).toEqual([])
    expect(driverDocAccessorials('detentions')).toEqual([])
  })

  it('ignores a note that rules it out, but not one that also asks for it', () => {
    expect(driverDocAccessorials('no detention')).toEqual([])
    expect(driverDocAccessorials('No detention at pickup')).toEqual([])
    expect(driverDocAccessorials('without detention')).toEqual([])
    expect(driverDocAccessorials('no tonu')).toEqual([])
    expect(driverDocAccessorials('Detention pay (no detention at pickup)')).toEqual(['DETENTION'])
  })
})

describe('stopTypeForDriverDoc', () => {
  it('uses the stop on the load, then the label, then the delivery', () => {
    expect(stopTypeForDriverDoc({ type: 'pickup' }, 'Delivery — X')).toBe('pickup')
    expect(stopTypeForDriverDoc({ type: 'delivery' }, 'Pickup — X')).toBe('delivery')
    expect(stopTypeForDriverDoc(null, 'Pickup — INGREDION INC')).toBe('pickup')
    expect(stopTypeForDriverDoc(null, 'Delivery — IFF')).toBe('delivery')
    expect(stopTypeForDriverDoc(undefined, null)).toBe('delivery')
    expect(stopTypeForDriverDoc({ type: 'stop' }, '')).toBe('delivery')
  })
})

describe('driverDocFlagNote', () => {
  it('quotes the driver and says it came from the app', () => {
    expect(driverDocFlagNote({ driverName: 'Joshua Kly', note: ' Detention pay ' })).toBe('Driver note: "Detention pay" — Joshua Kly, driver app')
  })
  it('stays inside the flag note limit', () => {
    expect(driverDocFlagNote({ driverName: 'A', note: 'x'.repeat(2000) }).length).toBeLessThanOrEqual(480)
  })
})
