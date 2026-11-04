/**
 * The per-PRO aggregate: one pure function turns a staged row into the FINAL state of every record the
 * PRO owns (Shipment, Order, Load, LoadFinancials, LoadCharge, LoadCarrier, Invoice, CarrierBill,
 * ProClaim, LegacyAljexRow) as a single transaction. Nothing here reads a table; the caller supplies
 * the resolved masters. Load rows are inserted once, complete, and never updated (plan §2.6).
 */
import { ALJEX_FEE_CHARGE_CODES, ALJEX_REFERENCE_CODES, type EngineRow, type LegacyFields, type TxItem } from '../../../../src/types/tms'
import type { Stop } from '../../../../src/types'
import type { CanonicalRow, CanonicalStop } from '../../../../src/lib/aljex/canonical'
import { classifyCharge, classifyProjected } from '../../../../src/lib/aljex/charges'
import type { MemoAdjustment, MemoOrphan } from '../../../../src/lib/aljex/memos'
import { chicagoDateTimeIso, chicagoMidnightIso, isPlausibleDate, noonUtcIso, addDays, type DateWindow } from '../../../../src/lib/aljex/dates'
import { normalizeLabel, type AljexProfile } from '../../../../src/lib/aljex/profile'
import { dueDate, resolveTermsDays } from '../../../../src/lib/aljex/terms'
import { deriveLegacyFields } from '../../../../src/lib/stops'
import { adjustmentLines, invoiceMath, memoNet, type InvoiceMath } from './memos'
import { resolveStopLocation, type CarrierRef, type CustomerLookup, type LocationMaps } from './directory'
import { rowFacts, type ApFacts, type RowFacts } from './facts'
import { IMPORT_ACTOR } from './types'
import { compact, compactText, monthOf, stableId } from './util'

export interface DriverRoster {
  /** normalized name -> active, non-placeholder driver ids */
  byName: Map<string, string[]>
}

export interface LoadEnv {
  runId: string
  stageHash: string
  profile: AljexProfile
  window: DateWindow
  customers: CustomerLookup
  /** aljexCode -> directory carrier (selected carriers only; absent = snapshot leg). */
  carriers: Map<string, CarrierRef>
  locations: LocationMaps
  settings: { defaultPaymentTermsDays: number | null; defaultCarrierTermsDays: number | null }
  factoringIds: Set<string>
  drivers: DriverRoster
  /** Invoice PRO key -> the CRED/DEBT memo lines on that invoice (DECIDED-1). */
  memos: Record<string, MemoAdjustment[]>
  /** Memo PRO -> why it is not applied. */
  memoOrphans: Map<string, MemoOrphan>
  /** Invoice ids already on the target: id -> orderId. Decides `id = PRO` vs the `ALJ-<pro>` fallback. */
  invoiceOwners: Map<string, string>
  /** Valid-for-this-run tag shown in notes (never a date). */
  actor: string
}

export interface RowIds {
  key: string
  shipmentId: string
  orderId: string
  loadId: string
  loadCarrierId: string
  billId: string
  invoiceId: string
}

export function rowIds(row: CanonicalRow, invoiceOwners?: Map<string, string>): RowIds {
  const key = `aljex:${row.proKey}`
  const orderId = stableId('ord', key)
  const loadCarrierId = stableId('lcr', key)
  let invoiceId = row.pro
  const owner = invoiceOwners?.get(invoiceId)
  if (owner !== undefined && owner !== orderId) invoiceId = `ALJ-${row.pro}`
  return { key, shipmentId: stableId('shp', key), orderId, loadId: stableId('lod', key), loadCarrierId, billId: `cb:${loadCarrierId}:1`, invoiceId }
}

const LEGACY: LegacyFields = { legacyImported: true, legacySource: 'ALJEX' }

/** ISO appointment for a date (+ optional local time). Date-only is Chicago midnight (app convention, plan D3). */
function apptIso(date: string, time: string | null): string {
  return time ? chicagoDateTimeIso(date, time) : chicagoMidnightIso(date)
}

function cityState(s: Pick<CanonicalStop, 'city' | 'state'>): string {
  return [s.city, s.state].filter(Boolean).join(', ')
}

interface BuiltStops {
  stops: Stop[]
  /** Warnings produced while shaping. */
  notes: string[]
}

function buildStopsJson(row: CanonicalRow, facts: RowFacts, env: LoadEnv): BuiltStops {
  const stops: Stop[] = []
  row.stops.forEach((s, i) => {
    let date = s.apptDate
    if (!date && i === 0 && s.type === 'pickup') date = facts.pickupDate
    const hasTime = Boolean(date && s.apptTime)
    const end = s.apptEndDate && date ? chicagoMidnightIso(s.apptEndDate) : undefined
    const apptType: Stop['apptType'] = !date ? 'tbd' : end && s.apptEndDate! > date ? 'range' : hasTime ? 'exact' : 'tbd'
    const locationId = resolveStopLocation(env.locations, s)
    const refs = s.ref ? [{ code: 'STOP_REF', value: s.ref, level: 'STOP' as const, visibility: 'ALL' as const }] : undefined
    const address = compactText({ street: s.street, city: s.city, state: s.state, zip: s.zip, country: 'US' })
    const stop: Stop = {
      id: `stp-${row.proKey}-${i}`,
      type: s.type,
      locationId: locationId ?? null,
      address: Object.keys(address).length > 1 ? address : null,
      appt: date ? apptIso(date, s.apptTime) : '',
      apptType,
      driverId: null,
      sequence: i,
    }
    if (s.name) stop.name = s.name
    if (cityState(s)) stop.city = cityState(s)
    if (apptType === 'range' && end) stop.apptEnd = end
    if (refs) stop.refs = refs
    stops.push(stop)
  })
  return { stops, notes: [] }
}

/** Free-text carrier driver cell -> driver name / phone. Phone-shaped values are phones. */
export function splitDriverText(text: string): { name?: string; phone?: string } {
  const t = text.trim()
  if (!t) return {}
  const digits = t.replace(/\D/g, '')
  return /^[\d\s().+-]+$/.test(t) && digits.length >= 7 ? { phone: t } : { name: t }
}

function parsePieces(commodity: string): number | undefined {
  const m = /\b(\d{1,5})\s*(?:PALLETS?|PLTS?|SKIDS?)\b/i.exec(commodity)
  return m ? Number(m[1]) : undefined
}

export interface AggregateResult {
  ids: RowIds
  items: TxItem[]
  facts: RowFacts
  /** Findings to report (codes only; no cell values). */
  findings: Array<{ code: string; detail?: string }>
  invoice: boolean
  bill: boolean
  customerUnresolved: boolean
  /** Memo rows only: the memo became an adjustment line on an invoice (false = orphan, reported). */
  memoApplied?: boolean
}

function revFields(facts: RowFacts, env: LoadEnv): EngineRow {
  const code = facts.division
  const top = code === 'OWNER_OPERATOR' ? 'ASSETS' : code
  return { revDivision: top, ...(code === top ? {} : { revSubdivision: code }), revTagSource: 'RULE', revRuleId: env.actor }
}

export function refsFor(row: CanonicalRow, facts: RowFacts): EngineRow[] {
  const out: EngineRow[] = []
  const seen = new Set<string>()
  const add = (code: string, value: string, visibility: 'ALL' | 'INTERNAL', label?: string) => {
    const v = value.trim()
    if (!v) return
    const k = `${code}|${v}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ code, ...(label ? { label } : {}), value: v, level: 'ORDER', visibility })
  }
  const C = ALJEX_REFERENCE_CODES
  add(C.customerRef, row.customerRefNo || row.referenceNo, 'ALL', 'Customer ref')
  if (row.referenceNo && row.referenceNo !== row.customerRefNo) add('REFERENCE', row.referenceNo, 'ALL', 'Reference #')
  add(C.quote, row.quoteNo, 'ALL', 'Quote #')
  add(C.manifest, row.manifest, 'ALL', 'Manifest')
  add(C.container, row.containerNo, 'ALL', 'Container #')
  add(C.pickupRef, row.pickupRefNo, 'ALL', 'Pickup ref')
  add(C.consigneeRef, row.consigneeRefNo, 'ALL', 'Consignee ref')
  row.additionalRefs.forEach((r, i) => add(`${C.additionalPrefix}${i + 1}`, r, 'ALL', `Additional ref ${i + 1}`))
  add(C.typeOfShipment, row.typeOfShipment, 'INTERNAL', 'Aljex shipment type')
  add(C.revenueType, row.freight.revenueType, 'INTERNAL', 'Aljex revenue type')
  if (facts.tonu) add('ALJEX_TONU', 'Y', 'INTERNAL', 'Aljex TONU')
  // Flags with no field of their own: kept as internal references so nothing the export said is lost.
  if (row.freight.labor) add('ALJEX_LABOR', 'Y', 'INTERNAL', 'Aljex labor')
  if (row.freight.highRisk) add('ALJEX_HIGH_RISK', 'Y', 'INTERNAL', 'Aljex high risk')
  if (row.freight.smartway) add('ALJEX_SMARTWAY', 'Y', 'INTERNAL', 'Aljex SmartWay')
  if (row.freight.pltExchange) add('ALJEX_PALLET_EXCHANGE', 'Y', 'INTERNAL', 'Aljex pallet exchange')
  add('ALJEX_TARP_SIZE', row.freight.tarpSize, 'INTERNAL', 'Aljex tarp size')
  return out
}

function searchKey(row: CanonicalRow, cities: string[], extra: string[] = []): string {
  return [row.pro, row.customer.name, ...cities, row.referenceNo, row.customerRefNo, row.pickupRefNo, row.consigneeRefNo, ...extra]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** Deterministic instant for a record's date: the day at noon UTC, falling back to the window start. */
function stamp(date: string | null | undefined, env: LoadEnv): string {
  return noonUtcIso(date && isPlausibleDate(date, env.window) ? date : env.window.start)
}

export function buildLoadAggregate(row: CanonicalRow, env: LoadEnv): AggregateResult {
  const { profile, window } = env
  const facts = rowFacts(row, profile, window)
  const ids = rowIds(row, env.invoiceOwners)
  const findings: AggregateResult['findings'] = []
  const note = (code: string, detail?: string) => findings.push(detail ? { code, detail } : { code })

  const customerId = row.customer.account ? env.customers.byAccount.get(row.customer.account) : undefined
  const customerUnresolved = !customerId
  if (customerUnresolved) note('NO_CUSTOMER')
  const built = buildStopsJson(row, facts, env)
  const stops = built.stops
  const legacy = stops.length > 0 ? deriveLegacyFields(stops) : null
  const pickupAppt = legacy?.pickupAppt ?? ''
  const deliveryAppt = legacy?.deliveryAppt ?? ''
  const originCity = row.stops.find((s) => s.type === 'pickup')?.city ?? ''
  const destCity = [...row.stops].reverse().find((s) => s.type === 'delivery')?.city ?? ''

  // ── charges ──────────────────────────────────────────────────────────────────────────────
  const customerCharges: EngineRow[] = []
  const notes: string[] = []
  let chargeSum = 0
  for (const c of row.charges) {
    const cl = classifyCharge(c, profile)
    if (cl.kind === 'NOTE') {
      notes.push(cl.label)
      continue
    }
    if (cl.kind === 'SKIP') continue
    chargeSum += cl.amountCents
    customerCharges.push({
      id: stableId('chg', `${ids.key}:C:${c.line}`),
      shipmentId: ids.shipmentId,
      side: 'CUSTOMER',
      orderId: ids.orderId,
      loadId: ids.loadId,
      code: cl.code,
      label: cl.label,
      calculatedBy: 'FLAT',
      rateCents: cl.rateCents ?? cl.amountCents,
      count: cl.rateCents != null ? cl.count : 1,
      amountCents: cl.amountCents,
      isRate: cl.isRate,
      sortOrder: c.line - 1,
      createdBy: IMPORT_ACTOR,
    })
  }
  if (chargeSum !== row.money.invoiceAmountCents) note('CHARGE_SUM_MISMATCH')
  const lhCents = row.charges.find((c) => c.line === 1)?.extensionCents ?? row.money.lhRevenueCents
  const revenueCents = row.money.invoiceAmountCents

  // ── carrier leg ──────────────────────────────────────────────────────────────────────────
  const carrierRef = row.carrier?.id ? env.carriers.get(row.carrier.id) : undefined
  const isIvan = facts.ownAsset
  const hasCarrier = row.carrier != null && !facts.isVoid
  const assignmentType = isIvan ? 'OWN_ASSET' : hasCarrier ? 'CARRIER' : 'NEED_TO_COVER'
  const carrierCharges: EngineRow[] = []
  let carrierRateCents = 0
  let costCents = 0
  if (hasCarrier && !isIvan) {
    row.projectedExpenses.forEach((p) => {
      if (p.amountCents === 0) return
      const pc = classifyProjected(p, profile)
      costCents += p.amountCents
      if (p.n === 1) carrierRateCents = p.amountCents
      carrierCharges.push({
        id: stableId('chg', `${ids.key}:K:${p.n}`),
        shipmentId: ids.shipmentId,
        side: 'CARRIER',
        loadId: ids.loadId,
        loadCarrierId: ids.loadCarrierId,
        code: pc.code,
        label: pc.label,
        calculatedBy: 'FLAT',
        rateCents: p.amountCents,
        count: 1,
        amountCents: p.amountCents,
        isRate: pc.isRate,
        sortOrder: 100 + p.n,
        createdBy: IMPORT_ACTOR,
      })
    })
    if (row.projectedExpenses.length === 0) {
      costCents = row.money.projectedCarrierExpenseCents
      carrierRateCents = row.money.carrierLhCents
    }
    for (const f of carrierFeeLines(row)) {
      carrierCharges.push({
        id: stableId('chg', `${ids.key}:K:${f.code}`),
        shipmentId: ids.shipmentId,
        side: 'CARRIER',
        loadId: ids.loadId,
        loadCarrierId: ids.loadCarrierId,
        code: f.code,
        label: f.label,
        calculatedBy: 'FLAT',
        rateCents: f.cents,
        count: 1,
        amountCents: f.cents,
        isRate: false,
        sortOrder: f.sortOrder,
        createdBy: IMPORT_ACTOR,
      })
    }
  } else if (carrierFeeLines(row).length > 0) {
    note('FEE_NOT_WRITTEN', 'no carrier leg')
  }
  const profitCents = revenueCents - costCents
  const marginBps = revenueCents !== 0 ? Math.round((profitCents * 10000) / revenueCents) : 0

  // ── dates ────────────────────────────────────────────────────────────────────────────────
  const plausible = (d: string | null) => (d && isPlausibleDate(d, window) ? d : null)
  const deliveredDate = facts.delivered ? plausible(row.dates.delivered) ?? plausible(row.dates.invoice) ?? plausible(row.dates.release) : null
  const deliveredAt = deliveredDate ? stamp(deliveredDate, env) : undefined
  const createdDate = plausible(row.dates.created)
  const createdAt = createdDate ? chicagoDateTimeIso(createdDate, /^\d{2}:\d{2}$/.test(row.dates.createdTime ?? '') ? (row.dates.createdTime as string) : '00:00') : undefined
  const voidedAt = facts.isVoid ? stamp(createdDate ?? facts.pickupDate, env) : undefined
  const changedAt = voidedAt ?? deliveredAt ?? stamp(createdDate ?? facts.pickupDate, env)

  // ── AR ───────────────────────────────────────────────────────────────────────────────────
  const wantsInvoice = facts.invoice && !customerUnresolved
  if (facts.invoice && customerUnresolved) note('INVOICE_NO_CUSTOMER')
  if (row.dates.invoice && row.money.invoiceAmountCents === 0) note('ZERO_INVOICE')
  let invoiceRow: EngineRow | null = null
  let arStatus: string
  let arBalance = 0
  const customerRecordTerms = customerId ? env.customers.termsById.get(customerId) ?? null : null
  if (wantsInvoice) {
    const built = buildInvoice(row, facts, env, {
      ids,
      customerId: customerId as string,
      lines: customerCharges.map((c) => ({ chargeId: c.id as string, code: c.code as string, label: c.label as string, rateCents: c.rateCents as number, count: c.count as number, amountCents: c.amountCents as number })),
      customerTermsDays: customerRecordTerms,
    })
    invoiceRow = built.row
    arBalance = built.balance
    arStatus = built.balance === 0 ? 'PAID' : 'UNPAID'
    if (built.termsNotConfigured) note('TERMS_NOT_CONFIGURED')
    if (built.residualCents !== 0) note('MEMO_BALANCE_RESIDUAL')
  } else if (facts.isVoid) arStatus = 'INVOICE_NOT_NEEDED'
  else if (facts.delivered && profile.unbilledLegacyBefore && facts.pickupDate && facts.pickupDate < profile.unbilledLegacyBefore) arStatus = 'LEGACY'
  else arStatus = 'DOCS_NEEDED'
  const arChangedAt = invoiceRow ? (invoiceRow.issuedAt as string) : changedAt

  // ── bill ─────────────────────────────────────────────────────────────────────────────────
  const ap = facts.ap
  const billable = ap != null && carrierRef != null
  let billRow: EngineRow | null = null
  let leg: EngineRow | null = null
  const driverText = row.carrier?.driverName ?? ''
  if (hasCarrier) {
    const car = row.carrier!
    const bookedAt = plausible(row.dates.covered) ? chicagoDateTimeIso(row.dates.covered as string, /^\d{2}:\d{2}$/.test(row.dates.coveredTime ?? '') ? (row.dates.coveredTime as string) : '00:00') : undefined
    const base: EngineRow = {
      id: ids.loadCarrierId,
      loadId: ids.loadId,
      shipmentId: ids.shipmentId,
      kind: isIvan ? 'OWN_ASSET' : 'CARRIER',
      status: 'ACTIVE',
      sequence: 1,
      carrierName: car.name || undefined,
      dispatcherName: (isIvan ? row.staff.actualDispatcher || car.dispatcher : car.dispatcher) || undefined,
      rateConStatus: 'NOT_SENT',
      bookedAt,
      createdBy: IMPORT_ACTOR,
      updatedBy: IMPORT_ACTOR,
    }
    if (isIvan) {
      Object.assign(base, { carrierRateCents: 0, costCents: 0 })
      if (driverText) {
        const matches = env.drivers.byName.get(normalizeLabel(driverText)) ?? []
        if (matches.length === 1) Object.assign(base, { driverId: matches[0], driverName: driverText })
        else {
          base.dispatchNote = `Driver (Aljex): ${driverText}`
          note(matches.length > 1 ? 'IVAN_DRIVER_AMBIGUOUS' : 'IVAN_DRIVER_UNMATCHED')
        }
      }
      if (row.carrier?.tractor) base.truckNumber = row.carrier.tractor
    } else {
      const d = splitDriverText(driverText)
      Object.assign(base, {
        carrierId: carrierRef?.id,
        carrierMc: car.mc || undefined,
        dispatcherPhone: car.dispatchPhone || undefined,
        driverName: d.name,
        driverPhone: d.phone,
        truckNumber: car.tractor || undefined,
        quickPay: row.money.quickPayFeesCents !== 0 ? true : undefined,
        quickPayFeeCents: row.money.quickPayFeesCents !== 0 ? Math.abs(row.money.quickPayFeesCents) : undefined,
        carrierRateCents,
        costCents,
      })
      if (!carrierRef) note('CARRIER_SNAPSHOT')
      if (facts.delivered) {
        if (billable) {
          const billDate = plausible(row.dates.delivered) ?? plausible(row.dates.release) ?? plausible(row.dates.created) ?? plausible(row.dates.invoice) ?? facts.pickupDate ?? window.start
          const terms = carrierRef.termsDays ?? env.settings.defaultCarrierTermsDays ?? 30
          billRow = buildBill(row, ap, ids, carrierRef, billDate, terms, facts, env)
          const open = (billRow.balanceCents as number) > 0
          const lastPaid = ap.carrierPayments.concat(ap.extraLines).map((l) => l.date).filter((d): d is string => !!d).sort().pop()
          Object.assign(base, {
            chargesFinalizedAt: noonUtcIso(billDate),
            apStatus: billRow.status === 'PAID' ? 'PAID' : 'TO_BE_PAID',
            apOpen: open ? 'OPEN' : undefined,
            apStatusChangedAt: open ? noonUtcIso(billDate) : undefined,
            apBalanceCents: billRow.balanceCents,
            apPaidAt: billRow.status === 'PAID' && lastPaid ? noonUtcIso(lastPaid) : undefined,
          })
        } else {
          // Snapshot leg of a skipped carrier (or a delivered load with no carrier cost): fully-paid history, no bill.
          const at = noonUtcIso(deliveredDate ?? facts.pickupDate ?? window.start)
          Object.assign(base, { chargesFinalizedAt: at, apStatus: 'PAID', apPaidAt: at, apBalanceCents: 0 })
        }
      } else if (!facts.isVoid) base.apStatus = 'AWAITING_INVOICE'
    }
    leg = compact(base)
  }

  // ── records ──────────────────────────────────────────────────────────────────────────────
  const refs = refsFor(row, facts)
  const f = row.freight
  const special = compact({
    hazmat: f.hazmat || undefined,
    team: f.team || undefined,
    tarps: f.tarps || undefined,
    tempControl: f.tempControl || undefined,
    escort: f.escort || undefined,
    oversize: f.overSize || undefined,
    permit: f.permit || undefined,
    blind: f.blind || undefined,
    sealRequired: f.seal !== '' && !/^(n|no|false|0)$/i.test(f.seal) ? true : undefined,
    customsBond: f.customsBond ? 'Y' : undefined,
    palletsIn: f.pltIn ?? undefined,
    palletsOut: f.pltOut ?? undefined,
  })
  const salesRepId = profile.repMap[row.salesrepId] || undefined
  const carrierRepId = profile.dispatcherMap[row.staff.actualDispatcher] || undefined
  const rev = revFields(facts, env)
  const customerName = row.customer.name || undefined

  const shipment = compact({
    id: ids.shipmentId,
    number: row.pro,
    status: facts.shipmentStatus,
    statusChangedAt: changedAt,
    statusChangedBy: IMPORT_ACTOR,
    customerId,
    customerName,
    mode: facts.mode,
    orderIds: [ids.orderId],
    loadIds: [ids.loadId],
    pickupAppt: pickupAppt || undefined,
    deliveryAppt: deliveryAppt || undefined,
    pickupMonth: facts.pickupDate ? monthOf(facts.pickupDate) : undefined,
    originCity: originCity || undefined,
    destinationCity: destCity || undefined,
    searchKey: searchKey(row, [originCity, destCity]),
    source: 'BACKFILL',
    deliveredAt,
    ...rev,
    salesRepId,
    carrierRepId,
    salesRepCode: row.salesrepId || undefined,
    createdByCode: row.staff.createdBy || undefined,
    serviceRepCode: row.staff.serviceRep || undefined,
    dispatcherCode: row.staff.assignedDispatcher || undefined,
    osd: row.osd || undefined,
    voidedAt,
    voidedBy: facts.isVoid ? IMPORT_ACTOR : undefined,
    voidReason: facts.isVoid ? 'Voided in Aljex' : undefined,
    ...LEGACY,
    importRunId: env.runId,
    createdAt,
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  })

  const order = compact({
    id: ids.orderId,
    shipmentId: ids.shipmentId,
    customerId,
    customerName,
    mode: facts.mode,
    references: refs,
    specialRequirements: Object.keys(special).length ? special : undefined,
    customerNotes: notes.length ? notes.join('\n') : undefined,
    internalNotes: facts.tonu ? 'Aljex flagged this load as a TONU.' : undefined,
    customerRateCents: lhCents,
    revenueCents,
    arStatus,
    arStatusChangedAt: arChangedAt,
    invoiceId: invoiceRow ? ids.invoiceId : undefined,
    invoiceNumber: invoiceRow ? row.pro : undefined,
    invoicedAt: invoiceRow ? (invoiceRow.issuedAt as string) : undefined,
    paidAt: invoiceRow?.paidAt as string | undefined,
    arBalanceCents: invoiceRow ? arBalance : undefined,
    factoringItemId: invoiceRow?.factoringItemId as string | undefined,
    pickupAppt: pickupAppt || undefined,
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  })

  const load = compact({
    id: ids.loadId,
    aljexId: row.pro,
    tmsId: row.referenceNo || row.pro,
    pickupNumber: row.pickupRefNo || row.pro,
    originName: legacy?.originName,
    originCity: legacy?.originCity,
    destinationName: legacy?.destinationName,
    destinationCity: legacy?.destinationCity,
    pickupAppt,
    pickupApptEnd: legacy?.pickupApptEnd,
    pickupApptType: legacy?.pickupApptType,
    deliveryAppt,
    deliveryApptEnd: legacy?.deliveryApptEnd,
    deliveryApptType: legacy?.deliveryApptType,
    readyToInvoice: false,
    rate: revenueCents,
    miles: row.freight.miles ?? undefined,
    customer: row.customer.name || undefined,
    hot: row.freight.hot || undefined,
    commodity: row.freight.commodity || undefined,
    weight: row.freight.weight ?? undefined,
    pieces: parsePieces(row.freight.commodity),
    unscheduled: false,
    customerId,
    stops: JSON.stringify(stops),
    shipmentId: ids.shipmentId,
    orderId: ids.orderId,
    loadNumber: row.pro,
    leg: 1,
    status: facts.loadStatus,
    statusChangedAt: changedAt,
    statusChangedBy: IMPORT_ACTOR,
    statusSource: 'BACKFILL',
    carrierRepId,
    assignmentType,
    activeLoadCarrierId: leg ? ids.loadCarrierId : undefined,
    carrierName: row.carrier?.name || undefined,
    divisionKey: isIvan ? 'IVAN_CARTAGE' : 'BCAT_LOGISTICS',
    trackingProvider: 'NONE',
    pickupMonth: facts.pickupDate ? monthOf(facts.pickupDate) : undefined,
    cargoValueCents: row.money.declaredValueCents > 0 ? row.money.declaredValueCents : undefined,
    deliveredAt,
    ...rev,
    salesRepId,
    voidedAt,
    previousStatus: facts.isVoid ? 'SOURCING' : undefined,
    previousReadyToInvoice: facts.isVoid ? false : undefined,
    ...LEGACY,
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
  })

  const financials = {
    id: ids.loadId,
    loadId: ids.loadId,
    shipmentId: ids.shipmentId,
    orderId: ids.orderId,
    customerRateCents: lhCents,
    revenueCents,
    carrierRateCents,
    costCents,
    profitCents,
    marginBps,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  }

  const claim = { id: row.proKey as string, loadId: ids.loadId, shipmentId: ids.shipmentId, claimedAt: '', claimedBy: IMPORT_ACTOR, origin: 'LEGACY' }

  const items: TxItem[] = [
    { op: 'put', table: 'proClaim', item: claim, ifNotExists: true },
    { op: 'put', table: 'shipment', item: shipment },
    { op: 'put', table: 'order', item: order },
    { op: 'put', table: 'load', item: load },
    { op: 'put', table: 'loadFinancials', item: financials },
    ...customerCharges.map((item) => ({ op: 'put', table: 'loadCharge', item }) as TxItem),
    ...carrierCharges.map((item) => ({ op: 'put', table: 'loadCharge', item }) as TxItem),
  ]
  if (leg) items.push({ op: 'put', table: 'loadCarrier', item: leg })
  if (invoiceRow) items.push({ op: 'put', table: 'invoice', item: invoiceRow })
  if (billRow) items.push({ op: 'put', table: 'carrierBill', item: billRow })
  items.push({ op: 'put', table: 'legacyAljexRow', item: legacyRow(row, ids.shipmentId, env, 'LOAD') })
  return { ids, items, facts, findings, invoice: invoiceRow != null, bill: billRow != null, customerUnresolved }
}

export interface InvoiceLineInput {
  chargeId: string
  code: string
  label: string
  rateCents: number
  count: number
  amountCents: number
}

/**
 * The AR facts and Invoice row of an invoiced load (DECIDED-1). Invoice = Invoice Amount + the memo
 * adjustment lines (+ a reported residual line when Aljex's Bal Due is not explained by the memos), so
 * the row is self-consistent and its balance equals Aljex's open balance to the cent.
 */
export function buildInvoice(
  row: CanonicalRow,
  facts: RowFacts,
  env: LoadEnv,
  p: { ids: Pick<RowIds, 'key' | 'orderId' | 'shipmentId' | 'loadId' | 'invoiceId'>; customerId: string; lines: InvoiceLineInput[]; customerTermsDays: number | null },
): { row: EngineRow; balance: number; termsNotConfigured: boolean; residualCents: number; math: InvoiceMath } {
  const adjustments = env.memos[row.proKey as string]
  const math = invoiceMath(row, memoNet(adjustments))
  const { totalCents: total, paidAppliedCents: paidApplied, balanceCents: balance, status } = math
  const invoiceDate = row.dates.invoice as string
  const terms = resolveTermsDays({ customerTermsDays: p.customerTermsDays, orgDefaultTermsDays: env.settings.defaultPaymentTermsDays })
  const termsDays = terms.days ?? 30
  const lastPay = row.payments.filter((x) => x.date).map((x) => x.date as string).sort().pop()
  const lines: EngineRow[] = p.lines.map((c) => ({ chargeId: c.chargeId, loadId: p.ids.loadId, code: c.code, label: c.label, calculatedBy: 'FLAT', rateCents: c.rateCents, count: c.count, amountCents: c.amountCents }))
  lines.push(...adjustmentLines(p.ids.key, p.ids.loadId, adjustments, math.residualCents))
  const billToName = row.billTo.name || row.customer.name
  const billToAddr = compactText({ street: row.billTo.street || row.customer.street, city: row.billTo.city || row.customer.city, state: row.billTo.state || row.customer.state, zip: row.billTo.zip || row.customer.zip })
  const factored = env.factoringIds.has(row.proKey as string)
  const invoice = compact({
    id: p.ids.invoiceId,
    number: row.pro,
    orderId: p.ids.orderId,
    shipmentId: p.ids.shipmentId,
    shipmentNumber: row.pro,
    customerId: p.customerId,
    customerName: row.customer.name || undefined,
    billTo: compact({ name: billToName, address: Object.keys(billToAddr).length ? billToAddr : null, email: null }),
    divisionKey: facts.ownAsset ? 'IVAN_CARTAGE' : 'BCAT_LOGISTICS',
    status,
    invoiceDate,
    issuedAt: noonUtcIso(invoiceDate),
    issuedBy: IMPORT_ACTOR,
    dueAt: dueDate(invoiceDate, termsDays),
    termsDays,
    termsText: `Net ${termsDays}`,
    invoiceMonth: monthOf(invoiceDate),
    lines,
    references: refsFor(row, facts).filter((r) => r.visibility === 'ALL'),
    subtotalCents: total,
    totalCents: total,
    paidCents: paidApplied,
    writtenOffCents: 0,
    balanceCents: balance,
    arOpen: balance > 0 ? 'OPEN' : undefined,
    paidAt: status === 'PAID' && lastPay ? noonUtcIso(lastPay) : undefined,
    remitTo: null,
    factored,
    factoringItemId: factored ? row.proKey : undefined,
    pdfKey: null,
    attachDocumentIds: [],
    sentCount: 0,
    markedSentAt: noonUtcIso(invoiceDate),
    markedSentBy: IMPORT_ACTOR,
    markedSentNote: 'Sent from Aljex',
    note: terms.days == null ? 'Aljex import: terms not in export and not configured; Net 30 assumed' : `Aljex import: terms not in export (${terms.source === 'CUSTOMER' ? 'customer' : 'org default'})`,
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  })
  return { row: invoice, balance, termsNotConfigured: terms.days == null, residualCents: math.residualCents, math }
}

/** The lossless source row (every non-empty cell, `fields` = row.raw) in the LegacyAljexRow side table (DECIDED-2). */
export function legacyRow(row: CanonicalRow, shipmentId: string | undefined, env: LoadEnv, kind: 'LOAD' | 'MEMO_DEBT' | 'MEMO_CRED'): EngineRow {
  return compact({
    id: kind === 'LOAD' ? `aljex:${row.pro}` : `aljex:memo:${row.pro}`,
    pro: row.pro,
    kind,
    shipmentId,
    importRunId: env.runId,
    sourceSha256: env.stageHash,
    rowNumber: row.rowNumber,
    fields: row.raw,
    importedAt: '',
  })
}

/**
 * `Carrier Ref #` is preserved verbatim on the leg's driver text and in the LegacyAljexRow raw row. It only
 * lands on the bill as a note when it carries something the leg's driver text does not.
 */
function carrierRefNote(row: CanonicalRow): string | undefined {
  const ref = row.carrierRefNo.trim()
  if (!ref || ref === (row.carrier?.driverName ?? '').trim()) return undefined
  return `Carrier Ref # (Aljex): ${ref}`
}

export function buildBill(row: CanonicalRow, ap: ApFacts, ids: RowIds, carrier: CarrierRef, billDate: string, termsDays: number, facts: RowFacts, env: LoadEnv): EngineRow {
  const lines: EngineRow[] = row.projectedExpenses
    .filter((p) => p.amountCents !== 0)
    .map((p) => {
      const pc = classifyProjected(p, env.profile)
      return { chargeId: stableId('chg', `${ids.key}:K:${p.n}`), code: pc.code, label: pc.label, calculatedBy: 'FLAT', rateCents: p.amountCents, count: 1, amountCents: p.amountCents }
    })
  ap.extraLines.forEach((l, i) =>
    lines.push({ chargeId: stableId('chg', `${ids.key}:X:${i}`), code: 'ACCESSORIAL', label: l.name || 'Aljex expense', calculatedBy: 'FLAT', rateCents: l.amountCents, count: 1, amountCents: l.amountCents, note: `GL ${l.gl}` }),
  )
  // Advance / Quick Pay fee columns: AP charge lines. They are the Aljex fee columns as exported and are NOT
  // deducted again here (gross/fee/net below come from the paid-expense lines, which already carry the fee).
  for (const f of carrierFeeLines(row)) lines.push({ chargeId: stableId('chg', `${ids.key}:K:${f.code}`), code: f.code, label: f.label, calculatedBy: 'FLAT', rateCents: f.cents, count: 1, amountCents: f.cents, note: 'Aljex fee column (informational; not in gross)' })
  const open = ap.balanceCents > 0
  return compact({
    id: ids.billId,
    loadCarrierId: ids.loadCarrierId,
    loadId: ids.loadId,
    shipmentId: ids.shipmentId,
    shipmentNumber: row.pro,
    loadNumber: row.pro,
    carrierId: carrier.id,
    carrierName: row.carrier?.name,
    carrierMc: row.carrier?.mc || undefined,
    payeeKind: 'CARRIER',
    divisionKey: facts.ownAsset ? 'IVAN_CARTAGE' : 'BCAT_LOGISTICS',
    status: ap.status,
    // Aljex has no bill-number column. `Carrier Ref #` is a copy of Driver Name (not unique), so the number is the
    // load's PRO: exactly the string the Invoice number carries, unique per load, one bill per load leg (`:1`).
    billNumber: row.pro,
    note: carrierRefNote(row),
    billDate,
    billMonth: monthOf(billDate),
    recordedAt: noonUtcIso(billDate),
    recordedBy: IMPORT_ACTOR,
    dueAt: addDays(billDate, termsDays),
    termsDays,
    quickPay: ap.feeCents > 0 ? true : undefined,
    lines,
    grossCents: ap.grossCents,
    quickPayFeeCents: ap.feeCents,
    netCents: ap.netCents,
    billedCents: ap.grossCents,
    varianceCents: 0,
    paidCents: ap.paidCents,
    creditedCents: 0,
    balanceCents: ap.balanceCents,
    apOpen: open ? 'OPEN' : undefined,
    approvedAt: noonUtcIso(billDate),
    approvedBy: IMPORT_ACTOR,
    approvalWarnings: ['LEGACY_IMPORT'],
    createdBy: IMPORT_ACTOR,
    updatedBy: IMPORT_ACTOR,
    version: 1,
  })
}

/** The Advance Fees / Quick Pay Fees columns as signed CARRIER charge lines (`ADVANCE_FEE` / `QUICKPAY_FEE`). */
export function carrierFeeLines(row: CanonicalRow): Array<{ code: string; label: string; cents: number; sortOrder: number }> {
  const out: Array<{ code: string; label: string; cents: number; sortOrder: number }> = []
  if (row.money.quickPayFeesCents !== 0) out.push({ code: ALJEX_FEE_CHARGE_CODES.quickPay, label: 'Quick pay fee (Aljex)', cents: row.money.quickPayFeesCents, sortOrder: 190 })
  if (row.money.advanceFeesCents !== 0) out.push({ code: ALJEX_FEE_CHARGE_CODES.advance, label: 'Advance fee (Aljex)', cents: row.money.advanceFeesCents, sortOrder: 191 })
  return out
}

/**
 * CRED/DEBT memo row (DECIDED-1): never a Shipment/Order/Load/ProClaim. Its money lives as an adjustment
 * line on the referenced invoice (built with that load); this row only keeps the lossless source copy and
 * reports the memo when its reference has no invoice.
 */
export function buildMemoRow(row: CanonicalRow, env: LoadEnv): AggregateResult {
  const ids = rowIds(row, env.invoiceOwners)
  const orphan = env.memoOrphans.get(row.pro)
  const findings = orphan ? [{ code: `MEMO_ORPHAN_${orphan.reason}`, detail: `reference ${orphan.referencePro || 'blank'}` }] : []
  const items: TxItem[] = [{ op: 'put', table: 'legacyAljexRow', item: legacyRow(row, undefined, env, row.kind === 'MEMO_DEBT' ? 'MEMO_DEBT' : 'MEMO_CRED') }]
  return { ids, items, facts: rowFacts(row, env.profile, env.window), findings, invoice: false, bill: false, customerUnresolved: false, memoApplied: !orphan }
}

