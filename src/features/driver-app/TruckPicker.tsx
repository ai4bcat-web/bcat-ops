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

  useEffect(() => {
    let stale = false
    fetchTrucks()
      .then((t) => { if (!stale) setList(t) })
      .catch((e) => { if (!stale) setError(errorText(e)) })
    return () => { stale = true }
  }, [])

  async function pick(t: TruckChoice) {
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
  return (
    <ul className="flex flex-col gap-2">
      {list.map((t) => {
        const current = truck?.id === t.id
        return (
          <li key={t.id}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void pick(t)}
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
              {busy === t.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
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
