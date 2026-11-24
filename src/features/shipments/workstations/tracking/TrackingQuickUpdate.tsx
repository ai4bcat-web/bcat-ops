/**
 * Update a load from the Tracking page: move its status, stamp the stop clock (on site at
 * pickup, departed pickup, arrived at delivery, delivered) and add the POD.
 *
 * Every save is the shipment form's own call: a time is UPDATE_STOP / SET_TIMES (an actual
 * time is a fact, saved at once, MANUAL, audited), a status is SET_LOAD_STATUS, the POD is the
 * editor's document upload. The server refuses what the form would refuse and its words are
 * shown as they come. Each call returns the shipment's bundle; the dialog keeps that one, so
 * the next save carries the load's fresh version.
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsSelect } from '@/features/tms/kit'
import { DateTime24Input } from '@/features/shipments/form/DateTime24Input'
import { setLoadStatus, updateStop } from '@/lib/apiClient'
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { LOAD_WORKFLOW_STATUS_LABELS } from '@/lib/shipmentStatus'
import { STOP_TIME_SOURCE_LABEL, stopTimesOf } from '@/lib/stopActualTimes'
import type { LoadWorkflowStatus, ShipmentBundle } from '@/types/tms'
import { TrackingPodBox } from './TrackingPodBox'
import { nowIso, quickTimeRows, statusOptions, timeProblem, type QuickTimeRow } from './quickUpdate'

export interface TrackingQuickUpdateProps {
  bundle: ShipmentBundle
  onClose: () => void
  /** Called after any save, with the new bundle, so the grid behind can re-read. */
  onChanged: (next: ShipmentBundle) => void
  /** Injected in tests; the live calls are the form's. */
  api?: { updateStop: typeof updateStop; setLoadStatus: typeof setLoadStatus }
}

export function TrackingQuickUpdate({ bundle: initial, onClose, onChanged, api = { updateStop, setLoadStatus } }: TrackingQuickUpdateProps) {
  const [bundle, setBundle] = useState(initial)
  const [loadId, setLoadId] = useState(initial.loads[0]?.id ?? '')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')

  const load = bundle.loads.find((l) => l.id === loadId) ?? bundle.loads[0] ?? null
  const rows = useMemo(() => (load ? quickTimeRows(load) : []), [load])
  const times = useMemo(() => stopTimesOf({ loads: load ? [load] : [] }), [load])
  const voided = Boolean(bundle.shipment.voidedAt)
  const options = statusOptions(load?.status ?? null, bundle.shipment.mode)

  const accept = (next: ShipmentBundle) => {
    setBundle(next)
    onChanged(next)
  }

  const saveTime = async (row: QuickTimeRow, iso: string | null) => {
    if (!load) return
    if (iso) {
      const problem = timeProblem(row, iso)
      if (problem) { setError(problem); return }
    }
    setBusy(row.key)
    setError(null)
    try {
      accept(await api.updateStop({
        loadId: load.id, expectedUpdatedAt: load.updatedAt ?? undefined, op: 'SET_TIMES', stopId: row.stopId, patch: { [row.kind]: iso },
      }))
      setDraft((d) => { const { [row.key]: _gone, ...rest } = d; return rest })
      toast.success(iso ? `${row.label} saved` : `${row.label} cleared`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that time')
    } finally {
      setBusy(null)
    }
  }

  const saveStatus = async () => {
    if (!load || !status) return
    setBusy('status')
    setError(null)
    try {
      accept(await api.setLoadStatus({ loadId: load.id, status: status as LoadWorkflowStatus }))
      setStatus('')
      toast.success(`Status is now ${LOAD_WORKFLOW_STATUS_LABELS[status as LoadWorkflowStatus]}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the status')
    } finally {
      setBusy(null)
    }
  }

  const off = busy !== null || voided

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`Update ${bundle.shipment.number}`}
      description="Times save as you press them. The server checks the order, so a load cannot skip a step."
      className="tms-quick-update"
      footer={<TmsButton variant="primary" data-testid="quick-update-done" onClick={onClose}>Done</TmsButton>}
    >
      <div className="tms-quick-update-body" data-testid="quick-update">
        {bundle.loads.length > 1 && (
          <label className="tms-quick-update-field">
            <span>Load</span>
            <TmsSelect
              aria-label="Load" value={load?.id ?? ''} onChange={(e) => { setLoadId(e.target.value); setError(null) }}
              options={bundle.loads.map((l, i) => ({ value: l.id, label: `Load ${i + 1}` }))}
            />
          </label>
        )}

        <section className="tms-quick-update-status">
          <header>
            <strong>Status</strong>
            {load?.status && <TmsBadge tone="blue" data-testid="quick-update-status-now">{LOAD_WORKFLOW_STATUS_LABELS[load.status]}</TmsBadge>}
          </header>
          {options.length === 0 ? (
            <p className="tms-muted text-sm">No further status can be set by hand.</p>
          ) : (
            <div className="tms-quick-update-row">
              <TmsSelect
                aria-label="Move load to" data-testid="quick-update-status" value={status} disabled={off}
                onChange={(e) => setStatus(e.target.value)}
                options={[{ value: '', label: 'Move load to…' }, ...options]}
              />
              <TmsButton size="sm" variant="primary" data-testid="quick-update-status-save" disabled={off || !status} onClick={() => void saveStatus()}>
                Set status
              </TmsButton>
            </div>
          )}
        </section>

        <section className="tms-quick-update-times">
          <header><strong>Stop times</strong></header>
          {rows.length === 0 && <p className="tms-muted text-sm">This load has no stops yet.</p>}
          {rows.map((row) => {
            const saved = row.value ? formatDateTimeInput(row.value) : ''
            const shown = draft[row.key] ?? saved
            const dirty = draft[row.key] !== undefined && draft[row.key] !== saved
            const source = times.find((t) => t.stopId === row.stopId)?.[row.kind === 'arrivedAt' ? 'arrivedSource' : 'departedSource']
            const id = `quick-${row.key.replace(':', '-')}`
            return (
              <div className="tms-quick-update-row" key={row.key} data-testid={`quick-row-${row.kind === 'arrivedAt' ? 'arrived' : 'departed'}-${row.stopId}`}>
                <label className="tms-quick-update-label" htmlFor={id}>
                  <span>{row.label}</span>
                  <span className="tms-muted text-xs">{row.where}{source ? ` · ${STOP_TIME_SOURCE_LABEL[source]}` : ''}</span>
                </label>
                <DateTime24Input
                  inputProps={{ id, 'data-testid': id, 'aria-label': `${row.label} date` }}
                  value={shown} disabled={off}
                  onChange={(v) => setDraft((d) => ({ ...d, [row.key]: v }))}
                />
                <TmsButton size="sm" data-testid={`${id}-now`} disabled={off} onClick={() => void saveTime(row, nowIso())}>Now</TmsButton>
                {dirty && (
                  <TmsButton size="sm" variant="primary" data-testid={`${id}-save`} disabled={off || !shown} onClick={() => void saveTime(row, fromDateTimeInput(shown))}>
                    Save
                  </TmsButton>
                )}
                {saved && !dirty && (
                  <TmsButton size="sm" variant="ghost" data-testid={`${id}-clear`} disabled={off} aria-label={`Clear ${row.label.toLowerCase()}`} onClick={() => void saveTime(row, null)}>
                    Clear
                  </TmsButton>
                )}
              </div>
            )
          })}
        </section>

        <TrackingPodBox bundle={bundle} onUploaded={accept} />

        {voided && <p className="tms-muted text-sm" role="status">This shipment is voided, so nothing can be updated.</p>}
        {error && <p className="tms-quick-update-error" role="alert" data-testid="quick-update-error">{error}</p>}
      </div>
    </TmsDialog>
  )
}
