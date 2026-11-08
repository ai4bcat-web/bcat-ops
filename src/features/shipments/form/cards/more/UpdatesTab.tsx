/** More ▸ Updates (edit mode): the shipment's history feed. */
import { memo } from 'react'
import { HistorySection } from '@/features/shipments/components/HistorySection'
import { LABEL } from '../../labels'
import type { CardProps } from '../cardRegistry'

function UpdatesTabImpl({ ctx }: CardProps) {
  return (
    <div className="tms-card-more-pane" data-testid={LABEL.more.updates.testId}>
      {ctx.bundle ? <HistorySection bundle={ctx.bundle} /> : <p className="tms-muted text-sm">Updates appear after the first save.</p>}
    </div>
  )
}

export const UpdatesTab = memo(UpdatesTabImpl)
