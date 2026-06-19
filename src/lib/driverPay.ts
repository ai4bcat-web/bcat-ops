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

/** A deduction line — `amount` is the positive dollar figure subtracted from pay. */
export interface PayDeductionInput {
  label:  string
  amount: number
}

export interface DriverPayStatement {
  gross:                 number   // Σ freight
  payPercent:            number
  expensesBeforePercent: boolean
  /** Σ of per-trip driver "Amount" (mode-false: pct×gross; mode-true: gross). */
  driverAmount:          number
  totalDeductions:       number
  /** mode-true: gross − deductions (the pre-% subtotal); mode-false: same as checkAmount. */
  subtotal:              number
  checkAmount:           number   // what the driver is paid this period
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
): DriverPayStatement {
  const gross = round2(trips.reduce((s, t) => s + (t.freightAmount || 0), 0))
  const totalDeductions = round2(deductions.reduce((s, d) => s + (d.amount || 0), 0))
  const pct = setting.payPercent

  let driverAmount: number
  let subtotal: number
  let checkAmount: number

  if (setting.expensesBeforePercent) {
    driverAmount = gross
    subtotal     = round2(gross - totalDeductions)
    checkAmount  = round2(pct * subtotal)
  } else {
    driverAmount = round2(pct * gross)
    subtotal     = round2(driverAmount - totalDeductions)
    checkAmount  = subtotal
  }

  return {
    gross,
    payPercent: pct,
    expensesBeforePercent: setting.expensesBeforePercent,
    driverAmount,
    totalDeductions,
    subtotal,
    checkAmount,
  }
}
