/**
 * Amazon driver-pay calculator — pure functions, money-critical.
 *
 * Two pay models (per driver), both verified against the production pay sheets:
 *
 *   • expensesBeforePercent = TRUE  (e.g. Chad @ 42%):
 *       the driver keeps `payPercent` of (gross − expenses).
 *       Each load's "Amount" shows the FULL freight; the % is applied at the end.
 *         check = payPercent × (gross − deductions)
 *
 *   • expensesBeforePercent = FALSE (e.g. Lee 88%, Mike 85%, Roy 88%):
 *       the driver keeps `payPercent` of gross, THEN expenses are subtracted.
 *       Each load's "Amount" = payPercent × freight.
 *         check = payPercent × gross − deductions
 *
 * gross = sum of every trip's freight amount (cancelled trips included — they appear
 * with a pay amount on the sheets). All amounts in DOLLARS.
 *
 * Credits (detention, layover, bonus, reimbursements, prior-period adjustments…) are
 * added to the check IN FULL after the pay model runs — the driver's % is never applied
 * to them, so a $150 credit always raises the check by exactly $150.
 */

export interface PayTripInput {
  freightAmount: number   // dollars
  status?: string | null
}

export interface DriverPaySettingInput {
  /** Driver's keep fraction, 0..1 (e.g. 0.42, 0.88). */
  payPercent: number
  /** True → keep% applies AFTER expenses (Chad); false → % of gross then minus expenses. */
  expensesBeforePercent: boolean
}

/**
 * A pinned historical rate window: for pay weeks starting in [from, until) the driver
 * was paid on THIS model, whatever the current setting says.
 *
 * Why windows instead of "the setting at the time": pay is derived live from the current
 * DriverPaySetting on every render, so changing a driver's % would silently rewrite every
 * past week's statement. Pinning the past as explicit windows keeps history stable while
 * the base setting stays the ONE current rate that the settings modal edits and future
 * weeks follow. (First real case: Chad's weeks of 8/16 and 8/23/2026 paid Lee/Roy-style
 * at 88% − expenses, before moving to 50% after expenses from 8/30 on.)
 */
export interface PayRateOverride {
  /** First pay-week start (YYYY-MM-DD, inclusive) this window covers. */
  from: string
  /** Pay-week start (YYYY-MM-DD, exclusive) where this window ends. */
  until: string
  payPercent: number
  expensesBeforePercent: boolean
}

export interface FixedExpenseMileage {
  costPerMile: number
  miles: number
}

/**
 * A fixed recurring charge, optionally bounded to a range of pay periods.
 *
 * `from`/`until` are period-start dates (YYYY-MM-DD): the charge applies to periods
 * starting in [from, until); either side absent means unbounded. Same idea as
 * PayRateOverride, for the same reason — deductions are derived live from the current
 * setting, so deleting a charge outright silently rewrote every past week's statement.
 * ENDING a charge (setting `until`) leaves history intact; deleting is for mistakes.
 */
export interface FixedExpenseInput {
  label:  string
  amount: number
  from?:  string | null
  until?: string | null
  /** Stable id of this revision; every prepared row has one. */
  revisionId?: string | null
  /** Stable id grouping all revisions of the same expense. */
  expenseId?:  string | null
  recordedAt?: string | null
  recordedBy?: string | null
  /** When this revision was ended, and by whom. */
  endedAt?: string | null
  endedBy?: string | null
  /** Mileage-based expense basis; when present the authoritative amount is derived from it. */
  mileage?: FixedExpenseMileage | null
}

const MS_PER_DAY = 86_400_000

function parseISODateUTC(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date ${JSON.stringify(value)}`)
  }
  const [y, m, d] = value.split('-').map(Number)
  const ts = Date.UTC(y, m - 1, d)
  const dt = new Date(ts)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date ${value}`)
  }
  return dt
}

/** A charge in force for a period, with the day fraction it was prorated by (absent = full period). */
export type ProratedFixedExpense<T extends FixedExpenseInput> = T & { proratedDays?: { days: number; periodDays: number } }

/** Statement label for a fixed charge — names the day fraction so a transition-period amount is explained on the sheet. */
export function fixedExpenseLineLabel(f: ProratedFixedExpense<FixedExpenseInput>): string {
  return f.proratedDays ? `${f.label} (${f.proratedDays.days}/${f.proratedDays.periodDays} days)` : f.label
}

/** The fixed charges in force for the period [periodStart, periodEndInclusive].
 *
 * Each overlapping revision is prorated by actual calendar days inside the period,
 * rounded to integer cents. Rounding error is allocated per `expenseId` series so a
 * same-rate split across revisions cannot create or lose a cent over the period.
 * Partial-period lines carry `proratedDays` so statements can show the fraction.
 */
export function effectiveFixedExpenses<T extends FixedExpenseInput>(
  fixedExpenses: T[] | null | undefined,
  periodStart: string,
  periodEndInclusive: string,
): ProratedFixedExpense<T>[] {
  const start = parseISODateUTC(periodStart)
  const end = parseISODateUTC(periodEndInclusive)
  if (end < start) {
    throw new Error(`periodEndInclusive ${periodEndInclusive} is before periodStart ${periodStart}`)
  }
  const periodDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1
  const periodEndExclusive = new Date(end.getTime() + MS_PER_DAY)

  type Item = {
    entry: T
    overlapDays: number
    exactCents: number
    baseCents: number
    frac: number
  }
  const items: Item[] = []

  for (const entry of fixedExpenses ?? []) {
    const from = entry.from ? parseISODateUTC(entry.from) : null
    const until = entry.until ? parseISODateUTC(entry.until) : null
    if (from && until && from > until) {
      throw new Error(`Invalid fixed-expense window: ${entry.from} > ${entry.until}`)
    }
    const overlapStart = from && from > start ? from : start
    const overlapEnd = until && until < periodEndExclusive ? until : periodEndExclusive
    if (overlapEnd.getTime() <= overlapStart.getTime()) continue

    const overlapDays = Math.round((overlapEnd.getTime() - overlapStart.getTime()) / MS_PER_DAY)
    if (overlapDays <= 0) continue

    const amountCents = Math.round(entry.amount * 100)
    const exactCents = (amountCents * overlapDays) / periodDays
    const baseCents = Math.floor(exactCents)
    items.push({
      entry,
      overlapDays,
      exactCents,
      baseCents,
      frac: exactCents - baseCents,
    })
  }

  // Allocate rounding per expenseId series.
  const noIdKey = Symbol('no-expense-id')
  const groups = new Map<string | symbol, Item[]>()
  for (const item of items) {
    const key = item.entry.expenseId ?? noIdKey
    const arr = groups.get(key) ?? []
    arr.push(item)
    groups.set(key, arr)
  }

  for (const group of groups.values()) {
    const totalExact = group.reduce((sum, item) => sum + item.exactCents, 0)
    const target = Math.round(totalExact)
    const baseSum = group.reduce((sum, item) => sum + item.baseCents, 0)
    let extra = target - baseSum
    const ordered = group
      .map((item, index) => ({ item, index, frac: item.frac }))
      .sort((a, b) => b.frac - a.frac || a.index - b.index)
    for (const { item } of ordered) {
      if (extra <= 0) break
      item.baseCents += 1
      extra -= 1
    }
  }

  return items.map(({ entry, baseCents, overlapDays }) => ({
    ...entry,
    amount: Math.round((baseCents / 100 + Number.EPSILON) * 100) / 100,
    ...(overlapDays < periodDays ? { proratedDays: { days: overlapDays, periodDays } } : {}),
  }))
}

/**
 * The pay model in force for the week starting `periodStart`: the matching pinned
 * window if one covers it, otherwise the setting's current base rate.
 */
export function effectivePayRate(
  setting: DriverPaySettingInput & { rateHistory?: PayRateOverride[] | null },
  periodStart: string,
): DriverPaySettingInput {
  const hit = (setting.rateHistory ?? []).find(
    (w) => w.from <= periodStart && periodStart < w.until,
  )
  return hit
    ? { payPercent: hit.payPercent, expensesBeforePercent: hit.expensesBeforePercent }
    : { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent }
}

/** A deduction line — `amount` is the positive dollar figure subtracted from pay. */
export interface PayDeductionInput {
  label:  string
  amount: number
}

/** A credit line — `amount` is the positive dollar figure ADDED to the check, in full. */
export interface PayCreditInput {
  label:       string
  amount:      number
  reasonCode?: string | null
}

/**
 * A debit line — the positive dollar figure SUBTRACTED from the check, in full, AFTER
 * the % model has run. The mirror of a credit: where an ordinary deduction on an
 * after-expenses driver only costs them their pay % of it, a debit costs the driver
 * the whole dollar (cash advance, damage, escrow, prior-period correction…).
 */
export type PayDebitInput = PayCreditInput

export interface DriverPayStatement {
  gross:                 number   // Σ freight
  payPercent:            number
  expensesBeforePercent: boolean
  /** Σ of per-trip driver "Amount" (mode-false: pct×gross; mode-true: gross). */
  driverAmount:          number
  totalDeductions:       number
  /** mode-true: gross − deductions (the pre-% subtotal); mode-false: pay after deductions. */
  subtotal:              number
  totalCredits:          number   // Σ credits — added to the check at 100%
  totalDebits:           number   // Σ debits — subtracted from the check at 100%, after the net
  /** Pay after the % model + deductions, BEFORE credits/debits are applied. */
  payBeforeCredits:      number
  checkAmount:           number   // what the driver is paid this period (incl. credits − debits)
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** The driver's pay "Amount" for a single load (before period deductions). */
export function tripPayAmount(freightAmount: number, setting: DriverPaySettingInput): number {
  const a = setting.expensesBeforePercent ? freightAmount : setting.payPercent * freightAmount
  return round2(a)
}

export function calcDriverPay(
  trips: PayTripInput[],
  setting: DriverPaySettingInput,
  deductions: PayDeductionInput[],
  credits: PayCreditInput[] = [],
  debits: PayDebitInput[] = [],
): DriverPayStatement {
  const gross = round2(trips.reduce((s, t) => s + (t.freightAmount || 0), 0))
  const totalDeductions = round2(deductions.reduce((s, d) => s + (d.amount || 0), 0))
  const totalCredits = round2(credits.reduce((s, c) => s + (c.amount || 0), 0))
  const totalDebits = round2(debits.reduce((s, d) => s + (d.amount || 0), 0))
  const pct = setting.payPercent

  let driverAmount: number
  let subtotal: number
  let payBeforeCredits: number

  if (setting.expensesBeforePercent) {
    driverAmount     = gross
    subtotal         = round2(gross - totalDeductions)
    payBeforeCredits = round2(pct * subtotal)
  } else {
    driverAmount     = round2(pct * gross)
    subtotal         = round2(driverAmount - totalDeductions)
    payBeforeCredits = subtotal
  }

  return {
    gross,
    payPercent: pct,
    expensesBeforePercent: setting.expensesBeforePercent,
    driverAmount,
    totalDeductions,
    subtotal,
    totalCredits,
    totalDebits,
    payBeforeCredits,
    checkAmount: round2(payBeforeCredits + totalCredits - totalDebits),
  }
}
