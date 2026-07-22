// Monthly Box-Truck profitability for a single box-truck driver (Zak / #3890).
// Mirrors the box-truck SETTLEMENT math (useBoxTruckPay) — gross = Σ grossProfit
// (customer rate − carrier cost); driver pay + expenses via calcDriverPay — but rolls
// it up over a calendar month instead of one biweekly pay period.
import { calcDriverPay, type PayDeductionInput } from './driverPay'
import { matchedFuelForCard, sumFuel } from './driverFuel'
import type { BoxTruckTrip, DriverPaySetting, DriverPayDeduction, FuelTransaction } from './apiClient'

export interface BoxTruckMonth {
  revenue:     number   // Σ customer rate (billed to customers)
  carrierCost: number   // Σ carrier cost (paid to the hauling carrier)
  grossProfit: number   // revenue − carrier cost (the settlement "gross")
  driverPay:   number   // the driver's check(s) for the month
  fuel:        number
  otherExp:    number   // fixed + one-off deductions
  expenses:    number   // fuel + otherExp
  profit:      number   // to the company = grossProfit − driverPay − expenses
  tripCount:   number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Aggregate one box-truck driver's shipments delivered within [start, end]. */
export function aggregateBoxTruckMonth(params: {
  trips: BoxTruckTrip[]
  setting: DriverPaySetting
  fuelTxs: FuelTransaction[]
  deductions: DriverPayDeduction[]
  start: string
  end: string
}): BoxTruckMonth {
  const { trips, setting, fuelTxs, deductions, start, end } = params

  // Trips for this driver delivered in the month (fall back to periodStart if no date).
  const inMonth = trips.filter((t) => {
    if (t.driverId !== setting.driverId) return false
    const d = t.date || t.periodStart
    return d >= start && d <= end
  })

  const revenue     = round2(inMonth.reduce((s, t) => s + (t.customerRate ?? 0), 0))
  const carrierCost = round2(inMonth.reduce((s, t) => s + (t.carrierCost ?? 0), 0))

  const fuelTxns = matchedFuelForCard(fuelTxs, setting.fuelCardNumber, start, end)
  const fuel = sumFuel(fuelTxns)
  const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart >= start && x.periodStart <= end)
  const otherExp = round2((setting.fixedExpenses ?? []).reduce((s, f) => s + (f.amount || 0), 0) + oneOffs.reduce((s, o) => s + (o.amount || 0), 0))

  const ded: PayDeductionInput[] = [
    ...(setting.fixedExpenses ?? []).map((f) => ({ label: f.label, amount: f.amount })),
    ...(fuel > 0 ? [{ label: `Fuel (card ${setting.fuelCardNumber})`, amount: fuel }] : []),
    ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
  ]

  // Settlement pay model applied to the month's gross profit (Zak = 50% after expenses).
  const statement = calcDriverPay(
    inMonth.map((t) => ({ freightAmount: t.grossProfit, status: t.status })),
    { payPercent: setting.payPercent, expensesBeforePercent: setting.expensesBeforePercent },
    ded,
  )

  const grossProfit = round2(statement.gross)
  const driverPay = round2(statement.checkAmount)
  const expenses = round2(fuel + otherExp)
  const profit = round2(grossProfit - driverPay - expenses)

  return { revenue, carrierCost, grossProfit, driverPay, fuel, otherExp, expenses, profit, tripCount: inMonth.length }
}
