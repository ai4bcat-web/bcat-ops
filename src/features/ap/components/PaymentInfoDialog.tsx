/**
 * Where a bill's money goes: the payee, the bank, and the last four of the account and routing numbers.
 *
 * The numbers are masked by design. BCAT Ops keeps only the last four of a carrier's account and routing
 * numbers (what it takes to tell two accounts apart); MyCarrierPackets holds the full ones, and the sync
 * drops them before they reach a row. Nothing on this dialog is read from a bank-details file, so opening it
 * cannot leak an account.
 */
import { Link } from 'react-router-dom'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import type { CarrierPaymentInfo } from '@/lib/apiClient'
import type { CarrierBillRecord } from '@/types/tms'
import { payToLabel, remitEmailOf } from '../apViews'

const METHOD_LABEL: Record<string, string> = {
  ACH: 'ACH', WIRE: 'Wire', CHECK: 'Check', ZELLE: 'Zelle', VENMO: 'Venmo', EFT: 'EFT',
}

const masked = (last4?: string | null) => (last4 ? `•••• ${last4}` : null)

export function PaymentInfoDialog({ bill, info, infos, open, onOpenChange }: {
  bill: CarrierBillRecord
  info: CarrierPaymentInfo | null
  infos: readonly CarrierPaymentInfo[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const address = bill.remitTo?.address
  const email = remitEmailOf(bill, infos)
  const rows: [string, string | null][] = [
    ['Pay to', payToLabel(bill)],
    ['Carrier', bill.carrierName ?? null],
    ['Payment method', info?.method ? (METHOD_LABEL[info.method] ?? info.method) : (bill.remitTo?.method ? (METHOD_LABEL[bill.remitTo.method] ?? bill.remitTo.method) : null)],
    ['Bank', info?.bankName ?? null],
    ['Account name', info?.accountName ?? null],
    ['Checking account', masked(info?.accountLast4 ?? bill.remitTo?.accountLast4)],
    ['Routing number', masked(info?.routingLast4)],
    ['Remittance e-mail', email || null],
    ['Remit address', address ? [address.street, address.street2, [address.city, address.state].filter(Boolean).join(', '), address.zip].filter(Boolean).join(' · ') : null],
  ]
  const nothingOnFile = !info && !bill.remitTo
  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Payment info — ${bill.carrierName ?? 'carrier'}`}
      footer={(
        <>
          <Link to={`/tms/carriers/${bill.carrierId}`} onClick={() => onOpenChange(false)}>Open carrier profile</Link>
          <TmsButton variant="primary" onClick={() => onOpenChange(false)}>Close</TmsButton>
        </>
      )}
    >
      {nothingOnFile && (
        <p className="tms-muted">Not on file. Request the carrier packet from MyCarrierPackets, then pull this carrier from the Integrations page.</p>
      )}
      <dl className="tms-meta-list">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 py-1">
            <dt className="tms-muted">{label}</dt>
            <dd>{value ?? <span className="tms-muted">Not on file</span>}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs tms-muted">
        Only the last four digits are kept here. The full account and routing numbers stay with MyCarrierPackets.
      </p>
    </TmsDialog>
  )
}
