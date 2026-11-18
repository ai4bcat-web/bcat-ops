import { useState } from 'react'
import { TmsAlert, TmsButton } from '@/features/tms/kit'
import type { ShipmentRecord } from '@/types/tms'
import { UnvoidShipmentDialog } from '../components/UnvoidShipmentDialog'

/**
 * The red banner on a voided shipment. The owner or an admin gets Restore from void beside it,
 * the same UNVOID_SHIPMENT the Voided tab uses (Ryne 2026-11-18: PRO 14600 was voided by mistake).
 */
export function VoidedBanner({ shipment, message, canRestore, onRestored }: {
  shipment: Pick<ShipmentRecord, 'id' | 'number' | 'updatedAt'>
  message: string
  canRestore: boolean
  onRestored: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TmsAlert tone="red" className="tms-ship-banner">
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span>{message}</span>
          {canRestore ? (
            <TmsButton size="sm" data-testid="ship-form-restore-void" onClick={() => setOpen(true)}>
              Restore from void
            </TmsButton>
          ) : null}
        </span>
      </TmsAlert>
      {canRestore && open ? (
        <UnvoidShipmentDialog
          shipment={shipment}
          open={open}
          onOpenChange={setOpen}
          onUnvoided={onRestored}
        />
      ) : null}
    </>
  )
}
