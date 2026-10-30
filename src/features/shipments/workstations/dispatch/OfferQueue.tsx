/**
 * P7 — parsed carrier offers for the selected shipment.
 *
 * Offers are sorted open-first, then by rate. A vetted carrier gets one-click
 * "Assign carrier + send rate con"; an unknown or unvetted MC gets "Send setup packet".
 */
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { TmsBadge, TmsButton, TmsCard } from '@/features/tms/kit'
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

  return (
    <div
      className="tms-dispatch-offer-row rounded border p-3"
      data-testid="offer-row"
      data-offer-id={offer.id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{offer.carrierName ?? 'Unknown carrier'}</span>
            <TmsBadge tone={bookable ? 'green' : vetting.known ? 'orange' : 'gray'}>
              {vetting.status ?? (bookable ? 'Vetted' : vetting.known ? 'Unvetted' : 'Unknown')}
            </TmsBadge>
            {isOpen && <TmsBadge tone="blue">Open</TmsBadge>}
          </div>
          <div className="mt-1 text-xs tms-muted">
            MC {offer.carrierMc ?? '—'} · ${formatCents(offer.amountCents)} · {offer.equipmentType ?? '—'}
          </div>
          <div className="mt-1 text-xs tms-muted">
            {offer.offerSource ?? 'MANUAL'} · {offer.offerContactName ?? '—'}
            {offer.offerAvailableAt && ` · available ${formatDateTime(offer.offerAvailableAt)}`}
          </div>
          {vetting.blockers.length > 0 && (
            <div className="mt-1 text-xs tms-text-destructive">
              {vetting.blockers.join(' · ')}
            </div>
          )}
        </div>

        <div className="shrink-0">
          {bookable ? (
            <TmsButton
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={onAssign}
              data-testid="assign-offer-button"
            >
              {busy ? 'Working…' : 'Assign carrier + send rate con'}
            </TmsButton>
          ) : (
            <TmsButton
              size="sm"
              disabled={busy || !offer.carrierEmail}
              onClick={onSetupPacket}
              data-testid="setup-packet-button"
            >
              {busy ? 'Working…' : 'Send setup packet'}
            </TmsButton>
          )}
        </div>
      </div>
    </div>
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
  await actions.bookCarrier({ carrierId, carrierRateCents })

  const fresh = await getShipmentBundle(shipmentId)
  const loadCarrier = fresh.loadCarriers.find(
    (lc) => lc.status === 'ACTIVE' && lc.carrierId === carrierId,
  )
  if (!loadCarrier) throw new Error('Carrier was not assigned to the load')

  const carrierBundle = await getCarrierBundle(carrierId)
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
