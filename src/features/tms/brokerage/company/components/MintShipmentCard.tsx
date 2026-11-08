import { useMemo, useState } from 'react'
import { Loader2, PackagePlus } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit'
import { SettingsCard } from '@/features/settings/settingsKit'
import { useAuth } from '@/hooks/useAuth'
import { useLoads } from '@/hooks/useLoads'
import { createShipmentForLoad } from '@/lib/apiClient'

/**
 * Data repair utility: lists loads that have no linked Shipment and mints one per row. It used to be the
 * Shipments board's "Create shipment" dialog; creating a shipment is the Aljex form now (`/tms/shipments/new`).
 *
 * Owner/ADMIN only in the UI; the Lambda (`BACKFILL_SHIPMENT`) is the real gate. A load that was just minted
 * drops out of the list at once, so the same load is never offered twice.
 */
export function MintShipmentCard() {
  const { isAdmin, isOwner } = useAuth()
  const { allLoads } = useLoads()
  const [runningId, setRunningId] = useState<string | null>(null)
  const [minted, setMinted] = useState<ReadonlySet<string>>(() => new Set())
  const mayMint = isAdmin || isOwner

  const loads = useMemo(
    () =>
      allLoads
        .filter((load) => !load.shipmentId && !minted.has(load.id))
        .sort((a, b) => (b.pickupAppt ?? '').localeCompare(a.pickupAppt ?? '')),
    [allLoads, minted],
  )

  const handleCreate = async (loadId: string) => {
    setRunningId(loadId)
    try {
      await createShipmentForLoad(loadId)
      setMinted((prev) => new Set(prev).add(loadId))
      toast.success('Shipment created for load')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create shipment failed')
    } finally {
      setRunningId(null)
    }
  }

  return (
    <div data-testid="mint-shipment-card">
      <SettingsCard
        icon={PackagePlus}
        title="Mint a shipment for a load"
        description="Mint a Shipment for a load that does not have one."
      >
        {!mayMint ? (
          <p className="tms-muted py-2">Only an owner or admin can mint shipments.</p>
        ) : loads.length === 0 ? (
          <p className="tms-muted py-4">Every load already has a shipment. Nothing to do.</p>
        ) : (
          <ul className="tms-board-create-list max-h-[60vh] overflow-auto">
            {loads.map((load) => (
              <li key={load.id} className="flex items-center justify-between gap-3 py-2" data-testid="mint-row" data-load-id={load.id}>
                <span className="min-w-0 truncate">
                  <span className="font-medium">{load.pickupNumber ?? load.id}</span>
                  <span className="tms-muted ml-2">
                    {load.originCity ?? ''} → {load.destinationCity ?? ''}
                  </span>
                </span>
                <TmsButton
                  size="sm"
                  variant="primary"
                  disabled={runningId === load.id}
                  onClick={() => { void handleCreate(load.id) }}
                >
                  {runningId === load.id ? <Loader2 size={14} className="animate-spin" /> : null}
                  Create
                </TmsButton>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </div>
  )
}
