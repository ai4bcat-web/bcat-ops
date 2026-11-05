/**
 * Step AR card 5: Carrier. Collapsed to "No carrier yet" + Cover / Assign until set; the Ivan
 * Cartage division opens straight to the roster driver + truck picker (Step AQ: roster drivers
 * only, no free text).
 */
import { memo } from 'react'
import { isIvanCartageName } from '@/lib/ownFleetDrivers'
import { CarrierInformationSection } from '../sections/CarrierInformationSection'
import { sliceOf, type CardProps } from './cardRegistry'

function CarrierCardImpl({ values, update, ctx, form }: CardProps) {
  const code = values.ship.revSubdivision || values.ship.revDivision
  const division = ctx.divisions.find((d) => d.division.code === code)?.division
  const ivan = isIvanCartageName(division?.name ?? code)
  return <CarrierInformationSection value={values.carrier} onChange={sliceOf(update, 'carrier')} ctx={ctx} form={form} expanded={ivan} />
}

export const CarrierCard = memo(CarrierCardImpl)
