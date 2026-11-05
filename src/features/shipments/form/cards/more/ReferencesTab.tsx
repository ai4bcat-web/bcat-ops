/** More ▸ References: the extra Ref #'s (Customer / Pick Up / Consignee refs live in their own cards). */
import { memo } from 'react'
import { ReferenceEditor } from '@/features/shipments/components/DraftOrderEditor'
import { LABEL } from '../../labels'
import { isLocked, lockReason } from '../../model'
import { sliceOf, type CardProps } from '../cardRegistry'

function ReferencesTabImpl({ values, update, ctx }: CardProps) {
  const disabled = ctx.busy || isLocked(ctx.locked, 'all')
  const refsLocked = isLocked(ctx.locked, 'references')
  return (
    <div className="tms-card-more-pane" data-testid={LABEL.more.references.testId} aria-label={LABEL.more.references.text}>
      <p className="tms-muted text-xs">
        Customer Ref #, Pick Up Ref # and Consignee Ref # are entered in the Customer and Route cards.
      </p>
      {refsLocked && <p className="tms-muted text-xs">{lockReason(ctx.locked, 'references')}</p>}
      <fieldset disabled={disabled || refsLocked} className="m-0 min-w-0 border-0 p-0">
        <ReferenceEditor
          references={values.more.references}
          required={ctx.customer?.requiredReferences ?? []}
          onChange={(references) => sliceOf(update, 'more')({ references })}
          onCommit={() => {}}
        />
      </fieldset>
    </div>
  )
}

export const ReferencesTab = memo(ReferencesTabImpl)
