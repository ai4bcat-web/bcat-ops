import { Suspense, lazy, useMemo } from 'react'
import { TmsAlert, TmsButton, TmsKpiCard } from '@/features/tms/kit'
import { useOnVisible } from '@/hooks/useOnVisible'
import type { Widget, WidgetResult } from '@/lib/dashboards/types'
import { chartDefFor } from './seriesAdapter'

// recharts stays in its own chunk and loads when a widget nears the viewport (PERF R6).
const ChartCard = lazy(() => import('@/features/tms/dashboard/ChartCard'))

export function WidgetSkeleton({ title }: { title: string }) {
  return <section className="tms-chart-card dash-skeleton" aria-busy="true" aria-label={title} />
}

function OkWidget({ widget, result }: { widget: Widget; result: Extract<WidgetResult, { ok: true }> }) {
  const [ref, visible] = useOnVisible<HTMLElement>('400px')
  const { def, series } = useMemo(() => chartDefFor(widget.id, widget.title, result), [widget.id, widget.title, result])
  const tilesOnly = widget.type === 'KPI' && series.rows.length === 0
  if (tilesOnly) {
    return (
      <div className="dash-kpis" data-testid={`dash-widget-${widget.id}`}>
        {(series.kpis ?? []).map((kpi) => (
          <TmsKpiCard key={kpi.label} label={kpi.label} value={kpi.value} sub={series.note ?? null} />
        ))}
      </div>
    )
  }
  if (!visible) return <section ref={ref} className="tms-chart-card dash-skeleton" aria-busy="true" aria-label={widget.title} />
  return (
    <div data-testid={`dash-widget-${widget.id}`} className="dash-chart">
      <Suspense fallback={<WidgetSkeleton title={widget.title} />}>
        <ChartCard def={def} series={series} />
      </Suspense>
    </div>
  )
}

/** One widget: its server result drawn by the existing renderers, or an inline error with Retry. */
export function WidgetView({ widget, result, onRetry }: { widget: Widget; result: WidgetResult; onRetry: () => void }) {
  if (!result.ok) {
    return (
      <section className="tms-chart-card dash-error" data-testid={`dash-widget-${widget.id}`}>
        <TmsAlert tone="red" title={widget.title}>
          {result.error}
          {' '}
          <TmsButton type="button" onClick={onRetry}>Retry</TmsButton>
        </TmsAlert>
      </section>
    )
  }
  return <OkWidget widget={widget} result={result} />
}
