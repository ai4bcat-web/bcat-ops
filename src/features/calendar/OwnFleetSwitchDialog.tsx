import { useEffect, useState } from 'react'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { useDrivers } from '@/hooks/useDrivers'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { onCoverRequest, onOwnFleetSwitchRequest, type CoverRequest, type OwnFleetSwitchRequest } from '@/lib/ownFleetSwitch'

/** Mounted once on the calendar: asks before an outside carrier is taken off a load so one of our drivers can run it. */
export function OwnFleetSwitchDialog() {
  const { drivers } = useDrivers()
  const [pending, setPending] = useState<{ req: OwnFleetSwitchRequest; answer: (ok: boolean) => void } | null>(null)

  const [cover, setCover] = useState<CoverRequest | null>(null)

  useEffect(() => onOwnFleetSwitchRequest((req, answer) => setPending({ req, answer })), [])
  useEffect(() => onCoverRequest(setCover), [])

  const coverDialog = cover ? (
    <CoverCarrierDialog shipmentId={cover.shipmentId} shipmentNumber={cover.shipmentNumber} onClose={() => setCover(null)} onCovered={() => setCover(null)} />
  ) : null
  if (!pending) return coverDialog
  const { req, answer } = pending
  const driverName = drivers.find((d) => d.id === req.driverId)?.name ?? 'this driver'
  const close = (ok: boolean) => { setPending(null); answer(ok) }
  if (req.kind === 'UNCOVER') {
    return (
      <>
        {coverDialog}
        <TmsDialog
          open
          onOpenChange={(o) => { if (!o) close(false) }}
          title="Back to need to cover?"
          description={`${req.loadLabel} is covered by ${req.carrierName ?? 'its current carrier or driver'}.`}
          footer={(
            <>
              <TmsButton variant="ghost" onClick={() => close(false)} data-testid="own-fleet-switch-cancel">Keep it</TmsButton>
              <TmsButton variant="primary" onClick={() => close(true)} data-testid="own-fleet-switch-confirm">Remove and mark need to cover</TmsButton>
            </>
          )}
        >
          <p style={{ margin: 0, fontSize: 13 }} data-testid="own-fleet-switch">
            Same as Remove carrier on the shipment: the assignment comes off and is recorded as bounced, its rate confirmation is voided, any tracking link stops working, and the load goes back to sourcing with no driver.
          </p>
        </TmsDialog>
      </>
    )
  }

  return (
    <>
    {coverDialog}
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) close(false) }}
      title="Switch to Ivan Cartage?"
      description={`${req.loadLabel} is covered by ${req.carrierName ?? 'an outside carrier'}.`}
      footer={(
        <>
          <TmsButton variant="ghost" onClick={() => close(false)} data-testid="own-fleet-switch-cancel">Keep the carrier</TmsButton>
          <TmsButton variant="primary" onClick={() => close(true)} data-testid="own-fleet-switch-confirm">Remove carrier and assign {driverName}</TmsButton>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 8, fontSize: 13 }} data-testid="own-fleet-switch">
        <p style={{ margin: 0 }}>
          {req.carrierName ?? 'The carrier'} comes off this load and is recorded as bounced (it is owed nothing for it). Their rate confirmation is voided and any tracking link they were sent stops working.
        </p>
        <p style={{ margin: 0 }}>
          {driverName} is then booked on the load as Ivan Cartage, with their truck and trailer. A carrier bill that was already recorded blocks this: void the bill first.
        </p>
      </div>
    </TmsDialog>
    </>
  )
}
