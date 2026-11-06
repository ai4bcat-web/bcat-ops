/** Step AR card 5 body: Rates. Net $ / Profit % are rendered by the summary rail. */
import { memo } from 'react'
import { RatesSection } from '../sections/RatesSection'
import { sliceOf, type CardProps } from './cardRegistry'

function RatesCardImpl({ values, update, ctx, form }: CardProps) {
  return <RatesSection value={values.rates} onChange={sliceOf(update, 'rates')} ctx={ctx} ship={values.ship} form={form} carriers={values.carriers} />
}

export const RatesCard = memo(RatesCardImpl)
