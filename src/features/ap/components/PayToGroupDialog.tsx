/**
 * Paying several carriers that share one pay-to in one go: the Selected tab's Pay selected when the ticked bills
 * belong to different carriers but are paid to the same payee (a factor, or a payee that carries more than one
 * carrier). Each bill is paid in full. The server posts one payment per carrier (a payment is one carrier's) and
 * sends ONE remittance e-mail to the pay-to listing every bill; it refuses a selection whose pay-to differs.
 *
 * Partial amounts and credits live in the one-carrier dialog (`PayCarrierDialog`).
 *
 * `clientRequestId` is generated once per mount: a Post that times out can be pressed again without paying twice.
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { graphqlErrorText, recordApPaymentGroup } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDateInput } from '@/lib/date'
import { withLegSuffix, type LegIndex } from '../apViews'
import type { ApPaymentMethod, CarrierBillRecord } from '@/types/tms'

const PAID_OUTSIDE_HINT = "Check 'Already paid outside the app' to record a payment you made elsewhere."
const METHODS: ApPaymentMethod[] = ['ACH', 'CHECK', 'WIRE', 'ZELLE', 'CARD', 'VENMO', 'EFT', 'OTHER']
const METHOD_LABEL: Record<ApPaymentMethod, string> = { ACH: 'ACH', CHECK: 'Paper check', WIRE: 'Wire', ZELLE: 'Zelle', VENMO: 'Venmo', EFT: 'EFT', CARD: 'Credit card (Amex)', OTHER: 'Other' }

/** The PRO the payee will match the money against: the base shipment number, no leg suffix. */
function proOf(bill: CarrierBillRecord): string {
  return bill.shipmentNumber?.trim() || bill.loadNumber?.trim() || bill.billNumber?.trim() || bill.id
}

export function PayToGroupDialog({ payTo, bills, legs, payBlocks, remitEmail, open, onOpenChange, onDone }: {
  /** The one payee every bill is paid to. */
  payTo: string
  bills: CarrierBillRecord[]
  legs?: LegIndex
  /** Bill id to the sentence that says why its payee cannot be paid yet; any entry blocks Post. */
  payBlocks?: Record<string, string>
  /** The address the single remittance goes to, when the board knows it. Display only. */
  remitEmail?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [clientRequestId] = useState(() => crypto.randomUUID())
  const [paidAt, setPaidAt] = useState(() => formatDateInput(new Date().toISOString()))
  const [method, setMethod] = useState<ApPaymentMethod>(() => bills[0]?.remitTo?.method ?? 'ACH')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [alreadyPaid, setAlreadyPaid] = useState(false)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => withLegSuffix(bills, legs), [bills, legs])
  const totalCents = rows.reduce((sum, row) => sum + row.balanceCents, 0)
  const carriers = new Set(rows.map((row) => row.carrierId)).size
  const missing = [...new Set(rows.map((row) => payBlocks?.[row.id]).filter((m): m is string => !!m))]
  // Already paid outside the app: the app moves no money, so missing bank details do not hold the recording.
  const blocked = alreadyPaid ? [] : missing
  const checkNumberMissing = method === 'CHECK' && reference.trim() === ''

  const submit = () => {
    if (checkNumberMissing || blocked.length > 0) return
    setPosting(true)
    setError(null)
    recordApPaymentGroup({
      billIds: rows.map((row) => row.id),
      paidAt,
      method,
      clientRequestId,
      reference: reference.trim() || undefined,
      note: note.trim() || undefined,
      ...(alreadyPaid ? { suppressRemittance: true } : {}),
    })
      .then((out) => {
        toast.success(out.duplicate ? 'That payment was already posted' : `Paid ${formatCents(totalCents)} to ${payTo}`)
        onDone()
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setPosting(false))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Record payment — ${payTo}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={posting}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={posting || checkNumberMissing || blocked.length > 0}>
            {posting ? 'Posting…' : `Post ${formatCents(totalCents)}`}
          </TmsButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {blocked.length > 0 && (
          <div className="p-2 tms-tint tms-tint-red text-xs" role="alert" data-testid="pay-group-blocked">
            <strong>This payment cannot be posted yet.</strong> {blocked.map((m) => <span key={m}>{m} </span>)}
            Take those bills off the selection, or fix the payee first. {PAID_OUTSIDE_HINT}
          </div>
        )}
        {missing.length > 0 && alreadyPaid && (
          <div className="p-2 tms-tint tms-tint-orange text-xs" data-testid="pay-group-blocked-bypassed">
            No bank details are on file for this payee. This is recorded as paid outside the app: nothing is sent to the bank or the payee.
          </div>
        )}
        <p className="m-0 text-sm tms-muted" data-testid="pay-group-explainer">
          {rows.length} bills from {carriers} carriers, all paid to {payTo}. Pay the payee first, then post it here. Each
          bill is paid in full and one remittance e-mail{remitEmail ? ` to ${remitEmail}` : ''} lists all of them. If the
          payee has no remit e-mail, nothing is sent.
        </p>
        <div className="tms-grid tms-grid-3">
          <TmsField label="Paid">
            <TmsInput aria-label="Payment date" type="date" value={paidAt} disabled={posting} onChange={(e) => setPaidAt(e.target.value)} />
          </TmsField>
          <TmsField label="Method">
            <TmsSelect aria-label="Payment method" value={method} disabled={posting} onChange={(e) => setMethod(e.target.value as ApPaymentMethod)}>
              {METHODS.map((row) => <option key={row} value={row}>{METHOD_LABEL[row]}</option>)}
            </TmsSelect>
          </TmsField>
          <TmsField label={method === 'CHECK' ? 'Check #' : 'Check / ref #'}>
            <TmsInput
              aria-label="Payment reference"
              value={reference}
              disabled={posting}
              aria-invalid={checkNumberMissing || undefined}
              placeholder={method === 'CHECK' ? 'required for a paper check' : 'trace or ref # (optional)'}
              onChange={(e) => setReference(e.target.value)}
            />
          </TmsField>
        </div>

        <ul style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }} aria-label="Bills in this payment">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-2 py-1.5">
              <span className="w-28 shrink-0 truncate font-medium">{proOf(row)}</span>
              <span className="flex-1 truncate text-xs tms-muted">{row.carrierName}</span>
              <span className="text-right text-xs">{formatCents(row.balanceCents)}</span>
            </li>
          ))}
          <li className="flex items-center gap-3 px-2 py-1.5 font-semibold">
            <span className="flex-1">Total</span>
            <span aria-label="Payment total">{formatCents(totalCents)}</span>
          </li>
        </ul>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={alreadyPaid} disabled={posting} onChange={(e) => setAlreadyPaid(e.target.checked)} />
          Already paid outside the app — don&apos;t send remittance e-mail
        </label>
        <TmsField label="Note">
          <TmsTextarea aria-label="Payment note" rows={2} value={note} disabled={posting} onChange={(e) => setNote(e.target.value)} />
        </TmsField>
        {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }} role="alert">{error}</p>}
      </div>
    </TmsDialog>
  )
}
