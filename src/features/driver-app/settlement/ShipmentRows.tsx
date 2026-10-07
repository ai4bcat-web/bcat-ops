/**
 * The week's shipments, as rows a driver can act on.
 *
 * Each row answers three things at a glance: which load, what it pays, and what paperwork
 * it still needs. The POD and rate-con cells are the actions — tapping one opens the page
 * picker already pointed at that load, so a driver never types a PRO from memory and a
 * document never lands on the wrong shipment.
 *
 * Only the POD is required. The rate confirmation is the office's to collect at factoring,
 * so it is offered here but never demanded: a driver who has it can send it, and a driver
 * who does not is not being chased for someone else's paperwork.
 *
 * Built as a grid rather than a <table> because this is read on a phone. The columns still
 * line up down the list, which is the point of columns; a real table at 400px would need
 * sideways scrolling to see whether a POD is in.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Upload, AlertTriangle, Eye } from 'lucide-react'
import type { FactoringFields, SettlementTrip, SubmissionKind } from '../driverApi'
import { useTripDocs, type TripDoc } from './useTripDocs'
import { DocPreviewSheet } from './DocPreviewSheet'

type Trip = SettlementTrip & {
  factoring?: FactoringFields | null
  heldReason?: string | null
  heldLabel?: string | null
}

function money(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n)
}

/** "1 Oct" — a date a driver can match to a day they worked. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** The PRO is what both the office and OTR call a load; the internal id means nothing here. */
function shipmentLabel(trip: Trip): string {
  return trip.factoring?.invoiceNo?.trim() || trip.loadId?.trim() || '—'
}

function DocCell({
  present, readOnly, required, label, shipment, pageCount, onPress, onPreview,
}: {
  present: boolean
  /**
   * True when this is being shown to someone who is not the driver — the staff preview on
   * the owner-operator settlements. The cells become labels: the controls here send a
   * driver into their own upload screen, which is not where a staff member belongs, and
   * the paperwork they CAN change lives on the Loads page.
   */
  readOnly: boolean
  /** Amber when its absence holds the driver's pay. Only the POD does. */
  required: boolean
  label: string
  /** Named in the accessible label so the rows are told apart, not just numbered. */
  shipment: string
  /** How many pages are on file. A driver who sent three wants to see three. */
  pageCount?: number
  onPress: () => void
  /**
   * Absent while the document index is still loading, or for a POD the office holds that
   * this driver never submitted. The tick then stays a tick rather than becoming a button
   * that opens nothing.
   */
  onPreview?: () => void
}) {
  // On its own line now, so each control can name the document instead of relying on a
  // two-letter column header a driver has to decode.
  const short = label === 'POD' ? 'POD' : 'Rate con'
  /*
   * Say how many pages are on file.
   *
   * "In" told a driver who photographed three sheets nothing about whether all three
   * arrived — and a POD missing its second page is the kind of thing nobody notices until
   * a broker refuses the invoice.
   */
  const count = pageCount && pageCount > 1 ? ` · ${pageCount} pages` : pageCount === 1 ? ' · 1 page' : ''

  if (readOnly) {
    return (
      <span
        className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${
          present
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : required
              ? 'border-amber-400 bg-amber-50 text-amber-800'
              : 'border-border bg-muted/50 text-muted-foreground'
        }`}
        aria-label={`${label} ${present ? 'on file' : 'not on file'} for ${shipment}`}
      >
        {present ? <Check className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {short} {present ? `in${count}` : 'needed'}
      </span>
    )
  }

  if (present) {
    if (!onPreview) {
      return (
        <span
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700"
          aria-label={`${label} on file for ${shipment}`}
        >
          <Check className="h-3.5 w-3.5" /> {short} in{count}
        </span>
      )
    }
    return (
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Check the ${label} you sent for ${shipment}`}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700"
      >
        <Eye className="h-3.5 w-3.5" /> {short} in{count}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={`Send the ${label} for ${shipment}`}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${
        required
          ? 'border-amber-400 bg-amber-50 text-amber-800'
          : 'border-border bg-muted/50 text-muted-foreground'
      }`}
    >
      <Upload className="h-3.5 w-3.5" />
      Send {short}
    </button>
  )
}

export function ShipmentRows({
  trips, readOnly = false,
  grossFreight, driverAmount, payPercent, heldFreight,
}: {
  trips: Trip[]
  readOnly?: boolean
  /**
   * The on-check totals, exactly as the server computed them for the cheque. Passed in
   * rather than summed here so the footer can never disagree with the check amount
   * underneath it — the desktop page shows statement.gross and statement.driverAmount,
   * and this shows the same two numbers.
   */
  grossFreight?: number
  driverAmount?: number
  payPercent?: number
  heldFreight?: number
}) {
  const navigate = useNavigate()
  const docs = useTripDocs()
  const [open, setOpen] = useState<{ doc: TripDoc; kind: SubmissionKind; shipment: string } | null>(null)

  if (trips.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">No trips this week</p>
    )
  }

  const send = (kind: 'pod' | 'ratecon', trip: Trip) => {
    const pro = trip.factoring?.invoiceNo?.trim() ?? ''
    navigate(`/driver/scan?kind=${kind}${pro ? `&pro=${encodeURIComponent(pro)}` : ''}`)
  }

  return (
    <div role="table" aria-label="Shipments this week" className="text-sm">
      {/*
        * Two columns, not four.
        *
        * The document cells were fixed at 44px and the controls inside them are wider than
        * that — an upload button is an icon and a word — so on a phone the POD column was
        * cut off at the edge of the screen, which is where it mattered most. The paperwork
        * gets its own line under the shipment instead, with room for a label on each
        * action rather than two initials in a header.
        */}
      {/*
        Freight AND pay, the way the desktop shows them.

        The app used to show pay alone. An owner operator is paid a percentage, so the
        number they most want to check is the one it was taken from — and with only the
        share on screen they had to ring the office to ask what the load actually paid.
        Miles ride under the freight, as the desktop puts them side by side.
      */}
      <div
        role="row"
        className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-border px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        <span role="columnheader">Shipment</span>
        <span role="columnheader" className="text-right">Freight</span>
        <span role="columnheader" className="text-right">Pay</span>
      </div>

      {trips.map((trip) => {
        const f = trip.factoring
        const podIn = !!f?.podPresent
        const held = !!trip.heldReason
        const shipment = shipmentLabel(trip)
        const pro = f?.invoiceNo ?? null
        const podDoc = docs.find('POD', trip.loadId, pro)
        const rcDoc = docs.find('RATECON', trip.loadId, pro)
        return (
          <div
            key={trip.id}
            role="row"
            className={`border-b border-border/60 px-3 py-2.5 ${held ? 'bg-amber-50/60' : ''}`}
          >
            <div className="grid grid-cols-[1fr_auto_auto] items-start gap-3">
            <div role="cell" className="min-w-0">
              <p className="truncate font-semibold text-card-foreground">{shipment}</p>
              <p className="truncate text-xs text-muted-foreground">
                {dayLabel(trip.date)}
                {trip.origin || trip.destination
                  ? ` · ${[trip.origin, trip.destination].filter(Boolean).join(' → ')}`
                  : ''}
              </p>
              {held && (
                <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-amber-800">
                  <AlertTriangle className="h-3 w-3" />
                  {trip.heldReason === 'NOT_DELIVERED'
                    ? 'Not delivered yet — pays on a later check'
                    : 'Not on this check until the POD is in'}
                </p>
              )}
            </div>

            {/* Gross freight, with the miles under it — the two the desktop puts side by side. */}
            <span role="cell" className="whitespace-nowrap text-right tabular-nums">
              <span className="block text-card-foreground">
                {trip.freight != null ? money(trip.freight) : '—'}
              </span>
              {(trip.miles != null || trip.rate != null) && (
                <span className="block text-xs text-muted-foreground">
                  {[
                    trip.miles != null ? `${trip.miles.toLocaleString('en-US')} mi` : null,
                    trip.rate != null ? `${money(trip.rate)}/mi` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              )}
            </span>

            {/*
              The figure shows whether or not the load is on this check — it is what the
              driver most wants to know — but a held one is muted and labelled so it can
              never be mistaken for money arriving in this week's bank.
            */}
            <span role="cell" className="whitespace-nowrap text-right tabular-nums">
              <span className={`block font-semibold ${held ? 'text-muted-foreground' : 'text-card-foreground'}`}>
                {money(trip.amount)}
              </span>
              {held && trip.heldLabel && (
                <span className="block text-[10px] font-bold uppercase tracking-wide text-amber-800">
                  {trip.heldLabel}
                </span>
              )}
            </span>
            </div>

            {/* The paperwork, on its own line with room to say what each one is. */}
            <div role="cell" className="mt-2 flex flex-wrap items-center gap-2">
              <DocCell
                present={podIn}
                readOnly={readOnly}
                required
                label="POD"
                shipment={shipment}
                pageCount={podDoc?.document.pageCount}
                onPress={() => send('pod', trip)}
                onPreview={podDoc ? () => setOpen({ doc: podDoc, kind: 'POD', shipment }) : undefined}
              />
              <DocCell
                present={!!f?.rateconPresent}
                readOnly={readOnly}
                required={false}
                label="rate confirmation"
                shipment={shipment}
                pageCount={rcDoc?.document.pageCount}
                onPress={() => send('ratecon', trip)}
                onPreview={rcDoc ? () => setOpen({ doc: rcDoc, kind: 'RATECON', shipment }) : undefined}
              />
            </div>
          </div>
        )
      })}

      {/*
        The totals row, as the desktop prints it: freight total and driver share for the
        loads ON this check, and a plain statement of what was left out. Shown only when
        the server sent the figures — an older API has none, and inventing them from the
        rows would be a second sum that could disagree with the cheque.
      */}
      {trips.length > 0 && grossFreight != null && driverAmount != null && (
        <div
          role="row"
          data-testid="shipment-totals"
          className="grid grid-cols-[1fr_auto_auto] items-start gap-3 bg-muted/40 px-3 py-2.5 text-sm font-bold"
        >
          <span role="cell" className="min-w-0">
            <span className="block">
              {/* payPercent arrives as a fraction (0.88), the same shape the staff page formats. */}
              Freight total / driver share{payPercent != null ? ` (${Math.round(payPercent * 100)}%)` : ''}
            </span>
            {!!heldFreight && heldFreight > 0 && (
              <span className="block text-xs font-semibold text-amber-800">
                excludes {money(heldFreight)} held for POD
              </span>
            )}
          </span>
          <span role="cell" className="whitespace-nowrap text-right tabular-nums">{money(grossFreight)}</span>
          <span role="cell" className="whitespace-nowrap text-right tabular-nums">{money(driverAmount)}</span>
        </div>
      )}

      {open && (
        <DocPreviewSheet
          doc={open.doc}
          kind={open.kind}
          shipment={open.shipment}
          onClose={() => setOpen(null)}
          onReplace={() => {
            setOpen(null)
            docs.refresh()
            navigate(
              `/driver/scan?kind=${open.kind === 'POD' ? 'pod' : 'ratecon'}` +
                `&pro=${encodeURIComponent(open.shipment)}`,
            )
          }}
          onAddPages={() => {
            // Nothing removed: the server puts further pages onto the submission this
            // shipment already has, so the office still ends up with one document.
            setOpen(null)
            navigate(
              `/driver/scan?kind=${open.kind === 'POD' ? 'pod' : 'ratecon'}` +
                `&pro=${encodeURIComponent(open.shipment)}`,
            )
          }}
          onRemoved={() => {
            setOpen(null)
            docs.refresh()
          }}
        />
      )}
    </div>
  )
}
