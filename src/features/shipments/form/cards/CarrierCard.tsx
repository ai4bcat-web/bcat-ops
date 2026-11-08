/**
 * Step AR card 5: Carrier. Collapsed to "No carrier yet" + Cover / Assign until set; the Ivan
 * Cartage division opens straight to the roster driver + truck picker (Step AQ: roster drivers
 * only, no free text).
 */
import { memo, useEffect, useMemo } from 'react'
import { isIvanCartageName } from '@/lib/ownFleetDrivers'
import { CarrierInformationSection } from '../sections/CarrierInformationSection'
import { sliceOf, type CardProps } from './cardRegistry'

function CarrierCardImpl({ values, update, ctx, form }: CardProps) {
  const code = values.ship.revSubdivision || values.ship.revDivision
  const division = ctx.divisions.find((d) => d.division.code === code)?.division
  const ivan = isIvanCartageName(division?.name ?? code)
  const onChange = useMemo(() => sliceOf(update, 'carrier'), [update])
  const v = values.carrier
  const unset = !v.carrierId && !v.useTyped && !v.loadCarrierId && !v.isOwnFleet
  // The Ivan Cartage division IS the own fleet: open straight to the roster driver + truck picker.
  useEffect(() => { if (ivan && unset && !ctx.locked.fields.carrierPicker) onChange({ isOwnFleet: true }) }, [ivan, unset, onChange, ctx.locked.fields.carrierPicker])
  return <CarrierInformationSection value={v} onChange={onChange} ctx={ctx} form={form} expanded={ivan} />
}

export const CarrierCard = memo(CarrierCardImpl)
