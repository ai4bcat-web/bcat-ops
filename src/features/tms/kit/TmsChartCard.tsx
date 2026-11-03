import type { ReactNode } from 'react'
import { Filter, Hash, Maximize2, Table } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface TmsChartCardProps {
  title: ReactNode
  /** Optional 16px line icon rendered before the title. */
  icon?: LucideIcon
  /** Extra class on the card (the dashboard grid uses it to span a full row). */
  className?: string
  /** Each control renders only when the dashboard supplies a handler for it. */
  onFilter?: () => void
  onNumbers?: () => void
  onTable?: () => void
  onExpand?: () => void
  /** The "…" overflow control; supply the trigger (and its menu) to show it. */
  menu?: ReactNode
  children?: ReactNode
}

/** Dashboard chart card (reference §3): white card, 14/600 title with a leading icon, chart body. */
export function TmsChartCard({ title, icon: Icon, className, onFilter, onNumbers, onTable, onExpand, menu, children }: TmsChartCardProps) {
  return (
    <section className={`tms-chart-card${className ? ` ${className}` : ''}`}>
      <header className="tms-chart-head">
        {Icon ? <Icon size={16} className="tms-chart-icon" aria-hidden="true" /> : null}
        <span className="tms-chart-title">{title}</span>
        {onFilter ? (
          <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Filter chart" onClick={onFilter}>
            <Filter size={13} />
          </button>
        ) : null}
        <div className="tms-chart-head-right">
          {onNumbers ? (
            <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Number view" onClick={onNumbers}>
              <Hash size={14} />
            </button>
          ) : null}
          {onTable ? (
            <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Table view" onClick={onTable}>
              <Table size={14} />
            </button>
          ) : null}
          {onExpand ? (
            <button type="button" className="tms-icon-btn tms-icon-btn-plain" aria-label="Expand chart" onClick={onExpand}>
              <Maximize2 size={14} />
            </button>
          ) : null}
          {menu}
        </div>
      </header>
      <div className="tms-chart-body">{children}</div>
    </section>
  )
}

export default TmsChartCard
