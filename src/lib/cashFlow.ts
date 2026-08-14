/**
 * Weekly rolling cash-flow forecast — pure math, no I/O.
 *
 * STANDALONE BY DESIGN: nothing here reads loads, invoices, expenses, insurance or any
 * other BCAT Ops model. Every number is typed in by the user on the Cash Flow page and
 * stored in that page's own tables. Keep it that way — wiring this to live AR/AP would
 * change what the page means.
 *
 * Money is held in **cents** (integers), matching the insurance module, so the running
 * balance can't drift the way repeated float addition would. Only format to dollars at
 * the edge.
 */

export interface CashFlowInputs {
  /** ISO date (yyyy-mm-dd). Drives the month labels — M1 is this date's month. */
  weekOf: string
  cashBcatCents: number
  cashIvanCents: number
  ar30Cents: number
  ar120Cents: number
  /** Share of the aged 120-day AR you expect to actually collect, 0–1 (0.9 = 90%). */
  ar120CollectionRate: number
  apBcatAgingCents: number
  apBcatExpectedCents: number
  apBcatAmexCents: number
  apIvanCcCents: number
  apIvanMiscCents: number
  recurringRevenueCents: number
  recurringExpensesCents: number
  /**
   * Months to spread the payables backlog over, starting at month 1. 1 = pay it all at
   * once (the default). Raising it staggers the same total across the early months, which
   * lifts the month-1 trough without changing where you end up — the money still goes out,
   * just later.
   */
  payablesSpreadMonths: number
  /** Lowest closing balance you're willing to run. Drives the red KPI. */
  minCashThresholdCents: number
}

/** The starter set the page ships with, so it renders populated on first load. */
export const SEED_INPUTS: CashFlowInputs = {
  weekOf: todayIso(),
  cashBcatCents: 2_435_000,          // $24,350
  cashIvanCents: 5_176_400,          // $51,764
  ar30Cents: 22_000_000,             // $220,000
  ar120Cents: 7_000_000,             // $70,000
  ar120CollectionRate: 0.9,
  apBcatAgingCents: 7_630_200,       // $76,302
  apBcatExpectedCents: 620_000,      // $6,200
  apBcatAmexCents: 450_000,          // $4,500
  apIvanCcCents: 0,
  apIvanMiscCents: 350_000,          // $3,500
  recurringRevenueCents: 22_000_000, // $220,000
  recurringExpensesCents: 20_500_000,// $205,000
  payablesSpreadMonths: 1,
  minCashThresholdCents: 0,
}

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Blank/NaN/negative-zero all collapse to 0 so a half-filled form still projects. */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

export const totalCashCents = (i: CashFlowInputs) => num(i.cashBcatCents) + num(i.cashIvanCents)

export const totalPayablesCents = (i: CashFlowInputs) =>
  num(i.apBcatAgingCents) + num(i.apBcatExpectedCents) + num(i.apBcatAmexCents) +
  num(i.apIvanCcCents) + num(i.apIvanMiscCents)

export interface MonthBucket {
  /** 1-based month index, M1…M6. */
  index: number
  /** e.g. "Aug 2026" */
  label: string
  openingCents: number
  ar30Cents: number
  ar120Cents: number
  revenueCents: number
  totalInflowCents: number
  payablesCents: number
  expensesCents: number
  totalOutflowCents: number
  netCents: number
  closingCents: number
}

export interface Projection {
  months: MonthBucket[]
  /** min(closing) across the six months — the number that tells you if you survive. */
  lowestClosingCents: number
  /** closing[6] */
  endingClosingCents: number
  /** True when the low point breaches the user's minimum-cash threshold. */
  breachesThreshold: boolean
}

export const MONTHS = 6

/** Month labels starting at `weekOf`'s month: Aug 2026, Sep 2026, … */
export function monthLabels(weekOf: string, count = MONTHS): string[] {
  // Parse as local noon so a yyyy-mm-dd string doesn't shift a day across timezones.
  const base = new Date(`${(weekOf || todayIso()).slice(0, 10)}T12:00:00`)
  const start = Number.isNaN(base.getTime()) ? new Date() : base
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  })
}

/**
 * The forecast. Timing assumptions, all deliberate and surfaced in the page legend:
 *  - 30-day AR lands in M1 only.
 *  - 120-day AR lands in M2 only, net of the collection rate.
 *  - Recurring revenue starts in M2 — M1's inflow is already the 30-day AR, and
 *    counting both would bill the same month of sales twice.
 *  - Payables clear in M1 by default, or spread evenly across the first
 *    `payablesSpreadMonths` months when you stagger them.
 *  - Recurring operating expenses run every month.
 */
export function project(inputs: CashFlowInputs, horizon = MONTHS): Projection {
  const labels = monthLabels(inputs.weekOf, horizon)
  const rate = Math.min(Math.max(num(inputs.ar120CollectionRate), 0), 1)
  const revenue = num(inputs.recurringRevenueCents)
  const expenses = num(inputs.recurringExpensesCents)
  const payables = totalPayablesCents(inputs)

  // Even split across the first `spread` months. The remainder rides on month 1 so the
  // instalments sum to the payables total exactly — no cents lost to rounding.
  const spread = Math.min(Math.max(Math.round(num(inputs.payablesSpreadMonths)) || 1, 1), MONTHS)
  const perMonth = Math.floor(payables / spread)
  const remainder = payables - perMonth * spread

  const months: MonthBucket[] = []
  let opening = totalCashCents(inputs)

  for (let m = 1; m <= horizon; m++) {
    const ar30 = m === 1 ? num(inputs.ar30Cents) : 0
    // Round once, here, so the collection-rate multiply can't leave sub-cent dust in
    // the running balance.
    const ar120 = m === 2 ? Math.round(num(inputs.ar120Cents) * rate) : 0
    const rev = m >= 2 ? revenue : 0
    const totalInflow = ar30 + ar120 + rev

    const ap = m > spread ? 0 : perMonth + (m === 1 ? remainder : 0)
    const totalOutflow = ap + expenses

    const net = totalInflow - totalOutflow
    const closing = opening + net

    months.push({
      index: m,
      label: labels[m - 1],
      openingCents: opening,
      ar30Cents: ar30,
      ar120Cents: ar120,
      revenueCents: rev,
      totalInflowCents: totalInflow,
      payablesCents: ap,
      expensesCents: expenses,
      totalOutflowCents: totalOutflow,
      netCents: net,
      closingCents: closing,
    })
    opening = closing
  }

  const closings = months.map((m) => m.closingCents)
  const lowest = Math.min(...closings)
  return {
    months,
    lowestClosingCents: lowest,
    endingClosingCents: closings[closings.length - 1],
    breachesThreshold: lowest < num(inputs.minCashThresholdCents),
  }
}

/* ── formatting ─────────────────────────────────────────────────────────────── */

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** Cents → "$24,350". Negatives render as "-$1,200". */
export function fmtCents(cents: number): string {
  return usd.format(Math.round(num(cents)) / 100)
}

export const fmtPercent = (rate: number) => `${(num(rate) * 100).toFixed(0)}%`

/**
 * Dollars typed into an input → integer cents ("24350.55" → 2435055).
 *
 * Parses the decimal string digit-by-digit rather than multiplying by 100: "1.005" is
 * 1.00499999… once it becomes a float, so `Math.round(n * 100)` would silently give 100
 * cents instead of 101. Inputs hand us strings, so the exact path covers real entry; the
 * float fallback only runs for programmatic callers.
 */
export function dollarsToCents(dollars: unknown): number {
  if (typeof dollars === 'string') {
    const m = dollars.trim().match(/^(-?)(\d*)(?:\.(\d*))?$/)
    if (m) {
      const sign = m[1] === '-' ? -1 : 1
      const whole = parseInt(m[2] || '0', 10)
      // Truncate beyond 2dp: a third decimal of a cent isn't money.
      const frac = parseInt((m[3] ?? '').padEnd(2, '0').slice(0, 2) || '0', 10)
      return sign * (whole * 100 + frac)
    }
  }
  return Math.round(num(dollars) * 100)
}

export const centsToDollars = (cents: number) => num(cents) / 100


/* ── runway ─────────────────────────────────────────────────────────────────── */

/** Stop walking here. Beyond five years "runway" stops meaning anything useful. */
export const RUNWAY_CAP_MONTHS = 60

export interface Runway {
  /**
   * Whole months of cash left before the balance drops below the minimum threshold.
   * null when it never does inside the cap — see `sustainable`.
   */
  monthsRemaining: number | null
  /** The month the money runs out, e.g. "Apr 2027". null when it doesn't. */
  runsOutLabel: string | null
  /** Net cash movement in a steady month, once the one-off AR and payables have settled. */
  steadyNetCents: number
  /** True when a steady month is break-even or better — the balance stops falling. */
  sustainable: boolean
  startingCashCents: number
  /** The walk, truncated at the month it runs out (or at the cap). Drives the chart. */
  months: MonthBucket[]
  /** True when the balance is already under the threshold today. */
  alreadyBelow: boolean
  /**
   * A month that dips below the floor but RECOVERS afterwards — e.g. August, where all
   * payables clear at once before the recurring revenue starts. Worth acting on, but it
   * isn't the end of the runway, so it's reported separately rather than cutting it short.
   */
  temporaryDipLabel: string | null
}

/**
 * How long the cash lasts.
 *
 * Runs the same monthly model as `project`, just further out, and stops at the first month
 * the closing balance falls below the minimum-cash threshold. The early months carry the
 * one-off events (30-day AR, the aged AR, clearing payables); from month 3 on every month
 * is identical — revenue minus expenses — so that figure is the real burn rate and what
 * determines whether the runway is finite at all.
 */
export function runway(inputs: CashFlowInputs): Runway {
  const floor = num(inputs.minCashThresholdCents)
  const steadyNet = num(inputs.recurringRevenueCents) - num(inputs.recurringExpensesCents)
  const startingCash = totalCashCents(inputs)

  const walk = project(inputs, RUNWAY_CAP_MONTHS).months
  const isAbove = (m: MonthBucket) => m.closingCents >= floor

  // Runway ends where the balance goes below the floor AND STAYS below — not at the first
  // dip. Month 1 clears every payable at once before recurring revenue starts, so a
  // one-month trough there is normal and recovers; treating it as the end would report
  // "under a month" for a business with years of cash.
  let lastAbove = -1
  for (let i = 0; i < walk.length; i++) if (isAbove(walk[i])) lastAbove = i

  const firstBelow = walk.findIndex((m) => !isAbove(m))
  // A dip that recovers: below the floor at some point, but not the final state.
  const temporaryDipLabel =
    firstBelow !== -1 && firstBelow < lastAbove ? walk[firstBelow].label : null

  // Never dips at all → nothing to report.
  if (firstBelow === -1) {
    return {
      monthsRemaining: null,
      runsOutLabel: null,
      steadyNetCents: steadyNet,
      sustainable: steadyNet >= 0,
      startingCashCents: startingCash,
      months: walk.slice(0, MONTHS),
      alreadyBelow: startingCash < floor,
      temporaryDipLabel: null,
    }
  }

  // Recovers and finishes above the floor inside the cap → no runway limit either.
  if (lastAbove === walk.length - 1) {
    return {
      monthsRemaining: null,
      runsOutLabel: null,
      steadyNetCents: steadyNet,
      sustainable: steadyNet >= 0,
      startingCashCents: startingCash,
      months: walk.slice(0, MONTHS),
      alreadyBelow: startingCash < floor,
      temporaryDipLabel,
    }
  }

  // Months you get fully through before the permanent shortfall.
  const monthsRemaining = lastAbove + 1
  return {
    monthsRemaining,
    runsOutLabel: walk[lastAbove + 1].label,
    steadyNetCents: steadyNet,
    sustainable: false,
    startingCashCents: startingCash,
    // Keep one month past the break so the chart shows it crossing, not stopping short.
    months: walk.slice(0, lastAbove + 2),
    alreadyBelow: startingCash < floor,
    temporaryDipLabel,
  }
}

/** "8 months" / "1 month" / "under a month". */
export function runwayLabel(r: Runway): string {
  if (r.monthsRemaining == null) return 'No limit'
  if (r.monthsRemaining === 0) return 'Under a month'
  return `${r.monthsRemaining} month${r.monthsRemaining === 1 ? '' : 's'}`
}


/**
 * The smallest number of months you'd need to spread the payables over to keep every
 * month at or above the minimum-cash threshold. null when no spread inside the horizon
 * achieves it — the shortfall is bigger than deferring payables can fix.
 *
 * Deferring doesn't create money: the same total still goes out, so this only helps when
 * the trough is a timing problem rather than a solvency one.
 */
export function suggestedPayablesSpread(inputs: CashFlowInputs): number | null {
  for (let spread = 1; spread <= MONTHS; spread++) {
    const p = project({ ...inputs, payablesSpreadMonths: spread })
    if (!p.breachesThreshold) return spread
  }
  return null
}
