/**
 * Load Review batch edit (Ryne 2026-11-09): tick any rows, then set their sales rep or revenue division in one go. Every row goes through the
 * same server action a single edit does (the BATCH_SHIPMENT_TASK rows), so each is authorized and audited on its own and a row the server
 * refuses comes back with its own message while the rest still apply.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsSelect } from '@/features/tms/kit'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { useStaff } from '@/hooks/useStaff'
import { batchShipmentTask } from '@/lib/apiClient'

export function ReviewBatchEdit({ ids, email, onDone }: { ids: string[]; email: string; onDone: () => void }) {
  const { staff } = useStaff(email)
  const { divisions } = useOwnershipDivisions()
  const [rep, setRep] = useState('')
  const [division, setDivision] = useState('')
  const [busy, setBusy] = useState(false)
  if (ids.length === 0) return null

  const run = (task: 'SET_SALES_REP' | 'SET_REV_DIVISION', params: Record<string, unknown>, what: string) => {
    setBusy(true)
    batchShipmentTask({ task, shipmentIds: ids, params })
      .then((result) => {
        const failed = result.results.filter((r) => !r.ok)
        if (failed.length === 0) toast.success(`${what} set on ${ids.length} shipment${ids.length === 1 ? '' : 's'}`)
        else toast.error(`${ids.length - failed.length} updated, ${failed.length} refused: ${failed.slice(0, 3).map((r) => `${r.number ?? r.shipmentId} (${r.message ?? 'refused'})`).join('; ')}`)
        onDone()
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'The batch update failed'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="aa-review-actions flex flex-wrap items-center gap-2" data-testid="review-batch-edit">
      <strong>{ids.length} selected</strong>
      <TmsSelect aria-label="Batch sales rep" value={rep} onChange={(e) => setRep(e.target.value)}>
        <option value="">Sales rep…</option>
        {staff.map((p) => <option key={p.id} value={p.id}>{p.name ?? p.email}</option>)}
      </TmsSelect>
      <TmsButton disabled={busy || !rep} data-testid="review-batch-rep" onClick={() => run('SET_SALES_REP', { repId: rep }, 'Sales rep')}>Set sales rep</TmsButton>
      <TmsSelect aria-label="Batch revenue division" value={division} onChange={(e) => setDivision(e.target.value)}>
        <option value="">Revenue division…</option>
        {(divisions ?? []).filter((d) => d.active && !d.parentId).map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}
      </TmsSelect>
      <TmsButton disabled={busy || !division} data-testid="review-batch-division" onClick={() => run('SET_REV_DIVISION', { divisionCode: division }, 'Revenue division')}>Set division</TmsButton>
    </div>
  )
}
