import type { ReactNode } from 'react'
import { Filter, Hash, Maximize2, Table } from 'lucide-react'

export interface TmsChartCardProps {
  title: ReactNode
  /** Each control renders only when the dashboard supplies a handler for it. */
  onFilter?: () => void
  onNumbers?: () => void
  onTable?: () => void
  onExpand?: () => void
  /** The "…" overflow control; supply the trigger (and its menu) to show it. */
  menu?: ReactNode
  children?: ReactNode
}

/** Dashboard chart card (reference §3): 410px tall, dark header strip, chart body. */
export function TmsChartCard({ title, onFilter, onNumbers, onTable, onExpand, menu, children }: TmsChartCardProps) {
  return (
    <section className="tms-chart-card">
      <header className="tms-chart-head">
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
