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
}

/** The fixed charges in force for the period starting `periodStart`. */
export function effectiveFixedExpenses<T extends FixedExpenseInput>(
  fixedExpenses: T[] | null | undefined,
  periodStart: string,
): T[] {
  return (fixedExpenses ?? []).filter(
    (f) => (!f.from || f.from <= periodStart) && (!f.until || periodStart < f.until),
  )
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
