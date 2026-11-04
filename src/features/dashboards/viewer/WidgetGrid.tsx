import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { autoLayout } from '@/lib/dashboards/spec'
import type { DashboardSpec, WidgetResult } from '@/lib/dashboards/types'
import { WidgetSkeleton, WidgetView } from './WidgetView'
import './viewer.css'

export interface WidgetGridProps {
  spec: DashboardSpec
  /** `null` until a run answered. */
  results: WidgetResult[] | null
  loading: boolean
  /** Re-runs the dashboard (the server runs a spec as a whole). */
  onRetry: (widgetId: string) => void
}

/** 12-column grid placed by `autoLayout`; stacks to one column on narrow screens. */
export function WidgetGrid({ spec, results, loading, onRetry }: WidgetGridProps) {
  const layout = useMemo(() => new Map(autoLayout(spec.widgets).map((item) => [item.id, item])), [spec.widgets])
  const byId = useMemo(() => new Map((results ?? []).map((r) => [r.widgetId, r])), [results])
  const ordered = [...spec.widgets].sort((a, b) => {
    const la = layout.get(a.id)
    const lb = layout.get(b.id)
    return (la?.row ?? 0) - (lb?.row ?? 0) || (la?.col ?? 0) - (lb?.col ?? 0)
  })
  return (
    <div className="dash-grid" data-testid="dash-grid" aria-busy={loading}>
      {ordered.map((widget) => {
        const place = layout.get(widget.id)
        const style = { '--dash-col': (place?.col ?? 0) + 1, '--dash-span': place?.span ?? 12 } as CSSProperties
        const result = byId.get(widget.id)
        return (
          <div key={widget.id} className="dash-cell" style={style}>
            {loading || !result
              ? <WidgetSkeleton title={widget.title} />
              : <WidgetView widget={widget} result={result} onRetry={() => onRetry(widget.id)} />}
          </div>
        )
      })}
    </div>
  )
}
