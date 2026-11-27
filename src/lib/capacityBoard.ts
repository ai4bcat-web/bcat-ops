/**
 * The Calendar's Capacity board (Ryne 2026-11-27): a card is a TRUCK WE NEED TO FILL, an open truck or driver the office has to find
 * a load for. The fields follow the DAT "Post Truck" form (available date(s), origin, destination or anywhere, equipment, load type,
 * length, weight, reference, minimum rate per mile, contact phone, comments). The board is one column per day; a card with a date
 * range shows on every day in it; a covered card stays on the board, greyed, until its last day has passed.
 *
 * The board lives in ONE settings field (`TmsSettings.capacityBoard`, written only by tms-directory-actions with a compare-and-swap),
 * so there is no new table. This module is shared by the page and that Lambda: pure functions only, no I/O.
 */

export type CapacityLoadType = 'FULL' | 'PARTIAL'
export type CapacityStatus = 'OPEN' | 'COVERED'

/** The fields a person types; everything else on a card is bookkeeping. */
export interface CapacityFields {
  /** First and last day the truck is available, 'YYYY-MM-DD'. A single day has availableTo === availableFrom. */
  availableFrom: string
  availableTo: string
  /** City, ST or ZIP. */
  origin: string
  /** City, ST or a zone; '' means the truck will go anywhere. */
  destination: string
  equipment: string
  loadType: CapacityLoadType
  lengthFt: number
  weightLbs?: number
  referenceId?: string
  /** Minimum rate per mile in cents (250 = $2.50). */
  minRatePerMileCents?: number
  contactPhone?: string
  comments?: string
  /** Optional link to the driver the truck is (a Driver id). */
  driverId?: string
}

export interface CapacityCard extends CapacityFields {
  id: string
  status: CapacityStatus
  coveredAt?: string
  coveredBy?: string
  /** Set when a card is deleted; it is hidden at once and dropped for good a week later, so Undo can bring it back. */
  deletedAt?: string
  deletedBy?: string
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
}

export interface CapacityBoard {
  cards: CapacityCard[]
}

export const EMPTY_CAPACITY_BOARD: CapacityBoard = { cards: [] }

/** A card may be offered for at most this many days, and the board shows at most this many columns. */
export const CAPACITY_MAX_SPAN_DAYS = 14
/** A deleted or finished card is kept this long (so Undo works and a covered card can be looked up), then dropped on the next write. */
export const CAPACITY_KEEP_DAYS = 7
/** A hard cap on live cards, so the one settings row can never grow past DynamoDB's item limit. */
export const CAPACITY_MAX_CARDS = 300

const YMD = /^\d{4}-\d{2}-\d{2}$/

export function isYmd(v: unknown): v is string {
  if (typeof v !== 'string' || !YMD.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** The day `n` days after (or before, if negative) a 'YYYY-MM-DD' day. */
export function addDaysYmd(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetweenYmd(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000)
}

/** Every day from `from` through `to`, inclusive; [] when the range is backwards. */
export function rangeDays(from: string, to: string): string[] {
  const n = daysBetweenYmd(from, to)
  if (n < 0) return []
  return Array.from({ length: n + 1 }, (_, i) => addDaysYmd(from, i))
}

/** Today's date in Chicago, the zone the office works in. */
export function todayChicagoYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now)
}

/** Day of week of a 'YYYY-MM-DD' day: 0 Sunday … 6 Saturday. */
export function dayOfWeek(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay()
}

/**
 * The range the board opens on: today through the coming Sunday. On a Sunday that is the whole next week (today through next
 * Sunday), so the board is never a single column.
 */
export function defaultCapacityRange(today: string): { from: string; to: string } {
  const untilSunday = (7 - dayOfWeek(today)) % 7
  return { from: today, to: addDaysYmd(today, untilSunday === 0 ? 7 : untilSunday) }
}

/** Clamp a picked range into something the board can show: ordered, and at most CAPACITY_MAX_SPAN_DAYS days. */
export function clampCapacityRange(from: string, to: string): { from: string; to: string } {
  const a = isYmd(from) ? from : todayChicagoYmd()
  let b = isYmd(to) ? to : a
  if (b < a) b = a
  const last = addDaysYmd(a, CAPACITY_MAX_SPAN_DAYS - 1)
  return { from: a, to: b > last ? last : b }
}

// ── Validation (the page and the Lambda use the same rules) ─────────────────

function text(value: unknown, label: string, max: number, required: boolean): string {
  if (value == null || value === '') {
    if (required) throw new Error(`${label} is required`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const t = value.trim().replace(/\s+/g, ' ')
  if (!t && required) throw new Error(`${label} is required`)
  if (t.length > max) throw new Error(`${label} is too long (${max} characters at most)`)
  return t
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value == null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''))
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`)
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return n
}

/**
 * Check and tidy what a person typed. Throws an Error whose message says what to fix. Origin, equipment and length are required,
 * as on DAT; a missing destination means "anywhere".
 */
export function parseCapacityFields(raw: Record<string, unknown>): CapacityFields {
  const availableFrom = raw.availableFrom
  const availableTo = raw.availableTo ?? raw.availableFrom
  if (!isYmd(availableFrom)) throw new Error('Available date is required')
  if (!isYmd(availableTo)) throw new Error('Available-through date is not a date')
  if (availableTo < availableFrom) throw new Error('The last available day is before the first')
  if (daysBetweenYmd(availableFrom, availableTo) + 1 > CAPACITY_MAX_SPAN_DAYS) {
    throw new Error(`A truck can be offered for ${CAPACITY_MAX_SPAN_DAYS} days at most`)
  }
  // Checked in the order the form asks: origin, destination, equipment, load type, length.
  const origin = text(raw.origin, 'Origin', 120, true)
  const destination = text(raw.destination, 'Destination', 120, false)
  const equipment = text(raw.equipment, 'Equipment', 60, true)
  const loadType = raw.loadType == null || raw.loadType === '' ? 'FULL' : raw.loadType
  if (loadType !== 'FULL' && loadType !== 'PARTIAL') throw new Error('Load type must be Full or Partial')
  const lengthFt = optionalNumber(raw.lengthFt, 'Length', 1, 80)
  if (lengthFt === undefined) throw new Error('Length is required')
  const weightLbs = optionalNumber(raw.weightLbs, 'Weight', 1, 200_000)
  const ratePerMile = optionalNumber(raw.minRatePerMile ?? (raw.minRatePerMileCents != null ? Number(raw.minRatePerMileCents) / 100 : undefined), 'Minimum rate per mile', 0, 50)
  const referenceId = text(raw.referenceId, 'Reference ID', 60, false)
  const contactPhone = text(raw.contactPhone, 'Contact phone', 40, false)
  const comments = text(raw.comments, 'Comments', 500, false)
  const driverId = text(raw.driverId, 'Driver', 80, false)
  return {
    availableFrom,
    availableTo,
    origin,
    destination,
    equipment,
    loadType,
    lengthFt,
    ...(weightLbs !== undefined ? { weightLbs: Math.round(weightLbs) } : {}),
    ...(referenceId ? { referenceId } : {}),
    ...(ratePerMile !== undefined ? { minRatePerMileCents: Math.round(ratePerMile * 100) } : {}),
    ...(contactPhone ? { contactPhone } : {}),
    ...(comments ? { comments } : {}),
    ...(driverId ? { driverId } : {}),
  }
}

// ── Reading a stored board ──────────────────────────────────────────────────

/** A stored board arrives as an object or as JSON text (AWSJSON); anything else is an empty board. */
export function parseCapacityBoard(raw: unknown): CapacityBoard {
  let v: unknown = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return { cards: [] } }
  }
  if (!v || typeof v !== 'object') return { cards: [] }
  const list = (v as { cards?: unknown }).cards
  if (!Array.isArray(list)) return { cards: [] }
  const cards: CapacityCard[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    if (typeof o.id !== 'string' || !isYmd(o.availableFrom)) continue
    cards.push(o as unknown as CapacityCard)
  }
  return { cards }
}

// ── Day columns ─────────────────────────────────────────────────────────────

export function cardIsOnDay(card: Pick<CapacityCard, 'availableFrom' | 'availableTo'>, day: string): boolean {
  return card.availableFrom <= day && day <= card.availableTo
}

export function isLive(card: CapacityCard): boolean {
  return !card.deletedAt
}

export interface CapacityDayColumn {
  day: string
  /** The cards shown on this day: open first, then covered (only when covered cards are shown), each in the order they were made. */
  cards: CapacityCard[]
  open: number
  covered: number
}

/**
 * One column per day in `days`. A deleted card never shows. `showCovered` false hides covered cards from the column, while the day's
 * counts still say how many are open and covered, so the header always tells the whole story.
 */
export function capacityColumns(board: CapacityBoard, days: readonly string[], showCovered: boolean, query = ''): CapacityDayColumn[] {
  const q = query.trim().toLowerCase()
  const live = board.cards.filter((c) => isLive(c) && (!q || cardHaystack(c).includes(q)))
  return days.map((day) => {
    const onDay = live.filter((c) => cardIsOnDay(c, day))
    const sorted = [...onDay].sort((a, b) => (a.status === b.status ? a.createdAt.localeCompare(b.createdAt) : a.status === 'OPEN' ? -1 : 1))
    return {
      day,
      cards: showCovered ? sorted : sorted.filter((c) => c.status === 'OPEN'),
      open: onDay.filter((c) => c.status === 'OPEN').length,
      covered: onDay.filter((c) => c.status === 'COVERED').length,
    }
  })
}

function cardHaystack(c: CapacityCard): string {
  return [c.origin, c.destination, c.equipment, c.referenceId, c.contactPhone, c.comments].filter(Boolean).join(' ').toLowerCase()
}

/**
 * Drag a card from one day to another: the card's whole range slides by the number of days between the two, so a Mon-Wed card dragged
 * from Tuesday to Thursday becomes Wed-Fri. A single-day card simply lands on the new day.
 */
export function shiftCardRange(card: Pick<CapacityCard, 'availableFrom' | 'availableTo'>, fromDay: string, toDay: string): { availableFrom: string; availableTo: string } {
  const delta = daysBetweenYmd(fromDay, toDay)
  return { availableFrom: addDaysYmd(card.availableFrom, delta), availableTo: addDaysYmd(card.availableTo, delta) }
}

// ── Operations (what the Lambda applies to the stored board) ────────────────

export type CapacityOp =
  | { op: 'save'; id?: string; fields: Record<string, unknown> }
  | { op: 'move'; id: string; fromDay: string; toDay: string }
  | { op: 'cover'; id: string }
  | { op: 'reopen'; id: string }
  | { op: 'delete'; id: string }
  | { op: 'restore'; id: string }

/** Drop what is old enough to forget: deleted cards a week after deletion, any card a week after its last available day. */
export function pruneBoard(board: CapacityBoard, today: string, nowIso: string): CapacityBoard {
  const cutoffDay = addDaysYmd(today, -CAPACITY_KEEP_DAYS)
  const cutoffTime = new Date(new Date(nowIso).getTime() - CAPACITY_KEEP_DAYS * 86_400_000).toISOString()
  return {
    cards: board.cards.filter((c) => {
      if (c.deletedAt) return c.deletedAt >= cutoffTime
      return c.availableTo >= cutoffDay
    }),
  }
}

export interface ApplyContext {
  today: string
  nowIso: string
  user: string
  /** A fresh card id (the Lambda passes randomUUID()). */
  newId: () => string
}

/** Apply one operation and return the new board. Throws an Error whose message is shown to the person. */
export function applyCapacityOp(current: CapacityBoard, op: CapacityOp, ctx: ApplyContext): { board: CapacityBoard; card: CapacityCard } {
  const board = pruneBoard(current, ctx.today, ctx.nowIso)
  const stamp = { updatedAt: ctx.nowIso, updatedBy: ctx.user }

  if (op.op === 'save') {
    const fields = parseCapacityFields(op.fields)
    if (!op.id) {
      if (board.cards.filter(isLive).length >= CAPACITY_MAX_CARDS) throw new Error('The capacity board is full; mark some cards covered or delete old ones')
      const card: CapacityCard = { id: ctx.newId(), status: 'OPEN', ...fields, createdAt: ctx.nowIso, createdBy: ctx.user, ...stamp }
      return { board: { cards: [...board.cards, card] }, card }
    }
    const existing = board.cards.find((c) => c.id === op.id && isLive(c))
    if (!existing) throw new Error('That card is gone: it was deleted or has aged off the board')
    // Optional fields a person cleared must disappear, so rebuild from the checked fields rather than merging.
    const card: CapacityCard = {
      id: existing.id, status: existing.status,
      ...(existing.coveredAt ? { coveredAt: existing.coveredAt } : {}), ...(existing.coveredBy ? { coveredBy: existing.coveredBy } : {}),
      ...fields, createdAt: existing.createdAt, createdBy: existing.createdBy, ...stamp,
    }
    return { board: { cards: board.cards.map((c) => (c.id === card.id ? card : c)) }, card }
  }

  const existing = board.cards.find((c) => c.id === op.id)
  if (!existing) throw new Error('That card is gone: it has aged off the board')
  let card: CapacityCard
  switch (op.op) {
    case 'move': {
      if (!isYmd(op.fromDay) || !isYmd(op.toDay)) throw new Error('Pick a day to move the card to')
      if (existing.deletedAt) throw new Error('That card was deleted')
      card = { ...existing, ...shiftCardRange(existing, op.fromDay, op.toDay), ...stamp }
      break
    }
    case 'cover': {
      if (existing.deletedAt) throw new Error('That card was deleted')
      card = { ...existing, status: 'COVERED', coveredAt: ctx.nowIso, coveredBy: ctx.user, ...stamp }
      break
    }
    case 'reopen': {
      if (existing.deletedAt) throw new Error('That card was deleted')
      const { coveredAt: _a, coveredBy: _b, ...rest } = existing
      void _a; void _b
      card = { ...rest, status: 'OPEN', ...stamp }
      break
    }
    case 'delete': {
      card = { ...existing, deletedAt: ctx.nowIso, deletedBy: ctx.user, ...stamp }
      break
    }
    case 'restore': {
      const { deletedAt: _c, deletedBy: _d, ...rest } = existing
      void _c; void _d
      card = { ...rest, ...stamp }
      break
    }
  }
  return { board: { cards: board.cards.map((c) => (c.id === card.id ? card : c)) }, card }
}

/** The text a card's phone and tooltip read: "Chicago, IL → anywhere · Dry Van · 53 ft". */
export function capacityHeadline(c: Pick<CapacityCard, 'origin' | 'destination'>): string {
  return `${c.origin} → ${c.destination || 'anywhere'}`
}

/** Min rate per mile as dollars, '$2.50/mi'; '' when none. */
export function formatRatePerMile(cents: number | undefined): string {
  return cents == null ? '' : `$${(cents / 100).toFixed(2)}/mi`
}
