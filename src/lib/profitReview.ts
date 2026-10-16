/**
 * Ivan Local profit review — pure math behind the Profit Review page.
 *
 * Takes one assembled row per calendar month (revenue, cost lines, miles, loads,
 * gallons, per-truck and per-customer detail) and derives: per-mile economics, a
 * baseline month to compare against, line-by-line deltas, a fuel price-vs-volume
 * split, ranked findings ("what to change"), and profit projections at a range of
 * average rates per mile.
 */

export interface ReviewTruck {
  unitNumber: string
  /** Ivan local (semis) vs the box truck — reporting bucket. */
  bucket:     'IVAN_LOCAL' | 'BOX_TRUCK'
  revenue:    number
  miles:      number
  fuel:       number
  /** Gallons bought on the truck's fuel card (price basis). */
  gallons:    number
  /** Gallons burned per Motive's engine data, driving plus idle (MPG basis). */
  motiveGallons: number
  /** Odometer miles on the days that also have Motive gallons, so MPG compares like with like. */
  motiveMiles:   number
  /** The truck's own costs from the engine (dollars, prorated to the month). */
  insurance?:     number
  loan?:          number
  /** Maintenance, permits, tolls and the truck's allocated shares of fleet costs. */
  otherExpenses?: number
  /** Pay attributed to this truck's driver (0 when the fleet's pay is entered combined). */
  driverCost?:    number
}

export interface ReviewCustomer {
  name:    string
  loads:   number
  revenue: number
  /** Booked miles on those loads (Load.miles), for revenue per mile against break-even. */
  miles:   number
}

export interface ReviewUnitMaintenance {
  unitNumber: string
  amount:     number
  biggest:    { description: string; amount: number } | null
}

export interface ReviewMonthInput {
  key:         string   // "2026-08"
  label:       string   // "Aug 2026"
  daysInMonth: number
  /** Days of the month that have happened (== daysInMonth for a finished month). */
  daysElapsed: number
  revenue:     number
  fuel:        number
  driverPay:   number
  maintenance: number
  insurance:   number
  /** Loans, trailer lease, yard, tolls, ELD, permits, other — the lines that don't move with miles. */
  fixed:       number
  miles:       number
  loads:       number
  gallons:     number
  trucks:      ReviewTruck[]
  customers:   ReviewCustomer[]
  unitMaintenance: ReviewUnitMaintenance[]
  /** True when the month predates the expense data (no fixed costs on file): shown, but
   *  never a baseline and never counted in averages or findings. */
  incomplete?: boolean
  /** True when insurance and fixed costs are already cut to the days elapsed (month to
   *  date), so net needs no further proration. */
  costsToDate?: boolean
  /** Box-truck driver pay estimated from the settlement rule (pay % of revenue after fixed
   *  charges). Included in `driverPay`; kept apart so it lands on the box truck, not the semis. */
  boxTruckPay?: number
  /** Trailer maintenance — the semis' cost, never the box truck's. */
  trailerMaintenance?: number
}

/** A finished month with real data behind it. */
export function isComparable(m: ReviewMonthInput): boolean {
  return m.daysElapsed >= m.daysInMonth && m.revenue > 0 && !m.incomplete
}

export interface MonthMetrics {
  net:            number
  margin:         number | null
  /** Net with insurance + fixed costs scaled to the days elapsed (partial months only). */
  proratedNet:    number
  proratedMargin: number | null
  isPartial:      boolean
  revPerMile:     number | null
  revPerLoad:     number | null
  fuelPerMile:    number | null
  payPerMile:     number | null
  maintPerMile:   number | null
  fixedPerMile:   number | null   // insurance + fixed
  costPerMile:    number | null   // everything
  profitPerMile:  number | null
  costPerLoad:    number | null
  variableCostPerMile: number | null  // fuel + pay + maintenance
  pricePerGallon: number | null
  /** Motive miles over Motive gallons burned — the ELD's own economy figure, not a card estimate. */
  mpg:            number | null
  payShare:       number | null   // driver pay / revenue
  totalCost:      number
}

const div = (a: number, b: number): number | null => (b > 0 ? a / b : null)

export function monthMetrics(m: ReviewMonthInput): MonthMetrics {
  const totalCost = m.fuel + m.driverPay + m.maintenance + m.insurance + m.fixed
  const net = m.revenue - totalCost
  const isPartial = m.daysElapsed < m.daysInMonth
  const share = m.daysInMonth > 0 ? Math.min(1, Math.max(0, m.daysElapsed / m.daysInMonth)) : 1
  const proratedNet = isPartial && !m.costsToDate ? m.revenue - (m.fuel + m.driverPay + m.maintenance + (m.insurance + m.fixed) * share) : net
  // Fuel economy from Motive only: trucks reporting both odometer miles and engine fuel burn.
  const eco = m.trucks.filter((t) => t.motiveMiles > 0 && t.motiveGallons > 0)
  const ecoMiles = eco.reduce((s, t) => s + t.motiveMiles, 0)
  const ecoGal = eco.reduce((s, t) => s + t.motiveGallons, 0)
  return {
    net,
    margin: div(net, m.revenue),
    proratedNet,
    proratedMargin: div(proratedNet, m.revenue),
    isPartial,
    revPerMile:   div(m.revenue, m.miles),
    revPerLoad:   div(m.revenue, m.loads),
    fuelPerMile:  div(m.fuel, m.miles),
    payPerMile:   div(m.driverPay, m.miles),
    maintPerMile: div(m.maintenance, m.miles),
    fixedPerMile: div(m.insurance + m.fixed, m.miles),
    costPerMile:  div(totalCost, m.miles),
    profitPerMile: div(net, m.miles),
    costPerLoad:  div(totalCost, m.loads),
    variableCostPerMile: div(m.fuel + m.driverPay + m.maintenance, m.miles),
    pricePerGallon: div(m.fuel, m.gallons),
    mpg: div(ecoMiles, ecoGal),
    payShare: div(m.driverPay, m.revenue),
    totalCost,
  }
}

/** The finished month with the highest net — the yardstick everything else is measured against. */
export function pickBaseline(months: ReviewMonthInput[]): ReviewMonthInput | null {
  const finished = months.filter(isComparable)
  if (finished.length === 0) return null
  return finished.reduce((best, m) => (monthMetrics(m).net > monthMetrics(best).net ? m : best))
}

export interface LineDelta {
  key:    'revenue' | 'fuel' | 'driverPay' | 'maintenance' | 'insurance' | 'fixed' | 'net'
  label:  string
  /** Effect on profit vs the baseline: positive helped, negative hurt. */
  effect: number
}

/** Each line's effect on profit relative to the baseline month (cost up = negative). */
export function deltasVsBaseline(m: ReviewMonthInput, base: ReviewMonthInput): LineDelta[] {
  const net = monthMetrics(m).net - monthMetrics(base).net
  return [
    { key: 'revenue',     label: 'Revenue',     effect: m.revenue - base.revenue },
    { key: 'fuel',        label: 'Fuel',        effect: base.fuel - m.fuel },
    { key: 'driverPay',   label: 'Driver pay',  effect: base.driverPay - m.driverPay },
    { key: 'maintenance', label: 'Maintenance', effect: base.maintenance - m.maintenance },
    { key: 'insurance',   label: 'Insurance',   effect: base.insurance - m.insurance },
    { key: 'fixed',       label: 'Fixed costs', effect: base.fixed - m.fixed },
    { key: 'net',         label: 'Net profit',  effect: net },
  ]
}

export interface FuelSplit {
  /** Extra spend from the price per gallon moving (at this month's gallons). */
  priceEffect:  number
  /** Extra spend from burning more/fewer gallons (at the baseline price). */
  volumeEffect: number
  total:        number
}

/** Split a month's fuel change vs the baseline into price and volume. */
export function fuelSplit(m: ReviewMonthInput, base: ReviewMonthInput): FuelSplit | null {
  const p = monthMetrics(m).pricePerGallon
  const pb = monthMetrics(base).pricePerGallon
  if (p == null || pb == null) return null
  const priceEffect = (p - pb) * m.gallons
  const volumeEffect = (m.gallons - base.gallons) * pb
  return { priceEffect, volumeEffect, total: m.fuel - base.fuel }
}

export interface Finding {
  severity: 'high' | 'medium' | 'info'
  title:    string
  detail:   string
  /** Dollars a month at stake, for ranking. */
  impact:   number
}

export interface FindingOptions {
  /** Driver pay as a share of revenue to hold to (default 0.28). */
  payShareTarget?: number
  /** Cushion over all-in cost per mile for the rate floor (default 5%). */
  rateFloorCushion?: number
  /** Fuel rows the engine could not attribute to any truck in the window. */
  unattributedFuel?: { count: number; amount: number }
  /** Loaded vs empty miles for the period being judged (from src/lib/deadhead.ts). */
  deadhead?: { label: string; loadedMiles: number; emptyMiles: number; variableCostPerMile: number }
  /** Empty miles as a share of all miles to hold to (default 0.25). */
  emptyShareTarget?: number
}

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const usd2 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const pct = (n: number) => `${Math.round(n * 100)}%`

/** Ranked list of what moved profit and what to change, from the latest months vs the baseline. */
export function findings(months: ReviewMonthInput[], base: ReviewMonthInput | null, opts: FindingOptions = {}): Finding[] {
  const payTarget = opts.payShareTarget ?? 0.28
  const cushion = opts.rateFloorCushion ?? 0.05
  const out: Finding[] = []
  const finished = months.filter(isComparable)
  const latest = finished.length > 0 ? finished[finished.length - 1] : null
  const latestM = latest ? monthMetrics(latest) : null

  // Driver pay share.
  if (latest && latestM?.payShare != null && latestM.payShare > payTarget + 0.02) {
    const overage = latest.driverPay - latest.revenue * payTarget
    out.push({
      severity: overage > 3000 ? 'high' : 'medium',
      title: `Hold driver pay at ${pct(payTarget)} of revenue or under`,
      detail: `${latest.label}: pay was ${pct(latestM.payShare)} of revenue (${usd(latest.driverPay)}). At ${pct(payTarget)} it would have been ${usd(latest.revenue * payTarget)}. Watch each 14-day pay period against the revenue those drivers delivered.`,
      impact: overage,
    })
  }

  // Rate per mile vs all-in cost.
  if (latest && latestM?.revPerMile != null && latestM.costPerMile != null) {
    const floor = latestM.costPerMile * (1 + cushion)
    if (latestM.revPerMile < floor) {
      const gap = (floor - latestM.revPerMile) * latest.miles
      out.push({
        severity: latestM.revPerMile < latestM.costPerMile ? 'high' : 'medium',
        title: `Set a rate floor of ${usd2(floor)} a mile (all-in cost ${usd2(latestM.costPerMile)} plus ${pct(cushion)})`,
        detail: `${latest.label} averaged ${usd2(latestM.revPerMile)} of revenue per mile against ${usd2(latestM.costPerMile)} of cost. Loads under the floor lose money before they add fuel and paid hours.`,
        impact: gap,
      })
    }
  }

  // Customers paying below the break-even cost per mile.
  if (latest && latestM?.costPerMile != null) {
    const be = latestM.costPerMile
    const cheap = latest.customers
      .filter((c) => c.loads >= 3 && c.miles > 0 && c.revenue / c.miles < be)
      .sort((a, b) => a.revenue / a.miles - b.revenue / b.miles)
      .slice(0, 4)
    if (cheap.length > 0) {
      const loss = cheap.reduce((s, c) => s + (be - c.revenue / c.miles) * c.miles, 0)
      out.push({
        severity: loss > 2000 ? 'high' : 'medium',
        title: `Reprice or drop freight paying under ${usd2(be)} a mile (break-even)`,
        detail: `${latest.label} all-in cost was ${usd2(be)} per mile. Below it: ${cheap.map((c) => `${c.name} (${c.loads} loads at ${usd2(c.revenue / c.miles)}/mi)`).join(', ')}.`,
        impact: loss,
      })
    }
  }

  // Fuel price move vs baseline.
  if (latest && base && latest.key !== base.key) {
    const split = fuelSplit(latest, base)
    const p = latestM?.pricePerGallon
    const pb = monthMetrics(base).pricePerGallon
    if (split && p != null && pb != null && Math.abs(p - pb) / pb > 0.05) {
      out.push({
        severity: split.priceEffect > 2000 ? 'high' : 'medium',
        title: p > pb ? 'Diesel is up — get a fuel surcharge on the main lane' : 'Diesel is down — lock in the savings',
        detail: `${latest.label} diesel averaged ${usd2(p)} a gallon vs ${usd2(pb)} in ${base.label}. Price alone moved fuel ${usd(Math.abs(split.priceEffect))}; gallons moved it ${usd(Math.abs(split.volumeEffect))}. Every $0.10 a gallon is ${usd(latest.gallons * 0.1)} a month at current volume.`,
        impact: Math.abs(split.priceEffect),
      })
    }
  }

  // Maintenance above the average month.
  if (finished.length >= 2) {
    const avg = finished.reduce((s, m) => s + m.maintenance, 0) / finished.length
    const spikes = finished.filter((m) => m.maintenance > avg * 1.25)
    if (spikes.length > 0) {
      const worst = spikes.reduce((a, b) => (a.maintenance > b.maintenance ? a : b))
      const units = [...worst.unitMaintenance].sort((a, b) => b.amount - a.amount).slice(0, 3)
      out.push({
        severity: 'medium',
        title: `Budget maintenance at ${usd(avg)} a month and cap the repeat offenders`,
        detail: `Average over ${finished.length} months is ${usd(avg)}. ${worst.label} hit ${usd(worst.maintenance)}: ${units.map((u) => `#${u.unitNumber} ${usd(u.amount)}${u.biggest ? ` (${u.biggest.description}, ${usd(u.biggest.amount)})` : ''}`).join('; ')}. Set a 12-month cap per truck and price the replacement when a quote would break it.`,
        impact: worst.maintenance - avg,
      })
    }
  }

  // Trucks burning well above the fleet average per mile (semis only).
  if (latest) {
    const semis = latest.trucks.filter((t) => t.bucket === 'IVAN_LOCAL' && t.miles > 500 && t.fuel > 0)
    if (semis.length >= 2) {
      const best = Math.min(...semis.map((t) => t.fuel / t.miles))
      const thirsty = semis.filter((t) => t.fuel / t.miles > best * 1.2)
      if (thirsty.length > 0) {
        const excess = thirsty.reduce((s, t) => s + (t.fuel / t.miles - best) * t.miles, 0)
        out.push({
          severity: excess > 1500 ? 'medium' : 'info',
          title: `Check fuel economy on ${thirsty.map((t) => `#${t.unitNumber}`).join(' and ')}`,
          detail: `${latest.label}: ${thirsty.map((t) => `#${t.unitNumber} ${usd2(t.fuel / t.miles)}/mi${t.motiveGallons > 0 && t.motiveMiles > 0 ? ` (${(t.motiveMiles / t.motiveGallons).toFixed(1)} mpg per Motive)` : ''}`).join(', ')} vs the best semi at ${usd2(best)}/mi. Idle time, routing and a post-repair economy check are the usual culprits.`,
          impact: excess,
        })
      }
    }
  }

  // Deadhead: empty miles above the target share, priced at the variable cost per mile.
  if (opts.deadhead) {
    const d = opts.deadhead
    const all = d.loadedMiles + d.emptyMiles
    const target = opts.emptyShareTarget ?? 0.25
    if (all > 0) {
      const share = d.emptyMiles / all
      if (share > target) {
        const excessMiles = d.emptyMiles - all * target
        const impact = excessMiles * d.variableCostPerMile
        out.push({
          severity: impact > 2000 ? 'high' : 'medium',
          title: `Cut empty miles: ${pct(share)} of miles ran empty in ${d.label}, target ${pct(target)}`,
          detail: `${Math.round(d.emptyMiles).toLocaleString('en-US')} empty miles against ${Math.round(d.loadedMiles).toLocaleString('en-US')} loaded. At ${usd2(d.variableCostPerMile)} a mile the empty miles cost ${usd(d.emptyMiles * d.variableCostPerMile)}; getting to ${pct(target)} saves ${usd(impact)}. Pair deliveries with the next pickup nearby and stop sending trucks back to the yard between loads.`,
          impact,
        })
      }
    }
  }

  // Data quality: fuel the engine could not place on a truck.
  if (opts.unattributedFuel && opts.unattributedFuel.count > 0) {
    out.push({
      severity: 'info',
      title: 'Fuel purchases with no truck on file',
      detail: `${opts.unattributedFuel.count} fuel ${opts.unattributedFuel.count === 1 ? 'purchase' : 'purchases'} (${usd(opts.unattributedFuel.amount)}) ${opts.unattributedFuel.count === 1 ? 'has' : 'have'} no truck and the card is not on any truck record, so it is left out of the P&L. Add the card number to the truck in Fleet.`,
      impact: opts.unattributedFuel.amount,
    })
  }

  return out.sort((a, b) => b.impact - a.impact)
}

export interface ProjectionInput {
  miles:               number
  fixedCost:           number   // insurance + fixed lines for the month
  variableCostPerMile: number   // fuel + driver pay + maintenance per mile
}

export interface ProjectionRow {
  ratePerMile:  number
  revenue:      number
  variableCost: number
  fixedCost:    number
  net:          number
  margin:       number | null
}

export function breakEvenRatePerMile(p: ProjectionInput): number | null {
  if (p.miles <= 0) return null
  return p.variableCostPerMile + p.fixedCost / p.miles
}

/** Monthly profit at each average rate per mile, holding miles and costs where they are. */
export function projectProfit(p: ProjectionInput, rates: number[]): ProjectionRow[] {
  return rates.map((ratePerMile) => {
    const revenue = ratePerMile * p.miles
    const variableCost = p.variableCostPerMile * p.miles
    const net = revenue - variableCost - p.fixedCost
    return { ratePerMile, revenue, variableCost, fixedCost: p.fixedCost, net, margin: div(net, revenue) }
  })
}

/** Evenly spaced rates from `from` to `to` inclusive. */
export function rateLadder(from: number, to: number, step: number): number[] {
  const out: number[] = []
  for (let r = from; r <= to + 1e-9; r += step) out.push(Math.round(r * 100) / 100)
  return out
}

export interface GroupPerMile {
  key:          'IVAN_LOCAL' | 'BOX_TRUCK' | 'FLEET'
  label:        string
  units:        string[]
  miles:        number
  revenue:      number
  fuel:         number
  /** Every cost charged to the group: its trucks' own costs plus its share of fleet costs. */
  cost:         number
  revPerMile:   number | null
  fuelPerMile:  number | null
  costPerMile:  number | null
  profitPerMile: number | null
}

/**
 * Per-mile economics by reporting bucket, each group carrying what it actually costs:
 *   • each truck's own fuel, insurance, loan, maintenance and allocated fixed shares (engine);
 *   • the combined Ivan driver pay and trailer maintenance → the semis only;
 *   • box-truck driver pay → the box truck;
 *   • whatever fleet cost is left (e.g. ELD) → spread by miles.
 * Groups therefore sum to the fleet. When a month carries no per-truck cost detail, the old
 * even-per-mile spread is used so the figure is never blank.
 */
export function groupPerMile(m: ReviewMonthInput): GroupPerMile[] {
  const mm = monthMetrics(m)
  const own = (t: ReviewTruck) => t.fuel + (t.insurance ?? 0) + (t.loan ?? 0) + (t.otherExpenses ?? 0) + (t.driverCost ?? 0)
  const hasDetail = m.trucks.some((t) => t.insurance != null || t.loan != null || t.otherExpenses != null)
  const ownAll = m.trucks.reduce((s, t) => s + own(t), 0)
  const boxPay = m.boxTruckPay ?? 0
  const combinedPay = Math.max(0, m.driverPay - boxPay - m.trucks.reduce((s, t) => s + (t.driverCost ?? 0), 0))
  const trailerMaint = m.trailerMaintenance ?? 0
  const residual = Math.max(0, mm.totalCost - ownAll - combinedPay - boxPay - trailerMaint)
  const sharedPerMile = m.miles > 0 ? (m.driverPay + m.maintenance + m.insurance + m.fixed) / m.miles : 0

  const build = (key: 'IVAN_LOCAL' | 'BOX_TRUCK', label: string, trucks: ReviewTruck[]): GroupPerMile => {
    const miles = trucks.reduce((s, t) => s + t.miles, 0)
    const revenue = trucks.reduce((s, t) => s + t.revenue, 0)
    const fuel = trucks.reduce((s, t) => s + t.fuel, 0)
    const cost = hasDetail
      ? trucks.reduce((s, t) => s + own(t), 0)
        + (key === 'IVAN_LOCAL' ? combinedPay + trailerMaint : boxPay)
        + (m.miles > 0 ? residual * (miles / m.miles) : 0)
      : fuel + sharedPerMile * miles
    const revPerMile = div(revenue, miles)
    const costPerMile = div(cost, miles)
    return {
      key, label, units: trucks.map((t) => t.unitNumber).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      miles, revenue, fuel, cost, revPerMile, fuelPerMile: div(fuel, miles), costPerMile,
      profitPerMile: revPerMile != null && costPerMile != null ? revPerMile - costPerMile : null,
    }
  }
  const out: GroupPerMile[] = []
  const ivan = m.trucks.filter((t) => t.bucket === 'IVAN_LOCAL')
  const box = m.trucks.filter((t) => t.bucket === 'BOX_TRUCK')
  if (ivan.length) out.push(build('IVAN_LOCAL', 'Ivan local', ivan))
  if (box.length) out.push(build('BOX_TRUCK', 'Box truck', box))
  out.push({
    key: 'FLEET', label: 'Fleet', units: [], miles: m.miles, revenue: m.revenue, fuel: m.fuel, cost: mm.totalCost,
    revPerMile: mm.revPerMile, fuelPerMile: mm.fuelPerMile, costPerMile: mm.costPerMile, profitPerMile: mm.profitPerMile,
  })
  return out
}

/** Box-truck driver pay for a stretch of days from the settlement rule: pay% of revenue
 *  after the fixed charges each 14-day period carries. */
export function boxTruckPayEstimate(revenue: number, days: number, rule: { payPercent: number; fixedPerPeriod: number; expensesBeforePercent: boolean }): number {
  const periods = days / 14
  const fixed = rule.fixedPerPeriod * periods
  const basis = rule.expensesBeforePercent ? Math.max(0, revenue - fixed) : revenue
  const pay = basis * rule.payPercent - (rule.expensesBeforePercent ? 0 : fixed)
  return Math.max(0, pay)
}
