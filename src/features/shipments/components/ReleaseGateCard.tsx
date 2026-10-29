/**
 * Ryne's release-to-accounting gate, as the Invoicing tab shows it.
 *
 * The rule is enforced server-side in both routers and there is no override, so this
 * card never decides anything: it asks `PREVIEW_INVOICE` — which writes nothing — for
 * the same verdict the write path will reach, and prints `releaseGate.missing[].message`
 * verbatim. The list is the checklist; "Ready for accounting" is the only other answer.
 *
 * Before delivery there is nothing to check, so the card says what it is waiting for
 * rather than inventing a list the gate has not produced.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { previewInvoice } from '@/lib/apiClient'
import { isDeliveredOrLater } from './releaseGateView'
import { TmsCard } from '@/features/tms/kit'
import type { ReleaseGateResult } from '@/lib/releaseGate'
import type { OrderRecord, ShipmentRecord } from '@/types/tms'

export function ReleaseGateList({ messages, testId }: { messages: string[]; testId?: string }) {
  return (
    <ul className="space-y-1 text-sm" data-testid={testId ?? 'release-gate-missing'}>
      {messages.map((message) => (
        <li key={message} className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[color:var(--tms-badge-orange)]" />
          <span>{message}</span>
        </li>
      ))}
    </ul>
  )
}

export function ReleaseGateCard({ shipment, order }: { shipment: ShipmentRecord; order: OrderRecord | null }) {
  const [gate, setGate] = useState<ReleaseGateResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const orderId = order?.id ?? null
  // The preview re-runs the whole rule server-side; re-ask whenever the order moves.
  const stamp = order?.updatedAt ?? ''
  const ready = isDeliveredOrLater(shipment, order)

  // No synchronous setState before the first await; a failed read keeps what we had.
  useEffect(() => {
    let live = true
    const answer = ready && orderId
      ? previewInvoice({ orderId }).then((p) => ({ gate: p.releaseGate, error: null as string | null }))
        .catch((err: unknown) => ({
          gate: null,
          error: err instanceof Error ? err.message : 'The release check could not be read.',
        }))
      : Promise.resolve({ gate: null, error: null as string | null })
    answer.then((result) => {
      if (!live) return
      setGate(result.gate)
      setError(result.error)
    })
    return () => { live = false }
  }, [ready, orderId, stamp])

  if (!order) return null

  return (
    <TmsCard title="Release to accounting">
      <div className="space-y-2" data-testid="release-gate">
        {!ready && (
          <p className="tms-muted text-sm">
            The gate runs once the shipment is delivered. Nothing is checked before then.
          </p>
        )}
        {ready && error && <p className="text-sm text-[color:var(--tms-badge-red)]">{error}</p>}
        {ready && !error && !gate && <p className="tms-muted text-sm">Checking the release requirements…</p>}
        {gate?.ok && (
          <p className="flex items-center gap-2 text-sm" data-testid="release-gate-ok">
            <CheckCircle2 size={14} className="text-[color:var(--tms-badge-green)]" />
            Ready for accounting
          </p>
        )}
        {gate && !gate.ok && <ReleaseGateList messages={gate.missing.map((reason) => reason.message)} />}
      </div>
    </TmsCard>
  )
}
