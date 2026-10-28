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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
  const [error, setError] = useState<string | null>(null)

  const rateConSigned = loadCarrier.rateConStatus === 'SIGNED'

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Dispatch load</DialogTitle></DialogHeader>

        {!rateConSigned && (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
            The rate confirmation is not signed. Dispatching anyway is allowed, and the load keeps a
            RATE_CON_NOT_SIGNED note.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Dispatched at</Label>
            <Input aria-label="Dispatched at" type="datetime-local" value={dispatchedAt} onChange={(e) => setDispatchedAt(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Pickup ETA</Label>
            <Input aria-label="Pickup ETA" type="datetime-local" value={pickupEta} onChange={(e) => setPickupEta(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Driver</Label>
            <Input aria-label="Dispatch driver name" value={driverName} onChange={(e) => setDriverName(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Driver phone</Label>
            <Input aria-label="Dispatch driver phone" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Truck #</Label>
            <Input aria-label="Dispatch truck number" value={truckNumber} onChange={(e) => setTruckNumber(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Trailer #</Label>
            <Input aria-label="Dispatch trailer number" value={trailerNumber} onChange={(e) => setTrailerNumber(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Tracking</Label>
            <select
              aria-label="Dispatch tracking"
              value={trackingProvider}
              onChange={(e) => setTrackingProvider(e.target.value as TrackingProvider)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {TRACKING_PROVIDERS.map((p) => <option key={p} value={p}>{p.replace(/_/g, ' ').toLowerCase()}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Next check call</Label>
            <Input aria-label="Next check call" type="datetime-local" value={checkCallAt} onChange={(e) => setCheckCallAt(e.target.value)} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Check call note</Label>
            <Input aria-label="Check call note" value={checkCallNote} onChange={(e) => setCheckCallNote(e.target.value)} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Dispatch note</Label>
            <Textarea aria-label="Dispatch note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="text-sm" />
          </div>
          {error && <p className="col-span-2 text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
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
              })
            }}
            disabled={busy}
          >
            {busy ? 'Dispatching…' : 'Dispatch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
