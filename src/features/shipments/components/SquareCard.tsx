/**
 * The Square side of an auto shipper shipment (Ryne 2026-11-27).
 *
 * An auto shipper shipment is invoiced through Square, one payer per shipment. This card is where that happens: it shows
 * where the Square invoice stands, makes the draft, sends it (the only step that reaches the payer, and it says so before
 * it does), cancels or reissues it, and re-reads Square when asked. Three rules shape it:
 *
 *  1. Nothing here claims more than Square said. The status, the pay link and the payments come back from Square; the card
 *     only reports them, and "Sync from Square" asks again.
 *  2. A Square problem never touches the shipment. The shipment is saved first; "Square: not created" with the reason and a
 *     Retry is the honest state when Square was down, and a retry resumes rather than starting a second invoice.
 *  3. Nothing that is carrier-side (pay, cost, margin) is shown or sent: the card reads the payer, the vehicle, the price.
 */
import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsDialog, TmsMetaList, type TmsTone } from '@/features/tms/kit'
import { ReasonDialog } from '@/features/ar/components/ReasonDialog'
import { useBillingGrant, BILLING_GRANT_MESSAGE } from '@/features/ar/useBillingGrant'
import {
  cancelSquareInvoice, createSquareInvoice, reissueSquareInvoice, sendSquareInvoice, syncSquareInvoice,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { squareCardState, squareStatusLabel, type CarShippingData } from '@/lib/squareInvoicing'
import { errorMessage } from '@/lib/utils/errorMessage'
import type { ShipmentBundle } from '@/types/tms'

const STATE_TONE: Record<ReturnType<typeof squareCardState>, TmsTone> = {
  NOT_CREATED: 'gray', DRAFT: 'blue', SENT: 'orange', PAID: 'green', CANCELED: 'gray', REVIEW: 'red',
}

export function SquareCard({ bundle, onReload }: { bundle: ShipmentBundle; onReload: () => void }) {
  const allowed = useBillingGrant('invoicing')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmSend, setConfirmSend] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)

  const data = bundle.shipment.carShipping as CarShippingData | null | undefined
  const shipmentIdForSync = bundle.shipment.id
  const openState = squareCardState(data?.square)
  const lastSyncAt = data?.square?.lastSyncAt ?? null
  const askedOnce = useRef(false)
  // Opening a sent, unpaid invoice asks Square once for its latest status, so what staff see is never minutes stale. Quiet: no
  // toast and no spinner, and not more than once a minute per shipment.
  useEffect(() => {
    if (!allowed || askedOnce.current || openState !== 'SENT') return
    if (lastSyncAt && Date.now() - Date.parse(lastSyncAt) < 60_000) return
    askedOnce.current = true
    void syncSquareInvoice({ shipmentId: shipmentIdForSync }).then(() => onReload()).catch(() => { /* the Sync button shows the reason */ })
  }, [allowed, openState, lastSyncAt, shipmentIdForSync, onReload])
  // Only for an auto shipper shipment, and only for people who may see AR money: the payer's invoice is AR.
  if (!data || !allowed) return null
  const square = data.square
  const state = squareCardState(square)
  const order = bundle.orders?.[0]
  const amountCents = Number(order?.customerRateCents ?? order?.revenueCents ?? 0)
  const priceChanged = square?.amountCents != null && square.amountCents !== amountCents

  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return
    setBusy(key)
    try {
      await work()
      if (done) toast.success(done)
      onReload()
    } catch (err) {
      toast.error(errorMessage(err))
      onReload()
    } finally {
      setBusy(null)
    }
  }

  const shipmentId = bundle.shipment.id
  const copyLink = async () => {
    if (!square?.publicUrl) return
    try { await navigator.clipboard.writeText(square.publicUrl); toast.success('Pay link copied') } catch { toast.error('Could not copy the link') }
  }

  return (
    <TmsCard
      title="Square invoice"
      actions={(
        <span className="flex items-center gap-2">
          {square?.environment && <TmsBadge tone={square.environment === 'PRODUCTION' ? 'red' : 'gray'} data-testid="square-env">{square.environment === 'PRODUCTION' ? 'Production' : 'Sandbox'}</TmsBadge>}
          <TmsBadge tone={STATE_TONE[state]} data-testid="square-status">{squareStatusLabel(square?.invoiceId ? square.status : null)}</TmsBadge>
        </span>
      )}
    >
      <div className="space-y-3" data-testid="square-card">
        <TmsMetaList
          columns={2}
          items={[
            { label: 'Bill to', value: [data.payer.company || data.payer.name, data.payer.email, data.payer.phone].filter(Boolean).join(' · ') },
            { label: 'Vehicle', value: [data.vehicle.year, data.vehicle.make, data.vehicle.model].filter(Boolean).join(' ') },
            { label: 'Amount', value: formatCents(amountCents) },
            { label: 'Invoice #', value: square?.invoiceNumber ?? '—' },
          ]}
        />

        {square?.lastError && (
          <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }} data-testid="square-error">
            Square: {square.lastError}
          </p>
        )}
        {square?.reviewFlag && (
          <p className="text-sm" style={{ color: 'var(--tms-badge-red)' }} data-testid="square-review">{square.reviewFlag}</p>
        )}
        {priceChanged && state !== 'NOT_CREATED' && (
          <p className="tms-muted text-xs" data-testid="square-price-changed">
            The price is now {formatCents(amountCents)} but the Square invoice was made for {formatCents(square?.amountCents ?? 0)}.
            {state === 'DRAFT' ? ' Rebuild the draft to match.' : ' Reissue it to match.'}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {state === 'NOT_CREATED' && (
            <TmsButton variant="primary" disabled={busy != null} onClick={() => { void run('create', () => createSquareInvoice({ shipmentId }), 'Square draft invoice created') }}>
              {square?.lastError ? 'Retry Square draft' : 'Create Square draft'}
            </TmsButton>
          )}
          {state === 'DRAFT' && (
            <>
              <TmsButton variant="primary" disabled={busy != null} onClick={() => setConfirmSend(true)}>Send invoice</TmsButton>
              {priceChanged && (
                <TmsButton disabled={busy != null} onClick={() => { void run('rebuild', () => createSquareInvoice({ shipmentId }), 'Draft rebuilt at the new price') }}>Rebuild draft</TmsButton>
              )}
              <TmsButton variant="ghost" disabled={busy != null} onClick={() => { void run('delete', () => cancelSquareInvoice({ shipmentId }), 'Draft deleted') }}>Delete draft</TmsButton>
            </>
          )}
          {(state === 'SENT' || state === 'PAID' || state === 'REVIEW') && (
            <TmsButton disabled={busy != null} onClick={() => { void run('sync', () => syncSquareInvoice({ shipmentId }), 'Synced from Square') }}>Sync from Square</TmsButton>
          )}
          {state === 'SENT' && (
            <>
              {priceChanged && (
                <TmsButton disabled={busy != null} onClick={() => { void run('reissue', () => reissueSquareInvoice({ shipmentId }), 'Reissued as a new draft') }}>Reissue at new price</TmsButton>
              )}
              <TmsButton variant="destructive" disabled={busy != null} onClick={() => setCancelOpen(true)}>Cancel invoice</TmsButton>
            </>
          )}
          {state === 'CANCELED' && (
            <TmsButton disabled={busy != null} onClick={() => { void run('reissue', () => reissueSquareInvoice({ shipmentId }), 'New draft made') }}>Make a new draft</TmsButton>
          )}
          {square?.publicUrl && (
            <TmsButton variant="ghost" onClick={() => { void copyLink() }} aria-label="Copy pay link"><Copy size={14} /> Copy pay link</TmsButton>
          )}
        </div>
        <p className="tms-muted text-xs">
          {state === 'DRAFT'
            ? 'A draft is not visible to the payer. Send invoice has Square e-mail it.'
            : state === 'NOT_CREATED'
              ? 'The shipment is saved. The Square invoice has not been made yet.'
              : 'Status and payments come from Square. Payments are recorded on the invoice automatically.'}
        </p>
      </div>

      {confirmSend && (
        <TmsDialog
          open
          onOpenChange={(open) => { if (!open) setConfirmSend(false) }}
          title="Send this invoice?"
          description={`Square will e-mail invoice ${square?.invoiceNumber ?? ''} for ${formatCents(amountCents)} to ${data.payer.email}${square?.environment === 'SANDBOX' ? ' (sandbox: no real e-mail is sent)' : ''}. This reaches the payer.`}
          footer={(
            <>
              <TmsButton variant="ghost" onClick={() => setConfirmSend(false)} disabled={busy != null}>Cancel</TmsButton>
              <TmsButton
                variant="primary"
                disabled={busy != null}
                onClick={() => { setConfirmSend(false); void run('send', () => sendSquareInvoice({ shipmentId }), 'Invoice sent') }}
              >
                Send invoice
              </TmsButton>
            </>
          )}
        >
          <p className="text-sm">{data.payer.company || data.payer.name} · {data.payer.email}</p>
        </TmsDialog>
      )}
      {cancelOpen && (
        <ReasonDialog
          title="Cancel this Square invoice?"
          description="Square cancels the invoice and tells the payer. If nothing was paid, the invoice here is voided too."
          label="Reason"
          confirmLabel="Cancel invoice"
          busy={busy != null}
          onClose={() => setCancelOpen(false)}
          onConfirm={(reason) => { setCancelOpen(false); void run('cancel', () => cancelSquareInvoice({ shipmentId, reason }), 'Invoice canceled') }}
        />
      )}
      {!allowed && <p className="tms-muted text-xs">{BILLING_GRANT_MESSAGE}</p>}
    </TmsCard>
  )
}
