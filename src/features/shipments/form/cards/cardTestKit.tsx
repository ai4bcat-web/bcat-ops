/** Test host for the AR cards: owns a values object and hands the card the CardProps contract. */
import type { ComponentType } from 'react'
import { render } from '@testing-library/react'
import { emptyValues, NO_LOCKS, type ShipmentFormValues } from '../model'
import type { FormCtx } from '../sectionProps'
import { ValuesHost, type Host } from '../sections/SectionHost'
import { makeCtx } from '../sections/sectionTestKit'
import type { CardProps } from './cardRegistry'

export function renderCard(
  Card: ComponentType<CardProps>,
  opts: { ctx?: (values: ShipmentFormValues) => Partial<FormCtx>; seed?: (v: ShipmentFormValues) => ShipmentFormValues } = {},
) {
  const host: { current: Host | null } = { current: null }
  render(
    <ValuesHost onHost={(h) => { host.current = h }} initial={opts.seed ? opts.seed(emptyValues()) : undefined}>
      {(values, update, form) => (
        <Card
          values={values} update={update} form={form} issues={[]} mode="create" locked={NO_LOCKS}
          ctx={makeCtx(opts.ctx?.(values) ?? {})}
        />
      )}
    </ValuesHost>,
  )
  return host
}
