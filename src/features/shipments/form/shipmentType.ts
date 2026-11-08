/**
 * Pure rules for the Freight card's Shipment type (feedback 7). Picking a type stores the key, keeps
 * `values.mode` (the stored `Order.mode`) in step and fills the type's default equipment and
 * requirement chips, but only where the field is still empty or the chip still off: a person's
 * input is never overwritten. A division change brings that division's default type only while the
 * type is still the previous division's default (the user has not picked one).
 */
import { defaultTypeForDivision, legacyModeOf, shipmentTypeOf } from '@/lib/shipmentTypes'
import type { ShipmentFormValues } from './model'

export function applyShipmentType(values: ShipmentFormValues, key: string): ShipmentFormValues {
  const def = shipmentTypeOf(key)
  const ship: ShipmentFormValues['ship'] = { ...values.ship }
  if (def?.defaultEquipment && !ship.equipmentType.trim()) ship.equipmentType = def.defaultEquipment
  for (const chip of def?.defaultChips ?? []) {
    switch (chip) {
      case 'tarps': if (!ship.tarps.on) ship.tarps = { ...ship.tarps, on: true }; break
      case 'tempControl': if (!ship.temp.on) ship.temp = { ...ship.temp, on: true }; break
      case 'palletExchange': if (!ship.palletExchange.on) ship.palletExchange = { ...ship.palletExchange, on: true }; break
      case 'liftgate': case 'inside': if (ship[chip] === null) ship[chip] = true; break
      default: if (!ship.flags[chip]) ship.flags = { ...ship.flags, [chip]: true }
    }
  }
  return { ...values, shipmentType: key, mode: legacyModeOf(key), ship }
}

/** `next` is `values` after the division changed; swap in the new division's default type if the old default was still in place. */
export function typeForDivisionChange(values: ShipmentFormValues, next: ShipmentFormValues): ShipmentFormValues {
  const untouched = values.shipmentType === defaultTypeForDivision(values.ship.revDivision)
  const target = defaultTypeForDivision(next.ship.revDivision)
  return untouched && target !== next.shipmentType ? applyShipmentType(next, target) : next
}
