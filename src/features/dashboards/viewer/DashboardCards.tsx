import { Link } from 'react-router-dom'
import { TmsBadge, TmsEmptyState } from '@/features/tms/kit'
import type { DashboardSummary } from '@/lib/dashboards/types'
import { SCOPE_LABELS } from './labels'
import './viewer.css'


function updated(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : ''
}

export function DashboardCards({ items, emptyTitle, emptyAction }: { items: DashboardSummary[]; emptyTitle: string; emptyAction?: { label: string; onClick: () => void } }) {
  if (items.length === 0) {
    return <TmsEmptyState title={emptyTitle} message={null} actionLabel={emptyAction?.label} onAction={emptyAction?.onClick} />
  }
  return (
    <div className="dash-cards" data-testid="dash-cards">
      {items.map((d) => (
        <Link key={d.id} to={`/tms/dashboard/d/${d.id}`} className="dash-card" data-testid={`dash-card-${d.id}`}>
          <span className="dash-card-title">{d.title}</span>
          <span><TmsBadge tone={d.scope === 'COMPANY' ? 'green' : 'gray'}>{SCOPE_LABELS[d.scope]}</TmsBadge></span>
          <span className="dash-card-meta">
            {d.ownerName ?? 'Unknown owner'} · {d.widgetCount} {d.widgetCount === 1 ? 'widget' : 'widgets'}
            {d.updatedAt ? ` · ${updated(d.updatedAt)}` : ''}
          </span>
        </Link>
      ))}
    </div>
  )
}
