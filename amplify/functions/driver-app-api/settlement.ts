/**
 * Driver weekly settlement composition.
 *
 * Reuses the exact same pure math the staff /driver-pay page uses so a driver
 * never sees a different number. See src/hooks/useAmazonPay.ts.
 */


import {
  calcDriverPay,
  factoringFeePctFor,
  tripPayAmount,
  effectivePayRate,
  effectiveFixedExpenses,
  fixedExpenseLineLabel,
  FACTORING_FEE_LABEL,
  type DriverPaySettingInput,
  type FixedExpenseInput,
  type PayRateOverride,
} from '../../../src/lib/driverPay'
import { matchedFuelForCard, sumFuel, effectiveFuelCard, type FuelCardWindow } from '../../../src/lib/driverFuel'
import { tripHoldReason, PAY_HOLD_LABEL, type PayHoldReason } from '../../../src/lib/payHold'
import { ratePerMile } from '../../../src/lib/ownerOperatorTrips'
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
  /**
   * The gross freight on the load, in dollars — what the broker pays.
   *
   * The phone used to receive only `amount` (the driver's share) and `rate` (per mile),
   * so an owner operator could not see the figure their percentage was taken from. The
   * desktop page has always shown Freight beside Driver Amount; the app now does too.
   */
  freight: number
  /** What this load pays, whether or not it is on this check. */
  amount: number
  /** False when the load is listed but not paid on this check — see heldReason. */
  onThisCheck?: boolean
  factoring?: FactoringFields | null
  /**
   * Set when this load is NOT on the check yet: the POD is missing, or it has not been
   * delivered. The driver sees the same held figure the office sees; a statement that
   * quietly differs from the cheque is how a driver loses trust in the app.
   */
  heldReason?: PayHoldReason | null
  heldLabel?: string | null
}

/**
 * The eleven OTR required fields plus the two required documents, resolved per load
 * (by driver-app-api from the Load row and its linked Customer/Location rows) so the
 * driver can see which settlements are blocked from factoring.
 */
export interface FactoringFields {
  invoiceNo: string | null
  poNumber: string | null
  brokerMc: string | null
  invoiceAmount: number | null
  invoiceDate: string | null
  fromCity: string | null
  fromState: string | null
  fromZip: string | null
  toCity: string | null
  toState: string | null
  toZip: string | null
  podPresent: boolean
  rateconPresent: boolean
  /**
   * False when the POD store could not be consulted at all — an unconfigured or failing
   * table. "We could not check" is not "there is no POD", and only the latter may hold a
   * driver's pay, so the distinction is carried explicitly rather than collapsed into
   * `podPresent: false`.
   */
  podKnown?: boolean
  /** True when any required field or document is missing. */
  blocked: boolean
}

export interface SettlementLine {
  label: string
  amount: number
}

export interface Settlement {
  weekStart: string
  weekLabel: string
  trips: SettlementTrip[]
  /** Σ freight of the loads ON this check, in dollars. The desktop calls this "Freight total". */
  grossPay: number
  /** Σ driver share of the loads on this check — the desktop's "driver share" column total. */
  driverAmount: number
  /** The driver's percentage, so the footer can say "driver share (88%)" like the desktop. */
  payPercent: number
  /** Σ freight of the loads held OFF this check, so the footer can say what it excludes. */
  heldFreight: number
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
  /** DynamoDB Load.id behind a display loadId (owner-operator trips carry it). */
  loadRowId?: string | null
  factoring?: FactoringFields | null
}

export interface RawDriverPaySetting {
  payPercent: number
  expensesBeforePercent: boolean
  /** Decides the factoring fee: Amazon freight is never factored. */
  payGroup?: string | null
  fuelCardNumber?: string | null
  fuelCardHistory?: unknown
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
  // The same rule the staff page uses, so phone and desktop show the same $/mi.
  return ratePerMile(trip.freightAmount, trip.miles)
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
  const weekCard = effectiveFuelCard(
    { fuelCardNumber: setting.fuelCardNumber, fuelCardHistory: parseJsonArray<FuelCardWindow>(setting.fuelCardHistory) },
    periodStart,
  )
  const rateModel = effectivePayRate(
    {
      payPercent: safeNumber(setting.payPercent),
      expensesBeforePercent: !!setting.expensesBeforePercent,
      rateHistory: parseJsonArray<PayRateOverride>(setting.rateHistory),
    },
    periodStart,
  )

  // A load with no POD cannot be invoiced, so it is held off the check — the same rule
  // the owner-operator settlement page applies. A trip with no factoring view at all is
  // unknown rather than POD-less, and unknown never holds anyone's pay.
  const today = new Date().toISOString().slice(0, 10)
  /*
   * Why each trip is off the check, or null when it is on it.
   *
   * Two reasons now, and the order matters: a load that has not been delivered yet is
   * NOT_DELIVERED even though it also has no POD, because "you have not run it" is the
   * true answer and "we need your POD" would be asking for paperwork that cannot exist.
   */
  const holdReasons = new Map<string, PayHoldReason>()
  for (const t of trips) {
    const undelivered = (t.shipmentDate ?? '').slice(0, 10) > today
    if (undelivered) { holdReasons.set(t.id, 'NOT_DELIVERED'); continue }
    const reason = tripHoldReason(
      {
        freightAmount: t.freightAmount,
        // No factoring view, or a POD store we could not read: both are unknown,
        // and unknown never holds pay.
        readiness:
          t.factoring && t.factoring.podKnown !== false
            ? { missingDocuments: t.factoring.podPresent ? [] : ['POD'] }
            : undefined,
      },
      { podsKnown: true },
    )
    if (reason) holdReasons.set(t.id, reason)
  }
  const heldTripIds = new Set(holdReasons.keys())

  const tripInputs = trips
    .filter((t) => !heldTripIds.has(t.id))
    .map((t) => ({ freightAmount: t.freightAmount, status: t.status }))

  const fixed = effectiveFixedExpenses(
    parseJsonArray<FixedExpenseInput>(setting.fixedExpenses),
    periodStart,
    end,
  )

  const fuel = sumFuel(
    matchedFuelForCard(
      fuelTransactions,
      // The card for THIS week — a swapped card must not re-match already-paid weeks.
      weekCard,
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
    ...(fuel > 0 ? [{ label: `Fuel (card ${weekCard ?? ''})`, amount: fuel }] : []),
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
    { ...(rateModel as DriverPaySettingInput), factoringFeePct: factoringFeePctFor(setting.payGroup) },
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
        freight: t.freightAmount,
        /*
         * The pay this load earns, ALWAYS — held or not.
         *
         * It used to be forced to $0 when held, so a driver with no POD on file could not
         * see what the load was worth at all. That is the number they most want, and
         * withholding it does not make the check any clearer: the row already says it is
         * not on this check, the check total already excludes it, and a driver who cannot
         * see their rate has to ring the office to ask.
         */
        amount: tripPayAmount(t.freightAmount, rateModel as DriverPaySettingInput),
        /** True only for the loads actually paid on this check — the totals use this. */
        onThisCheck: !heldTripIds.has(t.id),
        factoring: t.factoring ?? null,
        heldReason: holdReasons.get(t.id) ?? null,
        heldLabel: holdReasons.has(t.id) ? PAY_HOLD_LABEL[holdReasons.get(t.id)!] : null,
      })),
    grossPay: statement.gross,
    driverAmount: statement.driverAmount,
    payPercent: statement.payPercent,
    // What the totals leave out, named: the desktop footer says "excludes $X held for
    // POD", and a total that silently omits loads reads as money that does not exist.
    heldFreight: round2(trips.filter((t) => heldTripIds.has(t.id)).reduce((n, t) => n + (t.freightAmount ?? 0), 0)),
    // Where the fee applies it is always listed, even at $0 on a week with no loads: a
    // driver who never sees the line has no way to know the fee exists, and its absence
    // reads as an error. An Amazon driver's statement has no such line at all.
    deductions: [
      ...(statement.factoringFeePct > 0 ? [{ label: FACTORING_FEE_LABEL, amount: statement.factoringFee }] : []),
      ...deductionLines,
    ],
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
