import { Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { TmsKeyHint } from './TmsKeyHint'

export interface TmsEmptyStateProps {
  title?: ReactNode
  message?: ReactNode
  actionLabel?: ReactNode
  onAction?: () => void
  /** Key cap shown beside the action, e.g. `C` for "clear all filters". */
  actionKey?: string
}

/** The MVMNT empty state: info icon, headline, muted line, yellow action + key cap. */
export function TmsEmptyState({
  title = 'No items found using these filters.',
  message = 'Please try again using a different query.',
  actionLabel,
  onAction,
  actionKey,
}: TmsEmptyStateProps) {
  return (
    <div className="tms-empty">
      <Info className="tms-empty-icon" size={20} aria-hidden="true" />
      <div className="tms-empty-title">{title}</div>
      {message ? <div className="tms-empty-sub">{message}</div> : null}
      {actionLabel && onAction ? (
        <button type="button" className="tms-empty-action" onClick={onAction}>
          <span>{actionLabel}</span>
          {actionKey ? <TmsKeyHint>{actionKey}</TmsKeyHint> : null}
        </button>
      ) : null}
    </div>
  )
}

export default TmsEmptyState
