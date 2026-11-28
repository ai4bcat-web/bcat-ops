import { describe, it, expect } from 'vitest'
import { assignAccents, CAPACITY_ACCENTS, hashId, truckKindFor } from './capacityCardStyle'

const card = (id: string, from: string, to = from, createdAt = '2026-11-27T10:00:00.000Z') => ({ id, availableFrom: from, availableTo: to, createdAt })

describe('assignAccents', () => {
  it('gives the same card the same color every time, whatever else is on the board', () => {
    const alone = assignAccents([card('card-a', '2026-11-28')])
    const crowded = assignAccents([card('card-a', '2026-11-28'), card('card-z', '2026-12-20'), card('card-q', '2026-12-21')])
    expect(crowded.get('card-a')).toBe(alone.get('card-a'))
    expect(alone.get('card-a')).toBe(hashId('card-a') % CAPACITY_ACCENTS.length)
  })

  it('never gives two cards on the same day the same color', () => {
    // Many ids, so some would hash to the same hue.
    const cards = Array.from({ length: 8 }, (_, i) => card(`load-${i * 7}`, '2026-11-28', '2026-11-28', `2026-11-27T10:0${i}:00.000Z`))
    const out = assignAccents(cards)
    expect(new Set(cards.map((c) => out.get(c.id))).size).toBe(8)
  })

  it('keeps cards that overlap on any day apart, but lets cards on different days repeat', () => {
    const a = card('same-hue-1', '2026-11-28', '2026-11-30')
    const b = card('same-hue-1b', '2026-11-30', '2026-12-01', '2026-11-27T11:00:00.000Z')
    const far = card('same-hue-1c', '2026-12-10', '2026-12-10', '2026-11-27T12:00:00.000Z')
    const out = assignAccents([a, b, far])
    expect(out.get(a.id)).not.toBe(out.get(b.id))
    expect(out.get(far.id)).toBe(hashId(far.id) % CAPACITY_ACCENTS.length)
  })

  it('settles in a fixed order, so the input order does not change the result', () => {
    const cards = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id, i) => card(id, '2026-11-28', '2026-11-28', `2026-11-27T10:0${i}:00.000Z`))
    const fwd = assignAccents(cards)
    const rev = assignAccents([...cards].reverse())
    for (const c of cards) expect(rev.get(c.id)).toBe(fwd.get(c.id))
  })

  it('still answers when a day holds more cards than there are colors', () => {
    const cards = Array.from({ length: 11 }, (_, i) => card(`many-${i}`, '2026-11-28', '2026-11-28', `2026-11-27T10:${String(i).padStart(2, '0')}:00.000Z`))
    const out = assignAccents(cards)
    expect(out.size).toBe(11)
    for (const v of out.values()) expect(v).toBeLessThan(CAPACITY_ACCENTS.length)
  })
})

describe('truckKindFor', () => {
  it.each([
    ['Dry Van', 'van'], ['Straight Truck', 'straight'], ['Reefer', 'reefer'], ['Flatbed', 'flatbed'], ['Step Deck', 'stepdeck'],
    ['Power Only', 'power'], ['Container', 'container'], ['Hotshot', 'hotshot'], ['Conestoga', 'conestoga'],
  ])('%s is drawn as %s', (equipment, kind) => {
    expect(truckKindFor(equipment)).toBe(kind)
  })

  it('draws older stored names the way their new names are drawn', () => {
    expect(truckKindFor('Van')).toBe('van')
    expect(truckKindFor('Box truck')).toBe('straight')
  })

  it('draws older free-text equipment as a van', () => {
    expect(truckKindFor('')).toBe('van')
    expect(truckKindFor('Something new')).toBe('van')
  })

  it('reads a few common spellings', () => {
    expect(truckKindFor('53 ft reefer')).toBe('reefer')
    expect(truckKindFor('FLATBED w/ tarps')).toBe('flatbed')
    expect(truckKindFor('Straight truck')).toBe('straight')
  })
})
