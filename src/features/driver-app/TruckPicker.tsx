/**
 * Which truck the driver is in today.
 *
 * Asked at the start of the day because that is when it changes: a driver who hops into
 * a different unit and does not say so has their ELD logs, their PM line and their
 * position on the dispatch map all land on somebody else's name. One pick writes the
 * same two-sided assignment the office makes from the fleet page.
 */
import { useEffect, useState } from 'react'
import { Loader2, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchTrucks, selectTruck, type TruckChoice } from './driverApi'
import { useDriverTruck } from './useDriverProgram'
import { errorText } from '@/lib/errorText'

export function TruckPickerDialog({
  open, onClose, onPicked,
}: {
  open: boolean
  onClose: () => void
  onPicked?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="dark max-h-[85dvh] overflow-y-auto bg-background text-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Which truck are you in today?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Pick your unit so your ELD logs and your truck's location are on your name.
        </p>
        {/* Mounted fresh each time the dialog opens, so the list is fetched anew without any state to reset. */}
        {open && <TruckList onClose={onClose} onPicked={onPicked} />}
      </DialogContent>
    </Dialog>
  )
}

function TruckList({ onClose, onPicked }: { onClose: () => void; onPicked?: () => void }) {
  const { truck, setTruck } = useDriverTruck()
  const [list, setList] = useState<TruckChoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /*
   * Two guards against the wrong row.
   *
   * A driver with a truck on file is asked "still in 780?" and only sees the list if the
   * answer is no — the morning after a mis-tap, the highlighted row is the one a thumb
   * lands on. And a pick from the list is confirmed with the number large before it is
   * saved: a thumb on the row above or below is how Josh spent two days filed in a truck
   * he was never in.
   */
  // Derived at render, not at mount: the profile (and so `truck`) can arrive after the dialog opens.
  const [wantsList, setWantsList] = useState(false)
  const showList = !truck || wantsList
  const [confirming, setConfirming] = useState<TruckChoice | null>(null)

  useEffect(() => {
    let stale = false
    fetchTrucks()
      .then((t) => { if (!stale) setList(t) })
      .catch((e) => { if (!stale) setError(errorText(e)) })
    return () => { stale = true }
  }, [])

  async function pick(t: Pick<TruckChoice, 'id' | 'unitNumber'>) {
    setBusy(t.id)
    try {
      const res = await selectTruck(t.id)
      setTruck(res.truck)
      toast.success(`You're in truck ${res.truck.unitNumber}`)
      onClose()
      onPicked?.()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!list) {
    return <div className="flex justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" /></div>
  }

  if (confirming) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Switch to this truck?</p>
        <p className="text-center text-5xl font-black tabular-nums text-foreground">{confirming.unitNumber}</p>
        {confirming.holder && !confirming.yours && <p className="text-center text-sm text-amber-300">{confirming.holder} is in it now — they will be taken off it.</p>}
        <Button type="button" size="lg" className="h-14 w-full text-base font-bold" disabled={busy !== null} onClick={() => void pick(confirming)}>
          {busy === confirming.id ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : `Yes, I'm in ${confirming.unitNumber}`}
        </Button>
        <Button type="button" size="lg" variant="outline" className="h-12 w-full text-base" disabled={busy !== null} onClick={() => setConfirming(null)}>Back to the list</Button>
      </div>
    )
  }

  if (truck && !showList) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Still in this truck?</p>
        <p className="text-center text-5xl font-black tabular-nums text-foreground">{truck.unitNumber}</p>
        <Button type="button" size="lg" className="h-14 w-full text-base font-bold" disabled={busy !== null} onClick={() => void pick(truck)}>
          {busy === truck.id ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : `Yes, still in ${truck.unitNumber}`}
        </Button>
        <Button type="button" size="lg" variant="outline" className="h-12 w-full text-base" disabled={busy !== null} onClick={() => setWantsList(true)}>No, a different truck</Button>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {list.map((t) => {
        const current = truck?.id === t.id
        return (
          <li key={t.id}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirming(t)}
              aria-label={`Truck ${t.unitNumber}${current ? ' (your current truck)' : ''}`}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${
                current ? 'border-primary bg-primary/10' : 'border-border bg-card'
              }`}
            >
              <Truck className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-bold tabular-nums text-foreground">{t.unitNumber}</span>
                <span className="block text-xs text-muted-foreground">
                  {current ? 'Your truck now' : t.holder ? `Currently ${t.holder}` : 'Nobody in it'}
                  {t.eld ? ' · ELD' : ' · no ELD gateway'}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** The line at the top of the day: which truck, or the ask to pick one. */
export function TruckLine() {
  const { truck, loaded } = useDriverTruck()
  const [open, setOpen] = useState(false)
  if (!loaded) return null
  return (
    <>
      {truck ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <p className="flex items-center gap-2 text-sm">
            <Truck className="h-4 w-4 text-primary" aria-hidden="true" />
            <span className="text-muted-foreground">Your truck</span>
            <span className="text-base font-bold tabular-nums text-foreground">{truck.unitNumber}</span>
          </p>
          <Button variant="outline" size="sm" className="h-9" onClick={() => setOpen(true)}>Change</Button>
        </div>
      ) : (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-400/50 bg-amber-500/15 px-4 py-3">
          <p className="text-sm font-semibold text-amber-100">Which truck are you in today?</p>
          <Button size="sm" className="h-9 font-bold" onClick={() => setOpen(true)}>Pick your truck</Button>
        </div>
      )}
      <TruckPickerDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
