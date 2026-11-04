import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { TmsAlert, TmsBadge, TmsButton, TmsPage } from '@/features/tms/kit'
import { archiveDashboard, getDashboard, saveDashboard } from '@/lib/apiClient'
import type { DashboardRecord, DashboardWindow, WindowPreset } from '@/lib/dashboards/types'
import { SCOPE_LABELS } from './labels'
import { VisibilityBanner } from './VisibilityBanner'
import { WidgetGrid } from './WidgetGrid'
import { useDashboardAccess } from './useDashboardAccess'
import { useDashboardRun } from './useDashboardRun'

const PRESETS: { value: WindowPreset; label: string }[] = [
  { value: 'THIS_MONTH', label: 'This month' },
  { value: 'LAST_MONTH', label: 'Last month' },
  { value: 'THIS_QUARTER', label: 'This quarter' },
  { value: 'LAST_QUARTER', label: 'Last quarter' },
  { value: 'LAST_30_DAYS', label: 'Last 30 days' },
  { value: 'LAST_90_DAYS', label: 'Last 90 days' },
  { value: 'YEAR_TO_DATE', label: 'Year to date' },
]

function filterSummary(d: DashboardRecord): string[] {
  const f = d.spec.filters
  const out: string[] = []
  if (f.divisions.length) out.push(`Divisions: ${f.divisions.join(', ')}`)
  if (f.customerIds.length) out.push(`${f.customerIds.length} customer filter${f.customerIds.length === 1 ? '' : 's'}`)
  if (f.repIds.length) out.push(`${f.repIds.length} rep filter${f.repIds.length === 1 ? '' : 's'}`)
  if (f.modes.length) out.push(`Modes: ${f.modes.join(', ')}`)
  return out
}

/** `/tms/dashboard/d/:id`: runs the saved spec under the viewer's own visibility. */
export function DashboardViewPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const access = useDashboardAccess()
  const [loaded, setLoaded] = useState<{ id: string; record: { dashboard: DashboardRecord; canEdit: boolean } | null; error: string | null } | null>(null)
  const [windowPreset, setWindowPreset] = useState<WindowPreset | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    getDashboard(id).then(
      (record) => { if (live) setLoaded({ id, record, error: null }) },
      (e: unknown) => { if (live) setLoaded({ id, record: null, error: e instanceof Error ? e.message : 'Dashboard not found' }) },
    )
    return () => { live = false }
  }, [id])

  const record = loaded?.id === id ? loaded.record : null
  const loadError = loaded?.id === id ? loaded.error : null
  const target = useMemo(() => {
    if (!record) return null
    const override: DashboardWindow | undefined = windowPreset ? { preset: windowPreset } : undefined
    return override ? { id, window: override } : { id }
  }, [record, id, windowPreset])
  const run = useDashboardRun(target)

  if (loadError) {
    return (
      <TmsPage title="Dashboard">
        <TmsAlert tone="red">{loadError}</TmsAlert>
        <Link to="/tms/dashboard">Back to dashboards</Link>
      </TmsPage>
    )
  }
  if (!record) {
    return <TmsPage title="Dashboard"><div className="dash-skeleton tms-chart-card" aria-busy="true" /></TmsPage>
  }
  const { dashboard, canEdit } = record
  const effectiveWindow = windowPreset ?? (dashboard.spec.filters.window.preset === 'CUSTOM' ? null : dashboard.spec.filters.window.preset)
  const summary = filterSummary(dashboard)

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try { await fn() } catch (e) { setActionError(e instanceof Error ? e.message : 'Action failed') } finally { setBusy(false) }
  }
  const duplicate = () => act(async () => {
    const copy = await saveDashboard({ spec: { ...dashboard.spec, title: `${dashboard.title} (copy)`.slice(0, 80), scope: { kind: 'ME' } } })
    navigate(`/tms/dashboard/d/${copy.id}`)
  })
  const archive = () => act(async () => {
    await archiveDashboard(dashboard.id, dashboard.version)
    navigate('/tms/dashboard?tab=mine', { replace: true })
  })

  const actions = (
    <>
      <select
        className="tms-select"
        aria-label="Time window"
        value={effectiveWindow ?? ''}
        onChange={(e) => setWindowPreset(e.target.value as WindowPreset)}
      >
        {effectiveWindow === null ? <option value="">Custom range</option> : null}
        {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
      <TmsButton type="button" onClick={run.reload}>Refresh</TmsButton>
      {access.create ? <TmsButton type="button" disabled={busy} onClick={duplicate}>Duplicate</TmsButton> : null}
      {canEdit && access.create ? (
        <TmsButton type="button" onClick={() => navigate(`/tms/dashboard/d/${dashboard.id}/edit`)}>Edit</TmsButton>
      ) : null}
      {canEdit ? (
        confirmArchive
          ? <TmsButton type="button" variant="destructive" disabled={busy} onClick={archive}>Confirm archive</TmsButton>
          : <TmsButton type="button" onClick={() => setConfirmArchive(true)}>Archive</TmsButton>
      ) : null}
    </>
  )

  return (
    <TmsPage title={dashboard.title} actions={actions} className="tms-dash">
      <div className="dash-card-meta">
        <TmsBadge tone={dashboard.scope === 'COMPANY' ? 'green' : 'gray'}>{SCOPE_LABELS[dashboard.scope]}</TmsBadge>
        {' '}{dashboard.ownerName ?? 'Unknown owner'}
        {summary.length ? ` · ${summary.join(' · ')}` : ''}
        {run.result ? ` · ${run.result.resolved.from} to ${run.result.resolved.to}` : ''}
      </div>
      {dashboard.spec.description ? <p>{dashboard.spec.description}</p> : null}
      <VisibilityBanner visibility={run.result?.visibility ?? { viewAll: access.viewAll, ownedCustomers: 0, teamKeys: [] }} />
      {actionError ? <TmsAlert tone="red">{actionError}</TmsAlert> : null}
      {run.error ? <TmsAlert tone="red" title="Could not run this dashboard">{run.error}</TmsAlert> : null}
      <WidgetGrid spec={dashboard.spec} results={run.result?.results ?? null} loading={run.loading} onRetry={run.reload} />
    </TmsPage>
  )
}

export default DashboardViewPage
