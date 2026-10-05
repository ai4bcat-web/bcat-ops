/**
 * Where a driver records the clock at a dock.
 *
 * Offered on every load rather than only on the ones that ran long, because the driver is
 * the only person who knows how long they sat and they know it only while they are there.
 * The sheet says what counts as detention so nobody has to remember the rule, and it keeps
 * a short wait if one is entered — the record is the driver's account, not a filtered
 * version of it.
 */
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { saveLoadTimes, type PaperworkLoad, type PaperworkTimes } from '../driverApi'
import { errorText } from '@/lib/errorText'

/** Matches DETENTION_FREE_HOURS on the server. */
const FREE_HOURS = 2

function hoursBetween(timeIn: string, timeOut: string): number | null {
  const a = Date.parse(`${timeIn}:00Z`)
  const b = Date.parse(`${timeOut}:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const raw = (b - a) / 3_600_000
  return Math.round((raw < 0 ? raw + 24 : raw) * 100) / 100
}

export function LoadTimesSheet({
  load,
  leg,
  onClose,
  onSaved,
}: {
  load: PaperworkLoad
  leg: 'PICKUP' | 'DELIVERY'
  onClose: () => void
  onSaved: () => void
}) {
  const existing: PaperworkTimes = leg === 'PICKUP' ? load.pickupTimes : load.deliveryTimes
  const [timeIn, setTimeIn] = useState(existing.timeIn ?? '')
  const [timeOut, setTimeOut] = useState(existing.timeOut ?? '')
  const [notes, setNotes] = useState(existing.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hours = timeIn && timeOut ? hoursBetween(timeIn, timeOut) : null
  const billable = hours !== null && hours > FREE_HOURS

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await saveLoadTimes({ loadId: load.id, leg, timeIn: timeIn || null, timeOut: timeOut || null, notes: notes || null })
      onSaved()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60" role="dialog" aria-modal="true" aria-label="Record times">
      <div className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-background p-5 pb-8 text-foreground">
        <h2 className="text-lg font-bold">
          {leg === 'PICKUP' ? 'Pickup' : 'Delivery'} times · {load.reference}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          When you arrived and when you left. Over {FREE_HOURS} hours counts as detention and the
          office can bill it.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted-foreground">Time in</span>
            <Input
              id={`time-in-${leg}`}
              type="datetime-local"
              value={timeIn}
              onChange={(e) => setTimeIn(e.target.value)}
              className="h-12 bg-background text-base text-foreground"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted-foreground">Time out</span>
            <Input
              id={`time-out-${leg}`}
              type="datetime-local"
              value={timeOut}
              onChange={(e) => setTimeOut(e.target.value)}
              className="h-12 bg-background text-base text-foreground"
            />
          </label>
        </div>

        {hours !== null && (
          <p className={`mt-3 text-sm font-semibold ${billable ? 'text-amber-400' : 'text-muted-foreground'}`}>
            {hours} hour{hours === 1 ? '' : 's'} at the dock
            {billable ? ' · over 2 hours, this is detention' : ' · under 2 hours'}
          </p>
        )}

        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium text-muted-foreground">Notes (optional)</span>
          <Input
            id={`time-notes-${leg}`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Who you spoke to, what the hold-up was"
            className="h-12 bg-background text-base text-foreground"
          />
        </label>

        {error && <p className="mt-3 text-sm font-medium text-destructive">{error}</p>}

        <div className="mt-5 flex gap-3">
          <Button variant="outline" className="h-12 flex-1 text-base" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button className="h-12 flex-1 gap-2 text-base font-semibold" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save times
          </Button>
        </div>
      </div>
    </div>
  )
}
