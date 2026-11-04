/**
 * Step AM — enter the driver for a covered load: name, phone, truck # and trailer #, all four mandatory.
 * Tracking (the SMS to the driver, the check-call agent) keys off this record and Dispatch is blocked
 * until it is complete, so the dialog refuses a blank before it asks the server.
 *
 * Step AQ: when the carrier is Ivan Cartage (`ownFleet`) the driver is picked from our Driver records
 * and the other three fields are filled from the record and read-only; nothing can be typed.
 */
import { useState } from 'react'
import { OwnFleetDriverPicker } from '@/components/OwnFleetDriverPicker'
import { TmsAlert, TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { useOwnFleetRoster } from '@/hooks/useOwnFleetRoster'
import { DRIVER_INFO_FIELDS, driverInfoGaps, type DriverInfoKey } from '@/lib/carrierAssignment'
import { ownFleetDriverByName, ownFleetFill, type OwnFleetDriverOption } from '@/lib/ownFleetDrivers'

export type DriverInfoValues = Record<DriverInfoKey, string> & { driverId?: string }

const LABELS: Record<DriverInfoKey, string> = {
  driverName: 'Driver name',
  driverPhone: 'Driver phone',
  truckNumber: 'Truck #',
  trailerNumber: 'Trailer #',
}

export function DriverInfoDialog({ initial, carrierName, ownFleet = false, busy, onClose, onConfirm }: {
  initial?: Partial<Record<DriverInfoKey, string | null | undefined>>
  carrierName?: string | null
  /** Ivan Cartage: the driver comes from the roster, never from typing. */
  ownFleet?: boolean
  busy: boolean
  onClose: () => void
  /** Rejects with the server's sentence; the dialog shows it and stays open. */
  onConfirm: (values: DriverInfoValues) => Promise<void>
}) {
  const [values, setValues] = useState<DriverInfoValues>({
    driverName: initial?.driverName ?? '',
    driverPhone: initial?.driverPhone ?? '',
    truckNumber: initial?.truckNumber ?? '',
    trailerNumber: initial?.trailerNumber ?? '',
  })
  const [touched, setTouched] = useState(false)
  const roster = useOwnFleetRoster()
  const [pickedId, setPickedId] = useState('')
  const driverId = ownFleet ? pickedId || ownFleetDriverByName(roster, values.driverName)?.id || '' : ''
  const pick = (d: OwnFleetDriverOption | null) => {
    const fill = d ? ownFleetFill(d) : null
    setPickedId(d?.id ?? '')
    setValues({
      driverName: fill?.driverName ?? '', driverPhone: fill?.driverPhone ?? '',
      truckNumber: fill?.truckNumber ?? '', trailerNumber: fill?.trailerNumber ?? '',
    })
  }
  const [error, setError] = useState<string | null>(null)
  const gaps = driverInfoGaps(values)

  const submit = async () => {
    setTouched(true)
    if (ownFleet && !driverId) { setError('Pick the driver from the list.'); return }
    if (gaps.length > 0) return
    setError(null)
    try {
      await onConfirm({
        driverName: values.driverName.trim(),
        driverPhone: values.driverPhone.trim(),
        truckNumber: values.truckNumber.trim(),
        trailerNumber: values.trailerNumber.trim(),
        ...(ownFleet ? { driverId } : {}),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The driver info could not be saved.')
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose() }}
      title="Enter driver info"
      description={`${carrierName ? `${carrierName}: ` : ''}all four fields are required. Tracking texts this driver and Dispatch waits for this.`}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" data-testid="driver-info-save" onClick={() => { void submit() }} disabled={busy}>
            {busy ? 'Saving…' : 'Save driver info'}
          </TmsButton>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {DRIVER_INFO_FIELDS.map((f) => (
          <TmsField key={f.key} label={`${LABELS[f.key]} *`} error={touched && values[f.key].trim() === '' ? `${LABELS[f.key]} is required.` : undefined}>
            {ownFleet && f.key === 'driverName' ? (
              <OwnFleetDriverPicker roster={roster} value={driverId} ariaLabel={LABELS[f.key]} testId="driver-info-picker" showSummary={false} onChange={pick} />
            ) : (
              <TmsInput
                aria-label={LABELS[f.key]}
                type={f.key === 'driverPhone' ? 'tel' : 'text'}
                autoComplete="off"
                value={values[f.key]}
                readOnly={ownFleet}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            )}
          </TmsField>
        ))}
      </div>
      {error && <div className="mt-3"><TmsAlert tone="red" role="alert"><span data-testid="driver-info-error">{error}</span></TmsAlert></div>}
    </TmsDialog>
  )
}
