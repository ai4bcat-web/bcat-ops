/**
 * The one record carrying only typed customer text, and the one move that resolves it.
 *
 * Readiness is `customerId == null` and never status: the backfill sets status from the
 * stop clock, so one of these can arrive already DELIVERED and would otherwise reach AR
 * and die on a customer id that was never there. The copy is `unresolvedCustomerMessage`
 * so the screen says exactly what the Lambda says when it refuses the submit, the
 * invoice or the factoring.
 *
 * It lives here rather than on the shipment detail because the Errors tab raises the same
 * form over an UNKNOWN_CUSTOMER row. Both callers pass the same props and both end in
 * `onLink`, which is `SET_SHIPMENT_CUSTOMER` and nothing else: no Customer record is ever
 * created from this form.
 */
import { useState } from 'react'
import { TmsButton, TmsCard, TmsDialog, TmsField, TmsSelect } from '@/features/tms/kit'
import { effectiveCustomerStatus } from '@/lib/customerCredit'
import { UNRESOLVED_CUSTOMER_LABEL, unresolvedCustomerMessage } from '@/lib/customerResolution'
import type { CustomerRecord, ShipmentRecord } from '@/types/tms'

export interface IdentifyCustomerProps {
  shipment: Pick<ShipmentRecord, 'id' | 'number' | 'customerId' | 'customerName' | 'voidedAt'>
  customers: CustomerRecord[]
  /** A voided shipment is refused every write, so it is told, not asked. */
  frozen: boolean
  onLink: (customerId: string) => Promise<void>
}

/** The picker plus its button, shared by the inline card and the dialog. */
function IdentifyCustomerForm({ shipment, customers, frozen, onLink, onDone }: IdentifyCustomerProps & {
  onDone?: () => void
}) {
  const [customerId, setCustomerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // SET_SHIPMENT_CUSTOMER runs the same ACTIVE check CREATE_SHIPMENT runs, and dormant
  // is an automatic "no shipment in 90 days" label new freight clears. The server
  // re-checks; this list exists so nobody is offered a name it is going to refuse.
  const now = new Date().toISOString()
  const shippable = customers.filter((c) => {
    const status = effectiveCustomerStatus(c, null, now)
    return status === 'ACTIVE' || status === 'DORMANT'
  })

  return (
    <>
      <p className="text-sm" data-testid="unresolved-customer-note">
        {unresolvedCustomerMessage(shipment, 'submitting, invoicing or factoring it')}
      </p>
      {!frozen && (
        <div className="mt-3 flex items-end gap-2">
          <TmsField label="Customer" error={error}>
            <TmsSelect
              aria-label="Customer to link"
              value={customerId}
              onChange={(e) => { setCustomerId(e.target.value); setError(null) }}
            >
              <option value="">— select —</option>
              {shippable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </TmsSelect>
          </TmsField>
          <TmsButton
            variant="primary"
            disabled={busy}
            onClick={async () => {
              if (!customerId) { setError('Pick a customer.'); return }
              setBusy(true)
              try {
                await onLink(customerId)
                onDone?.()
              } catch {
                // `useShipmentActions` already toasted the Lambda's own refusal.
                setError('Could not link that customer.')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Linking…' : 'Link customer'}
          </TmsButton>
        </div>
      )}
    </>
  )
}

/** The card form, rendered inline on the shipment detail. */
export function UnresolvedCustomerCard(props: IdentifyCustomerProps) {
  return (
    <TmsCard title={UNRESOLVED_CUSTOMER_LABEL}>
      <IdentifyCustomerForm {...props} />
    </TmsCard>
  )
}

/** The same body in a dialog, raised from the Errors tab. */
export function IdentifyCustomerDialog(
  props: IdentifyCustomerProps & { open: boolean; onOpenChange: (open: boolean) => void },
) {
  const { open, onOpenChange, ...rest } = props
  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${UNRESOLVED_CUSTOMER_LABEL}${rest.shipment.number ? ` — ${rest.shipment.number}` : ''}`}
      footer={<TmsButton onClick={() => onOpenChange(false)}>Close</TmsButton>}
    >
      <IdentifyCustomerForm {...rest} onDone={() => onOpenChange(false)} />
    </TmsDialog>
  )
}

export default IdentifyCustomerDialog
