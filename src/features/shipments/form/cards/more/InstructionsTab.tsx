/**
 * More ▸ Instructions: Special Instructions (420), Rate Confirmation Notes (420) and Bill of
 * Lading Notes (260), each with a live counter. Stored text longer than a limit is never cut
 * silently; it can only shrink.
 */
import { memo } from 'react'
import { TmsTextarea } from '@/features/tms/kit'
import { Field, FieldGrid } from '../../fieldGrid'
import { MAX } from '../../constants'
import { LABEL } from '../../labels'
import { isLocked } from '../../model'
import { fieldAttrs } from '../../sections/fieldAttrs'
import { sliceOf, type CardProps } from '../cardRegistry'
import { Counter } from './Counter'

function InstructionsTabImpl({ values, update, ctx }: CardProps) {
  const value = values.more
  const onChange = sliceOf(update, 'more')
  const disabled = ctx.busy || isLocked(ctx.locked, 'all')
  const bol = value.bolNotes
  return (
    <div className="tms-card-more-pane" data-testid="more-instructions">
      <FieldGrid>
        <Field span={6} narrow={12} label={LABEL.more.specialInstructions.text} info={LABEL.more.specialInstructions.help} footer={<Counter used={value.specialInstructions.length} max={MAX.specialInstructions} testId="more-special-counter" />}>
          <TmsTextarea
            {...fieldAttrs(LABEL.more.specialInstructions)}
            rows={4}
            maxLength={MAX.specialInstructions}
            value={value.specialInstructions}
            disabled={disabled}
            onChange={(e) => onChange({ specialInstructions: e.target.value })}
          />
        </Field>
        <Field span={6} narrow={12} label={LABEL.more.rateConNotes.text} footer={<Counter used={value.rateConNotes.length} max={MAX.rateConNotes} testId="more-ratecon-counter" />}>
          <TmsTextarea
            {...fieldAttrs(LABEL.more.rateConNotes)}
            rows={4}
            maxLength={MAX.rateConNotes}
            value={value.rateConNotes}
            disabled={disabled}
            onChange={(e) => onChange({ rateConNotes: e.target.value })}
          />
        </Field>
      <Field span={12} label={LABEL.more.bolNotes.text} footer={<Counter used={bol.length} max={MAX.bolNotes} testId="more-bol-counter" />}>
        <TmsTextarea
          {...fieldAttrs(LABEL.more.bolNotes)}
          rows={3}
          value={bol}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value
            if (next.length > MAX.bolNotes && next.length > bol.length) return
            onChange({ bolNotes: next })
          }}
        />
      </Field>
      </FieldGrid>
    </div>
  )
}

export const InstructionsTab = memo(InstructionsTabImpl)
