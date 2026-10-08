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
 */
import { useState } from 'react'
import { Camera, Check, Loader2, PackageOpen, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { apptTimeLabel } from '@/lib/date'
import { errorText } from '@/lib/errorText'
import { setStopDetention, type PaperworkLoad } from '../driverApi'

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

export function TodayStops({
  loads,
  today,
  onSendPod,
  onChange,
}: {
  loads: PaperworkLoad[]
  today: string
  onSendPod: (load: PaperworkLoad) => void
  /** A flag changed; the page refreshes its copy of the week. */
  onChange: () => void
}) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const items = stopsForDay(loads, today).map((it) => {
    const key = `${it.load.id}#${it.stop.id}`
    return key in overrides ? { ...it, stop: { ...it.stop, detention: overrides[key] } } : it
  })

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
        return (
          <li
            key={`${load.id}#${stop.id}`}
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

            <p className="mt-2 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{load.reference}</span>
              {load.customer ? ` · ${load.customer}` : ''}
            </p>

            <DetentionBox
              item={item}
              onChange={(next) => {
                setOverrides((o) => ({ ...o, [`${next.load.id}#${next.stop.id}`]: next.stop.detention }))
                onChange()
              }}
            />

            {delivery && (
              <Button
                className="mt-3 h-14 w-full gap-2 text-base font-bold"
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
    </ul>
  )
}
