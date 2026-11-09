/**
 * The action menus: what a user can do to a shipment from a board row or the drawer
 * header, and what they can do to one of its loads.
 *
 * Which items appear is decided here from the status alone; whether the action is
 * *allowed* is decided by the Lambda. Hiding an item the server would refuse keeps the
 * menu honest, but nothing here is a security boundary.
 *
 * A PRO number is never reused. Staff can void; owners can delete after an export.
 * Unvoid and customer re-point remain owner/ADMIN actions, enforced on the server.
 */
import { useContext, useState } from 'react'
import { MoreHorizontal, Copy, PauseCircle, PlayCircle, Ban, RotateCcw, Check, X, Truck, Building2, UserMinus, FileSignature, UserCog, Trash2 } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { AuthContext } from '@/hooks/useAuth'
import { nextLoadStatuses, LOAD_WORKFLOW_STATUS_LABELS, isTruckloadMode } from '@/lib/shipmentStatus'
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { formatCents } from '@/lib/tmsDirectory'
import { BookCarrierDialog, type BookCarrierFields } from '@/features/carriers/components/BookCarrierDialog'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { TmsButton, TmsDialog, TmsField, TmsIconButton, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { type RemoveLoadCarrierReason } from '@/lib/apiClient'
import { liveCarriersOf } from '@/lib/carrierTotals'
import { MAX_LIVE_CARRIERS } from '@/lib/carrierLegs'
import { VoidShipmentDialog } from './VoidShipmentDialog'
import { DeleteShipmentsDialog } from './DeleteShipmentsDialog'
import { AssignDriverDialog, type AssignDriverFields } from './AssignDriverDialog'
import { OWN_ASSET_MESSAGES } from '@/lib/ownAssetDriver'
import { isIvanCartageName } from '@/lib/ownFleetDrivers'
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
  onDuplicate: (copies: { pickupAppt: string; deliveryAppt: string }[]) => Promise<void>
  onSetStatus: (status: 'ON_HOLD' | 'OPEN' | 'CANCELED' | 'UNCANCEL', reason?: string) => Promise<void>
  /** The void dialog does the call; this swaps the voided bundle in. */
  onVoid: (bundle: ShipmentBundle) => void
  onTenderRespond: (decision: 'ACCEPT' | 'REJECT' | 'RESET', reason?: string) => Promise<void>
  onUnvoid?: () => void
  onRepointCustomer?: () => void
  /** Step AM: open the Cover dialog for this shipment (the board offers it only for a load that needs a carrier). */
  onCover?: () => void
}

/** Everything the row menu needs to read, including what the void dialog stamps. */
export type ShipmentActionTarget =
  Pick<ShipmentRecord, 'id' | 'number' | 'status' | 'updatedAt' | 'pickupAppt' | 'deliveryAppt'>
  & Partial<Pick<ShipmentRecord, 'voidedAt'>>

type ShipmentDialog =
  | { kind: 'duplicate' }
  | { kind: 'void' }
  | { kind: 'delete' }
  | { kind: 'reason'; title: string; label: string; required: boolean; run: (reason: string) => Promise<void> }
  | null

export function ShipmentRowActions({ shipment, isAdmin, cancelDeleteAdminOnly, handlers, onDeleted, align = 'end' }: {
  shipment: ShipmentActionTarget
  isAdmin: boolean
  cancelDeleteAdminOnly: boolean
  handlers: ShipmentActionHandlers
  /** Offers the owner's hard Delete; called after rows were deleted so the host can leave the shipment. */
  onDeleted?: (outcome: { restored: boolean }) => void
  align?: 'start' | 'end'
}) {
  const [dialog, setDialog] = useState<ShipmentDialog>(null)
  const [busy, setBusy] = useState(false)

  // Same optional read as `useAuthUser`: row menus render in lists, drawers and tests
  // that do not always sit under AuthProvider, and the router is the real gate.
  const auth = useContext(AuthContext)
  // Void is every staff member's; unvoid, re-point and delete are not (the Lambda decides each).
  const mayManage = isAdmin || (auth?.isOwner ?? false)
  const mayDelete = (auth?.isOwner ?? false) && onDeleted != null

  const status = shipment.status
  const voided = Boolean(shipment.voidedAt)
  const mayCancel = isAdmin || !cancelDeleteAdminOnly

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
          <TmsIconButton aria-label="Shipment actions" onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal size={14} />
          </TmsIconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="tms-portal w-56" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuLabel>Shipment</DropdownMenuLabel>
          {handlers.onCover && (
            <DropdownMenuItem disabled={voided} data-testid="row-cover" onSelect={() => handlers.onCover?.()}>
              <Building2 size={14} className="mr-2" />Cover…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={voided} onSelect={() => setDialog({ kind: 'duplicate' })}>
            <Copy size={14} className="mr-2" />Duplicate
          </DropdownMenuItem>

          {status === 'TENDER_PENDING' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={voided} onSelect={() => run(() => handlers.onTenderRespond('ACCEPT'))}>
                <Check size={14} className="mr-2" />Accept tender
              </DropdownMenuItem>
              <DropdownMenuItem disabled={voided} onSelect={() => setDialog({
                kind: 'reason', title: 'Reject tender', label: 'Reason', required: true,
                run: (reason) => handlers.onTenderRespond('REJECT', reason),
              })}>
                <X size={14} className="mr-2" />Reject tender
              </DropdownMenuItem>
            </>
          )}
          {status === 'TENDER_REJECTED' && (
            <DropdownMenuItem disabled={voided} onSelect={() => run(() => handlers.onTenderRespond('RESET'))}>
              <RotateCcw size={14} className="mr-2" />Reset tender
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          {status === 'ON_HOLD' ? (
            <DropdownMenuItem disabled={voided} onSelect={() => run(() => handlers.onSetStatus('OPEN'))}>
              <PlayCircle size={14} className="mr-2" />Take off hold
            </DropdownMenuItem>
          ) : status !== 'CANCELED' && status !== 'DRAFT' && (
            <DropdownMenuItem disabled={voided} onSelect={() => setDialog({
              kind: 'reason', title: 'Put on hold', label: 'Reason', required: false,
              run: (reason) => handlers.onSetStatus('ON_HOLD', reason),
            })}>
              <PauseCircle size={14} className="mr-2" />Put on hold
            </DropdownMenuItem>
          )}

          {status === 'CANCELED' ? (
            <DropdownMenuItem disabled={voided || !mayCancel} onSelect={() => run(() => handlers.onSetStatus('UNCANCEL'))}>
              <RotateCcw size={14} className="mr-2" />Un-cancel
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={voided || !mayCancel} onSelect={() => setDialog({
              kind: 'reason', title: 'Cancel shipment', label: 'Reason', required: true,
              run: (reason) => handlers.onSetStatus('CANCELED', reason),
            })}>
              <Ban size={14} className="mr-2" />Cancel
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          {voided && mayManage && handlers.onUnvoid && (
            <DropdownMenuItem onSelect={() => handlers.onUnvoid?.()}>
              <RotateCcw size={14} className="mr-2" />Unvoid shipment…
            </DropdownMenuItem>
          )}
          {!voided && (
            <DropdownMenuItem
              className="text-[color:var(--tms-badge-red)]"
              onSelect={() => setDialog({ kind: 'void' })}
            >
              <Ban size={14} className="mr-2" />Void shipment…
            </DropdownMenuItem>
          )}
          {mayManage && handlers.onRepointCustomer && (
            <DropdownMenuItem onSelect={() => handlers.onRepointCustomer?.()}>
              <UserCog size={14} className="mr-2" />Re-point customer…
            </DropdownMenuItem>
          )}
          {mayDelete && (
            <DropdownMenuItem
              className="text-[color:var(--tms-badge-red)]"
              onSelect={() => setDialog({ kind: 'delete' })}
            >
              <Trash2 size={14} className="mr-2" />Delete shipment…
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
          onConfirm={(copies) => run(() => handlers.onDuplicate(copies))}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteShipmentsDialog
          shipments={[{ id: shipment.id, number: shipment.number }]}
          onClose={() => setDialog(null)}
          onDeleted={(outcome) => onDeleted?.(outcome)}
        />
      )}
      {dialog?.kind === 'void' && (
        <VoidShipmentDialog
          shipment={{ id: shipment.id, number: shipment.number, updatedAt: shipment.updatedAt }}
          open
          onClose={() => setDialog(null)}
          onVoided={(bundle) => { handlers.onVoid(bundle); setDialog(null) }}
        />
      )}
    </>
  )
}

export interface LoadActionHandlers {
  onSetLoadStatus: (status: LoadWorkflowStatus) => Promise<void>
  onAssignAsset: (input: AssignDriverFields) => Promise<void>
  onAssignCarrier: (input: {
    carrierName: string; carrierMc?: string; dispatcherName?: string; dispatcherPhone?: string
    driverName?: string; driverPhone?: string; carrierRateCents?: number
  }) => Promise<void>
  /** A directory carrier: everything the gate checks, acknowledged warnings included. */
  onBookCarrier: (input: BookCarrierFields) => Promise<void>
  /** AT-plan: another outside carrier beside the live ones; `legStopIds` absent = every stop. */
  onAddCarrier?: (input: BookCarrierFields, legStopIds?: string[]) => Promise<void>
  onRemoveCarrier: (
    loadCarrierId: string, outcome: 'BOUNCED' | 'TONU', reason: RemoveLoadCarrierReason, note?: string,
    /** Step AM: put the freed load back on DAT. Optional, off unless the rep ticks it. */
    repostToDat?: boolean,
  ) => Promise<void>
  onSetArStatus: (status: 'DOCS_NEEDED' | 'INVOICE_NOT_NEEDED') => Promise<void>
  /** Step AM: the Cover dialog assigned a carrier; re-read the shipment. */
  onCovered?: () => Promise<void>
}

type LoadDialog =
  | { kind: 'asset' } | { kind: 'carrier' } | { kind: 'book' } | { kind: 'add' } | { kind: 'cover' } | { kind: 'remove'; outcome: 'BOUNCED' | 'TONU' } | null

export function LoadActions({
  load, mode, bundle, activeCarrier, drivers, trucks, trailers, arStatus, isAdmin, voided = false, handlers, onRateCon, onError,
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
  /** A voided shipment is read-only: every item stays visible and every item is off. */
  voided?: boolean
  handlers: LoadActionHandlers
  /** The booker asked for the rate con straight after booking. */
  onRateCon: () => void
  /** A refused "Move load to…" lands here as the server's own sentence. */
  onError?: (message: string) => void
}) {
  const [dialog, setDialog] = useState<LoadDialog>(null)
  const ownLeg = activeCarrier?.kind === 'OWN_ASSET'
  const [busy, setBusy] = useState(false)
  const nextStatuses = load.status ? nextLoadStatuses(load.status, mode) : []
  // BOOK_CARRIER is the truckload path and only exists while the load is still being
  // covered; everything else keeps the name-only assignment it always had.
  const bookable = load.status === 'SOURCING' && isTruckloadMode(mode) && !activeCarrier
  // AT-plan: a second (third, fourth) outside carrier joins the live one; own fleet stays exclusive (D2).
  const liveCount = liveCarriersOf(bundle.loadCarriers, load.id).length
  const addable = isTruckloadMode(mode) && !ownLeg && liveCount > 0 && liveCount < MAX_LIVE_CARRIERS
    && (load.status === 'SOURCING' || load.status === 'BOOKED' || load.status === 'DISPATCHED')

  // An issued invoice owns the AR rung: the card voids it, this menu does not move it.
  const order = bundle.orders[0] ?? null
  const invoiced = Boolean(order?.invoiceId)

  // Same contract as the shipment menu: the error is already on screen as a toast.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); setDialog(null) } catch { /* already reported */ } finally { setBusy(false) }
  }
  // A status move is refused with a sentence the user must read (e.g. the Ivan Cartage
  // driver gate), so it is handed to the detail to show inline instead of a toast.
  const runStatus = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } catch (err) {
      onError?.(err instanceof Error ? err.message : 'The load status could not be changed.')
    } finally { setBusy(false) }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TmsButton size="sm" aria-label="Load actions">
            Actions <MoreHorizontal size={14} className="ml-1" />
          </TmsButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="tms-portal w-60">
          <DropdownMenuLabel>Assignment</DropdownMenuLabel>
          <DropdownMenuItem disabled={voided} onSelect={() => setDialog({ kind: 'asset' })}>
            <Truck size={14} className="mr-2" />{ownLeg ? 'Change driver…' : 'Book Ivan Cartage (own fleet)'}
          </DropdownMenuItem>
          {bookable && (
            <DropdownMenuItem disabled={voided} onSelect={() => setDialog({ kind: 'cover' })}>
              <Building2 size={14} className="mr-2" />Cover…
            </DropdownMenuItem>
          )}
          {bookable && (
            <DropdownMenuItem disabled={voided} onSelect={() => setDialog({ kind: 'book' })}>
              <FileSignature size={14} className="mr-2" />Book carrier
            </DropdownMenuItem>
          )}
          {/* Step AM: a carrier typed in by name never went through MyCarrierPackets, so only an admin can data-fix one. */}
          {isAdmin && (
            <DropdownMenuItem disabled={voided} onSelect={() => setDialog({ kind: 'carrier' })}>
              <Building2 size={14} className="mr-2" />Assign carrier by name (admin data fix)
            </DropdownMenuItem>
          )}
          {addable && (
            <DropdownMenuItem disabled={voided} data-testid="menu-add-carrier" onSelect={() => setDialog({ kind: 'add' })}>
              <Building2 size={14} className="mr-2" />Add carrier
            </DropdownMenuItem>
          )}
          {activeCarrier && (
            <>
              <DropdownMenuItem disabled={voided} onSelect={() => setDialog({ kind: 'remove', outcome: 'BOUNCED' })}>
                <UserMinus size={14} className="mr-2" />Bounce carrier
              </DropdownMenuItem>
              <DropdownMenuItem disabled={voided} onSelect={() => setDialog({ kind: 'remove', outcome: 'TONU' })}>
                <UserMinus size={14} className="mr-2" />Report TONU
              </DropdownMenuItem>
            </>
          )}

          {nextStatuses.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Move load to</DropdownMenuLabel>
              {nextStatuses.map((s) => (
                <DropdownMenuItem key={s} disabled={voided} onSelect={() => runStatus(() => handlers.onSetLoadStatus(s))}>
                  {LOAD_WORKFLOW_STATUS_LABELS[s]}
                </DropdownMenuItem>
              ))}
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>AR status</DropdownMenuLabel>
          {invoiced && (
            <DropdownMenuLabel className="text-xs font-normal tms-muted">
              Invoice {order?.invoiceNumber ?? order?.invoiceId} is issued — void the invoice first.
            </DropdownMenuLabel>
          )}
          {SETTABLE_AR_STATUSES.map((s) => (
            <DropdownMenuItem
              key={s}
              disabled={voided || arStatus === s || busy || invoiced}
              title={invoiced ? 'void the invoice first' : undefined}
              onSelect={() => run(() => handlers.onSetArStatus(s))}
            >
              {s.replace(/_/g, ' ').toLowerCase()}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog?.kind === 'asset' && (
        <AssignDriverDialog
          load={load} activeLeg={activeCarrier} drivers={drivers} trucks={trucks} trailers={trailers}
          isAdmin={isAdmin} busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={handlers.onAssignAsset}
        />
      )}
      {dialog?.kind === 'carrier' && (
        <AssignCarrierDialog
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(input) => run(() => handlers.onAssignCarrier(input))}
        />
      )}
      {dialog?.kind === 'cover' && (
        <CoverCarrierDialog
          shipmentId={bundle.shipment.id}
          shipmentNumber={bundle.shipment.number}
          bundle={bundle}
          onClose={() => setDialog(null)}
          onCovered={() => { void handlers.onCovered?.() }}
        />
      )}
      {(dialog?.kind === 'book' || dialog?.kind === 'add') && (
        <BookCarrierDialog
          bundle={bundle}
          isAdmin={isAdmin}
          busy={busy}
          additional={dialog.kind === 'add'}
          onClose={() => setDialog(null)}
          onConfirm={(input, legStopIds) => (dialog.kind === 'add' && handlers.onAddCarrier
            ? handlers.onAddCarrier(input, legStopIds)
            : handlers.onBookCarrier(input))}
          onRateCon={onRateCon}
        />
      )}
      {dialog?.kind === 'remove' && activeCarrier && (
        <RemoveCarrierDialog
          outcome={dialog.outcome}
          loadCarrier={activeCarrier}
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason, note, repostToDat) => run(() => handlers.onRemoveCarrier(activeCarrier.id, dialog.outcome, reason, note, repostToDat))}
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
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={title}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            onClick={() => {
              if (required && !reason.trim()) { setError('A reason is required.'); return }
              onConfirm(reason.trim())
            }}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Confirm'}
          </TmsButton>
        </>
      }
    >
      <TmsField label={`${label}${required ? '' : ' (optional)'}`} error={error}>
        <TmsTextarea aria-label={label} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </TmsField>
    </TmsDialog>
  )
}

/** Up to 20 copies, each with its own pickup and delivery date (spec §6.4 "Duplicate"). */
function DuplicateDialog({ pickupAppt, deliveryAppt, busy, onClose, onConfirm }: {
  pickupAppt: string | null
  deliveryAppt: string | null
  busy: boolean
  onClose: () => void
  onConfirm: (copies: { pickupAppt: string; deliveryAppt: string }[]) => void
}) {
  const [count, setCount] = useState(1)
  const [pickup, setPickup] = useState(pickupAppt ? formatDateTimeInput(pickupAppt) : '')
  const [delivery, setDelivery] = useState(deliveryAppt ? formatDateTimeInput(deliveryAppt) : '')
  const [error, setError] = useState<string | null>(null)

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Duplicate shipment"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            onClick={() => {
              if (count < 1 || count > 20) { setError('Between 1 and 20 copies.'); return }
              if (!pickup || !delivery) { setError('Both dates are required.'); return }
              onConfirm(
                Array.from({ length: count }, () => ({ pickupAppt: fromDateTimeInput(pickup), deliveryAppt: fromDateTimeInput(delivery) })),
              )
            }}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Duplicate'}
          </TmsButton>
        </>
      }
    >
      <div className="space-y-3">
        <TmsField label="Copies">
          <TmsInput aria-label="Copies" type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </TmsField>
        <TmsField label="Pickup">
          <TmsInput aria-label="Duplicate pickup" type="datetime-local" value={pickup} onChange={(e) => setPickup(e.target.value)} />
        </TmsField>
        <TmsField label="Delivery">
          <TmsInput aria-label="Duplicate delivery" type="datetime-local" value={delivery} onChange={(e) => setDelivery(e.target.value)} />
        </TmsField>
        {error && <p className="tms-field-error">{error}</p>}
      </div>
    </TmsDialog>
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
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Assign carrier"
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            onClick={() => {
              if (!carrierName.trim()) { setError('Carrier name is required.'); return }
              if (isIvanCartageName(carrierName)) { setError(OWN_ASSET_MESSAGES.typedIvanCartage); return }
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
          </TmsButton>
        </>
      }
    >
      <div className="tms-grid tms-grid-2">
        <TmsField label="Carrier name" className="col-span-2">
          <TmsInput aria-label="Carrier name" value={carrierName} onChange={(e) => setCarrierName(e.target.value)} />
        </TmsField>
        <TmsField label="MC #">
          <TmsInput aria-label="Carrier MC" value={carrierMc} onChange={(e) => setCarrierMc(e.target.value)} />
        </TmsField>
        <TmsField label="Dispatcher">
          <TmsInput aria-label="Dispatcher name" value={dispatcherName} onChange={(e) => setDispatcherName(e.target.value)} />
        </TmsField>
        <TmsField label="Dispatcher phone">
          <TmsInput aria-label="Dispatcher phone" value={dispatcherPhone} onChange={(e) => setDispatcherPhone(e.target.value)} />
        </TmsField>
        <TmsField label="Driver">
          <TmsInput aria-label="Carrier driver name" value={driverName} onChange={(e) => setDriverName(e.target.value)} />
        </TmsField>
        <TmsField label="Driver phone">
          <TmsInput aria-label="Carrier driver phone" value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} />
        </TmsField>
        <div className="col-span-2">
          <MoneyField label="Carrier rate" value={rateCents} onChange={setRateCents} />
        </div>
        {error && <p className="col-span-2 tms-field-error">{error}</p>}
      </div>
    </TmsDialog>
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
  onConfirm: (reason: RemoveLoadCarrierReason, note?: string, repostToDat?: boolean) => void
}) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  // Step AM: re-posting the freed load to DAT is a choice, never a default.
  const [repost, setRepost] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options = outcome === 'TONU' ? TONU_REASONS : BOUNCE_REASONS

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={outcome === 'TONU' ? 'Report TONU' : 'Bounce carrier'}
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton
            variant="primary"
            onClick={() => {
              if (!reason) { setError('Pick a reason.'); return }
              onConfirm(reason as RemoveLoadCarrierReason, note.trim() || undefined, repost)
            }}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Confirm'}
          </TmsButton>
        </>
      }
    >
      <div className="space-y-3">
        <TmsField label="Reason" error={error}>
          <TmsSelect aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">— select —</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Note (optional)" hint={`${note.length}/${REMOVAL_NOTE_MAX}`}>
          <TmsTextarea
            aria-label="Note"
            rows={3}
            maxLength={REMOVAL_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </TmsField>
        <p className="tms-muted text-xs" data-testid="remove-carrier-effect">
          The load goes back to Open. {loadCarrier.carrierName ?? 'The carrier'} stays in the load’s history.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={repost}
            onChange={(e) => setRepost(e.target.checked)}
            disabled={busy}
            aria-label="Re-post to DAT"
          />
          Re-post this load to DAT
        </label>
        {outcome === 'TONU' && (
          <p className="rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] p-2 text-xs">
            The carrier keeps ${formatCents(loadCarrier.carrierRateCents ?? 0)} — the cost line stays on the load.
          </p>
        )}
      </div>
    </TmsDialog>
  )
}
