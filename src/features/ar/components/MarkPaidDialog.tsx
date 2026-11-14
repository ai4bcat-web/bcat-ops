/**
 * Mark paid — one invoice or a batch. The top row is the defaults (paid date, ACH or paper
 * check, check/ref #); every invoice row has its own copy of those plus the amount paid, which
 * starts at the open balance. Less than the balance is a partial payment.
 *
 * Rows sharing customer + date + method + reference post as one payment (`markPaid.ts`), each
 * through `RECORD_PAYMENT` with a client request id fixed for the life of the dialog, so a
 * retry after a timeout never pays anything twice. A posting that fails leaves its rows in the
 * dialog with the error; the ones that went through are removed.
 */
import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { DateUsInput } from '@/features/shipments/form/DateUsInput'
import { graphqlErrorText, recordPayment } from '@/lib/apiClient'
import { chicagoDateStr } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import type { InvoiceRecord } from '@/types/tms'
import {
  MARK_PAID_METHOD_LABEL, applyDefaults, editRow, initialRows, planPostings, rowCents, rowProblem,
  type MarkPaidDefaults, type MarkPaidMethod, type MarkPaidRow,
} from '../markPaid'

const METHODS: MarkPaidMethod[] = ['ACH', 'CHECK']

export function MarkPaidDialog({ invoices, onClose, onDone }: {
  invoices: InvoiceRecord[]
  onClose: () => void
  /** Called once something was posted (the page refreshes). */
  onDone: () => void
}) {
  const today = chicagoDateStr(new Date())
  const [requestPrefix] = useState(() => crypto.randomUUID())
  const [defaults, setDefaultsState] = useState<MarkPaidDefaults>({ paidOn: today, method: 'CHECK', reference: '' })
  const [rows, setRows] = useState<MarkPaidRow[]>(() => initialRows(invoices, { paidOn: today, method: 'CHECK', reference: '' }))
  const [posting, setPosting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const byId = useMemo(() => new Map(invoices.map((inv) => [inv.id, inv])), [invoices])

  const setDefaults = (patch: Partial<MarkPaidDefaults>) => {
    const next = { ...defaults, ...patch }
    setDefaultsState(next)
    setRows((prev) => applyDefaults(prev, next))
  }
  const edit = (invoiceId: string, patch: Parameters<typeof editRow>[2]) => {
    setErrors((prev) => { const { [invoiceId]: _gone, ...rest } = prev; return rest })
    setRows((prev) => editRow(prev, invoiceId, patch))
  }

  const problems = rows.map((row) => rowProblem(row, byId.get(row.invoiceId), today))
  const totalCents = rows.reduce((sum, row) => sum + rowCents(row), 0)
  const partials = rows.filter((row) => {
    const inv = byId.get(row.invoiceId)
    return inv && rowCents(row) > 0 && rowCents(row) < inv.balanceCents
  }).length
  const customers = new Set(rows.map((row) => byId.get(row.invoiceId)?.customerName ?? '')).size
  const blocked = rows.length === 0 || problems.some((p) => p != null)

  const post = async () => {
    setPosting(true)
    const failed: Record<string, string> = {}
    const done = new Set<string>()
    for (const p of planPostings(rows, byId)) {
      try {
        await recordPayment({
          customerId: p.customerId,
          receivedAt: p.receivedAt,
          method: p.method,
          ...(p.reference ? { reference: p.reference } : {}),
          amountCents: p.amountCents,
          applications: p.applications,
          creditApplications: [],
          note: 'Marked paid from Invoicing',
          clientRequestId: `${requestPrefix}:${p.key}`.slice(0, 64),
        })
        p.invoiceIds.forEach((id) => done.add(id))
      } catch (err) {
        const text = graphqlErrorText(err) || 'Could not record the payment'
        p.invoiceIds.forEach((id) => { failed[id] = text })
      }
    }
    setPosting(false)
    if (done.size > 0) {
      toast.success(`Recorded payment on ${done.size} invoice${done.size === 1 ? '' : 's'}`)
      onDone()
    }
    if (Object.keys(failed).length === 0) { onClose(); return }
    setErrors(failed)
    setRows((prev) => prev.filter((row) => !done.has(row.invoiceId)))
  }

  const single = invoices.length === 1
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !posting) onClose() }}
      title={single ? `Mark invoice ${invoices[0].number} paid` : `Mark ${invoices.length} invoices paid`}
      description="Each row can have its own date, method, check # and amount. Less than the open balance records a partial payment; the invoice stays open for the rest."
      className="tms-dialog-xl"
      footer={(
        <>
          <span className="text-sm tms-muted" data-testid="mark-paid-summary">
            {rows.length} invoice{rows.length === 1 ? '' : 's'}{customers > 1 ? ` · ${customers} customers` : ''} · <strong>{formatCents(totalCents)}</strong>
            {partials > 0 ? ` · ${partials} partial` : ''}
          </span>
          <TmsButton variant="ghost" disabled={posting} onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="mark-paid-confirm" disabled={posting || blocked} onClick={() => { void post() }}>
            {posting && <Loader2 size={14} className="animate-spin" />} Mark paid · {formatCents(totalCents)}
          </TmsButton>
        </>
      )}
    >
      {!single && (
        <div className="flex flex-wrap items-end gap-3" data-testid="mark-paid-defaults">
          <TmsField label="Paid date (all rows)">
            <DateUsInput value={defaults.paidOn} onChange={(v) => setDefaults({ paidOn: v })} inputProps={{ 'aria-label': 'Default paid date', 'data-testid': 'mark-paid-default-date' }} />
          </TmsField>
          <TmsField label="Method (all rows)">
            <TmsSelect aria-label="Default method" value={defaults.method} onChange={(e) => setDefaults({ method: e.target.value as MarkPaidMethod })}>
              {METHODS.map((m) => <option key={m} value={m}>{MARK_PAID_METHOD_LABEL[m]}</option>)}
            </TmsSelect>
          </TmsField>
          <TmsField label="Check / ref # (all rows)">
            <TmsInput aria-label="Default check or reference number" data-testid="mark-paid-default-ref" value={defaults.reference} onChange={(e) => setDefaults({ reference: e.target.value })} />
          </TmsField>
        </div>
      )}
      <div className="tms-table-wrap">
        <table className="tms-table tms-table-stack" data-testid="mark-paid-rows">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th style={{ textAlign: 'right' }}>Open</th>
              <th>Paid date</th>
              <th>Method</th>
              <th>Check / ref #</th>
              <th style={{ textAlign: 'right' }}>Amount paid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const inv = byId.get(row.invoiceId)
              const problem = errors[row.invoiceId] ?? problems[i]
              const cents = rowCents(row)
              const partial = inv && cents > 0 && cents < inv.balanceCents
              return (
                <tr key={row.invoiceId} data-testid={`mark-paid-row-${inv?.number ?? row.invoiceId}`}>
                  <td data-label="Invoice">{inv?.number ?? row.invoiceId}</td>
                  <td data-label="Customer">{inv?.customerName ?? '—'}</td>
                  <td data-label="Open" style={{ textAlign: 'right' }}>{inv ? formatCents(inv.balanceCents) : '—'}</td>
                  <td data-label="Paid date" style={{ minWidth: 150 }}>
                    <DateUsInput value={row.paidOn} onChange={(v) => edit(row.invoiceId, { paidOn: v })} inputProps={{ 'aria-label': `Paid date for ${inv?.number ?? ''}` }} />
                  </td>
                  <td data-label="Method">
                    <TmsSelect aria-label={`Method for ${inv?.number ?? ''}`} value={row.method} onChange={(e) => edit(row.invoiceId, { method: e.target.value as MarkPaidMethod })}>
                      {METHODS.map((m) => <option key={m} value={m}>{MARK_PAID_METHOD_LABEL[m]}</option>)}
                    </TmsSelect>
                  </td>
                  <td data-label="Check / ref #">
                    <TmsInput aria-label={`Check or reference number for ${inv?.number ?? ''}`} value={row.reference}
                      placeholder={row.method === 'CHECK' ? 'Check # (required)' : 'Optional'}
                      onChange={(e) => edit(row.invoiceId, { reference: e.target.value })} />
                  </td>
                  <td data-label="Amount paid" style={{ textAlign: 'right', minWidth: 130 }}>
                    <TmsInput aria-label={`Amount paid for ${inv?.number ?? ''}`} inputMode="decimal" value={row.amount}
                      style={{ textAlign: 'right' }} onChange={(e) => edit(row.invoiceId, { amount: e.target.value })} />
                    {partial && <div className="text-xs tms-muted">Partial · {formatCents((inv?.balanceCents ?? 0) - cents)} stays open</div>}
                    {problem && <div className="text-xs" role="alert" style={{ color: 'var(--tms-badge-red)' }}>{problem}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </TmsDialog>
  )
}
