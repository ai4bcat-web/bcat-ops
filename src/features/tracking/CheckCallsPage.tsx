/**
 * The check-call worklist: every load with a reminder on the clock, grouped by how late
 * it is, plus the open exceptions nobody has closed out.
 *
 * It is the same data the sidebar badge counts and the notifier Lambda sweeps — one
 * `checkCallState` for all three — so a load that is overdue here is overdue in Slack.
 * Logging a call from this page is the same dialog and the same CAS token as the one on
 * the shipment's Tracking tab; there is no second write path.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Clock, ExternalLink, PhoneCall, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getTmsSettings, logCheckCall, resolveIncident, setNextCheckCall, textDriver } from '@/lib/apiClient'
import { CHECK_CALL_TYPE_LABELS, INCIDENT_TYPE_LABELS } from '@/lib/checkCalls'
import { LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { formatDateTime } from '@/lib/date'
import { cn } from '@/lib/utils'
import { useCheckCallWorklist, type CheckCallWorklistRow } from '@/hooks/useCheckCallWorklist'
import { useOpenIncidents } from '@/hooks/useOpenIncidents'
import { LogCheckCallDialog } from '@/features/shipments/components/LogCheckCallDialog'
import type { ChargeCodeDef, TmsSettings } from '@/types/tms'

const HOUR_MS = 3_600_000

type TabKey = 'overdue' | 'due' | 'scheduled' | 'exceptions'

export function CheckCallsPage() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [tab, setTab] = useState<TabKey>('overdue')
  const [logging, setLogging] = useState<CheckCallWorklistRow | null>(null)
  const [busy, setBusy] = useState(false)

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

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'overdue', label: 'Overdue', count: byState.overdue.length },
    { key: 'due', label: 'Due', count: byState.due.length },
    { key: 'scheduled', label: 'Scheduled', count: byState.scheduled.length },
    { key: 'exceptions', label: 'Exceptions', count: incidents.incidents.length },
  ]

  const rows = tab === 'exceptions' ? [] : byState[tab]
  const catalog = (settings?.chargeCodes ?? []) as ChargeCodeDef[]

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <PhoneCall size={18} />
        <h1 className="text-lg font-semibold">Check calls</h1>
        <Badge variant="outline">{worklist.dueCount}</Badge>
        <Button
          variant="ghost" size="icon" className="ml-auto h-9 w-9" aria-label="Refresh"
          onClick={() => { void worklist.refresh(); void incidents.refresh() }}
        >
          <RefreshCw size={14} className={worklist.loading ? 'animate-spin' : undefined} />
        </Button>
      </header>

      <nav role="tablist" aria-label="Check call state" className="flex gap-1 overflow-x-auto border-b border-border px-5">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            {t.label}
            <Badge variant="outline" className="text-[10px]">{t.count}</Badge>
          </button>
        ))}
      </nav>

      {(worklist.error || incidents.error) && (
        <p className="px-5 py-3 text-sm text-destructive">{worklist.error ?? incidents.error}</p>
      )}

      <div className="flex-1 overflow-auto px-5 py-3">
        {tab === 'exceptions' ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-2 py-2">Raised</th>
                <th className="px-2 py-2">Exception</th>
                <th className="px-2 py-2">Note</th>
                <th className="px-2 py-2">Logged by</th>
                <th className="w-44" />
              </tr>
            </thead>
            <tbody>
              {incidents.incidents.length === 0 && !incidents.loading && (
                <tr><td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">Nothing is open.</td></tr>
              )}
              {incidents.incidents.map((row) => (
                <tr key={row.id} className="border-b border-border/60">
                  <td className="px-2 py-2">{formatDateTime(row.at)}</td>
                  <td className="px-2 py-2">
                    <Badge variant="outline" className="text-[10px]">
                      {row.incidentType ? INCIDENT_TYPE_LABELS[row.incidentType] : CHECK_CALL_TYPE_LABELS[row.type]}
                    </Badge>
                  </td>
                  <td className="max-w-md truncate px-2 py-2">{row.note ?? '—'}</td>
                  <td className="px-2 py-2 text-muted-foreground">{row.createdBy}</td>
                  <td className="px-1 py-2">
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => { void resolve(row.id) }}>
                        <AlertTriangle size={13} className="mr-1" />Resolve
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-7"
                        onClick={() => navigate(`/shipments/${row.shipmentId}`)}
                      >
                        <ExternalLink size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-2 py-2">Load</th>
                <th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2">Lane</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Carrier · driver</th>
                <th className="px-2 py-2">Due</th>
                <th className="px-2 py-2">Rep</th>
                <th className="w-60" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !worklist.loading && (
                <tr><td colSpan={8} className="py-8 text-center text-sm text-muted-foreground">Nothing in this view.</td></tr>
              )}
              {rows.map((row) => (
                <tr key={row.load.id} className="border-b border-border/60">
                  <td className="px-2 py-2 font-medium">{row.load.loadNumber ?? row.load.aljexId}</td>
                  <td className="px-2 py-2">{row.load.customer ?? '—'}</td>
                  <td className="px-2 py-2">
                    {[row.load.originCity, row.load.destinationCity].filter(Boolean).join(' → ') || '—'}
                  </td>
                  <td className="px-2 py-2">
                    <Badge variant="outline" className="text-[10px]">
                      {row.load.status ? LOAD_WORKFLOW_STATUS_LABELS[row.load.status] : '—'}
                    </Badge>
                  </td>
                  <td className="px-2 py-2">
                    <span>{row.carrier?.carrierName ?? row.load.carrierName ?? '—'}</span>
                    {row.carrier?.driverPhone && (
                      <>
                        {' · '}
                        <a href={`tel:${row.carrier.driverPhone}`} className="underline underline-offset-2">
                          {row.carrier.driverPhone}
                        </a>
                      </>
                    )}
                  </td>
                  <td className={cn('px-2 py-2', row.state === 'OVERDUE' && 'text-destructive', row.state === 'DUE' && 'text-amber-700')}>
                    <Clock size={12} className="mr-1 inline" />{formatDateTime(row.load.nextCheckCallAt)}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{row.load.carrierRepId ?? '—'}</td>
                  <td className="px-1 py-2">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" className="h-7" disabled={busy} onClick={() => setLogging(row)}>
                        <PhoneCall size={13} className="mr-1" />Log check call
                      </Button>
                      <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => { void snooze(row) }}>
                        Snooze
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-7" aria-label="Open shipment"
                        onClick={() => navigate(`/shipments/${row.load.shipmentId}`)}
                      >
                        <ExternalLink size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
    </div>
  )
}

export default CheckCallsPage
