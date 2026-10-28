/**
 * The action menus: what a user can do to a shipment from a board row or the drawer
 * header, and what they can do to one of its loads.
 *
 * Which items appear is decided here from the status alone; whether the action is
 * *allowed* is decided by the Lambda. Hiding an item the server would refuse keeps the
 * menu honest, but nothing here is a security boundary.
 */
import { useState } from 'react'
import { MoreHorizontal, Copy, PauseCircle, PlayCircle, Ban, RotateCcw, Trash2, Check, X, Truck, Building2, UserMinus, FileSignature } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { nextLoadStatuses, LOAD_WORKFLOW_STATUS_LABELS, isTruckloadMode } from '@/lib/shipmentStatus'
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { formatCents } from '@/lib/tmsDirectory'
import { BookCarrierDialog, type BookCarrierFields } from '@/features/carriers/components/BookCarrierDialog'
import { type RemoveLoadCarrierReason } from '@/lib/apiClient'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'
import type {
  ArStatus, LoadCarrierRecord, LoadWorkflowStatus, ShipmentBundle, ShipmentLoad, ShipmentMode, ShipmentRecord,
} from '@/types/tms'

/**
 * UNPAID and PAID are written by invoicing, never set by hand. UNBILLED is not here
 * either: Ready to invoice is the document gate and lives on the AR card, so this menu
 * only holds the two values a person genuinely decides.
 */
const SETTABLE_AR_STATUSES = ['DOCS_NEEDED', 'INVOICE_NOT_NEEDED'] as const

/**
 * Why an assignment ended. A bounce is the carrier falling off and keeping nothing; a
 * TONU is the truck showing up to nothing and being paid for it — so the two lists are
 * different questions, not two spellings of one.
 */
const BOUNCE_REASONS: { value: RemoveLoadCarrierReason; label: string }[] = [
  { value: 'CARRIER_CANNOT_TAKE', label: 'Carrier cannot take it' },
  { value: 'GAVE_BACK', label: 'Carrier gave it back' },
  { value: 'REJECTED_RATE_CON', label: 'Rejected the rate con' },
  { value: 'OTHER', label: 'Other' },
]
const TONU_REASONS: { value: RemoveLoadCarrierReason; label: string }[] = [
  { value: 'CUSTOMER_NOT_READY', label: 'Customer not ready' },
  { value: 'CONSIGNEE_NOT_READY', label: 'Consignee not ready' },
  { value: 'FORGOT_TO_BOUNCE', label: 'Forgot to bounce' },
  { value: 'OTHER', label: 'Other' },
]

/** A removal note is a sentence for the next booker, not a file. */
const REMOVAL_NOTE_MAX = 250

export interface ShipmentActionHandlers {
  onDuplicate: (copies: { pickupAppt: string; deliveryAppt: string }[], sameCarrier: boolean) => Promise<void>
  onSetStatus: (status: 'ON_HOLD' | 'OPEN' | 'CANCELED' | 'UNCANCEL', reason?: string) => Promise<void>
  onDelete: () => Promise<void>
  onRestore: () => Promise<void>
  onTenderRespond: (decision: 'ACCEPT' | 'REJECT' | 'RESET', reason?: string) => Promise<void>
}

type ShipmentDialog =
  | { kind: 'duplicate' }
  | { kind: 'reason'; title: string; label: string; required: boolean; run: (reason: string) => Promise<void> }
  | null

export function ShipmentRowActions({ shipment, isAdmin, cancelDeleteAdminOnly, handlers, align = 'end' }: {
  shipment: Pick<ShipmentRecord, 'id' | 'status' | 'deletedAt' | 'pickupAppt' | 'deliveryAppt'>
  isAdmin: boolean
  cancelDeleteAdminOnly: boolean
  handlers: ShipmentActionHandlers
  align?: 'start' | 'end'
}) {
  const [dialog, setDialog] = useState<ShipmentDialog>(null)
  const [busy, setBusy] = useState(false)

  const status = shipment.status
  const mayCancelOrDelete = isAdmin || !cancelDeleteAdminOnly
  const deletable = status === 'DRAFT' || status === 'CANCELED' || status === 'TENDER_REJECTED'

  // The handler has already toasted whatever went wrong; swallowing it here keeps the
  // dialog open on failure and stops Radix's `onSelect`/`onConfirm` — which ignore the
  // returned promise — from producing an unhandled rejection.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); setDialog(null) } catch { /* already reported */ } finally { setBusy(false) }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Shipment actions" onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-56" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuLabel>Shipment</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setDialog({ kind: 'duplicate' })}>
            <Copy size={14} className="mr-2" />Duplicate
          </DropdownMenuItem>

          {status === 'TENDER_PENDING' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => run(() => handlers.onTenderRespond('ACCEPT'))}>
                <Check size={14} className="mr-2" />Accept tender
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog({
                kind: 'reason', title: 'Reject tender', label: 'Reason', required: true,
                run: (reason) => handlers.onTenderRespond('REJECT', reason),
              })}>
                <X size={14} className="mr-2" />Reject tender
              </DropdownMenuItem>
            </>
          )}
          {status === 'TENDER_REJECTED' && (
            <DropdownMenuItem onSelect={() => run(() => handlers.onTenderRespond('RESET'))}>
              <RotateCcw size={14} className="mr-2" />Reset tender
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          {status === 'ON_HOLD' ? (
            <DropdownMenuItem onSelect={() => run(() => handlers.onSetStatus('OPEN'))}>
              <PlayCircle size={14} className="mr-2" />Take off hold
            </DropdownMenuItem>
          ) : status !== 'CANCELED' && status !== 'DRAFT' && (
            <DropdownMenuItem onSelect={() => setDialog({
              kind: 'reason', title: 'Put on hold', label: 'Reason', required: false,
              run: (reason) => handlers.onSetStatus('ON_HOLD', reason),
            })}>
              <PauseCircle size={14} className="mr-2" />Put on hold
            </DropdownMenuItem>
          )}

          {status === 'CANCELED' ? (
            <DropdownMenuItem disabled={!mayCancelOrDelete} onSelect={() => run(() => handlers.onSetStatus('UNCANCEL'))}>
              <RotateCcw size={14} className="mr-2" />Un-cancel
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={!mayCancelOrDelete} onSelect={() => setDialog({
              kind: 'reason', title: 'Cancel shipment', label: 'Reason', required: true,
              run: (reason) => handlers.onSetStatus('CANCELED', reason),
            })}>
              <Ban size={14} className="mr-2" />Cancel
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          {shipment.deletedAt ? (
            <DropdownMenuItem disabled={!isAdmin} onSelect={() => run(handlers.onRestore)}>
              <RotateCcw size={14} className="mr-2" />Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className="text-destructive"
              disabled={!deletable || !mayCancelOrDelete}
              onSelect={() => run(handlers.onDelete)}
            >
              <Trash2 size={14} className="mr-2" />Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog?.kind === 'reason' && (
        <ReasonDialog
          title={dialog.title}
          label={dialog.label}
          required={dialog.required}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => run(() => dialog.run(reason))}
        />
      )}
      {dialog?.kind === 'duplicate' && (
        <DuplicateDialog
          pickupAppt={shipment.pickupAppt ?? null}
          deliveryAppt={shipment.deliveryAppt ?? null}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(copies, sameCarrier) => run(() => handlers.onDuplicate(copies, sameCarrier))}
        />
      )}
    </>
  )
}

export interface LoadActionHandlers {
  onSetLoadStatus: (status: LoadWorkflowStatus) => Promise<void>
  onAssignAsset: (input: { driverId: string; truckId?: string; trailerId?: string }) => Promise<void>
  onAssignCarrier: (input: {
    carrierName: string; carrierMc?: string; dispatcherName?: string; dispatcherPhone?: string
    driverName?: string; driverPhone?: string; carrierRateCents?: number
  }) => Promise<void>
  /** A directory carrier: everything the gate checks, acknowledged warnings included. */
  onBookCarrier: (input: BookCarrierFields) => Promise<void>
  onRemoveCarrier: (
    loadCarrierId: string, outcome: 'BOUNCED' | 'TONU', reason: RemoveLoadCarrierReason, note?: string,
  ) => Promise<void>
  onSetArStatus: (status: 'DOCS_NEEDED' | 'INVOICE_NOT_NEEDED') => Promise<void>
}

type LoadDialog =
  | { kind: 'asset' } | { kind: 'carrier' } | { kind: 'book' } | { kind: 'remove'; outcome: 'BOUNCED' | 'TONU' } | null

export function LoadActions({
  load, mode, bundle, activeCarrier, drivers, trucks, trailers, arStatus, isAdmin, handlers, onRateCon,
}: {
  load: ShipmentLoad
  mode: ShipmentMode
  bundle: ShipmentBundle
  activeCarrier: LoadCarrierRecord | null
  drivers: Driver[]
  trucks: Equipment[]
  trailers: Equipment[]
  arStatus: ArStatus | null
  isAdmin: boolean
  handlers: LoadActionHandlers
  /** The booker asked for the rate con straight after booking. */
  onRateCon: () => void
}) {
  const [dialog, setDialog] = useState<LoadDialog>(null)
  const [busy, setBusy] = useState(false)
  const nextStatuses = load.status ? nextLoadStatuses(load.status, mode) : []
  // BOOK_CARRIER is the truckload path and only exists while the load is still being
  // covered; everything else keeps the name-only assignment it always had.
  const bookable = load.status === 'SOURCING' && isTruckloadMode(mode) && !activeCarrier

  // An issued invoice owns the AR rung: the card voids it, this menu does not move it.
  const order = bundle.orders[0] ?? null
  const invoiced = Boolean(order?.invoiceId)

  // Same contract as the shipment menu: the error is already on screen as a toast.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); setDialog(null) } catch { /* already reported */ } finally { setBusy(false) }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Load actions">
            Actions <MoreHorizontal size={14} className="ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Assignment</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setDialog({ kind: 'asset' })}>
            <Truck size={14} className="mr-2" />Assign own asset
          </DropdownMenuItem>
          {bookable && (
            <DropdownMenuItem onSelect={() => setDialog({ kind: 'book' })}>
              <FileSignature size={14} className="mr-2" />Book carrier
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setDialog({ kind: 'carrier' })}>
            <Building2 size={14} className="mr-2" />Assign carrier (name only)
          </DropdownMenuItem>
          {activeCarrier && (
            <>
              <DropdownMenuItem onSelect={() => setDialog({ kind: 'remove', outcome: 'BOUNCED' })}>
                <UserMinus size={14} className="mr-2" />Bounce carrier
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog({ kind: 'remove', outcome: 'TONU' })}>
                <UserMinus size={14} className="mr-2" />Report TONU
              </DropdownMenuItem>
            </>
          )}

          {nextStatuses.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Move load to</DropdownMenuLabel>
              {nextStatuses.map((s) => (
                <DropdownMenuItem key={s} onSelect={() => run(() => handlers.onSetLoadStatus(s))}>
                  {LOAD_WORKFLOW_STATUS_LABELS[s]}
                </DropdownMenuItem>
              ))}
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>AR status</DropdownMenuLabel>
          {invoiced && (
            <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">
              Invoice {order?.invoiceNumber ?? order?.invoiceId} is issued — void the invoice first.
            </DropdownMenuLabel>
          )}
          {SETTABLE_AR_STATUSES.map((s) => (
            <DropdownMenuItem
              key={s}
              disabled={arStatus === s || busy || invoiced}
              title={invoiced ? 'void the invoice first' : undefined}
              onSelect={() => run(() => handlers.onSetArStatus(s))}
            >
              {s.replace(/_/g, ' ').toLowerCase()}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog?.kind === 'asset' && (
        <AssignAssetDialog
          drivers={drivers} trucks={trucks} trailers={trailers} busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(input) => run(() => handlers.onAssignAsset(input))}
        />
      )}
      {dialog?.kind === 'carrier' && (
        <AssignCarrierDialog
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(input) => run(() => handlers.onAssignCarrier(input))}
        />
      )}
      {dialog?.kind === 'book' && (
        <BookCarrierDialog
          bundle={bundle}
          isAdmin={isAdmin}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(input) => handlers.onBookCarrier(input)}
          onRateCon={onRateCon}
        />
      )}
      {dialog?.kind === 'remove' && activeCarrier && (
        <RemoveCarrierDialog
          outcome={dialog.outcome}
          loadCarrier={activeCarrier}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason, note) => run(() => handlers.onRemoveCarrier(activeCarrier.id, dialog.outcome, reason, note))}
        />
      )}
    </>
  )
}

function ReasonDialog({ title, label, required, busy, onClose, onConfirm }: {
  title: string
  label: string
  required: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}{required ? '' : ' (optional)'}</Label>
          <Textarea aria-label={label} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="text-sm" />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => {
              if (required && !reason.trim()) { setError('A reason is required.'); return }
              onConfirm(reason.trim())
            }}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Up to 20 copies, each with its own pickup and delivery date (spec §6.4 "Duplicate"). */
function DuplicateDialog({ pickupAppt, deliveryAppt, busy, onClose, onConfirm }: {
  pickupAppt: string | null
  deliveryAppt: string | null
  busy: boolean
  onClose: () => void
  onConfirm: (copies: { pickupAppt: string; deliveryAppt: string }[], sameCarrier: boolean) => void
}) {
  const [count, setCount] = useState(1)
  const [pickup, setPickup] = useState(pickupAppt ? formatDateTimeInput(pickupAppt) : '')
  const [delivery, setDelivery] = useState(deliveryAppt ? formatDateTimeInput(deliveryAppt) : '')
  const [sameCarrier, setSameCarrier] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Duplicate shipment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Copies</Label>
            <Input aria-label="Copies" type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Pickup</Label>
            <Input aria-label="Duplicate pickup" type="datetime-local" value={pickup} onChange={(e) => setPickup(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Delivery</Label>
            <Input aria-label="Duplicate delivery" type="datetime-local" value={delivery} onChange={(e) => setDelivery(e.target.value)} className="h-9 text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sameCarrier} onChange={(e) => setSameCarrier(e.target.checked)} /> Book the same carrier
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => {
              if (count < 1 || count > 20) { setError('Between 1 and 20 copies.'); return }
              if (!pickup || !delivery) { setError('Both dates are required.'); return }
              onConfirm(
                Array.from({ length: count }, () => ({ pickupAppt: fromDateTimeInput(pickup), deliveryAppt: fromDateTimeInput(delivery) })),
                sameCarrier,
              )
            }}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Duplicate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssignAssetDialog({ drivers, trucks, trailers, busy, onClose, onConfirm }: {
  drivers: Driver[]
  trucks: Equipment[]
  trailers: Equipment[]
  busy: boolean
  onClose: () => void
  onConfirm: (input: { driverId: string; truckId?: string; trailerId?: string }) => void
}) {
  const [driverId, setDriverId] = useState('')
  const [truckId, setTruckId] = useState('')
  const [trailerId, setTrailerId] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Assign own asset</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Driver</Label>
            <select aria-label="Driver" value={driverId} onChange={(e) => setDriverId(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">— select —</option>
              {drivers.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Truck</Label>
            <select aria-label="Truck" value={truckId} onChange={(e) => setTruckId(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">— none —</option>
              {trucks.map((t) => <option key={t.id} value={t.id}>{t.unitNumber}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Trailer</Label>
            <select aria-label="Trailer" value={trailerId} onChange={(e) => setTrailerId(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">— none —</option>
              {trailers.map((t) => <option key={t.id} value={t.id}>{t.unitNumber}</option>)}
            </select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => {
              if (!driverId) { setError('Pick a driver.'); return }
              onConfirm({ driverId, truckId: truckId || undefined, trailerId: trailerId || undefined })
            }}
            disabled={busy}
          >
            {busy ? 'Assigning…' : 'Assign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AssignCarrierDialog({ busy, onClose, onConfirm }: {
  busy: boolean
  onClose: () => void
  onConfirm: (input: {
    carrierName: string; carrierMc?: string; dispatcherName?: string; dispatcherPhone?: string
    driverName?: string; driverPhone?: string; carrierRateCents?: number
  }) => void
}) {
  const [carrierName, setCarrierName] = useState('')
  const [carrierMc, setCarrierMc] = useState('')
  const [dispatcherName, setDispatcherName] = useState('')
  const [dispatcherPhone, setDispatcherPhone] = useState('')
  const [driverName, setDriverName] = useState('')
  const [driverPhone, setDriverPhone] = useState('')
  const [rateCents, setRateCents] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Assign carrier</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Carrier name</Label>
            <Input aria-label="Carrier name" value={carrierName} onChange={(e) => setCarrierName(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">MC #</Label>
            <Input aria-label="Carrier MC" value={carrierMc} onChange={(e) => setCarrierMc(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Dispatcher</Label>
            <Input aria-label="Dispatcher name" value={dispatcherName} onChange={(e) => setDispatcherName(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Dispatcher phone</Label>
            <Input aria-label="Dispatcher phone" value={dispatcherPhone} onChange={(e) => setDispatcherPhone(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Driver</Label>
            <Input aria-label="Carrier driver name" value={driverName} onChange={(e) => setDriverName(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Driver phone</Label>
            <Input aria-label="Carrier driver phone" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} className="h-9 text-sm" />
          </div>
          <div className="col-span-2">
            <MoneyField label="Carrier rate" value={rateCents} onChange={setRateCents} />
          </div>
          {error && <p className="col-span-2 text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => {
              if (!carrierName.trim()) { setError('Carrier name is required.'); return }
              if (rateCents != null && rateCents < 0) { setError('Carrier rate cannot be negative.'); return }
              onConfirm({
                carrierName: carrierName.trim(),
                carrierMc: carrierMc.trim() || undefined,
                dispatcherName: dispatcherName.trim() || undefined,
                dispatcherPhone: dispatcherPhone.trim() || undefined,
                driverName: driverName.trim() || undefined,
                driverPhone: driverPhone.trim() || undefined,
                carrierRateCents: rateCents ?? undefined,
              })
            }}
            disabled={busy}
          >
            {busy ? 'Booking…' : 'Assign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Ending an assignment. The reason is a code rather than a sentence because the next
 * booker reads it as carrier history — and because bounce and TONU answer different
 * questions. The note is the colour, capped so it stays a note.
 *
 * A TONU keeps the carrier's money; a bounce takes the charges away with it.
 */
export function RemoveCarrierDialog({ outcome, loadCarrier, busy, onClose, onConfirm }: {
  outcome: 'BOUNCED' | 'TONU'
  loadCarrier: LoadCarrierRecord
  busy: boolean
  onClose: () => void
  onConfirm: (reason: RemoveLoadCarrierReason, note?: string) => void
}) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const options = outcome === 'TONU' ? TONU_REASONS : BOUNCE_REASONS

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{outcome === 'TONU' ? 'Report TONU' : 'Bounce carrier'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Reason</Label>
            <select
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">— select —</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Note (optional)</Label>
            <Textarea
              aria-label="Note"
              rows={3}
              maxLength={REMOVAL_NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="text-sm"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">{note.length}/{REMOVAL_NOTE_MAX}</p>
          </div>
          {outcome === 'TONU' && (
            <p className="rounded-lg border border-border bg-muted/30 p-2 text-xs">
              The carrier keeps ${formatCents(loadCarrier.carrierRateCents ?? 0)} — the cost line stays on the load.
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => {
              if (!reason) { setError('Pick a reason.'); return }
              onConfirm(reason as RemoveLoadCarrierReason, note.trim() || undefined)
            }}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
