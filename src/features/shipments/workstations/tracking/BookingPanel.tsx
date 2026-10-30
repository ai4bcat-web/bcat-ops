import { useMemo, useState } from 'react'
import { AlertTriangle, Building2, Package, Send } from 'lucide-react'
import { TmsBadge, TmsButton, TmsEmptyState } from '@/features/tms/kit'
import { formatCents } from '@/lib/tmsDirectory'
import { formatDateTime } from '@/lib/date'
import type { QuoteRecord } from '@/types/tms'
import type { CarrierOfferVetting } from '@/lib/apiClient'
import type { BookingPanelProps } from './types'

type BookingSubtab = 'offers' | 'postings'

function offerSummary(o: QuoteRecord): string {
  const parts = [o.equipmentType, o.commodity].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}

export function BookingPanel({
  rows,
  offersByShipment,
  postings,
  loading,
  selectedId,
  onSelect,
  onAssign,
  onSendSetupPacket,
}: BookingPanelProps) {
  const [subtab, setSubtab] = useState<BookingSubtab>('offers')

  const shipmentsWithOffers = useMemo(
    () => rows.filter((r) => (offersByShipment[r.id] ?? []).length > 0),
    [rows, offersByShipment],
  )

  const selectedShipment = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? shipmentsWithOffers[0] ?? null,
    [rows, selectedId, shipmentsWithOffers],
  )

  const selectedOffers = useMemo(
    () => (selectedShipment ? offersByShipment[selectedShipment.id] ?? [] : []),
    [selectedShipment, offersByShipment],
  )

  const postingsWithShipment = useMemo(
    () =>
      postings
        .map((p) => ({ posting: p, shipment: rows.find((r) => r.id === p.shipmentId) ?? null }))
        .filter((p): p is { posting: (typeof postings)[number]; shipment: NonNullable<typeof p.shipment> } => p.shipment != null),
    [postings, rows],
  )

  return (
    <div className="tms-tracking-booking">
      <div className="tms-tracking-booking-head">
        <TmsButton size="sm" variant={subtab === 'offers' ? 'primary' : 'secondary'} onClick={() => setSubtab('offers')}>
          Carrier offers
        </TmsButton>
        <TmsButton size="sm" variant={subtab === 'postings' ? 'primary' : 'secondary'} onClick={() => setSubtab('postings')}>
          Active postings
        </TmsButton>
      </div>
      <div className="tms-tracking-booking-body">
        {subtab === 'offers' ? (
          <>
            <div className="tms-tracking-booking-list">
              {loading && !shipmentsWithOffers.length ? (
                <p className="tms-tracking-empty">Loading offers…</p>
              ) : shipmentsWithOffers.length === 0 ? (
                <TmsEmptyState title="No offers" message="Carrier responses appear here once postings draw replies." />
              ) : (
                shipmentsWithOffers.map((r) => {
                  const count = offersByShipment[r.id].length
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`tms-tracking-booking-item${selectedShipment?.id === r.id ? ' tms-active' : ''}`}
                      onClick={() => onSelect(r.id)}
                    >
                      <span className="tms-tracking-booking-pro">{r.number}</span>
                      <span className="tms-tracking-booking-route">
                        {r.originCity ?? '—'} → {r.destinationCity ?? '—'}
                      </span>
                      {count > 0 && <TmsBadge tone="orange">{count}</TmsBadge>}
                    </button>
                  )
                })
              )}
            </div>
            <div className="tms-tracking-booking-detail">
              {!selectedShipment ? (
                <TmsEmptyState title="Select a shipment" message="Pick a shipment to see its carrier offers." />
              ) : selectedOffers.length === 0 ? (
                <TmsEmptyState title="No offers" message={`${selectedShipment.number} has no carrier offers.`} />
              ) : (
                <div className="tms-tracking-offers">
                  <div className="tms-tracking-offer-head">
                    <span className="tms-tracking-offer-pro">{selectedShipment.number}</span>
                    <span className="tms-tracking-offer-route">
                      {selectedShipment.originCity ?? '—'} → {selectedShipment.destinationCity ?? '—'}
                    </span>
                  </div>
                  {selectedOffers.map((o) => (
                    <OfferCard key={o.id} offer={o} onAssign={() => onAssign(selectedShipment.id, o.id)} onSendSetupPacket={() => onSendSetupPacket(selectedShipment.id, o.id)} />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="tms-tracking-postings">
            {postingsWithShipment.length === 0 ? (
              <TmsEmptyState title="No active postings" message="Loads are not currently live on any board." />
            ) : (
              postingsWithShipment.map(({ posting, shipment }) => (
                <div key={posting.id} className="tms-tracking-posting">
                  <div className="tms-tracking-posting-line">
                    <Package size={14} />
                    <span className="tms-tracking-posting-pro">{shipment.number}</span>
                    <TmsBadge tone="blue">{posting.provider}</TmsBadge>
                    <span className="tms-tracking-posting-status">{posting.status}</span>
                  </div>
                  <div className="tms-tracking-posting-meta">
                    {formatDateTime(posting.postedAt)} · {posting.rateCents ? formatCents(posting.rateCents) : 'no rate'}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function OfferCard({
  offer,
  onAssign,
  onSendSetupPacket,
}: {
  offer: QuoteRecord & { vetting: CarrierOfferVetting }
  onAssign: () => void
  onSendSetupPacket: () => void
}) {
  const v = offer.vetting
  return (
    <div className="tms-tracking-offer-card">
      <div className="tms-tracking-offer-main">
        <div className="tms-tracking-offer-carrier">
          <Building2 size={14} />
          <span>{offer.carrierName ?? 'Unknown carrier'}</span>
          {offer.carrierMc && <span className="tms-tracking-offer-mc">MC {offer.carrierMc}</span>}
        </div>
        <div className="tms-tracking-offer-facts">
          <span className="tms-tracking-offer-rate">{formatCents(offer.amountCents)}</span>
          <span className="tms-tracking-offer-summary">{offerSummary(offer)}</span>
          <span className="tms-tracking-offer-availability">{formatDateTime(offer.pickupAppt) ?? '—'}</span>
        </div>
        <div className="tms-tracking-offer-vetting">
          <TmsBadge tone={v.bookable ? 'green' : v.known ? 'orange' : 'gray'}>
            {v.bookable ? 'Bookable' : v.status ?? (v.known ? 'Known' : 'Unknown')}
          </TmsBadge>
          {v.blockers.length > 0 && (
            <span className="tms-tracking-offer-blockers">
              <AlertTriangle size={12} /> {v.blockers.join('; ')}
            </span>
          )}
        </div>
      </div>
      <div className="tms-tracking-offer-actions">
        <TmsButton size="sm" variant="primary" disabled={!v.bookable} onClick={onAssign}>
          Assign
        </TmsButton>
        <TmsButton size="sm" variant="secondary" onClick={onSendSetupPacket}>
          <Send size={12} /> Setup packet
        </TmsButton>
      </div>
    </div>
  )
}
