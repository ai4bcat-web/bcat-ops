/**
 * Asking the market what it wants for a load.
 *
 * One press creates one REQUESTED offer per carrier, each with its own link and its own
 * clock, all in one group — so the first truck to take it closes the rest rather than
 * leaving five live offers on a load that is covered.
 *
 * Only carriers the org will actually book are offered: `effectiveCarrierStatus` is the
 * same reading `BOOK_CARRIER` gates on, so nobody is asked for a price we could not pay.
 * The book-now rate is shown only when the org lets a carrier take a load at a number on
 * the link.
 *
 * SES is denied outside production, so each send answers individually: the dialog lists
 * what went out and what did not, with the link for the ones that did not.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { useCarriers } from '@/hooks/useCarriers'
import { getTmsSettings, graphqlErrorText, requestOffers, type RequestOffersResult } from '@/lib/apiClient'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import type { TmsSettings } from '@/types/tms'

export function RequestOffersDialog({ shipmentId, loadId, open, onOpenChange, onDone }: {
  shipmentId: string
  loadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const { carriers, loading: carriersLoading } = useCarriers()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [bookNowCents, setBookNowCents] = useState<number | null>(null)
  const [expiryHours, setExpiryHours] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RequestOffersResult | null>(null)

  // Non-async on purpose (react-hooks/set-state-in-effect).
  const load = useCallback(() =>
    getTmsSettings()
      .then((s) => setSettings(s))
      .catch(() => {}),
  [])
  useEffect(() => { load() }, [load])

  const allowed = settings?.allowedCarrierStatuses ?? ['ACTIVE']
  const showBookNow = settings?.quoteOffersCarrierSeesBookNow !== false

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const now = new Date()
    return carriers
      .filter((carrier) => allowed.includes(effectiveCarrierStatus(carrier, now).status))
      .filter((carrier) => !needle || [carrier.name, carrier.dbaName, carrier.mcNumber]
        .some((value) => value?.toLowerCase().includes(needle)))
      .slice(0, 40)
    // `allowed` is derived from settings, which is in the dep list through `settings`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carriers, search, settings])

  const submit = () => {
    if (picked.length === 0) { setError('Pick at least one carrier.'); return }
    setBusy(true)
    setError(null)
    const hours = Number(expiryHours)
    requestOffers({
      shipmentId,
      loadId,
      carrierIds: picked,
      message: message.trim() || undefined,
      bookNowRateCents: showBookNow ? bookNowCents : null,
      expiryHours: Number.isFinite(hours) && hours > 0 ? hours : undefined,
    })
      .then((answer) => {
        setResult(answer)
        const sent = answer.sends.filter((send) => send.sent).length
        if (sent === answer.sends.length) toast.success(`${sent} offer${sent === 1 ? '' : 's'} out`)
        else toast.warning(`${answer.sends.length - sent} offer${answer.sends.length - sent === 1 ? '' : 's'} were not e-mailed`)
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setBusy(false))
  }

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
      .then(() => toast.success('Link copied'))
      .catch(() => toast.error('Could not copy the link'))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Request offers</DialogTitle>
        </DialogHeader>

        {!result && (
          <div className="space-y-3">
            <div className="relative">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search carriers"
                className="h-9 pl-7 text-sm"
                placeholder="name or MC"
                value={search}
                disabled={busy}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="max-h-56 overflow-auto rounded-md border border-border">
              {carriersLoading && (
                <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Reading the directory…
                </p>
              )}
              {!carriersLoading && candidates.length === 0 && (
                <p className="p-2 text-sm text-muted-foreground">No carrier the org will book matches that.</p>
              )}
              {candidates.map((carrier) => {
                const status = effectiveCarrierStatus(carrier, new Date()).status
                return (
                  <label key={carrier.id} className="flex items-start gap-2 border-b border-border/60 p-2 text-sm last:border-0">
                    <Checkbox
                      aria-label={`Ask ${carrier.name}`}
                      checked={picked.includes(carrier.id)}
                      disabled={busy}
                      onCheckedChange={(v) => setPicked((prev) => (
                        v === true ? [...prev, carrier.id] : prev.filter((id) => id !== carrier.id)
                      ))}
                      className="mt-0.5"
                    />
                    <span className="flex-1">
                      {carrier.name}
                      {carrier.mcNumber && <span className="ml-1 text-xs text-muted-foreground">MC {carrier.mcNumber}</span>}
                      <Badge variant="outline" className="ml-1 text-[10px]">{CARRIER_STATUS_LABELS[status] ?? status}</Badge>
                      {(carrier.equipment ?? []).slice(0, 3).map((type) => (
                        <Badge key={type} variant="outline" className="ml-1 text-[10px]">{type}</Badge>
                      ))}
                      {!carrier.email && <span className="ml-1 text-xs text-destructive">no e-mail on file</span>}
                    </span>
                  </label>
                )
              })}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {showBookNow && (
                <MoneyField
                  label="Book-now rate (optional)"
                  value={bookNowCents}
                  onChange={setBookNowCents}
                  disabled={busy}
                />
              )}
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="offers-expiry">
                  Hours to answer
                </Label>
                <Input
                  id="offers-expiry"
                  type="number"
                  min={1}
                  className="h-9 text-sm"
                  placeholder={String(settings?.offerExpiryHours ?? 24)}
                  value={expiryHours}
                  disabled={busy}
                  onChange={(e) => setExpiryHours(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">Always capped at the first pickup.</p>
              </div>
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground" htmlFor="offers-message">
                A line to the carriers
              </Label>
              <Textarea
                id="offers-message"
                rows={2}
                className="text-sm"
                value={message}
                disabled={busy}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            {result.sends.map((send) => (
              <div key={send.quoteId} className="rounded-md border border-border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{send.quoteId}</span>
                  <span className="text-xs text-muted-foreground">{send.to.join(', ') || 'no address'}</span>
                  {send.sent
                    ? <Badge variant="outline" className="text-[10px]">Sent</Badge>
                    : <Badge variant="destructive" className="text-[10px]">Not sent</Badge>}
                </div>
                {send.link && (
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 truncate rounded border border-border bg-muted/40 px-2 py-0.5 text-xs">{send.link}</code>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Copy link for ${send.quoteId}`}
                      onClick={() => copy(send.link ?? '')}
                    >
                      <Link2 size={13} /> Copy
                    </Button>
                  </div>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Every offer that was not e-mailed still has a live link — that is the delivery on dev.
            </p>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={onDone}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button aria-label="Send the offer requests" disabled={busy || picked.length === 0} onClick={submit}>
                {busy ? 'Asking…' : `Ask ${picked.length} carrier${picked.length === 1 ? '' : 's'}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
