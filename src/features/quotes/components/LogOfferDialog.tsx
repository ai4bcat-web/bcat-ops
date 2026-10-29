/**
 * The number that came in by phone.
 *
 * Most carriers do not click links; they call. An offer logged here is the same row a
 * link would have made — same group, same lane history, same Accept button — so the
 * board is a true picture of what the shipment has been offered at rather than only of
 * what happened to arrive electronically.
 *
 * No link is minted: nobody is being asked anything, the price is already known.
 */
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
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
    if (needle.length === 0) return []
    return carriers
      .filter((carrier) => [carrier.name, carrier.dbaName, carrier.mcNumber]
        .some((value) => value?.toLowerCase().includes(needle)))
      .slice(0, 12)
  }, [carriers, search])

  const carrier = carriers.find((row) => row.id === carrierId) ?? null

  const submit = () => {
    if (carrier == null) { setError('Pick the carrier who called.'); return }
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
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Log an offer"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" aria-label="Log the offer" disabled={busy || carrier == null || amountCents == null} onClick={submit}>
            {busy ? 'Logging…' : 'Log offer'}
          </TmsButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div>
          <div className="tms-field-label">Who called</div>
          {carrier ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{carrier.name}</span>
              <TmsBadge tone="blue">
                {CARRIER_STATUS_LABELS[effectiveCarrierStatus(carrier, new Date()).status]}
              </TmsBadge>
              <TmsButton size="sm" variant="ghost" onClick={() => { setCarrierId(''); setSearch('') }} disabled={busy}>
                Change
              </TmsButton>
            </div>
          ) : (
            <>
              <div style={{ position: 'relative' }}>
                <Search size={14} className="tms-muted" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }} />
                <TmsInput
                  id="log-offer-carrier"
                  aria-label="Search carriers"
                  style={{ paddingLeft: 28 }}
                  placeholder="name or MC"
                  value={search}
                  disabled={busy}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {candidates.length > 0 && (
                <div style={{ marginTop: 4, maxHeight: 160, overflow: 'auto', borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)' }}>
                  {candidates.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      style={{ display: 'block', width: '100%', padding: '6px 8px', textAlign: 'left', fontSize: 13, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                      onClick={() => setCarrierId(row.id)}
                    >
                      {row.name}
                      {row.mcNumber && <span className="tms-muted" style={{ marginLeft: 4, fontSize: 12 }}>MC {row.mcNumber}</span>}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <MoneyField label="Their number" value={amountCents} onChange={setAmountCents} disabled={busy} />

        <TmsField label="Who you spoke to" htmlFor="log-offer-contact">
          <TmsInput
            id="log-offer-contact"
            value={contactName}
            disabled={busy}
            onChange={(e) => setContactName(e.target.value)}
          />
        </TmsField>

        <TmsField label="What they said" htmlFor="log-offer-note">
          <TmsTextarea
            id="log-offer-note"
            rows={2}
            value={note}
            disabled={busy}
            placeholder="empty nearby, needs a 2-day load, wants a lumper"
            onChange={(e) => setNote(e.target.value)}
          />
        </TmsField>

        {error && <p className="tms-field-error">{error}</p>}
      </div>
    </TmsDialog>
  )
}
