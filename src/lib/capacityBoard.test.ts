import { describe, it, expect } from 'vitest'
import {
  addDaysYmd, applyCapacityOp, capacityColumns, clampCapacityRange, daysBetweenYmd, defaultCapacityRange, parseCapacityBoard,
  parseCapacityFields, canonicalEquipment, formatCapacityTimes, formatMaxWeight, CAPACITY_EQUIPMENT, capacityHeadline, pruneBoard, rangeDays, shiftCardRange, CAPACITY_MAX_CARDS, EMPTY_CAPACITY_BOARD,
  parseNoGoStates, stateOfPlace, noGoStateOf, summarizeNoGoStates, readCapacityHistory, appendCapacityEvent, CAPACITY_HISTORY_MAX, US_STATES,
  type CapacityBoard, type CapacityOp, type CapacityEvent,
} from './capacityBoard'

const NOW = '2026-11-27T15:00:00.000Z'
const TODAY = '2026-11-27' // a Friday
let n = 0
const ctx = { today: TODAY, nowIso: NOW, user: 'dennis@bcatcorp.com', newId: () => `c${++n}` }
const fields = { availableFrom: '2026-11-27', origin: 'Chicago, IL', equipment: 'Dry Van', lengthFt: '53' }

function run(board: CapacityBoard, op: CapacityOp) { return applyCapacityOp(board, op, ctx) }

describe('days and ranges', () => {
  it('opens today through the coming Sunday', () => {
    expect(defaultCapacityRange('2026-11-27')).toEqual({ from: '2026-11-27', to: '2026-11-29' }) // Fri -> Sun
    expect(defaultCapacityRange('2026-11-28')).toEqual({ from: '2026-11-28', to: '2026-11-29' }) // Sat -> Sun
    expect(defaultCapacityRange('2026-11-23')).toEqual({ from: '2026-11-23', to: '2026-11-29' }) // Mon -> Sun
  })

  it('shows next week on a Sunday, never a single column', () => {
    expect(defaultCapacityRange('2026-11-29')).toEqual({ from: '2026-11-29', to: '2026-12-06' })
  })

  it('lists every day of a range and none for a backwards one', () => {
    expect(rangeDays('2026-11-27', '2026-11-29')).toEqual(['2026-11-27', '2026-11-28', '2026-11-29'])
    expect(rangeDays('2026-11-29', '2026-11-27')).toEqual([])
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01')
    expect(daysBetweenYmd('2026-11-27', '2026-12-04')).toBe(7)
  })

  it('keeps a picked range ordered and at most two weeks', () => {
    expect(clampCapacityRange('2026-11-27', '2026-11-20')).toEqual({ from: '2026-11-27', to: '2026-11-27' })
    expect(clampCapacityRange('2026-11-27', '2027-02-01')).toEqual({ from: '2026-11-27', to: '2026-12-10' })
  })
})

describe('card fields', () => {
  it('needs origin, equipment and length, like DAT, and treats an empty destination as anywhere', () => {
    expect(() => parseCapacityFields({ ...fields, origin: '' })).toThrow('Origin is required')
    expect(() => parseCapacityFields({ ...fields, equipment: ' ' })).toThrow('Equipment is required')
    expect(() => parseCapacityFields({ ...fields, lengthFt: '' })).toThrow('Length is required')
    const ok = parseCapacityFields(fields)
    expect(ok.destination).toBe('')
    expect(ok.availableTo).toBe('2026-11-27')
    expect(ok.loadType).toBe('FULL')
    expect(ok.lengthFt).toBe(53)
  })

  it('reads the minimum rate per mile in dollars and keeps it in cents', () => {
    expect(parseCapacityFields({ ...fields, minRatePerMile: '2.5' }).minRatePerMileCents).toBe(250)
    expect(parseCapacityFields({ ...fields, weightLbs: '45,000' }).weightLbs).toBe(45000)
    expect(() => parseCapacityFields({ ...fields, minRatePerMile: 'abc' })).toThrow('must be a number')
  })

  it('keeps optional pickup and destination radius, and ignores a destination radius with no destination', () => {
    const plain = parseCapacityFields(fields)
    expect(plain.originRadiusMi).toBeUndefined() // an old card has no radius
    const ok = parseCapacityFields({ ...fields, destination: 'Atlanta, GA', originRadiusMi: '50', destinationRadiusMi: '100' })
    expect(ok.originRadiusMi).toBe(50)
    expect(ok.destinationRadiusMi).toBe(100)
    expect(parseCapacityFields({ ...fields, originRadiusMi: '50', destinationRadiusMi: '100' }).destinationRadiusMi).toBeUndefined()
    expect(() => parseCapacityFields({ ...fields, originRadiusMi: '501' })).toThrow('between 0 and 500')
    expect(() => parseCapacityFields({ ...fields, originRadiusMi: 'far' })).toThrow('must be a number')
    expect(capacityHeadline({ origin: 'Chicago, IL', destination: 'Atlanta, GA', originRadiusMi: 50 })).toBe('Chicago, IL · 50 mi → Atlanta, GA')
  })

  it('keeps optional pickup and delivery times, single or window, and refuses a window that ends before it starts', () => {
    const ok = parseCapacityFields({ ...fields, pickupTimeFrom: '08:00', pickupTimeTo: '12:00', deliveryTimeFrom: '14:00' })
    expect(formatCapacityTimes(ok)).toBe('PU 8:00a–12:00p · DEL 2:00p')
    expect(formatCapacityTimes(parseCapacityFields({ ...fields, deliveryTimeTo: '17:30' }))).toBe('DEL by 5:30p')
    expect(formatCapacityTimes(parseCapacityFields(fields))).toBe('')
    expect(() => parseCapacityFields({ ...fields, pickupTimeFrom: '12:00', pickupTimeTo: '08:00' })).toThrow('Pickup window ends before it starts')
    expect(() => parseCapacityFields({ ...fields, deliveryTimeFrom: '25:00' })).toThrow('must be a time')
  })

  it('reads an old card that still holds a reference, phone and plain weight, without showing or requiring them', () => {
    const old = parseCapacityBoard({ cards: [{ id: 'o1', status: 'OPEN', availableFrom: '2026-11-27', availableTo: '2026-11-27', origin: 'Chicago, IL', destination: '', equipment: 'Dry Van', loadType: 'FULL', lengthFt: 53, weightLbs: 40000, referenceId: 'R9', contactPhone: '555', createdAt: NOW, createdBy: 'x', updatedAt: NOW, updatedBy: 'x' }] })
    expect(old.cards).toHaveLength(1)
    expect(formatMaxWeight(old.cards[0].weightLbs)).toBe('max 40,000 lb')
    const saved = parseCapacityFields({ ...fields, referenceId: 'R9', contactPhone: '555' }) as unknown as Record<string, unknown>
    expect(saved.referenceId).toBeUndefined()
    expect(saved.contactPhone).toBeUndefined()
    expect(() => parseCapacityFields({ ...fields, weightLbs: '999999' })).toThrow('Maximum weight must be between')
    expect(CAPACITY_EQUIPMENT.map((o) => o.value)).toEqual(['Dry Van', 'Straight Truck', 'Power Only', 'Step Deck', 'Flatbed', 'Reefer', 'Container', 'Hotshot', 'Conestoga'])
    expect(CAPACITY_EQUIPMENT.slice(0, 2)).toEqual([{ value: 'Dry Van', defaultLengthFt: 53 }, { value: 'Straight Truck', defaultLengthFt: 18 }])
    expect(Object.fromEntries(CAPACITY_EQUIPMENT.map((o) => [o.value, o.defaultLengthFt]))).toMatchObject({ 'Power Only': undefined, 'Step Deck': 48, Flatbed: 48, Reefer: 53, Container: 40, Hotshot: 40, Conestoga: 48 })
  })

  it('refuses a backwards or too-long range and a bad load type', () => {
    expect(() => parseCapacityFields({ ...fields, availableTo: '2026-11-26' })).toThrow('before the first')
    expect(() => parseCapacityFields({ ...fields, availableTo: '2026-12-31' })).toThrow('14 days at most')
    expect(() => parseCapacityFields({ ...fields, loadType: 'HALF' })).toThrow('Full or Partial')
  })
})

describe('operations', () => {
  it('saves a new card open, then edits it and clears a field the person emptied', () => {
    const created = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields: { ...fields, comments: 'R1' } })
    expect(created.card).toMatchObject({ status: 'OPEN', origin: 'Chicago, IL', comments: 'R1', createdBy: 'dennis@bcatcorp.com' })
    const edited = run(created.board, { op: 'save', id: created.card.id, fields: { ...fields, origin: 'Dallas, TX', comments: '' } })
    expect(edited.board.cards).toHaveLength(1)
    expect(edited.card.origin).toBe('Dallas, TX')
    expect(edited.card.comments).toBeUndefined()
    expect(edited.card.createdAt).toBe(created.card.createdAt)
  })

  it('moves a card to another day: a single day lands there, a range slides whole', () => {
    const one = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields })
    const moved = run(one.board, { op: 'move', id: one.card.id, fromDay: '2026-11-27', toDay: '2026-11-29' })
    expect(moved.card).toMatchObject({ availableFrom: '2026-11-29', availableTo: '2026-11-29' })
    expect(shiftCardRange({ availableFrom: '2026-11-23', availableTo: '2026-11-25' }, '2026-11-24', '2026-11-26'))
      .toEqual({ availableFrom: '2026-11-25', availableTo: '2026-11-27' })
  })

  it('covers and reopens a card, and remembers who covered it', () => {
    const made = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields })
    const covered = run(made.board, { op: 'cover', id: made.card.id })
    expect(covered.card).toMatchObject({ status: 'COVERED', coveredBy: 'dennis@bcatcorp.com', coveredAt: NOW })
    const reopened = run(covered.board, { op: 'reopen', id: made.card.id })
    expect(reopened.card.status).toBe('OPEN')
    expect(reopened.card.coveredAt).toBeUndefined()
  })

  it('deletes softly and brings a card back on Undo', () => {
    const made = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields })
    const gone = run(made.board, { op: 'delete', id: made.card.id })
    expect(capacityColumns(gone.board, [TODAY], true)[0].cards).toHaveLength(0)
    expect(() => run(gone.board, { op: 'cover', id: made.card.id })).toThrow('deleted')
    const back = run(gone.board, { op: 'restore', id: made.card.id })
    expect(back.card.deletedAt).toBeUndefined()
    expect(capacityColumns(back.board, [TODAY], true)[0].cards).toHaveLength(1)
  })

  it('says so when the card is gone', () => {
    expect(() => run(EMPTY_CAPACITY_BOARD, { op: 'cover', id: 'nope' })).toThrow('gone')
    expect(() => run(EMPTY_CAPACITY_BOARD, { op: 'save', id: 'nope', fields })).toThrow('gone')
  })

  it('forgets cards a week after their last day and a week after a delete, and caps the board', () => {
    const old = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields: { ...fields, availableFrom: '2026-11-10' } })
    expect(pruneBoard(old.board, TODAY, NOW).cards).toHaveLength(0)
    const recent = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields: { ...fields, availableFrom: '2026-11-24' } })
    expect(pruneBoard(recent.board, TODAY, NOW).cards).toHaveLength(1)
    const full: CapacityBoard = { cards: Array.from({ length: CAPACITY_MAX_CARDS }, (_, i) => ({ ...recent.card, id: `x${i}` })) }
    expect(() => run(full, { op: 'save', fields })).toThrow('board is full')
  })

  it('round-trips through the stored JSON, as an object or as text', () => {
    const made = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields })
    expect(parseCapacityBoard(JSON.parse(JSON.stringify(made.board))).cards[0].id).toBe(made.card.id)
    expect(parseCapacityBoard(JSON.stringify(made.board)).cards[0].id).toBe(made.card.id)
    expect(parseCapacityBoard('not json').cards).toEqual([])
    expect(parseCapacityBoard(null).cards).toEqual([])
  })
})

describe('day columns', () => {
  const days = rangeDays('2026-11-27', '2026-11-29')

  it('shows a ranged card on every day of its range, with counts per day', () => {
    const a = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields: { ...fields, availableTo: '2026-11-28' } })
    const b = run(a.board, { op: 'save', fields: { ...fields, origin: 'Atlanta, GA' } })
    const cols = capacityColumns(b.board, days, true)
    expect(cols.map((c) => c.cards.length)).toEqual([2, 1, 0])
    expect(cols.map((c) => c.open)).toEqual([2, 1, 0])
  })

  it('hides covered cards when asked while the counts still tell the whole story', () => {
    const a = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields })
    const b = run(a.board, { op: 'save', fields: { ...fields, origin: 'Atlanta, GA' } })
    const c = run(b.board, { op: 'cover', id: a.card.id })
    const shown = capacityColumns(c.board, days, true)[0]
    expect(shown.cards.map((x) => x.status)).toEqual(['OPEN', 'COVERED'])
    const hidden = capacityColumns(c.board, days, false)[0]
    expect(hidden.cards.map((x) => x.status)).toEqual(['OPEN'])
    expect(hidden).toMatchObject({ open: 1, covered: 1 })
  })

  it('searches origin, destination, equipment, reference and comments', () => {
    const a = run(EMPTY_CAPACITY_BOARD, { op: 'save', fields: { ...fields, comments: 'needs load-locks' } })
    const b = run(a.board, { op: 'save', fields: { ...fields, origin: 'Atlanta, GA', equipment: 'Reefer' } })
    expect(capacityColumns(b.board, days, true, 'reefer')[0].cards).toHaveLength(1)
    expect(capacityColumns(b.board, days, true, 'load-locks')[0].cards).toHaveLength(1)
    expect(capacityColumns(b.board, days, true, 'zzz')[0].cards).toHaveLength(0)
  })
})

describe('canonicalEquipment', () => {
  it.each([
    ['Van', 'Dry Van'], ['van', 'Dry Van'], ['Dry Van', 'Dry Van'], ['dry-van', 'Dry Van'], ["53' van", 'Dry Van'],
    ['Box truck', 'Straight Truck'], ['box truck', 'Straight Truck'], ['Straight truck', 'Straight Truck'], ['Straight', 'Straight Truck'],
    ['power only', 'Power Only'], ['STEP DECK', 'Step Deck'], ['reefer', 'Reefer'],
  ])('%s reads as %s', (stored, name) => {
    expect(canonicalEquipment(stored)).toBe(name)
  })

  it('leaves other older text as written, and an empty value empty', () => {
    expect(canonicalEquipment('Reefer van w/ tarps')).toBe('Reefer van w/ tarps')
    expect(canonicalEquipment('Sprinter')).toBe('Sprinter')
    expect(canonicalEquipment('  ')).toBe('')
    expect(canonicalEquipment(undefined)).toBe('')
  })

  it('finds an older card by the new name in search', () => {
    const a = run({ cards: [] }, { op: 'save', fields: { ...fields, equipment: 'Box truck', lengthFt: '18' } })
    expect(capacityColumns(a.board, ['2026-11-27'], true, 'straight truck')[0].cards).toHaveLength(1)
    expect(capacityColumns(a.board, ['2026-11-27'], true, 'dry van')[0].cards).toHaveLength(0)
  })
})

describe('states we do not travel to', () => {
  it('knows the fifty states and DC', () => {
    expect(US_STATES).toHaveLength(51)
    expect(new Set(US_STATES.map((x) => x.code)).size).toBe(51)
  })

  it('checks a picked list: real codes only, upper-cased, no repeats, sorted', () => {
    expect(parseNoGoStates(['ny', 'CA', 'NY', ' wa '])).toEqual(['CA', 'NY', 'WA'])
    expect(parseNoGoStates([])).toEqual([])
    expect(parseNoGoStates(undefined)).toEqual([])
    expect(() => parseNoGoStates(['XX'])).toThrow('"XX" is not a state')
    expect(() => parseNoGoStates(['CA', 5])).toThrow('two-letter code')
    expect(() => parseNoGoStates('CA')).toThrow('must be a list')
    expect(parseNoGoStates(US_STATES.map((x) => x.code))).toHaveLength(51)
  })

  it('sets the list on the board without touching the cards, and clears it with an empty list', () => {
    const a = run({ cards: [] }, { op: 'save', fields })
    const b = run(a.board, { op: 'setNoGo', states: ['wa', 'CA'] })
    expect(b.card).toBeNull()
    expect(b.board.noGoStates).toEqual(['CA', 'WA'])
    expect(b.board.cards).toEqual(a.board.cards)
    // The list survives every card operation and the weekly prune.
    const covered = run(b.board, { op: 'cover', id: a.card.id })
    expect(covered.board.noGoStates).toEqual(['CA', 'WA'])
    expect(run(covered.board, { op: 'save', fields }).board.noGoStates).toEqual(['CA', 'WA'])
    expect(pruneBoard(covered.board, TODAY, NOW).noGoStates).toEqual(['CA', 'WA'])
    const cleared = run(covered.board, { op: 'setNoGo', states: [] })
    expect('noGoStates' in cleared.board).toBe(false)
  })

  it('refuses a bad list and leaves the board as it was', () => {
    expect(() => run({ cards: [] }, { op: 'setNoGo', states: ['ZZ'] })).toThrow('not a state')
  })

  it('reads a board saved before the list existed as having none, and keeps a stored list through the JSON', () => {
    expect(parseCapacityBoard({ cards: [] }).noGoStates).toBeUndefined()
    expect(parseCapacityBoard(JSON.stringify({ cards: [], noGoStates: ['tx', 'ZZ', 7, 'CA'] })).noGoStates).toEqual(['CA', 'TX'])
    expect(parseCapacityBoard({ cards: [], noGoStates: 'CA' }).noGoStates).toBeUndefined()
  })

  it('finds the state in a typed place, with or without a ZIP, and nothing in a zone or bare ZIP', () => {
    expect(stateOfPlace('Chicago, IL')).toBe('IL')
    expect(stateOfPlace('Los Angeles, ca 90001')).toBe('CA')
    expect(stateOfPlace('St. Louis, MO 63101-1234')).toBe('MO')
    expect(stateOfPlace('Midwest')).toBe('')
    expect(stateOfPlace('60601')).toBe('')
    expect(stateOfPlace('Portland, XX')).toBe('')
    expect(stateOfPlace(undefined)).toBe('')
  })

  it('warns only when the place is in an excluded state', () => {
    expect(noGoStateOf('Los Angeles, CA', ['CA', 'NY'])).toBe('CA')
    expect(noGoStateOf('Dallas, TX', ['CA', 'NY'])).toBe('')
    expect(noGoStateOf('Los Angeles, CA', [])).toBe('')
    expect(noGoStateOf('Los Angeles, CA', undefined)).toBe('')
  })

  it('shortens a long list for a card and keeps the whole list for the tooltip', () => {
    const s = summarizeNoGoStates(['AK', 'CA', 'HI', 'NY', 'OR', 'WA', 'MT', 'ND'])
    expect(s.shown).toEqual(['AK', 'CA', 'HI', 'NY', 'OR', 'WA'])
    expect(s.more).toBe(2)
    expect(s.all).toBe('AK, CA, HI, NY, OR, WA, MT, ND')
    expect(summarizeNoGoStates(undefined)).toEqual({ shown: [], more: 0, all: '' })
  })
})

describe('who covered a card', () => {
  const created = () => run({ cards: [] }, { op: 'save', fields })

  it('stamps the covering caller and the time on the card and in its history', () => {
    const a = created()
    expect(a.card.history).toEqual([{ action: 'created', by: 'dennis@bcatcorp.com', at: NOW }])
    const later = { ...ctx, user: 'ruben@bcatcorp.com', nowIso: '2026-11-28T20:15:00.000Z' }
    const c = applyCapacityOp(a.board, { op: 'cover', id: a.card.id }, later)
    expect(c.card.status).toBe('COVERED')
    expect(c.card.coveredBy).toBe('ruben@bcatcorp.com')
    expect(c.card.coveredAt).toBe('2026-11-28T20:15:00.000Z')
    expect(c.card.history?.at(-1)).toEqual({ action: 'covered', by: 'ruben@bcatcorp.com', at: '2026-11-28T20:15:00.000Z' })
  })

  it('ignores a coveredBy, coveredAt or history the page sends', () => {
    const a = created()
    const forged = { op: 'cover', id: a.card.id, coveredBy: 'someone.else@bcatcorp.com', coveredAt: '2020-01-01T00:00:00.000Z', history: [] } as unknown as CapacityOp
    const c = run(a.board, forged)
    expect(c.card?.coveredBy).toBe('dennis@bcatcorp.com')
    expect(c.card?.coveredAt).toBe(NOW)
    expect(c.card?.history).toHaveLength(2)
    // Nor can an edit rewrite them.
    const edited = run(c.board, { op: 'save', id: a.card.id, fields: { ...fields, coveredBy: 'x@y.com', history: [], status: 'OPEN' } })
    expect(edited.card.coveredBy).toBe('dennis@bcatcorp.com')
    expect(edited.card.status).toBe('COVERED')
    expect(edited.card.history).toHaveLength(2)
  })

  it('clears the covered-by line on reopen and keeps who covered and who reopened in the history', () => {
    const a = created()
    const c = applyCapacityOp(a.board, { op: 'cover', id: a.card.id }, { ...ctx, user: 'ruben@bcatcorp.com' })
    const r = applyCapacityOp(c.board, { op: 'reopen', id: a.card.id }, { ...ctx, user: 'dennis@bcatcorp.com', nowIso: '2026-11-27T18:00:00.000Z' })
    expect(r.card.status).toBe('OPEN')
    expect(r.card.coveredBy).toBeUndefined()
    expect(r.card.coveredAt).toBeUndefined()
    expect(r.card.history?.map((e) => `${e.action}:${e.by}`)).toEqual(['created:dennis@bcatcorp.com', 'covered:ruben@bcatcorp.com', 'reopened:dennis@bcatcorp.com'])
  })

  it('does not add an event when the card is already in that state', () => {
    const a = created()
    expect(run(a.board, { op: 'reopen', id: a.card.id }).card.history).toHaveLength(1)
    const c = run(a.board, { op: 'cover', id: a.card.id })
    expect(run(c.board, { op: 'cover', id: a.card.id }).card.history).toHaveLength(2)
  })

  it('keeps only the most recent events', () => {
    let h: CapacityEvent[] | undefined
    for (let i = 0; i < CAPACITY_HISTORY_MAX + 5; i += 1) h = appendCapacityEvent(h, { action: i % 2 ? 'reopened' : 'covered', by: 'a@b.com', at: `2026-11-27T10:${String(i).padStart(2, '0')}:00.000Z` })
    expect(h).toHaveLength(CAPACITY_HISTORY_MAX)
    expect(h?.[0].at).toBe('2026-11-27T10:05:00.000Z')
    expect(h?.at(-1)?.at).toBe(`2026-11-27T10:${String(CAPACITY_HISTORY_MAX + 4).padStart(2, '0')}:00.000Z`)
  })

  it('reads a card with no history, or a damaged one, as having none', () => {
    expect(readCapacityHistory({})).toEqual([])
    expect(readCapacityHistory({ history: 'x' })).toEqual([])
    expect(readCapacityHistory({ history: [{ action: 'covered', by: 'a@b.com', at: NOW }, { action: 'nope', by: 'a', at: NOW }, null, { action: 'covered' }] })).toEqual([{ action: 'covered', by: 'a@b.com', at: NOW }])
  })

  it('covers a card saved before history existed without breaking', () => {
    const old = { cards: [{ id: 'old', status: 'OPEN', availableFrom: '2026-11-27', availableTo: '2026-11-27', origin: 'Chicago, IL', destination: '', equipment: 'Dry Van', loadType: 'FULL', lengthFt: 53, createdAt: NOW, createdBy: 'x', updatedAt: NOW, updatedBy: 'x' }] }
    const c = run(parseCapacityBoard(old), { op: 'cover', id: 'old' })
    expect(c.card.history).toEqual([{ action: 'covered', by: 'dennis@bcatcorp.com', at: NOW }])
  })
})
