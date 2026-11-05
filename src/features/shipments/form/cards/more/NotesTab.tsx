/** More ▸ Notes: internal notes, never sent outside the office. */
import { memo } from 'react'
import { TmsField, TmsTextarea } from '@/features/tms/kit'
import { MAX } from '../../constants'
import { LABEL } from '../../labels'
import { isLocked } from '../../model'
import { fieldAttrs } from '../../sections/fieldAttrs'
import { sliceOf, type CardProps } from '../cardRegistry'

function NotesTabImpl({ values, update, ctx }: CardProps) {
  const disabled = ctx.busy || isLocked(ctx.locked, 'all')
  return (
    <div className="tms-card-more-pane">
      <TmsField label={LABEL.more.notes.text} hint="Never leaves the office">
        <TmsTextarea
          {...fieldAttrs(LABEL.more.notes)}
          rows={5}
          maxLength={MAX.notes}
          value={values.more.notes}
          disabled={disabled}
          onChange={(e) => sliceOf(update, 'more')({ notes: e.target.value })}
        />
      </TmsField>
    </div>
  )
}

export const NotesTab = memo(NotesTabImpl)
