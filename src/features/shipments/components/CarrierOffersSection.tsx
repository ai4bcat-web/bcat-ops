/**
 * Step P7 — carrier responses that land on a shipment.
 *
 * These are BUY-side offers: a carrier replies to a posting or a dispatcher calls
 * in, and the app turns it into a quote with vetting. The section sits on the
 * Carrier tab, above the existing assignment card, because choosing a carrier comes
 * before booking one.
 *
 * A bookable offer reuses the AcceptOfferDialog from the quotes page so there is
 * exactly one booking path. An unknown or unvetted carrier gets a setup packet
 * instead. Blockers and warnings are shown in the gate's own words.
 */
import { useEffect, useState } from 'react'
import { Phone, Mail, LayoutGrid, PenLine } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsDialog, TmsEmptyState, TmsField, TmsInput } from '@/features/tms/kit'
import { AcceptOfferDialog } from '@/features/quotes/components/AcceptOfferDialog'
import { type CarrierOfferVetting, listCarrierOffers, recordCarrierOffer, sendSetupPacket, graphqlErrorText } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDateTime } from '@/lib/date'
import type { QuoteRecord, ShipmentBundle } from '@/types/tms'

const SOURCE_ICONS = {
  EMAIL: Mail,
  PHONE: Phone,
  BOARD: LayoutGrid,
  MANUAL: PenLine,
} as const

const SOURCE_LABEL: Record<string, string> = {
  EMAIL: 'E-mail',
  PHONE: 'Logged call',
  BOARD: 'Board',
  MANUAL: 'Manual',
}

export interface CarrierOffersSectionProps {
  shipmentId: string
  bundle: ShipmentBundle
  onReload: () => void | Promise<void>
}

export function CarrierOffersSection({ shipmentId, bundle, onReload }: CarrierOffersSectionProps) {
  const [offers, setOffers] = useState<(QuoteRecord & { vetting: CarrierOfferVetting })[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<{ kind: 'accept'; quote: QuoteRecord } | { kind: 'log' } | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const { offers: rows } = await listCarrierOffers(shipmentId)
      setOffers(rows)
    } catch (err) {
      toast.error(graphqlErrorText(err))
    } finally {
      setLoading(false)
    }
  }

  // The first read is the only one driven by an effect; every later refresh is
  // kicked off by a user action (accept, log, setup packet) and owns its spinner.
  useEffect(() => {
    let live = true
    listCarrierOffers(shipmentId)
      .then(({ offers: rows }) => { if (live) setOffers(rows) })
      .catch((err) => { if (live) toast.error(graphqlErrorText(err)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [shipmentId])

  const setupPacket = async (offer: QuoteRecord & { vetting: CarrierOfferVetting }) => {
    const email = offer.carrierEmail || offer.contactEmail
    if (!email) {
      toast.error('No e-mail on this offer to send the setup packet to.')
      return
    }
    setBusy(true)
    try {
      const result = await sendSetupPacket({ shipmentId, quoteId: offer.id, email })
      toast.success(result.message)
      await onReload()
    } catch (err) {
      toast.error(graphqlErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const logCall = async (input: {
    carrierName: string
    carrierMc: string
    amountCents: number
    contactName: string
    contactPhone: string
    equipmentType: string
    notes: string
  }) => {
    setBusy(true)
    try {
      await recordCarrierOffer({
        shipmentId,
        source: 'PHONE',
        carrierName: input.carrierName,
        carrierMc: input.carrierMc || null,
        contactName: input.contactName || null,
        contactPhone: input.contactPhone || null,
        amountCents: input.amountCents,
        equipmentType: input.equipmentType || null,
        notes: input.notes || null,
      })
      toast.success('Logged call')
      setDialog(null)
      await refresh()
      await onReload()
    } catch (err) {
      toast.error(graphqlErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const load = bundle.loads[0]

  return (
    <TmsCard
      title="Carrier offers"
      actions={(
        <TmsButton size="sm" disabled={busy} onClick={() => setDialog({ kind: 'log' })}>
          <Phone size={14} aria-hidden /> Log a call
        </TmsButton>
      )}
    >
      {loading ? (
        <p className="tms-muted text-sm">Loading offers…</p>
      ) : offers.length === 0 ? (
        <TmsEmptyState title="No offers yet" message="Post the load or log a carrier call to see offers here." />
      ) : (
        <div className="tms-offers-list">
          {offers.map((offer) => (
            <OfferRow
              key={offer.id}
              offer={offer}
              busy={busy}
              onSetupPacket={() => setupPacket(offer)}
              onAssign={() => setDialog({ kind: 'accept', quote: offer })}
            />
          ))}
        </div>
      )}

      {dialog?.kind === 'accept' && (
        <AcceptOfferDialog
          quote={dialog.quote}
          open
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          onDone={async () => { setDialog(null); await refresh(); await onReload() }}
        />
      )}

      {dialog?.kind === 'log' && (
        <LogCallDialog
          load={load}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={logCall}
        />
      )}
    </TmsCard>
  )
}

function OfferRow({ offer, busy, onSetupPacket, onAssign }: {
  offer: QuoteRecord & { vetting: CarrierOfferVetting }
  busy: boolean
  onSetupPacket: () => void
  onAssign: () => void
}) {
  const SourceIcon = SOURCE_ICONS[offer.offerSource as keyof typeof SOURCE_ICONS] ?? PenLine
  const label = SOURCE_LABEL[offer.offerSource as string] ?? offer.offerSource ?? '—'
  const vetting = offer.vetting

  return (
    <div className="tms-offer-row">
      <div className="tms-offer-main">
        <div className="tms-offer-carrier">
          <span className="tms-offer-name">{offer.carrierName ?? 'Unknown carrier'}</span>
          {offer.carrierMc && <TmsBadge tone="gray">MC {offer.carrierMc}</TmsBadge>}
          <TmsBadge tone="blue" className="tms-offer-source"><SourceIcon size={12} aria-hidden /> {label}</TmsBadge>
        </div>
        <div className="tms-offer-details">
          <span>Rate <strong>{formatCents(offer.amountCents)}</strong></span>
          <span>{offer.equipmentType ?? '—'}</span>
          <span>{offer.offerAvailableAt ? `Available ${formatDateTime(offer.offerAvailableAt)}` : 'Availability unknown'}</span>
          {offer.offerMessageRef && (
            <a href={`#message-${offer.offerMessageRef}`} className="tms-offer-message-link">View message</a>
          )}
        </div>
        {(vetting.blockers.length > 0 || vetting.warnings.length > 0) && (
          <div className="tms-offer-vetting">
            {vetting.blockers.map((b) => <p key={b} className="tms-offer-blocker">{b}</p>)}
            {vetting.warnings.map((w) => <p key={w} className="tms-offer-warning">{w}</p>)}
          </div>
        )}
      </div>
      <div className="tms-offer-actions">
        {(!vetting.known || !vetting.bookable) && (
          <TmsButton size="sm" disabled={busy} onClick={onSetupPacket}>Send setup packet</TmsButton>
        )}
        {vetting.bookable && (
          <TmsButton variant="primary" size="sm" disabled={busy} onClick={onAssign}>Assign to load</TmsButton>
        )}
      </div>
    </div>
  )
}

function LogCallDialog({ load, busy, onClose, onSubmit }: {
  load?: { equipmentType?: string | null }
  busy: boolean
  onClose: () => void
  onSubmit: (input: {
    carrierName: string
    carrierMc: string
    amountCents: number
    contactName: string
    contactPhone: string
    equipmentType: string
    notes: string
  }) => void
}) {
  const [carrierName, setCarrierName] = useState('')
  const [carrierMc, setCarrierMc] = useState('')
  const [amount, setAmount] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [equipmentType, setEquipmentType] = useState(load?.equipmentType ?? '')
  const [notes, setNotes] = useState('')

  const submit = () => {
    const amountCents = Math.round(Number(amount) * 100)
    onSubmit({ carrierName, carrierMc, amountCents, contactName, contactPhone, equipmentType, notes })
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Log a carrier call"
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={submit} disabled={busy || !carrierName || !amount}>Log call</TmsButton>
        </>
      )}
    >
      <div className="tms-grid tms-grid-2">
        <TmsField label="Carrier name"><TmsInput value={carrierName} onChange={(e) => setCarrierName(e.target.value)} /></TmsField>
        <TmsField label="MC"><TmsInput value={carrierMc} onChange={(e) => setCarrierMc(e.target.value)} /></TmsField>
        <TmsField label="Rate ($)"><TmsInput type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></TmsField>
        <TmsField label="Equipment"><TmsInput value={equipmentType} onChange={(e) => setEquipmentType(e.target.value)} /></TmsField>
        <TmsField label="Contact name"><TmsInput value={contactName} onChange={(e) => setContactName(e.target.value)} /></TmsField>
        <TmsField label="Contact phone"><TmsInput value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} /></TmsField>
        <TmsField label="Notes" className="tms-grid-col-2"><TmsInput value={notes} onChange={(e) => setNotes(e.target.value)} /></TmsField>
      </div>
    </TmsDialog>
  )
}
