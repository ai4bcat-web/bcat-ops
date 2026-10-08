/**
 * Today's pickups and deliveries — the Ivan driver's day sheet.
 *
 * A driver standing at a dock wants two things from the app: the one box that says "this
 * went long" and, at a delivery, the button that sends the POD. So that is the whole card.
 *
 * Detention is a yes/no, not a form. The rule is printed under the box so nobody has to
 * remember it, and the in/out times go on the BOL where the customer signs for them —
 * which is the record the office actually bills from. The app used to ask for the clock a
 * second time; drivers did not fill it in.
 *
 * Built from the week's loads: every stop whose appointment falls on today (Chicago), in
 * appointment order, pickups and deliveries alike. A load that loads today and delivers
 * tomorrow shows its pickup today and its delivery tomorrow.
 *
 * Each card also carries the stop's progress — on site, departed, delivered — reported
 * with one tap and stamped on the load for dispatch (src/lib/stopEvents.ts), and, on a
 * delivery the driver is rolling toward, the ETA the server worked out from the truck.
 */
import { useState } from 'react'
import { Camera, Check, Eye, FileWarning, Loader2, LogOut, MapPin, Navigation, PackageOpen, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTripDocs, type TripDoc } from '../settlement/useTripDocs'
import { DocPreviewSheet } from '../settlement/DocPreviewSheet'
import { apptTimeLabel } from '@/lib/date'
import { errorText } from '@/lib/errorText'
import { recordStopEvent, setStopDetention, type PaperworkLoad, type PaperworkStop, type StopEvent } from '../driverApi'

import { DETENTION_HOURS, isDelivery, stopsForDay, type TodayStop } from './daySheet'

function DetentionBox({ item, onChange }: { item: TodayStop; onChange: (next: TodayStop) => void }) {
  const [saving, setSaving] = useState(false)
  const flagged = item.stop.detention
  const inputId = `detention-${item.load.id}-${item.stop.id}`

  async function toggle() {
    const next = !flagged
    setSaving(true)
    try {
      await setStopDetention({ loadId: item.load.id, stopId: item.stop.id, detention: next })
      onChange({ ...item, stop: { ...item.stop, detention: next } })
      toast.success(next ? 'Detention flagged — the office will see it' : 'Detention cleared')
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <label
      htmlFor={inputId}
      className={`mt-3 flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
        flagged ? 'border-amber-400/60 bg-amber-500/15' : 'border-border bg-background/60'
      }`}
    >
      <span className="relative mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center">
        <input
          id={inputId}
          type="checkbox"
          className="peer h-6 w-6 cursor-pointer appearance-none rounded-md border-2 border-muted-foreground/70 bg-background checked:border-amber-400 checked:bg-amber-400 disabled:opacity-60"
          checked={flagged}
          disabled={saving}
          onChange={() => void toggle()}
        />
        {saving
          ? <Loader2 className="pointer-events-none absolute h-4 w-4 animate-spin text-foreground" aria-hidden="true" />
          : <Check className="pointer-events-none absolute hidden h-4 w-4 text-background peer-checked:block" strokeWidth={3} aria-hidden="true" />}
      </span>
      <span className="min-w-0">
        <span className={`block text-base font-semibold ${flagged ? 'text-amber-200' : 'text-foreground'}`}>
          Detention{flagged ? ' — flagged' : ''}
        </span>
        <span className="block text-sm text-muted-foreground">
          Check this if you were here {DETENTION_HOURS} hours or longer from your appointment time.
          Please write your in and out times on the BOL.
        </span>
      </span>
    </label>
  )
}

/** Where the POD stands, said once on the delivery card. Three states, not the same problem. */
function PodStatus({ load, doc, onView }: { load: PaperworkLoad; doc: TripDoc | null; onView: () => void }) {
  const { pod } = load
  if (!pod.present && !doc) return null
  const bad = pod.legibility === 'UNREADABLE' || pod.legibility === 'LOW'
  return (
    <div className="mt-3 flex flex-col gap-2">
      {bad ? (
        <p className="flex items-start gap-2 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">
          <FileWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">{pod.legibility === 'UNREADABLE' ? 'POD unreadable' : 'POD hard to read'}</span>
            {pod.notes ? ` — ${pod.notes}. Please send a new photo.` : ' — please send a new photo.'}
          </span>
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-emerald-200">
          <Check className="h-4 w-4" aria-hidden="true" />
          POD on file{pod.pages > 1 ? ` · ${pod.pages} pages` : ''}
        </p>
      )}
      {doc && (
        <Button variant="outline" className="h-12 w-full gap-2 text-base font-semibold" onClick={onView}>
          <Eye className="h-5 w-5" aria-hidden="true" />
          View POD{doc.document.pageCount > 1 ? ` (${doc.document.pageCount} pages)` : ''}
        </Button>
      )}
    </div>
  )
}

/** "9:12 AM" in Chicago, for a stamp the driver just made. */
function clock(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
}

function StatusPill({ tone, children }: { tone: 'sky' | 'emerald' | 'slate'; children: React.ReactNode }) {
  const cls = tone === 'emerald'
    ? 'bg-emerald-400/20 text-emerald-100'
    : tone === 'sky' ? 'bg-sky-400/20 text-sky-100' : 'bg-muted text-muted-foreground'
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${cls}`}>{children}</span>
}

/**
 * The stop's status and the one button that moves it on.
 *   pickup:    On site at pickup → Departed
 *   delivery:  On site at delivery → Delivered (which also opens the POD scanner)
 */
function StopProgress({
  item,
  busy,
  onEvent,
}: {
  item: TodayStop
  busy: boolean
  onEvent: (event: StopEvent) => void
}) {
  const { stop } = item
  const delivery = isDelivery(stop)
  if (stop.departedAt) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill tone={delivery ? 'emerald' : 'sky'}>
          <Check className="h-4 w-4" aria-hidden="true" />
          {delivery ? 'Delivered' : 'Departed'} {clock(stop.departedAt)}
        </StatusPill>
      </div>
    )
  }
  if (stop.arrivedAt) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <StatusPill tone={delivery ? 'emerald' : 'sky'}>
          <MapPin className="h-4 w-4" aria-hidden="true" />
          On site since {clock(stop.arrivedAt)}
        </StatusPill>
        <Button className="h-14 w-full gap-2 text-base font-bold" disabled={busy} onClick={() => onEvent('DEPARTED')}>
          {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : delivery ? <Camera className="h-5 w-5" aria-hidden="true" /> : <LogOut className="h-5 w-5" aria-hidden="true" />}
          {delivery ? 'Delivered — send POD' : 'Departed'}
        </Button>
      </div>
    )
  }
  return (
    <Button
      variant="outline"
      className="mt-3 h-14 w-full gap-2 text-base font-bold"
      disabled={busy}
      onClick={() => onEvent('ARRIVED')}
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <MapPin className="h-5 w-5" aria-hidden="true" />}
      {delivery ? 'On site at delivery' : 'On site at pickup'}
    </Button>
  )
}

export function TodayStops({
  loads,
  today,
  onSendPod,
  onChange,
}: {
  loads: PaperworkLoad[]
  /** The day on screen — today, or one the driver paged back to. */
  today: string
  onSendPod: (load: PaperworkLoad) => void
  /** A flag or event changed; the page refreshes its copy of the week. */
  onChange: () => void
}) {
  // What the driver just did, applied on top of the week until the refetch lands.
  const [patches, setPatches] = useState<Record<string, Partial<PaperworkStop>>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  // The documents the driver has sent, so a delivered load can show its POD back to them.
  const docs = useTripDocs()
  const [viewing, setViewing] = useState<{ doc: TripDoc; load: PaperworkLoad } | null>(null)
  const keyOf = (it: TodayStop) => `${it.load.id}#${it.stop.id}`
  const patch = (it: TodayStop, p: Partial<PaperworkStop>) =>
    setPatches((all) => ({ ...all, [keyOf(it)]: { ...all[keyOf(it)], ...p } }))

  const items = stopsForDay(loads, today).map((it) =>
    keyOf(it) in patches ? { ...it, stop: { ...it.stop, ...patches[keyOf(it)] } } : it)

  async function sendEvent(item: TodayStop, event: StopEvent) {
    const key = keyOf(item)
    setBusyKey(key)
    try {
      const res = await recordStopEvent({ loadId: item.load.id, stopId: item.stop.id, event })
      patch(item, event === 'ARRIVED' ? { arrivedAt: res.at } : { departedAt: res.at })
      if (res.eta) {
        // The delivery this ETA is for may be on today's sheet too.
        const target = items.find((x) => x.load.id === item.load.id && x.stop.id === res.eta!.stopId)
        if (target) patch(target, { etaAt: res.eta.etaAt, etaBasis: res.eta.basis })
      }
      onChange()
      if (event === 'DEPARTED' && isDelivery(item.stop)) {
        onSendPod(item.load)
      } else {
        toast.success(event === 'ARRIVED' ? 'Marked on site' : 'Marked departed')
      }
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusyKey(null)
    }
  }

  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card p-5 text-center text-sm text-muted-foreground">
        No pickups or deliveries scheduled today.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const { load, stop } = item
        const delivery = isDelivery(stop)
        const podOk = load.pod.present && load.pod.legibility === 'OK'
        const podDoc = delivery ? docs.find('POD', load.id, load.reference) : null
        const showEta = delivery && !!stop.etaAt && !stop.arrivedAt && !stop.departedAt
        return (
          <li
            key={keyOf(item)}
            className={`rounded-xl border p-4 ${delivery ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-sky-400/40 bg-sky-500/10'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ${
                  delivery ? 'bg-emerald-400/20 text-emerald-200' : 'bg-sky-400/20 text-sky-200'
                }`}>
                  {delivery ? <PackageOpen className="h-3.5 w-3.5" aria-hidden="true" /> : <Truck className="h-3.5 w-3.5" aria-hidden="true" />}
                  {delivery ? 'Delivery' : 'Pickup'}
                </span>
                <p className="mt-2 text-lg font-bold leading-tight text-foreground">{stop.name ?? 'Stop'}</p>
                <p className="text-sm text-muted-foreground">
                  {[stop.city, stop.state].filter(Boolean).join(', ') || '—'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-2xl font-bold tabular-nums text-foreground">
                  {apptTimeLabel(stop.appt, stop.apptType, stop.apptEnd)}
                </p>
                <p className="text-xs text-muted-foreground">appt</p>
              </div>
            </div>

            {/* The numbers the shipper and the office will ask for, in the order they ask. */}
            <dl className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-background/50 px-3 py-2">
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">BCAT PRO #</dt>
                <dd className="text-base font-bold tabular-nums text-foreground">{load.reference}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">PO #</dt>
                <dd className="truncate text-base font-bold tabular-nums text-foreground">{load.poNumber || '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">PU #</dt>
                <dd className="truncate text-base font-bold tabular-nums text-foreground">{load.pickupNumber || '—'}</dd>
              </div>
            </dl>
            {load.customer && <p className="mt-1.5 text-sm text-muted-foreground">{load.customer}</p>}

            {showEta && (
              <p className="mt-3 flex items-center gap-2 rounded-lg bg-background/50 px-3 py-2 text-sm">
                <Navigation className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                <span className="text-foreground">
                  <span className="font-bold">ETA {clock(stop.etaAt)}</span>
                  <span className="text-muted-foreground">
                    {stop.etaBasis === 'motive' ? ' · from your truck’s location' : ' · the appointment time'}
                  </span>
                </span>
              </p>
            )}

            <StopProgress item={item} busy={busyKey === keyOf(item)} onEvent={(ev) => void sendEvent(item, ev)} />

            <DetentionBox
              item={item}
              onChange={(next) => {
                patch(next, { detention: next.stop.detention })
                onChange()
              }}
            />

            {delivery && (
              <PodStatus load={load} doc={podDoc} onView={() => podDoc && setViewing({ doc: podDoc, load })} />
            )}

            {delivery && (stop.departedAt || load.pod.present) && (
              <Button
                className="mt-3 h-12 w-full gap-2 text-base font-semibold"
                variant={podOk ? 'outline' : 'default'}
                onClick={() => onSendPod(load)}
              >
                <Camera className="h-5 w-5" aria-hidden="true" />
                {load.pod.present ? 'Replace POD' : 'Send POD'}
              </Button>
            )}
          </li>
        )
      })}

      {viewing && (
        <DocPreviewSheet
          doc={viewing.doc}
          kind="POD"
          shipment={viewing.load.reference}
          onClose={() => setViewing(null)}
          onReplace={() => { setViewing(null); docs.refresh(); onSendPod(viewing.load) }}
          onAddPages={() => { setViewing(null); onSendPod(viewing.load) }}
          onRemoved={() => { setViewing(null); docs.refresh(); onChange() }}
        />
      )}
    </ul>
  )
}
