/**
 * Add or fix a carrier's pay-to without leaving Payable (Ryne 2026-11-18: a payee with no pay-to "needs its pay to
 * updated"). It is the carrier profile's payment-method editor in a dialog: the same fields, the same write
 * (`UPSERT_PAYMENT_METHOD`), so a method saved here is the one the carrier profile and the Remit e-mails page show.
 * Nothing is invented: the pay-to name, method, remit e-mail and factor are typed by whoever knows them.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { CarrierPaymentEditor, type CarrierPaymentDraft } from '@/features/carriers/components/CarrierPaymentEditor'
import { archiveCarrierPaymentMethod, getCarrierBundle, graphqlErrorText, upsertCarrierPaymentMethod } from '@/lib/apiClient'
import type { CarrierPaymentMethodRecord } from '@/types/tms'

export function PayToDialog({ carrierId, carrierName, awaiting, open, onOpenChange, onChanged }: {
  carrierId: string
  carrierName: string
  /** What the missing pay-to is holding up, for the editor's warning. */
  awaiting?: { count: number; cents: number }
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A method was saved or retired: the board re-reads its payment infos. */
  onChanged: () => void
}) {
  const [methods, setMethods] = useState<CarrierPaymentMethodRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  // No synchronous setState in the effect (react-hooks/set-state-in-effect): every write is in the promise chain.
  useEffect(() => {
    let alive = true
    getCarrierBundle(carrierId)
      .then((bundle) => { if (alive) { setMethods(bundle.paymentMethods); setError(null) } })
      .catch((err: unknown) => { if (alive) setError(graphqlErrorText(err) || 'The payment methods could not be loaded') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [carrierId, reload])

  const save = async (draft: CarrierPaymentDraft) => {
    await upsertCarrierPaymentMethod({ carrierId, ...draft })
    toast.success('Pay-to saved')
    setReload((n) => n + 1)
    onChanged()
  }

  const archive = async (method: CarrierPaymentMethodRecord) => {
    await archiveCarrierPaymentMethod({ id: method.id, expectedUpdatedAt: method.updatedAt })
    toast.success('Payment method retired')
    setReload((n) => n + 1)
    onChanged()
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Pay-to — ${carrierName}`}
      footer={<TmsButton variant="ghost" onClick={() => onOpenChange(false)}>Close</TmsButton>}
    >
      <p className="tms-muted">
        Where {carrierName} is paid: the carrier&rsquo;s own account, or its factoring company. Add one, or mark one
        as the preferred method if there are several. Only the last four digits of an account are ever stored.
      </p>
      {error && <p className="mt-2 text-xs" role="alert" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
      {loading ? (
        <p className="tms-muted">Loading payment methods…</p>
      ) : (
        <CarrierPaymentEditor methods={methods} awaitingPayment={awaiting} carrierName={carrierName} onSave={save} onArchive={archive} />
      )}
    </TmsDialog>
  )
}
