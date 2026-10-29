/**
 * Dispatching a booked load: the moment we tell the carrier to roll, and the facts we
 * write down when we do (spec §6.2 "Dispatch").
 *
 * The driver, truck and trailer default to whatever booking captured, because dispatch
 * is usually the first time anybody knows them for certain. An unsigned rate con is a
 * warning, not a refusal — the Lambda records it on the assignment and lets the load go.
 */
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { TmsButton, TmsDialog, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import type { LoadCarrierRecord, TrackingProvider } from '@/types/tms'

const TRACKING_PROVIDERS: TrackingProvider[] = ['NONE', 'MANUAL', 'LINK', 'DRIVER_APP', 'MOTIVE']

/** Everything DISPATCH_LOAD takes except the load it is dispatching. */
export interface DispatchFields {
  dispatchedAt: string
  pickupEtaAt?: string
  driverName?: string
  driverPhone?: string
  truckNumber?: string
  trailerNumber?: string
  trackingProvider?: TrackingProvider
  nextCheckCallAt?: string
  nextCheckCallNote?: string
  note?: string
  /**
   * Send the driver the ping link as soon as the dispatch lands. Not part of
   * DISPATCH_LOAD — the caller fires SEND_TRACKING_LINK after it succeeds, because a
   * text that fails is no reason to un-dispatch a truck that is rolling.
   */
  sendTrackingLink?: boolean
}

export function DispatchDialog({ loadCarrier, busy, onClose, onConfirm }: {
  loadCarrier: LoadCarrierRecord
  busy: boolean
  onClose: () => void
  onConfirm: (input: DispatchFields) => void
}) {
  const [dispatchedAt, setDispatchedAt] = useState(formatDateTimeInput(new Date().toISOString()))
  const [pickupEta, setPickupEta] = useState(loadCarrier.pickupEtaAt ? formatDateTimeInput(loadCarrier.pickupEtaAt) : '')
  const [driverName, setDriverName] = useState(loadCarrier.driverName ?? '')
  const [driverPhone, setDriverPhone] = useState(loadCarrier.driverPhone ?? '')
  const [truckNumber, setTruckNumber] = useState(loadCarrier.truckNumber ?? '')
  const [trailerNumber, setTrailerNumber] = useState(loadCarrier.trailerNumber ?? '')
  const [trackingProvider, setTrackingProvider] = useState<TrackingProvider>('MANUAL')
  const [checkCallAt, setCheckCallAt] = useState('')
  const [checkCallNote, setCheckCallNote] = useState('')
  const [note, setNote] = useState('')
  // Checked by default exactly when it would work: a link-tracked load with a phone to
  // text. Switching the provider to LINK ticks it, switching away unticks it.
  const [sendLink, setSendLink] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rateConSigned = loadCarrier.rateConStatus === 'SIGNED'

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Dispatch load"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary"
            onClick={() => {
              if (!dispatchedAt) { setError('A dispatch time is required.'); return }
              onConfirm({
                dispatchedAt: fromDateTimeInput(dispatchedAt),
                pickupEtaAt: pickupEta ? fromDateTimeInput(pickupEta) : undefined,
                driverName: driverName.trim() || undefined,
                driverPhone: driverPhone.trim() || undefined,
                truckNumber: truckNumber.trim() || undefined,
                trailerNumber: trailerNumber.trim() || undefined,
                trackingProvider,
                nextCheckCallAt: checkCallAt ? fromDateTimeInput(checkCallAt) : undefined,
                nextCheckCallNote: checkCallNote.trim() || undefined,
                note: note.trim() || undefined,
                sendTrackingLink: sendLink && driverPhone.trim().length > 0,
              })
            }}
            disabled={busy}
          >
            {busy ? 'Dispatching…' : 'Dispatch'}
          </TmsButton>
        </>
      }
    >
        {!rateConSigned && (
          <p className="flex items-start gap-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] bg-[color:var(--tms-card)] p-2 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[color:var(--tms-badge-orange)]" />
            The rate confirmation is not signed. Dispatching anyway is allowed, and the load keeps a
            RATE_CON_NOT_SIGNED note.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="tms-field-label">Dispatched at</Label>
            <TmsInput aria-label="Dispatched at" type="datetime-local" value={dispatchedAt} onChange={(e) => setDispatchedAt(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Pickup ETA</Label>
            <TmsInput aria-label="Pickup ETA" type="datetime-local" value={pickupEta} onChange={(e) => setPickupEta(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Driver</Label>
            <TmsInput aria-label="Dispatch driver name" value={driverName} onChange={(e) => setDriverName(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Driver phone</Label>
            <TmsInput aria-label="Dispatch driver phone" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Truck #</Label>
            <TmsInput aria-label="Dispatch truck number" value={truckNumber} onChange={(e) => setTruckNumber(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Trailer #</Label>
            <TmsInput aria-label="Dispatch trailer number" value={trailerNumber} onChange={(e) => setTrailerNumber(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="tms-field-label">Tracking</Label>
            <TmsSelect
              aria-label="Dispatch tracking"
              value={trackingProvider}
              onChange={(e) => {
                const next = e.target.value as TrackingProvider
                setTrackingProvider(next)
                setSendLink(next === 'LINK' && driverPhone.trim().length > 0)
              }}
              className="mt-1 h-9 w-full rounded-md border border-[color:var(--tms-input-border)] bg-[color:var(--tms-input)] px-2 text-sm"
            >
              {TRACKING_PROVIDERS.map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ').toLowerCase()}</option>)}
            </TmsSelect>
          </div>
          <div>
            <Label className="tms-field-label">Next check call</Label>
            <TmsInput aria-label="Next check call" type="datetime-local" value={checkCallAt} onChange={(e) => setCheckCallAt(e.target.value)} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <Label className="tms-field-label">Check call note</Label>
            <TmsInput aria-label="Check call note" value={checkCallNote} onChange={(e) => setCheckCallNote(e.target.value)} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <Label className="tms-field-label">Dispatch note</Label>
            <TmsTextarea aria-label="Dispatch note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="text-sm" />
          </div>
          {error && <p className="col-span-2 text-xs text-[color:var(--tms-badge-red)]">{error}</p>}
          <div className="col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label="Send tracking link now"
                checked={sendLink}
                disabled={!driverPhone.trim()}
                onCheckedChange={(v) => setSendLink(v === true)}
              />
              Send tracking link now
              {!driverPhone.trim() && <span className="text-xs tms-muted">— needs a driver phone</span>}
            </label>
          </div>
        </div>
    </TmsDialog>
  )
}
