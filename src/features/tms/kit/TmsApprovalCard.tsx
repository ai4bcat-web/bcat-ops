import { Eye } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { TmsButton } from './TmsButton'

export interface TmsApprovalCardProps {
  title: ReactNode
  subtitle?: ReactNode
  chip?: ReactNode
  meta?: ReactNode
  children?: ReactNode
  /** Eye-icon "View" link. */
  to?: string
  onApprove?: () => void
  onReject?: () => void
  approveLabel?: string
  rejectLabel?: string
  /** Extra buttons, rendered before Approve / Reject. */
  actions?: ReactNode
  busy?: boolean
  testId?: string
  className?: string
}

/** Approve / reject card: title row, optional body, green + red outline actions. */
export function TmsApprovalCard({
  title,
  subtitle,
  chip,
  meta,
  children,
  to,
  onApprove,
  onReject,
  approveLabel = 'Approve',
  rejectLabel = 'Reject',
  actions,
  busy,
  testId,
  className,
}: TmsApprovalCardProps) {
  const hasActions = Boolean(actions) || Boolean(onApprove) || Boolean(onReject)
  return (
    <article className={`tms-approval${className ? ` ${className}` : ''}`} data-testid={testId}>
      <div className="tms-approval-head">
        <div className="tms-approval-titles">
          <div className="tms-approval-title">{title}</div>
          {subtitle ? <div className="tms-approval-subtitle">{subtitle}</div> : null}
        </div>
        {chip ? <div className="tms-approval-chip">{chip}</div> : null}
        {to ? (
          <Link to={to} className="tms-approval-view" aria-label="View">
            <Eye size={16} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      {meta ? <div className="tms-approval-meta">{meta}</div> : null}
      {children ? <div className="tms-approval-body">{children}</div> : null}
      {hasActions ? (
        <div className="tms-approval-actions">
          {actions}
          {onReject ? (
            <TmsButton variant="reject" size="sm" disabled={busy} onClick={onReject}>
              {rejectLabel}
            </TmsButton>
          ) : null}
          {onApprove ? (
            <TmsButton variant="approve" size="sm" disabled={busy} onClick={onApprove}>
              {approveLabel}
            </TmsButton>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export default TmsApprovalCard
