import { useEffect, useState } from 'react'
import { Loader2, Truck, Warehouse, Container, Check, HelpCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { setPaperworkLocation, confirmPaperwork, fetchTrailers, type PaperworkLoad, type TrailerChoice } from '../driverApi'
import type { PaperworkPlace } from '@/lib/paperworkLocation'
import type { TodayStop } from './daySheet'

/*
 * The two paperwork questions around the clock.
 *
 * End of day, before clocking out: any paperwork from today, and where did each one go?
 * One screen, every load on it, a tap per load, and a skip for a day with none — answered
 * standing in a yard with a phone, so it has to be quick.
 * Start of day, before clocking in: for each load being delivered today that was picked
 * up earlier, does the driver have the paperwork in hand? Asked one load at a time.
 */

export interface WhereItem { load: PaperworkLoad; pickupName: string | null }

interface WhereProps {
  items: WhereItem[]
  /** The truck the driver is in, prefilled as the passenger-seat answer. */
  truckUnit: string | null
  onClose: () => void
  /** Every load answered. */
  onDone: () => void
}

export function EndOfDayPaperworkDialog({ items, truckUnit, onClose, onDone }: WhereProps) {
  type Choice = { kind: Exclude<PaperworkPlace, 'UNKNOWN'>; unit: string }
  // One answer per load, chosen with a tap; nothing is saved until "Save & clock out".
  const [choices, setChoices] = useState<Record<string, Choice | undefined>>({})
  const [truck, setTruck] = useState(truckUnit ?? '')
  const [trailers, setTrailers] = useState<Record<string, string>>(() => Object.fromEntries(items.map((it) => [it.load.id, it.load.trailerNumber ?? ''])))
  const [busy, setBusy] = useState(false)

  const pick = (loadId: string, kind: Choice['kind']) =>
    setChoices((c) => (c[loadId]?.kind === kind ? { ...c, [loadId]: undefined } : { ...c, [loadId]: { kind, unit: '' } }))

  const chosen = items.filter((it) => choices[it.load.id])

  const save = async () => {
    for (const it of chosen) {
      const kind = choices[it.load.id]!.kind
      const unit = kind === 'TRUCK' ? truck.trim() : kind === 'TRAILER' ? (trailers[it.load.id] ?? '').trim() : ''
      if (kind !== 'SHED' && !unit) { toast.error(kind === 'TRUCK' ? 'Which truck? Enter the unit number.' : `Which trailer for PRO ${it.load.reference}? Enter its number.`); return }
    }
    setBusy(true)
    try {
      await Promise.all(chosen.map((it) => {
        const kind = choices[it.load.id]!.kind
        const unit = kind === 'TRUCK' ? truck.trim() : kind === 'TRAILER' ? (trailers[it.load.id] ?? '').trim() : null
        return setPaperworkLocation(it.load.id, kind, unit)
      }))
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const chip = (loadId: string, kind: Choice['kind'], icon: React.ReactNode, label: string) => {
    const on = choices[loadId]?.kind === kind
    return (
      <button type="button" disabled={busy} onClick={() => pick(loadId, kind)} aria-pressed={on}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold ${on ? 'border-primary bg-primary/15 text-foreground' : 'border-border bg-card text-muted-foreground'}`}>
        {icon} {label}
      </button>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Any paperwork from today?</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Tap where you put each one. Skip if you have none.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {/* The truck is one answer for the whole day: a driver sits in one cab. */}
          <label htmlFor="paperwork-truck" className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-2"><Truck className="h-4 w-4 text-primary" /> Your truck</span>
            <input id="paperwork-truck" value={truck} onChange={(e) => setTruck(e.target.value)} placeholder="unit" inputMode="numeric"
              className="h-9 w-20 rounded-md border border-input bg-background px-2 text-center font-mono text-base text-foreground" />
          </label>
          <ul className="grid gap-2">
            {items.map((it) => {
              const c = choices[it.load.id]
              return (
                <li key={it.load.id} className="rounded-xl border border-border bg-card p-3">
                  <div className="mb-2 text-sm">
                    <span className="font-bold text-foreground">PRO {it.load.reference}</span>
                    {it.pickupName ? <span className="text-muted-foreground"> · {it.pickupName}</span> : null}
                    {c ? <Check className="ml-2 inline h-4 w-4 text-primary" aria-label="answered" /> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {chip(it.load.id, 'TRUCK', <Truck className="h-4 w-4" />, 'Seat')}
                    {chip(it.load.id, 'SHED', <Warehouse className="h-4 w-4" />, 'Shed')}
                    {chip(it.load.id, 'TRAILER', <Container className="h-4 w-4" />, 'Trailer')}
                    {c?.kind === 'TRAILER' ? (
                      <input aria-label={`Trailer number for PRO ${it.load.reference}`} value={trailers[it.load.id] ?? ''} onChange={(e) => setTrailers((t) => ({ ...t, [it.load.id]: e.target.value }))} placeholder="trailer #" inputMode="numeric" autoFocus
                        className="h-9 w-24 rounded-md border border-input bg-background px-2 text-center font-mono text-base text-foreground" />
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button type="button" variant="outline" className="h-12" disabled={busy} onClick={onDone}>
              No paperwork today
            </Button>
            <Button type="button" className="h-12 font-bold" disabled={busy || chosen.length === 0} onClick={() => void save()}>
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : `Save${chosen.length > 1 ? ` ${chosen.length}` : ''} & clock out`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export interface ConfirmItem { load: PaperworkLoad; deliveryName: string | null; where: string | null }

interface ConfirmProps {
  items: ConfirmItem[]
  onClose: () => void
  onDone: () => void
}

export function StartOfDayPaperworkDialog({ items, onClose, onDone }: ConfirmProps) {
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const item = items[index]
  if (!item) return null
  const answer = async (confirm: 'HAVE' | 'MISSING') => {
    setBusy(true)
    try {
      await confirmPaperwork(item.load.id, confirm)
      if (confirm === 'MISSING') toast.warning('Dispatch has been told. Check with the office before you leave.')
      if (index + 1 < items.length) setIndex(index + 1)
      else onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Do you have the paperwork?</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            PRO {item.load.reference}{item.deliveryName ? ` · delivering to ${item.deliveryName}` : ''}{items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{item.where ? `It was left: ${item.where}.` : 'Nobody recorded where it was left.'}</p>
        <div className="grid gap-3">
          <Button className="h-14 text-base font-bold" disabled={busy} onClick={() => void answer('HAVE')}><Check className="mr-2 h-5 w-5" /> Yes, I have it</Button>
          <Button variant="outline" className="h-14 text-base font-semibold" disabled={busy} onClick={() => void answer('MISSING')}><HelpCircle className="mr-2 h-5 w-5" /> I can't find it</Button>
          {busy ? <div className="flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Leaving a pickup: which trailer is the load on? A pick-list of the trailers on file. */
export function TrailerDialog({ item, onClose, onPick }: { item: TodayStop; onClose: () => void; onPick: (trailer: string) => void }) {
  const [trailers, setTrailers] = useState<TrailerChoice[] | null>(null)
  const [choice, setChoice] = useState(item.load.trailerNumber ?? '')
  const [other, setOther] = useState('')
  useEffect(() => {
    let alive = true
    fetchTrailers().then((rows) => { if (alive) setTrailers(rows) }).catch(() => { if (alive) setTrailers([]) })
    return () => { alive = false }
  }, [])
  const listed = trailers ?? []
  const onFile = listed.some((t) => t.unitNumber === choice)
  // The load's current trailer may be one not on file; keep it selectable.
  const options = item.load.trailerNumber && !listed.some((t) => t.unitNumber === item.load.trailerNumber)
    ? [{ id: 'current', unitNumber: item.load.trailerNumber, nickname: null }, ...listed]
    : listed
  const go = () => {
    const t = (choice === OTHER ? other : choice).trim()
    if (!t) { toast.error('Pick the trailer') ; return }
    onPick(t)
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Which trailer?</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            PRO {item.load.reference}{item.stop.name ? ` · leaving ${item.stop.name}` : ''}. The trailer this load is on.
          </DialogDescription>
        </DialogHeader>
        {trailers === null ? <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin" /></div> : (
          <select id="pickup-trailer" value={onFile || choice === OTHER || choice === '' ? choice : OTHER} onChange={(e) => setChoice(e.target.value)} autoFocus
            className="h-14 w-full rounded-md border border-input bg-background px-3 font-mono text-xl text-foreground">
            <option value="">Pick a trailer…</option>
            {options.map((t) => <option key={t.id} value={t.unitNumber}>{t.unitNumber}{t.nickname ? ` · ${t.nickname}` : ''}</option>)}
            <option value={OTHER}>Not on the list…</option>
          </select>
        )}
        {choice === OTHER ? (
          <input id="pickup-trailer-other" value={other} onChange={(e) => setOther(e.target.value)} placeholder="Trailer number" inputMode="numeric" autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') go() }}
            className="h-12 w-full rounded-md border border-input bg-background px-3 text-center font-mono text-xl text-foreground" />
        ) : null}
        <Button className="h-14 text-base font-bold" onClick={go} disabled={trailers === null}><Container className="mr-2 h-5 w-5" /> Departed with this trailer</Button>
      </DialogContent>
    </Dialog>
  )
}

const OTHER = '__other__'
