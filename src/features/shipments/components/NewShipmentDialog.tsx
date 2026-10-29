/**
 * The one door freight comes in through.
 *
 * Every "+" in the app — the calendar's add buttons and 'n' key, the scheduler's day
 * columns and drag-create, intake's Build Load, the tasks queue, the board's "+ Shipment" —
 * raises this form, and the form calls CREATE_SHIPMENT exactly once, on Save. Nothing is
 * written when it opens and nothing is written when it is abandoned: a shipment number
 * comes off an atomic counter and can only ever be voided, so a create-on-open would leave
 * a permanent dead number behind every time somebody pressed the wrong button.
 *
 * It takes a customer RECORD or the operator's typed TEXT. The typed branch is a visible
 * choice, not a silent fallback — no Customer record is ever created from here and no
 * name is ever invented — and the shipment then reads as customer-not-linked everywhere
 * until SET_SHIPMENT_CUSTOMER links one.
 *
 * On success it opens the shipment detail. Never the load drawer: one record, one surface.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Check, CheckCircle2, Circle, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DirectoryPicker } from '@/components/directory-picker/DirectoryPicker'
import { DirectoryCreateDialog } from '@/components/directory-picker/DirectoryCreateDialog'
import {
  Field, FreightFields, LegFlagToggles, LegStopsSection, NotesField, RateField, SectionHeading,
} from '@/features/loads/legForm'
import {
  bookedAddressSnapshot, emptyStopForms, stopFormToStop, tenderNotes, tenderStopForms,
} from '@/features/loads/legFields'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useDrivers } from '@/hooks/useDrivers'
import { useLoads } from '@/hooks/useLoads'
import {
  createApptTask, createLocation, createShipment, getTmsSettings, notifySlackStatusChange,
  updateIntakeItem, updateLoad,
} from '@/lib/apiClient'
import { apptNotices } from '@/lib/apptNotify'
import { requiresApptProofs } from '@/lib/apptQueue'
import { effectiveCustomerStatus } from '@/lib/customerCredit'
import { UNRESOLVED_CUSTOMER_LABEL } from '@/lib/customerResolution'
import { locationInputForStop, matchStopLocation } from '@/lib/locationAutoSave'
import { proConflict } from '@/lib/proConflict'
import { loadSchemaFor, type LoadFormValues } from '@/lib/schemas'
import { sendApptNotices } from '@/lib/sendApptNotices'
import { withDerivedLegacy } from '@/lib/stops'
import { errorMessage } from '@/lib/utils/errorMessage'
import type { TenderPrefill } from '@/lib/intakeTender'
import type { Load, Stop } from '@/types'
import type { LocationRecord, ShipmentBundle, ShipmentMode, TmsSettings } from '@/types/tms'
import { MODE_OPTIONS } from '../orderDraft'
import { ShipmentDrawer } from './ShipmentDrawer'

/**
 * "This form has not been seeded yet", distinct from every prefill including `undefined`
 * and `null` — an opener with nothing to say still has to get a cleared form.
 */
const UNSEEDED = Symbol('unseeded')

/**
 * What an opener already knows. Every field is optional because every opener knows a
 * different slice: the calendar knows a date and maybe a driver lane, intake knows the
 * whole tender, the board knows nothing at all.
 */
export interface NewShipmentPrefill {
  /** The calendar day the "+" was pressed on, or the dragged range's start. */
  dateStr?: string
  /** The resource lane a scheduler drag started in. */
  driverId?: string | null
  /** A customer record the opener already matched. */
  customerId?: string
  /** Customer text the opener read off an email — never a guess, never invented. */
  customerName?: string
  /** Everything intake could read out of the tender email. */
  tender?: TenderPrefill
  /** The intake item this shipment is being built for: linked and marked DONE on success. */
  intakeItemId?: string
  /**
   * Set only by `proposalToPrefill` when a person applies a TENDER workflow proposal:
   * the server opens a `TENDER` shipment in TENDER_PENDING so TENDER_RESPOND can
   * Accept or Reject it. Every other opener leaves it unset and gets `MANUAL`/DRAFT.
   */
  source?: 'TENDER'
  /**
   * The WorkflowRun the tender was read from, so the shipment carries the back-reference
   * CREATE_SHIPMENT writes once. Only the workflow proposal card sets it.
   */
  workflowRunId?: string
}

export interface NewShipmentDialogProps {
  open: boolean
  prefill?: NewShipmentPrefill | null
  defaultMode?: ShipmentMode
  onClose: () => void
  /**
   * The shipment exists. A list behind the dialog refreshes here; the dialog itself opens
   * the detail, so a caller does not have to.
   */
  onCreated?: (shipmentId: string) => void
}

/**
 * The work that used to hang off `addLoad` and the drawer's create branch, run once the
 * bundle is back. None of it may fail the create — the shipment and its number already
 * exist by the time any of this starts.
 */
async function applyNewShipmentEffects({
  bundle, stops, prevNotices, isBatory, intakeItemId, rateConKey, actorName,
}: {
  bundle: ShipmentBundle
  /** The stops as written, so the Slack notices describe the saved state. */
  stops: Stop[]
  /** Appointment notices decided before the save, against an empty previous state. */
  prevNotices: ReturnType<typeof apptNotices>
  isBatory: boolean
  intakeItemId?: string
  rateConKey?: string
  actorName: string
}): Promise<void> {
  const load = bundle.loads[0]
  if (!load) return

  /*
   * Every load write below goes straight at the API, never through the store's
   * `updateLoad`.
   *
   * That action opens with `const before = get().loads.find(l => l.id === id)` and
   * returns silently when the row is missing. The leg is created server-side inside
   * CREATE_SHIPMENT and only reaches the store when the `onCreateLoad` subscription
   * delivers it — a race this code normally loses, because it runs the instant the
   * mutation resolves. Routed through the store the tender PDF would never attach and
   * the #appts-ivan thread ts would never be remembered, both without an error. The
   * deleted `addLoad` hid this by pushing the created row into the store itself.
   *
   * Kept from the store's write path: `updatedBy` attribution and the stops→legacy
   * dual-write, so the canonical array and its mirrors still cannot disagree. Left
   * behind: the optimistic copy and the audit diff, neither of which can be computed
   * without a `before` row — and the subscription delivers this update too, so the
   * store converges on its own.
   */
  const writeLoad = (id: string, patch: Partial<Load>) =>
    updateLoad(id, withDerivedLegacy({ ...patch, updatedBy: actorName }))

  if (isBatory) {
    /*
     * A Batory shipment enters the appointment ladder immediately: pickup NEED TO DENNIS
     * (the standing 12pm rule) and delivery NEED RUBEN, who picks the time. The stop
     * statuses rode in on the leg bag; these are the two tasks that chase them.
     *
     * Fire-and-forget — a task hiccup must not read as a failed shipment.
     */
    const ref = [load.aljexId ? `Pro# ${load.aljexId}` : null, bundle.shipment.customerName].filter(Boolean).join(' · ')
    const puDate = load.pickupAppt ? load.pickupAppt.slice(0, 10) : 'the pickup date'
    void createApptTask({
      loadId: load.id, kind: 'request_pickup', assignee: 'dennis@bcatcorp.com',
      subject: `Request pickup appt for 12:00 PM — ${ref || 'Batory load'}`,
      bodyText: `New Batory load built. Email the pickup facility to request a 12:00 PM appointment for ${puDate}, then upload the request-email screenshot to move it to REQUESTED.`,
      aljexId: load.aljexId ?? null,
    }).catch((err) => console.error('[NewShipmentDialog] pickup task failed', err))
    void createApptTask({
      loadId: load.id, kind: 'pick_delivery_time', assignee: 'ruben@bcatcorp.com',
      subject: `Pick delivery appt time — ${ref || 'Batory load'}`,
      bodyText: `New Batory load built. Choose the delivery time you want booked (set it on the delivery stop); Dennis is then tasked to book it.`,
      aljexId: load.aljexId ?? null,
    }).catch((err) => console.error('[NewShipmentDialog] delivery task failed', err))
  }

  if (intakeItemId) {
    try {
      /*
       * Attach the tender's own document, when it came with one.
       *
       * The key is pointed at rather than copied: it is already in the same bucket and
       * readable, and duplicating the bytes would leave two copies to keep in step.
       */
      if (rateConKey) {
        await writeLoad(load.id, { rateConfirmKey: rateConKey })
      }
      /*
       * DONE, not BUILT. Building the shipment IS the work the intake item was asking for,
       * so a separate "Mark as done" click was pure bookkeeping — and an item left at BUILT
       * reads as outstanding on a page whose whole job is showing what still needs doing.
       */
      await updateIntakeItem(intakeItemId, {
        builtLoadId: load.id,
        status: 'DONE',
        ...(load.aljexId ? { proNumber: load.aljexId } : {}),
      })
      notifySlackStatusChange({
        intakeItemId,
        oldStatus: 'IN_PROGRESS',
        newStatus: 'DONE',
        actorName,
        proNumber: load.aljexId || null,
      })
    } catch (linkErr) {
      console.error('[NewShipmentDialog] failed to link intake item', linkErr)
    }
  }

  if (prevNotices.length > 0) {
    // Fire-and-forget, but never unhandled: the shipment already exists, so a Slack
    // outage is a logged warning, not a rejection that surfaces as an app-level error.
    void sendApptNotices({
      load: { ...load, stops } as unknown as Load,
      next: stops,
      prev: [],
      actorName,
      updateLoad: writeLoad,
    }).catch((err) => console.error('[NewShipmentDialog] appointment notices failed', err))
    const needed = prevNotices.filter((n) => n.kind === 'needed').length
    toast.message(needed > 0
      ? `Posted to #appts-ivan — ${needed} appt needed`
      : 'Updated the #appts-ivan thread')
  }
}

export function NewShipmentDialog({ open, prefill, defaultMode = 'FTL', onClose, onCreated }: NewShipmentDialogProps) {
  const directory = useDirectory()
  const { drivers } = useDrivers()
  // The identity table on purpose: `proConflict` is the fast client-side answer and a
  // voided load keeps its Pro # forever, so hiding voided rows would let a dead number
  // read as free. The server's claim is the rule either way.
  const { allLoads } = useLoads()
  const { user, isAdmin } = useAuth()
  // Only for the detail this hands over to; the form itself needs none of it.
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  useEffect(() => { getTmsSettings().then(setSettings).catch(() => setSettings(null)) }, [])

  const [mode, setMode] = useState<ShipmentMode>(defaultMode)
  const [pro, setPro] = useState('')
  const [customerId, setCustomerId] = useState('')
  /** The operator chose to record typed text because nothing in the directory matched. */
  const [useTypedCustomer, setUseTypedCustomer] = useState(false)
  const [typedCustomer, setTypedCustomer] = useState('')
  const [createCustomerFor, setCreateCustomerFor] = useState<{ name?: string; city?: string } | undefined>(undefined)
  const [createLocationFor, setCreateLocationFor] = useState<{ initial?: { name?: string; city?: string }; stopIndex: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)

  const tender = prefill?.tender
  const linkedCustomer = directory.customers.find((c) => c.id === customerId) ?? null

  /*
   * Is this a Batory shipment? Same rule the appointments queue uses, so the two cannot
   * disagree about whose freight goes through the request ladder.
   */
  const isBatory = requiresApptProofs({
    customer: linkedCustomer?.name ?? typedCustomer,
    customerApptWorkflow: linkedCustomer?.apptWorkflow ?? null,
  })

  /*
   * Dormant is an automatic "no shipment in 90 days" label that new freight clears, so a
   * dormant customer is still shippable; only the lead stages, Pending and Blocked are
   * refused. The Lambda re-checks — this list exists so the user is not offered a name
   * the server will reject.
   */
  const activeCustomers = useMemo(() => {
    const now = new Date().toISOString()
    return directory.customers.filter((c) => {
      const status = effectiveCustomerStatus(c, null, now)
      return status === 'ACTIVE' || status === 'DORMANT'
    })
  }, [directory.customers])

  const schema = useMemo(() => {
    const factored = new Set(directory.customers.filter((c) => c.factored === true).map((c) => c.id))
    return loadSchemaFor((id) => !!id && factored.has(id), { isNew: true })
  }, [directory.customers])

  const {
    register, control, handleSubmit, reset, watch, setValue, getValues,
    formState: { errors },
  } = useForm<LoadFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      aljexId: '', tmsId: '', pickupNumber: '', trailerNumber: '',
      commodity: '', weight: null, pieces: null, piecesUnit: '', cargoValueCents: null,
      stops: emptyStopForms(), readyToInvoice: false,
      customer: '', customerId: '', miles: null, rate: null, notes: '', hot: false, unscheduled: false,
    },
  })

  /*
   * Seed the whole form from the prefill each time the dialog is raised.
   *
   * On the open transition during render, not in an effect: an effect that calls setState
   * in its body cascades a second render and trips react-hooks/set-state-in-effect, and
   * this is React's own "adjust state when a prop changes" case. Nothing is written to the
   * server here — this is the unsaved form every opener used to raise, unchanged.
   */
  const [seededFor, setSeededFor] = useState<NewShipmentPrefill | null | undefined | typeof UNSEEDED>(UNSEEDED)
  if (!open) {
    // Closing arms the next opening, so raising the form again with the very same prefill
    // object still starts from a clean sheet rather than from what was abandoned.
    if (seededFor !== UNSEEDED) setSeededFor(UNSEEDED)
  } else if (seededFor !== prefill) {
    setSeededFor(prefill)
    setMode(defaultMode)
    setPro('')
    setError(null)
    setCustomerId(prefill?.customerId ?? '')
    setTypedCustomer(prefill?.customerName ?? prefill?.tender?.customer ?? '')
    setUseTypedCustomer(false)
    const preDate = prefill?.dateStr
    const t = prefill?.tender
    // Batory freight skips the tender's appointment times and facility instructions: both
    // are established by hand through the request ladder. Everything else carries over.
    const skipAppts = requiresApptProofs({
      customer: t?.customer ?? '',
      customerApptWorkflow: (t?.customerId ? directory.customers.find((c) => c.id === t.customerId)?.apptWorkflow : null) ?? null,
    })
    reset({
      /*
       * The Pro # is NOT prefilled from the tender, deliberately. A tender carries the
       * BROKER's reference — a TMS ID like 208663813 — which is a different number
       * entirely, and putting it here would make every intake-built shipment claim an
       * Aljex PRO it never had. That reference belongs in TMS ID, where it is correct.
       */
      aljexId: '', tmsId: t?.reference ?? '',
      pickupNumber: t?.pickupNumber ?? '',
      trailerNumber: '',
      // The tender email states the weight; the commodity, count and declared value wait
      // for the rate con.
      commodity: '', weight: t?.weightLb ?? null, pieces: null, piecesUnit: '', cargoValueCents: null,
      stops: t
        ? tenderStopForms(t, preDate, prefill?.driverId ?? null, skipAppts, directory.locations)
        : emptyStopForms(preDate, prefill?.driverId ?? null),
      readyToInvoice: false,
      customer: '', customerId: '',
      /*
       * Facility instructions off the tender — "Appointments required", "48 Hour Notice",
       * "must be locked or sealed". 162 of the 166 tenders on file carry one, and it is
       * exactly what a dispatcher otherwise reads off the email and retypes.
       */
      notes: skipAppts ? '' : tenderNotes(t),
      miles: null, rate: null, hot: false, unscheduled: false,
    })
  }

  /*
   * Batory defaults: the pickup defaults to NEED with 12:00 PM and the delivery to NEED,
   * but only while the stops are still vanilla — no facility names, no times — so a
   * deliberate edit is never overwritten.
   */
  useEffect(() => {
    if (!open || !isBatory) return
    const stops = getValues('stops') ?? []
    if (stops.length === 0) return
    const isVanilla = stops.every((s) =>
      !s.name && !s.city && s.apptType === 'exact' && (!s.appt || s.appt.length <= 10),
    )
    if (!isVanilla) return
    stops.forEach((s, i) => {
      if (s.type === 'pickup') {
        const date = s.appt?.slice(0, 10) || ''
        setValue(`stops.${i}.apptType`, 'tbd', { shouldDirty: true })
        if (date) setValue(`stops.${i}.appt`, `${date}T12:00`, { shouldDirty: true })
      }
      if (s.type === 'delivery') {
        setValue(`stops.${i}.apptType`, 'tbd', { shouldDirty: true })
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isBatory])

  /*
   * One save at a time. A second click can land before the disabled button re-renders,
   * and two creates 98 ms apart is exactly how 14578 ended up twice in production — except
   * now each one burns a permanent shipment number.
   */
  const saveInFlight = useRef(false)
  const [saving, setSaving] = useState(false)

  /*
   * Every stop leaves with a directory location on it.
   *
   * A stop the dispatcher linked keeps its link. One they only typed is matched to the
   * directory (same name in the same city, or the same street) and, when nothing matches,
   * filed as a new location — so the next tender from that shipper arrives knowing its
   * hours, its dock notes and what drivers said about it. Filing is best-effort: a
   * directory hiccup must never stop a shipment from being recorded.
   */
  const linkStopsToDirectory = async (stops: Stop[]): Promise<Stop[]> => {
    let filed = 0
    let locations = directory.locations
    const out: Stop[] = []
    for (const stop of stops) {
      if (stop.locationId || !(stop.name ?? '').trim()) { out.push(stop); continue }
      const known = matchStopLocation(stop, locations)
      if (known) { out.push({ ...stop, locationId: known.id, address: stop.address ?? bookedAddressSnapshot(known) }); continue }
      const input = locationInputForStop(stop)
      if (!input) { out.push(stop); continue }
      try {
        const created = await createLocation(input)
        locations = [...locations, created]
        filed++
        out.push({ ...stop, locationId: created.id })
      } catch (err) {
        console.warn('[NewShipmentDialog] could not file the stop as a location', { name: stop.name, err })
        out.push(stop)
      }
    }
    if (filed > 0) {
      void directory.refresh()
      toast.message(`${filed} new location${filed === 1 ? '' : 's'} filed in the directory`)
    }
    return out
  }

  const onSubmit = async (values: LoadFormValues) => {
    if (saveInFlight.current) return
    const typed = typedCustomer.trim()
    if (!customerId && !(useTypedCustomer && typed)) {
      setError('Pick a customer, or choose to record the name you typed.')
      return
    }
    const typedPro = pro.trim()
    if (typedPro) {
      const conflict = proConflict(allLoads, typedPro)
      if (conflict.kind === 'block') {
        setError(`Pro # ${typedPro} is already used on another load. A Pro # is never reissued.`)
        return
      }
    }
    saveInFlight.current = true
    setSaving(true)
    setError(null)
    try {
      let stops = await linkStopsToDirectory(values.stops.map((s, i) => stopFormToStop(s, i)))
      if (isBatory) {
        // The ladder starts on the stops themselves: pickup needs requesting, delivery
        // needs a time picked and then booking.
        stops = stops.map((s) => ({
          ...s,
          apptStatus: s.apptStatus ?? (s.type === 'delivery' ? 'need_book' : 'need_request'),
        }))
      }
      // Decided before the save, so the comparison is against what was on screen.
      const notices = apptNotices(stops, [])
      const rateCents = values.rate != null && !isNaN(values.rate) ? Math.round(values.rate * 100) : undefined
      const bundle = await createShipment({
        ...(customerId ? { customerId } : { customerName: typed }),
        mode,
        ...(typedPro ? { pro: typedPro } : {}),
        // The agent never creates freight. This runs in the browser under the operator's
        // own Cognito identity, the server claims the PRO in the same transaction as for
        // any manual shipment, and a `TENDER` source only opens it TENDER_PENDING so
        // TENDER_RESPOND stays the review. A prefill that says nothing is MANUAL.
        source: prefill?.source ?? 'MANUAL',
        ...(prefill?.workflowRunId ? { workflowRunId: prefill.workflowRunId } : {}),
        load: {
          stops,
          tmsId: values.tmsId?.trim() || undefined,
          pickupNumber: values.pickupNumber?.trim() || undefined,
          commodity: values.commodity?.trim() || undefined,
          weight: values.weight != null && !isNaN(values.weight) ? Math.round(values.weight) : undefined,
          pieces: values.pieces != null && !isNaN(values.pieces) ? Math.round(values.pieces) : undefined,
          piecesUnit: values.pieces != null && !isNaN(values.pieces) ? (values.piecesUnit || 'pieces') : undefined,
          cargoValueCents: values.cargoValueCents != null && !isNaN(values.cargoValueCents) ? Math.round(values.cargoValueCents) : undefined,
          miles: values.miles ?? undefined,
          notes: values.notes?.trim() || undefined,
          hot: values.hot,
          unscheduled: values.unscheduled,
          ...(rateCents != null ? { rateCents } : {}),
        },
      })
      toast.success(`Shipment ${bundle.shipment.number} created`)
      await applyNewShipmentEffects({
        bundle,
        stops,
        prevNotices: notices,
        isBatory,
        intakeItemId: prefill?.intakeItemId,
        rateConKey: tender?.rateConKey,
        actorName: user?.email ?? 'dispatch',
      })
      setCreatedId(bundle.shipment.id)
      onCreated?.(bundle.shipment.id)
    } catch (err) {
      // The server's refusal verbatim — a duplicate PRO, a credit hold, an archived
      // customer. Paraphrasing it would hide which of them it was.
      setError(errorMessage(err))
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  // The shipment exists: hand straight over to its detail. Never the load drawer.
  if (createdId) {
    return (
      <ShipmentDrawer
        shipmentId={createdId}
        onClose={() => { setCreatedId(null); onClose() }}
        onChanged={() => onCreated?.(createdId)}
        customers={directory.customers}
        locations={directory.locations}
        settings={settings}
        isAdmin={isAdmin}
        currentUser={user?.email ?? ''}
      />
    )
  }

  if (!open) return null

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        className="p-0 gap-0 flex flex-col overflow-hidden"
        style={{ maxWidth: 640, maxHeight: '85vh', width: '100%' }}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div style={{
          padding: '16px 52px 16px 24px', borderBottom: '1px solid var(--ds-border)', flexShrink: 0,
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>New shipment</h2>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 8px' }}>
          {/* `handleSubmit` is bound in the handler, not during render: the submit closure
              reads the in-flight ref, and reading a ref while rendering is not allowed. */}
          <form id="new-shipment-form" onSubmit={(e) => { void handleSubmit(onSubmit)(e) }}>

            {/*
              What the tender brought with it. Attaching the rate confirmation happens on
              save, so without saying so here somebody fills the form with no idea whether
              the document is coming and uploads a second copy to be sure.
            */}
            {tender && (
              <div
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16,
                  padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
                  background: tender.rateConKey ? '#ecfdf5' : 'var(--ds-bg)',
                  border: `1px solid ${tender.rateConKey ? '#86efac' : 'var(--ds-border)'}`,
                  color: tender.rateConKey ? '#15803d' : 'var(--ds-t3)',
                }}
              >
                {tender.rateConKey ? <Check size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                  : <FileText size={14} style={{ marginTop: 1, flexShrink: 0 }} />}
                <span>
                  {/*
                    Said here because a blank appointment on a Batory load otherwise reads
                    as a prefill that failed, and somebody goes looking for the date in the
                    email instead of starting the request.
                  */}
                  {isBatory && (
                    <span style={{ display: 'block', marginBottom: 4 }}>
                      <b>Batory load</b> — appointments are left blank on purpose; request
                      them through the appointments page.
                    </span>
                  )}
                  {tender.rateConKey ? (
                    <>
                      <b>Rate confirmation attached</b> from the tender — it goes on the load
                      when you save, and the factoring queue reads it from there.
                    </>
                  ) : (
                    <>
                      This tender arrived with <b>no rate confirmation</b> attached. Upload one
                      on the load or in the factoring queue once you have it.
                    </>
                  )}
                </span>
              </div>
            )}

            {/* ── Customer, mode, PRO ─────────────────────────────────── */}
            <div style={{ marginBottom: 24 }}>
              <SectionHeading>Shipment</SectionHeading>
              <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 12 }}>
                <Field label="Customer" hint="Only active customers can be shipped.">
                  <DirectoryPicker
                    type="customer"
                    value={customerId || null}
                    customers={activeCustomers}
                    locations={directory.locations}
                    placeholder="Select customer…"
                    onChange={(id, record) => {
                      setCustomerId(id ?? '')
                      if (id) { setUseTypedCustomer(false); setError(null) }
                      if (record?.name && !typedCustomer) setTypedCustomer(record.name)
                    }}
                    onCreateNew={(initial) => setCreateCustomerFor(initial)}
                  />
                </Field>
                <Field label="Mode">
                  <select
                    aria-label="Mode"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as ShipmentMode)}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  >
                    {MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </Field>
              </div>

              {/*
                The deliberate "we do not know which customer this is" branch.
                It is a choice the operator makes and can see, never a silent fallback, and
                it never creates a Customer record — the typed text is recorded verbatim and
                the shipment reads as not linked until somebody links one.
              */}
              {!customerId && (
                <div style={{
                  border: '1px solid var(--ds-border)', borderRadius: 8, padding: '12px 14px',
                  background: 'var(--ds-bg)', marginBottom: 12,
                }}>
                  <button
                    type="button"
                    onClick={() => setUseTypedCustomer((v) => !v)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, background: 'none',
                      border: 'none', padding: 0, cursor: 'pointer', fontSize: 13,
                      color: 'var(--ds-t1)', fontWeight: 600, fontFamily: 'inherit',
                    }}
                  >
                    {useTypedCustomer
                      ? <CheckCircle2 size={16} style={{ color: '#16a34a' }} />
                      : <Circle size={16} style={{ color: 'var(--ds-t3)' }} />}
                    No matching customer — record the name for now
                  </button>
                  {useTypedCustomer && (
                    <div style={{ marginTop: 10 }}>
                      <Input
                        aria-label="Customer name"
                        value={typedCustomer}
                        onChange={(e) => { setTypedCustomer(e.target.value); setError(null) }}
                        placeholder="Arrive Logistics, Echo Global…"
                        className="h-9"
                      />
                      <p style={{ fontSize: 12, color: 'var(--ds-t3)', margin: '6px 0 0' }}>
                        No customer record is created. The shipment shows as
                        “{UNRESOLVED_CUSTOMER_LABEL}” and cannot be invoiced or sent to
                        factoring until someone links one on the shipment detail.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <Field label="Pro #" hint="Blank: the shipment numbers its own leg.">
                  <Input
                    aria-label="Pro #"
                    value={pro}
                    onChange={(e) => { setPro(e.target.value); setError(null) }}
                    placeholder="A-2847391"
                    className="h-9"
                  />
                </Field>
                <Field label="TMS ID / PO" error={errors.tmsId?.message}>
                  <Input {...register('tmsId')} placeholder="TMS-44201" className="h-9" />
                </Field>
                <Field label="Pickup #" error={errors.pickupNumber?.message}>
                  <Input {...register('pickupNumber')} placeholder="PU-8812" className="h-9" />
                </Field>
              </div>
            </div>

            {/* ── Freight ─────────────────────────────────────────────── */}
            <div style={{ marginBottom: 24 }}>
              <SectionHeading>Freight</SectionHeading>
              <FreightFields control={control} register={register} errors={errors} />
            </div>

            {/* ── Stops ───────────────────────────────────────────────── */}
            <LegStopsSection
              isOpen={open}
              control={control}
              register={register}
              errors={errors}
              watch={watch}
              setValue={setValue}
              drivers={drivers.filter((d) => d.active)}
              locations={directory.locations}
              onCreateLocation={(initial, stopIndex) => setCreateLocationFor({ initial, stopIndex })}
            />

            {/* ── Financials ──────────────────────────────────────────── */}
            <div style={{ marginBottom: 16 }}>
              <SectionHeading>Financials</SectionHeading>
              {/* Priced as a CUSTOMER LINEHAUL charge on the shipment, never as a raw
                  Load.rate — the order's revenue is derived from the charges. */}
              <RateField register={register} />
              <NotesField register={register} />
              <LegFlagToggles control={control} />
            </div>
          </form>
        </div>

        <div style={{
          padding: '12px 24px', borderTop: '1px solid var(--ds-border)',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          background: 'var(--ds-surface)',
        }}>
          {(error || Object.keys(errors).length > 0) && (
            <span style={{ flex: 1, fontSize: 12, color: 'var(--ds-red, #dc2626)' }}>
              {error ?? 'Please fill in the required fields above.'}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <Button variant="outline" className="h-9 px-5" onClick={onClose} type="button" disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="new-shipment-form" className="h-9 px-5" disabled={saving}>
              {saving ? 'Creating…' : 'Create shipment'}
            </Button>
          </div>
        </div>
      </DialogContent>

      {createCustomerFor !== undefined && (
        <DirectoryCreateDialog
          type="customer"
          open
          initial={createCustomerFor}
          customers={directory.customers}
          divisions={[]}
          onClose={() => setCreateCustomerFor(undefined)}
          onSave={async (record) => {
            // Only ever from this explicit dialog, where a person typed the record's own
            // details. The form never creates a Customer behind anybody's back.
            const c = await directory.addCustomer(record as Parameters<typeof directory.addCustomer>[0])
            setCustomerId(c.id)
            setTypedCustomer(c.name)
            setUseTypedCustomer(false)
          }}
        />
      )}

      {createLocationFor && (
        <DirectoryCreateDialog
          type="location"
          open
          initial={createLocationFor.initial}
          customers={directory.customers}
          divisions={[]}
          onClose={() => setCreateLocationFor(null)}
          onSave={async (record, geocodeToken) => {
            const { id: _id, createdAt: _c, updatedAt: _u, ...input } = record as LocationRecord
            const loc = await directory.addLocation({ ...input, ...(geocodeToken ? { geocodeToken } : {}) })
            const i = createLocationFor.stopIndex
            setValue(`stops.${i}.locationId`, loc.id, { shouldDirty: true })
            setValue(`stops.${i}.address`, bookedAddressSnapshot(loc), { shouldDirty: true })
            if (!getValues(`stops.${i}.name`)) setValue(`stops.${i}.name`, loc.name, { shouldDirty: true })
            if (!getValues(`stops.${i}.city`) && loc.city) setValue(`stops.${i}.city`, [loc.city, loc.state].filter(Boolean).join(', '), { shouldDirty: true })
          }}
        />
      )}
    </Dialog>
  )
}
