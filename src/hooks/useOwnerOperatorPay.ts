import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  listLoads,
  listCustomers,
  listLocations,
  listDriverPaySettings,
  listDriverPayDeductions,
  listDriverPayCredits,
  createDriverPaySetting,
  updateDriverPaySetting,
  createDriverPayDeduction,
  deleteDriverPayDeduction,
  createDriverPayCredit,
  updateDriverPayCredit,
  deleteDriverPayCredit,
  type DriverPaySetting,
  type DriverPayDeduction,
  type DriverPayCredit,
  type DriverPayCreditInput,
  type FuelTransaction,
  listFactoringItems,
  type CustomerRecord,
  type LocationRecord,
} from '@/lib/apiClient'
import { listPods } from '@/lib/podsClient'
import { listDriverSubmissions } from '@/lib/driverSubmissionsClient'
import { buildPodIndex, podUploadedAt, type PodIndex, type PodSubmissionLike } from '@/lib/podPresence'
import { splitPayableTrips, type PayHoldReason } from '@/lib/payHold'
import type { ManualOverrides } from '@/lib/otrInvoice'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import {
  calcDriverPay,
  effectivePayRate,
  effectiveFixedExpenses,
  fixedExpenseLineLabel,
  type DriverPayStatement,
  type PayDeductionInput,
  type PayDebitInput,
} from '@/lib/driverPay'
import { creditLineLabel } from '@/lib/payCredits'
import { matchedFuelForCard, sumFuel } from '@/lib/driverFuel'
import { ownerOpTripsFor, ownerOpWeekAtOrAfterFirst, type OwnerOpTrip, isOwnerOperatorGroup } from '@/lib/ownerOperatorTrips'
import { otrSettlementReadiness } from '@/lib/otrSettlementFields'
import { duplicateTripIds as dupIdsForWeek } from '@/lib/tripDedup'
import type { Driver, Load } from '@/types'
import { classificationForFleet } from '@/lib/fileHub'
import { errorText } from '@/lib/errorText'

export type { DriverPaySetting, DriverPayDeduction, DriverPayCredit, DriverPayCreditInput, FuelTransaction }
export { ownerOpWeekAtOrAfterFirst }

export interface OwnerOperatorPayRow {
  driver: Driver
  setting: DriverPaySetting
  baseSetting: DriverPaySetting
  trips: OwnerOpTrip[]
  fuel: number
  fuelTxns: FuelTransaction[]
  deductions: PayDeductionInput[]
  oneOffs: DriverPayDeduction[]
  credits: DriverPayCredit[]
  debits: DriverPayCredit[]
  fixedDebits: PayDebitInput[]
  statement: DriverPayStatement
  /**
   * Loads delivered this week that are NOT in the statement, and why. Today the only
   * reason is a missing POD. They stay visible so nobody has to guess what is held.
   */
  heldTrips: Array<{ trip: OwnerOpTrip; reason: PayHoldReason }>
  /** Freight dollars sitting in `heldTrips`. */
  heldFreight: number
  /** Ids of this week's loads whose Load ID also settled last week (likely entered twice). */
  duplicateTripIds: Set<string>
}

export interface OwnerOperatorPayState {
  loading: boolean
  error: string | null
  /**
   * False when a POD store could not be read. Pay is then NOT held for a missing POD,
   * because an integration outage must never cost a week of drivers their money. The
   * page says so out loud rather than quietly paying loads it should have held.
   */
  podsKnown: boolean
  rows: OwnerOperatorPayRow[]
  unconfigured: Driver[]
  refresh: () => void
  saveSetting: (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>, expectedUpdatedAt: string | undefined) => Promise<void>
  addDeduction: (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  removeDeduction: (id: string) => Promise<void>
  addCredit: (input: DriverPayCreditInput) => Promise<void>
  updateCredit: (id: string, patch: Partial<DriverPayCreditInput>) => Promise<void>
  removeCredit: (id: string) => Promise<void>
}

function periodEnd(periodStart: string): string {
  const d = new Date(`${periodStart}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return d.toISOString().slice(0, 10)
}

/**
 * Every POD we know about, from both stores: the ones JobsDone received and a human
 * linked to a load, and the ones a driver scanned in the PWA or staff uploaded on their
 * behalf. See src/lib/podPresence.ts for why both have to count.
 *
 * `known` is false if EITHER store failed. A POD that exists in the half we could not
 * read looks identical to no POD at all, and that distinction now decides whether a
 * driver gets paid, so a partial read is treated as no knowledge.
 */
async function loadPodIndex(): Promise<{ index: PodIndex; known: boolean }> {
  const jobsdoneLoadIds: string[] = []
  let known = true

  try {
    let nextToken: string | null = null
    for (let attempt = 0; attempt < 100; attempt++) {
      const page = await listPods({ nextToken: nextToken ?? undefined })
      for (const doc of page.items) {
        if (doc.loadId) jobsdoneLoadIds.push(doc.loadId)
      }
      nextToken = page.nextToken ?? null
      if (!nextToken) break
    }
  } catch (err) {
    console.warn('[owner-operator-pay] could not read JobsDone PODs — no load will be held for a missing POD', err)
    known = false
  }

  let submissions: PodSubmissionLike[] = []
  try {
    submissions = (await listDriverSubmissions()).map((s) => ({
      loadId: s.loadId,
      referenceNumber: s.referenceNumber,
      hasPodDoc: s.docs.some((d) => d.kind === 'POD'),
      hasRateconDoc: s.docs.some((d) => d.kind === 'RATECON'),
      // Earliest POD page, so the column reads when the paperwork first landed.
      podUploadedAt: s.docs
        .filter((d) => d.kind === 'POD')
        .map((d) => d.uploadedAt)
        .sort()[0] ?? null,
    }))
  } catch (err) {
    console.warn('[owner-operator-pay] could not read driver submissions — no load will be held for a missing POD', err)
    known = false
  }

  return { index: buildPodIndex({ jobsdoneLoadIds, submissions }), known }
}

/**
 * Field values a human typed on a factoring queue row, keyed by the Load they belong
 * to. This is what makes a correction made in the queue appear on the settlement:
 * both pages then assemble the same load from the same inputs.
 */
async function loadManualOverrides(): Promise<Map<string, ManualOverrides>> {
  const byLoadId = new Map<string, ManualOverrides>()
  try {
    for (const item of await listFactoringItems()) {
      const loadId = (item.loadId ?? '').trim()
      const fields = item.otrManualFields
      if (!loadId || !fields || typeof fields !== 'object') continue
      byLoadId.set(loadId, fields as ManualOverrides)
    }
  } catch (err) {
    // Ancillary to the dollars: without it the settlement just shows the pre-correction
    // values, which is what it showed before this existed.
    console.warn('[owner-operator-pay] could not read factoring queue corrections', err)
  }
  return byLoadId
}

/**
 * Customers (for Broker MC) and Locations (for city/state/ZIP). Ancillary to the
 * settlement dollars, so a directory outage degrades readiness to "blocked" rather
 * than blanking a page that would otherwise pay drivers correctly.
 */
async function loadFactoringDirectory(): Promise<{ customers: CustomerRecord[]; locations: LocationRecord[] }> {
  try {
    const [customers, locations] = await Promise.all([
      listCustomers({ includeArchived: true }),
      listLocations({ includeArchived: true }),
    ])
    return { customers, locations }
  } catch (err) {
    console.warn('[owner-operator-pay] could not load customers/locations — factoring readiness will show those fields as missing', err)
    return { customers: [], locations: [] }
  }
}

export function useOwnerOperatorPay(rawPeriodStart: string): OwnerOperatorPayState {
  const periodStart = useMemo(() => ownerOpWeekAtOrAfterFirst(rawPeriodStart), [rawPeriodStart])
  const { drivers, updateDriver } = useDrivers()
  const { transactions: fuelTxs } = useFuelTransactions()

  const [loads, setLoads] = useState<Load[]>([])
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [locations, setLocations] = useState<LocationRecord[]>([])
  const [podIndex, setPodIndex] = useState<PodIndex>(() => buildPodIndex({ jobsdoneLoadIds: [], submissions: [] }))
  // Starts false: until the PODs have actually been read we know nothing, and holding
  // pay on no knowledge is the one outcome worth ruling out by construction.
  const [podsKnown, setPodsKnown] = useState(false)
  const [manualByLoadId, setManualByLoadId] = useState<Map<string, ManualOverrides>>(new Map())
  const [settings, setSettings] = useState<DriverPaySetting[]>([])
  const [deductions, setDeductions] = useState<DriverPayDeduction[]>([])
  const [credits, setCredits] = useState<DriverPayCredit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const end = periodEnd(periodStart)
  // The week before this one — where a load entered twice would already have paid out.
  const prevStart = useMemo(() => {
    const d = new Date(`${periodStart}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 7)
    return d.toISOString().slice(0, 10)
  }, [periodStart])

  const load = useCallback(() =>
    Promise.all([
      listLoads(),
      loadFactoringDirectory(),
      listDriverPaySettings(),
      listDriverPayDeductions(),
      listDriverPayCredits(),
      loadPodIndex(),
      loadManualOverrides(),
    ])
      .then(([l, dir, s, d, creds, pods, manual]) => {
        setLoads(l)
        setCustomers(dir.customers)
        setLocations(dir.locations)
        setSettings(s)
        setDeductions(d)
        setCredits(creds)
        setPodIndex(pods.index)
        setPodsKnown(pods.known)
        setManualByLoadId(manual)
        setError(null)
      })
      .catch((err: unknown) => {
        // Logged as well as shown: the message a person can read is rarely the whole shape,
        // and this page failing means nobody can be paid from it.
        console.error('[owner-operator-pay] could not load the week', err)
        setError(errorText(err, 'Could not load this week — reload, or tell Ryne what this says'))
      })
      .finally(() => setLoading(false)),
  [])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { void load() }, [load])

  const rows = useMemo<OwnerOperatorPayRow[]>(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    const customersById = new Map(customers.map((c) => [c.id, c]))
    const locationsById = new Map(locations.map((l) => [l.id, l]))
    const loadsById = new Map(loads.map((l) => [l.id, l]))
    return settings
      .filter((s) => isOwnerOperatorGroup(s.payGroup) && s.active !== false)
      .map((baseSetting): OwnerOperatorPayRow | null => {
        const setting: DriverPaySetting = { ...baseSetting, ...effectivePayRate(baseSetting, periodStart) }
        const driver = driverById.get(setting.driverId)
        // 'BROKER COVERED' and friends are pseudo-drivers that carry real loads; paying
        // one would cut a cheque to nobody. Same guard the box-truck hook uses.
        if (!driver || driver.type === 'broker') return null

        const driverTrips = ownerOpTripsFor(loads, setting.driverId, periodStart)
        const tripsWithReadiness = driverTrips.map((trip) => {
          const load = loadsById.get(trip.id)
          if (!load) return trip
          return {
            ...trip,
            // When the POD landed, so the column can say more than "present".
            podUploadedAt: podUploadedAt(podIndex, load),
            readiness: otrSettlementReadiness({
              load,
              customersById,
              locationsById,
              podIndex,
              manual: manualByLoadId.get(load.id) ?? null,
            }),
          }
        })
        // Same guard the Amazon statement uses: a reference that already paid out last
        // week is flagged, never dropped, because only a human knows a real repeat.
        const duplicateTripIds = dupIdsForWeek(tripsWithReadiness, ownerOpTripsFor(loads, setting.driverId, prevStart))

        // The weekly charges — fixed expenses, the fuel card, one-off deductions — are
        // per driver-week, not per page, so exactly ONE statement carries them. The
        // boundary is a fixed date: through Amazon's last week they stay on the Amazon
        // statement and move here afterwards. periodStart is clamped to the first
        // owner-operator week above, so every week rendered here owns its charges.
        const fuelTxns = matchedFuelForCard(fuelTxs, setting.fuelCardNumber, periodStart, end)
        const fuel = sumFuel(fuelTxns)

        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)

        const fixed = effectiveFixedExpenses(setting.fixedExpenses, periodStart, end)
        const fixedDebits: PayDebitInput[] = fixed
          .filter((f) => f.afterPercent)
          .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))

        const ded: PayDeductionInput[] = [
          ...fixed.filter((f) => !f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
          ...(fuel > 0 ? [{ label: `Fuel (card ${setting.fuelCardNumber})`, amount: fuel }] : []),
          ...oneOffs.map((o) => ({ label: o.label, amount: o.amount })),
        ]

        const mine = credits
          .filter((c) => c.driverId === setting.driverId && c.periodStart === periodStart)
          .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.createdAt.localeCompare(b.createdAt))
        const driverCredits = mine.filter((c) => (c.kind ?? 'CREDIT') === 'CREDIT')
        const driverDebits = mine.filter((c) => c.kind === 'DEBIT')

        // A POD is what lets a load be invoiced, so a load without one is held off this
        // week's check rather than paid ahead of the money coming in. It stays on the
        // page, and it pays itself the moment the POD lands, because the settlement is
        // recomputed from current data every time it is opened.
        const { payable, held, heldFreight } = splitPayableTrips(tripsWithReadiness, { podsKnown })

        const statement = calcDriverPay(
          payable.map((t) => ({ freightAmount: t.freightAmount })),
          setting,
          ded,
          driverCredits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode })),
          [...fixedDebits, ...driverDebits.map((c) => ({ label: creditLineLabel(c), amount: c.amount, reasonCode: c.reasonCode }))],
        )

        return { driver, setting, baseSetting, trips: tripsWithReadiness, fuel, fuelTxns, deductions: ded, oneOffs, credits: driverCredits, debits: driverDebits, fixedDebits, statement, heldTrips: held, heldFreight, duplicateTripIds }
      })
      .filter((r): r is OwnerOperatorPayRow => r !== null)
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [settings, drivers, loads, customers, locations, podIndex, podsKnown, manualByLoadId, deductions, credits, fuelTxs, periodStart, prevStart, end])

  const unconfigured = useMemo(() => {
    const configured = new Set(
      settings.filter((s) => isOwnerOperatorGroup(s.payGroup)).map((s) => s.driverId),
    )
    return drivers.filter(
      (d) => d.active !== false && d.type !== 'broker'
        && (classificationForFleet(d.fleetGroup) === 'OWNER_OPERATOR' || d.driverType === 'OWNER_OPERATOR') && !configured.has(d.id),
    )
  }, [drivers, settings])

  const saveSetting = useCallback(async (driverId: string, patch: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt' | 'driverId'>, expectedUpdatedAt: string | undefined) => {
    const existing = settings.find((s) => s.driverId === driverId && isOwnerOperatorGroup(s.payGroup))
    if (existing) {
      // Keep whatever group the driver is already on. An Amazon driver edited here must
      // STAY on AMAZON, or their whole Amazon settlement history disappears from that page.
      const { payGroup: _ignored, ...rest } = patch
      const updated = await updateDriverPaySetting(existing.id, rest, expectedUpdatedAt ?? '')
      setSettings((p) => p.map((s) => s.id === existing.id ? updated : s))
    } else {
      const created = await createDriverPaySetting({ driverId, ...patch, payGroup: 'OWNER_OPERATOR' })
      setSettings((p) => [...p, created])
    }

    const driver = drivers.find((d) => d.id === driverId)
    if (patch.email?.trim() && driver && !driver.email?.trim()) {
      try {
        await updateDriver(driverId, { email: patch.email.trim() })
      } catch (err) {
        console.error('[owner-operator-pay] could not mirror the email onto the driver', err)
      }
    }
  }, [settings, drivers, updateDriver])

  const addDeduction = useCallback(async (input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>) => {
    const created = await createDriverPayDeduction(input)
    setDeductions((p) => [...p, created])
  }, [])

  const removeDeduction = useCallback(async (id: string) => {
    await deleteDriverPayDeduction(id)
    setDeductions((p) => p.filter((d) => d.id !== id))
  }, [])

  const addCredit = useCallback(async (input: DriverPayCreditInput) => {
    const created = await createDriverPayCredit(input)
    setCredits((p) => [...p, created])
  }, [])

  const updateCredit = useCallback(async (id: string, patch: Partial<DriverPayCreditInput>) => {
    const updated = await updateDriverPayCredit(id, patch)
    setCredits((p) => p.map((c) => c.id === id ? updated : c))
  }, [])

  const removeCredit = useCallback(async (id: string) => {
    await deleteDriverPayCredit(id)
    setCredits((p) => p.filter((c) => c.id !== id))
  }, [])

  return {
    loading, error, podsKnown, rows, unconfigured, refresh,
    saveSetting, addDeduction, removeDeduction,
    addCredit, updateCredit, removeCredit,
  }
}
