/** More ▸ Updates (edit mode): who did what and when lives in the right rail's Activity; this tab keeps only the invoice change timeline. */
import { memo } from 'react'
import { Link } from 'react-router-dom'
import { ChangeTimeline } from '@/components/ChangeTimeline'
import { entitiesWithSpellings } from '@/components/changeTimelineModel'
import { auditEntitiesFor } from '@/features/shipments/auditEntities'
import { AUDIT_PATH } from '../../ActivityBlock'
import { LABEL } from '../../labels'
import type { CardProps } from '../cardRegistry'

function UpdatesTabImpl({ ctx }: CardProps) {
  const bundle = ctx.bundle
  const invoiceIds = (bundle?.orders ?? []).map((o) => o.invoiceId).filter((id): id is string => Boolean(id))
  return (
    <div className="tms-card-more-pane" data-testid={LABEL.more.updates.testId}>
      {bundle ? (
        <>
          <p className="tms-muted text-sm">
            Who did what, and when, is in the Activity list on the right.{' '}
            <Link className="ship-link" to={`${AUDIT_PATH}?entity=${encodeURIComponent(bundle.shipment.id)}`}>Open the full audit history</Link>
          </p>
          {invoiceIds.length > 0 && (
            <ChangeTimeline
              entities={[...auditEntitiesFor(bundle), ...entitiesWithSpellings(['Invoice', 'INVOICE'], invoiceIds)]}
              refreshKey={bundle.shipment.updatedAt}
            />
          )}
        </>
      ) : <p className="tms-muted text-sm">Updates appear after the first save.</p>}
    </div>
  )
}

export const UpdatesTab = memo(UpdatesTabImpl)
