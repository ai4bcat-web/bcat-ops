import { stopTapsLine, podSentAtFrom } from '@/lib/stopTimes'
import { useLoadDriverDocs } from '@/hooks/useLoadDriverDocs'
import { paperworkStatusLine } from '@/lib/paperworkLocation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@/lib/utils/errorMessage'
import {
  useForm, Controller,
  type Control, type FieldErrors, type UseFormHandleSubmit, type UseFormRegister,
  type UseFormSetValue, type UseFormWatch,
} from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CheckCircle2, Circle, Edit2, Upload, X, FileImage } from 'lucide-react'
import { SidePanel } from '@/features/files/SidePanel'
import { panelBtn } from '@/lib/ui/panel-btn'
import { DirectoryCreateDialog } from '@/components/directory-picker/DirectoryCreateDialog'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store/useAppStore'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useAuth } from '@/hooks/useAuth'
import { LoadPods } from '@/features/pods/LoadPods'
import { LoadDriverDocs } from './LoadDriverDocs'
import { LoadPodNotes } from './LoadPodNotes'
import { DriverDocUploadDialog } from '@/features/driver-docs'
import { setLoadPro, uploadRateConfirm, createLocation } from '@/lib/apiClient'
import { matchStopLocation, locationInputForStop } from '@/lib/locationAutoSave'
import { uploadRateconAndApply } from '@/lib/rateconUpload'
import { freightSummary, hasFreight } from '@/lib/freight'
import { staffUploadDriverDoc } from '@/lib/driverSubmissionsClient'
import { loadSchemaFor, type LoadFormValues } from '@/lib/schemas'
import { getStops, deriveLegacyFields } from '@/lib/stops'
import { apptNotices } from '@/lib/apptNotify'
import { sendApptNotices } from '@/lib/sendApptNotices'
import { useDirectory } from '@/hooks/useDirectory'
import {
  formatDateTime, formatDateTimeInput,
  formatDateShort, apptHasTime, PENDING_LABEL,
} from '@/lib/date'
import { toast } from 'sonner'
import { proConflict } from '@/lib/proConflict'
import { syncLoadRateToShipment } from '@/features/shipments/loadRateSync'
import { customerDisplayName } from '@/lib/customerResolution'
import {
  Field, FreightFields, LegFlagToggles, LegStopsSection, NotesField, RateField, ReadonlyField,
  SectionHeading, ToggleCard,
} from './legForm'
import { bookedAddressSnapshot, loadToStopForms, stopFormToStop } from './legFields'
import type { Load, Stop } from '@/types'
import type { LocationRecord } from '@/types/tms'

// ── Edit dialog ───────────────────────────────────────────────────────────────

/**
 * The leg editor. It never brings a record into being: a load is created inside
 * CREATE_SHIPMENT, with its PRO claimed in the same transaction, so there is no create
 * mode here and no "Create Load" button to find.
 */
function EditLoadDialog({
  isOpen,
  onClose,
  handleSubmit,
  activeDrivers,
  onSubmit,
  errors,
  control,
  register,
  watch,
  setValue,
  saving = false,
  load,
  onEditPro,
  // No onDelete: a load carries a PRO number, and a PRO number is permanent.
}: {
  isOpen: boolean
  onClose: () => void
  handleSubmit: UseFormHandleSubmit<LoadFormValues>
  activeDrivers: Array<{ id: string; name: string }>
  onSubmit: (values: LoadFormValues) => Promise<void>
  errors: FieldErrors<LoadFormValues>
  control: Control<LoadFormValues>
  register: UseFormRegister<LoadFormValues>
  watch: UseFormWatch<LoadFormValues>
  setValue: UseFormSetValue<LoadFormValues>
  /** A save is in flight: the button goes dead so a double-click cannot save twice. */
  saving?: boolean
  load?: Load
  /** Pro # moves through SET_LOAD_PRO, never through a load write. */
  onEditPro: () => void
}) {
  // The reusable address book: facility names suggest as you type.
  const directory = useDirectory()
  const [createLocationFor, setCreateLocationFor] = useState<{ initial?: { name?: string; city?: string }; stopIndex: number } | null>(null)

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        className="p-0 gap-0 flex flex-col overflow-hidden"
        style={{ maxWidth: 640, maxHeight: '85vh', width: '100%' }}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {/* Fixed header */}
        <div style={{
          padding: '16px 52px 16px 24px', borderBottom: '1px solid var(--ds-border)',
          flexShrink: 0,
        }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>
            {`Edit — ${load?.aljexId ?? 'Load'}`}
          </h2>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 8px' }}>
          <form id="new-load-form" onSubmit={handleSubmit(onSubmit)}>

            {/* ── Section 1: Identifiers ─────────────────────────────── */}
            <div style={{ marginBottom: 24 }}>
              <SectionHeading>Identifiers</SectionHeading>
              {/*
                Pro #, TMS ID and Pickup # are read-only to a signed-in client: a PRO is
                claimed atomically and never released, and the other two fall back to it,
                so the server owns all three. Moving a PRO is its own action — it claims
                the new number and keeps the old one claimed forever.
              */}
              <div className="grid grid-cols-3 gap-3" style={{ marginBottom: 12 }}>
                <Field label="Pro #" hint="Changing a Pro # claims the new number and never releases the old one.">
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Input value={load?.aljexId ?? ''} readOnly disabled className="h-9" />
                    <Button type="button" variant="outline" size="sm" className="h-9 px-3 shrink-0" aria-label="Change Pro #" onClick={onEditPro}>
                      Change
                    </Button>
                  </div>
                </Field>
                <Field label="TMS ID / PO">
                  <Input value={load?.tmsId ?? ''} readOnly disabled className="h-9" />
                </Field>
                <Field label="Pickup #">
                  <Input value={load?.pickupNumber ?? ''} readOnly disabled className="h-9" />
                </Field>
                <Field label="Trailer" hint="named by the driver as they leave the pickup">
                  <Input {...register('trailerNumber')} placeholder="5302" className="h-9" />
                </Field>
              </div>
              <FreightFields control={control} register={register} errors={errors} />
              {/*
                The customer belongs to the SHIPMENT, not to this leg.

                Writing `customer`/`customerId` from here set Load.customerId while the
                Shipment and the Order stayed unresolved, so the release gate and the AR
                worklist disagreed with what the calendar showed. SET_SHIPMENT_CUSTOMER on
                the shipment detail writes all three together, which is why the link lives
                there and not here.
              */}
              <div style={{ marginTop: 12 }}>
                <Field label="Customer" hint="Link or change the customer on the shipment detail.">
                  <Input value={customerDisplayName({ customerId: load?.customerId, customerName: load?.customer })} readOnly disabled className="h-9" />
                </Field>
              </div>
            </div>

            {/* ── Section 2: Stops (multi-pickup / multi-delivery) ───── */}
            <LegStopsSection
              isOpen={isOpen}
              control={control}
              register={register}
              errors={errors}
              watch={watch}
              setValue={setValue}
              drivers={activeDrivers}
              locations={directory.locations}
              onCreateLocation={(initial, stopIndex) => setCreateLocationFor({ initial, stopIndex })}
            />

            {/* ── Section 5: Financials ──────────────────────────────── */}
            <div style={{ marginBottom: 16 }}>
              <SectionHeading>Financials</SectionHeading>
              <RateField register={register} />
              <NotesField register={register} />

              {/* RTI toggle card */}
              <div style={{ marginTop: 16 }}>
                <Controller
                  name="readyToInvoice"
                  control={control}
                  render={({ field }) => (
                    <ToggleCard
                      active={!!field.value}
                      onToggle={() => field.onChange(!field.value)}
                      accent="#15803d"
                      tint="#f0fdf4"
                      icon={field.value ? <CheckCircle2 style={{ width: 20, height: 20, color: '#16a34a' }} /> : <Circle style={{ width: 20, height: 20, color: 'var(--ds-t3)' }} />}
                      titleActive="Ready to Invoice"
                      titleIdle="Mark as Ready to Invoice"
                      hintActive="Click to undo"
                      hintIdle="All paperwork received and load is invoiceable"
                    />
                  )}
                />
              </div>

              <LegFlagToggles control={control} />
            </div>

          </form>
        </div>

        {/* Fixed footer */}
        <div style={{
          padding: '12px 24px', borderTop: '1px solid var(--ds-border)',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          background: 'var(--ds-surface)',
        }}>
          {/* A load is never deleted here: the PRO is permanent (Ryne, 2026-10-28). */}
          {Object.keys(errors).length > 0 && (
            <span style={{ flex: 1, fontSize: 12, color: 'var(--ds-red, #dc2626)' }}>
              Please fill in the required fields above.
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <Button variant="outline" className="h-9 px-5" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" form="new-load-form" className="h-9 px-5" disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </DialogContent>

      {createLocationFor && (
        <DirectoryCreateDialog
          type="location"
          open
          initial={createLocationFor.initial}
          customers={directory.customers}
          divisions={[]} // load form does not need division defaults
          onClose={() => setCreateLocationFor(null)}
          onSave={async (record, geocodeToken) => {
            const { id: _id, createdAt: _c, updatedAt: _u, ...input } = record as LocationRecord
            const loc = await directory.addLocation({ ...input, ...(geocodeToken ? { geocodeToken } : {}) })
            // Link the new facility to the stop the "+" was pressed on.
            const i = createLocationFor.stopIndex
            setValue(`stops.${i}.locationId`, loc.id, { shouldDirty: true })
            setValue(`stops.${i}.address`, bookedAddressSnapshot(loc), { shouldDirty: true })
            if (!watch(`stops.${i}.name`)) setValue(`stops.${i}.name`, loc.name, { shouldDirty: true })
            if (!watch(`stops.${i}.city`) && loc.city) setValue(`stops.${i}.city`, [loc.city, loc.state].filter(Boolean).join(', '), { shouldDirty: true })
          }}
        />
      )}
    </Dialog>
  )
}

// ── Drawer (view / edit modes) ────────────────────────────────────────────────

export function LoadDrawer() {
  const selectedLoadId        = useAppStore((s) => s.selectedLoadId)
  const drawerMode            = useAppStore((s) => s.drawerMode)
  const setSelectedLoad       = useAppStore((s) => s.setSelectedLoad)
  // SET_LOAD_PRO writes the Load server-side, so the store's copy has to be re-pulled.
  const refreshCalendarData   = useAppStore((s) => s.refreshCalendarData)
  // The identity table, not the live working set. Two reasons: `proConflict` below is the
  // only Pro #-uniqueness check in the app and a voided load keeps its Pro # forever, so
  // hiding voided rows here would let a dead Pro # be reissued; and the drawer opens on a
  // load id, which the Voided tab hands it, so the record has to still be findable.
  const { allLoads: loads, updateLoad } = useLoads()
  const { drivers } = useDrivers()
  // What the driver app recorded at each stop, plus when the POD came in. Looked up by the
  // selected load id so the hook runs on every render, ahead of the mode-based early returns.
  const selectedForTimes = selectedLoadId ? loads.find((l) => l.id === selectedLoadId) : undefined
  const driverDocsForTimes = useLoadDriverDocs(selectedForTimes?.id, selectedForTimes?.aljexId)
  const podSentAt = podSentAtFrom(driverDocsForTimes.pods)
  const { user } = useAuth()

  const load         = loads.find((l) => l.id === selectedLoadId)
  const isOpen       = drawerMode !== null
  const activeDrivers = drivers.filter((d) => d.active)

  /*
   * Which customers are factored, so the form knows whose loads need an MC and ZIPs.
   * Unset is treated as not factored by loadSchemaFor — an unclassified customer must
   * never block a booking.
   */
  const formDirectory = useDirectory()

  const factoredAwareSchema = useMemo(() => {
    const factored = new Set(
      formDirectory.customers.filter((c) => c.factored === true).map((c) => c.id),
    )
    /*
     * On an EXISTING load, only hold it to what it already had.
     *
     * The MC and ZIP rules arrived after hundreds of loads were already booked, and
     * applying them to every save meant nobody could move an appointment on any of those
     * loads — the rule exists so an invoice can be assembled later, which is no reason to
     * block dispatch today. A field the load already carries is still protected, so an edit
     * cannot quietly strip one.
     */
    const stops = load ? getStops(load) : []
    const firstPickup = stops.find((st) => st.type === 'pickup')
    const lastDelivery = [...stops].reverse().find((st) => st.type === 'delivery')
    return loadSchemaFor((id) => !!id && factored.has(id), {
      isNew: false,
      had: {
        customerId: !!(load?.customerId ?? '').trim(),
        originZip: ((firstPickup?.address?.zip ?? '').trim()).length >= 3,
        destinationZip: ((lastDelivery?.address?.zip ?? '').trim()).length >= 3,
      },
    })
  }, [formDirectory.customers, load])

  const {
    register, control, handleSubmit, reset, watch, setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoadFormValues>({
    /*
     * The MC/ZIP rules apply only to a customer we factor — see loadSchemaFor. A
     * direct-billed customer never has an invoice sent to OTR, so demanding paperwork for
     * one would block real work.
     */
    resolver: zodResolver(factoredAwareSchema),
    defaultValues: {
      aljexId: '', tmsId: '', pickupNumber: '', trailerNumber: '',
      commodity: '', weight: null, pieces: null, piecesUnit: '', cargoValueCents: null,
      stops: [], readyToInvoice: false,
      customer: '', customerId: '', miles: null, rate: null, notes: '', hot: false, unscheduled: false,
    },
  })

  useEffect(() => {
    if (!isOpen || !load) return
    reset({
      aljexId: load.aljexId,
      tmsId: load.tmsId,
      pickupNumber: load.pickupNumber,
      trailerNumber: load.trailerNumber ?? '',
      commodity: load.commodity ?? '',
      weight: load.weight ?? null,
      pieces: load.pieces ?? null,
      piecesUnit: load.piecesUnit ?? '',
      cargoValueCents: load.cargoValueCents ?? null,
      stops: loadToStopForms(load),
      readyToInvoice:   load.readyToInvoice,
      customer: load.customer ?? '',
      customerId: load.customerId ?? '',
      miles: load.miles ?? null,
      rate: load.rate != null ? load.rate / 100 : null,
      notes: load.notes ?? '',
      hot: load.hot ?? false,
      unscheduled: load.unscheduled ?? false,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, load?.id, drawerMode])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showUploadPod, setShowUploadPod] = useState(false)

  const deliveryDriverId = useMemo(() => {
    if (!load) return null
    const stops = getStops(load)
    return [...stops].reverse().find((s) => s.type === 'delivery')?.driverId ?? stops.find((s) => s.type === 'pickup')?.driverId ?? null
  }, [load])

  const deliveryDriver = deliveryDriverId ? drivers.find((d) => d.id === deliveryDriverId) ?? null : null

  const handleRateConfirmUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !load) return
    e.target.value = ''
    const driverInfo = deliveryDriver
      ? { id: deliveryDriver.id, name: deliveryDriver.name, email: deliveryDriver.email }
      : undefined
    if (!/batory/i.test(load.customer ?? '')) {
      // Non-Batory: shared helper — upload + AI-read the appt times + auto-confirm.
      await uploadRateconAndApply(load, file, updateLoad, {
        driver: driverInfo,
        staffEmail: user?.email,
        referenceNumber: load.pickupNumber ?? undefined,
      })
    } else {
      try {
        const key = await uploadRateConfirm(load.id, file)
        await updateLoad(load.id, { rateConfirmKey: key } as never)
        toast.success('Rate confirmation uploaded')
        if (driverInfo && user?.email) {
          try {
            await staffUploadDriverDoc({
              driver: driverInfo,
              kind: 'RATECON',
              files: [file],
              submittedByEmail: user.email,
              referenceNumber: load.pickupNumber ?? undefined,
              loadId: load.id,
            })
          } catch (err) {
            console.error('[LoadDrawer] driver submission mirror failed', err)
            toast.error('Rate confirmation saved, but driver PWA copy failed')
          }
        }
      } catch {
        toast.error('Upload failed')
      }
    }
  }

  const handleRateConfirmRemove = async () => {
    if (!load) return
    try {
      if (load.rateConfirmUrl) {
        const { deleteRateConfirm } = await import('@/lib/apiClient')
        await deleteRateConfirm((load as Load & { rateConfirmKey?: string }).rateConfirmKey ?? '')
      }
      await updateLoad(load.id, { rateConfirmKey: undefined } as never)
      toast('Rate confirmation removed')
    } catch {
      toast.error('Failed to remove')
    }
  }

  const onClose = () => setSelectedLoad(null)

  // One save at a time. react-hook-form reports isSubmitting (the button reads it), but a
  // second click can land before that re-render — and two creates 98 ms apart is exactly
  // how 14578 ended up twice in production.
  const saveInFlight = useRef(false)

  const onSubmit = async (values: LoadFormValues) => {
    if (saveInFlight.current) return
    saveInFlight.current = true
    try {
      await saveLoad(values)
    } finally {
      saveInFlight.current = false
    }
  }

  /*
   * Every stop leaves with a directory location on it.
   *
   * A stop the dispatcher linked keeps its link. One they only typed is matched to the
   * directory (same name in the same city, or the same street) and, when nothing matches,
   * filed as a new location — so the next tender from that shipper arrives knowing its
   * hours, its dock notes and what drivers said about it. Filing is best-effort: a
   * directory hiccup must never stop a load from saving.
   */
  const linkStopsToDirectory = async (stops: Stop[]): Promise<Stop[]> => {
    let filed = 0
    let locations = formDirectory.locations
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
        console.warn('[LoadDrawer] could not file the stop as a location', { name: stop.name, err })
        out.push(stop)
      }
    }
    if (filed > 0) {
      void formDirectory.refresh()
      toast.message(`${filed} new location${filed === 1 ? '' : 's'} filed in the directory`)
    }
    return out
  }

  /*
   * Moving a Pro #.
   *
   * `aljexId` is field-level read-only to clients, so this cannot ride along on the save:
   * a PRO is claimed atomically and the claim is never released, voided rows included, and
   * SET_LOAD_PRO is the only writer that takes a new claim. `proConflict` is still the
   * fast answer in the browser against the identity table, but the server's refusal is the
   * rule and is surfaced verbatim.
   */
  const [proDraft, setProDraft] = useState<string | null>(null)
  const [proSaving, setProSaving] = useState(false)

  const commitPro = async () => {
    if (!load || proDraft == null) return
    const next = proDraft.trim()
    if (!next || next === (load.aljexId ?? '').trim()) { setProDraft(null); return }
    const conflict = proConflict(loads, next, load)
    if (conflict.kind === 'block') {
      toast.error(`Pro # ${next} is already used on another load`)
      return
    }
    setProSaving(true)
    try {
      await setLoadPro({ loadId: load.id, pro: next, expectedUpdatedAt: load.updatedAt })
      await refreshCalendarData()
      toast.success(`Pro # is now ${next}`)
      setProDraft(null)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setProSaving(false)
    }
  }

  const saveLoad = async (values: LoadFormValues) => {
    if (!load) return
    const userEmail = user?.email ?? 'dispatch'
    // Build the canonical stops array; the store derives the legacy pickup/delivery
    // mirror fields (withDerivedLegacy) — the form never sets them directly.
    const prevStops = getStops(load)
    const prevById = new Map(prevStops.map((st) => [st.id, st]))
    const stops = await linkStopsToDirectory(values.stops.map((s, i) => {
      const was = prevById.get(s.id)
      return stopFormToStop(s, i, was && { type: was.apptType, value: formatDateTimeInput(was.appt) }, was)
    }))
    // Slack notices are decided BEFORE the save, so the comparison is against what was on
    // screen rather than what we just wrote.
    const notices = apptNotices(stops, prevStops)
    // Once a load belongs to a shipment, `rate` is a mirror of the customer linehaul
    // charge line. Writing it here would desync the order's revenue and LoadFinancials,
    // so the shipment layer rewrites both and the mirror with it. A cleared field is a
    // deliberate zero — leaving the old linehaul standing would contradict the form.
    const rateCents = values.rate != null && !isNaN(values.rate) ? Math.round(values.rate * 100) : undefined
    const shipmentId = load.shipmentId ?? null
    /*
     * What a client may change on a leg, and nothing else.
     *
     * `aljexId`, `tmsId` and `pickupNumber` are field-level read-only — the PRO claim owns
     * them — and `customer`/`customerId` belong to the shipment: writing them here left
     * the Shipment and the Order unresolved while the calendar looked linked.
     */
    const payload = {
      trailerNumber: values.trailerNumber?.trim() || undefined,
      stops,
      ...deriveLegacyFields(stops), // pickupAppt/deliveryAppt/origin*/dest*/drivers (store re-derives; idempotent)
      readyToInvoice: values.readyToInvoice,
      rate: shipmentId ? undefined : rateCents,
      miles: values.miles ?? undefined,
      commodity: values.commodity?.trim() || undefined,
      weight: values.weight != null && !isNaN(values.weight) ? Math.round(values.weight) : undefined,
      pieces: values.pieces != null && !isNaN(values.pieces) ? Math.round(values.pieces) : undefined,
      piecesUnit: values.pieces != null && !isNaN(values.pieces) ? (values.piecesUnit || 'pieces') : undefined,
      cargoValueCents: values.cargoValueCents != null && !isNaN(values.cargoValueCents) ? Math.round(values.cargoValueCents) : undefined,
      notes: values.notes || undefined,
      hot: values.hot,
      unscheduled: values.unscheduled,
      updatedBy: userEmail,
    }
    try {
      // The rate goes first: RECALC_CHARGES rewrites the `rate` mirror server-side, so
      // a sync that fails after the load was written would leave the drawer's number
      // saved and the shipment's money untouched.
      if (shipmentId) {
        const nextRateCents = rateCents ?? 0
        if (nextRateCents !== (load.rate ?? 0)) {
          await syncLoadRateToShipment(shipmentId, load.id, nextRateCents)
        }
      }
      await updateLoad(load.id, payload)
      toast.success('Load updated')

      // Fire-and-forget, after the save succeeded — never post about a load that failed
      // to save, and never let a Slack outage block the drawer from closing.
      if (notices.length > 0) {
        void sendApptNotices({
          load: { ...load, ...payload } as Load,
          next: stops,
          prev: prevStops,
          actorName: userEmail,
          updateLoad,
        })
        const needed = notices.filter((n) => n.kind === 'needed').length
        toast.message(needed > 0
          ? `Posted to #appts-ivan — ${needed} appt needed`
          : 'Updated the #appts-ivan thread')
      }
      onClose()
    } catch (err) {
      console.error('Load save error:', err)
      toast.error(errorMessage(err))
    }
  }

  const driverName = (id: string | null) => id ? (drivers.find((d) => d.id === id)?.name ?? id) : '—'

  const apptLabel = (appt: string, type?: string, apptEnd?: string) => {
    if (type === 'tbd') return 'NEED'
    if (type === 'fcfs') return 'FCFS (first come first serve)'
    if (type === 'range' && apptEnd) return `${formatDateTime(appt)} – ${formatDateTime(apptEnd)}`
    // No time chosen yet — show the date and say so rather than implying midnight.
    if (!apptHasTime(appt)) return `${formatDateShort(appt)} · ${PENDING_LABEL}`
    return formatDateTime(appt)
  }

  const proDialog = proDraft !== null && load && (
    <Dialog open onOpenChange={(open) => { if (!open) setProDraft(null) }}>
      <DialogContent style={{ maxWidth: 420 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>Change Pro #</h2>
        <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', margin: '6px 0 0' }}>
          The new number is claimed for good. {load.aljexId || 'The old one'} stays claimed too —
          a Pro # is never reissued, so nothing can land on it again.
        </p>
        <Input
          autoFocus
          aria-label="New Pro #"
          value={proDraft}
          onChange={(e) => setProDraft(e.target.value)}
          className="h-9"
          style={{ marginTop: 12 }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <Button variant="outline" className="h-9 px-5" type="button" onClick={() => setProDraft(null)} disabled={proSaving}>
            Cancel
          </Button>
          <Button className="h-9 px-5" type="button" onClick={commitPro} disabled={proSaving}>
            {proSaving ? 'Claiming…' : 'Claim it'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )

  // ── Edit mode → centered Dialog ──────────────────────────────────────────
  if (drawerMode === 'edit') {
    return (
      <>
        <EditLoadDialog
          isOpen={isOpen}
          onClose={onClose}
          handleSubmit={handleSubmit}
          activeDrivers={activeDrivers}
          onSubmit={onSubmit}
          errors={errors}
          control={control}
          register={register}
          watch={watch}
          setValue={setValue}
          saving={isSubmitting}
          load={load}
          onEditPro={() => setProDraft(load?.aljexId ?? '')}
        />
        {proDialog}
      </>
    )
  }

  // SidePanel has no `open` prop — the Sheet honoured one, and without this guard the
  // drawer renders as soon as it mounts and covers the loads list.
  if (!isOpen) return null

  // ── View mode → shared SidePanel ───────────────────────────────────────────
  // Was a Radix Sheet with its own chrome: bg-white and border-slate-200 hardcoded, a
  // 540px width and px-8/py-5 header. Every other drawer in the app is the SidePanel
  // shell on --ds-surface / --ds-border, so this one ignored the theme and read as a
  // different component — which is what "doesn't match" was.
  // No Delete button: the PRO number on this load is permanent (Ryne, 2026-10-28).
  const panelFooter = (
    <>
      <div style={{ flex: 1 }} />
      <button type="button" onClick={() => setSelectedLoad(selectedLoadId, 'edit')} style={panelBtn.primary}>
        <Edit2 size={14} /> Edit Load
      </button>
    </>
  )

  return (
    <>
      <SidePanel
        title={load?.aljexId ?? 'Load Detail'}
        subtitle={customerDisplayName({ customerId: load?.customerId, customerName: load?.customer })}
        onClose={onClose}
        actions={load ? (
          load.readyToInvoice ? (
            <Badge variant="green" className="gap-1 text-xs">
              <CheckCircle2 className="size-3" /> Ready to Invoice
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
              <Circle className="size-3" /> Pending
            </Badge>
          )
        ) : undefined}
        footer={panelFooter}
      >
        <>
          {load ? (
            <div className="space-y-0">
              <ReadonlyField label="Pro #"       value={load.aljexId} />
              <ReadonlyField label="TMS / PO"   value={load.tmsId} />
              <ReadonlyField label="PU #"       value={load.pickupNumber} />
              <ReadonlyField label="Customer" value={customerDisplayName({ customerId: load.customerId, customerName: load.customer })} />
              {/* Stops — each pickup/delivery with its appointment + driver */}
              {(() => {
                const stops = getStops(load)
                let pu = 0, de = 0
                return stops.map((s) => {
                  const n = s.type === 'pickup' ? ++pu : ++de
                  const label = `${s.type === 'pickup' ? 'Pickup' : 'Delivery'}${(s.type === 'pickup' ? pu : de) > 1 || stops.filter((x) => x.type === s.type).length > 1 ? ` #${n}` : ''}`
                  const where = [s.name, s.city].filter(Boolean).join(' · ')
                  const when = apptLabel(s.appt, s.apptType, s.apptEnd)
                  const who = driverName(s.driverId)
                  const place = s.locationId ? formDirectory.locations.find((l) => l.id === s.locationId) : undefined
                  // Defensive as well as unwrapped at the client: a string here must never take the page down.
                  const notes = Array.isArray(place?.driverNotes) ? place.driverNotes : []
                  return (
                    <div key={s.id}>
                      <ReadonlyField
                        label={label}
                        value={[where, when, who !== '—' ? `Driver: ${who}` : null].filter(Boolean).join('  ·  ')}
                      />
                      {/* In and out times from the driver app, when the driver used it here. */}
                      {stopTapsLine(s, s.type === 'delivery' ? podSentAt : null) && (
                        <div className="-mt-1 mb-2 ml-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Driver app:</span> {stopTapsLine(s, s.type === 'delivery' ? podSentAt : null)}
                        </div>
                      )}
                      {/* What the directory knows about the place — the reason it is filed. */}
                      {place && (place.hours || place.dockNotes || notes.length > 0) && (
                        <div className="-mt-1 mb-2 ml-1 space-y-0.5 text-xs text-muted-foreground">
                          {place.hours && <div><span className="font-medium text-foreground">Hours:</span> {place.hours}</div>}
                          {place.dockNotes && <div><span className="font-medium text-foreground">Dock:</span> {place.dockNotes}</div>}
                          {notes.slice(-3).map((n, i) => (
                            <div key={i}><span className="font-medium text-foreground">{n.by}:</span> {n.text}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              })()}
              {hasFreight(load) && <ReadonlyField label="Freight" value={freightSummary(load)} />}
              {load.miles && <ReadonlyField label="Miles" value={String(load.miles)} />}
              {load.rate != null && (
                <ReadonlyField label="Rate" value={`$${(load.rate / 100).toFixed(2)}`} />
              )}
              <ReadonlyField label="Status"     value={load.readyToInvoice ? 'Ready to Invoice' : 'Pending'} />
              {load.notes && <ReadonlyField label="Notes" value={load.notes} />}
              <ReadonlyField label="Created"    value={formatDateTime(load.createdAt)} />
              <ReadonlyField label="Updated"    value={formatDateTime(load.updatedAt)} />
              <ReadonlyField label="Created by" value={load.createdBy} />

              <div className="pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rate Confirmation</Label>
                  <div className="flex items-center gap-2">
                    {load.rateConfirmUrl && (
                      <button
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
                        onClick={handleRateConfirmRemove}
                      >
                        <X className="size-3" /> Remove
                      </button>
                    )}
                    <button
                      className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="size-3" /> {load.rateConfirmUrl ? 'Replace' : 'Upload'}
                    </button>
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={handleRateConfirmUpload}
                />
                {load.rateConfirmUrl ? (
                  <a href={load.rateConfirmUrl} target="_blank" rel="noreferrer">
                    <img
                      src={load.rateConfirmUrl}
                      alt="Rate confirmation"
                      className="w-full rounded-md border border-border object-contain max-h-64 hover:opacity-90 transition-opacity cursor-pointer"
                    />
                  </a>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full h-24 rounded-md border border-dashed border-border flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors"
                  >
                    <FileImage className="size-6 opacity-50" />
                    <span className="text-xs">Click to upload rate confirmation</span>
                  </button>
                )}
                {/* A rate con the driver scanned does not write Load.rateConfirmKey, so
                    without this the slot above looked empty while the document existed. */}
                <LoadDriverDocs loadId={load.id} proNumber={load.aljexId} kind="RATECON" />
              </div>

              {/* Upload POD on the delivery driver's behalf */}
              {load && deliveryDriver && (
                <div className="pt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Driver POD</Label>
                    <button
                      className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
                      onClick={() => setShowUploadPod(true)}
                    >
                      <Upload className="size-3" /> Upload POD
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Upload a POD for {deliveryDriver.name} so it appears in the driver PWA.
                  </p>
                </div>
              )}

              {/* PODs linked to this shipment. Two stores: the ones JobsDone received and
                  a human linked, and the ones a driver scanned or staff uploaded. Reading
                  only the first meant a driver's POD was invisible here. */}
              {load?.paperworkLocation && (
                <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Paperwork: </span>
                  <span className="font-medium">{paperworkStatusLine(load.paperworkLocation)}</span>
                  <span className="text-muted-foreground"> · {load.paperworkLocation.byName ?? 'driver'}, {new Date((load.paperworkLocation.inHandAt ?? load.paperworkLocation.missingAt ?? load.paperworkLocation.at)).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              )}
              {load && (
                <div className="pt-4 border-t border-border mt-4 space-y-3">
                  <LoadPods loadId={load.id} />
                  <LoadDriverDocs loadId={load.id} proNumber={load.aljexId} kind="POD" />
                  <LoadPodNotes key={`${load.id}:${load.podNotes ?? ''}`} load={load} />
                  <LoadDriverDocs loadId={load.id} proNumber={load.aljexId} kind="MISC" />
                </div>
              )}
            </div>
          ) : null}
        </>
      </SidePanel>
      {load && deliveryDriver && (
        <DriverDocUploadDialog
          open={showUploadPod}
          onClose={() => setShowUploadPod(false)}
          drivers={drivers}
          preselectedDriver={deliveryDriver}
          preselectedKind="POD"
          load={{ id: load.id, aljexId: load.aljexId }}
          staffEmail={user?.email ?? ''}
          onSubmitted={() => {
            toast.success(`POD uploaded for ${deliveryDriver.name}`)
          }}
        />
      )}
    </>
  )
}
