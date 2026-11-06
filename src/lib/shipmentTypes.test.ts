import { describe, expect, it } from 'vitest'
import {
  SHIPMENT_TYPES,
  defaultTypeForDivision,
  effectiveShipmentType,
  isShipmentTypeKey,
  legacyModeOf,
  shipmentTypeOf,
  typeOfLegacyMode,
} from './shipmentTypes'
import type { ShipmentMode } from '../types/tms'

const MODES: ShipmentMode[] = ['FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL']

describe('SHIPMENT_TYPES', () => {
  it('lists the 25 types of feedback 7, in order, with unique keys', () => {
    expect(SHIPMENT_TYPES.map((t) => t.label)).toEqual([
      'Truckload (FTL)', 'LTL', 'Partial / Volume', 'Expedited', 'Hot shot', 'Team', 'Power only', 'Drayage',
      'Intermodal (rail)', 'Rail carload', 'Air freight', 'Ocean FCL', 'Ocean LCL', 'Auto transport (open)',
      'Auto transport (enclosed)', 'Heavy haul / Oversize', 'Flatbed specialized', 'Refrigerated / Reefer', 'Hazmat',
      'Final mile', 'Dedicated', 'Cross-border (Mexico)', 'Cross-border (Canada)', 'Courier / Parcel', 'Other',
    ])
    expect(new Set(SHIPMENT_TYPES.map((t) => t.key)).size).toBe(SHIPMENT_TYPES.length)
  })

  it('documents each type default (equipment, chips)', () => {
    const defaults = Object.fromEntries(
      SHIPMENT_TYPES.filter((t) => t.defaultEquipment || t.defaultChips).map((t) => [t.key, [t.defaultEquipment, t.defaultChips]]),
    )
    expect(defaults).toEqual({
      EXPEDITED: [undefined, ['hot']],
      HOT_SHOT: ['Hotshot', ['hot']],
      TEAM: [undefined, ['team']],
      POWER_ONLY: ['Power Only', undefined], // the carrier brings the power, no trailer equipment chip
      DRAYAGE: ['Container', undefined],
      INTERMODAL: ['Container', undefined],
      OCEAN_FCL: ['Container', undefined],
      AUTO_OPEN: ['Auto carrier', undefined],
      AUTO_ENCLOSED: ['Enclosed auto carrier', undefined],
      HEAVY_HAUL: ['Step Deck', ['oversized', 'permits']],
      FLATBED_SPECIALIZED: ['Flatbed', ['tarps', 'strapsChains']],
      REEFER: ['Reefer', ['tempControl']],
      HAZMAT: [undefined, ['hazmat']],
      FINAL_MILE: ['Box Truck', ['liftgate', 'inside']],
      XBORDER_MX: [undefined, ['customsBonded']],
      XBORDER_CA: [undefined, ['customsBonded']],
    })
  })
})

describe('defaultTypeForDivision', () => {
  it('maps each division, falling back to FTL', () => {
    expect(defaultTypeForDivision('BROKERAGE')).toBe('FTL')
    expect(defaultTypeForDivision('CAR_SHIPPING')).toBe('AUTO_OPEN')
    expect(defaultTypeForDivision('ASSETS')).toBe('FTL')
    expect(defaultTypeForDivision('OWNER_OPERATOR')).toBe('POWER_ONLY')
    expect(defaultTypeForDivision('SOMETHING_NEW')).toBe('FTL')
    expect(defaultTypeForDivision(null)).toBe('FTL')
  })
})

describe('legacy mode mapping', () => {
  it('maps every type onto a mode that exists, and unknown keys to FTL', () => {
    for (const t of SHIPMENT_TYPES) expect(MODES).toContain(legacyModeOf(t.key))
    expect(legacyModeOf('PARTIAL')).toBe('PTL')
    expect(legacyModeOf('REEFER')).toBe('FTL')
    expect(legacyModeOf('OCEAN_LCL')).toBe('OCEAN')
    expect(legacyModeOf('RAIL_CARLOAD')).toBe('RAIL')
    expect(legacyModeOf('nope')).toBe('FTL')
    expect(legacyModeOf(null)).toBe('FTL')
  })

  it('gives every stored mode a type that maps straight back to the same mode', () => {
    for (const mode of MODES.filter((m) => m !== 'BULK' && m !== 'RLTL')) {
      expect(legacyModeOf(typeOfLegacyMode(mode))).toBe(mode)
    }
    expect(typeOfLegacyMode('RLTL')).toBe('LTL')
    expect(typeOfLegacyMode('')).toBe('FTL')
    expect(typeOfLegacyMode('WHATEVER')).toBe('FTL')
  })

  it('prefers an explicit known type over the mode', () => {
    expect(effectiveShipmentType('REEFER', 'FTL')).toBe('REEFER')
    expect(effectiveShipmentType('bogus', 'LTL')).toBe('LTL')
    expect(effectiveShipmentType(undefined, 'AIR')).toBe('AIR')
    expect(isShipmentTypeKey('HAZMAT')).toBe(true)
    expect(isShipmentTypeKey('')).toBe(false)
    expect(shipmentTypeOf('TEAM')?.label).toBe('Team')
  })
})
