import { useState, useEffect, useCallback, useMemo } from 'react'
import {
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
  listShipmentDocuments,
  type CustomerRecord,
  type LocationRecord,
} from '@/lib/apiClient'
import { listPods } from '@/lib/podsClient'
import { listDriverSubmissions } from '@/lib/driverSubmissionsClient'
import { buildPodIndex, podUploadedAt, type PodIndex, type PodSubmissionLike } from '@/lib/podPresence'
import { shipmentDocPresence } from '@/lib/shipmentDocPresence'
import { getStops } from '@/lib/stops'
import { splitPayableTrips, type PayHoldReason } from '@/lib/payHold'
import type { ManualOverrides } from '@/lib/otrInvoice'
import { useFuelTransactions } from './useFuelTransactions'
import { useDrivers } from './useDrivers'
import { useLoads, useEnsureLoadRange } from './useLoads'
import {
  calcDriverPay,
  effectivePayRate,
  onOwnerOperatorStatement,
  ownerOpServiceDays,
  hasOwnerOpService,
  effectiveFixedExpenses,
  fixedExpenseLineLabel,
  type DriverPayStatement,
  type PayDeductionInput,
  type PayDebitInput,
} from '@/lib/driverPay'
import { creditLineLabel } from '@/lib/payCredits'
import { matchedFuelForCard, sumFuel, effectiveFuelCard } from '@/lib/driverFuel'
import { ownerOpTripsFor, ownerOpWeekAtOrAfterFirst, ownerOpStartDate, ownerOpOnPayroll, ownerOpBeforeEnd, ownerOpWeekFrom, type OwnerOpTrip, isOwnerOperatorGroup, settlementStopDates } from '@/lib/ownerOperatorTrips'
import { otrSettlementReadiness } from '@/lib/otrSettlementFields'
import { duplicateTripIds as dupIdsForWeek } from '@/lib/tripDedup'
import type { Driver } from '@/types'
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
  /** First day they are on this page (the day chosen when switched to owner operator, else hire date, else setup date for a driver added without one), or null when there is no limit. */
  startsOn: string | null
  /** Last day they are on this page, set when they were switched away from owner operator, or null. */
  endsOn: string | null
  /** No hire date on the driver's file: the page says so rather than hiding the driver. */
  noHireDate: boolean
  /**
   * An owner operator who has no pay setting yet. They are listed from their hire date at 0% so nothing can be paid by mistake, until
   * someone sets their pay terms (Settings on the statement).
   */
  payTermsPending: boolean
}

/** What a driver with no pay setting is listed with: owner operator, 0%, nothing saved. Never written anywhere. */
function pendingSetting(driver: Driver): DriverPaySetting {
  return {
    id: `pending:${driver.id}`, driverId: driver.id, payGroup: 'OWNER_OPERATOR', payPercent: 0, expensesBeforePercent: false,
    email: null, fuelCardNumber: null, fixedExpenses: [], active: true, notes: null,
    createdAt: driver.createdAt, updatedAt: driver.createdAt,
  }
}

/** Active owner operators (by fleet or driver type) with no owner-operator pay setting yet. */
function ownerOperatorsWithoutSetting(drivers: Driver[], settings: DriverPaySetting[]): Driver[] {
  const configured = new Set(settings.filter((s) => isOwnerOperatorGroup(s.payGroup) || hasOwnerOpService(s)).map((s) => s.driverId))
  return drivers.filter(
    (d) => d.active !== false && d.type !== 'broker'
      && (classificationForFleet(d.fleetGroup) === 'OWNER_OPERATOR' || d.driverType === 'OWNER_OPERATOR') && !configured.has(d.id),
  )
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
async function loadPodIndex(): Promise<{ inputs: PodInputs; known: boolean }> {
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

  return { inputs: { jobsdoneLoadIds, submissions }, known }
}

interface PodInputs { jobsdoneLoadIds: string[]; submissions: PodSubmissionLike[] }

/**
 * The POD and rate-con status the shipment page shows, as POD-index entries for each load:
 * a document filed on the shipment counts on the settlement too. Read per shipment, for
 * the week's loads only. A shipment whose documents cannot be read adds nothing; the
 * driver and JobsDone stores still answer for it.
 */
async function loadShipmentDocSubmissions(loadsByShipment: Map<string, string[]>): Promise<PodSubmissionLike[]> {
  const out: PodSubmissionLike[] = []
  await Promise.all([...loadsByShipment].map(async ([shipmentId, loadIds]) => {
    try {
      const docs = await listShipmentDocuments(shipmentId)
      for (const loadId of loadIds) {
        const p = shipmentDocPresence(docs, loadId)
        if (p.pod || p.ratecon) out.push({ loadId, hasPodDoc: p.pod, hasRateconDoc: p.ratecon, podUploadedAt: p.podUploadedAt })
      }
    } catch (err) {
      console.warn('[owner-operator-pay] could not read shipment documents for', shipmentId, err)
    }
  }))
  return out
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

  const { loads } = useLoads()
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [locations, setLocations] = useState<LocationRecord[]>([])
  const [podInputs, setPodInputs] = useState<PodInputs>({ jobsdoneLoadIds: [], submissions: [] })
  const [shipmentDocSubs, setShipmentDocSubs] = useState<PodSubmissionLike[]>([])
  const podIndex = useMemo<PodIndex>(
    () => buildPodIndex({ jobsdoneLoadIds: podInputs.jobsdoneLoadIds, submissions: [...podInputs.submissions, ...shipmentDocSubs] }),
    [podInputs, shipmentDocSubs],
  )
  // Starts false: until the PODs have actually been read we know nothing, and holding
  // pay on no knowledge is the one outcome worth ruling out by construction.
  const [podsKnown, setPodsKnown] = useState(false)
  const [manualByLoadId, setManualByLoadId] = useState<Map<string, ManualOverrides>>(new Map())
  const [settings, setSettings] = useState<DriverPaySetting[]>([])
  // False until the pay settings have been read: before that every owner operator looks like one with no setting.
  const [settingsRead, setSettingsRead] = useState(false)
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
  const ready = useEnsureLoadRange(prevStart, end)

  const load = useCallback(() =>
    Promise.all([
      loadFactoringDirectory(),
      listDriverPaySettings(),
      listDriverPayDeductions(),
      listDriverPayCredits(),
      loadPodIndex(),
      loadManualOverrides(),
    ])
      .then(([dir, s, d, creds, pods, manual]) => {
        setCustomers(dir.customers)
        setLocations(dir.locations)
        setSettings(s)
        setSettingsRead(true)
        setDeductions(d)
        setCredits(creds)
        setPodInputs(pods.inputs)
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
  const [docsVersion, setDocsVersion] = useState(0)
  const refresh = useCallback(() => { setLoading(true); setDocsVersion((v) => v + 1); return load() }, [load])

  useEffect(() => { void load() }, [load])

  // The shipment page's Documents, for the loads this week and last week can settle.
  const shipmentKey = useMemo(() => {
    const byShipment = new Map<string, string[]>()
    for (const l of loads) {
      if (!l.shipmentId) continue
      const day = (l.deliveryAppt ?? '').slice(0, 10)
      if (day < prevStart || day > end) continue
      byShipment.set(l.shipmentId, [...(byShipment.get(l.shipmentId) ?? []), l.id])
    }
    return JSON.stringify([...byShipment].sort())
  }, [loads, prevStart, end])
  useEffect(() => {
    let live = true
    const byShipment = new Map<string, string[]>(JSON.parse(shipmentKey) as [string, string[]][])
    void loadShipmentDocSubmissions(byShipment).then((subs) => { if (live) setShipmentDocSubs(subs) })
    return () => { live = false }
  }, [shipmentKey, docsVersion])

  const rows = useMemo<OwnerOperatorPayRow[]>(() => {
    const driverById = new Map(drivers.map((d) => [d.id, d]))
    const customersById = new Map(customers.map((c) => [c.id, c]))
    const locationsById = new Map(locations.map((l) => [l.id, l]))
    const loadsById = new Map(loads.map((l) => [l.id, l]))
    // An owner operator with no pay setting yet is listed too (at 0%), so setting a driver up as an owner operator is all it takes to
    // see them here; the hire date below decides which weeks.
    const entries: Array<{ baseSetting: DriverPaySetting; pending: boolean }> = [
      ...settings
        // A week pinned to Amazon mode settles on the Amazon page; a week pinned to standard owner operator settles here even for a legacy
        // Amazon-group driver. Unpinned weeks follow the pay group exactly as before.
        .filter((s) => onOwnerOperatorStatement(s, periodStart) && s.active !== false)
        .map((baseSetting) => ({ baseSetting, pending: false })),
      ...(settingsRead ? ownerOperatorsWithoutSetting(drivers, settings) : []).map((d) => ({ baseSetting: pendingSetting(d), pending: true })),
    ]
    return entries
      .map(({ baseSetting, pending }): OwnerOperatorPayRow | null => {
        const setting: DriverPaySetting = { ...baseSetting, ...effectivePayRate(baseSetting, periodStart) }
        const driver = driverById.get(setting.driverId)
        // 'BROKER COVERED' and friends are pseudo-drivers that carry real loads; paying
        // one would cut a cheque to nobody. Same guard the box-truck hook uses.
        if (!driver || driver.type === 'broker') return null

        // From the hire date: earlier weeks are not theirs, the week holding it counts from that day, and loads delivered before it are
        // left out. With no hire date a driver who already settles keeps every week; one added without a setting starts the day they
        // were set up. Either way they stay listed and the page says the hire date is missing.
        // The day chosen when they were switched to (or from) owner operator wins over the hire date.
        const service = ownerOpServiceDays(baseSetting)
        const hire = ownerOpStartDate(driver.hireDate)
        const startsOn = service.from ?? hire ?? (pending ? ownerOpStartDate(driver.createdAt) : null)
        const endsOn = service.to
        if (!ownerOpOnPayroll(startsOn, periodStart) || !ownerOpBeforeEnd(endsOn, periodStart)) return null
        const weekFrom = ownerOpWeekFrom(startsOn, periodStart)
        const weekTo = endsOn && endsOn < end ? endsOn : end

        const driverTrips = ownerOpTripsFor(loads, setting.driverId, periodStart, startsOn, endsOn)
        const tripsWithReadiness = driverTrips.map((trip) => {
          const load = loadsById.get(trip.id)
          if (!load) return trip
          return {
            ...trip,
            // When the POD landed, so the column can say more than "present".
            podUploadedAt: podUploadedAt(podIndex, load),
            dates: settlementStopDates(getStops(load), (load as { deliveredAt?: string | null }).deliveredAt),
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
        const duplicateTripIds = dupIdsForWeek(tripsWithReadiness, ownerOpTripsFor(loads, setting.driverId, prevStart, startsOn, endsOn))

        // The weekly charges — fixed expenses, the fuel card, one-off deductions — are
        // per driver-week, not per page, so exactly ONE statement carries them. The
        // boundary is a fixed date: through Amazon's last week they stay on the Amazon
        // statement and move here afterwards. periodStart is clamped to the first
        // owner-operator week above, so every week rendered here owns its charges.
        const fuelTxns = matchedFuelForCard(fuelTxs, effectiveFuelCard(setting, periodStart), weekFrom, weekTo)
        const fuel = sumFuel(fuelTxns)

        const oneOffs = deductions.filter((x) => x.driverId === setting.driverId && x.periodStart === periodStart)

        // A hire inside the week prorates the weekly charges from that day, the way a charge that starts mid-week already is.
        const dayAfter = (day: string) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }
        const clipped = weekFrom > periodStart || weekTo < end
        const fixedFor = clipped
          ? (setting.fixedExpenses ?? []).map((f) => ({
            ...f,
            from: f.from && f.from > weekFrom ? f.from : weekFrom,
            until: weekTo < end && (!f.until || f.until > dayAfter(weekTo)) ? dayAfter(weekTo) : f.until,
          }))
          : setting.fixedExpenses
        const fixed = effectiveFixedExpenses(fixedFor, periodStart, end)
        const fixedDebits: PayDebitInput[] = fixed
          .filter((f) => f.afterPercent)
          .map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount }))

        const ded: PayDeductionInput[] = [
          ...fixed.filter((f) => !f.afterPercent).map((f) => ({ label: fixedExpenseLineLabel(f), amount: f.amount })),
          ...(fuel > 0 ? [{ label: `Fuel (card ${effectiveFuelCard(setting, periodStart) ?? ''})`, amount: fuel }] : []),
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

        return { driver, setting, baseSetting, trips: tripsWithReadiness, fuel, fuelTxns, deductions: ded, oneOffs, credits: driverCredits, debits: driverDebits, fixedDebits, statement, heldTrips: held, heldFreight, duplicateTripIds, startsOn, endsOn, noHireDate: hire == null && service.from == null, payTermsPending: pending }
      })
      .filter((r): r is OwnerOperatorPayRow => r !== null)
      .sort((a, b) => a.driver.name.localeCompare(b.driver.name))
  }, [settings, settingsRead, drivers, loads, customers, locations, podIndex, podsKnown, manualByLoadId, deductions, credits, fuelTxs, periodStart, prevStart, end])

  // Owner operators with no setting who are not listed this week (their hire date is later): shown as the set-up chips, as before.
  const unconfigured = useMemo(() => {
    const listed = new Set(rows.map((r) => r.driver.id))
    return settingsRead ? ownerOperatorsWithoutSetting(drivers, settings).filter((d) => !listed.has(d.id)) : []
  }, [drivers, settings, settingsRead, rows])

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
    loading: loading || !ready, error, podsKnown, rows, unconfigured, refresh,
    saveSetting, addDeduction, removeDeduction,
    addCredit, updateCredit, removeCredit,
  }
}
