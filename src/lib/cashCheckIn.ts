import { z } from 'zod'

export type CenterKey = 'bcat' | 'ivan' | 'amazon'

export interface CenterDef {
  readonly key: CenterKey
  readonly name: string
  readonly tag: string
}

export const CENTERS: readonly CenterDef[] = [
  { key: 'bcat', name: 'BCAT Logistics', tag: 'brokerage' },
  { key: 'ivan', name: 'Ivan Cartage', tag: 'asset carrier' },
  { key: 'amazon', name: 'Amazon DSP', tag: 'delivery' },
] as const

const CENTER_KEYS: readonly CenterKey[] = ['bcat', 'ivan', 'amazon']

const centerMtdField: Record<CenterKey, keyof CashCheckInInput> = {
  bcat: 'bcatMtdProfit',
  ivan: 'ivanMtdProfit',
  amazon: 'amazonMtdProfit',
}

export interface CashCheckInInput {
  date: string
  cash: number
  ar?: number | null
  ap?: number | null
  cards?: number | null
  bcatMtdProfit?: number | null
  ivanMtdProfit?: number | null
  amazonMtdProfit?: number | null
  note?: string | null
}

export interface CashCheckIn extends CashCheckInInput {
  id: string
  createdBy?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface CenterRunRate {
  fixed: number
  profit: number
  /** Months between profit being earned and landing in the bank (0..3). 30-day terms = 1. */
  lagMonths: number
}

export interface CashSettingsValues {
  floor: number
  months: number
  runrate: Record<CenterKey, CenterRunRate>
  items: { ym: string; label: string; amount: number }[]
  factoring: {
    on: boolean
    start: string
    stop: string
    eligible: number
    fee: number
    advance: number
  }
  /** Biweekly Slack reminder: the morning after every 14th day from the last payroll. '' = off. */
  reminder: {
    payrollAnchor: string // YYYY-MM-DD of a payroll day
    slackChannel: string  // Slack channel ID (C…) or user ID (U…)
  }
}

export const DEFAULT_CASH_SETTINGS: CashSettingsValues = {
  floor: 25_000,
  months: 12,
  runrate: {
    bcat: { fixed: 30_000, profit: -5_000, lagMonths: 1 },
    ivan: { fixed: 60_000, profit: 20_000, lagMonths: 1 },
    amazon: { fixed: 82_000, profit: 18_000, lagMonths: 0 }, // Amazon pays weekly
  },
  items: [{ ym: '2026-10', label: 'Pay off credit cards', amount: -9_000 }],
  factoring: {
    on: false,
    start: '2026-10',
    stop: '',
    eligible: 100_000,
    fee: 2,
    advance: 90,
  },
  reminder: { payrollAnchor: '', slackChannel: '' },
}

export const MAX_LAG_MONTHS = 3
export const clampLagMonths = (n: number): number => Math.min(MAX_LAG_MONTHS, Math.max(0, Math.round(n)))

const YM_RE = /^\d{4}-\d{2}$/

export interface CashOutlookRow {
  ym: string
  /** Profit earned in the month, per center (the P&L view). */
  per: Record<CenterKey, number>
  /** Sum of `per` — what was earned this month. */
  net: number
  /** What arrives in the bank this month after each center's lag (the cash view). */
  landing: number
  /** `landing`, less the part of the current month already behind the check-in date. */
  netToCome: number
  items: CashSettingsValues['items']
  itemsSum: number
  cash: number
  status: 'short' | 'low' | 'ok'
  current: boolean
  estimated: Record<CenterKey, boolean>
  fxCash?: number
  fxDelta?: number
  fxActive?: boolean
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function coalesceMoney(value: unknown): number {
  if (value === null || value === undefined) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function isValidDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  )
}

function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function formatYm(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function clampMonths(n: number): number {
  return Math.min(12, Math.max(3, n))
}

export function cashToday(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addCashMonths(ym: string, k: number): string {
  const [y, m] = ym.split('-').map(Number)
  return formatYm(new Date(Date.UTC(y, m - 1 + k, 1)))
}

export function cashMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric',
  })
}

export function cashDateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function cashMoney(n: number): string {
  const v = Math.round(n)
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US')
}

export function latestCashCheckIn(checkins: CashCheckIn[]): CashCheckIn | null {
  if (checkins.length === 0) return null
  return [...checkins].sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null
}

export function trueLiquidity(checkIn: CashCheckIn | CashCheckInInput): number {
  return (
    coalesceMoney(checkIn.cash) -
    coalesceMoney(checkIn.cards) +
    coalesceMoney(checkIn.ar) -
    coalesceMoney(checkIn.ap)
  )
}

function applyFactoring(
  rows: CashOutlookRow[],
  settings: CashSettingsValues,
): void {
  const f = settings.factoring ?? DEFAULT_CASH_SETTINGS.factoring
  if (!f.on || !YM_RE.test(f.start || '')) return

  const E = f.eligible ?? DEFAULT_CASH_SETTINGS.factoring.eligible
  const fee = (f.fee ?? DEFAULT_CASH_SETTINGS.factoring.fee) / 100
  const adv = (f.advance ?? DEFAULT_CASH_SETTINGS.factoring.advance) / 100
  let fx = 0

  for (const row of rows) {
    const active = row.ym >= f.start && (!f.stop || row.ym < f.stop)
    let delta = 0
    if (row.ym === f.start) delta += adv * E
    if (row.ym === addCashMonths(f.start, 1)) delta += (1 - adv) * E
    if (active) delta -= fee * E
    if (f.stop && row.ym === f.stop) delta -= adv * E
    if (f.stop && row.ym === addCashMonths(f.stop, 1)) delta -= (1 - adv) * E
    fx += delta
    row.fxDelta = delta
    row.fxCash = row.cash + fx
    row.fxActive = active
  }
}

export function projectCash(
  checkins: CashCheckIn[],
  settings: CashSettingsValues,
  today?: string,
): CashOutlookRow[] {
  const latest = latestCashCheckIn(checkins)
  const startYm = latest ? latest.date.slice(0, 7) : (today ?? cashToday()).slice(0, 7)
  let cash = latest ? coalesceMoney(latest.cash) : 0
  const rows: CashOutlookRow[] = []

  // Pass 1: what each center EARNS per month (P&L view). Month 0 scales MTD to a full
  // month when the check-in carries one; every other month is the run-rate.
  const earned: Record<CenterKey, number>[] = []
  for (let i = 0; i < settings.months; i++) {
    const ym = addCashMonths(startYm, i)
    const per: Record<CenterKey, number> = { bcat: 0, ivan: 0, amazon: 0 }
    for (const center of CENTERS) {
      const mtd = i === 0 && latest ? (latest[centerMtdField[center.key]] as number | null | undefined) : null
      if (mtd !== null && mtd !== undefined) {
        const day = Number(latest!.date.slice(8, 10))
        per[center.key] = mtd / Math.max(day / daysInMonth(ym), 0.1)
      } else {
        per[center.key] = settings.runrate[center.key].profit
      }
    }
    earned.push(per)
  }

  // Pass 2: what LANDS in the bank each month — each center's earnings shifted by its
  // lag. Months before the horizon (i − lag < 0) are assumed to have earned the run-rate.
  for (let i = 0; i < settings.months; i++) {
    const ym = addCashMonths(startYm, i)
    const per = earned[i]
    const net = CENTERS.reduce((sum, c) => sum + per[c.key], 0)
    let landing = 0
    for (const center of CENTERS) {
      const rr = settings.runrate[center.key]
      const lag = clampLagMonths(rr.lagMonths ?? 0)
      landing += lag === 0 ? per[center.key] : i - lag >= 0 ? earned[i - lag][center.key] : rr.profit
    }

    let netToCome = landing
    if (i === 0 && latest) {
      const day = Number(latest.date.slice(8, 10))
      netToCome = landing * (1 - day / daysInMonth(ym))
    }

    const items = (settings.items || []).filter((item) => item.ym === ym)
    const itemsSum = items.reduce((sum, item) => sum + coalesceMoney(item.amount), 0)
    cash = cash + netToCome + itemsSum

    const estimated: Record<CenterKey, boolean> = { bcat: false, ivan: false, amazon: false }
    if (i === 0 && latest) {
      for (const center of CENTERS) {
        const mtd = latest[centerMtdField[center.key]] as number | null | undefined
        estimated[center.key] = mtd !== null && mtd !== undefined
      }
    }

    const status: CashOutlookRow['status'] =
      cash < 0 ? 'short' : cash < settings.floor ? 'low' : 'ok'

    rows.push({
      ym,
      per,
      net,
      landing,
      netToCome,
      items,
      itemsSum,
      cash,
      status,
      current: i === 0,
      estimated,
    })
  }

  applyFactoring(rows, settings)
  return rows
}

export function factoringSummary(
  rows: CashOutlookRow[],
  settings: CashSettingsValues,
): {
  stepUp: number
  monthlyFee: number
  advanceAmount: number
  endCash: number
  baseEndCash: number
  totalFees: number
  stopReadyMonth: string | null
} {
  const f = settings.factoring ?? DEFAULT_CASH_SETTINGS.factoring
  const E = f.eligible ?? DEFAULT_CASH_SETTINGS.factoring.eligible
  const fee = (f.fee ?? DEFAULT_CASH_SETTINGS.factoring.fee) / 100
  const adv = (f.advance ?? DEFAULT_CASH_SETTINGS.factoring.advance) / 100

  const stepUp = E
  const monthlyFee = fee * E
  const advanceAmount = adv * E

  const withFactoring = rows.filter((row) => row.fxCash !== undefined)
  const baseRow = rows[rows.length - 1]
  const factoringRow = withFactoring[withFactoring.length - 1]

  const baseEndCash = baseRow?.cash ?? 0
  const endCash = factoringRow?.fxCash ?? baseEndCash
  const totalFees = monthlyFee * withFactoring.filter((row) => row.fxActive).length

  const fixedCushion =
    CENTERS.reduce(
      (sum, center) => sum + Math.max(settings.runrate[center.key].fixed, 0),
      0,
    ) * 0.4

  const stopReady = rows.find(
    (row) =>
      row.fxCash !== undefined &&
      row.fxCash - E >= settings.floor + fixedCushion,
  )

  return {
    stepUp,
    monthlyFee,
    advanceAmount,
    endCash,
    baseEndCash,
    totalFees,
    stopReadyMonth: stopReady?.ym ?? null,
  }
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function normalizeCashSettings(value: unknown): CashSettingsValues {
  const parsed: Record<string, unknown> | null =
    typeof value === 'string'
      ? (safeJsonParse(value) as Record<string, unknown> | null)
      : value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null

  if (!parsed || typeof parsed !== 'object') {
    return deepClone(DEFAULT_CASH_SETTINGS)
  }

  const out = deepClone(DEFAULT_CASH_SETTINGS)

  if (typeof parsed.floor === 'number') out.floor = parsed.floor
  if (typeof parsed.months === 'number') out.months = clampMonths(parsed.months)

  if (parsed.runrate && typeof parsed.runrate === 'object') {
    const rr = parsed.runrate as Record<string, unknown>
    for (const key of CENTER_KEYS) {
      const center = rr[key]
      if (center && typeof center === 'object') {
        const c = center as Record<string, unknown>
        out.runrate[key] = {
          fixed: typeof c.fixed === 'number' ? c.fixed : out.runrate[key].fixed,
          profit: typeof c.profit === 'number' ? c.profit : out.runrate[key].profit,
          // Records written before the lag existed pick up the per-center default.
          lagMonths: typeof c.lagMonths === 'number' ? clampLagMonths(c.lagMonths) : out.runrate[key].lagMonths,
        }
      }
    }
  }

  if (Array.isArray(parsed.items)) {
    out.items = parsed.items.map((item) => {
      const it = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      return {
        ym: typeof it.ym === 'string' ? it.ym : '',
        label: typeof it.label === 'string' ? it.label : '',
        amount: typeof it.amount === 'number' ? it.amount : 0,
      }
    })
  }

  if (parsed.factoring && typeof parsed.factoring === 'object') {
    const f = parsed.factoring as Record<string, unknown>
    out.factoring = {
      on: typeof f.on === 'boolean' ? f.on : out.factoring.on,
      start: typeof f.start === 'string' ? f.start : out.factoring.start,
      stop: typeof f.stop === 'string' ? f.stop : out.factoring.stop,
      eligible: typeof f.eligible === 'number' ? f.eligible : out.factoring.eligible,
      fee: typeof f.fee === 'number' ? f.fee : out.factoring.fee,
      advance: typeof f.advance === 'number' ? f.advance : out.factoring.advance,
    }
  }

  if (parsed.reminder && typeof parsed.reminder === 'object') {
    const r = parsed.reminder as Record<string, unknown>
    out.reminder = {
      payrollAnchor: typeof r.payrollAnchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.payrollAnchor) ? r.payrollAnchor : '',
      slackChannel: typeof r.slackChannel === 'string' ? r.slackChannel.trim() : '',
    }
  }

  out.months = clampMonths(out.months)
  return out
}

/** Days from ISO date a to ISO date b (calendar days, UTC-safe). */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/**
 * The payroll date a reminder is for on `today`, or null when none is due.
 *
 * Payroll recurs every 14 days from `payrollAnchor`; the reminder goes out the morning
 * AFTER each one (today − 1 is a payroll day). It is suppressed once a check-in dated on
 * or after that payroll exists, so a reminder is never sent for a check-in already done.
 */
export function reminderDuePayroll(
  settings: Pick<CashSettingsValues, 'reminder'>,
  checkins: Pick<CashCheckIn, 'date'>[],
  today: string,
): string | null {
  const anchor = settings.reminder.payrollAnchor
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return null
  const sinceAnchor = daysBetween(anchor, today) - 1
  if (sinceAnchor < 0 || sinceAnchor % 14 !== 0) return null
  const payroll = (() => { const [y, m, d] = anchor.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + sinceAnchor)).toISOString().slice(0, 10) })()
  return checkins.some((c) => c.date >= payroll) ? null : payroll
}

function requireMoney(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`)
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be whole dollars`)
  }
  return value
}

function optionalMoney(value: unknown, label: string): number | null | undefined {
  if (value === undefined || value === null) return value as null | undefined
  return requireMoney(value, label)
}

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine(isValidDate, { message: 'Date is not a valid calendar date' })

export function validateCashCheckIn(value: unknown): CashCheckInInput {
  if (!value || typeof value !== 'object') {
    throw new Error('Check-in must be an object')
  }
  const v = value as Record<string, unknown>

  const date = dateStringSchema.parse(v.date)
  const cash = requireMoney(v.cash, 'Cash')
  const ar = optionalMoney(v.ar, 'Receivables')
  const ap = optionalMoney(v.ap, 'Payables')
  const cards = optionalMoney(v.cards, 'Credit cards owed')
  const bcatMtdProfit = optionalMoney(v.bcatMtdProfit, 'BCAT MTD profit')
  const ivanMtdProfit = optionalMoney(v.ivanMtdProfit, 'Ivan MTD profit')
  const amazonMtdProfit = optionalMoney(v.amazonMtdProfit, 'Amazon DSP MTD profit')

  // null must survive (like the money fields): it is how an edit clears a note. undefined
  // would be dropped from the GraphQL input and leave the old note in place.
  let note: string | null | undefined = v.note === null ? null : undefined
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== 'string') throw new Error('Note must be a string')
    note = v.note
  }

  const out: CashCheckInInput = { date, cash }
  out.ar = ar
  out.ap = ap
  out.cards = cards
  out.bcatMtdProfit = bcatMtdProfit
  out.ivanMtdProfit = ivanMtdProfit
  out.amazonMtdProfit = amazonMtdProfit
  out.note = note
  return out
}
