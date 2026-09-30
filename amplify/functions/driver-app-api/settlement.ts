/**
 * Driver weekly settlement composition.
 *
 * Reuses the exact same pure math the staff /driver-pay page uses so a driver
 * never sees a different number. See src/hooks/useAmazonPay.ts.
 */


import {
  calcDriverPay,
  tripPayAmount,
  effectivePayRate,
  effectiveFixedExpenses,
  fixedExpenseLineLabel,
  type DriverPaySettingInput,
  type FixedExpenseInput,
  type PayRateOverride,
} from '../../../src/lib/driverPay'
import { matchedFuelForCard, sumFuel } from '../../../src/lib/driverFuel'
import { creditLineLabel } from '../../../src/lib/payCredits'
import { weekStartOfISO, weekLabel } from '../../../src/features/driver-pay/week'

export interface SettlementTrip {
  id: string
  date: string
  loadId?: string | null
  origin?: string | null
  destination?: string | null
  miles?: number | null
  rate?: number | null
  amount: number
}

export interface SettlementLine {
  label: string
  amount: number
}

export interface Settlement {
  weekStart: string
  weekLabel: string
  trips: SettlementTrip[]
  grossPay: number
  deductions: SettlementLine[]
  credits: SettlementLine[]
  debits: SettlementLine[]
  checkAmount: number
}

export interface SettlementWeek {
  weekStart: string
  gross: number
  net: number
  tripCount: number
}

export interface RawAmazonTrip {
  id: string
  periodStart: string
  shipmentDate?: string | null
  loadId?: string | null
  origin?: string | null
  destination?: string | null
  miles?: number | null
  ratePerMile?: number | null
  freightAmount: number
  status?: string | null
  sortOrder?: number | null
  createdAt?: string | null
}

export interface RawDriverPaySetting {
  payPercent: number
  expensesBeforePercent: boolean
  fuelCardNumber?: string | null
  fixedExpenses?: unknown
  rateHistory?: unknown
}

export interface RawFuelTransaction {
  transactionDate: string
  cardNumber: string
  fuelType: string
  itemCategory?: string | null
  amount: number
  quantity: number
}

export interface RawDeduction {
  label: string
  amount: number
}

export interface RawCredit {
  kind?: string | null
  reasonCode: string
  label?: string | null
  amount: number
  miles?: number | null
  costPerMile?: number | null
  date?: string | null
}

const MS_PER_DAY = 86_400_000

function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

function parseJsonArray<T>(value: unknown): T[] | null {
  if (!value) return null
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  return Array.isArray(parsed) ? (parsed as T[]) : null
}

function safeNumber(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function tripRate(trip: RawAmazonTrip): number | null {
  if (trip.ratePerMile != null && Number.isFinite(trip.ratePerMile)) return trip.ratePerMile
  if (trip.miles && trip.freightAmount) return round2(trip.freightAmount / trip.miles)
  return null
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function buildSettlement(
  periodStart: string,
  trips: RawAmazonTrip[],
  setting: RawDriverPaySetting,
  deductions: RawDeduction[],
  credits: RawCredit[],
  debits: RawCredit[],
  fuelTransactions: RawFuelTransaction[],
): Settlement {
  const end = periodEnd(periodStart)
  const rateModel = effectivePayRate(
    {
      payPercent: safeNumber(setting.payPercent),
      expensesBeforePercent: !!setting.expensesBeforePercent,
      rateHistory: parseJsonArray<PayRateOverride>(setting.rateHistory),
    },
    periodStart,
  )

  const tripInputs = trips.map((t) => ({ freightAmount: t.freightAmount, status: t.status }))

  const fixed = effectiveFixedExpenses(
    parseJsonArray<FixedExpenseInput>(setting.fixedExpenses),
    periodStart,
    end,
  )

  const fuel = sumFuel(
    matchedFuelForCard(
      fuelTransactions,
      setting.fuelCardNumber,
      periodStart,
      end,
    ),
  )

  const fixedDebits = fixed
    .filter((f) => f.afterPercent)
    .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))

  const deductionLines = [
    ...fixed
      .filter((f) => !f.afterPercent)
      .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
    ...(fuel > 0 ? [{ label: `Fuel (card ${setting.fuelCardNumber ?? ''})`, amount: fuel }] : []),
    ...deductions.map((d) => ({ label: d.label, amount: safeNumber(d.amount) })),
  ]

  const myCredits = credits
    .map((c) => ({
      label: creditLineLabel({
        reasonCode: c.reasonCode,
        label: c.label,
        miles: c.miles,
        costPerMile: c.costPerMile,
        amount: c.amount,
      }),
      amount: safeNumber(c.amount),
      reasonCode: c.reasonCode,
    }))
    .sort(
      (a, b) =>
        (a.reasonCode ?? '').localeCompare(b.reasonCode ?? '') || a.label.localeCompare(b.label),
    )

  const myDebits = debits
    .map((c) => ({
      label: creditLineLabel({
        reasonCode: c.reasonCode,
        label: c.label,
        miles: c.miles,
        costPerMile: c.costPerMile,
        amount: c.amount,
      }),
      amount: safeNumber(c.amount),
      reasonCode: c.reasonCode,
    }))
    .sort(
      (a, b) =>
        (a.reasonCode ?? '').localeCompare(b.reasonCode ?? '') || a.label.localeCompare(b.label),
    )

  const statement = calcDriverPay(
    tripInputs,
    rateModel as DriverPaySettingInput,
    deductionLines,
    myCredits,
    [...fixedDebits, ...myDebits],
  )

  return {
    weekStart: periodStart,
    weekLabel: weekLabel(periodStart),
    trips: trips
      .sort(
        (a, b) =>
          ((a.shipmentDate ?? a.periodStart).localeCompare(b.shipmentDate ?? b.periodStart)) ||
          ((a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
      )
      .map((t) => ({
        id: t.id,
        date: t.shipmentDate ?? t.periodStart,
        loadId: t.loadId ?? null,
        origin: t.origin ?? null,
        destination: t.destination ?? null,
        miles: t.miles ?? null,
        rate: tripRate(t),
        amount: tripPayAmount(t.freightAmount, rateModel as DriverPaySettingInput),
      })),
    grossPay: statement.gross,
    deductions: deductionLines,
    credits: myCredits,
    debits: [...fixedDebits, ...myDebits],
    checkAmount: statement.checkAmount,
  }
}

export function listWeekStarts(
  trips: RawAmazonTrip[],
  referenceDate: Date = new Date(),
  minWeekStart?: string,
): string[] {
  let earliest = undefined as string | undefined
  for (const t of trips) {
    if (!earliest || t.periodStart < earliest) earliest = t.periodStart
  }
  if (!earliest) earliest = minWeekStart
  if (!earliest) return []
  if (minWeekStart && earliest < minWeekStart) earliest = minWeekStart
  const start = new Date(`${weekStartOfISO(earliest)}T12:00:00Z`)
  const now = new Date(`${weekStartOfISO(referenceDate.toISOString().slice(0, 10))}T12:00:00Z`)
  const weeks: string[] = []
  while (start.getTime() <= now.getTime() + 6 * MS_PER_DAY) {
    const iso = start.toISOString().slice(0, 10)
    if (!minWeekStart || iso >= minWeekStart) {
      weeks.push(iso)
    }
    start.setUTCDate(start.getUTCDate() + 7)
  }
  return weeks.reverse()
}
