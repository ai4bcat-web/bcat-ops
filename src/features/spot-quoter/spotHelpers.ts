/**
 * Small pure helpers the Spot inbox shares: the lane a request names, the stops a quote is
 * saved with, and the one-line labels the list prints.
 */
import { formatCents } from '@/lib/invoiceBuild'
import type { Stop } from '@/types'
import type { SpotExtraction, SpotStop } from '@/lib/spot/types'

export interface SpotEnd {
  city: string
  state: string
  zip: string
}

const endOf = (s: SpotStop | undefined): SpotEnd | null =>
  s && (s.city || s.state) ? { city: s.city ?? '', state: s.state ?? '', zip: s.zip ?? '' } : null

/** The first pickup and the last delivery: the lane a request is priced on. */
export function spotEnds(e: SpotExtraction | null | undefined): { origin: SpotEnd | null; destination: SpotEnd | null } {
  const stops = e?.stops ?? []
  const pickup = stops.find((s) => s.type === 'PICKUP') ?? stops[0]
  const delivery = [...stops].reverse().find((s) => s.type === 'DELIVERY') ?? (stops.length > 1 ? stops[stops.length - 1] : undefined)
  return { origin: endOf(pickup), destination: endOf(delivery) }
}

const placeText = (p: SpotEnd | null): string => (p ? [p.city, p.state].filter(Boolean).join(', ') : '?')

/** `Chicago, IL → Dallas, TX`; a missing end prints as `?`. */
export function laneText(e: SpotExtraction | null | undefined): string {
  const { origin, destination } = spotEnds(e)
  if (!origin && !destination) return 'No lane read'
  return `${placeText(origin)} → ${placeText(destination)}`
}

/** The stops a Quote is saved with, in the shape the quote editor writes. */
export function quoteStops(e: SpotExtraction): Stop[] {
  return e.stops.map((s, index) => {
    const appt = (s.type === 'PICKUP' ? e.pickupDate : e.deliveryDate) ?? s.dateStr ?? ''
    return {
      id: `stop-${index}`,
      type: s.type === 'PICKUP' ? 'pickup' : 'delivery',
      name: s.name ?? undefined,
      city: s.state ? `${s.city ?? ''}, ${s.state}` : (s.city ?? ''),
      address: { city: s.city ?? '', state: s.state ?? '', zip: s.zip ?? '' },
      appt: appt ? new Date(`${appt}T12:00:00`).toISOString() : '',
      driverId: null,
      sequence: index,
    } as unknown as Stop
  })
}

/** `3h ago`, `2d ago` — enough to tell a fresh request from a stale one. */
export function relativeTime(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const mins = Math.max(0, Math.round((nowMs - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export const dollarsToCents = (text: string): number | null => {
  const n = Number(text.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null
}

export const money = (cents: number | null | undefined): string => (cents == null ? '—' : formatCents(cents))

export const gmailThreadUrl = (googleEmail: string | null | undefined, threadId: string): string | null =>
  threadId
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(googleEmail ?? '')}#all/${encodeURIComponent(threadId)}`
    : null
