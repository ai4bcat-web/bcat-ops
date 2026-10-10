import { useState } from 'react'
import { Loader2, Truck, Warehouse, Container, Check, HelpCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { setPaperworkLocation, confirmPaperwork, type PaperworkLoad } from '../driverApi'
import type { PaperworkPlace } from '@/lib/paperworkLocation'
import type { TodayStop } from './daySheet'

/*
 * The two paperwork questions around the clock.
 *
 * End of day, before clocking out: for each load picked up today, where did the BOL go?
 * Start of day, before clocking in: for each load being delivered today that was picked
 * up earlier, does the driver have the paperwork in hand? Both are asked one load at a
 * time with big buttons, because this is answered standing in a yard with a phone.
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
  const [index, setIndex] = useState(0)
  const [truck, setTruck] = useState(truckUnit ?? '')
  const [trailer, setTrailer] = useState(items[0]?.load.trailerNumber ?? '')
  const [busy, setBusy] = useState(false)
  const item = items[index]
  if (!item) return null

  const answer = async (kind: Exclude<PaperworkPlace, 'UNKNOWN'>) => {
    const unit = kind === 'TRUCK' ? truck.trim() : kind === 'TRAILER' ? trailer.trim() : null
    if (kind !== 'SHED' && !unit) { toast.error(kind === 'TRUCK' ? 'Which truck? Enter the unit number.' : 'Which trailer? Enter its number.'); return }
    setBusy(true)
    try {
      await setPaperworkLocation(item.load.id, kind, unit)
      if (index + 1 < items.length) {
        setIndex(index + 1)
        setTrailer(items[index + 1].load.trailerNumber ?? '')
      } else {
        onDone()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const unitInput = (id: string, value: string, onChange: (v: string) => void, placeholder: string) => (
    <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="numeric"
      onClick={(e) => e.stopPropagation()}
      className="h-10 w-24 rounded-md border border-input bg-background px-2 text-center font-mono text-base text-foreground" />
  )

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Where is the paperwork?</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            PRO {item.load.reference}{item.pickupName ? ` · picked up at ${item.pickupName}` : ''}{items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <button type="button" disabled={busy} onClick={() => void answer('TRUCK')}
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-left text-base font-semibold hover:border-primary">
            <span className="flex items-center gap-3"><Truck className="h-6 w-6 text-primary" /> Passenger seat of truck</span>
            {unitInput('paperwork-truck', truck, setTruck, 'unit')}
          </button>
          <button type="button" disabled={busy} onClick={() => void answer('SHED')}
            className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left text-base font-semibold hover:border-primary">
            <Warehouse className="h-6 w-6 text-primary" /> In the shed
          </button>
          <button type="button" disabled={busy} onClick={() => void answer('TRAILER')}
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-left text-base font-semibold hover:border-primary">
            <span className="flex items-center gap-3"><Container className="h-6 w-6 text-primary" /> In the trailer</span>
            {unitInput('paperwork-trailer', trailer, setTrailer, 'trailer #')}
          </button>
          {busy ? <div className="flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : null}
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

/** Leaving a pickup: which trailer is the load on? Required for Ivan's local drivers. */
export function TrailerDialog({ item, onClose, onPick }: { item: TodayStop; onClose: () => void; onPick: (trailer: string) => void }) {
  const [trailer, setTrailer] = useState(item.load.trailerNumber ?? '')
  const go = () => {
    const t = trailer.trim()
    if (!t) { toast.error('Enter the trailer number'); return }
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
        <input id="pickup-trailer" value={trailer} onChange={(e) => setTrailer(e.target.value)} placeholder="Trailer number" inputMode="numeric" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
          className="h-12 w-full rounded-md border border-input bg-background px-3 text-center font-mono text-xl text-foreground" />
        <Button className="h-14 text-base font-bold" onClick={go}><Container className="mr-2 h-5 w-5" /> Departed with this trailer</Button>
      </DialogContent>
    </Dialog>
  )
}
