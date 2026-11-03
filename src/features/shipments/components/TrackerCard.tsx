/**
 * Who is tracking this shipment.
 *
 * `Shipment.trackerId` is stamped from the customer's default tracker when the shipment
 * is created, so the card says so while the two still agree; a hand reassignment
 * removes the hint. One `assignTracker` call per change, then the page reloads: the
 * server may skip the id (voided, unknown or INACTIVE person) and the card must show
 * what was actually stored, so a skip is reported rather than assumed away.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TrackerPicker } from '@/components/TrackerPicker'
import { TmsCard } from '@/features/tms/kit'
import { useStaff } from '@/hooks/useStaff'
import { assignTracker } from '@/lib/apiClient'
import type { CustomerRecord, ShipmentRecord } from '@/types/tms'

export interface TrackerCardProps {
  shipment: ShipmentRecord
  canEdit: boolean
  onChanged: () => void | Promise<void>
  /** The shipment's customer, for the "inherited" hint. */
  customer?: CustomerRecord | null
}

export function TrackerCard({ shipment, canEdit, onChanged, customer }: TrackerCardProps) {
  const { nameOf } = useStaff()
  const [busy, setBusy] = useState(false)
  const trackerId = shipment.trackerId ?? null
  const editable = canEdit && !shipment.voidedAt
  const inherited = trackerId != null && trackerId === (customer?.defaultTrackerId ?? null)

  const change = async (next: string | null) => {
    if (next === trackerId) return
    setBusy(true)
    try {
      const result = await assignTracker({ shipmentIds: [shipment.id], trackerId: next })
      const skipped = result.skipped.find((s) => s.shipmentId === shipment.id)
      if (skipped) toast.error(`Tracker not changed: ${skipped.reason}`)
      else toast.success(next ? `Assigned to ${nameOf(next)}` : 'Tracker cleared')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not assign the tracker')
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsCard title="Tracker">
      <div className="space-y-2" data-testid="tracker-card">
        {editable ? (
          <TrackerPicker value={trackerId} onChange={(id) => { void change(id) }} disabled={busy} />
        ) : (
          <p data-testid="tracker-name">{trackerId ? nameOf(trackerId) : 'Unassigned'}</p>
        )}
        {inherited && (
          <p className="tms-muted" data-testid="tracker-inherited">
            Inherited from {customer?.name ?? 'the customer'}
          </p>
        )}
      </div>
    </TmsCard>
  )
}
