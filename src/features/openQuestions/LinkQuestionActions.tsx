/**
 * One-click answers for an unlinked-customer question in Needs review (Ryne 2026-11-16: "i'll do the customer links manually").
 * The sweep asked "13894: link 'SIMPLIFIED LOGISTICS SOLUTIONS' to …?"; these buttons do it: link to the suggested customer,
 * choose another, or create the customer. Linking is the shipment's own SET_SHIPMENT_CUSTOMER, and the question resolves with
 * the answer written on it.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit'
import { RepointCustomerDialog } from '@/features/shipments/components/RepointCustomerDialog'
import { bestCustomerFor, linkQuestionShipment } from '@/features/directory/unlinked'
import { invalidateUnlinkedShipments } from '@/features/directory/useUnlinkedShipments'
import { setShipmentCustomer } from '@/lib/apiClient'
import { updateOpenQuestionRow } from '@/lib/openQuestionsClient'
import type { CustomerRecord } from '@/types/tms'
import { appendNote, statusFor, toOpenQuestion, type OpenQuestion } from './openQuestions'

export interface LinkQuestionActionsProps {
  question: OpenQuestion
  /** Directory customers (the suggestion and the picker search them). */
  customers: CustomerRecord[]
  who: string
  /** The question as saved once the link is made and it is resolved. */
  onResolved: (next: OpenQuestion) => void
}

export function LinkQuestionActions({ question, customers, who, onResolved }: LinkQuestionActionsProps) {
  const target = linkQuestionShipment(question)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<'choose' | 'create' | null>(null)
  if (!target || question.status !== 'OPEN') return null
  const suggestion = bestCustomerFor(target.typedName, customers)

  const resolve = async (customerName: string) => {
    const notes = appendNote(question.notes, `Linked ${target.pro} to ${customerName}.`, who)
    const saved = await updateOpenQuestionRow(question.id, { adminNotes: notes, status: statusFor(true) })
    invalidateUnlinkedShipments()
    onResolved(toOpenQuestion(saved))
  }

  const linkSuggested = async () => {
    if (!suggestion) return
    setBusy(true)
    try {
      await setShipmentCustomer({ shipmentId: target.shipmentId, customerId: suggestion.customer.id })
      toast.success(`${target.pro} linked to ${suggestion.customer.name}`)
      await resolve(suggestion.customer.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not link')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="oq-link-actions" data-testid={`link-actions-${target.pro}`} style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
      {suggestion ? (
        <TmsButton size="sm" variant="primary" disabled={busy} onClick={() => void linkSuggested()}
          title={`${Math.round(suggestion.score * 100)}% name match`}>{`Link to ${suggestion.customer.name}`}</TmsButton>
      ) : null}
      <TmsButton size="sm" variant={suggestion ? 'secondary' : 'primary'} disabled={busy} onClick={() => setDialog('choose')}>Choose another…</TmsButton>
      <TmsButton size="sm" variant="secondary" disabled={busy} onClick={() => setDialog('create')}>Create customer…</TmsButton>
      {dialog ? (
        <RepointCustomerDialog
          shipment={{ id: target.shipmentId, number: target.pro, customerId: null, customerName: target.typedName, updatedAt: '' }}
          customers={customers} open startCreating={dialog === 'create'}
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          onRepointed={async (customerId) => {
            setDialog(null)
            const name = customers.find((c) => c.id === customerId)?.name ?? 'the chosen customer'
            try { await resolve(name) } catch { toast.error('Linked, but the question could not be resolved. Mark it resolved.') }
          }}
        />
      ) : null}
    </span>
  )
}
