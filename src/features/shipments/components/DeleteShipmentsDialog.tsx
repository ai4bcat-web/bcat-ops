/**
 * Delete — the owner's hard delete, for freight that should never have been on the books
 * (other staff void when the org permits). It opens on a server-side preview (`dryRun`) that lists the billing
 * each shipment carries row for row, because a delete that takes an invoice with it must be
 * read, not guessed. Billing is refused unless the separate Force box is ticked AND FORCE is
 * typed, on top of the typed DELETE. After a delete the export prefix is shown and the
 * whole thing can be put back with Restore. The Lambda re-checks the owner from the token;
 * this dialog is the explanation and the confirmation, never the permission.
 */
import { useEffect, useState } from 'react'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import {
  deleteShipments, graphqlErrorText, latestDeleteExport, restoreDeletedShipments,
  type DeleteBillingSummary, type DeleteShipmentResult, type DeleteShipmentsResponse,
  type RestoreDeletedShipmentsResponse,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/tmsDirectory'

/** The Lambda refuses a bigger batch; the dialog says so up front. */
export const MAX_DELETE_SELECTION = 10

export interface DeleteTarget { id: string; number: string }

const money = (cents: number | null) => (cents == null ? '—' : formatCents(cents))

/** One line per billing row, exactly what the server found. */
function billingLines(b: DeleteBillingSummary): string[] {
  return [
    ...b.invoices.map((i) => `Invoice ${i.number ?? i.id} [${i.id}] · ${i.status ?? 'no status'} · total ${money(i.totalCents)} · balance ${money(i.balanceCents)}`),
    ...b.carrierBills.map((c) => `Carrier bill ${c.billNumber ?? c.id} [${c.id}] · ${c.status ?? 'no status'} · net ${money(c.netCents)} · paid ${money(c.paidCents)}`),
    ...b.commissions.map((c) => `Commission ${c.repName ?? c.id} [${c.id}] · ${c.status ?? 'no status'} · net ${money(c.netCents)}`),
    ...b.factoringItems.map((f) => `Factoring item ${f.proNumber ?? f.id} [${f.id}] · ${f.status ?? 'no status'}`),
    ...b.payments.map((p) => `${p.model === 'ArPayment' ? 'Customer' : 'Carrier'} payment ${p.id} · ${p.kind ?? 'payment'} · ${money(p.amountCents)} (removed with a force delete if only this shipment's billing uses it)`),
    ...b.markers.map((m) => `Marker: ${m}`),
  ]
}

const countsText = (counts: Record<string, number>) => {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([model, n]) => `${n} ${model}`)
  return parts.length ? parts.join(', ') : 'no rows'
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'preview'; response: DeleteShipmentsResponse }
  | { kind: 'done'; response: DeleteShipmentsResponse }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown'; startedAt: number; exportPrefix: string | null }
export function DeleteShipmentsDialog({ shipments, onClose, onDeleted }: {
  shipments: DeleteTarget[]
  onClose: () => void
  /** Called when the dialog closes after rows were deleted; `restored` says they were put back. */
  onDeleted: (outcome: { restored: boolean }) => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [force, setForce] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [forceConfirm, setForceConfirm] = useState('')
  const [hasBilled, setHasBilled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restored, setRestored] = useState<RestoreDeletedShipmentsResponse | null>(null)

  const [ids] = useState(() => shipments.map((s) => s.id))
  const tooMany = ids.length > MAX_DELETE_SELECTION

  // The preview is asked again when Force is toggled, so what is shown is what the server
  // would do: a payment shared with other shipments refuses even a forced delete.
  useEffect(() => {
    if (tooMany) return undefined
    let live = true
    deleteShipments({ shipmentIds: ids, dryRun: true, force, confirm: 'DELETE' })
      .then((response) => {
        if (!live) return
        if (response.results.some((r) => r.outcome === 'REFUSED_BILLING' || (r.billing && billingLines(r.billing).length > 0))) setHasBilled(true)
        setPhase({ kind: 'preview', response })
      })
      .catch((err: unknown) => { if (live) setPhase({ kind: 'failed', message: graphqlErrorText(err) || (err instanceof Error ? err.message : 'Preview failed') }) })
    return () => { live = false }
  }, [force, ids, tooMany])

  const results: DeleteShipmentResult[] = phase.kind === 'preview' || phase.kind === 'done' ? phase.response.results : []
  const deletable = results.filter((r) => r.outcome === 'PREVIEW')
  const typedOk = confirm === 'DELETE' && (!force || forceConfirm === 'FORCE')
  const canDelete = phase.kind === 'preview' && !busy && deletable.length > 0 && typedOk

  const recover = async (startedAt: number) => {
    setBusy(true)
    try {
      const found = await latestDeleteExport()
      const current = found.createdAt != null && Date.parse(found.createdAt) >= startedAt - 5000
      setPhase({ kind: 'unknown', startedAt, exportPrefix: current ? found.exportPrefix : null })
    } catch {
      setError('Could not look up the export. Check recovery again before retrying the delete.')
    } finally { setBusy(false) }
  }

  const submit = async () => {
    if (!canDelete) return
    setBusy(true)
    setError(null)
    const startedAt = Date.now()
    try {
      const response = await deleteShipments({
        shipmentIds: ids,
        dryRun: false,
        force,
        confirm: 'DELETE',
        ...(force ? { forceConfirm: 'FORCE' as const } : {}),
      })
      setPhase({ kind: 'done', response })
    } catch (err) {
      setPhase({ kind: 'unknown', startedAt, exportPrefix: null })
      setError(`Delete outcome unknown: ${graphqlErrorText(err) || (err instanceof Error ? err.message : 'request interrupted')}. The server may still be running; do not retry deletion.`)
      await recover(startedAt)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (exportPrefix: string) => {
    setBusy(true)
    setError(null)
    try {
      setRestored(await restoreDeletedShipments({ exportPrefix, dryRun: false }))
    } catch (err) {
      setError(graphqlErrorText(err) || (err instanceof Error ? err.message : 'Restore failed'))
    } finally {
      setBusy(false)
    }
  }

  const done = phase.kind === 'done' ? phase.response : null
  const exportPrefix = done?.exportPrefix ?? (phase.kind === 'unknown' ? phase.exportPrefix : null)
  const restoreFailed = restored ? Object.values(restored.tables).reduce((n, table) => n + table.failed, 0) : 0
  const close = () => {
    onClose()
    if (done?.exportPrefix || phase.kind === 'unknown') onDeleted({ restored: restored != null && restoreFailed === 0 })
  }
  const label = shipments.length === 1 ? `shipment ${shipments[0].number}` : `${shipments.length} shipments`

  return (
    <TmsDialog
      open
      onOpenChange={(next) => { if (!next && !busy) close() }}
      title={done ? 'Delete finished' : `Delete ${label}`}
      className="max-w-2xl"
      description={done ? undefined : (
        'Delete is permanent and not the same as void: the shipment and its rows leave the system '
        + '(its PRO is never reused). Every row is exported first and can be restored.'
      )}
      footer={done || phase.kind === 'unknown' ? (
        <>
          {phase.kind === 'unknown' && <TmsButton disabled={busy} onClick={() => { void recover(phase.startedAt) }}>Check recovery</TmsButton>}
          {exportPrefix && (!restored || restoreFailed > 0) && (
            <TmsButton variant="secondary" disabled={busy} onClick={() => { void restore(exportPrefix) }}>
              {busy ? 'Restoring…' : 'Restore deleted'}
            </TmsButton>
          )}
          <TmsButton variant="primary" onClick={close} disabled={busy}>Close</TmsButton>
        </>
      ) : (
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="destructive" disabled={!canDelete} onClick={() => { void submit() }}>
            {busy ? 'Deleting…' : `Delete ${deletable.length || ''} ${deletable.length === 1 ? 'shipment' : 'shipments'}`.replace(/\s+/g, ' ')}
          </TmsButton>
        </>
      )}
    >
      <div className="space-y-3">
        {tooMany && <TmsAlert tone="red">Delete at most {MAX_DELETE_SELECTION} shipments at a time; {ids.length} are selected.</TmsAlert>}
        {phase.kind === 'loading' && !tooMany && <p className="tms-muted text-sm">Checking what each shipment carries…</p>}
        {phase.kind === 'failed' && <TmsAlert tone="red">{phase.message}</TmsAlert>}

        {results.map((r) => {
          const b = r.billing
          const lines = b ? billingLines(b) : []
          return (
            <div key={r.shipmentId} data-testid={`delete-row-${r.shipmentId}`} className="rounded border border-[color:var(--tms-border)] p-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{r.number ?? r.shipmentId}</span>
                <TmsBadge tone={r.outcome === 'DELETED' ? 'green' : r.outcome === 'PREVIEW' ? 'gray' : 'red'}>
                  {r.outcome === 'PREVIEW' ? 'Ready to delete' : r.outcome.replace(/_/g, ' ').toLowerCase()}
                </TmsBadge>
                {r.outcome === 'PREVIEW' && force && lines.length > 0 && <TmsBadge tone="orange">will be force-deleted</TmsBadge>}
              </div>
              <div className="tms-muted">{countsText(r.counts)}</div>
              {r.message && <div data-testid={`delete-message-${r.shipmentId}`}>{r.message}</div>}
              {lines.length > 0 && (
                <ul className="mt-1 list-disc pl-5" aria-label={`Billing on ${r.number ?? r.shipmentId}`}>
                  {lines.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
            </div>
          )
        })}

        {(phase.kind === 'preview' || (phase.kind === 'loading' && !tooMany)) && (
          <>
            {hasBilled && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={force}
                  disabled={busy}
                  onChange={(e) => { setPhase({ kind: 'loading' }); setForce(e.target.checked); if (!e.target.checked) setForceConfirm('') }}
                />
                <span>
                  <strong>Force</strong> — also delete the billing listed above (invoices, carrier bills, commissions, factoring).
                  Payments used only by this shipment's billing are removed too. A payment shared with other
                  shipments refuses the delete until it is split offline, and a box-truck settlement can never be forced.
                </span>
              </label>
            )}
            <TmsField label="Type DELETE to confirm">
              <TmsInput aria-label="Type DELETE to confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </TmsField>
            {force && (
              <TmsField label="Type FORCE to delete billing">
                <TmsInput aria-label="Type FORCE to delete billing" autoComplete="off" value={forceConfirm} onChange={(e) => setForceConfirm(e.target.value)} />
              </TmsField>
            )}
          </>
        )}

        {phase.kind === 'unknown' && (
          <TmsAlert tone="orange">
            The delete did not return a result. Some rows may have been deleted. Wait at least two minutes
            after submitting before restoring, so the original server operation has stopped.
            {exportPrefix ? <p>Recovery export: <code data-testid="export-prefix">{exportPrefix}</code>.</p>
              : <p>No current export found yet. Use Check recovery; do not assume nothing was deleted.</p>}
          </TmsAlert>
        )}
        {(done || phase.kind === 'unknown') && (
          <>
            {done && <TmsAlert tone={done.failed > 0 ? 'orange' : 'green'}>
              {done.deleted} deleted{done.failed > 0 ? `, ${done.failed} not deleted` : ''}.
            </TmsAlert>}
            {done?.exportPrefix && (
              <p className="text-sm">
                Exported to <code data-testid="export-prefix">{done.exportPrefix}</code>. Restore puts these rows back.
              </p>
            )}
            {restored && (
              <TmsAlert tone={restoreFailed > 0 ? 'orange' : 'green'}>
                {restoreFailed > 0 ? 'Restore incomplete. Retry Restore deleted.' : 'Restore complete.'}
                {Object.entries(restored.tables).map(([model, counts]) => (
                  <div key={model}>{model}: {counts.restored} restored, {counts.alreadyPresent} already present, {counts.failed} failed</div>
                ))}
              </TmsAlert>
            )}
          </>
        )}
        {error && <TmsAlert tone="red">{error}</TmsAlert>}
      </div>
    </TmsDialog>
  )
}

export default DeleteShipmentsDialog
