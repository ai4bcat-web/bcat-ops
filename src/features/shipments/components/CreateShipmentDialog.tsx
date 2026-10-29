import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { useLoads } from '@/hooks/useLoads'
import { createShipmentForLoad } from '@/lib/apiClient'

export interface CreateShipmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: () => void | Promise<void>
}

/**
 * Lists loads that have no linked Shipment and mints one per row.
 *
 * Owner/ADMIN only in the UI: the Lambda is the real gate. The list refreshes
 * after every backfill so the same load is never offered twice.
 */
export function CreateShipmentDialog({ open, onOpenChange, onCreated }: CreateShipmentDialogProps) {
  const { allLoads } = useLoads()
  const [runningId, setRunningId] = useState<string | null>(null)

  const loads = useMemo(
    () =>
      allLoads
        .filter((load) => !load.shipmentId)
        .sort((a, b) => (b.pickupAppt ?? '').localeCompare(a.pickupAppt ?? '')),
    [allLoads],
  )

  const handleCreate = async (loadId: string) => {
    setRunningId(loadId)
    try {
      await createShipmentForLoad(loadId)
      toast.success('Shipment created for load')
      if (onCreated) await onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create shipment failed')
    } finally {
      setRunningId(null)
    }
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create shipment"
      description="Mint a Shipment for a load that does not have one."
      footer={
        <TmsButton variant="secondary" onClick={() => onOpenChange(false)}>
          Done
        </TmsButton>
      }
    >
      {loads.length === 0 ? (
        <p className="tms-muted py-4">Every load already has a shipment. Nothing to do.</p>
      ) : (
        <ul className="tms-board-create-list max-h-[60vh] overflow-auto">
          {loads.map((load) => (
            <li key={load.id} className="flex items-center justify-between gap-3 py-2">
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
    </TmsDialog>
  )
}
