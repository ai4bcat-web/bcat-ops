/**
 * Asking the market what it wants for a shipment.
 *
 * One press creates one REQUESTED offer per carrier, each with its own link and its own
 * clock, all in one group — so the first truck to take it closes the rest rather than
 * leaving five live offers on a shipment that is covered.
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
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { useCarriers } from '@/hooks/useCarriers'
import { getTmsSettings, graphqlErrorText, requestOffers, type RequestOffersResult } from '@/lib/apiClient'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import type { TmsSettings } from '@/types/tms'

const CODE_STYLE: React.CSSProperties = {
  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12,
  borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)',
  background: 'var(--tms-card)', padding: '2px 8px',
}

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
      .filter((carrier) => needle.length === 0 || [carrier.name, carrier.dbaName, carrier.mcNumber]
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
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      className="tms-dialog-wide"
      title="Request offers"
      footer={
        result ? (
          <TmsButton variant="primary" onClick={onDone}>Done</TmsButton>
        ) : (
          <>
            <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</TmsButton>
            <TmsButton variant="primary" aria-label="Send the offer requests" disabled={busy || picked.length === 0} onClick={submit}>
              {busy ? 'Asking…' : `Ask ${picked.length} carrier${picked.length === 1 ? '' : 's'}`}
            </TmsButton>
          </>
        )
      }
    >
      {result === null && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} className="tms-muted" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }} />
            <TmsInput
              aria-label="Search carriers"
              style={{ paddingLeft: 28 }}
              placeholder="name or MC"
              value={search}
              disabled={busy}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div style={{ maxHeight: 224, overflow: 'auto', borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)' }}>
            {carriersLoading && (
              <p className="tms-muted" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, fontSize: 13 }}>
                <Loader2 size={14} /> Reading the directory…
              </p>
            )}
            {carriersLoading === false && candidates.length === 0 && (
              <p className="tms-muted" style={{ padding: 8, fontSize: 13 }}>No carrier the org will book matches that.</p>
            )}
            {candidates.map((carrier) => {
              const status = effectiveCarrierStatus(carrier, new Date()).status
              return (
                <label key={carrier.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, borderBottom: '1px solid var(--tms-border)', padding: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    aria-label={`Ask ${carrier.name}`}
                    checked={picked.includes(carrier.id)}
                    disabled={busy}
                    onChange={(e) => setPicked((prev) => (
                      e.target.checked ? [...prev, carrier.id] : prev.filter((id) => id !== carrier.id)
                    ))}
                  />
                  <span style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                    {carrier.name}
                    {carrier.mcNumber && <span className="tms-muted" style={{ fontSize: 12 }}>MC {carrier.mcNumber}</span>}
                    <TmsBadge tone="blue">{CARRIER_STATUS_LABELS[status] ?? status}</TmsBadge>
                    {(carrier.equipment ?? []).slice(0, 3).map((type) => (
                      <TmsBadge key={type} tone="gray">{type}</TmsBadge>
                    ))}
                    {carrier.email == null && <span className="tms-field-error">no e-mail on file</span>}
                  </span>
                </label>
              )
            })}
          </div>

          <div className="tms-grid tms-grid-2">
            {showBookNow && (
              <MoneyField
                label="Book-now rate (optional)"
                value={bookNowCents}
                onChange={setBookNowCents}
                disabled={busy}
              />
            )}
            <TmsField label="Hours to answer" htmlFor="offers-expiry" hint="Always capped at the first pickup.">
              <TmsInput
                id="offers-expiry"
                type="number"
                min={1}
                placeholder={String(settings?.offerExpiryHours ?? 24)}
                value={expiryHours}
                disabled={busy}
                onChange={(e) => setExpiryHours(e.target.value)}
              />
            </TmsField>
          </div>

          <TmsField label="A line to the carriers" htmlFor="offers-message">
            <TmsTextarea
              id="offers-message"
              rows={2}
              value={message}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
            />
          </TmsField>

          {error && <p className="tms-field-error">{error}</p>}
        </div>
      )}

      {result && (
        <div style={{ display: 'grid', gap: 8 }}>
          {result.sends.map((send) => (
            <div key={send.quoteId} style={{ borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)', padding: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{send.quoteId}</span>
                <span className="tms-muted" style={{ fontSize: 12 }}>{send.to.join(', ') || 'no address'}</span>
                {send.sent ? <TmsBadge tone="green">Sent</TmsBadge> : <TmsBadge tone="red">Not sent</TmsBadge>}
              </div>
              {send.link && (
                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={CODE_STYLE}>{send.link}</code>
                  <TmsButton size="sm" aria-label={`Copy link for ${send.quoteId}`} onClick={() => copy(send.link ?? '')}>
                    <Link2 size={13} /> Copy
                  </TmsButton>
                </div>
              )}
            </div>
          ))}
          <p className="tms-muted" style={{ fontSize: 12 }}>
            Every offer that was not e-mailed still has a live link — that is the delivery on dev.
          </p>
        </div>
      )}
    </TmsDialog>
  )
}
