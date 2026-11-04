/**
 * The dashboard's card shell, kept free of recharts: the chart module (`ChartCard`, with recharts)
 * is a separate chunk that loads only when a card first scrolls within 400px of the viewport (PERF
 * R6). Until then, and until the page has data, a card is an empty placeholder in the same grid cell.
 */
import { Suspense, lazy, useMemo } from 'react'
import { useOnVisible } from '@/hooks/useOnVisible'
import type { ChartDef, DashboardData, DashboardFilters, DashboardGroupBy } from './types'

const ChartCard = lazy(() => import('./ChartCard'))

export function ChartPlaceholder({ def, sectionRef }: { def: ChartDef; sectionRef?: (node: HTMLElement | null) => void }) {
  return (
    <section
      ref={sectionRef}
      className={`tms-chart-card${def.kind === 'table' ? ' tms-chart-wide' : ''}`}
      style={{ minHeight: 240 }}
      aria-busy="true"
      aria-label={def.title}
    />
  )
}

export interface LazyChartCardProps {
  def: ChartDef
  data: DashboardData
  filters: DashboardFilters
  /** The effective group-by (the card's override, else the dashboard's). */
  groupBy: DashboardGroupBy | null
  override: DashboardGroupBy | null | undefined
  onOverride: (groupBy: DashboardGroupBy | null | undefined) => void
}

/** Computes and mounts the chart only once the card is within 400px of the viewport. */
export function LazyChartCard({ def, data, filters, groupBy, override, onOverride }: LazyChartCardProps) {
  const [ref, visible] = useOnVisible<HTMLElement>('400px')
  const series = useMemo(
    () => (visible ? def.compute(data, filters, groupBy) : null),
    [visible, def, data, filters, groupBy],
  )
  if (!series) return <ChartPlaceholder def={def} sectionRef={ref} />
  return (
    <Suspense fallback={<ChartPlaceholder def={def} />}>
      <ChartCard def={def} series={series} override={override} onOverride={onOverride} />
    </Suspense>
  )
}
