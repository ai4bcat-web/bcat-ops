/**
 * Pure view helpers for the Offers hub: risk cell, identity flag chips, the one-line summary of an
 * inbound message, and the "carrier withdrew?" rule. No I/O.
 */
import type { CarrierOfferRow } from '@/lib/apiClient'
import type { InboundFlag, InboundOfferRecord } from '@/lib/carrierInbox/types'
import type { McpReviewCard, ReviewTone } from '@/lib/integrations/mcpReview'
import { formatCents } from '@/lib/invoiceBuild'
import type { ShipmentMessageRecord } from '@/types/tms'

export type ChipTone = 'gray' | 'orange' | 'red' | 'green' | 'blue'

export interface RiskCell {
  /** null = unknown MC: the rep may press Check MCP. */
  points: number | null
  tone: ReviewTone
  /** True when the number came from an MCP preview that was a labelled fixture. */
  stub: boolean
}

const TONE: Record<ReviewTone, ChipTone> = { green: 'green', amber: 'orange', red: 'red', gray: 'gray' }
export const toneOf = (t: ReviewTone): ChipTone => TONE[t]

/** Directory carrier: its stored points (gray until a rating says otherwise). Unknown carrier: null. */
export function riskOf(offer: Pick<CarrierOfferRow, 'vetting' | 'carrierRisk'>): RiskCell | null {
  if (!offer.vetting.known) return null
  const points = offer.carrierRisk?.mcpRiskScore ?? null
  return { points, tone: 'gray', stub: false }
}

/** An on-demand MCP preview card -> the same cell. */
export function riskOfCard(card: McpReviewCard | null): RiskCell {
  if (!card) return { points: null, tone: 'gray', stub: false }
  return { points: card.risk.totalPoints ?? null, tone: card.risk.tone, stub: card.source === 'STUB' }
}

const FLAG_CHIP: Partial<Record<InboundFlag, { label: string; tone: ChipTone; title: string }>> = {
  MC_NAME_MISMATCH: { label: 'MC / name mismatch', tone: 'red', title: 'The MC belongs to a different carrier than the name given.' },
  SENDER_UNVERIFIED: { label: 'Sender unverified', tone: 'orange', title: 'SPF/DKIM did not align with the From domain.' },
  FREEMAIL_SENDER: { label: 'Free-mail sender', tone: 'gray', title: 'Sent from a free e-mail domain.' },
  NO_MC: { label: 'No MC', tone: 'orange', title: 'The message names no MC number.' },
  RATE_OUTLIER: { label: 'Rate outlier', tone: 'orange', title: 'Far from the posted rate.' },
}

export function flagChips(flags: readonly InboundFlag[] | undefined): Array<{ flag: InboundFlag; label: string; tone: ChipTone; title: string }> {
  return (flags ?? []).flatMap((f) => (FLAG_CHIP[f] ? [{ flag: f, ...FLAG_CHIP[f]! }] : []))
}

export function offerOf(m: ShipmentMessageRecord): InboundOfferRecord | null {
  const o = m.offer as unknown
  return o && typeof o === 'object' ? (o as InboundOfferRecord) : null
}

/** "Offered $1,850 · MC 123456 · Dry van · available Thu". */
export function summaryLine(offer: InboundOfferRecord): string {
  const x = offer.extraction
  const lead = x.kind === 'OFFER' ? (x.rateCents != null ? `Offered ${formatCents(x.rateCents)}` : 'Offer')
    : x.kind === 'WITHDRAW' ? 'Withdrew'
      : 'Interested'
  return [lead, x.carrier.mc ? `MC ${x.carrier.mc}` : x.carrier.name, x.equipment, x.availableAt ? `available ${x.availableAt}` : null]
    .filter((p): p is string => !!p && p.length > 0)
    .join(' · ')
}

/** Carrier keys (MC, else lower-cased name) that sent a WITHDRAW after their latest non-withdraw message. */
export function withdrawnCarriers(thread: readonly ShipmentMessageRecord[]): Set<string> {
  const latest = new Map<string, { at: string; withdraw: boolean }>()
  for (const m of thread) {
    const o = offerOf(m)
    if (!o) continue
    const key = carrierKey(o.extraction.carrier.mc, o.extraction.carrier.name)
    if (!key) continue
    const prev = latest.get(key)
    if (!prev || m.at >= prev.at) latest.set(key, { at: m.at, withdraw: o.extraction.kind === 'WITHDRAW' })
  }
  return new Set([...latest].filter(([, v]) => v.withdraw).map(([k]) => k))
}

export function carrierKey(mc: string | null | undefined, name: string | null | undefined): string | null {
  const m = (mc ?? '').replace(/\D/g, '')
  if (m) return `mc:${m}`
  const n = (name ?? '').trim().toLowerCase()
  return n ? `n:${n}` : null
}

/** Newest offer per carrier first (open before closed is the server order); the rest are "earlier". */
export function groupByCarrier<T extends { carrierMc?: string | null; carrierName?: string | null; id: string }>(
  offers: readonly T[],
): Array<{ head: T; earlier: T[] }> {
  const groups = new Map<string, T[]>()
  const order: string[] = []
  for (const o of offers) {
    const k = carrierKey(o.carrierMc, o.carrierName) ?? `id:${o.id}`
    if (!groups.has(k)) { groups.set(k, []); order.push(k) }
    groups.get(k)!.push(o)
  }
  return order.map((k) => ({ head: groups.get(k)![0]!, earlier: groups.get(k)!.slice(1) }))
}
