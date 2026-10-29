/**
 * The check-call worklist: every shipment with a reminder on the clock, grouped by how
 * late it is, plus the open exceptions nobody has closed out.
 *
 * It is the same data the sidebar badge counts and the notifier Lambda sweeps — one
 * `checkCallState` for all three — so a shipment that is overdue here is overdue in
 * Slack. Logging a call from this page is the same dialog and the same CAS token as the
 * one on the shipment's Tracking tab; there is no second write path.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Clock, ExternalLink, PhoneCall } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsListPage } from '@/features/tms/kit'
import type { ColumnDef, TmsTabGroup } from '@/features/tms/kit'
import { getTmsSettings, logCheckCall, resolveIncident, setNextCheckCall, textDriver } from '@/lib/apiClient'
import { CHECK_CALL_TYPE_LABELS, INCIDENT_TYPE_LABELS } from '@/lib/checkCalls'
import { LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { formatDateTime } from '@/lib/date'
import { useCheckCallWorklist, type CheckCallWorklistRow } from '@/hooks/useCheckCallWorklist'
import { useOpenIncidents } from '@/hooks/useOpenIncidents'
import { LogCheckCallDialog } from '@/features/shipments/components/LogCheckCallDialog'
import type { ChargeCodeDef, LoadCheckCallRecord, TmsSettings } from '@/types/tms'

const HOUR_MS = 3_600_000

type TabKey = 'overdue' | 'due' | 'scheduled' | 'exceptions'

export function CheckCallsPage() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [tab, setTab] = useState<TabKey>('overdue')
  const [logging, setLogging] = useState<CheckCallWorklistRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [pageSize, setPageSize] = useState(50)

  useEffect(() => {
    let live = true
    getTmsSettings().catch(() => null).then((s) => { if (live) setSettings(s) })
    return () => { live = false }
  }, [])

  const worklist = useCheckCallWorklist({ graceMinutes: settings?.checkCallGraceMinutes })
  const incidents = useOpenIncidents()

  const byState = useMemo(() => ({
    overdue: worklist.rows.filter((r) => r.state === 'OVERDUE'),
    due: worklist.rows.filter((r) => r.state === 'DUE'),
    scheduled: worklist.rows.filter((r) => r.state === 'SCHEDULED'),
  }), [worklist.rows])

  const quickTabs: TmsTabGroup = {
    tabs: [
      { key: 'overdue', label: 'Overdue', count: byState.overdue.length },
      { key: 'due', label: 'Due', count: byState.due.length },
      { key: 'scheduled', label: 'Scheduled', count: byState.scheduled.length },
      { key: 'exceptions', label: 'Exceptions', count: incidents.incidents.length },
    ],
    active: tab,
    onSelect: (key) => setTab(key as TabKey),
  }

  const catalog = (settings?.chargeCodes ?? []) as ChargeCodeDef[]
  const refreshAll = () => { void worklist.refresh(); void incidents.refresh() }
  const error = worklist.error ?? incidents.error

  const snooze = async (row: CheckCallWorklistRow) => {
    setBusy(true)
    try {
      await setNextCheckCall({
        loadId: row.load.id,
        expectedUpdatedAt: row.load.updatedAt,
        nextCheckCallAt: new Date(worklist.nowMs + HOUR_MS).toISOString(),
      })
      await worklist.refresh()
      toast.success('Snoozed an hour')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not snooze that check call')
    } finally { setBusy(false) }
  }

  const resolve = async (checkCallId: string) => {
    setBusy(true)
    try {
      await resolveIncident({ checkCallId })
      await incidents.refresh()
      toast.success('Exception resolved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not resolve that exception')
    } finally { setBusy(false) }
  }

  const q = query.trim().toLowerCase()

  const worklistRows = useMemo(() => {
    const rows = tab === 'exceptions' ? [] : byState[tab]
    if (!q) return rows
    return rows.filter((r) => [
      r.load.loadNumber, r.load.aljexId, r.load.customer, r.load.originCity, r.load.destinationCity,
      r.carrier?.carrierName ?? r.load.carrierName, r.load.carrierRepId,
    ].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [tab, byState, q])

  const exceptionRows = useMemo(() => {
    if (!q) return incidents.incidents
    return incidents.incidents.filter((row) => [row.note, row.createdBy].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [incidents.incidents, q])

  const worklistColumns: Array<ColumnDef<CheckCallWorklistRow>> = [
    { key: 'shipment', header: 'SHIPMENT', width: 150, render: (row) => <span style={{ fontWeight: 600 }}>{row.load.loadNumber ?? row.load.aljexId}</span> },
    { key: 'customer', header: 'CUSTOMER', width: 180, render: (row) => row.load.customer ?? '—' },
    {
      key: 'lane',
      header: 'LANE',
      width: 220,
      render: (row) => [row.load.originCity, row.load.destinationCity].filter(Boolean).join(' → ') || '—',
    },
    {
      key: 'status',
      header: 'STATUS',
      width: 130,
      render: (row) => (row.load.status
        ? <TmsBadge tone="blue">{LOAD_WORKFLOW_STATUS_LABELS[row.load.status]}</TmsBadge>
        : '—'),
    },
    {
      key: 'carrier',
      header: 'CARRIER · DRIVER',
      width: 220,
      render: (row) => (
        <span>
          {row.carrier?.carrierName ?? row.load.carrierName ?? '—'}
          {row.carrier?.driverPhone && (
            <>
              {' · '}
              <a href={`tel:${row.carrier.driverPhone}`}>{row.carrier.driverPhone}</a>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'due',
      header: 'DUE',
      width: 180,
      render: (row) => (
        <span style={{ color: row.state === 'OVERDUE' ? 'var(--tms-badge-red)' : row.state === 'DUE' ? 'var(--tms-badge-orange)' : undefined }}>
          <Clock size={12} style={{ marginRight: 4, display: 'inline' }} />{formatDateTime(row.load.nextCheckCallAt)}
        </span>
      ),
    },
    { key: 'rep', header: 'REP', width: 170, render: (row) => <span className="tms-muted">{row.load.carrierRepId ?? '—'}</span> },
    {
      key: 'actions',
      header: '',
      width: 280,
      render: (row) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => setLogging(row)}>
            <PhoneCall size={13} />Log check call
          </TmsButton>
          <TmsButton size="sm" disabled={busy} onClick={() => { void snooze(row) }}>Snooze</TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label="Open shipment" onClick={() => navigate(`/tms/shipments/${row.load.shipmentId}`)}>
            <ExternalLink size={13} />
          </TmsButton>
        </div>
      ),
    },
  ]

  const exceptionColumns: Array<ColumnDef<LoadCheckCallRecord>> = [
    { key: 'raised', header: 'RAISED', width: 180, render: (row) => formatDateTime(row.at) },
    {
      key: 'exception',
      header: 'EXCEPTION',
      width: 160,
      render: (row) => (
        <TmsBadge tone="orange">
          {row.incidentType ? INCIDENT_TYPE_LABELS[row.incidentType] : CHECK_CALL_TYPE_LABELS[row.type]}
        </TmsBadge>
      ),
    },
    { key: 'note', header: 'NOTE', width: 320, render: (row) => row.note ?? '—' },
    { key: 'by', header: 'LOGGED BY', width: 200, render: (row) => <span className="tms-muted">{row.createdBy}</span> },
    {
      key: 'actions',
      header: '',
      width: 180,
      render: (row) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          <TmsButton size="sm" disabled={busy} onClick={() => { void resolve(row.id) }}>
            <AlertTriangle size={13} />Resolve
          </TmsButton>
          <TmsButton variant="ghost" size="sm" aria-label="Open shipment" onClick={() => navigate(`/tms/shipments/${row.shipmentId}`)}>
            <ExternalLink size={13} />
          </TmsButton>
        </div>
      ),
    },
  ]

  return (
    <>
      {tab === 'exceptions' ? (
        <TmsListPage<LoadCheckCallRecord>
          title="Check calls"
          search={{ value: query, onChange: setQuery, placeholder: 'Search exceptions' }}
          onRefresh={refreshAll}
          quickTabs={quickTabs}
          columns={exceptionColumns}
          rows={exceptionRows.slice(0, pageSize)}
          rowKey={(row) => row.id}
          page={{ from: exceptionRows.length === 0 ? 0 : 1, to: Math.min(exceptionRows.length, pageSize), total: exceptionRows.length, pageSize, onPageSize: setPageSize }}
          emptyText={error ?? (incidents.loading ? 'Loading exceptions…' : 'Nothing is open.')}
          onClearFilters={() => setQuery('')}
        />
      ) : (
        <TmsListPage<CheckCallWorklistRow>
          title="Check calls"
          search={{ value: query, onChange: setQuery, placeholder: 'Search shipments, carriers, reps' }}
          onRefresh={refreshAll}
          quickTabs={quickTabs}
          columns={worklistColumns}
          rows={worklistRows.slice(0, pageSize)}
          rowKey={(row) => row.load.id}
          page={{ from: worklistRows.length === 0 ? 0 : 1, to: Math.min(worklistRows.length, pageSize), total: worklistRows.length, pageSize, onPageSize: setPageSize }}
          emptyText={error ?? (worklist.loading ? 'Loading the worklist…' : 'Nothing in this view.')}
          onClearFilters={() => setQuery('')}
        />
      )}

      {logging && (
        <LogCheckCallDialog
          load={logging.load}
          loadCarrier={logging.carrier}
          catalog={catalog}
          busy={busy}
          onClose={() => { setLogging(null); void worklist.refresh() }}
          onSubmit={async (values) => {
            setBusy(true)
            try {
              await logCheckCall({
                loadId: logging.load.id,
                expectedUpdatedAt: logging.load.updatedAt,
                ...values,
              })
              await worklist.refresh()
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Could not log that check call')
              throw err
            } finally { setBusy(false) }
          }}
          onTextDriver={async (body) => {
            if (!logging.carrier) return
            await textDriver({ loadCarrierId: logging.carrier.id, body })
          }}
        />
      )}
    </>
  )
}

export default CheckCallsPage
