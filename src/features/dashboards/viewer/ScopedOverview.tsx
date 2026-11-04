import { TmsAlert, TmsButton, TmsPage } from '@/features/tms/kit'
import { OVERVIEW_SPEC } from '@/lib/dashboards/builtin'
import { VisibilityBanner } from './VisibilityBanner'
import { WidgetGrid } from './WidgetGrid'
import { useDashboardRun } from './useDashboardRun'

const TARGET = { builtin: 'OVERVIEW' } as const

/**
 * Overview for viewers without "see all": the classic page reads every shipment, invoice and
 * sample straight from AppSync, so it is never mounted for them. The server runs the built-in
 * spec under their own visibility instead.
 */
export function ScopedOverview() {
  const { result, loading, error, reload } = useDashboardRun(TARGET)
  return (
    <TmsPage title="Dashboard" className="tms-dash" actions={<TmsButton type="button" onClick={reload}>Refresh</TmsButton>}>
      <VisibilityBanner visibility={result?.visibility ?? { viewAll: false, ownedCustomers: 0, teamKeys: [] }} />
      {error ? <TmsAlert tone="red" title="Could not load the overview">{error}</TmsAlert> : null}
      <WidgetGrid spec={OVERVIEW_SPEC} results={result?.results ?? null} loading={loading} onRetry={reload} />
    </TmsPage>
  )
}
