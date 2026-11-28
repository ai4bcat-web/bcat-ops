/**
 * The confirmation before an auto shipper's Square invoice goes out. Sending is the only step that reaches the payer, so the
 * dialog names the payer, the amount and the invoice number, and says Square e-mails it. Shared by Auto Shipper Loads and Receivables.
 */
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'

export interface SquareSendTarget {
  pro: string
  payer: string
  payerEmail: string | null
  amountCents: number | null
}

export function SquareSendDialog({ target, busy, onCancel, onConfirm }: {
  target: SquareSendTarget
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onCancel() }}
      title="Send this invoice?"
      description={`Square will e-mail invoice ${target.pro}${target.amountCents != null ? ` for ${formatCents(target.amountCents)}` : ''} to ${target.payerEmail ?? 'the payer'}. This reaches the payer. Review the draft in Square first if you have not.`}
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onCancel} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={onConfirm} disabled={busy} data-testid="square-send-confirm">Send invoice</TmsButton>
        </>
      )}
    >
      <p className="text-sm">{target.payer}{target.payerEmail ? ` · ${target.payerEmail}` : ''}</p>
    </TmsDialog>
  )
}
