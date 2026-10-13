/**
 * Which trailer the driver is starting the day with, asked right after the truck at
 * clock-in for Ivan's local drivers. Written to the driver's file so dispatch shows the
 * unit under them; the trailer a load rides on is still named as they leave each pickup.
 */
import { useEffect, useState } from 'react'
import { Container, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchTrailers, selectTrailer, type TrailerChoice } from './driverApi'
import { useDriverProfile, refreshDriverProfile } from './useDriverProgram'
import { errorText } from '@/lib/errorText'

export function TrailerPickerDialog({ open, onClose, onPicked }: { open: boolean; onClose: () => void; onPicked?: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Which trailer are you starting with?</DialogTitle>
          <DialogDescription className="text-muted-foreground">Pick the one hooked up now, or none if you are bobtailing.</DialogDescription>
        </DialogHeader>
        {open && <TrailerList onClose={onClose} onPicked={onPicked} />}
      </DialogContent>
    </Dialog>
  )
}

function TrailerList({ onClose, onPicked }: { onClose: () => void; onPicked?: () => void }) {
  const current = useDriverProfile()?.trailer ?? null
  const [list, setList] = useState<TrailerChoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    fetchTrailers()
      .then((t) => { if (!stale) setList(t) })
      .catch((e) => { if (!stale) setError(errorText(e)) })
    return () => { stale = true }
  }, [])

  async function pick(t: TrailerChoice | null) {
    setBusy(t?.id ?? 'none')
    try {
      const res = await selectTrailer(t?.id ?? null)
      void refreshDriverProfile()
      toast.success(res.trailer ? `Trailer ${res.trailer.unitNumber}` : 'No trailer today')
      onClose()
      onPicked?.()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!list) return <div className="flex justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" /></div>
  return (
    <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
      <li>
        <button type="button" disabled={busy !== null} onClick={() => void pick(null)} aria-label="No trailer"
          className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${!current ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}>
          <X className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-base font-semibold text-foreground">No trailer (bobtail)</span>
          {busy === 'none' && <Loader2 className="ml-auto h-4 w-4 animate-spin" aria-hidden="true" />}
        </button>
      </li>
      {list.map((t) => {
        const on = current?.id === t.id
        return (
          <li key={t.id}>
            <button type="button" disabled={busy !== null} onClick={() => void pick(t)} aria-label={`Trailer ${t.unitNumber}${on ? ' (your current trailer)' : ''}`}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${on ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}>
              <Container className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-bold tabular-nums text-foreground">{t.unitNumber}</span>
                <span className="block text-xs text-muted-foreground">{on ? 'Your trailer now' : t.nickname ?? ''}</span>
              </span>
              {busy === t.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
