/**
 * Step AM — enter the driver for a covered load: name, phone, truck # and trailer #, all four mandatory.
 * Tracking (the SMS to the driver, the check-call agent) keys off this record and Dispatch is blocked
 * until it is complete, so the dialog refuses a blank before it asks the server.
 */
import { useState } from 'react'
import { TmsAlert, TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { DRIVER_INFO_FIELDS, driverInfoGaps, type DriverInfoKey } from '@/lib/carrierAssignment'

export type DriverInfoValues = Record<DriverInfoKey, string>

const LABELS: Record<DriverInfoKey, string> = {
  driverName: 'Driver name',
  driverPhone: 'Driver phone',
  truckNumber: 'Truck #',
  trailerNumber: 'Trailer #',
}

export function DriverInfoDialog({ initial, carrierName, busy, onClose, onConfirm }: {
  initial?: Partial<Record<DriverInfoKey, string | null | undefined>>
  carrierName?: string | null
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
  const [error, setError] = useState<string | null>(null)
  const gaps = driverInfoGaps(values)

  const submit = async () => {
    setTouched(true)
    if (gaps.length > 0) return
    setError(null)
    try {
      await onConfirm({
        driverName: values.driverName.trim(),
        driverPhone: values.driverPhone.trim(),
        truckNumber: values.truckNumber.trim(),
        trailerNumber: values.trailerNumber.trim(),
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
            <TmsInput
              aria-label={LABELS[f.key]}
              type={f.key === 'driverPhone' ? 'tel' : 'text'}
              autoComplete="off"
              value={values[f.key]}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </TmsField>
        ))}
      </div>
      {error && <div className="mt-3"><TmsAlert tone="red" role="alert"><span data-testid="driver-info-error">{error}</span></TmsAlert></div>}
    </TmsDialog>
  )
}
