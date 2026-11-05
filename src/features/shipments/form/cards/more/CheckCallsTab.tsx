/** More ▸ Check calls (edit mode): the read-only Load Tracking preview. */
import { memo } from 'react'
import { CheckCallsSection } from '../../sections/CheckCallsSection'
import { sliceOf, type CardProps } from '../cardRegistry'

function CheckCallsTabImpl({ values, update, ctx, form }: CardProps) {
  return <CheckCallsSection value={values.checkCall} onChange={sliceOf(update, 'checkCall')} ctx={ctx} form={form} />
}

export const CheckCallsTab = memo(CheckCallsTabImpl)
