/**
 * P7 — parsed carrier offers for the selected shipment.
 *
 * Offers are sorted open-first, then by rate. A vetted carrier with a completed
 * MyCarrierPackets packet gets one-click "Assign carrier + send rate con" (the carrier is
 * re-checked before booking, so a stale snapshot never books-then-refuses); a vetted
 * carrier without a completed packet gets that button disabled with the reason plus
 * "Send setup packet"; an unknown or unvetted MC gets "Send setup packet".
 */
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { TmsApprovalCard, TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import {
  getCarrierBundle,
  getShipmentBundle,
  sendSetupPacket,
  type CarrierOfferVetting,
  type QuoteRecord,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/tmsDirectory'
import {
  buildRateConInput,
  buildRateConPdf,
  rateConPdfBase64,
  rateConRecipients,
} from './rateCon'
import type { ShipmentActions } from '@/features/shipments/useShipmentActions'
import type { Division, ShipmentBundle, TmsSettings } from '@/types/tms'
import { mcpPacketStanding, rateConMcpRefusal } from '@/lib/mcpPacket'

interface OfferQueueProps {
  shipmentId: string
  offers: (QuoteRecord & { vetting: CarrierOfferVetting })[]
  selectedBundle: ShipmentBundle | null
  actions: ShipmentActions
  settings: TmsSettings | null
  divisions: Division[]
  refreshAll: () => Promise<void>
}

export function OfferQueue({
  shipmentId,
  offers,
  selectedBundle,
  actions,
  settings,
  divisions,
  refreshAll,
}: OfferQueueProps) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const sorted = useMemo(() => {
    return [...offers].sort((a, b) => {
      const aOpen = a.quoteOpen === 'OPEN' ? 0 : 1
      const bOpen = b.quoteOpen === 'OPEN' ? 0 : 1
      if (aOpen !== bOpen) return aOpen - bOpen
      return (a.amountCents ?? 0) - (b.amountCents ?? 0)
    })
  }, [offers])

  const handleAssign = useCallback(
    async (offer: QuoteRecord & { vetting: CarrierOfferVetting }) => {
      if (!selectedBundle || !offer.carrierId) {
        toast.error('Carrier is not known well enough to assign.')
        return
      }
      setBusyId(offer.id)
      try {
        await bookCarrierAndSendRateCon({
          shipmentId,
          bundle: selectedBundle,
          carrierId: offer.carrierId,
          carrierRateCents: offer.amountCents,
          actions,
          settings,
          divisions,
        })
        toast.success(`${offer.carrierName ?? offer.carrierMc ?? 'Carrier'} assigned and rate con sent`)
        await refreshAll()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not assign carrier')
      } finally {
        setBusyId(null)
      }
    },
    [shipmentId, selectedBundle, actions, settings, divisions, refreshAll],
  )

  const handleSetupPacket = useCallback(
    async (offer: QuoteRecord & { vetting: CarrierOfferVetting }) => {
      const email = offer.carrierEmail
      if (!email) {
        toast.error('No carrier e-mail on this offer.')
        return
      }
      setBusyId(offer.id)
      try {
        const result = await sendSetupPacket({ shipmentId, quoteId: offer.id, email })
        toast.success(result.message)
        await refreshAll()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not send setup packet')
      } finally {
        setBusyId(null)
      }
    },
    [shipmentId, refreshAll],
  )

  return (
    <TmsCard title={`Carrier offers (${sorted.length})`}>
      {sorted.length === 0 ? (
        <p className="text-sm tms-muted">No carrier offers yet.</p>
      ) : (
        <div className="space-y-3">
          {sorted.map((offer) => (
            <OfferRow
              key={offer.id}
              offer={offer}
              busy={busyId === offer.id}
              onAssign={() => { void handleAssign(offer) }}
              onSetupPacket={() => { void handleSetupPacket(offer) }}
            />
          ))}
        </div>
      )}
    </TmsCard>
  )
}

interface OfferRowProps {
  offer: QuoteRecord & { vetting: CarrierOfferVetting }
  busy: boolean
  onAssign: () => void
  onSetupPacket: () => void
}

function OfferRow({ offer, busy, onAssign, onSetupPacket }: OfferRowProps) {
  const vetting = offer.vetting
  const isOpen = offer.quoteOpen === 'OPEN'
  const bookable = vetting.bookable && offer.carrierId != null
  const packetStanding = mcpPacketStanding({ mcpStatus: vetting.mcpStatus })

  const actions = bookable ? (
    <>
      {!packetStanding.completed && offer.carrierEmail && (
        <TmsButton
          size="sm"
          disabled={busy}
          onClick={onSetupPacket}
          data-testid="setup-packet-button"
        >
          Send setup packet
        </TmsButton>
      )}
      <TmsButton
        size="sm"
        variant="approve"
        disabled={busy || !packetStanding.completed}
        onClick={onAssign}
        data-testid="assign-offer-button"
      >
        {busy ? 'Working…' : 'Assign carrier + send rate con'}
      </TmsButton>
    </>
  ) : (
    <TmsButton
      size="sm"
      disabled={busy || !offer.carrierEmail}
      onClick={onSetupPacket}
      data-testid="setup-packet-button"
    >
      {busy ? 'Working…' : 'Send setup packet'}
    </TmsButton>
  )

  return (
    <TmsApprovalCard
      className="tms-dispatch-offer-row"
      testId="offer-row"
      title={offer.carrierName ?? 'Unknown carrier'}
      subtitle={`MC ${offer.carrierMc ?? '—'} · $${formatCents(offer.amountCents)} · ${offer.equipmentType ?? '—'}`}
      chip={
        <span className="flex items-center gap-2">
          <TmsBadge tone={bookable ? 'green' : vetting.known ? 'orange' : 'gray'}>
            {vetting.status ?? (bookable ? 'Vetted' : vetting.known ? 'Unvetted' : 'Unknown')}
          </TmsBadge>
          {isOpen && <TmsBadge tone="blue">Open</TmsBadge>}
        </span>
      }
      meta={
        <>
          {offer.offerSource ?? 'MANUAL'} · {offer.offerContactName ?? '—'}
          {offer.offerAvailableAt && ` · available ${formatDateTime(offer.offerAvailableAt)}`}
        </>
      }
      actions={actions}
    >
      {vetting.blockers.length > 0 && (
        <div className="text-xs tms-text-destructive">{vetting.blockers.join(' · ')}</div>
      )}
      {bookable && !packetStanding.completed && (
        <p className="text-xs tms-muted" data-testid="offer-packet-reason">
          {offer.carrierName ?? 'This carrier'} {packetStanding.reason}
        </p>
      )}
    </TmsApprovalCard>
  )
}

interface BookAndSendParams {
  shipmentId: string
  bundle: ShipmentBundle
  carrierId: string
  carrierRateCents: number
  actions: ShipmentActions
  settings: TmsSettings | null
  divisions: Division[]
}

async function bookCarrierAndSendRateCon(params: BookAndSendParams): Promise<void> {
  const { shipmentId, carrierId, carrierRateCents, actions, settings, divisions } = params
  // Check the carrier's packet BEFORE booking: the offer's vetting snapshot can be stale,
  // and a carrier that would be refused a rate con must never end up booked-then-refused.
  const carrierBundle = await getCarrierBundle(carrierId)
  const standing = mcpPacketStanding(carrierBundle.carrier)
  if (!standing.completed) {
    throw new Error(rateConMcpRefusal(carrierBundle.carrier?.name ?? 'This carrier', standing))
  }

  await actions.bookCarrier({ carrierId, carrierRateCents })

  const fresh = await getShipmentBundle(shipmentId)
  const loadCarrier = fresh.loadCarriers.find(
    (lc) => lc.status === 'ACTIVE' && lc.carrierId === carrierId,
  )
  if (!loadCarrier) throw new Error('Carrier was not assigned to the load')

  const doc = await buildRateConPdf(
    buildRateConInput(fresh, loadCarrier, carrierBundle.carrier, settings, divisions),
  )
  const to = rateConRecipients(carrierBundle.carrier, carrierBundle.contacts)
  if (to.length === 0) throw new Error('No rate-con recipient found for this carrier')

  await actions.sendRateCon({
    loadCarrierId: loadCarrier.id,
    pdfBase64: rateConPdfBase64(doc),
    to,
    expiresHours: 72,
  })
}
