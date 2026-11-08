/**
 * Booking Ivan Cartage (own fleet), or changing the driver once it is booked.
 *
 * Step W: an own-fleet load always carries a driver. The driver picked here is written
 * to the load every own-fleet view reads: the calendar, Schedule, Dispatch, the driver
 * app and the settlement run. Broker placeholders are not offered; the server refuses
 * them too, and everything the server refuses comes back as inline text rather than a
 * toast, so the dialog stays open for the retry.
 */
import { useState } from 'react'
import { OwnFleetDriverPicker } from '@/components/OwnFleetDriverPicker'
import { TmsAlert, TmsButton, TmsDialog, TmsField, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { useOwnFleetRoster } from '@/hooks/useOwnFleetRoster'
import { PAY_OVERRIDE_REASON_MIN, distinctStopDrivers, evaluatePayLock } from '@/lib/ownAssetDriver'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { LoadCarrierRecord, ShipmentLoad } from '@/types/tms'

export interface AssignDriverFields {
  driverId: string
  truckId?: string
  truckNumber?: string
  trailerId?: string
  trailerNumber?: string
  flattenSplit?: boolean
  payOverrideReason?: string
}

export interface AssignDriverDialogProps {
  load: ShipmentLoad
  activeLeg: LoadCarrierRecord | null
  drivers: Driver[]
  trucks: Equipment[]
  trailers: Equipment[]
  isAdmin: boolean
  busy: boolean
  onClose: () => void
  /** Rejection text is shown inline and the dialog stays open; success closes it. */
  onConfirm: (input: AssignDriverFields) => Promise<void>
}

/** The driver the load's delivery stop (the one pay reads) currently names. */
function currentDeliveryDriverId(load: ShipmentLoad, activeLeg: LoadCarrierRecord | null): string | null {
  const stops = load.stops ?? []
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i].type === 'delivery' && stops[i].driverId) return stops[i].driverId ?? null
  }
  return activeLeg?.kind === 'OWN_ASSET' ? activeLeg.driverId ?? null : null
}

export function AssignDriverDialog({
  load, activeLeg, drivers, trucks, trailers, isAdmin, busy, onClose, onConfirm,
}: AssignDriverDialogProps) {
  const ownLeg = activeLeg?.kind === 'OWN_ASSET' ? activeLeg : null
  const roster = useOwnFleetRoster({ drivers, trucks, trailers })
  const activeTrucks = trucks.filter((t) => t.active !== false)
  const activeTrailers = trailers.filter((t) => t.active !== false)

  const startDriver = ownLeg?.driverId && roster.some((d) => d.id === ownLeg.driverId) ? ownLeg.driverId : ''
  const [driverId, setDriverId] = useState(startDriver)
  const [truckId, setTruckId] = useState(ownLeg?.truckId ?? '')
  const [trailerId, setTrailerId] = useState(ownLeg?.trailerId ?? '')
  const [touched, setTouched] = useState({ truck: false, trailer: false })
  const [flatten, setFlatten] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const changing = Boolean(ownLeg)
  const nameOf = (id: string | null | undefined) => (id ? drivers.find((d) => d.id === id)?.name ?? id : '')

  const pickDriver = (d: (typeof roster)[number] | null) => {
    setDriverId(d?.id ?? '')
    setError(null)
    if (!touched.truck) setTruckId(d?.truckId ?? '')
    if (!touched.trailer) setTrailerId(d?.trailerId ?? '')
  }

  const stopDrivers = distinctStopDrivers(load.stops)
  const relay = stopDrivers.length >= 2
  const deliveryDriverId = currentDeliveryDriverId(load, ownLeg)
  const movesPay = Boolean(driverId) && driverId !== deliveryDriverId
  const lock = movesPay
    ? evaluatePayLock({
      deliveryAppt: load.deliveryAppt,
      todayUtc: new Date().toISOString().slice(0, 10),
      oldDriverName: nameOf(deliveryDriverId) || 'the previous driver',
      newDriverName: nameOf(driverId),
      isAdmin,
      reason,
    })
    : { state: 'OPEN' as const }
  const closedWeek = lock.state !== 'OPEN'
  const lockRefused = lock.state === 'REFUSED'

  const submit = async () => {
    if (!driverId) { setError('Pick a driver.'); return }
    const truck = activeTrucks.find((t) => t.id === truckId)
    const trailer = activeTrailers.find((t) => t.id === trailerId)
    setSubmitting(true)
    setError(null)
    try {
      await onConfirm({
        driverId,
        truckId: truckId || undefined,
        truckNumber: truck?.unitNumber,
        trailerId: trailerId || undefined,
        trailerNumber: trailer?.unitNumber,
        flattenSplit: relay ? true : undefined,
        payOverrideReason: lock.state === 'CLOSED_WEEK_OVERRIDE' ? lock.reason : undefined,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The driver could not be assigned.')
    } finally {
      setSubmitting(false)
    }
  }

  const working = busy || submitting

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={changing ? 'Change driver' : 'Book Ivan Cartage (own fleet)'}
      description="The driver and truck picked here are written to the load every own-fleet view reads: the calendar, Schedule, Dispatch, the driver app and driver settlements."
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={working}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            onClick={() => { void submit() }}
            disabled={working || !driverId || (relay && !flatten) || lockRefused}
          >
            {working ? 'Saving…' : changing ? 'Change driver' : 'Book own fleet'}
          </TmsButton>
        </>
      }
    >
      <div className="space-y-3">
        <TmsField label="Driver">
          <OwnFleetDriverPicker
            roster={roster}
            value={driverId}
            ariaLabel="Driver"
            placeholder="— select —"
            testId="assign-driver-select"
            onChange={pickDriver}
          />
        </TmsField>
        <TmsField label="Truck">
          <TmsSelect
            aria-label="Truck"
            value={truckId}
            onChange={(e) => { setTruckId(e.target.value); setTouched((t) => ({ ...t, truck: true })) }}
          >
            <option value="">— none —</option>
            {activeTrucks.map((t) => <option key={t.id} value={t.id}>{t.unitNumber}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Trailer">
          <TmsSelect
            aria-label="Trailer"
            value={trailerId}
            onChange={(e) => { setTrailerId(e.target.value); setTouched((t) => ({ ...t, trailer: true })) }}
          >
            <option value="">— none —</option>
            {activeTrailers.map((t) => <option key={t.id} value={t.id}>{t.unitNumber}</option>)}
          </TmsSelect>
        </TmsField>

        {relay && (
          <TmsAlert tone="orange">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="assign-driver-flatten"
                className="mt-1"
                checked={flatten}
                onChange={(e) => setFlatten(e.target.checked)}
              />
              <span>
                This load runs as a relay ({stopDrivers.map(nameOf).join(' → ')}). Booking one driver puts them on
                every stop. Confirm to continue.
              </span>
            </label>
          </TmsAlert>
        )}

        {closedWeek && (
          <TmsAlert tone="orange">
            {lock.state === 'REFUSED' && lock.code === 'CLOSED_WEEK' && lock.message}
            {isAdmin && (
              <div className="space-y-2">
                {lock.state === 'REFUSED' && lock.code === 'REASON_REQUIRED' && <p>{lock.message}</p>}
                <TmsField label={`Reason (at least ${PAY_OVERRIDE_REASON_MIN} characters)`}>
                  <TmsTextarea
                    aria-label="Pay override reason"
                    data-testid="assign-driver-reason"
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </TmsField>
              </div>
            )}
          </TmsAlert>
        )}

        {error && <p className="tms-field-error" role="alert" data-testid="assign-driver-error">{error}</p>}
      </div>
    </TmsDialog>
  )
}
