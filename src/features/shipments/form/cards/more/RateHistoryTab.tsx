/** More ▸ Rate history: Step AE lane history (yesterday … year; linehaul vs rate), read-only. */
import { memo } from 'react'
import { HistoricalRatesSection } from '../../sections/HistoricalRatesSection'
import type { CardProps } from '../cardRegistry'

function RateHistoryTabImpl({ values, ctx, form }: CardProps) {
  return <HistoricalRatesSection stops={values.stops} equipmentType={values.ship.equipmentType} ctx={ctx} form={form} />
}

export const RateHistoryTab = memo(RateHistoryTabImpl)
