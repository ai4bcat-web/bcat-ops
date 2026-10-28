/**
 * The number that came in by phone.
 *
 * Most carriers do not click links; they call. An offer logged here is the same row a
 * link would have made — same group, same lane history, same Accept button — so the
 * board is a true picture of what the load has been offered at rather than only of what
 * happened to arrive electronically.
 *
 * No link is minted: nobody is being asked anything, the price is already known.
 */
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { useCarriers } from '@/hooks/useCarriers'
import { graphqlErrorText, logOffer } from '@/lib/apiClient'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { formatCents } from '@/lib/invoiceBuild'

export function LogOfferDialog({ shipmentId, loadId, open, onOpenChange, onDone }: {
  shipmentId: string
  loadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const { carriers } = useCarriers()
  const [search, setSearch] = useState('')
  const [carrierId, setCarrierId] = useState('')
  const [amountCents, setAmountCents] = useState<number | null>(null)
  const [contactName, setContactName] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return []
    return carriers
      .filter((carrier) => [carrier.name, carrier.dbaName, carrier.mcNumber]
        .some((value) => value?.toLowerCase().includes(needle)))
      .slice(0, 12)
  }, [carriers, search])

  const carrier = carriers.find((row) => row.id === carrierId) ?? null

  const submit = () => {
    if (!carrier) { setError('Pick the carrier who called.'); return }
    if (amountCents == null || amountCents <= 0) { setError('An offer needs a number.'); return }
    setBusy(true)
    setError(null)
    logOffer({
      shipmentId,
      loadId,
      carrierId: carrier.id,
      amountCents,
      note: note.trim() || undefined,
      contactName: contactName.trim() || null,
      carrierEmail: carrier.email ?? null,
    })
      .then(() => {
        toast.success(`${carrier.name} logged at ${formatCents(amountCents)}`)
        onDone()
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Log an offer</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="log-offer-carrier">
              Who called
            </Label>
            {carrier ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{carrier.name}</span>
                <Badge variant="outline" className="text-[10px]">
                  {CARRIER_STATUS_LABELS[effectiveCarrierStatus(carrier, new Date()).status]}
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => { setCarrierId(''); setSearch('') }} disabled={busy}>
                  Change
                </Button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="log-offer-carrier"
                    aria-label="Search carriers"
                    className="h-9 pl-7 text-sm"
                    placeholder="name or MC"
                    value={search}
                    disabled={busy}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {candidates.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-auto rounded-md border border-border">
                    {candidates.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        className="block w-full px-2 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() => setCarrierId(row.id)}
                      >
                        {row.name}
                        {row.mcNumber && <span className="ml-1 text-xs text-muted-foreground">MC {row.mcNumber}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <MoneyField label="Their number" value={amountCents} onChange={setAmountCents} disabled={busy} />

          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="log-offer-contact">
              Who you spoke to
            </Label>
            <Input
              id="log-offer-contact"
              className="h-9 text-sm"
              value={contactName}
              disabled={busy}
              onChange={(e) => setContactName(e.target.value)}
            />
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="log-offer-note">
              What they said
            </Label>
            <Textarea
              id="log-offer-note"
              rows={2}
              className="text-sm"
              value={note}
              disabled={busy}
              placeholder="empty nearby, needs a 2-day load, wants a lumper"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button aria-label="Log the offer" disabled={busy || !carrier || amountCents == null} onClick={submit}>
            {busy ? 'Logging…' : 'Log offer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
