import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { TmsAlert, TmsBadge, TmsButton, TmsField, TmsInput, TmsPage } from '@/features/tms/kit'
import { dashboardOptions, getDashboard, saveDashboard } from '@/lib/apiClient'
import { SPEC_LIMITS } from '@/lib/dashboards/spec'
import type { DashboardRecord, DashboardScope, DashOptions } from '@/lib/dashboards/types'
import { WidgetGrid } from '../viewer/WidgetGrid'
import { useDashboardAccess } from '../viewer/useDashboardAccess'
import { useDashboardRun } from '../viewer/useDashboardRun'
import { ChatPanel } from './ChatPanel'
import { SaveDashboardDialog } from './SaveDashboardDialog'
import { useDashboardChat } from './useDashboardChat'
import './builder.css'

const DASHBOARD_HOME = '/tms/dashboard'

/**
 * D1: the dashboard service filters what a dashboard SHOWS to the viewer's own customers. It is
 * not a read boundary: any signed-in user can still query the underlying records directly.
 */
export const D1_NOTICE =
  'Dashboards built here show only the customers you own or your team covers, and the dashboard service enforces that for everyone who opens them. This is not a security boundary for the underlying records: any signed-in user can still read them directly through the API. Treat a dashboard as a view, not as access control.'

function sharedWithOf(scope: DashboardScope) {
  return {
    userIds: scope.kind === 'USERS' ? scope.userIds : [],
    teamKeys: scope.kind === 'TEAM' ? scope.teamKeys : [],
  }
}

/** Route element for `/tms/dashboard/new` and `/tms/dashboard/d/:id/edit`. */
export function DashboardBuilderPage() {
  const { id } = useParams<{ id?: string }>()
  const access = useDashboardAccess()
  const [loaded, setLoaded] = useState<{
    id: string
    record: { dashboard: DashboardRecord; canEdit: boolean } | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (!id || !access.create) return
    let live = true
    getDashboard(id).then(
      (r) => live && setLoaded({ id, record: r, error: null }),
      (e: unknown) =>
        live && setLoaded({ id, record: null, error: e instanceof Error ? e.message : 'Could not open this dashboard.' }),
    )
    return () => {
      live = false
    }
  }, [id, access.create])

  // An answer for a different dashboard id is not an answer for this one.
  const current = loaded && loaded.id === id ? loaded : null
  const record = current?.record ?? null
  const loadError = current?.error ?? null

  if (!access.create) return <Navigate to={DASHBOARD_HOME} replace />
  if (id && loadError) {
    return (
      <TmsPage title="Edit dashboard">
        <TmsAlert tone="red">{loadError}</TmsAlert>
      </TmsPage>
    )
  }
  if (id && !record) {
    return (
      <TmsPage title="Edit dashboard">
        <div role="status">Loading…</div>
      </TmsPage>
    )
  }
  if (record && !record.canEdit) {
    return (
      <TmsPage title="Edit dashboard">
        <TmsAlert tone="orange">You can view this dashboard but not edit it. Open it and use Duplicate to make your own copy.</TmsAlert>
      </TmsPage>
    )
  }
  return <Builder key={id ?? 'new'} record={record?.dashboard ?? null} />
}

function Builder({ record }: { record: DashboardRecord | null }) {
  const navigate = useNavigate()
  const access = useDashboardAccess()
  const [options, setOptions] = useState<DashOptions | null>(null)
  const chat = useDashboardChat(record ? { scope: record.spec.scope, draft: record.spec } : undefined)
  const { draft, scope } = chat
  // The user's own title wins; until they type one the assistant's draft title names the dashboard.
  const [titleOverride, setTitleOverride] = useState<string | null>(record ? record.title : null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    dashboardOptions().then(
      (o) => live && setOptions(o),
      () => undefined, // pickers fall back to empty lists; the server still validates every scope
    )
    return () => {
      live = false
    }
  }, [])

  const title = titleOverride ?? draft?.title ?? ''

  // The preview runs the draft as the assistant produced it; the title is not part of the data.
  const run = useDashboardRun(draft ? { spec: draft } : null)
  const viewAll = options?.access.viewAll ?? access.viewAll

  const save = ({ title: name, scope: chosen }: { title: string; scope: DashboardScope }) => {
    if (!draft || saving) return
    setSaving(true)
    setSaveError(null)
    saveDashboard({
      ...(record ? { id: record.id, expectedVersion: record.version } : {}),
      spec: { ...draft, title: name, scope: chosen },
      sharedWith: sharedWithOf(chosen),
    }).then(
      (saved) => navigate(`${DASHBOARD_HOME}/d/${saved.id}`),
      (e: unknown) => {
        setSaveError(e instanceof Error ? e.message : 'Could not save the dashboard.')
        setSaving(false)
      },
    )
  }

  return (
    <TmsPage
      title={record ? 'Edit dashboard' : 'New dashboard'}
      actions={
        <>
          <TmsButton onClick={() => navigate(DASHBOARD_HOME)}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            disabled={!draft || !scope}
            onClick={() => {
              setSaveError(null)
              setSaveOpen(true)
            }}
            data-testid="dash-save"
          >
            Save
          </TmsButton>
        </>
      }
    >
      {viewAll ? null : (
        <TmsAlert tone="orange" title="You only see your own customers' data" className="dbb-d1" >
          <span data-testid="dash-d1-banner">{D1_NOTICE}</span>
        </TmsAlert>
      )}
      <div className="dbb-split">
        <ChatPanel chat={chat} options={options} access={access} />
        <section className="dbb-preview" aria-label="Preview" data-testid="dash-preview">
          <div className="dbb-preview-head">
            {record ? null : <TmsBadge tone="orange">Draft — not saved</TmsBadge>}
            {draft ? (
              <TmsField label="Title" className="dbb-title-field">
                <TmsInput
                  value={title}
                  maxLength={SPEC_LIMITS.maxTitle}
                  onChange={(e) => setTitleOverride(e.target.value)}
                />
              </TmsField>
            ) : null}
          </div>
          {run.error ? <TmsAlert tone="red">{run.error}</TmsAlert> : null}
          {draft ? (
            <>
              {run.result && !run.result.visibility.viewAll ? (
                <div className="dbb-muted" data-testid="dash-preview-visibility">
                  Showing only the customers you own or your team covers.
                </div>
              ) : null}
              <WidgetGrid spec={draft} results={run.result?.results ?? null} loading={run.loading} onRetry={run.reload} />
            </>
          ) : (
            <div className="dbb-empty">
              Your dashboard appears here once the assistant knows who it is for and what to show.
            </div>
          )}
        </section>
      </div>
      {draft && scope ? (
        <SaveDashboardDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          title={title}
          scope={scope}
          options={options}
          access={access}
          saving={saving}
          error={saveError}
          onSave={save}
        />
      ) : null}
    </TmsPage>
  )
}

export default DashboardBuilderPage
