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
  present, required, label, shipment, onPress, onPreview,
}: {
  present: boolean
  /** Amber when its absence holds the driver's pay. Only the POD does. */
  required: boolean
  label: string
  /** Named in the accessible label so the rows are told apart, not just numbered. */
  shipment: string
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

  if (present) {
    if (!onPreview) {
      return (
        <span
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700"
          aria-label={`${label} on file for ${shipment}`}
        >
          <Check className="h-3.5 w-3.5" /> {short} in
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
        <Eye className="h-3.5 w-3.5" /> {short} in
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

export function ShipmentRows({ trips }: { trips: Trip[] }) {
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
      <div
        role="row"
        className="grid grid-cols-[1fr_auto] gap-2 border-b border-border px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        <span role="columnheader">Shipment</span>
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
            <div className="grid grid-cols-[1fr_auto] items-start gap-2">
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
                  Not on this check until the POD is in
                </p>
              )}
            </div>

            <span
              role="cell"
              className="whitespace-nowrap text-right font-semibold tabular-nums text-card-foreground"
            >
              {money(trip.amount)}
            </span>
            </div>

            {/* The paperwork, on its own line with room to say what each one is. */}
            <div role="cell" className="mt-2 flex flex-wrap items-center gap-2">
              <DocCell
                present={podIn}
                required
                label="POD"
                shipment={shipment}
                onPress={() => send('pod', trip)}
                onPreview={podDoc ? () => setOpen({ doc: podDoc, kind: 'POD', shipment }) : undefined}
              />
              <DocCell
                present={!!f?.rateconPresent}
                required={false}
                label="rate confirmation"
                shipment={shipment}
                onPress={() => send('ratecon', trip)}
                onPreview={rcDoc ? () => setOpen({ doc: rcDoc, kind: 'RATECON', shipment }) : undefined}
              />
            </div>
          </div>
        )
      })}

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
          onRemoved={() => {
            setOpen(null)
            docs.refresh()
          }}
        />
      )}
    </div>
  )
}
