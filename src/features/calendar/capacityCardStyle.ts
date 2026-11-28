/* eslint-disable no-restricted-syntax -- data colour: the per-card identity palette */
import type { CapacityCard } from '@/lib/capacityBoard'

/** The accent a card wears: its truck tint, outline and status accents. Eight hues that stay apart from one another on the board. */
export const CAPACITY_ACCENTS: readonly { name: string; hex: string }[] = [
  { name: 'orange', hex: '#f97316' },
  { name: 'blue', hex: '#2563eb' },
  { name: 'green', hex: '#16a34a' },
  { name: 'purple', hex: '#9333ea' },
  { name: 'teal', hex: '#0d9488' },
  { name: 'rose', hex: '#e11d48' },
  { name: 'amber', hex: '#d97706' },
  { name: 'indigo', hex: '#4f46e5' },
]

/** A small stable hash of a card id, so the same card prefers the same hue on every device and every reload. */
export function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

type Span = Pick<CapacityCard, 'id' | 'availableFrom' | 'availableTo' | 'createdAt'>

/**
 * One accent index per card. Each card starts from the hue its id hashes to; when another card that shares a day with it already has
 * that hue it takes the next free one, so two cards on the same day never wear the same color (unless a day holds more cards than
 * there are hues). Cards are settled in a fixed order (oldest first, then id), so a card's color does not depend on which days or
 * filters are on screen, and adding a card only ever moves that card if it collides.
 */
export function assignAccents(cards: readonly Span[], palette = CAPACITY_ACCENTS.length): Map<string, number> {
  const ordered = [...cards].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const settled: { span: Span; accent: number }[] = []
  const out = new Map<string, number>()
  for (const card of ordered) {
    const taken = new Set<number>()
    for (const o of settled) {
      if (o.span.availableFrom <= card.availableTo && card.availableFrom <= o.span.availableTo) taken.add(o.accent)
    }
    const start = hashId(card.id) % palette
    let pick = start
    for (let i = 0; i < palette; i++) {
      const c = (start + i) % palette
      if (!taken.has(c)) { pick = c; break }
    }
    settled.push({ span: card, accent: pick })
    out.set(card.id, pick)
  }
  return out
}

export type TruckKind = 'van' | 'straight' | 'reefer' | 'flatbed' | 'stepdeck' | 'power' | 'container' | 'hotshot' | 'conestoga'

/** Which truck drawing an equipment value gets; anything unfamiliar (older free-text cards) is drawn as a van. */
export function truckKindFor(equipment: string): TruckKind {
  const e = equipment.trim().toLowerCase()
  if (!e) return 'van'
  if (e.includes('conestoga')) return 'conestoga'
  if (e.includes('step') || e.includes('drop deck') || e.includes('lowboy')) return 'stepdeck'
  if (e.includes('flat')) return 'flatbed'
  if (e.includes('reefer') || e.includes('refrig')) return 'reefer'
  if (e.includes('box') || e.includes('straight')) return 'straight'
  if (e.includes('power')) return 'power'
  if (e.includes('container') || e.includes('chassis')) return 'container'
  if (e.includes('hot')) return 'hotshot'
  return 'van'
}
