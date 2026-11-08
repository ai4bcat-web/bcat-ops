/** More ▸ Items: freight lines beyond line 1 (line 1 is the Freight card). */
import { memo } from 'react'
import { FreightEditor } from '@/features/shipments/components/DraftOrderEditor'
import { LABEL } from '../../labels'
import { isLocked, lockReason } from '../../model'
import { sliceOf, type CardProps } from '../cardRegistry'

function ItemsTabImpl({ values, update, ctx }: CardProps) {
  const disabled = ctx.busy || isLocked(ctx.locked, 'all')
  const itemsLocked = isLocked(ctx.locked, 'items')
  return (
    <div className="tms-card-more-pane" data-testid={LABEL.more.items.testId} aria-label={LABEL.more.items.text}>
      <p className="tms-muted text-xs">
        Line 1 (Description, Pieces, Weight, Freight Class) is edited in the Freight card. Add further lines here.
      </p>
      {itemsLocked && <p className="tms-muted text-xs">{lockReason(ctx.locked, 'items')}</p>}
      <fieldset disabled={disabled || itemsLocked} className="m-0 min-w-0 border-0 p-0">
        <FreightEditor freight={values.more.items} onChange={(items) => sliceOf(update, 'more')({ items })} onCommit={() => {}} />
      </fieldset>
    </div>
  )
}

export const ItemsTab = memo(ItemsTabImpl)
