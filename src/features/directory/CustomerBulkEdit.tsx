/**
 * Bulk edit for the customer list (Ryne 2026-11-10): tick rows, pick what to set, apply. Each customer goes through the same
 * UPSERT_CUSTOMER a single edit uses (validated and audited one by one), so a customer the server refuses (a MANUAL customer with no
 * AP e-mail, say) comes back by name while the rest still change.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { CustomerRecord, Division, UserProfileRecord } from '@/types/tms'

type Patch = Partial<Pick<CustomerRecord, 'billingMethod' | 'paymentTermsDays' | 'defaultDivisionKey' | 'defaultSalesRepId'>>

export function CustomerBulkEdit({ customers, divisions, staff, save, onDone, onClear }: {
  customers: readonly CustomerRecord[]
  divisions: readonly Division[]
  staff: readonly UserProfileRecord[]
  save: (current: CustomerRecord, patch: Patch) => Promise<unknown>
  onDone: () => void
  onClear: () => void
}) {
  const [method, setMethod] = useState('')
  const [terms, setTerms] = useState('')
  const [division, setDivision] = useState('')
  const [rep, setRep] = useState('')
  const [busy, setBusy] = useState(false)
  if (customers.length === 0) return null

  const patch: Patch = {
    ...(method === 'FACTOR' || method === 'MANUAL' ? { billingMethod: method } : {}),
    ...(terms.trim() !== '' && Number.isInteger(Number(terms)) && Number(terms) >= 0 ? { paymentTermsDays: Number(terms) } : {}),
    ...(division ? { defaultDivisionKey: division } : {}),
    ...(rep ? { defaultSalesRepId: rep } : {}),
  }
  const changes = Object.keys(patch).length

  const apply = async () => {
    setBusy(true)
    const failed: string[] = []
    for (const c of customers) {
      try { await save(c, patch) } catch (e) { failed.push(`${c.name} (${e instanceof Error ? e.message : 'refused'})`) }
    }
    setBusy(false)
    if (failed.length === 0) toast.success(`${customers.length} customer${customers.length === 1 ? '' : 's'} updated`)
    else toast.error(`${customers.length - failed.length} updated, ${failed.length} refused: ${failed.slice(0, 3).join('; ')}`)
    setMethod(''); setTerms(''); setDivision(''); setRep('')
    onDone()
  }

  return (
    <div className="tms-dense-bar flex flex-wrap items-center gap-2" data-testid="customer-bulk-edit">
      <strong>{customers.length} selected</strong>
      <TmsSelect aria-label="Bulk billing method" value={method} onChange={(e) => setMethod(e.target.value)}>
        <option value="">Billing method…</option>
        <option value="FACTOR">Factor</option>
        <option value="MANUAL">Manual invoice</option>
      </TmsSelect>
      <TmsInput aria-label="Bulk payment terms (days)" type="number" min={0} placeholder="Net days" value={terms} onChange={(e) => setTerms(e.target.value)} style={{ width: 100 }} />
      <TmsSelect aria-label="Bulk default division" value={division} onChange={(e) => setDivision(e.target.value)}>
        <option value="">Default division…</option>
        {divisions.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
      </TmsSelect>
      <TmsSelect aria-label="Bulk default sales rep" value={rep} onChange={(e) => setRep(e.target.value)}>
        <option value="">Default sales rep…</option>
        {staff.map((p) => <option key={p.id} value={p.id}>{p.name ?? p.email}</option>)}
      </TmsSelect>
      <TmsButton variant="primary" size="sm" disabled={busy || changes === 0} data-testid="customer-bulk-apply" onClick={() => void apply()}>
        {busy ? 'Applying…' : `Apply to ${customers.length}`}
      </TmsButton>
      <TmsButton variant="ghost" size="sm" disabled={busy} onClick={onClear}>Clear</TmsButton>
    </div>
  )
}
