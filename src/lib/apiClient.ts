import { generateClient } from 'aws-amplify/data'
import { uploadData, getUrl, remove } from 'aws-amplify/storage'
import type { Load, Stop, Driver, AuditLogEntry, EntityType, AuditAction, FactoringItem, FactoringItemStatus, TimeClockEntry } from '@/types'
import type { RateConExtract, RateConFreight } from '@/lib/otrInvoice'
import type { Equipment, MaintenanceTask, MaintenanceInvoice } from '@/types/equipment'
import { fuelDedupKey } from '@/lib/driverFuel'
import { fileContentType } from '@/lib/disputeFiles'
import type { FixedExpenseInput } from './driverPay'
import type { DispatchConversation, DispatchMessage } from './dispatch'
import type { VendorPayable, VendorApAttachment, VendorPayableDetails, VendorPayment } from '@/types/vendorAp'
import type {
  CustomerRecord, LocationRecord, Division, TmsSettings, GeocodeResult, AutocompleteSuggestion,
  LocationMergePreview, LocationMergeJob,
  ShipmentRecord, OrderRecord, LoadCarrierRecord, LoadFinancialsRecord, LoadChargeRecord,
  LoadChargeInput, ShipmentBundle, ShipmentLoadFields, ShipmentStatus, ShipmentMode,
  LoadWorkflowStatus, AssignmentType,
  CarrierRecord, CarrierContactRecord, CarrierPaymentMethodRecord, CarrierDocumentRecord,
  CarrierBundle, CarrierStatus, CarrierStatusReason, CarrierContactType, CarrierDocumentType,
  CarrierPaymentMethodKind, CarrierPayeeType, QuickPayTier,
  ChargeSide, CheckCallNotifyChannel, CheckCallType, IncidentType, LoadCheckCallRecord,
  TrackingContact, TrackingLinkRecord, CustomerNotification,
  ShipmentDocumentRecord, ShipmentDocumentType, ShipmentDocumentAudience,
  ShipmentNoticeRecord, DocGateResult,
  InvoiceRecord, ArPaymentRecord, ArPaymentMethod, ArSettings, ArStatus,
  PaymentApplication, CreditApplication,
  ApStatus, CarrierBillRecord, ApPaymentRecord, ApPaymentMethod, ApPaymentApplication,
  ApPayeeKind, ApRemitTo, ApSettings,
  QuoteRecord, QuoteSettings, QuoteLostReason, QuoteSide, QuoteAcceptedVia,
  LaneRateSampleRecord, OrderReference, RateType,
} from '@/types/tms'
import type { CreditSummary } from '@/lib/customerCredit'
import type { QuotePricingResult } from '@/lib/quotes'
import { isActiveDirectoryRecord } from '@/lib/tmsDirectory'

// Untyped client — our own types from src/types handle type safety
const client = generateClient()

// ── GraphQL fragments ─────────────────────────────────────────────────────────

// Base selection set, minus `hot`. `hot` is a newer field; it is appended via
// loadFields() only while the backend supports it. If a deploy hasn't added `hot`
// yet, listLoads detects the FieldUndefined error and drops it (see below) so the
// app keeps working against an older API. Self-heals to include `hot` post-deploy.
const LOAD_FIELDS = `
  id aljexId tmsId pickupNumber
  originName originCity destinationName destinationCity
  pickupAppt pickupApptEnd pickupApptType
  deliveryAppt deliveryApptEnd deliveryApptType
  pickupDriverId deliveryDriverId
  readyToInvoice rateConfirmKey
  colorKey daySlot rate miles customer truckId notes
  createdBy updatedBy createdAt updatedAt
`

// `hot`/`unscheduled`, `stops`, `sortOrder`, and `customerId` are newer fields added in
// later backend deploys. Each is gated by a flag and appended only while the backend
// supports it; if the API predates a field, listLoads detects the FieldUndefined error,
// clears that flag, and retries (so a frontend shipping before the backend deploy keeps
// working). Self-heals post-deploy.
let loadsHaveHot = true
let loadsHaveStops = true
let loadsHaveSortOrder = true
let loadsHaveCustomerId = true
let loadsHaveEldReview = true
let loadsHavePaperworkLocation = true
let loadsHaveTrailer = true
let loadsHaveFreight = true
// Step C's declared cargo value — read by the carrier booking gates.
let loadsHaveCargoValue = true
let loadsHavePodNotes = true
// Step B's shipment layer: the link to Shipment/Order plus the carrier-side status
// and assignment. One flag for the whole group — they deploy together, and step D's
// tracking columns ride the same flag because they land in the same Load deploy.
let loadsHaveShipment = true
const LOAD_SHIPMENT_FIELDS = `
  shipmentId orderId loadNumber leg status statusChangedAt statusChangedBy statusSource
  carrierRepId assignmentType activeLoadCarrierId carrierName equipmentType divisionKey
  trackingProvider nextCheckCallAt nextCheckCallNote checkCallOpen pickupMonth
  lastCheckCallAt lastCheckCallType lastKnownAt lastKnownCity lastKnownState
  lastKnownLat lastKnownLng lastKnownSource openIncidentCount deliveredAt
  checkCallDueNotifiedAt checkCallOverdueNotifiedAt
`
const loadFields = () => {
  let f = LOAD_FIELDS
  if (loadsHaveHot) f += ' hot unscheduled'
  if (loadsHaveStops) f += ' stops'
  if (loadsHaveSortOrder) f += ' sortOrder'
  if (loadsHaveCustomerId) f += ' customerId'
  if (loadsHaveEldReview) f += ' eldLogsReviewedAt eldLogsReviewedBy eldLogsNote'
  if (loadsHavePaperworkLocation) f += ' paperworkLocation'
  if (loadsHaveTrailer) f += ' trailerNumber'
  if (loadsHaveFreight) f += ' commodity weight pieces piecesUnit'
  if (loadsHavePodNotes) f += ' podNotes'
  if (loadsHaveCargoValue) f += ' cargoValueCents'
  if (loadsHaveShipment) f += LOAD_SHIPMENT_FIELDS
  return f
}

// Base selection set. onboardingStatus/complianceStatus are newer compliance fields;
// appended via driverFields() only while the backend supports them (self-heals like
// LOAD_FIELDS' `hot`), so the roster keeps working against a pre-deploy API.
const DRIVER_BASE_FIELDS = `
  id name phone active type colorKey notes photoKey assignedTruckId
  email cdl cdlExpiration medCardExpiration drugTestDate hireDate driverType
  createdAt updatedAt
`
let driversHaveCompliance = true
// assignedTrailerId + fleetGroup ship with the Files hub — same self-healing treatment.
// They deploy together, so one flag covers both.
let driversHaveTrailer = true
// Same treatment again for the Motive link, so the roster still loads between this deploy
// and the backend catching up. One unhandled throw here blanks every driver in the app.
let driversHaveMotive = true
// And for the dedicated dispatcher pair.
let driversHaveDispatcher = true
const driverFields = () => [
  DRIVER_BASE_FIELDS,
  driversHaveCompliance ? 'onboardingStatus complianceStatus' : '',
  driversHaveTrailer ? 'assignedTrailerId fleetGroup' : '',
  driversHaveMotive ? 'motiveDriverId' : '',
  driversHaveDispatcher ? 'dispatcherPrimary dispatcherBackup ivanApp timeClock unitType' : '',
].filter(Boolean).join(' ')

const isMotiveFieldUndefined = (err: unknown) => /motiveDriverId/.test(JSON.stringify(err ?? ''))
const isDispatcherFieldUndefined = (err: unknown) => /dispatcher(Primary|Backup)|ivanApp|timeClock|unitType/.test(JSON.stringify(err ?? ''))

function isComplianceFieldUndefined(err: unknown): boolean {
  const errs = (err as { errors?: { message?: string }[] })?.errors
  return Array.isArray(errs) && errs.some((e) => /'(onboardingStatus|complianceStatus)'/.test(e?.message ?? ''))
}

/**
 * Whether an error is AppSync rejecting `assignedTrailerId` as an unknown field.
 *
 * Deliberately inspects the WHOLE serialized error rather than errors[].message: a
 * rejected query surfaces through the Amplify client in more than one shape (an
 * `errors` array, a bare Error with the text in `message`, a wrapped network error),
 * and missing it here blanks the entire driver roster — initializeData gives up on
 * the first listDrivers throw. Same approach as isMissingBtExt below.
 */
export function isTrailerFieldUndefined(err: unknown): boolean {
  return /assignedTrailerId|fleetGroup/i.test(safeStringify(err))
}

/** JSON.stringify that also captures Error.message (not an own enumerable property). */
function safeStringify(err: unknown): string {
  if (err == null) return ''
  const parts = [String((err as { message?: unknown })?.message ?? '')]
  try { parts.push(JSON.stringify(err)) } catch { /* circular — the message is enough */ }
  return parts.join(' ')
}

/** False once a call proved the backend predates assignedTrailerId (pre-deploy). */
export const driverTrailerFieldDeployed = () => driversHaveTrailer

const AUDIT_FIELDS = `
  id entityType entityId action user changes createdAt
`

// ── Loads ─────────────────────────────────────────────────────────────────────

// Which newer fields the backend is rejecting (not deployed yet). Used to clear the
// corresponding flag and retry.
function undefinedLoadFields(err: unknown): { hot: boolean; stops: boolean; sortOrder: boolean; customerId: boolean; eldReview: boolean; paperworkLocation: boolean; trailer: boolean; freight: boolean; cargoValue: boolean; podNotes: boolean; shipment: boolean } {
  const errs = (err as { errors?: { message?: string }[] })?.errors
  const msg = Array.isArray(errs) ? errs.map((e) => e?.message ?? '').join(' ') : ''
  return {
    hot: /'(hot|unscheduled)'/i.test(msg),
    stops: /'stops'/i.test(msg),
    sortOrder: /'sortOrder'/i.test(msg),
    customerId: /'customerId'/i.test(msg),
    eldReview: /'(eldLogsReviewedAt|eldLogsReviewedBy|eldLogsNote)'/i.test(msg),
    paperworkLocation: /'paperworkLocation'/i.test(msg),
    trailer: /'trailerNumber'/i.test(msg),
    freight: /'(commodity|weight|pieces|piecesUnit)'/i.test(msg),
    cargoValue: /'cargoValueCents'/i.test(msg),
    podNotes: /'podNotes'/i.test(msg),
    shipment: /'(shipmentId|orderId|loadNumber|leg|status|statusChangedAt|statusChangedBy|statusSource|carrierRepId|assignmentType|activeLoadCarrierId|carrierName|equipmentType|divisionKey|trackingProvider|nextCheckCallAt|nextCheckCallNote|checkCallOpen|pickupMonth|lastCheckCallAt|lastCheckCallType|lastKnownAt|lastKnownCity|lastKnownState|lastKnownLat|lastKnownLng|lastKnownSource|openIncidentCount|deliveredAt|checkCallDueNotifiedAt|checkCallOverdueNotifiedAt)'/i.test(msg),
  }
}

export async function listLoads(): Promise<Load[]> {
  // Every page: one DynamoDB scan stops at 1 MB whatever the limit, and the Load table
  // passed that in Oct 2026 — the loads past the first page silently vanished app-wide.
  type LoadPage = { items: (Load & { rateConfirmKey?: string })[]; nextToken?: string | null }
  const run = async () => {
    const items: LoadPage['items'] = []
    let nextToken: string | null = null
    do {
      const r = await client.graphql({
        query: `query ListLoads($nextToken: String) { listLoads(limit: 10000, nextToken: $nextToken) { items { ${loadFields()} } nextToken } }`,
        variables: { nextToken },
      }) as { data: { listLoads: LoadPage } }
      items.push(...(r.data.listLoads.items ?? []))
      nextToken = r.data.listLoads.nextToken ?? null
    } while (nextToken)
    return { data: { listLoads: { items } } }
  }

  // The customer policy map must be current before loads are stamped with it.
  const customersReady = listCustomers({ includeArchived: true })
  let result
  // Retry up to twice so a single query missing newer fields can recover.
  for (let attempt = 0; ; attempt++) {
    try { result = await run(); break }
    catch (err) {
      if (attempt >= 2) throw err
      const u = undefinedLoadFields(err)
      let changed = false
      if (loadsHaveHot && u.hot) {
        console.warn("[apiClient] backend has no 'hot' field yet — querying loads without it until deploy")
        loadsHaveHot = false; changed = true
      }
      if (loadsHaveStops && u.stops) {
        console.warn("[apiClient] backend has no 'stops' field yet — querying loads without it until deploy")
        loadsHaveStops = false; changed = true
      }
      if (loadsHaveSortOrder && u.sortOrder) {
        console.warn("[apiClient] backend has no 'sortOrder' field yet — querying loads without it until deploy")
        loadsHaveSortOrder = false; changed = true
      }
      if (loadsHaveCustomerId && u.customerId) {
        console.warn("[apiClient] backend has no 'customerId' field yet — querying loads without it until deploy")
        loadsHaveCustomerId = false; changed = true
      }
      if (loadsHaveEldReview && u.eldReview) {
        console.warn("[apiClient] backend has no ELD review fields yet — querying loads without them until deploy")
        loadsHaveEldReview = false; changed = true
      }
      if (loadsHavePaperworkLocation && u.paperworkLocation) {
        console.warn("[apiClient] backend has no paperworkLocation yet — querying loads without it until deploy")
        loadsHavePaperworkLocation = false; changed = true
      }
      if (loadsHaveTrailer && u.trailer) {
        console.warn("[apiClient] backend has no trailerNumber yet — querying loads without it until deploy")
        loadsHaveTrailer = false; changed = true
      }
      if (loadsHaveFreight && u.freight) {
        console.warn("[apiClient] backend has no freight fields yet — querying loads without them until deploy")
        loadsHaveFreight = false; changed = true
      }
      if (loadsHaveCargoValue && u.cargoValue) {
        console.warn("[apiClient] backend has no cargoValueCents yet — querying loads without it until deploy")
        loadsHaveCargoValue = false; changed = true
      }
      if (loadsHavePodNotes && u.podNotes) {
        console.warn("[apiClient] backend has no podNotes yet — querying loads without it until deploy")
        loadsHavePodNotes = false; changed = true
      }
      if (loadsHaveShipment && u.shipment) {
        console.warn('[apiClient] backend has no shipment fields on Load yet — querying loads without them until deploy')
        loadsHaveShipment = false; changed = true
      }
      if (!changed) throw err
    }
  }
  await customersReady
  const items = result.data.listLoads.items ?? []
  return Promise.all(items.map((l) => resolveRateConfirmUrl(withCustomerPolicy(l))))
}

// `stops` is an a.json() (AWSJSON) field. Through this client it must be written as a
// JSON STRING (same as createAuditLog's `changes`); reads undo the encoding via unwrapJson.
// Also drop newer fields from the input if the backend doesn't have them yet (pre-deploy).
function serializeLoadInput<T extends { stops?: unknown; sortOrder?: unknown; customerId?: unknown }>(input: T): T {
  let out: T = input
  if (!loadsHaveSortOrder && 'sortOrder' in (out as object)) {
    const { sortOrder: _drop, ...rest } = out as T & { sortOrder?: unknown }
    out = rest as T
  }
  if (!loadsHavePodNotes && 'podNotes' in (out as object)) {
    const { podNotes: _drop, ...rest } = out as T & { podNotes?: unknown }
    out = rest as T
  }
  if (!loadsHaveCustomerId && 'customerId' in (out as object)) {
    const { customerId: _drop, ...rest } = out as T & { customerId?: unknown }
    out = rest as T
  }
  if (!loadsHaveStops) {
    const { stops: _drop, ...rest } = out as T & { stops?: unknown }
    return rest as T
  }
  if (out.stops == null) return out
  return { ...out, stops: JSON.stringify(out.stops) }
}

// `customerApptWorkflow` is resolved from the Customer at read time and never written.
export async function createLoad(
  input: Omit<Load, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Load> {
  const { rateConfirmUrl: _skip, customerApptWorkflow: _policy, ...rest } = input as Load & { rateConfirmUrl?: string }
  const result = await client.graphql({
    query: `mutation CreateLoad($input: CreateLoadInput!) { createLoad(input: $input) { ${loadFields()} } }`,
    variables: { input: serializeLoadInput(rest) },
  }) as { data: { createLoad: Load } }
  return normalizeLoadStops(withCustomerPolicy(result.data.createLoad))
}

export async function updateLoad(
  id: string,
  patch: Partial<Omit<Load, 'id' | 'createdAt'>>
): Promise<Load> {
  const { rateConfirmUrl: _skip, customerApptWorkflow: _policy, ...rest } = patch as typeof patch & { rateConfirmUrl?: string }
  const result = await client.graphql({
    query: `mutation UpdateLoad($input: UpdateLoadInput!) { updateLoad(input: $input) { ${loadFields()} } }`,
    variables: { input: serializeLoadInput({ id, ...rest }) },
  }) as { data: { updateLoad: Load } }
  return resolveRateConfirmUrl(withCustomerPolicy(result.data.updateLoad))
}

export async function deleteLoad(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteLoad($input: DeleteLoadInput!) { deleteLoad(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Real-time subscriptions ───────────────────────────────────────────────────

interface SubscriptionHandle { unsubscribe(): void }
interface Subscribable<T> {
  subscribe(opts: { next(v: { data: T }): void; error(e: unknown): void }): SubscriptionHandle
}

export function subscribeToLoadChanges(callbacks: {
  onCreate?: (load: Load) => void
  onUpdate?: (load: Load) => void
  onDelete?: (id: string) => void
}): () => void {
  const handles: SubscriptionHandle[] = []

  function wire<T>(query: string, pick: (data: T) => void) {
    const handle = (client.graphql({ query }) as unknown as Subscribable<T>)
      .subscribe({
        next:  ({ data }) => pick(data),
        error: (e) => console.warn('[subscription] error:', e),
      })
    handles.push(handle)
  }

  if (callbacks.onCreate) {
    const cb = callbacks.onCreate
    wire<{ onCreateLoad: Load }>(
      `subscription OnCreateLoad { onCreateLoad { ${loadFields()} } }`,
      (d) => { if (d.onCreateLoad) cb(normalizeLoadStops(withCustomerPolicy(d.onCreateLoad))) },
    )
  }
  if (callbacks.onUpdate) {
    const cb = callbacks.onUpdate
    wire<{ onUpdateLoad: Load }>(
      `subscription OnUpdateLoad { onUpdateLoad { ${loadFields()} } }`,
      (d) => { if (d.onUpdateLoad) cb(normalizeLoadStops(withCustomerPolicy(d.onUpdateLoad))) },
    )
  }
  if (callbacks.onDelete) {
    const cb = callbacks.onDelete
    wire<{ onDeleteLoad: { id: string } }>(
      `subscription OnDeleteLoad { onDeleteLoad { id } }`,
      (d) => { if (d.onDeleteLoad?.id) cb(d.onDeleteLoad.id) },
    )
  }

  return () => handles.forEach((h) => h.unsubscribe())
}

// ── Drivers ───────────────────────────────────────────────────────────────────

export async function listDrivers(): Promise<Driver[]> {
  const run = async () => client.graphql({
    query: `query ListDrivers { listDrivers(limit: 1000) { items { ${driverFields()} } } }`,
  }) as Promise<{ data: { listDrivers: { items: Driver[] } } }>
  // Retry while newer fields are rejected: AppSync may report only one unknown field
  // per attempt, and one unhandled throw here blanks the whole roster (initializeData
  // gives up on the first failure) — which is exactly how the Files page ended up
  // showing trucks but no drivers.
  let err: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await run()
      const items = result.data.listDrivers.items ?? []
      return Promise.all(items.map(resolveDriverPhotoUrl))
    } catch (e: unknown) {
      err = e
      let dropped = false
      if (driversHaveCompliance && isComplianceFieldUndefined(e)) {
        console.warn("[apiClient] backend has no onboardingStatus/complianceStatus yet — querying drivers without them until deploy")
        driversHaveCompliance = false; dropped = true
      }
      if (driversHaveTrailer && isTrailerFieldUndefined(e)) {
        console.warn("[apiClient] backend has no assignedTrailerId yet — querying drivers without it until deploy")
        driversHaveTrailer = false; dropped = true
      }
      if (driversHaveMotive && isMotiveFieldUndefined(e)) {
        console.warn("[apiClient] backend has no motiveDriverId yet — querying drivers without it until deploy")
        driversHaveMotive = false; dropped = true
      }
      if (driversHaveDispatcher && isDispatcherFieldUndefined(e)) {
        console.warn("[apiClient] backend has no dispatcherPrimary/dispatcherBackup yet — querying drivers without them until deploy")
        driversHaveDispatcher = false; dropped = true
      }
      if (!dropped) break
    }
  }
  // Stale records (e.g. legacy lowercase driverType before the enum migration) make
  // AppSync return partial errors with valid data alongside. Surface what we can
  // rather than blanking the roster — invalid enum fields come back null (Unclassified).
  const partial = (err as { data?: { listDrivers?: { items?: Driver[] } } })?.data
  if (partial?.listDrivers?.items) {
    console.warn('[listDrivers] partial errors (stale records?) — showing valid items', err)
    return Promise.all(partial.listDrivers.items.filter(Boolean).map(resolveDriverPhotoUrl))
  }
  throw err
}

// Stale/unset enum fields (e.g. legacy lowercase driverType, or an onboardingStatus that
// was never classified) make AppSync return field errors *alongside* the valid written
// data — the mutation still persisted. Surface the partial driver instead of throwing, so
// saving a driver that has legacy data doesn't look like it failed (matches listDrivers).
function driverFromPartial(err: unknown, key: 'createDriver' | 'updateDriver'): Driver | null {
  const data = (err as { data?: Record<string, Driver | null> }).data
  return data?.[key] ?? null
}

export async function createDriver(
  input: Omit<Driver, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Driver> {
  try {
    const result = await client.graphql({
      query: `mutation CreateDriver($input: CreateDriverInput!) { createDriver(input: $input) { ${driverFields()} } }`,
      variables: { input },
    }) as { data: { createDriver: Driver } }
    return result.data.createDriver
  } catch (err: unknown) {
    const partial = driverFromPartial(err, 'createDriver')
    if (partial) return partial
    throw err
  }
}

export async function updateDriver(
  id: string,
  patch: Partial<Omit<Driver, 'id' | 'createdAt'>>
): Promise<Driver> {
  const { photoUrl: _skip, ...all } = patch as typeof patch & { photoUrl?: string }
  const { assignedTrailerId: _t, fleetGroup: _f, ...withoutNewFields } = all
  const { motiveDriverId: _m, ...withoutMotive } = all
  const { dispatcherPrimary: _dp, dispatcherBackup: _db, ivanApp: _ia, timeClock: _tc, unitType: _ut, ...withoutDispatcher } = all

  // The SELECTION matters as much as the input. Building it from `driversHaveTrailer`
  // meant a stale flag returned a driver with fleetGroup/assignedTrailerId missing —
  // the write succeeded and the response then overwrote local state without them, so a
  // saved value instantly read as unsaved. Ask for them on the optimistic attempt.
  const run = async (input: Record<string, unknown>, withNewFields: boolean) => {
    const fields = withNewFields
      ? `${DRIVER_BASE_FIELDS} ${driversHaveCompliance ? 'onboardingStatus complianceStatus' : ''} assignedTrailerId fleetGroup motiveDriverId dispatcherPrimary dispatcherBackup ivanApp timeClock unitType`
      : driverFields()
    return client.graphql({
      query: `mutation UpdateDriver($input: UpdateDriverInput!) { updateDriver(input: $input) { ${fields} } }`,
      variables: { input: { id, ...input } },
    }) as Promise<{ data: { updateDriver: Driver } }>
  }

  // ALWAYS attempt the full patch first, then fall back if the backend rejects a newer
  // field. Deciding up-front from `driversHaveTrailer` was a silent data loss: that flag
  // is set for the life of the page by the first read, so a tab opened before the deploy
  // kept dropping fleetGroup/assignedTrailerId from every save while still reporting
  // success — the user set a value, saw it accepted, and it was never written.
  try {
    const result = await run(all, true)
    driversHaveTrailer = true   // proven supported — re-enable it for reads too
    return resolveDriverPhotoUrl(result.data.updateDriver)
  } catch (err: unknown) {
    const partial = driverFromPartial(err, 'updateDriver')
    if (partial) return resolveDriverPhotoUrl(partial)

    if (isTrailerFieldUndefined(err)) {
      console.warn('[apiClient] backend has no assignedTrailerId/fleetGroup yet — saving without them')
      driversHaveTrailer = false
      const result = await run(withoutNewFields, false)
      return resolveDriverPhotoUrl(result.data.updateDriver)
    }
    if (isMotiveFieldUndefined(err)) {
      // Same silent-data-loss trap as above: retry WITHOUT the field rather than deciding
      // up-front from the flag, so a tab opened before the deploy still saves everything else.
      console.warn('[apiClient] backend has no motiveDriverId yet — saving without it')
      driversHaveMotive = false
      const result = await run(withoutMotive, false)
      return resolveDriverPhotoUrl(result.data.updateDriver)
    }
    if (isDispatcherFieldUndefined(err)) {
      console.warn('[apiClient] backend has no dispatcherPrimary/dispatcherBackup yet — saving without them')
      driversHaveDispatcher = false
      const result = await run(withoutDispatcher, false)
      return resolveDriverPhotoUrl(result.data.updateDriver)
    }
    throw err
  }
}

export async function deleteDriver(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteDriver($input: DeleteDriverInput!) { deleteDriver(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function listAuditLogs(): Promise<AuditLogEntry[]> {
  const result = await client.graphql({
    query: `query ListAuditLogs { listAuditLogs(limit: 10000) { items { ${AUDIT_FIELDS} } } }`,
  }) as { data: { listAuditLogs: { items: (Omit<AuditLogEntry, 'changes'> & { changes: string })[] } } }
  return (result.data.listAuditLogs.items ?? []).map((e) => ({
    ...e,
    changes: JSON.parse(e.changes ?? '{}'),
  }))
}

export async function createAuditLog(entry: {
  entityType: EntityType
  entityId: string
  action: AuditAction
  user: string
  changes: AuditLogEntry['changes']
}): Promise<void> {
  await client.graphql({
    query: `mutation CreateAuditLog($input: CreateAuditLogInput!) { createAuditLog(input: $input) { id } }`,
    variables: {
      input: {
        ...entry,
        changes: JSON.stringify(entry.changes),
      },
    },
  })
}

// ── Fuel transactions ─────────────────────────────────────────────────────────

export interface FuelTransaction {
  id: string
  transactionDate: string
  cardNumber: string
  invoiceNumber?: string
  unitNumber?: string
  truckId?: string
  driverName?: string
  odometer?: number
  locationName?: string
  city?: string
  state?: string
  fees?: number
  fuelType: string
  itemCategory?: string
  pricePerUnit: number
  quantity: number
  amount: number
  currency?: string
  sourceFile?: string
  importedAt?: string
  createdAt: string
  updatedAt: string
}

const FUEL_TX_FIELDS = `
  id transactionDate cardNumber invoiceNumber unitNumber truckId driverName
  odometer locationName city state fees fuelType itemCategory pricePerUnit quantity amount
  currency sourceFile importedAt createdAt updatedAt
`

export async function listFuelTransactions(filter?: {
  truckId?: string
  cardNumber?: string
  startDate?: string
  endDate?: string
}): Promise<FuelTransaction[]> {
  // Load all and filter client-side for simplicity (dataset is small enough)
  const result = await client.graphql({
    query: `query ListFuelTransactions { listFuelTransactions(limit: 10000) { items { ${FUEL_TX_FIELDS} } } }`,
  }) as { data: { listFuelTransactions: { items: FuelTransaction[] } } }
  let items = result.data.listFuelTransactions.items ?? []
  if (filter?.truckId)   items = items.filter((t) => t.truckId === filter.truckId)
  if (filter?.cardNumber) items = items.filter((t) => t.cardNumber === filter.cardNumber)
  if (filter?.startDate) items = items.filter((t) => t.transactionDate >= filter.startDate!)
  if (filter?.endDate)   items = items.filter((t) => t.transactionDate <= filter.endDate!)
  return items
}

export async function createFuelTransaction(
  input: Omit<FuelTransaction, 'id' | 'createdAt' | 'updatedAt'>
): Promise<FuelTransaction> {
  const result = await client.graphql({
    query: `mutation CreateFuelTransaction($input: CreateFuelTransactionInput!) { createFuelTransaction(input: $input) { ${FUEL_TX_FIELDS} } }`,
    variables: { input },
  }) as { data: { createFuelTransaction: FuelTransaction } }
  return result.data.createFuelTransaction
}

export async function updateFuelTransaction(
  id: string,
  patch: Partial<Omit<FuelTransaction, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<FuelTransaction> {
  const result = await client.graphql({
    query: `mutation UpdateFuelTransaction($input: UpdateFuelTransactionInput!) { updateFuelTransaction(input: $input) { ${FUEL_TX_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateFuelTransaction: FuelTransaction } }
  return result.data.updateFuelTransaction
}

export async function deleteFuelTransaction(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteFuelTransaction($input: DeleteFuelTransactionInput!) { deleteFuelTransaction(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

/**
 * One-time cleanup: finds and deletes duplicate FuelTransaction records, keeping the
 * oldest (smallest createdAt) of each. Uses the shared invoice-agnostic identity
 * (date|card|fuelType|amount|gallons) so the same fill re-imported with a different
 * invoice number is recognised as a duplicate.
 *
 * Returns counts of removed vs kept records.
 */
export async function cleanupDuplicateFuelTransactions(): Promise<{ removed: number; kept: number }> {
  const all = await listFuelTransactions()
  const seen = new Map<string, FuelTransaction>()
  const toDelete: string[] = []

  // Sort oldest-first so we always keep the original import
  const sorted = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  for (const tx of sorted) {
    const key = fuelDedupKey(tx)
    if (seen.has(key)) toDelete.push(tx.id)
    else seen.set(key, tx)
  }

  console.log(`[cleanupDuplicates] ${all.length} total, ${toDelete.length} duplicates to remove`)
  for (const id of toDelete) await deleteFuelTransaction(id)
  return { removed: toDelete.length, kept: seen.size }
}

/**
 * Is this fill already stored? Matches on the invoice-agnostic identity
 * (date + card + fuelType + amount + gallons) so the same fill re-uploaded with a
 * different invoice number is still skipped.
 */
export async function checkFuelTxExists(
  transactionDate: string,
  cardNumber: string,
  fuelType: string,
  amount: number,
  quantity: number,
): Promise<boolean> {
  const result = await client.graphql({
    query: `query ListFuelTransactions($filter: ModelFuelTransactionFilterInput) {
      listFuelTransactions(filter: $filter, limit: 1) { items { id } }
    }`,
    variables: {
      filter: {
        transactionDate: { eq: transactionDate },
        cardNumber:      { eq: cardNumber },
        fuelType:        { eq: fuelType },
        amount:          { eq: amount },
        quantity:        { eq: quantity },
      },
    },
  }) as { data: { listFuelTransactions: { items: { id: string }[] } } }
  return (result.data.listFuelTransactions.items ?? []).length > 0
}

// ── Intake items ──────────────────────────────────────────────────────────────

import type { IntakeItem, IntakeStatus } from '@/types'

const INTAKE_FIELDS = `
  id source status assignedTo receivedAt fromEmail subject
  bodyText bodyHtml s3KeyPdfAttachments
  externalSource externalId externalUrl slackChannelId slackMessageTs
  gmailMessageId extractedMetadata builtLoadId proNumber notes createdAt updatedAt
  slackRepliedAt lastReplyText lastReplyAt lastReplyUser replyCount threadSyncedAt
`

export async function listIntakeItems(filter?: { assignedTo?: string; source?: string }): Promise<IntakeItem[]> {
  let filterArg = ''
  const vars: Record<string, unknown> = {}
  if (filter?.assignedTo) { filterArg = '(filter: { assignedTo: { eq: $assignedTo } })'; vars['assignedTo'] = filter.assignedTo }
  else if (filter?.source) { filterArg = '(filter: { source: { eq: $source } })'; vars['source'] = filter.source }

  const varDef = filter?.assignedTo ? '($assignedTo: String)' : filter?.source ? '($source: String)' : ''
  try {
    const result = await client.graphql({
      query: `query ListIntakeItems${varDef} { listIntakeItems${filterArg}(limit: 200) { items { ${INTAKE_FIELDS} } } }`,
      variables: vars,
    }) as { data: { listIntakeItems: { items: IntakeItem[] } } }
    return result.data.listIntakeItems.items ?? []
  } catch (err: unknown) {
    // AppSync returns partial errors (e.g. invalid enum on stale records) as a thrown object
    // with both .data and .errors — extract whatever valid items came back rather than blanking the UI
    const partial = (err as { data?: { listIntakeItems?: { items?: IntakeItem[] } } }).data
    if (partial?.listIntakeItems?.items) {
      console.warn('[listIntakeItems] partial errors (stale records?) — showing valid items', err)
      return partial.listIntakeItems.items.filter(Boolean) as IntakeItem[]
    }
    throw err
  }
}

export async function getIntakeItem(id: string): Promise<IntakeItem | null> {
  const result = await client.graphql({
    query: `query GetIntakeItem($id: ID!) { getIntakeItem(id: $id) { ${INTAKE_FIELDS} } }`,
    variables: { id },
  }) as { data: { getIntakeItem: IntakeItem | null } }
  return result.data.getIntakeItem
}

export async function updateIntakeItem(id: string, patch: {
  status?: IntakeStatus
  assignedTo?: string
  notes?: string
  builtLoadId?: string | null
  proNumber?: string | null
}): Promise<IntakeItem> {
  const result = await client.graphql({
    query: `mutation UpdateIntakeItem($input: UpdateIntakeItemInput!) { updateIntakeItem(input: $input) { ${INTAKE_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateIntakeItem: IntakeItem } }
  return result.data.updateIntakeItem
}

export async function deleteIntakeItem(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteIntakeItem($input: DeleteIntakeItemInput!) { deleteIntakeItem(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

/** Create a task/intake item by hand (externalSource 'manual'); shows in Tasks + the dashboard Open Tasks. */
export async function createIntakeItem(input: {
  source: 'IVAN_CARTAGE' | 'BCAT_LOGISTICS'
  subject: string
  assignedTo?: string | null
  bodyText?: string | null
}): Promise<IntakeItem> {
  const result = await client.graphql({
    query: `mutation CreateIntakeItem($input: CreateIntakeItemInput!) { createIntakeItem(input: $input) { ${INTAKE_FIELDS} } }`,
    variables: {
      input: {
        source: input.source,
        status: 'NEW',
        subject: input.subject,
        assignedTo: input.assignedTo ?? null,
        bodyText: input.bodyText ?? null,
        externalSource: 'manual',
        externalId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        receivedAt: new Date().toISOString(),
      },
    },
  }) as { data: { createIntakeItem: IntakeItem } }
  return result.data.createIntakeItem
}

// ── Factoring items ───────────────────────────────────────────────────────────

// Every field the UI reads. The OTR columns were missing here, which left OtrPanel
// permanently in its "not yet prepared" branch: the Lambda caches readiness on the
// row and the browser simply never asked for it.
const FACTORING_ITEM_FIELDS = `
  id proNumber status subject fromEmail receivedAt messageId createdAt updatedAt
  loadId otrManualFields otrReadiness
  brokerMcChecked brokerCheckResult brokerCheckedAt
  otrInvoiceId otrSubmittedAt otrSubmittedBy
  otrStatus otrScheduleId otrAmount otrStatusSyncedAt
  otrDocsUploaded otrError
  customerId manualReason manualSteps apEmail manualInvoicedAt
`
// Step F's columns: a row this system raised from an issued invoice rather than one an
// intake e-mail did. Its own flag, like every other generation here — one unhandled
// throw on a backend that predates the deploy empties the whole factoring queue.
const FACTORING_ITEM_V2_FIELDS = ['source', 'invoiceId', 'orderId', 'shipmentId']
let factoringItemsHaveTms = true

/** Every FactoringItem read or write, with step F's group dropped and retried pre-deploy. */
async function readFactoring<T>(run: (fields: string) => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await run(factoringItemsHaveTms ? `${FACTORING_ITEM_FIELDS} ${FACTORING_ITEM_V2_FIELDS.join(' ')}` : FACTORING_ITEM_FIELDS)
    } catch (err) {
      if (!factoringItemsHaveTms || !fieldNamed(FACTORING_ITEM_V2_FIELDS, err)) throw err
      console.warn('[apiClient] backend has no TMS fields on FactoringItem yet — querying without them until deploy')
      factoringItemsHaveTms = false
    }
  }
}

/**
 * AppSync hands an `a.json()` column back as a JSON *string*, so the three JSON columns
 * on a FactoringItem have to be parsed before anything can read a property off them.
 * A column that will not parse is dropped rather than thrown: one malformed cached
 * readiness must not blank the whole factoring queue.
 */
const FACTORING_JSON_FIELDS = ['otrManualFields', 'otrReadiness', 'otrDocsUploaded', 'manualSteps'] as const

function parseFactoringJson(item: FactoringItem): FactoringItem {
  const out = { ...item } as unknown as Record<string, unknown>
  for (const field of FACTORING_JSON_FIELDS) {
    const value = out[field]
    if (typeof value !== 'string') continue
    try {
      out[field] = JSON.parse(value)
    } catch {
      console.warn('[factoring] could not parse', field, 'on', item.id)
      out[field] = null
    }
  }
  return out as unknown as FactoringItem
}

/** Fetch every FactoringItem page so direct DynamoDB email inserts are never missed. */
export async function listFactoringItems(): Promise<FactoringItem[]> {
  return readFactoring(async (fields) => {
    const items: FactoringItem[] = []
    let nextToken: string | null = null
    do {
      const result = await client.graphql({
        query: `query ListFactoringItems($nextToken: String) { listFactoringItems(limit: 1000, nextToken: $nextToken) { items { ${fields} } nextToken } }`,
        variables: { nextToken },
      }) as { data: { listFactoringItems: { items: (FactoringItem | null)[]; nextToken?: string | null } } }
      const page = result.data.listFactoringItems
      for (const item of page.items ?? []) {
        if (item) items.push(parseFactoringJson(item))
      }
      nextToken = page.nextToken ?? null
    } while (nextToken)
    return items
  })
}

/** Staff may update status; email intake owns creation. */
export async function updateFactoringItem(
  id: string,
  patch: { status: FactoringItemStatus },
): Promise<FactoringItem> {
  return readFactoring(async (fields) => {
    const result = await client.graphql({
      query: `mutation UpdateFactoringItem($input: UpdateFactoringItemInput!) { updateFactoringItem(input: $input) { ${fields} } }`,
      variables: { input: { id, ...patch } },
    }) as { data: { updateFactoringItem: FactoringItem } }
    return parseFactoringJson(result.data.updateFactoringItem)
  })
}

/**
 * Write the field values a human typed on a factoring queue row.
 *
 * These are the top precedence tier in src/lib/otrInvoice.ts, which existed with no
 * writer at all: the queue could show a field as missing and offer no way to supply
 * it. Overrides replace the whole map, so the caller merges first; a value trimmed to
 * empty is removed rather than stored blank, so clearing a bad entry falls back to
 * whatever the load or the rate confirmation says.
 *
 * The column is `a.json()`, which AppSync expects as a JSON string on the way in.
 */
export async function setFactoringManualFields(
  id: string,
  fields: Record<string, string>,
): Promise<FactoringItem> {
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    const v = (value ?? '').trim()
    if (v) cleaned[key] = v
  }
  return readFactoring(async (selection) => {
    const result = await client.graphql({
      query: `mutation UpdateFactoringItem($input: UpdateFactoringItemInput!) { updateFactoringItem(input: $input) { ${selection} } }`,
      variables: { input: { id, otrManualFields: JSON.stringify(cleaned) } },
    }) as { data: { updateFactoringItem: FactoringItem } }
    return parseFactoringJson(result.data.updateFactoringItem)
  })
}

/** The model authorizes deletion only for the Cognito ADMIN group. */
export async function deleteFactoringItem(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteFactoringItem($input: DeleteFactoringItemInput!) { deleteFactoringItem(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Vendor accounts payable ──────────────────────────────────────────────────

const VENDOR_PAYABLE_FIELDS = `
  id status source sourceInvoiceId sourceMessageId subject vendor invoiceNumber
  amount invoiceDate dueDate vendorEmail confirmationSentAt confirmationSentTo extractedAt extractionNote description fromEmail attachments receivedAt
  paymentMethod paymentDate paymentReference paidBy paidAt createdAt updatedAt
`
type VendorPayableRecord = Omit<VendorPayable, 'attachments'> & {
  attachments?: VendorApAttachment[] | string | null
}

function vendorPayableFromRecord(record: VendorPayableRecord): VendorPayable {
  const attachments = typeof record.attachments === 'string'
    ? JSON.parse(record.attachments) as VendorApAttachment[]
    : record.attachments ?? []
  return { ...record, attachments }
}

export async function listVendorPayables(): Promise<VendorPayable[]> {
  const items: VendorPayable[] = []
  let nextToken: string | null = null
  do {
    const result = await client.graphql({
      query: `query ListVendorPayables($nextToken: String) { listVendorPayables(limit: 1000, nextToken: $nextToken) { items { ${VENDOR_PAYABLE_FIELDS} } nextToken } }`,
      variables: { nextToken },
    }) as { data: { listVendorPayables: { items: (VendorPayableRecord | null)[]; nextToken?: string | null } } }
    const page = result.data.listVendorPayables
    for (const item of page.items) if (item) items.push(vendorPayableFromRecord(item))
    nextToken = page.nextToken ?? null
  } while (nextToken)
  return items
}

export async function getVendorPayable(id: string): Promise<VendorPayable> {
  const result = await client.graphql({
    query: `query GetVendorPayable($id: ID!) { getVendorPayable(id: $id) { ${VENDOR_PAYABLE_FIELDS} emailBody } }`,
    variables: { id },
  }) as { data: { getVendorPayable: VendorPayableRecord | null } }
  if (!result.data.getVendorPayable) throw new Error('This invoice is no longer in Vendor AP. Refresh the queue.')
  return vendorPayableFromRecord(result.data.getVendorPayable)
}

async function vendorPayableAction(
  action: 'SEND_MAINTENANCE' | 'UPDATE_DETAILS' | 'COMPLETE' | 'REOPEN',
  args: { id?: string; maintenanceInvoiceId?: string; input?: object },
): Promise<{ item: VendorPayable; duplicate: boolean }> {
  try {
    const result = await client.graphql({
      query: `mutation ManageVendorPayable($action: String!, $id: ID, $maintenanceInvoiceId: ID, $input: AWSJSON) {
        manageVendorPayable(action: $action, id: $id, maintenanceInvoiceId: $maintenanceInvoiceId, input: $input)
      }`,
      variables: { ...args, action, input: args.input ? JSON.stringify(args.input) : undefined },
    }) as { data: { manageVendorPayable: string | { item: VendorPayableRecord; duplicate?: boolean } } }
    const raw = result.data.manageVendorPayable
    const value = typeof raw === 'string' ? JSON.parse(raw) as { item: VendorPayableRecord; duplicate?: boolean } : raw
    if (!value?.item) throw new Error('Vendor AP did not return the saved invoice. Refresh and try again.')
    return { item: vendorPayableFromRecord(value.item), duplicate: value.duplicate === true }
  } catch (err) {
    throw new Error(vendorApErrorMessage(err), { cause: err })
  }
}

/** Vendor AP mutations surface the Lambda's own message; nothing here is a screenshot import. */
function vendorApErrorMessage(err: unknown): string {
  return graphqlErrorText(err) || 'Vendor AP request failed. Refresh the queue and try again.'
}

export async function sendMaintenanceInvoiceToVendorAp(maintenanceInvoiceId: string): Promise<{ item: VendorPayable; duplicate: boolean }> {
  return vendorPayableAction('SEND_MAINTENANCE', { maintenanceInvoiceId })
}

export async function updateVendorPayable(id: string, patch: VendorPayableDetails, expectedUpdatedAt: string): Promise<VendorPayable> {
  return (await vendorPayableAction('UPDATE_DETAILS', { id, input: { ...patch, expectedUpdatedAt } })).item
}

export async function completeVendorPayable(id: string, payment: VendorPayment, expectedUpdatedAt: string): Promise<VendorPayable> {
  return (await vendorPayableAction('COMPLETE', { id, input: { ...payment, expectedUpdatedAt } })).item
}

export async function reopenVendorPayable(id: string, expectedUpdatedAt: string): Promise<VendorPayable> {
  return (await vendorPayableAction('REOPEN', { id, input: { expectedUpdatedAt } })).item
}

export async function deleteVendorPayable(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteVendorPayable($input: DeleteVendorPayableInput!) { deleteVendorPayable(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

export async function getVendorApAttachmentUrl(key: string): Promise<string> {
  if (!key.startsWith('intake-pdfs/vendor-ap/')) throw new Error('Invalid Vendor AP attachment')
  return getIntakePdfUrl(key)
}


// ── Team members / helpers ───────────────────────────────────────────────────━

/**
 * The task a NEEDS-TO-BE-MOVED appointment creates: an IntakeItem assigned to Dennis,
 * shown on the Appt Changes page. externalId carries load+stop so the record is
 * traceable; the timestamp suffix lets the same stop be re-flagged after a past task
 * was completed without colliding with it.
 */
export const APPT_MOVE_ASSIGNEE = 'dennis@bcatcorp.com'
export const APPT_MOVE_PREFIX = 'appt-move:'
export const APPT_TASK_PREFIX = 'appt-task:'

/**
 * A workflow task on the Appt Changes queue — used for the Batory ladder: Dennis's
 * "request pickup for 12pm" on load build, Ruben's "pick the delivery time", and
 * Dennis's "book the delivery for X" once Ruben has picked.
 */
export async function createApptTask(args: {
  loadId: string
  kind: 'request_pickup' | 'pick_delivery_time' | 'book_delivery'
  assignee: string
  subject: string
  bodyText: string
  aljexId?: string | null
}): Promise<IntakeItem> {
  const result = await client.graphql({
    query: `mutation CreateIntakeItem($input: CreateIntakeItemInput!) { createIntakeItem(input: $input) { ${INTAKE_FIELDS} } }`,
    variables: {
      input: {
        source: 'IVAN_CARTAGE', status: 'NEW',
        subject: args.subject, bodyText: args.bodyText,
        assignedTo: args.assignee, externalSource: 'manual',
        externalId: `${APPT_TASK_PREFIX}${args.kind}:${args.loadId}:${Date.now()}`,
        proNumber: args.aljexId ?? null, builtLoadId: args.loadId,
        receivedAt: new Date().toISOString(),
      },
    },
  }) as { data: { createIntakeItem: IntakeItem } }
  return result.data.createIntakeItem
}

export async function createApptMoveTask(args: {
  loadId: string
  stopId: string
  stopKind: 'pickup' | 'delivery'
  aljexId?: string | null
  pickupNumber?: string | null
  customer?: string | null
  location?: string | null
  apptLabel?: string | null
  actorName?: string | null
}): Promise<IntakeItem> {
  const kind = args.stopKind === 'delivery' ? 'Delivery' : 'Pickup'
  const ref = [args.aljexId ? `Pro# ${args.aljexId}` : null, args.customer].filter(Boolean).join(' · ')
  const result = await client.graphql({
    query: `mutation CreateIntakeItem($input: CreateIntakeItemInput!) { createIntakeItem(input: $input) { ${INTAKE_FIELDS} } }`,
    variables: {
      input: {
        source: 'IVAN_CARTAGE',
        status: 'NEW',
        subject: `Move ${kind.toLowerCase()} appt — ${ref || 'load'}`,
        bodyText: [
          `${kind} appointment needs to be MOVED.`,
          args.apptLabel ? `Currently booked: ${args.apptLabel}` : null,
          args.location ? `Location: ${args.location}` : null,
          args.pickupNumber ? `PU# ${args.pickupNumber}` : null,
          args.actorName ? `Flagged by ${args.actorName}` : null,
        ].filter(Boolean).join('\n'),
        assignedTo: APPT_MOVE_ASSIGNEE,
        externalSource: 'manual',
        externalId: `${APPT_MOVE_PREFIX}${args.loadId}:${args.stopId}:${Date.now()}`,
        proNumber: args.aljexId ?? null,
        builtLoadId: args.loadId,
        receivedAt: new Date().toISOString(),
      },
    },
  }) as { data: { createIntakeItem: IntakeItem } }
  return result.data.createIntakeItem
}

// ── Directory: customers, locations, divisions, settings ─────────────────────
//
// Every write goes through the tmsDirectoryActions Lambda (server-side invariants: CAS on
// updatedAt, no links to archived/merged records, geocode proof). Reads use the generated
// list queries. Errors propagate — a directory that fails to load must say so, not render
// empty.

export type { CustomerRecord, LocationRecord, Division, TmsSettings, GeocodeResult, AutocompleteSuggestion, LocationMergePreview, LocationMergeJob } from '@/types/tms'

const CUSTOMER_FIELDS_BASE = `
  id name contactName contactEmail contactPhone notes
  mcNumber dotNumber factored billingEmail billingContactName billingPhone billingAddress
  paymentTermsDays creditLimitCents creditHoldFlag requiredDocsForInvoice
  defaultDivisionKey defaultSalesRepId aliases normalizedName active apptWorkflow mergedIntoId
  createdAt updatedAt
`
const CUSTOMER_V2_FIELDS = [
  'status', 'statusReason', 'statusChangedAt', 'statusChangedBy', 'replacementCustomerId',
  'leadSource', 'industry', 'serviceTier', 'website',
  'freeCreditRequired', 'creditUsageWarningBps', 'maxDaysLate',
  'contacts', 'billToParties', 'requiredReferences', 'chargeCodeOverrides', 'defaultCharges',
  'pricingDefaults', 'quotingDefaults',
  'rateConTerms', 'teamKey', 'operatedById', 'accountOwnerIds',
  'invoiceFrequency', 'visibilityPrefs', 'gpSplitBps',
]
const CUSTOMER_JSON_FIELDS: (keyof CustomerRecord)[] = ['billingAddress', 'contacts', 'billToParties', 'requiredReferences', 'chargeCodeOverrides', 'defaultCharges', 'pricingDefaults', 'quotingDefaults', 'visibilityPrefs']
let customersHaveV2 = true
const customerFields = () => customersHaveV2 ? `${CUSTOMER_FIELDS_BASE} ${CUSTOMER_V2_FIELDS.join(' ')}` : CUSTOMER_FIELDS_BASE
function customerFieldUndefined(err: unknown): boolean {
  const msg = safeStringify(err)
  return CUSTOMER_V2_FIELDS.some((f) => new RegExp(`['"]${f}['"]`).test(msg))
}

const LOCATION_FIELDS = `
  id name city customerName apptContactName apptContactEmail apptContactPhone notes
  street state zip country lat lng timezone geohash6 placeId geocodedAt geocodeExpiresAt
  facilityType hours apptRule apptLeadTimeHours dockNotes lumperNotes detentionNotes
  contacts driverNotes customerIds aliases normalizedName normalizedAddress mergedIntoId mergeJobId active
  createdAt updatedAt
`
const DIVISION_FIELDS = `
  id key name legalName mcNumber dotNumber scac remitToName remitToAddress remitToEmail
  invoicePrefix fleetGroup active createdAt updatedAt
`

const TMS_SETTINGS_FIELDS_BASE = `id marginFloorBps defaultPaymentTermsDays accessorialCodes loadStatusRules invoiceNumberFormat autoClearPastAppts createdAt updatedAt`
const TMS_SETTINGS_V2_FIELDS = [
  'defaultCreditLimitCents', 'defaultFreeCreditRequired', 'defaultCreditUsageWarningBps', 'defaultMaxDaysLate',
  'requireCustomerApproval', 'defaultRequiredDocs', 'defaultRequiredReferences', 'chargeCodes', 'rateConTerms',
]
// Step B's settings. A separate flag from V2 so a backend that has the credit fields
// but not these keeps serving the credit ones instead of losing both.
const TMS_SETTINGS_V3_FIELDS = [
  'shipmentPrefix', 'nextShipmentNumber', 'cancelDeleteAdminOnly',
  'arUnbilledStage', 'apInReviewStage', 'defaultMode',
]
// Step C's carrier booking settings. Its own flag again, for the same reason.
const TMS_SETTINGS_V4_FIELDS = [
  'allowedCarrierStatuses', 'requireCarrierApproval', 'requiredCarrierDocs',
  'bookingRequiredFields', 'defaultCarrierTermsDays', 'quickPayTiers',
  'rateConExpiryHours', 'rateConRequiredFields', 'insuranceWarnDays',
]
// Step D's tracking and check-call settings. Same treatment once more.
const TMS_SETTINGS_V5_FIELDS = [
  'checkCallDefaultIntervalHours', 'checkCallGraceMinutes', 'checkCallNotifyChannel',
  'checkCallSlackChannelId', 'trackingLinkExpiryHours', 'customerLinkExpiryDays',
  'customerLinkShowsCarrier', 'customerLinkShowsPosition', 'trackingContact', 'trackingSmsTemplate',
]
// Step E's document and notice settings. Its own flag again, for the same reason.
const TMS_SETTINGS_V6_FIELDS = [
  'milestoneNoticesEnabled', 'podRequestEnabled', 'requiredCarrierUploadTypes', 'uploadLinkExpiryDays',
  'milestoneEmailTemplate', 'podRequestEmailTemplate', 'bolTerms', 'documentDeleteAdminOnly',
]
// Step F's AR settings. Its own flag again, for the same reason.
const TMS_SETTINGS_V7_FIELDS = [
  'nextInvoiceNumber', 'invoiceTerms', 'invoiceEmailTemplate', 'invoiceAttachTypes',
  'factorRemitTo', 'arPostingAdminOnly', 'invoiceBatchEmail',
]
// Step G's AP settings. Its own flag again, for the same reason.
const TMS_SETTINGS_V8_FIELDS = [
  'apApprovalAdminOnly', 'apPostingAdminOnly', 'apRequireSignedRateCon',
  'remittanceEmailTemplate', 'apBillDocsRequired',
]
// Step H's quotes & rates settings. Its own flag again, for the same reason.
const TMS_SETTINGS_V9_FIELDS = [
  'hoursToQuote', 'offerExpiryHours', 'quoteNumberFormat', 'nextQuoteNumber',
  'quoteEmailTemplate', 'counterEmailTemplate', 'offerRequestEmailTemplate',
  'quoteTermsText', 'quoteBelowMinMarginAdminOnly', 'quoteOffersCarrierSeesBookNow',
]
const TMS_SETTINGS_JSON_FIELDS: (keyof TmsSettings)[] = ['accessorialCodes', 'loadStatusRules', 'defaultRequiredReferences', 'chargeCodes', 'quickPayTiers', 'trackingContact', 'factorRemitTo']
let settingsHaveV2 = true
let settingsHaveV3 = true
let settingsHaveV4 = true
let settingsHaveV5 = true
let settingsHaveV6 = true
let settingsHaveV7 = true
let settingsHaveV8 = true
let settingsHaveV9 = true
const tmsSettingsFields = () => [
  TMS_SETTINGS_FIELDS_BASE,
  settingsHaveV2 ? TMS_SETTINGS_V2_FIELDS.join(' ') : '',
  settingsHaveV3 ? TMS_SETTINGS_V3_FIELDS.join(' ') : '',
  settingsHaveV4 ? TMS_SETTINGS_V4_FIELDS.join(' ') : '',
  settingsHaveV5 ? TMS_SETTINGS_V5_FIELDS.join(' ') : '',
  settingsHaveV6 ? TMS_SETTINGS_V6_FIELDS.join(' ') : '',
  settingsHaveV7 ? TMS_SETTINGS_V7_FIELDS.join(' ') : '',
  settingsHaveV8 ? TMS_SETTINGS_V8_FIELDS.join(' ') : '',
  settingsHaveV9 ? TMS_SETTINGS_V9_FIELDS.join(' ') : '',
].filter(Boolean).join(' ')
const fieldNamed = (names: string[], err: unknown) => {
  const msg = safeStringify(err)
  return names.some((f) => new RegExp(`['"]${f}['"]`).test(msg))
}
const MERGE_JOB_FIELDS = `id sourceId targetId status processedCount remainingCount error createdAt updatedAt`

// Both custom-op wrappers rethrow AppSync's `{errors:[…]}` payload as an Error carrying
// the Lambda's message, so every caller's toast shows the real reason, not `[object Object]`.
async function directoryAction<T>(action: string, input: unknown): Promise<T> {
  let r: { data: { tmsDirectoryActions: unknown } }
  try {
    r = await client.graphql({
      query: `mutation TmsDirectoryActions($action: String!, $input: AWSJSON!) { tmsDirectoryActions(action: $action, input: $input) }`,
      variables: { action, input: JSON.stringify(input) },
    }) as { data: { tmsDirectoryActions: unknown } }
  } catch (err) {
    throw new Error(graphqlErrorText(err) || `${action} failed`, { cause: err })
  }
  const v = unwrapJson(r.data.tmsDirectoryActions)
  if (v == null) throw new Error(`${action} returned no result`)
  return v as T
}

/** AWSJSON columns arrive as strings through the generated list queries. */
function unwrapJsonFields<T extends object>(row: T, keys: (keyof T)[]): T {
  const out = { ...row }
  for (const key of keys) if (out[key] != null) out[key] = unwrapJson(out[key]) as T[typeof key]
  return out
}

async function listAll<T>(name: string, fields: string, limit: number): Promise<T[]> {
  const rows: T[] = []
  let nextToken: string | null = null
  do {
    const r = await client.graphql({
      query: `query ${name}($nextToken: String) { ${name}(limit: ${limit}, nextToken: $nextToken) { items { ${fields} } nextToken } }`,
      variables: { nextToken },
    }) as { data: Record<string, { items: (T | null)[]; nextToken?: string | null }> }
    const page = r.data[name]
    for (const item of page.items) if (item) rows.push(item)
    nextToken = page.nextToken ?? null
  } while (nextToken)
  return rows
}

// Customer.apptWorkflow decides the appointment ladder for every load linked to it. The
// policy is stamped onto loads at read time (never persisted) so the calendar, Appts
// board and drawer read one field; this map is refreshed by every customer read/write.
const customerPolicies: Record<string, CustomerRecord['apptWorkflow']> = {}
function rememberCustomerPolicy(c: CustomerRecord): CustomerRecord {
  customerPolicies[c.id] = c.apptWorkflow ?? null
  return c
}
/** Stamp the linked customer's appointment policy (from the last customer read) onto a load. */
export function withCustomerPolicy<T extends Pick<Load, 'customerId' | 'customerApptWorkflow'>>(load: T): T {
  return { ...load, customerApptWorkflow: load.customerId ? customerPolicies[load.customerId] ?? null : null }
}

/** Active customers only unless asked; archived and merged records stay out of pickers. */
export async function listCustomers(opts?: { includeArchived?: boolean }): Promise<CustomerRecord[]> {
  const run = async () => (await listAll<CustomerRecord>('listCustomers', customerFields(), 1000))
    .map((c) => rememberCustomerPolicy(unwrapJsonFields(c, CUSTOMER_JSON_FIELDS)))

  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await run()
      return opts?.includeArchived ? rows : rows.filter(isActiveDirectoryRecord)
    } catch (err) {
      if (attempt >= 2 || !customersHaveV2 || !customerFieldUndefined(err)) throw err
      console.warn('[apiClient] backend has no Customer v2 fields yet — querying without them until deploy')
      customersHaveV2 = false
    }
  }
}
export async function createCustomer(input: Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<CustomerRecord> {
  return rememberCustomerPolicy(await directoryAction<CustomerRecord>('UPSERT_CUSTOMER', input))
}
/** `expectedUpdatedAt` = the record the caller last saw; the server refuses stale writes. */
export async function updateCustomer(id: string, patch: Partial<Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'>>, expectedUpdatedAt: string): Promise<CustomerRecord> {
  return rememberCustomerPolicy(await directoryAction<CustomerRecord>('UPSERT_CUSTOMER', { id, expectedUpdatedAt, ...patch }))
}
export async function archiveCustomer(id: string, expectedUpdatedAt: string): Promise<CustomerRecord> {
  return rememberCustomerPolicy(await directoryAction<CustomerRecord>('ARCHIVE_CUSTOMER', { id, expectedUpdatedAt }))
}
/** Status transitions go through a dedicated action so CAS and transition rules live server-side. */
export async function setCustomerStatus(
  id: string,
  expectedUpdatedAt: string,
  input: { status: CustomerRecord['status']; reason?: string; replacementCustomerId?: string },
): Promise<CustomerRecord> {
  return rememberCustomerPolicy(await directoryAction<CustomerRecord>('SET_CUSTOMER_STATUS', { id, expectedUpdatedAt, ...input }))
}

export async function listLocations(opts?: { includeArchived?: boolean }): Promise<LocationRecord[]> {
  // driverNotes is AWSJSON too: the driver app appends to it as a native list, and
  // AppSync hands that back as a JSON STRING. Left wrapped, the load drawer called
  // .map on it and blanked the page for every load touching that location.
  const rows = (await listAll<LocationRecord>('listLocations', LOCATION_FIELDS, 1000)).map((l) => unwrapJsonFields(l, ['contacts', 'driverNotes']))
  return opts?.includeArchived ? rows : rows.filter(isActiveDirectoryRecord)
}
/**
 * Coordinates are accepted only with the `geocodeToken` the tmsGeocode call returned for
 * them; a plain postal address without coordinates is always fine.
 */
export async function createLocation(input: Omit<LocationRecord, 'id' | 'createdAt' | 'updatedAt'> & { geocodeToken?: string }): Promise<LocationRecord> {
  return directoryAction<LocationRecord>('UPSERT_LOCATION', input)
}
export async function updateLocation(id: string, patch: Partial<Omit<LocationRecord, 'id' | 'createdAt' | 'updatedAt'>> & { geocodeToken?: string }, expectedUpdatedAt: string): Promise<LocationRecord> {
  return directoryAction<LocationRecord>('UPSERT_LOCATION', { id, expectedUpdatedAt, ...patch })
}
export async function archiveLocation(id: string, expectedUpdatedAt: string): Promise<LocationRecord> {
  return directoryAction<LocationRecord>('ARCHIVE_LOCATION', { id, expectedUpdatedAt })
}

// ── Location merge — a resumable job, never a single transaction ──────────────
export async function previewLocationMerge(sourceId: string, targetId: string): Promise<LocationMergePreview> {
  return directoryAction<LocationMergePreview>('PREVIEW_MERGE_LOCATIONS', { sourceId, targetId })
}
export async function startLocationMerge(sourceId: string, targetId: string): Promise<LocationMergeJob> {
  return directoryAction<LocationMergeJob>('MERGE_LOCATIONS', { sourceId, targetId })
}
export async function resumeLocationMerge(jobId: string): Promise<LocationMergeJob> {
  return directoryAction<LocationMergeJob>('RESUME_MERGE', { jobId })
}
export async function listLocationMergeJobs(): Promise<LocationMergeJob[]> {
  return listAll<LocationMergeJob>('listDirectoryMergeJobs', MERGE_JOB_FIELDS, 1000)
}

// ── Divisions & TMS settings (ADMIN writes; nothing is seeded with guessed values) ──
export async function listDivisions(): Promise<Division[]> {
  return (await listAll<Division>('listDivisions', DIVISION_FIELDS, 1000)).map((d) => unwrapJsonFields(d, ['remitToAddress']))
}
export async function saveDivision(input: Omit<Division, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }, expectedUpdatedAt?: string): Promise<Division> {
  return directoryAction<Division>('SAVE_DIVISION', { expectedUpdatedAt, ...input })
}
export async function getTmsSettings(): Promise<TmsSettings | null> {
  const run = async () => {
    const r = await client.graphql({
      query: `query GetTmsSettings { getTmsSettings(id: "default") { ${tmsSettingsFields()} } }`,
    }) as { data: { getTmsSettings: TmsSettings | null } }
    return r.data.getTmsSettings ? unwrapJsonFields(r.data.getTmsSettings, TMS_SETTINGS_JSON_FIELDS) : null
  }

  // Each generation drops on its own, so a backend missing only the newest group
  // keeps serving every older one.
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      if (attempt >= 8) throw err
      if (settingsHaveV9 && fieldNamed(TMS_SETTINGS_V9_FIELDS, err)) {
        console.warn('[apiClient] backend has no TmsSettings quote fields yet — querying without them until deploy')
        settingsHaveV9 = false
        continue
      }
      if (settingsHaveV8 && fieldNamed(TMS_SETTINGS_V8_FIELDS, err)) {
        console.warn('[apiClient] backend has no TmsSettings AP fields yet — querying without them until deploy')
        settingsHaveV8 = false
        continue
      }
      if (settingsHaveV7 && fieldNamed(TMS_SETTINGS_V7_FIELDS, err)) {
        console.warn('[apiClient] backend has no TmsSettings AR fields yet — querying without them until deploy')
        settingsHaveV7 = false
        continue
      }
      if (settingsHaveV6 && fieldNamed(TMS_SETTINGS_V6_FIELDS, err)) {
        console.warn('[apiClient] backend has no TmsSettings document fields yet — querying without them until deploy')
        settingsHaveV6 = false
        continue
      }
      if (settingsHaveV5 && fieldNamed(TMS_SETTINGS_V5_FIELDS, err)) {
        console.warn('[apiClient] backend has no TmsSettings tracking fields yet — querying without them until deploy')
        settingsHaveV5 = false
        continue
      }
      if (settingsHaveV4 && fieldNamed(TMS_SETTINGS_V4_FIELDS, err)) {
        console.warn('[apiClient] backend has no TmsSettings carrier fields yet — querying without them until deploy')
        settingsHaveV4 = false
        continue
      }
      if (settingsHaveV3 && fieldNamed(TMS_SETTINGS_V3_FIELDS, err)) {
        console.warn('[apiClient] backend has no TmsSettings shipment fields yet — querying without them until deploy')
        settingsHaveV3 = false
        continue
      }
      if (settingsHaveV2 && fieldNamed(TMS_SETTINGS_V2_FIELDS, err)) {
        console.warn('[apiClient] backend has no TmsSettings v2 fields yet — querying without them until deploy')
        settingsHaveV2 = false
        continue
      }
      throw err
    }
  }
}
export async function saveTmsSettings(patch: Partial<Omit<TmsSettings, 'id' | 'createdAt' | 'updatedAt'>>, expectedUpdatedAt?: string): Promise<TmsSettings> {
  return directoryAction<TmsSettings>('SAVE_SETTINGS', { id: 'default', expectedUpdatedAt, ...patch })
}

// ── Shipments · Orders · Load money (tmsShipmentActions) ─────────────────────
//
// Reads come straight off the generated queries and their GSIs; every write goes
// through the one Lambda, which owns the transaction across the five tables. The
// board polls — these models have no subscriptions.

export type {
  ShipmentRecord, OrderRecord, LoadCarrierRecord, LoadFinancialsRecord, LoadChargeRecord,
  LoadChargeInput, ShipmentBundle, ShipmentLoad, ShipmentStatus, LoadWorkflowStatus,
  ShipmentMode, ArStatus, AssignmentType,
} from '@/types/tms'

const SHIPMENT_FIELDS = `
  id number status previousStatus statusChangedAt statusChangedBy
  holdReason cancelReason tenderRejectReason deletedAt deletedBy
  customerId customerName mode parentShipmentId orderIds loadIds
  pickupAppt deliveryAppt pickupMonth originCity destinationCity searchKey source
  createdBy updatedBy version createdAt updatedAt
`
// Step E stamps the shipment when every load has delivered and remembers the last
// notice it sent. Its own flag, like the settings generations above: one unhandled
// throw on a pre-deploy backend empties the whole board.
const SHIPMENT_DELIVERY_FIELDS = ['deliveredAt', 'lastNoticeAt', 'lastNoticeStatus']
let shipmentsHaveDelivery = true

/** Every Shipment read, with step E's group dropped and retried if the backend predates it. */
async function readShipments<T>(run: (fields: string) => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await run(shipmentsHaveDelivery ? `${SHIPMENT_FIELDS} ${SHIPMENT_DELIVERY_FIELDS.join(' ')}` : SHIPMENT_FIELDS)
    } catch (err) {
      if (!shipmentsHaveDelivery || !fieldNamed(SHIPMENT_DELIVERY_FIELDS, err)) throw err
      console.warn('[apiClient] backend has no delivery fields on Shipment yet — querying without them until deploy')
      shipmentsHaveDelivery = false
    }
  }
}
const ORDER_FIELDS = `
  id shipmentId customerId customerName customerContactId customerRepId billToId costCenter
  mode rateType references equipmentType equipmentLengthFt specialRequirements freight
  customerNotes internalNotes customerRateCents revenueCents
  arStatus arStatusChangedAt invoiceId invoiceEarly readyToInvoiceAt pickupAppt
  createdBy updatedBy version createdAt updatedAt
`
const ORDER_JSON_FIELDS: (keyof OrderRecord)[] = ['references', 'specialRequirements', 'freight']
// Step E's cached verdict of the required-document gate. Same self-heal, same reason.
const ORDER_DOC_FIELDS = [
  'docsRequired', 'docsMissing', 'docsCheckedAt', 'docsOverrideAt', 'docsOverrideBy', 'docsOverrideNote',
]
let ordersHaveDocs = true
// Step F's cached invoice facts, so a board row can show the number and what is still
// owed without opening the Invoice. Its own flag and its own retry, one generation
// later than the document fields above.
const ORDER_AR_FIELDS = ['invoiceNumber', 'invoicedAt', 'paidAt', 'arBalanceCents', 'factoringItemId']
let ordersHaveAr = true

/** Every Order read, with each newer group dropped and retried if the backend predates it. */
async function readOrders<T>(run: (fields: string) => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await run([
        ORDER_FIELDS,
        ordersHaveDocs ? ORDER_DOC_FIELDS.join(' ') : '',
        ordersHaveAr ? ORDER_AR_FIELDS.join(' ') : '',
      ].filter(Boolean).join(' '))
    } catch (err) {
      if (ordersHaveAr && fieldNamed(ORDER_AR_FIELDS, err)) {
        console.warn('[apiClient] backend has no AR fields on Order yet — querying without them until deploy')
        ordersHaveAr = false
        continue
      }
      if (!ordersHaveDocs || !fieldNamed(ORDER_DOC_FIELDS, err)) throw err
      console.warn('[apiClient] backend has no document fields on Order yet — querying without them until deploy')
      ordersHaveDocs = false
    }
  }
}
const LOAD_CARRIER_FIELDS = `
  id loadId shipmentId kind status removalReason removedAt removedBy sequence
  carrierId carrierName carrierMc carrierRepId dispatcherName dispatcherPhone dispatcherEmail
  driverId driverName driverPhone driver2Name driver2Phone
  truckId truckNumber trailerId trailerNumber plates vin sealNumber tripNumber
  pickupEtaAt deliveryEtaAt priorDeliveryAt priorDeliveryNote
  rateConSignedAt rateConKey chargesFinalizedAt
  carrierRateCents costCents apStatus invoiceId createdBy updatedBy createdAt updatedAt
`
// Step C's booking layer on the assignment row: quick pay, the rate-con lifecycle and
// dispatch. One flag for the whole group — they deploy together — and the same self-heal
// as the settings generations, because one unhandled throw here blanks the shipment drawer.
const LOAD_CARRIER_V2_FIELDS = [
  'quickPay', 'quickPayDays', 'quickPayFeeBps', 'quickPayFeeCents', 'paymentTermsDays',
  'rateConStatus', 'rateConToken', 'rateConSentAt', 'rateConSentTo', 'rateConExpiresAt',
  'rateConDocumentId', 'rateConSignerName', 'rateConSignerIp', 'rateConVersion',
  'bookedAt', 'bookingWarnings', 'dispatchedAt', 'dispatchNote', 'removalNote',
]
let loadCarriersHaveCarrierV2 = true
// Step E's upload link, the carrier's outstanding paperwork and the rating the office
// gave them. A third generation with its own flag, because it deploys after step C's.
const LOAD_CARRIER_V3_FIELDS = [
  'uploadLinkId', 'podRequestedAt', 'docsMissing', 'ratingStars', 'ratingNote', 'ratedAt', 'ratedBy',
]
let loadCarriersHaveDocuments = true
// Step G's AP facts on the assignment: the sparse open marker, when the rung last moved,
// what is still owed on it and when it was paid. A fourth generation with its own flag.
const LOAD_CARRIER_V4_FIELDS = ['apOpen', 'apStatusChangedAt', 'apBalanceCents', 'apPaidAt']
let loadCarriersHaveAp = true
const loadCarrierFields = () => [
  LOAD_CARRIER_FIELDS,
  loadCarriersHaveCarrierV2 ? LOAD_CARRIER_V2_FIELDS.join(' ') : '',
  loadCarriersHaveDocuments ? LOAD_CARRIER_V3_FIELDS.join(' ') : '',
  loadCarriersHaveAp ? LOAD_CARRIER_V4_FIELDS.join(' ') : '',
].filter(Boolean).join(' ')

/** Every LoadCarrier read, with a group dropped and retried if the backend predates it. */
async function readLoadCarriers<T>(run: (fields: string) => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await run(loadCarrierFields())
    } catch (err) {
      if (loadCarriersHaveAp && fieldNamed(LOAD_CARRIER_V4_FIELDS, err)) {
        console.warn('[apiClient] backend has no AP fields on LoadCarrier yet — querying without them until deploy')
        loadCarriersHaveAp = false
        continue
      }
      if (loadCarriersHaveDocuments && fieldNamed(LOAD_CARRIER_V3_FIELDS, err)) {
        console.warn('[apiClient] backend has no document fields on LoadCarrier yet — querying without them until deploy')
        loadCarriersHaveDocuments = false
        continue
      }
      if (!loadCarriersHaveCarrierV2 || !fieldNamed(LOAD_CARRIER_V2_FIELDS, err)) throw err
      console.warn('[apiClient] backend has no carrier booking fields on LoadCarrier yet — querying without them until deploy')
      loadCarriersHaveCarrierV2 = false
    }
  }
}

/** The four index reads of the assignment table; `args` maps the generated arguments. */
function listLoadCarriersByIndex(name: string, args: Record<string, string>): Promise<LoadCarrierRecord[]> {
  return readLoadCarriers((fields) => listAllByIndex<LoadCarrierRecord>(name, args, fields, 1000))
}
const LOAD_FINANCIALS_FIELDS = `
  id loadId shipmentId orderId customerRateCents revenueCents carrierRateCents costCents
  profitCents marginBps topSpendCents targetBuyCents frozenAt frozenBy updatedBy version
  createdAt updatedAt
`
const LOAD_CHARGE_FIELDS = `
  id shipmentId side orderId loadId loadCarrierId code label calculatedBy
  rateCents count amountCents isRate release sortOrder note createdBy createdAt updatedAt
`

/**
 * Page a secondary-index query to the end. `args` maps the generated argument names to
 * their values; most index keys are Strings, but an enum-backed key (Shipment.status) is
 * generated as its own GraphQL type and AppSync rejects a `String!` variable there, so
 * `argTypes` names the exception.
 */
async function listAllByIndex<T>(
  name: string,
  args: Record<string, string>,
  fields: string,
  limit: number,
  argTypes: Record<string, string> = {},
): Promise<T[]> {
  const names = Object.keys(args)
  const decls = names.map((n) => `$${n}: ${argTypes[n] ?? 'String!'}`).join(', ')
  const passed = names.map((n) => `${n}: $${n}`).join(', ')
  const rows: T[] = []
  let nextToken: string | null = null
  do {
    const r = await client.graphql({
      query: `query ${name}(${decls}, $nextToken: String) { ${name}(${passed}, limit: ${limit}, nextToken: $nextToken) { items { ${fields} } nextToken } }`,
      variables: { ...args, nextToken },
    }) as { data: Record<string, { items: (T | null)[]; nextToken?: string | null }> }
    const page = r.data[name]
    for (const item of page.items) if (item) rows.push(item)
    nextToken = page.nextToken ?? null
  } while (nextToken)
  return rows
}

/**
 * Every shipment write. Same contract as `directoryAction`: the Lambda's own message
 * is rethrown, so a refusal ("customer is on credit hold") reaches the toast intact
 * instead of `[object Object]`.
 */
export async function shipmentAction<T>(action: string, input: unknown): Promise<T> {
  let r: { data: { tmsShipmentActions: unknown } }
  try {
    r = await client.graphql({
      query: `mutation TmsShipmentActions($action: String!, $input: AWSJSON!) { tmsShipmentActions(action: $action, input: $input) }`,
      variables: { action, input: JSON.stringify(input) },
    }) as { data: { tmsShipmentActions: unknown } }
  } catch (err) {
    throw new Error(graphqlErrorText(err) || `${action} failed`, { cause: err })
  }
  const v = unwrapJson(r.data.tmsShipmentActions)
  if (v == null) throw new Error(`${action} returned no result`)
  return v as T
}

// ── Writes ───────────────────────────────────────────────────────────────────
// Every one takes the action's input object verbatim and returns the whole
// ShipmentBundle, already parsed out of AWSJSON, so a caller swaps the response in
// rather than re-reading the shipment. `expectedUpdatedAt` is the CAS token: the
// record as the caller last saw it. It is optional only on the actions whose target
// row the board does not hold a copy of.

export interface CreateShipmentInput {
  customerId: string
  mode?: ShipmentMode
}
export async function createShipment(input: CreateShipmentInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('CREATE_SHIPMENT', input)
}

export interface SaveOrderFormInput {
  shipmentId: string
  expectedUpdatedAt: string
  order: Partial<Omit<OrderRecord, 'id' | 'shipmentId' | 'createdAt' | 'updatedAt'>>
  stops?: Stop[]
  charges?: LoadChargeInput[]
  loadFields?: Partial<ShipmentLoadFields> & { miles?: number | null; notes?: string | null }
}
export async function saveOrderForm(input: SaveOrderFormInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('SAVE_ORDER_FORM', input)
}

/** Read-only: what the customer owes today, and whether `projectedCents` would fit. */
export interface CheckCreditInput {
  customerId: string
  projectedCents?: number
}
export async function checkCredit(input: CheckCreditInput): Promise<CreditSummary> {
  return shipmentAction<CreditSummary>('CHECK_CREDIT', { projectedCents: 0, ...input })
}

export interface SubmitOrderInput {
  shipmentId: string
  expectedUpdatedAt: string
  carrierRepId?: string
}
export async function submitOrder(input: SubmitOrderInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('SUBMIT_ORDER', input)
}

/** UNCANCEL is its own verb: it restores `previousStatus`, it does not set one. */
export type ShipmentStatusAction = 'ON_HOLD' | 'OPEN' | 'CANCELED' | 'UNCANCEL'
export interface SetShipmentStatusInput {
  shipmentId: string
  expectedUpdatedAt: string
  status: ShipmentStatusAction
  reason?: string
}
export async function setShipmentStatus(input: SetShipmentStatusInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('SET_SHIPMENT_STATUS', input)
}

export interface SetLoadStatusInput {
  loadId: string
  status: LoadWorkflowStatus
  expectedUpdatedAt?: string
}
export async function setLoadStatus(input: SetLoadStatusInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('SET_LOAD_STATUS', input)
}

export async function deleteShipment(input: { shipmentId: string; expectedUpdatedAt: string }): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('DELETE_SHIPMENT', input)
}
export async function restoreShipment(input: { shipmentId: string; expectedUpdatedAt?: string }): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('RESTORE_SHIPMENT', input)
}

export interface TenderRespondInput {
  shipmentId: string
  expectedUpdatedAt: string
  decision: 'ACCEPT' | 'REJECT' | 'RESET'
  reason?: string
}
export async function tenderRespond(input: TenderRespondInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('TENDER_RESPOND', input)
}

export interface DuplicateShipmentCopy {
  pickupAppt: string
  deliveryAppt: string
}
export interface DuplicateShipmentInput {
  shipmentId: string
  copies: DuplicateShipmentCopy[]
  /** Carry the source shipment's carrier assignment onto every copy. */
  sameCarrier?: boolean
}
/** Returns the SOURCE shipment's bundle; the copies are new rows the board picks up. */
export async function duplicateShipment(input: DuplicateShipmentInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('DUPLICATE_SHIPMENT', input)
}

export type StopOp =
  | 'ADD' | 'REMOVE' | 'SWAP' | 'SET_APPT' | 'SET_REQUESTED'
  | 'SET_TIMES' | 'SET_TYPE' | 'SET_REFS' | 'SET_LOCATION'
export interface UpdateStopInput {
  loadId: string
  expectedUpdatedAt?: string
  op: StopOp
  stopId?: string
  patch?: Partial<Stop> & { withStopId?: string }
}
export async function updateStop(input: UpdateStopInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('UPDATE_STOP', input)
}

/**
 * Mirrors what `ASSIGN_ASSET` actually reads. The second driver is a nested object
 * server-side — the Lambda flattens it onto `LoadCarrier.driver2Name/driver2Phone` —
 * so sending flat `driver2Name` here would silently drop it.
 */
export interface AssignAssetInput {
  loadId: string
  expectedUpdatedAt?: string
  driverId: string
  driverName?: string | null
  driverPhone?: string | null
  truckId?: string | null
  truckNumber?: string | null
  trailerId?: string | null
  trailerNumber?: string | null
  driver2?: { name?: string | null; phone?: string | null } | null
}
export async function assignAsset(input: AssignAssetInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('ASSIGN_ASSET', input)
}

/**
 * Mirrors what `ASSIGN_CARRIER` actually reads. Equipment is the ORDER's (the customer
 * agreed to it), not the assignment's, so it is edited on the order form and is not
 * part of this call.
 */
export interface AssignCarrierInput {
  loadId: string
  expectedUpdatedAt?: string
  carrierName: string
  carrierMc?: string | null
  dispatcherName?: string | null
  dispatcherPhone?: string | null
  dispatcherEmail?: string | null
  driverName?: string | null
  driverPhone?: string | null
  truckNumber?: string | null
  trailerNumber?: string | null
  plates?: string | null
  vin?: string | null
  carrierRateCents?: number | null
}
export async function assignCarrier(input: AssignCarrierInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('ASSIGN_CARRIER', input)
}

/**
 * A removal always has a reason — it is the carrier history the next booker reads. The
 * reason is a code so the history is countable; anything the dispatcher wants to say in
 * their own words goes in `note` (<=250 chars).
 */
export type RemoveLoadCarrierReason =
  | 'CARRIER_CANNOT_TAKE' | 'GAVE_BACK' | 'REJECTED_RATE_CON'
  | 'CUSTOMER_NOT_READY' | 'CONSIGNEE_NOT_READY' | 'FORGOT_TO_BOUNCE'
  | 'OTHER'
export interface RemoveLoadCarrierInput {
  loadCarrierId: string
  outcome: 'BOUNCED' | 'TONU'
  reason: RemoveLoadCarrierReason
  note?: string
}
export async function removeLoadCarrier(input: RemoveLoadCarrierInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('REMOVE_LOAD_CARRIER', input)
}

/** Full replace per side. `expectedVersion` is the LoadFinancials row's. */
export interface RecalcChargesInput {
  shipmentId: string
  expectedVersion: number
  charges: LoadChargeInput[]
}
export async function recalcCharges(input: RecalcChargesInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('RECALC_CHARGES', input)
}

/** UNPAID and PAID belong to step F's invoicing and are refused here. */
export interface SetArStatusInput {
  orderId: string
  status: 'DOCS_NEEDED' | 'UNBILLED' | 'INVOICE_NOT_NEEDED'
  expectedUpdatedAt?: string
}
export async function setArStatus(input: SetArStatusInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('SET_AR_STATUS', input)
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listShipmentsByStatus(status: ShipmentStatus): Promise<ShipmentRecord[]> {
  // The index key is the Shipment.status enum, so the variable must be declared as one.
  return readShipments((fields) => listAllByIndex<ShipmentRecord>(
    'listShipmentByStatusAndPickupAppt', { status }, fields, 1000, { status: 'ShipmentStatus!' },
  ))
}
export async function listShipmentsByCustomer(customerId: string): Promise<ShipmentRecord[]> {
  return readShipments((fields) => listAllByIndex<ShipmentRecord>('listShipmentByCustomerIdAndPickupAppt', { customerId }, fields, 1000))
}
/** `month` is 'YYYY-MM' — the board's default window. */
export async function listShipmentsByMonth(month: string): Promise<ShipmentRecord[]> {
  return readShipments((fields) => listAllByIndex<ShipmentRecord>('listShipmentByPickupMonthAndPickupAppt', { pickupMonth: month }, fields, 1000))
}
export async function listShipments(): Promise<ShipmentRecord[]> {
  return readShipments((fields) => listAll<ShipmentRecord>('listShipments', fields, 1000))
}

export async function listOrders(): Promise<OrderRecord[]> {
  const rows = await readOrders((fields) => listAll<OrderRecord>('listOrders', fields, 1000))
  return rows.map((o) => unwrapJsonFields(o, ORDER_JSON_FIELDS))
}
export async function listOrdersByCustomer(customerId: string): Promise<OrderRecord[]> {
  const rows = await readOrders((fields) => listAllByIndex<OrderRecord>('listOrderByCustomerIdAndPickupAppt', { customerId }, fields, 1000))
  return rows.map((o) => unwrapJsonFields(o, ORDER_JSON_FIELDS))
}

/**
 * Everything one shipment page renders, in one round trip's worth of parallel reads.
 * LoadFinancials has no index — its `id` IS the load id, so each one is a GetItem.
 */
export async function getShipmentBundle(shipmentId: string): Promise<ShipmentBundle> {
  const [shipment, orders, loads, loadCarriers, charges, documents] = await Promise.all([
    getShipment(shipmentId),
    readOrders((fields) => listAllByIndex<OrderRecord>('listOrderByShipmentId', { shipmentId }, fields, 1000)),
    listAllByIndex<Load>('listLoadByShipmentId', { shipmentId }, loadFields(), 1000),
    listLoadCarriersByIndex('listLoadCarrierByShipmentId', { shipmentId }),
    listAllByIndex<LoadChargeRecord>('listLoadChargeByShipmentIdAndSortOrder', { shipmentId }, LOAD_CHARGE_FIELDS, 1000),
    listShipmentDocuments(shipmentId),
  ])
  if (!shipment) throw new Error('Shipment not found')
  const financials = (await Promise.all(loads.map((l) => getLoadFinancials(l.id))))
    .filter((f): f is LoadFinancialsRecord => f != null)
  return {
    shipment,
    orders: orders.map((o) => unwrapJsonFields(o, ORDER_JSON_FIELDS)),
    loads: loads.map((l) => unwrapJsonFields(l, ['stops'])),
    loadCarriers,
    charges,
    financials,
    documents,
  }
}

export async function getShipment(id: string): Promise<ShipmentRecord | null> {
  return readShipments(async (fields) => {
    const r = await client.graphql({
      query: `query GetShipment($id: ID!) { getShipment(id: $id) { ${fields} } }`,
      variables: { id },
    }) as { data: { getShipment: ShipmentRecord | null } }
    return r.data.getShipment
  })
}

export async function getLoadFinancials(loadId: string): Promise<LoadFinancialsRecord | null> {
  const r = await client.graphql({
    query: `query GetLoadFinancials($id: ID!) { getLoadFinancials(id: $id) { ${LOAD_FINANCIALS_FIELDS} } }`,
    variables: { id: loadId },
  }) as { data: { getLoadFinancials: LoadFinancialsRecord | null } }
  return r.data.getLoadFinancials
}

/** Just enough of every load to colour a board row: no stops, no rate-con URLs. */
export interface LoadBoardSummary {
  id: string
  shipmentId?: string | null
  orderId?: string | null
  status?: LoadWorkflowStatus | null
  assignmentType?: AssignmentType | null
  // Step D — what the board's Last update, Next check call and Exceptions columns read.
  lastKnownAt?: string | null
  lastKnownCity?: string | null
  lastKnownState?: string | null
  lastCheckCallAt?: string | null
  nextCheckCallAt?: string | null
  checkCallOpen?: 'OPEN' | null
  openIncidentCount?: number | null
}
const LOAD_SUMMARY_FIELDS = `
  id shipmentId orderId status assignmentType
  lastKnownAt lastKnownCity lastKnownState lastCheckCallAt
  nextCheckCallAt checkCallOpen openIncidentCount
`
export async function listLoadSummaries(): Promise<LoadBoardSummary[]> {
  if (!loadsHaveShipment) return []
  try {
    return await listAll<LoadBoardSummary>('listLoads', LOAD_SUMMARY_FIELDS, 10000)
  } catch (err) {
    if (!undefinedLoadFields(err).shipment) throw err
    console.warn('[apiClient] backend has no shipment fields on Load yet — board facets stay empty until deploy')
    loadsHaveShipment = false
    return []
  }
}

// ── Carriers (tmsCarrierActions) ─────────────────────────────────────────────
//
// The outside-carrier directory: who we may book, what they are insured for, who to
// pay and the paperwork behind it. Reads come off the generated queries and their
// GSIs; every write goes through the one Lambda, which owns the dedupe, the status
// table and the document protocol. No subscriptions — the board refreshes.

export type {
  CarrierRecord, CarrierContactRecord, CarrierPaymentMethodRecord, CarrierDocumentRecord,
  CarrierBundle, CarrierType, CarrierStatus, CarrierStatusReason, CarrierInactiveReason,
  CarrierDoNotUseReason, CarrierContactType, CarrierDocumentType, CarrierDocumentSource,
  CarrierPaymentMethodKind, CarrierPayeeType, AuthorityStatus, SafetyRating,
  ComplianceCheckStatus, CarrierEquipment, InsurancePolicy, InsurancePolicyType,
  QuickPayTier, RateConStatus, RateConRequiredField, BookingRequiredField,
} from '@/types/tms'

const CARRIER_FIELDS = `
  id name dbaName normalizedName type status statusReason statusNote statusChangedAt statusChangedBy
  mcNumber dotNumber scac einNumber inFmcsa
  authorityStatus authorityGrantedAt authorityExpiresAt
  safetyRating safetyRatingAt reviewType reviewedAt
  driverInspections driverOos vehicleInspections vehicleOos
  insurancePolicies equipment cargoTypes powerUnits trailerCount driverCount
  address phone email website dispatcherName dispatcherPhone dispatcherEmail
  paymentTermsDays quickPayEligible defaultQuickPayDays factorPaymentMethodId
  highwayStatus rmisStatus mcpStatus accountOwnerIds teamKey internalNotes
  loadCount lastLoadAt createdBy updatedBy version createdAt updatedAt
`
const CARRIER_JSON_FIELDS: (keyof CarrierRecord)[] = ['insurancePolicies', 'address']
const CARRIER_CONTACT_FIELDS = `
  id carrierId name types email phone isPrimary rateConRecipient active
  createdBy updatedBy createdAt updatedAt
`
const CARRIER_PAYMENT_METHOD_FIELDS = `
  id carrierId method recipientType factorName factorAddress bankName accountName
  accountLast4 routingLast4 bankDetailsKey payeeEmail remitToAddress isPreferred status
  createdBy updatedBy createdAt updatedAt
`
const CARRIER_PAYMENT_METHOD_JSON_FIELDS: (keyof CarrierPaymentMethodRecord)[] = ['factorAddress', 'remitToAddress']
const CARRIER_DOCUMENT_FIELDS = `
  id carrierId type name s3Key contentType sizeBytes expiresAt loadCarrierId source
  uploadedBy createdAt updatedAt
`

/**
 * Every carrier write. Same contract as `directoryAction`: the Lambda's own message is
 * rethrown, so a refusal ("MC 123456 already belongs to Acme Trucking") reaches the
 * toast intact instead of `[object Object]`.
 */
export async function carrierAction<T>(action: string, input: unknown): Promise<T> {
  let r: { data: { tmsCarrierActions: unknown } }
  try {
    r = await client.graphql({
      query: `mutation TmsCarrierActions($action: String!, $input: AWSJSON!) { tmsCarrierActions(action: $action, input: $input) }`,
      variables: { action, input: JSON.stringify(input) },
    }) as { data: { tmsCarrierActions: unknown } }
  } catch (err) {
    throw new Error(graphqlErrorText(err) || `${action} failed`, { cause: err })
  }
  const v = unwrapJson(r.data.tmsCarrierActions)
  if (v == null) throw new Error(`${action} returned no result`)
  return v as T
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listCarriers(): Promise<CarrierRecord[]> {
  const rows = await listAll<CarrierRecord>('listCarriers', CARRIER_FIELDS, 1000)
  return rows.map((c) => unwrapJsonFields(c, CARRIER_JSON_FIELDS))
}
export async function listCarriersByStatus(status: CarrierStatus): Promise<CarrierRecord[]> {
  // The index key is the Carrier.status enum, so the variable must be declared as one.
  const rows = await listAllByIndex<CarrierRecord>(
    'listCarrierByStatusAndName', { status }, CARRIER_FIELDS, 1000, { status: 'CarrierStatus!' },
  )
  return rows.map((c) => unwrapJsonFields(c, CARRIER_JSON_FIELDS))
}
/** MC and DOT are the two numbers a broker dedupes on; both indexes answer with a list. */
export async function carriersByMc(mcNumber: string): Promise<CarrierRecord[]> {
  const rows = await listAllByIndex<CarrierRecord>('listCarrierByMcNumber', { mcNumber }, CARRIER_FIELDS, 1000)
  return rows.map((c) => unwrapJsonFields(c, CARRIER_JSON_FIELDS))
}
export async function carriersByDot(dotNumber: string): Promise<CarrierRecord[]> {
  const rows = await listAllByIndex<CarrierRecord>('listCarrierByDotNumber', { dotNumber }, CARRIER_FIELDS, 1000)
  return rows.map((c) => unwrapJsonFields(c, CARRIER_JSON_FIELDS))
}
export async function getCarrier(id: string): Promise<CarrierRecord | null> {
  const r = await client.graphql({
    query: `query GetCarrier($id: ID!) { getCarrier(id: $id) { ${CARRIER_FIELDS} } }`,
    variables: { id },
  }) as { data: { getCarrier: CarrierRecord | null } }
  return r.data.getCarrier ? unwrapJsonFields(r.data.getCarrier, CARRIER_JSON_FIELDS) : null
}
/** Every document in the system — the board's "missing required docs" filter reads it. */
export async function listCarrierDocuments(): Promise<CarrierDocumentRecord[]> {
  return listAll<CarrierDocumentRecord>('listCarrierDocuments', CARRIER_DOCUMENT_FIELDS, 1000)
}

/** Everything one carrier profile renders, in one round trip's worth of parallel reads. */
export async function getCarrierBundle(id: string): Promise<CarrierBundle> {
  const [carrier, contacts, paymentMethods, documents, loadCarriers] = await Promise.all([
    getCarrier(id),
    listAllByIndex<CarrierContactRecord>('listCarrierContactByCarrierId', { carrierId: id }, CARRIER_CONTACT_FIELDS, 1000),
    listAllByIndex<CarrierPaymentMethodRecord>('listCarrierPaymentMethodByCarrierId', { carrierId: id }, CARRIER_PAYMENT_METHOD_FIELDS, 1000),
    listAllByIndex<CarrierDocumentRecord>('listCarrierDocumentByCarrierIdAndType', { carrierId: id }, CARRIER_DOCUMENT_FIELDS, 1000),
    listLoadCarriersByIndex('listLoadCarrierByCarrierId', { carrierId: id }),
  ])
  if (!carrier) throw new Error('Carrier not found')
  return {
    carrier,
    contacts,
    paymentMethods: paymentMethods.map((p) => unwrapJsonFields(p, CARRIER_PAYMENT_METHOD_JSON_FIELDS)),
    documents,
    loadCarriers,
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────
// `expectedUpdatedAt` is the CAS token: the record as the caller last saw it. It is
// absent on a create. The server derives normalizedName, the status audit stamps and
// the load counters, so none of them are part of an input.

export type UpsertCarrierInput = { id?: string; expectedUpdatedAt?: string } & Partial<Omit<
  CarrierRecord,
  'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy' | 'version'
  | 'normalizedName' | 'statusChangedAt' | 'statusChangedBy' | 'loadCount' | 'lastLoadAt'
>>
export async function upsertCarrier(input: UpsertCarrierInput): Promise<CarrierRecord> {
  return carrierAction<CarrierRecord>('UPSERT_CARRIER', input)
}

/** Status transitions go through a dedicated action so CAS and the transition table live server-side. */
export interface SetCarrierStatusInput {
  id: string
  expectedUpdatedAt: string
  status: CarrierStatus
  reason?: CarrierStatusReason
  note?: string
}
export async function setCarrierStatus(input: SetCarrierStatusInput): Promise<CarrierRecord> {
  return carrierAction<CarrierRecord>('SET_CARRIER_STATUS', input)
}

export interface UpsertCarrierContactInput {
  id?: string
  carrierId: string
  expectedUpdatedAt?: string
  name: string
  types?: CarrierContactType[]
  email?: string | null
  phone?: string | null
  isPrimary?: boolean
  rateConRecipient?: boolean
  active?: boolean
}
export async function upsertCarrierContact(input: UpsertCarrierContactInput): Promise<CarrierContactRecord> {
  return carrierAction<CarrierContactRecord>('UPSERT_CONTACT', input)
}
export async function archiveCarrierContact(input: { id: string; expectedUpdatedAt: string }): Promise<CarrierContactRecord> {
  return carrierAction<CarrierContactRecord>('ARCHIVE_CONTACT', input)
}

/** Only the last four digits ever leave the browser — the full numbers live in `bankDetailsKey`. */
export interface UpsertCarrierPaymentMethodInput {
  id?: string
  carrierId: string
  expectedUpdatedAt?: string
  method: CarrierPaymentMethodKind
  recipientType: CarrierPayeeType
  factorName?: string | null
  factorAddress?: Record<string, unknown> | null
  bankName?: string | null
  accountName?: string | null
  accountLast4?: string | null
  routingLast4?: string | null
  bankDetailsKey?: string | null
  payeeEmail?: string | null
  remitToAddress?: Record<string, unknown> | null
  isPreferred?: boolean
  status?: 'ACTIVE' | 'INACTIVE'
}
export async function upsertCarrierPaymentMethod(input: UpsertCarrierPaymentMethodInput): Promise<CarrierPaymentMethodRecord> {
  return carrierAction<CarrierPaymentMethodRecord>('UPSERT_PAYMENT_METHOD', input)
}
export async function archiveCarrierPaymentMethod(input: { id: string; expectedUpdatedAt: string }): Promise<CarrierPaymentMethodRecord> {
  return carrierAction<CarrierPaymentMethodRecord>('ARCHIVE_PAYMENT_METHOD', input)
}

/** Two steps, as in vendor-ap intake: presign, upload straight to S3, then commit the row. */
export async function prepareCarrierDocument(input: {
  carrierId: string
  type: CarrierDocumentType
  name: string
  contentType: string
  sizeBytes: number
}): Promise<{ uploadUrl: string; s3Key: string }> {
  return carrierAction<{ uploadUrl: string; s3Key: string }>('PREPARE_DOCUMENT', input)
}
export async function commitCarrierDocument(input: {
  carrierId: string
  type: CarrierDocumentType
  name: string
  s3Key: string
  contentType: string
  sizeBytes: number
  expiresAt?: string | null
}): Promise<CarrierDocumentRecord> {
  return carrierAction<CarrierDocumentRecord>('COMMIT_DOCUMENT', input)
}
export async function deleteCarrierDocument(input: { id: string }): Promise<{ id: string }> {
  return carrierAction<{ id: string }>('DELETE_DOCUMENT', input)
}

/** The nine booking fields on TmsSettings. Admin only, server-side. */
export interface CarrierSettingsPatch {
  allowedCarrierStatuses?: string[] | null
  requireCarrierApproval?: boolean | null
  requiredCarrierDocs?: string[] | null
  bookingRequiredFields?: string[] | null
  defaultCarrierTermsDays?: number | null
  quickPayTiers?: QuickPayTier[] | null
  rateConExpiryHours?: number | null
  rateConRequiredFields?: string[] | null
  insuranceWarnDays?: number | null
}
export async function saveCarrierSettings(patch: CarrierSettingsPatch, expectedUpdatedAt?: string): Promise<TmsSettings> {
  return carrierAction<TmsSettings>('SAVE_CARRIER_SETTINGS', { id: 'default', expectedUpdatedAt, ...patch })
}

/** Upload to the presigned PUT from PREPARE_DOCUMENT. `contentType` must be the value the
 *  URL was signed for (the browser's file.type may be empty) — so must the length. */
export async function uploadCarrierDocumentFile(file: File, uploadUrl: string, contentType: string): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'content-type': contentType, 'content-length': String(file.size) },
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`)
}

export async function getCarrierDocumentUrl(s3Key: string): Promise<string> {
  return getRateConfirmUrl(s3Key) // same bucket, same presigned URL mechanism
}

// ── Booking · rate con · dispatch (tmsShipmentActions) ───────────────────────
// These five live on the shipment Lambda, not the carrier one: they move load money
// and load status inside its transaction, so they answer with the whole ShipmentBundle.

export interface BookCarrierInput {
  loadId: string
  expectedUpdatedAt: string
  carrierId: string
  carrierRepId?: string | null
  carrierRateCents: number
  /** Extra CARRIER-side lines beside the LINEHAUL the rate itself creates. */
  charges?: LoadChargeInput[]
  contactId?: string | null
  dispatcherName?: string | null
  dispatcherPhone?: string | null
  dispatcherEmail?: string | null
  driverName?: string | null
  driverPhone?: string | null
  driver2Name?: string | null
  driver2Phone?: string | null
  truckNumber?: string | null
  trailerNumber?: string | null
  plates?: string | null
  vin?: string | null
  equipmentType?: string | null
  trackingProvider?: string | null
  quickPayDays?: number | null
  paymentTermsDays?: number | null
  /** The `key` of every warning the booker ticked off. Blocks can never be acknowledged. */
  acknowledgeWarnings?: string[]
}
export async function bookCarrier(input: BookCarrierInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('BOOK_CARRIER', input)
}

/** `quickPayDays: null` clears the election; any other value must match a configured tier. */
export async function setQuickPay(input: { loadCarrierId: string; quickPayDays: number | null }): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('SET_QUICK_PAY', input)
}

/** The PDF is built in the browser (`buildRateConPdf`); a re-send voids the prior token. */
export async function sendRateCon(input: {
  loadCarrierId: string
  pdfBase64: string
  to: string[]
  cc?: string[]
  expiresHours?: number
}): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('SEND_RATE_CON', input)
}
export async function voidRateCon(input: { loadCarrierId: string }): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('VOID_RATE_CON', input)
}

export interface DispatchLoadInput {
  loadId: string
  dispatchedAt: string
  pickupEtaAt?: string | null
  driverName?: string | null
  driverPhone?: string | null
  truckNumber?: string | null
  trailerNumber?: string | null
  trackingProvider?: string | null
  nextCheckCallAt?: string | null
  nextCheckCallNote?: string | null
  note?: string | null
}
export async function dispatchLoad(input: DispatchLoadInput): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('DISPATCH_LOAD', input)
}

// ── Tracking & check calls (tmsTrackingActions) ──────────────────────────────
//
// Step D. The event log (LoadCheckCall) and the tokenised links (TrackingLink). The
// writes split by what they touch: anything that moves a Load's status or its money
// stays on the shipment router and returns the bundle; the link, text and settings
// actions live on their own router because they reach Twilio, SES and Cognito.

export type {
  CheckCallType, CheckCallSource, IncidentType, LoadCheckCallRecord, TrackingLinkRecord,
  TrackingLinkKind, TrackingLinkStatus, TrackingLinkChannel, TrackingContact,
  CheckCallNotifyChannel, CheckCallChargeSnapshot,
} from '@/types/tms'

const LOAD_CHECK_CALL_FIELDS = `
  id loadId shipmentId loadCarrierId stopId at type source
  incidentType incidentOpen resolvedAt resolvedBy resolutionNote
  statusBefore statusAfter city state lat lng accuracyM
  personName note driverMessageId charges
  nextCheckCallAt nextCheckCallNote pickupEtaAt deliveryEtaAt
  createdBy createdAt updatedAt
`
const LOAD_CHECK_CALL_JSON_FIELDS: (keyof LoadCheckCallRecord)[] = ['charges']

const TRACKING_LINK_FIELDS = `
  id kind shipmentId loadId loadCarrierId status expiresAt
  sentTo sentVia sentAt smsMessageId contactName contactEmail contactPhone
  showCarrier showPosition openCount lastOpenedAt requestCount
  pingCount lastPingAt lastPingLat lastPingLng lastPingAccuracyM
  revokedAt revokedBy createdBy createdAt updatedAt
`
// Step E's carrier upload portal counts its files on the link row. Its own flag, as
// everywhere else: the tracking tab must still list links on a pre-deploy backend.
const TRACKING_LINK_UPLOAD_FIELDS = ['uploadCount', 'lastUploadAt', 'neededTypes']
let trackingLinksHaveUploads = true

/**
 * Every tracking write. Same contract as `carrierAction`: the Lambda's own refusal
 * ("own trucks track through Motive and the driver app") reaches the toast intact.
 */
export async function trackingAction<T>(action: string, input: unknown): Promise<T> {
  let r: { data: { tmsTrackingActions: unknown } }
  try {
    r = await client.graphql({
      query: `mutation TmsTrackingActions($action: String!, $input: AWSJSON!) { tmsTrackingActions(action: $action, input: $input) }`,
      variables: { action, input: JSON.stringify(input) },
    }) as { data: { tmsTrackingActions: unknown } }
  } catch (err) {
    throw new Error(graphqlErrorText(err) || `${action} failed`, { cause: err })
  }
  const v = unwrapJson(r.data.tmsTrackingActions)
  if (v == null) throw new Error(`${action} returned no result`)
  return v as T
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** A charge an incident asks for. BOTH bills the customer and pays the carrier. */
export interface CheckCallChargeInput {
  side: ChargeSide | 'BOTH'
  code: string
  label?: string | null
  rateCents: number
  count?: number | null
}

export interface LogCheckCallInput {
  loadId: string
  /** The Load's `updatedAt` as the dialog read it. */
  expectedUpdatedAt: string
  at: string
  type: CheckCallType
  stopId?: string | null
  incidentType?: IncidentType | null
  city?: string | null
  state?: string | null
  lat?: number | null
  lng?: number | null
  personName?: string | null
  note?: string | null
  charges?: CheckCallChargeInput[]
  /** `null` clears the reminder; omitted leaves it alone. */
  nextCheckCallAt?: string | null
  nextCheckCallNote?: string | null
}

/**
 * Every check-call write answers the same way: the whole bundle, plus the LoadCheckCall
 * row it wrote. `event` is null for the one action that schedules without logging.
 */
export interface CheckCallResult {
  bundle: ShipmentBundle
  event: LoadCheckCallRecord | null
}

export async function logCheckCall(input: LogCheckCallInput): Promise<CheckCallResult> {
  return shipmentAction<CheckCallResult>('LOG_CHECK_CALL', input)
}

export async function resolveIncident(input: { checkCallId: string; note?: string | null }): Promise<CheckCallResult> {
  return shipmentAction<CheckCallResult>('RESOLVE_INCIDENT', input)
}

/** The banner's Edit reminder / Snooze / No reminder. `nextCheckCallAt: null` clears it. */
export async function setNextCheckCall(input: {
  loadId: string
  expectedUpdatedAt: string
  nextCheckCallAt: string | null
  note?: string | null
}): Promise<CheckCallResult> {
  return shipmentAction<CheckCallResult>('SET_NEXT_CHECK_CALL', input)
}

/** ETAs live on the ACTIVE assignment, so this is keyed by LoadCarrier, not Load. */
export async function setEta(input: {
  loadCarrierId: string
  expectedUpdatedAt: string
  pickupEtaAt?: string | null
  deliveryEtaAt?: string | null
  note?: string | null
}): Promise<CheckCallResult> {
  return shipmentAction<CheckCallResult>('SET_ETA', input)
}

/** What the server did with the text. `url` is copyable whatever the status says. */
export type TrackingSmsStatus = 'SENT' | 'COPY' | 'NOT_CONFIGURED' | 'FAILED'
export interface SendTrackingLinkResult {
  link: TrackingLinkRecord
  url: string
  smsStatus: TrackingSmsStatus
  smsError: string | null
  messageId: string | null
}
export async function sendTrackingLink(input: {
  loadCarrierId: string
  to?: string | null
  via: 'SMS' | 'COPY'
  message?: string | null
}): Promise<SendTrackingLinkResult> {
  return trackingAction<SendTrackingLinkResult>('SEND_TRACKING_LINK', input)
}

export async function revokeTrackingLink(input: { trackingLinkId: string }): Promise<{ link: TrackingLinkRecord }> {
  return trackingAction<{ link: TrackingLinkRecord }>('REVOKE_TRACKING_LINK', input)
}

export type CustomerLinkEmailStatus = 'SENT' | 'COPY' | 'NOT_SENT'
export interface SendCustomerLinkResult {
  link: TrackingLinkRecord
  url: string
  emailStatus: CustomerLinkEmailStatus
  emailError: string | null
  /** The patched shipment, so the next call's `expectedVersion` needs no refetch. */
  shipment: ShipmentRecord
}
export async function sendCustomerLink(input: {
  shipmentId: string
  expectedVersion: number
  to: string[]
  cc?: string[]
  message?: string | null
  via: 'EMAIL' | 'COPY'
  regenerate?: boolean
}): Promise<SendCustomerLinkResult> {
  return trackingAction<SendCustomerLinkResult>('SEND_CUSTOMER_LINK', input)
}

export async function revokeCustomerLink(input: { trackingLinkId: string }): Promise<{ link: TrackingLinkRecord }> {
  return trackingAction<{ link: TrackingLinkRecord }>('REVOKE_CUSTOMER_LINK', input)
}

/** The check-call dialog's "text this to the driver". Never undoes the check call. */
export async function textDriver(input: { loadCarrierId: string; body: string }): Promise<{
  messageId: string | null
  smsStatus: TrackingSmsStatus
  smsError: string | null
}> {
  return trackingAction<{ messageId: string | null; smsStatus: TrackingSmsStatus; smsError: string | null }>(
    'TEXT_DRIVER', input,
  )
}

/** The ten tracking fields on TmsSettings. Admin only, validated server-side. */
export interface TrackingSettingsPatch {
  checkCallDefaultIntervalHours?: number | null
  checkCallGraceMinutes?: number | null
  checkCallNotifyChannel?: CheckCallNotifyChannel | null
  checkCallSlackChannelId?: string | null
  trackingLinkExpiryHours?: number | null
  customerLinkExpiryDays?: number | null
  customerLinkShowsCarrier?: boolean | null
  customerLinkShowsPosition?: boolean | null
  trackingContact?: TrackingContact | null
  trackingSmsTemplate?: string | null
}
export async function saveTrackingSettings(patch: TrackingSettingsPatch, expectedUpdatedAt?: string): Promise<TmsSettings> {
  return trackingAction<TmsSettings>('SAVE_TRACKING_SETTINGS', { id: 'default', expectedUpdatedAt, ...patch })
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Page a tracking index to the end. Separate from `listAllByIndex` because these
 * queries need a sort direction and, for the Motive history, a key range — neither of
 * which a map of scalar arguments can express.
 */
async function listTrackingIndex<T>(opts: {
  name: string
  /** Variable declarations without the paging token, e.g. `$loadId: String!`. */
  decls: string
  /** The arguments as the query passes them, e.g. `loadId: $loadId`. */
  args: string
  variables: Record<string, unknown>
  fields: string
  limit: number
  sortDirection?: 'ASC' | 'DESC'
}): Promise<T[]> {
  const dir = opts.sortDirection ? `, sortDirection: ${opts.sortDirection}` : ''
  const rows: T[] = []
  let nextToken: string | null = null
  do {
    const r = await client.graphql({
      query: `query ${opts.name}(${opts.decls}, $nextToken: String) {
        ${opts.name}(${opts.args}, limit: ${opts.limit}${dir}, nextToken: $nextToken) {
          items { ${opts.fields} } nextToken
        }
      }`,
      variables: { ...opts.variables, nextToken },
    }) as { data: Record<string, { items: (T | null)[]; nextToken?: string | null }> }
    const page = r.data[opts.name]
    for (const item of page.items) if (item) rows.push(item)
    nextToken = page.nextToken ?? null
  } while (nextToken)
  return rows
}

/** One load's event log, newest first — the order the Tracking tab renders. */
export async function listCheckCallsByLoad(loadId: string): Promise<LoadCheckCallRecord[]> {
  const rows = await listTrackingIndex<LoadCheckCallRecord>({
    name: 'listLoadCheckCallByLoadIdAndAt',
    decls: '$loadId: String!',
    args: 'loadId: $loadId',
    variables: { loadId },
    fields: LOAD_CHECK_CALL_FIELDS,
    limit: 500,
    sortDirection: 'DESC',
  })
  return rows.map((r) => unwrapJsonFields(r, LOAD_CHECK_CALL_JSON_FIELDS))
}

/** Every unresolved incident across the book, newest first. The sparse key is the filter. */
export async function listOpenIncidents(): Promise<LoadCheckCallRecord[]> {
  const rows = await listTrackingIndex<LoadCheckCallRecord>({
    name: 'listLoadCheckCallByIncidentOpenAndAt',
    decls: '$incidentOpen: String!',
    args: 'incidentOpen: $incidentOpen',
    variables: { incidentOpen: 'OPEN' },
    fields: LOAD_CHECK_CALL_FIELDS,
    limit: 500,
    sortDirection: 'DESC',
  })
  return rows.map((r) => unwrapJsonFields(r, LOAD_CHECK_CALL_JSON_FIELDS))
}

export async function listTrackingLinksByShipment(shipmentId: string): Promise<TrackingLinkRecord[]> {
  for (;;) {
    const fields = trackingLinksHaveUploads
      ? `${TRACKING_LINK_FIELDS} ${TRACKING_LINK_UPLOAD_FIELDS.join(' ')}`
      : TRACKING_LINK_FIELDS
    try {
      return await listAllByIndex<TrackingLinkRecord>('listTrackingLinkByShipmentId', { shipmentId }, fields, 200)
    } catch (err) {
      if (!trackingLinksHaveUploads || !fieldNamed(TRACKING_LINK_UPLOAD_FIELDS, err)) throw err
      console.warn('[apiClient] backend has no upload fields on TrackingLink yet — querying without them until deploy')
      trackingLinksHaveUploads = false
    }
  }
}

/** Motive breadcrumbs for one truck inside a window, oldest → newest. */
export async function listTruckPositions(truckId: string, from: string, to: string): Promise<TruckLocation[]> {
  return listTrackingIndex<TruckLocation>({
    name: 'listTruckLocationHistoryByTruckIdAndLocatedAt',
    decls: '$truckId: String!, $from: String!, $to: String!',
    args: 'truckId: $truckId, locatedAt: { between: [$from, $to] }',
    variables: { truckId, from, to },
    fields: TRUCK_LOCATION_HISTORY_FIELDS,
    limit: 1000,
    sortDirection: 'ASC',
  })
}

/**
 * Every load with a check call on the clock, soonest first. `checkCallOpen` is the
 * sparse GSI key, so this reads only the loads that are actually being tracked.
 */
export async function listCheckCallWorklist(): Promise<Load[]> {
  const rows = await listTrackingIndex<Load>({
    name: 'listLoadByCheckCallOpenAndNextCheckCallAt',
    decls: '$checkCallOpen: String!',
    args: 'checkCallOpen: $checkCallOpen',
    variables: { checkCallOpen: 'OPEN' },
    fields: loadFields(),
    limit: 1000,
    sortDirection: 'ASC',
  })
  return rows.map((l) => unwrapJsonFields(l, ['stops']))
}

/** One load's assignments — the worklist reads the ACTIVE one for carrier and driver phone. */
export async function listLoadCarriersByLoad(loadId: string): Promise<LoadCarrierRecord[]> {
  return listLoadCarriersByIndex('listLoadCarrierByLoadId', { loadId })
}

// ── Documents & delivery (tmsShipmentActions · tmsTrackingActions) ───────────
//
// Step E. ShipmentDocument is the shipment's index of every file it has, wherever the
// bytes live; ShipmentNotice is every e-mail the system tried to send, with the text it
// rendered. The writes split the way step D's did: the rows and the AR gate belong to
// the shipment router, the links and SES to the tracking router. Neither model has
// subscriptions, so the Documents tab polls (src/hooks/useShipmentDocuments.ts).

export type {
  ShipmentDocumentRecord, ShipmentDocumentType, ShipmentDocumentSource, ShipmentDocumentAudience,
  ShipmentDocumentStatus, ShipmentDocumentReviewStatus, ShipmentDocumentSection,
  ShipmentNoticeRecord, ShipmentNoticeKind, ShipmentNoticeStatus, DocGateResult,
} from '@/types/tms'

const SHIPMENT_DOCUMENT_FIELDS = `
  id shipmentId orderId loadId loadCarrierId stopId
  type name s3Key contentType sizeBytes pages source sourceRef audience
  status version supersedesId
  reviewStatus reviewedAt reviewedBy reviewNote uploadLinkId
  voidedAt voidedBy voidReason uploadedBy uploadedAt
  createdBy createdAt updatedAt
`
const SHIPMENT_NOTICE_FIELDS = `
  id shipmentId loadId loadCarrierId kind milestone channel
  to cc subject body attachments status error messageId sentAt trackingLinkId
  at createdBy createdAt updatedAt
`
const SHIPMENT_NOTICE_JSON_FIELDS: (keyof ShipmentNoticeRecord)[] = ['attachments']

// Both models arrive with step E's deploy, and until it lands AppSync has no such
// query at all — the error names the query, not a field, so the field-level self-heal
// above cannot see it. Degrade to "this shipment has no documents" (the same bargain
// `payCreditsDeployed` strikes) rather than failing every shipment page mid-deploy.
let documentModelsAvailable = true
const isMissingDocumentModel = (err: unknown) =>
  /Cannot query field ['"]listShipment(Document|Notice)|Unknown type ['"]ShipmentDocument/i.test(safeStringify(err))

/** False once a read proved the backend predates the document models. */
export const shipmentDocumentsDeployed = () => documentModelsAvailable

function forgetDocumentModels(err: unknown): void {
  if (!isMissingDocumentModel(err)) throw err
  console.warn('[apiClient] backend has no document models yet — reading no documents until deploy')
  documentModelsAvailable = false
}

/**
 * One shipment's documents, oldest first — the order `ShipmentBundle.documents` comes
 * back in from the Lambda, so a page that swaps a write's bundle in sees the same
 * sequence it read. A view that wants newest first sorts its own copy.
 */
export async function listShipmentDocuments(shipmentId: string): Promise<ShipmentDocumentRecord[]> {
  if (!documentModelsAvailable) return []
  try {
    return await listTrackingIndex<ShipmentDocumentRecord>({
      name: 'listShipmentDocumentByShipmentIdAndUploadedAt',
      decls: '$shipmentId: String!',
      args: 'shipmentId: $shipmentId',
      variables: { shipmentId },
      fields: SHIPMENT_DOCUMENT_FIELDS,
      limit: 500,
      sortDirection: 'ASC',
    })
  } catch (err) {
    forgetDocumentModels(err)
    return []
  }
}

/**
 * Every carrier-portal upload still waiting on a person, oldest first: the queue is
 * worked in the order the carriers sent them. The index is sparse — only CARRIER_PORTAL
 * rows ever carry PENDING — so this reads exactly the worklist however big the book is.
 */
export async function listDocumentReviewQueue(): Promise<ShipmentDocumentRecord[]> {
  if (!documentModelsAvailable) return []
  try {
    return await listTrackingIndex<ShipmentDocumentRecord>({
      // The index key is the model's own enum, so the variable must be declared as one.
      name: 'listShipmentDocumentByReviewStatusAndUploadedAt',
      decls: '$reviewStatus: ShipmentDocumentReviewStatus!',
      args: 'reviewStatus: $reviewStatus',
      variables: { reviewStatus: 'PENDING' },
      fields: SHIPMENT_DOCUMENT_FIELDS,
      limit: 500,
      sortDirection: 'ASC',
    })
  } catch (err) {
    forgetDocumentModels(err)
    return []
  }
}

/** One shipment's e-mail history, newest first. A NOT_SENT row is still readable. */
export async function listShipmentNotices(shipmentId: string): Promise<ShipmentNoticeRecord[]> {
  if (!documentModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<ShipmentNoticeRecord>({
      name: 'listShipmentNoticeByShipmentIdAndAt',
      decls: '$shipmentId: String!',
      args: 'shipmentId: $shipmentId',
      variables: { shipmentId },
      fields: SHIPMENT_NOTICE_FIELDS,
      limit: 200,
      sortDirection: 'DESC',
    })
    return rows.map((n) => unwrapJsonFields(n, SHIPMENT_NOTICE_JSON_FIELDS))
  } catch (err) {
    forgetDocumentModels(err)
    return []
  }
}

// ── Document writes (tmsShipmentActions) ─────────────────────────────────────

export interface PrepareDocumentUploadInput {
  shipmentId: string
  type: ShipmentDocumentType
  name: string
  contentType: string
  sizeBytes: number
}
/** A presigned PUT pinned to the type and the length, good for five minutes. */
export interface PreparedDocumentUpload {
  uploadUrl: string
  s3Key: string
  documentId: string
}
export async function prepareDocumentUpload(input: PrepareDocumentUploadInput): Promise<PreparedDocumentUpload> {
  return shipmentAction<PreparedDocumentUpload>('PREPARE_DOCUMENT_UPLOAD', input)
}

/**
 * Every document write answers the same way: the whole bundle (its `documents`, the
 * order's re-cached `docsMissing`) plus the row it wrote, so a dialog swaps the
 * response in rather than re-reading the shipment.
 */
export interface DocumentResult {
  bundle: ShipmentBundle
  document: ShipmentDocumentRecord
}

export interface CommitDocumentInput {
  shipmentId: string
  /** Both from the PREPARE_DOCUMENT_UPLOAD that signed the PUT. */
  documentId: string
  s3Key: string
  type: ShipmentDocumentType
  name: string
  contentType: string
  sizeBytes: number
  /** Which section the row lands in: order → Customer, assignment → Carrier, neither → Shipment. */
  orderId?: string | null
  loadId?: string | null
  loadCarrierId?: string | null
  stopId?: string | null
  /** Defaults to the type's own audience; INTERNAL keeps a file in the building. */
  audience?: ShipmentDocumentAudience | null
}
export async function commitDocument(input: CommitDocumentInput): Promise<DocumentResult> {
  return shipmentAction<DocumentResult>('COMMIT_DOCUMENT', input)
}

export interface SaveGeneratedDocumentInput {
  shipmentId: string
  type: 'BOL' | 'LOAD_SUMMARY' | 'RATE_CON'
  loadId?: string | null
  loadCarrierId?: string | null
  /** The PDF the browser built, base64 with no data: prefix. */
  pdfBase64: string
  filename: string
}
export async function saveGeneratedDocument(input: SaveGeneratedDocumentInput): Promise<DocumentResult> {
  return shipmentAction<DocumentResult>('SAVE_GENERATED_DOCUMENT', input)
}

/** Points a shipment at a file the driver app already holds; the bytes are never copied. */
export interface AttachDriverDocInput {
  shipmentId: string
  loadId: string
  submissionDocId: string
  type: 'POD' | 'PHOTO' | 'OTHER'
}
export async function attachDriverDoc(input: AttachDriverDocInput): Promise<DocumentResult> {
  return shipmentAction<DocumentResult>('ATTACH_DRIVER_DOC', input)
}

/** PENDING carrier-portal rows only. Nothing a carrier sent satisfies a gate until this. */
export interface ReviewDocumentInput {
  documentId: string
  decision: 'ACCEPT' | 'REJECT'
  /** ACCEPT may retype the upload, within what a carrier is allowed to send. */
  type?: ShipmentDocumentType
  audience?: ShipmentDocumentAudience
  note?: string | null
}
export async function reviewDocument(input: ReviewDocumentInput): Promise<DocumentResult> {
  return shipmentAction<DocumentResult>('REVIEW_DOCUMENT', input)
}

/** ACTIVE rows that own their bytes; a generated row may change audience only. */
export interface UpdateDocumentInput {
  documentId: string
  name?: string
  type?: ShipmentDocumentType
  audience?: ShipmentDocumentAudience
  orderId?: string | null
  loadCarrierId?: string | null
}
export async function updateDocument(input: UpdateDocumentInput): Promise<DocumentResult> {
  return shipmentAction<DocumentResult>('UPDATE_DOCUMENT', input)
}

/** The row goes VOID and stops counting; the file itself is never deleted. */
export async function voidDocument(input: { documentId: string; reason: string }): Promise<DocumentResult> {
  return shipmentAction<DocumentResult>('VOID_DOCUMENT', input)
}

export interface ReadyToInvoiceInput {
  orderId: string
  /** The Order's `updatedAt` as the page read it. */
  expectedUpdatedAt: string
  /** ADMIN/owner may bill past a missing document; the note is then required. */
  override?: boolean
  overrideNote?: string
}
/** `gate` is what the required-document check decided, missing documents included. */
export interface ReadyToInvoiceResult {
  bundle: ShipmentBundle
  gate: DocGateResult
}
export async function readyToInvoice(input: ReadyToInvoiceInput): Promise<ReadyToInvoiceResult> {
  return shipmentAction<ReadyToInvoiceResult>('READY_TO_INVOICE', input)
}

/** How the office rates the carrier once their load is done. One to five stars. */
export async function rateCarrier(input: {
  loadCarrierId: string
  stars: number
  note?: string
}): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('RATE_CARRIER', input)
}

// ── Upload links & notices (tmsTrackingActions) ──────────────────────────────

/** NOT_SENT is an honest outcome: the notice and its text exist, SES refused it. */
export type NoticeEmailStatus = 'SENT' | 'COPY' | 'NOT_SENT'

export interface SendUploadLinkInput {
  loadCarrierId: string
  /** Defaults to the assignment's dispatcher e-mail. */
  to?: string[]
  via: 'EMAIL' | 'COPY'
  message?: string | null
  /** Ask before the load has delivered; refused without it. */
  early?: boolean
  /** Revoke the assignment's link and mint a new token. */
  regenerate?: boolean
}
export interface SendUploadLinkResult {
  link: TrackingLinkRecord
  /** Copyable whatever the e-mail did. */
  url: string
  /** Written before the send, so the text exists even when SES refused it. */
  notice: ShipmentNoticeRecord
  emailStatus: NoticeEmailStatus
  emailError: string | null
}
export async function sendUploadLink(input: SendUploadLinkInput): Promise<SendUploadLinkResult> {
  return trackingAction<SendUploadLinkResult>('SEND_UPLOAD_LINK', input)
}

export async function revokeUploadLink(input: { trackingLinkId: string }): Promise<{ link: TrackingLinkRecord }> {
  return trackingAction<{ link: TrackingLinkRecord }>('REVOKE_UPLOAD_LINK', input)
}

/** The manual send of a milestone the stream has already passed, or never sent. */
export interface SendMilestoneNoticeInput {
  shipmentId: string
  milestone: CustomerNotification
  /** Defaults to the customer contacts subscribed to that milestone. */
  to?: string[]
  message?: string | null
  via: 'EMAIL' | 'COPY'
}
export interface SendMilestoneNoticeResult {
  notice: ShipmentNoticeRecord
  /** Who the server actually addressed it to. */
  to: string[]
  emailStatus: NoticeEmailStatus
  emailError: string | null
  /** The patched shipment, so `lastNoticeAt` needs no refetch. */
  shipment: ShipmentRecord
}
export async function sendMilestoneNotice(input: SendMilestoneNoticeInput): Promise<SendMilestoneNoticeResult> {
  return trackingAction<SendMilestoneNoticeResult>('SEND_MILESTONE_NOTICE', input)
}

export interface EmailDocumentsInput {
  shipmentId: string
  documentIds: string[]
  to: string[]
  cc?: string[]
  subject?: string | null
  message?: string | null
  /** Decides which audiences may go out; INTERNAL rows are refused either way. */
  recipientKind: 'CUSTOMER' | 'CARRIER'
}
export interface EmailDocumentsResult {
  notice: ShipmentNoticeRecord
  emailStatus: NoticeEmailStatus
  emailError: string | null
  /** Empty on a send; one-hour presigned GETs to hand over when SES refused. */
  downloads: { documentId: string; name: string; url: string }[]
}
export async function emailDocuments(input: EmailDocumentsInput): Promise<EmailDocumentsResult> {
  return trackingAction<EmailDocumentsResult>('EMAIL_DOCUMENTS', input)
}

/** The eight document settings on TmsSettings. ADMIN only, validated server-side. */
export interface DocumentSettingsPatch {
  milestoneNoticesEnabled?: boolean | null
  podRequestEnabled?: boolean | null
  requiredCarrierUploadTypes?: string[] | null
  uploadLinkExpiryDays?: number | null
  milestoneEmailTemplate?: string | null
  podRequestEmailTemplate?: string | null
  bolTerms?: string | null
  documentDeleteAdminOnly?: boolean | null
}
export async function saveDocumentSettings(patch: DocumentSettingsPatch, expectedUpdatedAt?: string): Promise<TmsSettings> {
  return trackingAction<TmsSettings>('SAVE_DOCUMENT_SETTINGS', { id: 'default', expectedUpdatedAt, ...patch })
}

/**
 * Send the bytes to a presigned PUT. Both the staff dialog and the public carrier
 * portal upload through this one implementation: the Content-Type has to be exactly
 * what the Lambda signed or S3 rejects the PUT, and Amplify's uploadData cannot be
 * used here — the portal has no credentials at all.
 */
export async function putPresignedFile(uploadUrl: string, file: Blob, contentType: string): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': contentType },
  })
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status}). The upload link may have expired — try again.`)
  }
}

// ── Google geocoding proxy (tmsGeocode) — real upstream errors, no fallbacks ─────
async function geocodeAction<T>(action: string, input: unknown): Promise<T> {
  let r: { data: { tmsGeocode: unknown } }
  try {
    r = await client.graphql({
      query: `query TmsGeocode($action: String!, $input: AWSJSON!) { tmsGeocode(action: $action, input: $input) }`,
      variables: { action, input: JSON.stringify(input) },
    }) as { data: { tmsGeocode: unknown } }
  } catch (err) {
    throw new Error(graphqlErrorText(err) || `${action} failed`, { cause: err })
  }
  const v = unwrapJson(r.data.tmsGeocode)
  if (v == null) throw new Error(`${action} returned no result`)
  return v as T
}
export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  return geocodeAction<GeocodeResult>('GEOCODE', { address })
}
export async function autocompleteAddress(query: string, sessionToken: string): Promise<AutocompleteSuggestion[]> {
  return (await geocodeAction<{ suggestions: AutocompleteSuggestion[] }>('AUTOCOMPLETE', { query, sessionToken })).suggestions
}
export async function getPlaceDetails(placeId: string, sessionToken: string): Promise<GeocodeResult> {
  return geocodeAction<GeocodeResult>('PLACE_DETAILS', { placeId, sessionToken })
}

export async function notifySlackStatusChange(args: {
  intakeItemId: string
  oldStatus?: string | null
  newStatus: string
  actorName?: string | null
  proNumber?: string | null
  reassignedTo?: string | null
}): Promise<void> {
  try {
    await client.graphql({
      query: `mutation NotifySlack(
        $intakeItemId: ID!, $oldStatus: String, $newStatus: String!,
        $actorName: String, $proNumber: String, $reassignedTo: String
      ) {
        notifySlackStatusChange(
          intakeItemId: $intakeItemId, oldStatus: $oldStatus, newStatus: $newStatus,
          actorName: $actorName, proNumber: $proNumber, reassignedTo: $reassignedTo
        )
      }`,
      variables: args,
    })
  } catch (err) {
    // Fire-and-forget — log but don't surface to the user
    console.error('[notifySlackStatusChange] failed', err)
  }
}

export async function getIntakePdfUrl(s3Key: string): Promise<string> {
  return getRateConfirmUrl(s3Key) // same bucket, same presigned URL mechanism
}

/** Email a driver their weekly pay statement (PDF attachment built client-side). */
export async function sendDriverPayEmail(args: {
  to: string
  cc?: string
  driverName?: string
  periodLabel?: string
  subject?: string
  bodyText?: string
  filename?: string
  pdfBase64: string
}): Promise<{ sent: boolean; to?: string; error?: string }> {
  const res = await client.graphql({
    query: `mutation SendDriverPayEmail(
      $to: String!, $cc: String, $driverName: String, $periodLabel: String,
      $subject: String, $bodyText: String, $filename: String, $pdfBase64: String!
    ) {
      sendDriverPayEmail(
        to: $to, cc: $cc, driverName: $driverName, periodLabel: $periodLabel,
        subject: $subject, bodyText: $bodyText, filename: $filename, pdfBase64: $pdfBase64
      )
    }`,
    variables: args,
  })
  // The mutation returns AWSJSON, which the client hands back as a JSON *string* —
  // parse it so callers can read { sent, to, error }.
  let data: unknown = (res as { data?: { sendDriverPayEmail?: unknown } }).data?.sendDriverPayEmail
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { /* leave as-is */ } }
  return (data ?? { sent: false, error: 'no-response' }) as { sent: boolean; to?: string; error?: string }
}

// ── Trip screenshot parsing (Driver Pay import) ────────────────────────────────

export interface ScreenshotTrip {
  loadId: string | null
  origin: string | null
  destination: string | null
  miles: number | null
  equipment: string | null
  freightAmount: number
  ratePerMile: number | null
  status: string | null
  date: string | null
}

/**
 * Read an Amazon Relay trips-list screenshot into structured trip rows (Claude
 * vision, server-side). The caller downscales the image first — AppSync caps the
 * request at ~1MB — and previews the rows before importing.
 */
export async function sendApptRequestEmail(args: {
  to: string; cc?: string | null; subject: string; body: string; replyTo?: string | null
}): Promise<{ ok: boolean; error?: string | null }> {
  let res: unknown
  try {
    res = await client.graphql({
      query: `mutation SendApptRequestEmail($to: String!, $cc: String, $subject: String!, $body: String!, $replyTo: String) {
        sendApptRequestEmail(to: $to, cc: $cc, subject: $subject, body: $body, replyTo: $replyTo)
      }`,
      variables: args,
    })
  } catch (err) { return { ok: false, error: graphqlErrorMessage(err) } }
  let data: unknown = (res as { data?: { sendApptRequestEmail?: unknown } }).data?.sendApptRequestEmail
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { /* leave */ } }
  return (data ?? { ok: false, error: 'no-response' }) as { ok: boolean; error?: string | null }
}

export interface ParsedRateconAppt { date: string | null; time: string | null; timeEnd: string | null }
export async function parseRateConfirm(args: {
  fileBase64: string
  mediaType?: string
  todayISO?: string
}): Promise<{
  appts: { pickup: ParsedRateconAppt; delivery: ParsedRateconAppt } | null
  /** The billing fields off the same single pass. Null when the parser could not read them. */
  invoice?: RateConExtract | null
  /** What is on the truck, off the same pass. */
  freight?: RateConFreight | null
  error?: string | null
}> {
  let res: unknown
  try {
    res = await client.graphql({
      query: `mutation ParseRateConfirm($fileBase64: String!, $mediaType: String, $todayISO: String) {
        parseRateConfirm(fileBase64: $fileBase64, mediaType: $mediaType, todayISO: $todayISO)
      }`,
      variables: args,
    })
  } catch (err) {
    return { appts: null, error: graphqlErrorMessage(err) }
  }
  let data: unknown = (res as { data?: { parseRateConfirm?: unknown } }).data?.parseRateConfirm
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { /* leave */ } }
  return (data ?? { appts: null, error: 'no-response' }) as {
    appts: { pickup: ParsedRateconAppt; delivery: ParsedRateconAppt } | null
    invoice?: RateConExtract | null
    error?: string | null
  }
}

export async function parseTripScreenshot(args: {
  imageBase64: string
  mediaType?: string
  todayISO?: string
}): Promise<{ trips: ScreenshotTrip[] | null; error?: string | null }> {
  let res: unknown
  try {
    res = await client.graphql({
      query: `mutation ParseTripScreenshot($imageBase64: String!, $mediaType: String, $todayISO: String) {
        parseTripScreenshot(imageBase64: $imageBase64, mediaType: $mediaType, todayISO: $todayISO)
      }`,
      variables: args,
    })
  } catch (err) {
    // Amplify rejects with a plain { data, errors } object, NOT an Error. Callers that
    // did `String(e)` on it printed "[object Object]" and hid the real cause — which is
    // usually the resolver timing out on a large screenshot.
    return { trips: null, error: graphqlErrorMessage(err) }
  }
  let data: unknown = (res as { data?: { parseTripScreenshot?: unknown } }).data?.parseTripScreenshot
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { /* leave as-is */ } }
  return (data ?? { trips: null, error: 'no-response' }) as { trips: ScreenshotTrip[] | null; error?: string | null }
}

/**
 * A readable message out of whatever the GraphQL client threw.
 *
 * Amplify rejects with `{ data, errors: [{ message }] }` — a plain object, so `instanceof
 * Error` is false and `String(err)` yields "[object Object]". Every rung of the error
 * path has to unwrap it or the user is told nothing at all.
 */
export function graphqlErrorMessage(err: unknown): string {
  const core = graphqlErrorText(err)
  if (core) return /timeout|timed out/i.test(core)
    ? 'The screenshot took too long to read. Crop to just the trips table (or split a long list into two screenshots) and try again.'
    : core
  return 'Something went wrong reading the screenshot.'
}

/**
 * Neutral core: Error.message → errors[].message joined → string → ''. No feature copy,
 * so directory/geocode/vendor-AP callers can surface the Lambda's own words.
 */
export function graphqlErrorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  const errors = (err as { errors?: { message?: string }[] } | null)?.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const joined = errors.map((e) => e?.message).filter(Boolean).join('; ')
    if (joined) return joined
  }
  return typeof err === 'string' ? err : ''
}

// ── Vehicle quote email (Best Care Auto Transport) ─────────────────────────────

/**
 * Send the branded HTML vehicle-transport quote. `html` is built on the frontend
 * (src/lib/quoteEmail.ts) so the preview and the sent email match. The Lambda sends
 * from ruben@bcatcorp.com and always CCs cars@bcatcorp.com (visible to the customer).
 */
export async function sendVehicleQuoteEmail(args: {
  to: string
  subject: string
  html: string
  replyTo?: string
}): Promise<{ sent: boolean; to?: string; cc?: string; error?: string }> {
  const res = await client.graphql({
    query: `mutation SendVehicleQuoteEmail(
      $to: String!, $subject: String!, $html: String!, $replyTo: String
    ) {
      sendVehicleQuoteEmail(to: $to, subject: $subject, html: $html, replyTo: $replyTo)
    }`,
    variables: args,
  })
  let data: unknown = (res as { data?: { sendVehicleQuoteEmail?: unknown } }).data?.sendVehicleQuoteEmail
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { /* leave as-is */ } }
  return (data ?? { sent: false, error: 'no-response' }) as { sent: boolean; to?: string; cc?: string; error?: string }
}

export interface GoogleReviewsResult {
  configured: boolean
  ok: boolean
  rating: number | null
  total: number | null
  url: string | null
  error?: string
}

/** Live Google rating + review count for the Best Care Auto Transport listing. */
export async function getGoogleReviews(): Promise<GoogleReviewsResult> {
  const res = await client.graphql({ query: `query GetGoogleReviews { getGoogleReviews }` })
  let data: unknown = (res as { data?: { getGoogleReviews?: unknown } }).data?.getGoogleReviews
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { /* leave as-is */ } }
  return (data ?? { configured: false, ok: false, rating: null, total: null, url: null }) as GoogleReviewsResult
}

// ── User management ───────────────────────────────────────────────────────────

export interface CognitoUser {
  username: string
  email: string
  status: string
  enabled: boolean
  createdAt: string
}

// AppSync AWSJSON round-trips can return a parsed value, a JSON string, or even a
// double-encoded JSON string (the Lambda does JSON.stringify(...) into an a.json()
// field). Unwrap string layers until we reach the real value so a double-encoded
// array doesn't end up as a string (which callers then treat as empty).
function unwrapJson(raw: unknown): unknown {
  let v = raw
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  return v
}

export async function listCognitoUsers(): Promise<CognitoUser[]> {
  const result = await client.graphql({
    query: `query ManageUsers($action: String!) { manageUsers(action: $action) }`,
    variables: { action: 'list' },
  }) as { data: { manageUsers: unknown } }
  const v = unwrapJson(result.data.manageUsers)
  if (Array.isArray(v)) return v as CognitoUser[]
  // null means the Lambda didn't return a value — surface as error instead of silently showing 0 users
  if (v == null) {
    throw new Error('manageUsers returned null — Lambda may not be deployed or USER_POOL_ID may be misconfigured.')
  }
  throw new Error(`manageUsers returned an unexpected shape (${typeof v}): ${JSON.stringify(v).slice(0, 300)}`)
}

export async function createCognitoUser(email: string): Promise<void> {
  await client.graphql({
    query: `query ManageUsers($action: String!, $email: String) { manageUsers(action: $action, email: $email) }`,
    variables: { action: 'create', email },
  })
}

export async function disableCognitoUser(username: string): Promise<void> {
  await client.graphql({
    query: `query ManageUsers($action: String!, $username: String) { manageUsers(action: $action, username: $username) }`,
    variables: { action: 'disable', username },
  })
}

export async function enableCognitoUser(username: string): Promise<void> {
  await client.graphql({
    query: `query ManageUsers($action: String!, $username: String) { manageUsers(action: $action, username: $username) }`,
    variables: { action: 'enable', username },
  })
}

/** Remove the user from the pool entirely. Owner only; the owner account itself is refused. */
export async function deleteCognitoUser(username: string): Promise<void> {
  await client.graphql({
    query: `query ManageUsers($action: String!, $username: String) { manageUsers(action: $action, username: $username) }`,
    variables: { action: 'delete', username },
  })
}

export async function getUserGroups(username: string): Promise<string[]> {
  const result = await client.graphql({
    query: `query ManageUsers($action: String!, $username: String) { manageUsers(action: $action, username: $username) }`,
    variables: { action: 'getGroups', username },
  }) as { data: { manageUsers: unknown } }
  const v = unwrapJson(result.data.manageUsers)
  return Array.isArray(v) ? v as string[] : []
}

export async function setUserPageGroups(username: string, pages: string[]): Promise<void> {
  await client.graphql({
    query: `query ManageUsers($action: String!, $username: String, $pages: String) { manageUsers(action: $action, username: $username, pages: $pages) }`,
    variables: { action: 'setPageGroups', username, pages: JSON.stringify(pages) },
  })
}

export async function resetCognitoPassword(username: string): Promise<void> {
  await client.graphql({
    query: `query ManageUsers($action: String!, $username: String) { manageUsers(action: $action, username: $username) }`,
    variables: { action: 'resetPassword', username },
  })
}

export async function setUserAdmin(username: string, isAdmin: boolean): Promise<void> {
  await client.graphql({
    query: `query ManageUsers($action: String!, $username: String, $isAdmin: Boolean) { manageUsers(action: $action, username: $username, isAdmin: $isAdmin) }`,
    variables: { action: 'setAdmin', username, isAdmin },
  })
}

// ── Driver availability ────────────────────────────────────────────────────────

export interface DriverAvailability {
  id: string
  driverId: string
  type: 'FULL_DAY_OFF' | 'EARLY_START' | 'LATE_START'
  startDate: string
  endDate: string
  time?: string | null
  note?: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

const DA_FIELDS = `id driverId type startDate endDate time note createdBy createdAt updatedAt`

export async function listDriverAvailabilities(): Promise<DriverAvailability[]> {
  const result = await client.graphql({
    query: `query ListDriverAvailabilities { listDriverAvailabilities(limit: 2000) { items { ${DA_FIELDS} } } }`,
  }) as { data: { listDriverAvailabilities: { items: DriverAvailability[] } } }
  return result.data.listDriverAvailabilities.items ?? []
}

export async function createDriverAvailability(
  input: Omit<DriverAvailability, 'id' | 'createdAt' | 'updatedAt'>
): Promise<DriverAvailability> {
  const result = await client.graphql({
    query: `mutation CreateDriverAvailability($input: CreateDriverAvailabilityInput!) { createDriverAvailability(input: $input) { ${DA_FIELDS} } }`,
    variables: { input },
  }) as { data: { createDriverAvailability: DriverAvailability } }
  return result.data.createDriverAvailability
}

export async function updateDriverAvailability(
  id: string,
  patch: Partial<Omit<DriverAvailability, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<DriverAvailability> {
  const result = await client.graphql({
    query: `mutation UpdateDriverAvailability($input: UpdateDriverAvailabilityInput!) { updateDriverAvailability(input: $input) { ${DA_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateDriverAvailability: DriverAvailability } }
  return result.data.updateDriverAvailability
}

export async function deleteDriverAvailability(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteDriverAvailability($input: DeleteDriverAvailabilityInput!) { deleteDriverAvailability(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

/**
 * Real-time driver-availability changes — keeps every open calendar in sync when any
 * user adds, edits, or removes a time-off / availability entry. Mirrors
 * subscribeToLoadChanges. Returns an unsubscribe function.
 */
export function subscribeToDriverAvailabilityChanges(callbacks: {
  onCreate?: (a: DriverAvailability) => void
  onUpdate?: (a: DriverAvailability) => void
  onDelete?: (id: string) => void
}): () => void {
  const handles: SubscriptionHandle[] = []
  function wire<T>(query: string, pick: (data: T) => void) {
    const handle = (client.graphql({ query }) as unknown as Subscribable<T>)
      .subscribe({ next: ({ data }) => pick(data), error: (e) => console.warn('[subscription] error:', e) })
    handles.push(handle)
  }
  if (callbacks.onCreate) {
    const cb = callbacks.onCreate
    wire<{ onCreateDriverAvailability: DriverAvailability }>(
      `subscription OnCreateDriverAvailability { onCreateDriverAvailability { ${DA_FIELDS} } }`,
      (d) => { if (d.onCreateDriverAvailability) cb(d.onCreateDriverAvailability) },
    )
  }
  if (callbacks.onUpdate) {
    const cb = callbacks.onUpdate
    wire<{ onUpdateDriverAvailability: DriverAvailability }>(
      `subscription OnUpdateDriverAvailability { onUpdateDriverAvailability { ${DA_FIELDS} } }`,
      (d) => { if (d.onUpdateDriverAvailability) cb(d.onUpdateDriverAvailability) },
    )
  }
  if (callbacks.onDelete) {
    const cb = callbacks.onDelete
    wire<{ onDeleteDriverAvailability: { id: string } }>(
      `subscription OnDeleteDriverAvailability { onDeleteDriverAvailability { id } }`,
      (d) => { if (d.onDeleteDriverAvailability?.id) cb(d.onDeleteDriverAvailability.id) },
    )
  }
  return () => handles.forEach((h) => h.unsubscribe())
}

// ── Amazon disputes ─────────────────────────────────────────────────────────────

import type { AmazonDispute, DisputeEvidence } from '@/types/dispute'

const DISPUTE_BASE_FIELDS = `
  id driverName tripNumber shipmentDate payPeriod amountPaid amountRequested
  description photoUrl status resolvedAmount submittedAt source externalId
  notes createdAt updatedAt
`

// Fields added after an earlier deploy. During the ~2 min Amplify rollout the live schema
// can still be missing them, and AppSync fails the WHOLE query on an unknown selection —
// which used to empty the disputes page. A read drops exactly the fields the error names
// and retries; the next read asks for everything again, so it heals itself once deployed.
const DISPUTE_PENDING_FIELDS = [
  'evidence', 'amazonResponse', 'amazonResponseAt', 'amazonResponseBy',
  'settlementPeriodStart', 'settlementTripId', 'settlementDriverId',
] as const

const disputeFields = (dropped: ReadonlySet<string> = new Set()) =>
  [DISPUTE_BASE_FIELDS, ...DISPUTE_PENDING_FIELDS.filter((f) => !dropped.has(f))].join(' ')

/** Newer dispute fields an AppSync error reports as undefined (backend predates them). */
export function undefinedDisputeFields(err: unknown): string[] {
  const text = safeStringify(err)
  return DISPUTE_PENDING_FIELDS.filter((f) => text.includes(`'${f}'`))
}

/**
 * Writes never silently drop a field: losing the Amazon response text staff just typed
 * while reporting success is worse than refusing the save.
 */
function rethrowDisputeWriteError(err: unknown): never {
  const missing = undefinedDisputeFields(err)
  if (missing.length > 0) {
    throw new Error(
      `The backend hasn't deployed ${missing.join(', ')} yet — nothing was saved. Retry once the Amplify deploy finishes.`,
    )
  }
  throw err
}

function parseEvidence(raw: unknown): DisputeEvidence[] | null {
  if (raw == null) return null
  if (Array.isArray(raw)) return raw as DisputeEvidence[]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as DisputeEvidence[]) : null
    } catch {
      return null
    }
  }
  return null
}

function normalizeDispute(d: AmazonDispute): AmazonDispute {
  return { ...d, evidence: parseEvidence(d.evidence as unknown) }
}

function serializeDisputeInput<T extends { evidence?: unknown }>(input: T): T {
  if (!('evidence' in (input as object))) return input
  const { evidence, ...rest } = input as T & { evidence?: unknown }
  if (evidence == null) return rest as T
  return { ...rest, evidence: JSON.stringify(evidence) } as T
}

export async function listAmazonDisputes(): Promise<AmazonDispute[]> {
  const run = async (dropped: ReadonlySet<string>) => {
    const items: AmazonDispute[] = []
    let nextToken: string | null = null
    do {
      const result = await client.graphql({
        query: `query ListAmazonDisputes($nextToken: String) { listAmazonDisputes(limit: 1000, nextToken: $nextToken) { items { ${disputeFields(dropped)} } nextToken } }`,
        variables: { nextToken },
      }) as {
        data: {
          listAmazonDisputes: {
            items: (AmazonDispute | null)[]
            nextToken?: string | null
          }
        }
      }
      const page = result.data.listAmazonDisputes
      for (const item of page.items ?? []) if (item) items.push(item)
      nextToken = page.nextToken ?? null
    } while (nextToken)
    return items
  }

  const dropped = new Set<string>()
  for (;;) {
    try {
      const items = await run(dropped)
      return items.map(normalizeDispute)
    } catch (err) {
      const missing = undefinedDisputeFields(err).filter((f) => !dropped.has(f))
      if (missing.length === 0) throw err
      console.warn(`[apiClient] backend has no ${missing.join(', ')} on AmazonDispute yet — querying without them until deploy`)
      for (const f of missing) dropped.add(f)
    }
  }
}

export async function createAmazonDispute(
  input: Omit<AmazonDispute, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<AmazonDispute> {
  try {
    const result = await client.graphql({
      query: `mutation CreateAmazonDispute($input: CreateAmazonDisputeInput!) { createAmazonDispute(input: $input) { ${disputeFields()} } }`,
      variables: { input: serializeDisputeInput(input) },
    }) as { data: { createAmazonDispute: AmazonDispute } }
    return normalizeDispute(result.data.createAmazonDispute)
  } catch (err) {
    rethrowDisputeWriteError(err)
  }
}

export async function updateAmazonDispute(
  id: string,
  patch: Partial<Omit<AmazonDispute, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<AmazonDispute> {
  try {
    const result = await client.graphql({
      query: `mutation UpdateAmazonDispute($input: UpdateAmazonDisputeInput!) { updateAmazonDispute(input: $input) { ${disputeFields()} } }`,
      variables: { input: serializeDisputeInput({ id, ...patch }) },
    }) as { data: { updateAmazonDispute: AmazonDispute } }
    return normalizeDispute(result.data.updateAmazonDispute)
  } catch (err) {
    rethrowDisputeWriteError(err)
  }
}

export async function deleteAmazonDispute(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteAmazonDispute($input: DeleteAmazonDisputeInput!) { deleteAmazonDispute(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

export async function getDisputeEvidenceUrl(key: string): Promise<string> {
  const result = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

/**
 * Staff upload of Amazon's reply. Driver uploads live under dispute-proofs/ and staff have
 * no write grant there — keeping Amazon screenshots in their own prefix leaves the driver's
 * evidence untouchable while staff can replace their own.
 */
export async function uploadDisputeResponseImage(disputeId: string, file: File): Promise<string> {
  const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-80) || 'amazon-response'
  const key = `dispute-responses/${disputeId}/${Date.now()}-${safeName}`
  await uploadData({ path: key, data: file, options: { contentType: file.type || 'application/octet-stream' } }).result
  return key
}

export async function deleteDisputeResponseImage(key: string): Promise<void> {
  await remove({ path: key })
}

/**
 * Staff upload of manual dispute proof. Driver portal uploads live under dispute-proofs/
 * and staff have no write grant there; staff-created manual disputes keep their proof in
 * a separate prefix so staff can manage their own files without touching the driver's.
 */
export async function uploadDisputeStaffProof(
  disputeId: string,
  file: File,
  kind: 'CONFIRMATION' | 'PHOTO',
): Promise<string> {
  const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-80) || kind.toLowerCase()
  const key = `dispute-staff-proofs/${disputeId}/${Date.now()}-${kind.toLowerCase()}-${safeName}`
  await uploadData({
    path: key,
    data: file,
    options: { contentType: fileContentType(file) || 'application/octet-stream' },
  }).result
  return key
}

export async function deleteDisputeStaffProof(key: string): Promise<void> {
  await remove({ path: key })
}

// ── S3 rate confirmations ─────────────────────────────────────────────────────

export async function uploadRateConfirm(loadId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const key = `rate-confirms/${loadId}/rate-confirm.${ext}`
  await uploadData({ path: key, data: file, options: { contentType: file.type } }).result
  return key
}

// ── Appointment booking proofs (Appts page) ────────────────────────────────────
// One screenshot per (stop, slot): slot 'e2open' = the E2Open update, 'email' = the
// email confirmation. Pasted images arrive as Blobs with no name; type decides the ext.

export type ApptProofSlot = 'request' | 'e2open' | 'email'

export async function uploadApptProof(loadId: string, stopId: string, slot: ApptProofSlot, file: Blob): Promise<string> {
  const ext = file.type === 'image/png' ? 'png' : 'jpg'
  // Timestamped so a re-upload never collides with a cached old proof.
  const key = `appt-proofs/${loadId}/${stopId.replace(/[^\w.-]+/g, '_')}/${slot}-${Date.now()}.${ext}`
  await uploadData({ path: key, data: file, options: { contentType: file.type || 'image/jpeg' } }).result
  return key
}

export async function getApptProofUrl(key: string): Promise<string> {
  const result = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

export async function deleteApptProof(key: string): Promise<void> {
  await remove({ path: key })
}

export async function getRateConfirmUrl(key: string): Promise<string> {
  const result = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

/**
 * Presigned GET for a shipment document's bytes. Deliberately keyed by the row's own
 * `s3Key` rather than a prefix: a pointer row's bytes live where the driver app or the
 * old rate-con store already put them, and the browser's read grant covers all three.
 */
export async function getShipmentDocumentUrl(key: string): Promise<string> {
  const result = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

export async function deleteRateConfirm(key: string): Promise<void> {
  await remove({ path: key })
}

// ── S3 driver-pay master CSV archive ───────────────────────────────────────────

export async function uploadPayMasterFile(periodStart: string, fileName: string, text: string): Promise<{ key: string; size: number }> {
  const safe = (fileName || 'master.csv').replace(/[^\w.-]+/g, '_')
  const key = `driver-pay-masters/${periodStart}/${Date.now()}-${safe}`
  await uploadData({ path: key, data: text, options: { contentType: 'text/csv' } }).result
  return { key, size: new Blob([text]).size }
}

export async function getPayMasterUrl(key: string): Promise<string> {
  const result = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

export async function deletePayMasterFile(key: string): Promise<void> {
  await remove({ path: key })
}

// ── S3 driver photos ──────────────────────────────────────────────────────────

export async function uploadDriverPhoto(driverId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const key = `driver-photos/${driverId}.${ext}`
  await uploadData({ path: key, data: file, options: { contentType: file.type } }).result
  return key
}

export async function getDriverPhotoUrl(key: string): Promise<string> {
  const result = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

export async function deleteDriverPhoto(key: string): Promise<void> {
  await remove({ path: key })
}

// ── Expense types ─────────────────────────────────────────────────────────────

export type ExpenseCategory = 'FUEL' | 'INSURANCE' | 'FINANCING' | 'LEASE' | 'MAINTENANCE' | 'PERMITS' | 'TOLLS' | 'OTHER'
export type EntryMethod = 'FIXED' | 'MANUAL' | 'AUTO_INGESTED'

export interface ExpenseTypeData {
  id: string
  name: string
  category: ExpenseCategory
  defaultEntryMethod: EntryMethod
  active: boolean
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface TruckExpenseAllocationData {
  id: string
  expenseTypeId: string
  allocationMethod: 'DIRECT' | 'SPLIT_EVEN'
  truckIds?: string[]
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface ExpenseRecordData {
  id: string
  expenseTypeId: string
  allocationId?: string | null
  amount: number
  periodMonth?: string | null    // "2026-05"
  transactionDate?: string | null
  entryMethod?: EntryMethod | null
  directTruckId?: string | null
  notes?: string | null
  source?: string | null
  createdAt: string
  updatedAt: string
}

export interface RecurringExpenseData {
  id: string
  expenseTypeId: string
  allocationId: string
  monthlyAmount: number
  startMonth: string
  endMonth?: string | null
  /** The day the amount took effect / stopped (YYYY-MM-DD); the boundary months are prorated by day. */
  startDate?: string | null
  endDate?: string | null
  active: boolean
  notes?: string | null
  createdAt: string
  updatedAt: string
}

const EXPENSE_TYPE_FIELDS = `id name category defaultEntryMethod active notes createdAt updatedAt`
const ALLOCATION_FIELDS   = `id expenseTypeId allocationMethod truckIds notes createdAt updatedAt`
const EXPENSE_REC_FIELDS  = `id expenseTypeId allocationId amount periodMonth transactionDate entryMethod directTruckId notes source createdAt updatedAt`
const RECURRING_FIELDS    = `id expenseTypeId allocationId monthlyAmount startMonth endMonth startDate endDate active notes createdAt updatedAt`

export async function listExpenseTypes(): Promise<ExpenseTypeData[]> {
  const result = await client.graphql({
    query: `query ListExpenseTypes { listExpenseTypes(limit: 1000) { items { ${EXPENSE_TYPE_FIELDS} } } }`,
  }) as { data: { listExpenseTypes: { items: ExpenseTypeData[] } } }
  return result.data.listExpenseTypes.items ?? []
}

export async function createExpenseType(input: Omit<ExpenseTypeData, 'id' | 'createdAt' | 'updatedAt'>): Promise<ExpenseTypeData> {
  const result = await client.graphql({
    query: `mutation CreateExpenseType($input: CreateExpenseTypeInput!) { createExpenseType(input: $input) { ${EXPENSE_TYPE_FIELDS} } }`,
    variables: { input },
  }) as { data: { createExpenseType: ExpenseTypeData } }
  return result.data.createExpenseType
}

export async function updateExpenseType(id: string, patch: Partial<Omit<ExpenseTypeData, 'id' | 'createdAt'>>): Promise<ExpenseTypeData> {
  const result = await client.graphql({
    query: `mutation UpdateExpenseType($input: UpdateExpenseTypeInput!) { updateExpenseType(input: $input) { ${EXPENSE_TYPE_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateExpenseType: ExpenseTypeData } }
  return result.data.updateExpenseType
}

export async function deleteExpenseType(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteExpenseType($input: DeleteExpenseTypeInput!) { deleteExpenseType(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

export async function listAllocations(): Promise<TruckExpenseAllocationData[]> {
  const result = await client.graphql({
    query: `query ListTruckExpenseAllocations { listTruckExpenseAllocations(limit: 1000) { items { ${ALLOCATION_FIELDS} } } }`,
  }) as { data: { listTruckExpenseAllocations: { items: TruckExpenseAllocationData[] } } }
  return result.data.listTruckExpenseAllocations.items ?? []
}

export async function createAllocation(input: Omit<TruckExpenseAllocationData, 'id' | 'createdAt' | 'updatedAt'>): Promise<TruckExpenseAllocationData> {
  const result = await client.graphql({
    query: `mutation CreateTruckExpenseAllocation($input: CreateTruckExpenseAllocationInput!) { createTruckExpenseAllocation(input: $input) { ${ALLOCATION_FIELDS} } }`,
    variables: { input },
  }) as { data: { createTruckExpenseAllocation: TruckExpenseAllocationData } }
  return result.data.createTruckExpenseAllocation
}

export async function updateAllocation(id: string, patch: Partial<Omit<TruckExpenseAllocationData, 'id' | 'createdAt'>>): Promise<TruckExpenseAllocationData> {
  const result = await client.graphql({
    query: `mutation UpdateTruckExpenseAllocation($input: UpdateTruckExpenseAllocationInput!) { updateTruckExpenseAllocation(input: $input) { ${ALLOCATION_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateTruckExpenseAllocation: TruckExpenseAllocationData } }
  return result.data.updateTruckExpenseAllocation
}

export async function deleteAllocation(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteTruckExpenseAllocation($input: DeleteTruckExpenseAllocationInput!) { deleteTruckExpenseAllocation(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

export async function listExpenseRecords(): Promise<ExpenseRecordData[]> {
  const result = await client.graphql({
    query: `query ListExpenseRecords { listExpenseRecords(limit: 10000) { items { ${EXPENSE_REC_FIELDS} } } }`,
  }) as { data: { listExpenseRecords: { items: ExpenseRecordData[] } } }
  return result.data.listExpenseRecords.items ?? []
}

export async function createExpenseRecord(input: Omit<ExpenseRecordData, 'id' | 'createdAt' | 'updatedAt'>): Promise<ExpenseRecordData> {
  const result = await client.graphql({
    query: `mutation CreateExpenseRecord($input: CreateExpenseRecordInput!) { createExpenseRecord(input: $input) { ${EXPENSE_REC_FIELDS} } }`,
    variables: { input },
  }) as { data: { createExpenseRecord: ExpenseRecordData } }
  return result.data.createExpenseRecord
}

export async function updateExpenseRecord(id: string, patch: Partial<Omit<ExpenseRecordData, 'id' | 'createdAt'>>): Promise<ExpenseRecordData> {
  const result = await client.graphql({
    query: `mutation UpdateExpenseRecord($input: UpdateExpenseRecordInput!) { updateExpenseRecord(input: $input) { ${EXPENSE_REC_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateExpenseRecord: ExpenseRecordData } }
  return result.data.updateExpenseRecord
}

export async function deleteExpenseRecord(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteExpenseRecord($input: DeleteExpenseRecordInput!) { deleteExpenseRecord(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

export async function listRecurringExpenses(): Promise<RecurringExpenseData[]> {
  const result = await client.graphql({
    query: `query ListRecurringExpenses { listRecurringExpenses(limit: 1000) { items { ${RECURRING_FIELDS} } } }`,
  }) as { data: { listRecurringExpenses: { items: RecurringExpenseData[] } } }
  return result.data.listRecurringExpenses.items ?? []
}

export async function createRecurringExpense(input: Omit<RecurringExpenseData, 'id' | 'createdAt' | 'updatedAt'>): Promise<RecurringExpenseData> {
  const result = await client.graphql({
    query: `mutation CreateRecurringExpense($input: CreateRecurringExpenseInput!) { createRecurringExpense(input: $input) { ${RECURRING_FIELDS} } }`,
    variables: { input },
  }) as { data: { createRecurringExpense: RecurringExpenseData } }
  return result.data.createRecurringExpense
}

export async function updateRecurringExpense(id: string, patch: Partial<Omit<RecurringExpenseData, 'id' | 'createdAt'>>): Promise<RecurringExpenseData> {
  const result = await client.graphql({
    query: `mutation UpdateRecurringExpense($input: UpdateRecurringExpenseInput!) { updateRecurringExpense(input: $input) { ${RECURRING_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateRecurringExpense: RecurringExpenseData } }
  return result.data.updateRecurringExpense
}

export async function deleteRecurringExpense(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteRecurringExpense($input: DeleteRecurringExpenseInput!) { deleteRecurringExpense(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function resolveDriverPhotoUrl(driver: Driver): Promise<Driver> {
  if (!driver.photoKey) return driver
  try {
    const url = await getDriverPhotoUrl(driver.photoKey)
    return { ...driver, photoUrl: url }
  } catch {
    return driver
  }
}

// `stops` is an a.json() field — AppSync may return it as a (possibly double-encoded)
// string. Unwrap to a real array; null/garbage → undefined so getStops() falls back to
// the legacy pickup/delivery synthesis rather than crashing a view.
function normalizeLoadStops<T extends { stops?: unknown; paperworkLocation?: unknown }>(load: T): T {
  // paperworkLocation is a.json() too; same unwrap, object or nothing.
  const pl = load.paperworkLocation == null ? load.paperworkLocation : unwrapJson(load.paperworkLocation)
  const withPl = { ...load, paperworkLocation: pl && typeof pl === 'object' ? pl : null }
  if (load.stops == null) return withPl
  const v = unwrapJson(load.stops)
  return { ...withPl, stops: Array.isArray(v) ? v : undefined }
}

async function resolveRateConfirmUrl(
  raw: Load & { rateConfirmKey?: string }
): Promise<Load> {
  const load = normalizeLoadStops(raw)
  if (!load.rateConfirmKey) return load
  try {
    const url = await getRateConfirmUrl(load.rateConfirmKey)
    return { ...load, rateConfirmUrl: url }
  } catch {
    return load
  }
}

// ── TruckConfig ───────────────────────────────────────────────────────────────

export interface TruckConfig {
  truckId:             string
  unitNumber:          string
  ownershipType?:      'COMPANY' | 'OWNER_OPERATOR' | 'LEASED'
  motiveVehicleId?:    number | null
  motiveVehicleNumber?: string | null
  // DOT onboarding / compliance (internal only)
  onboardingStatus?:      'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE' | null
  complianceStatus?:      'COMPLIANT' | 'EXPIRING_SOON' | 'NON_COMPLIANT' | 'UNKNOWN' | null
  assignedFuelCardNumber?: string | null   // LAST 4 ONLY
  assignedPhone?:         string | null
  assignedTablet?:        string | null
  eldSerialNumber?:       string | null
  inServiceDate?:         string | null
  createdAt:           string
  updatedAt:           string
}

const TRUCK_CONFIG_FIELDS = `truckId unitNumber ownershipType motiveVehicleId motiveVehicleNumber onboardingStatus complianceStatus assignedFuelCardNumber assignedPhone assignedTablet eldSerialNumber inServiceDate createdAt updatedAt`

export async function listTruckConfigs(): Promise<TruckConfig[]> {
  const result = await client.graphql({
    query: `query ListTruckConfigs { listTruckConfigs(limit: 100) { items { ${TRUCK_CONFIG_FIELDS} } } }`,
  }) as { data: { listTruckConfigs: { items: TruckConfig[] } } }
  return result.data.listTruckConfigs.items ?? []
}

export async function upsertTruckConfig(
  input: Pick<TruckConfig, 'truckId' | 'unitNumber'> & Partial<Omit<TruckConfig, 'truckId' | 'unitNumber' | 'createdAt' | 'updatedAt'>>,
): Promise<TruckConfig> {
  // Try update first; if it doesn't exist, create it
  try {
    const result = await client.graphql({
      query: `mutation UpdateTruckConfig($input: UpdateTruckConfigInput!) { updateTruckConfig(input: $input) { ${TRUCK_CONFIG_FIELDS} } }`,
      variables: { input },
    }) as { data: { updateTruckConfig: TruckConfig } }
    return result.data.updateTruckConfig
  } catch {
    const result = await client.graphql({
      query: `mutation CreateTruckConfig($input: CreateTruckConfigInput!) { createTruckConfig(input: $input) { ${TRUCK_CONFIG_FIELDS} } }`,
      variables: { input },
    }) as { data: { createTruckConfig: TruckConfig } }
    return result.data.createTruckConfig
  }
}

// ── Company phones (Ivan local drivers) ─────────────────────────────────────────

export interface CompanyPhone {
  label: string
  number?: string | null
  assignedDriverId?: string | null
  sortOrder?: number | null
}

const COMPANY_PHONE_FIELDS = `label number assignedDriverId sortOrder`

export async function listCompanyPhones(): Promise<CompanyPhone[]> {
  const result = await client.graphql({
    query: `query ListCompanyPhones { listCompanyPhones(limit: 1000) { items { ${COMPANY_PHONE_FIELDS} } } }`,
  }) as { data: { listCompanyPhones: { items: CompanyPhone[] } } }
  return (result.data.listCompanyPhones.items ?? [])
    .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99) || a.label.localeCompare(b.label))
}

export async function createCompanyPhone(input: CompanyPhone): Promise<CompanyPhone> {
  const result = await client.graphql({
    query: `mutation CreateCompanyPhone($input: CreateCompanyPhoneInput!) { createCompanyPhone(input: $input) { ${COMPANY_PHONE_FIELDS} } }`,
    variables: { input },
  }) as { data: { createCompanyPhone: CompanyPhone } }
  return result.data.createCompanyPhone
}

export async function updateCompanyPhone(input: Pick<CompanyPhone, 'label'> & Partial<CompanyPhone>): Promise<CompanyPhone> {
  const result = await client.graphql({
    query: `mutation UpdateCompanyPhone($input: UpdateCompanyPhoneInput!) { updateCompanyPhone(input: $input) { ${COMPANY_PHONE_FIELDS} } }`,
    variables: { input },
  }) as { data: { updateCompanyPhone: CompanyPhone } }
  return result.data.updateCompanyPhone
}

// ── Equipment (Fleet) ───────────────────────────────────────────────────────────
// Stored field-for-field; the client supplies `id` on create so local/server ids stay aligned.

// Amplify manages createdAt/updatedAt — strip them from create inputs (id is kept).
function withoutTimestamps<T extends object>(o: T): Omit<T, 'createdAt' | 'updatedAt'> {
  const rest = { ...o } as Record<string, unknown>
  delete rest.createdAt
  delete rest.updatedAt
  return rest as Omit<T, 'createdAt' | 'updatedAt'>
}

const EQUIPMENT_FIELDS = `
  id type unitNumber nickname vin plate make model year mileage
  ownership insured active
  dotInspectionDate iftaExpirationDate irpExpirationDate insuranceExpirationDate bobtailInsuranceDate
  assignedDriverId fleetManagerAssignee onTollwayAccount fuelCardNumbers
  eldSource eldSerialNumber motiveVehicleNumber fleetGroup lastPmDate lastPmMileage notes trackingUrl trackingCode inactiveSince
  createdAt updatedAt
`

export async function listEquipment(): Promise<Equipment[]> {
  const result = await client.graphql({
    query: `query ListEquipment { listEquipment(limit: 1000) { items { ${EQUIPMENT_FIELDS} } } }`,
  }) as { data: { listEquipment: { items: Equipment[] } } }
  return result.data.listEquipment.items ?? []
}

export async function createEquipment(input: Equipment): Promise<Equipment> {
  const result = await client.graphql({
    query: `mutation CreateEquipment($input: CreateEquipmentInput!) { createEquipment(input: $input) { ${EQUIPMENT_FIELDS} } }`,
    variables: { input: withoutTimestamps(input) },
  }) as { data: { createEquipment: Equipment } }
  return result.data.createEquipment
}

export async function updateEquipment(
  id: string,
  patch: Partial<Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<Equipment> {
  const result = await client.graphql({
    query: `mutation UpdateEquipment($input: UpdateEquipmentInput!) { updateEquipment(input: $input) { ${EQUIPMENT_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateEquipment: Equipment } }
  return result.data.updateEquipment
}

export async function deleteEquipment(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteEquipment($input: DeleteEquipmentInput!) { deleteEquipment(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Maintenance tasks ───────────────────────────────────────────────────────────

const MAINT_TASK_FIELDS = `
  id equipmentId title dueDate priority status completedDate notes autoDot assignee createdAt updatedAt
`

export async function listMaintenanceTasks(): Promise<MaintenanceTask[]> {
  const result = await client.graphql({
    query: `query ListMaintenanceTasks { listMaintenanceTasks(limit: 5000) { items { ${MAINT_TASK_FIELDS} } } }`,
  }) as { data: { listMaintenanceTasks: { items: MaintenanceTask[] } } }
  return result.data.listMaintenanceTasks.items ?? []
}

export async function createMaintenanceTask(input: MaintenanceTask): Promise<MaintenanceTask> {
  const result = await client.graphql({
    query: `mutation CreateMaintenanceTask($input: CreateMaintenanceTaskInput!) { createMaintenanceTask(input: $input) { ${MAINT_TASK_FIELDS} } }`,
    variables: { input: withoutTimestamps(input) },
  }) as { data: { createMaintenanceTask: MaintenanceTask } }
  return result.data.createMaintenanceTask
}

export async function updateMaintenanceTask(
  id: string,
  patch: Partial<Omit<MaintenanceTask, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<MaintenanceTask> {
  const result = await client.graphql({
    query: `mutation UpdateMaintenanceTask($input: UpdateMaintenanceTaskInput!) { updateMaintenanceTask(input: $input) { ${MAINT_TASK_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateMaintenanceTask: MaintenanceTask } }
  return result.data.updateMaintenanceTask
}

export async function deleteMaintenanceTask(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteMaintenanceTask($input: DeleteMaintenanceTaskInput!) { deleteMaintenanceTask(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Maintenance invoices ──────────────────────────────────────────────────────────

const MAINT_INVOICE_FIELDS = `
  id equipmentId date vendor description amount invoiceNumber paymentMethod paymentDate assignee source status reviewedBy externalId createdAt updatedAt
`

export async function listMaintenanceInvoices(): Promise<MaintenanceInvoice[]> {
  const invoices: MaintenanceInvoice[] = []
  let nextToken: string | null = null
  do {
    const result = await client.graphql({
      query: `query ListMaintenanceInvoices($nextToken: String) { listMaintenanceInvoices(limit: 1000, nextToken: $nextToken) { items { ${MAINT_INVOICE_FIELDS} } nextToken } }`,
      variables: { nextToken },
    }) as { data: { listMaintenanceInvoices: { items: (MaintenanceInvoice | null)[]; nextToken?: string | null } } }
    const page = result.data.listMaintenanceInvoices
    for (const invoice of page.items ?? []) {
      if (invoice) invoices.push(invoice)
    }
    nextToken = page.nextToken ?? null
  } while (nextToken)
  return invoices
}

export async function createMaintenanceInvoice(input: MaintenanceInvoice): Promise<MaintenanceInvoice> {
  const result = await client.graphql({
    query: `mutation CreateMaintenanceInvoice($input: CreateMaintenanceInvoiceInput!) { createMaintenanceInvoice(input: $input) { ${MAINT_INVOICE_FIELDS} } }`,
    variables: { input: withoutTimestamps(input) },
  }) as { data: { createMaintenanceInvoice: MaintenanceInvoice } }
  return result.data.createMaintenanceInvoice
}

export async function updateMaintenanceInvoice(
  id: string,
  patch: Partial<Omit<MaintenanceInvoice, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<MaintenanceInvoice> {
  const result = await client.graphql({
    query: `mutation UpdateMaintenanceInvoice($input: UpdateMaintenanceInvoiceInput!) { updateMaintenanceInvoice(input: $input) { ${MAINT_INVOICE_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateMaintenanceInvoice: MaintenanceInvoice } }
  return result.data.updateMaintenanceInvoice
}

export async function deleteMaintenanceInvoice(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteMaintenanceInvoice($input: DeleteMaintenanceInvoiceInput!) { deleteMaintenanceInvoice(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── TruckMileage ──────────────────────────────────────────────────────────────

export interface TruckMileage {
  truckId:     string
  unitNumber:  string
  periodStart: string   // YYYY-MM-DD
  periodType:  string   // 'WEEK' | 'MONTH'
  miles:       number
  /** US gallons from Motive, driving plus idle. Null when Motive had no fuel for it. */
  gallons?:    number | null
  source:      string
  syncedAt:    string
  createdAt:   string
  updatedAt:   string
}

const TRUCK_MILEAGE_FIELDS = `truckId unitNumber periodStart periodType miles gallons source syncedAt createdAt updatedAt`

/**
 * List mileage records. With a truckId, returns that truck's full history (all
 * period types). Without, returns the whole fleet — pass a periodType to fetch only
 * that granularity (DAY/WEEK/MONTH/YEAR), which keeps payloads small as DAY records
 * accumulate.
 */
export async function listTruckMileages(truckId?: string, periodType?: string): Promise<TruckMileage[]> {
  if (truckId) {
    const result = await client.graphql({
      query: `query ListByTruck($truckId: String!) {
        listTruckMileageByTruckIdAndPeriodStart(truckId: $truckId, limit: 2000) {
          items { ${TRUCK_MILEAGE_FIELDS} }
        }
      }`,
      variables: { truckId },
    }) as { data: { listTruckMileageByTruckIdAndPeriodStart: { items: TruckMileage[] } } }
    return result.data.listTruckMileageByTruckIdAndPeriodStart.items ?? []
  }
  const result = await client.graphql({
    query: `query ListTruckMileages($filter: ModelTruckMileageFilterInput) {
      listTruckMileages(limit: 10000, filter: $filter) { items { ${TRUCK_MILEAGE_FIELDS} } }
    }`,
    variables: periodType ? { filter: { periodType: { eq: periodType } } } : {},
  }) as { data: { listTruckMileages: { items: TruckMileage[] } } }
  return result.data.listTruckMileages.items ?? []
}

// ── TruckLocation ───────────────────────────────────────────────────────────────

export interface TruckLocation {
  truckId:      string
  unitNumber:   string
  lat:          number
  lon:          number
  bearing:      number | null
  speed:        number | null
  locatedAt:    string   // ISO timestamp Motive reported the fix
  description:  string | null
  motion:       string | null   // 'MOVING' | 'STATIONARY'
  motionSince:  string | null   // ISO timestamp the truck entered its current motion state
  odometer:     number | null   // latest odometer (miles) from Motive, if reported
  source:       string
  syncedAt:     string
  createdAt:    string
  updatedAt:    string
}

const TRUCK_LOCATION_FIELDS = `truckId unitNumber lat lon bearing speed locatedAt description motion motionSince odometer source syncedAt createdAt updatedAt`

/** Current location of every truck (one row per truck, latest fix). */
export async function listTruckLocations(): Promise<TruckLocation[]> {
  const result = await client.graphql({
    query: `query ListTruckLocations { listTruckLocations(limit: 5000) { items { ${TRUCK_LOCATION_FIELDS} } } }`,
  }) as { data: { listTruckLocations: { items: TruckLocation[] } } }
  return result.data.listTruckLocations.items ?? []
}

// ── TruckFaultCode ──────────────────────────────────────────────────────────────

export interface TruckFaultCode {
  truckId:          string
  faultId:          string
  unitNumber:       string
  code:             string
  description?:     string | null
  sourceLabel?:     string | null
  fmiDescription?:  string | null
  faultType?:       string | null
  occurrenceCount?: number | null
  firstObservedAt?: string | null
  lastObservedAt?:  string | null
  vehicleMake?:     string | null
  vehicleModel?:    string | null
  network?:         string | null
  source:           string
  syncedAt:         string
}

const TRUCK_FAULT_CODE_FIELDS = `truckId faultId unitNumber code description sourceLabel fmiDescription faultType occurrenceCount firstObservedAt lastObservedAt vehicleMake vehicleModel network source syncedAt`

/**
 * Every fault code Motive currently reports as open. The sync deletes rows Motive
 * stops reporting, so what comes back IS the live fault list. Returns nothing until
 * the model is deployed rather than breaking the dashboard around it.
 */
export async function listTruckFaultCodes(): Promise<TruckFaultCode[]> {
  try {
    const result = await client.graphql({
      query: `query ListTruckFaultCodes { listTruckFaultCodes(limit: 5000) { items { ${TRUCK_FAULT_CODE_FIELDS} } } }`,
    }) as { data: { listTruckFaultCodes: { items: TruckFaultCode[] } } }
    return result.data.listTruckFaultCodes.items ?? []
  } catch (err) {
    if (/TruckFaultCode/i.test(safeStringify(err))) {
      console.warn('[apiClient] TruckFaultCode not deployed yet — no fault codes shown')
      return []
    }
    throw err
  }
}

const TRUCK_LOCATION_HISTORY_FIELDS = `truckId unitNumber lat lon bearing speed locatedAt description source syncedAt`

/** Breadcrumb history for one truck, oldest → newest, for drawing its trail. */
export async function listTruckLocationHistory(truckId: string): Promise<TruckLocation[]> {
  const result = await client.graphql({
    query: `query ListByTruck($truckId: String!) {
      listTruckLocationHistoryByTruckIdAndLocatedAt(truckId: $truckId, limit: 500) {
        items { ${TRUCK_LOCATION_HISTORY_FIELDS} }
      }
    }`,
    variables: { truckId },
  }) as { data: { listTruckLocationHistoryByTruckIdAndLocatedAt: { items: TruckLocation[] } } }
  return result.data.listTruckLocationHistoryByTruckIdAndLocatedAt.items ?? []
}

// ── DriverPayPeriod ─────────────────────────────────────────────────────────────
// Manual biweekly gross-pay entry. `source` is the Paychex integration seam.

export interface DriverPayPeriod {
  id:          string
  driverId:    string
  periodStart: string   // YYYY-MM-DD (inclusive)
  periodEnd:   string   // YYYY-MM-DD (inclusive)
  grossPay:    number   // dollars
  source?:     'MANUAL' | 'PAYCHEX' | null
  notes?:      string | null
  createdAt:   string
  updatedAt:   string
}

const DRIVER_PAY_FIELDS = `id driverId periodStart periodEnd grossPay source notes createdAt updatedAt`

export async function listDriverPayPeriods(): Promise<DriverPayPeriod[]> {
  const result = await client.graphql({
    query: `query ListDriverPayPeriods { listDriverPayPeriods(limit: 5000) { items { ${DRIVER_PAY_FIELDS} } } }`,
  }) as { data: { listDriverPayPeriods: { items: DriverPayPeriod[] } } }
  return result.data.listDriverPayPeriods.items ?? []
}

export async function createDriverPayPeriod(
  input: Omit<DriverPayPeriod, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<DriverPayPeriod> {
  const result = await client.graphql({
    query: `mutation CreateDriverPayPeriod($input: CreateDriverPayPeriodInput!) { createDriverPayPeriod(input: $input) { ${DRIVER_PAY_FIELDS} } }`,
    variables: { input },
  }) as { data: { createDriverPayPeriod: DriverPayPeriod } }
  return result.data.createDriverPayPeriod
}

export async function updateDriverPayPeriod(
  id: string,
  patch: Partial<Omit<DriverPayPeriod, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<DriverPayPeriod> {
  const result = await client.graphql({
    query: `mutation UpdateDriverPayPeriod($input: UpdateDriverPayPeriodInput!) { updateDriverPayPeriod(input: $input) { ${DRIVER_PAY_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateDriverPayPeriod: DriverPayPeriod } }
  return result.data.updateDriverPayPeriod
}

export async function deleteDriverPayPeriod(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteDriverPayPeriod($input: DeleteDriverPayPeriodInput!) { deleteDriverPayPeriod(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Amazon driver pay ────────────────────────────────────────────────────────

export interface AmazonTrip {
  id:            string
  driverId:      string
  periodStart:   string
  loadId?:       string | null
  origin?:       string | null
  destination?:  string | null
  miles?:        number | null
  equipment?:    string | null
  freightAmount: number
  ratePerMile?:  number | null
  dispatcher?:   string | null
  status?:       string | null
  notes?:        string | null
  sortOrder?:    number | null
  createdAt:     string
  updatedAt:     string
}

const AMAZON_TRIP_FIELDS_BASE = `id driverId periodStart loadId origin destination miles equipment freightAmount ratePerMile dispatcher status notes createdAt updatedAt`
// sortOrder is a newer field; until the backend schema deploys it, querying it errors.
// Detect that once and fall back so existing settlements never disappear during a deploy.
let amazonHasSortOrder = true
const amazonTripFields = () => (amazonHasSortOrder ? `${AMAZON_TRIP_FIELDS_BASE} sortOrder` : AMAZON_TRIP_FIELDS_BASE)
const isMissingSortOrder = (err: unknown) => /sortOrder/i.test(JSON.stringify(err ?? ''))

export async function listAmazonTrips(): Promise<AmazonTrip[]> {
  try {
    const result = await client.graphql({
      query: `query ListAmazonTrips { listAmazonTrips(limit: 10000) { items { ${amazonTripFields()} } } }`,
    }) as { data: { listAmazonTrips: { items: AmazonTrip[] } } }
    return result.data.listAmazonTrips.items ?? []
  } catch (err) {
    if (amazonHasSortOrder && isMissingSortOrder(err)) {
      console.warn("[apiClient] AmazonTrip 'sortOrder' not deployed yet — querying without it")
      amazonHasSortOrder = false
      return listAmazonTrips()
    }
    throw err
  }
}

export async function createAmazonTrip(input: Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>): Promise<AmazonTrip> {
  const { sortOrder: _so, ...rest } = input
  const safeInput = amazonHasSortOrder ? input : rest // drop sortOrder until the field exists
  const result = await client.graphql({
    query: `mutation CreateAmazonTrip($input: CreateAmazonTripInput!) { createAmazonTrip(input: $input) { ${amazonTripFields()} } }`,
    variables: { input: safeInput },
  }) as { data: { createAmazonTrip: AmazonTrip } }
  return result.data.createAmazonTrip
}

export async function updateAmazonTrip(id: string, patch: Partial<Omit<AmazonTrip, 'id' | 'createdAt' | 'updatedAt'>>): Promise<AmazonTrip> {
  const { sortOrder: _so, ...rest } = patch
  const safePatch = amazonHasSortOrder ? patch : rest // skip sortOrder writes until the field exists
  const result = await client.graphql({
    query: `mutation UpdateAmazonTrip($input: UpdateAmazonTripInput!) { updateAmazonTrip(input: $input) { ${amazonTripFields()} } }`,
    variables: { input: { id, ...safePatch } },
  }) as { data: { updateAmazonTrip: AmazonTrip } }
  return result.data.updateAmazonTrip
}

export async function deleteAmazonTrip(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteAmazonTrip($input: DeleteAmazonTripInput!) { deleteAmazonTrip(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Amazon pay master uploads (archive of source CSVs) ──────────────────────────

export interface AmazonPayMaster {
  id:           string
  fileName:     string
  periodStart:  string
  s3Key:        string
  uploadedAt:   string
  uploadedBy?:  string | null
  rowCount?:    number | null
  tripCount?:   number | null
  driverCount?: number | null
  sizeBytes?:   number | null
  notes?:       string | null
  createdAt:    string
  updatedAt:    string
}

const PAY_MASTER_FIELDS = `id fileName periodStart s3Key uploadedAt uploadedBy rowCount tripCount driverCount sizeBytes notes createdAt updatedAt`

export async function listAmazonPayMasters(): Promise<AmazonPayMaster[]> {
  const result = await client.graphql({
    query: `query ListAmazonPayMasters { listAmazonPayMasters(limit: 1000) { items { ${PAY_MASTER_FIELDS} } } }`,
  }) as { data: { listAmazonPayMasters: { items: AmazonPayMaster[] } } }
  return result.data.listAmazonPayMasters.items ?? []
}

export async function createAmazonPayMaster(input: Omit<AmazonPayMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<AmazonPayMaster> {
  const result = await client.graphql({
    query: `mutation CreateAmazonPayMaster($input: CreateAmazonPayMasterInput!) { createAmazonPayMaster(input: $input) { ${PAY_MASTER_FIELDS} } }`,
    variables: { input },
  }) as { data: { createAmazonPayMaster: AmazonPayMaster } }
  return result.data.createAmazonPayMaster
}

export async function deleteAmazonPayMaster(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteAmazonPayMaster($input: DeleteAmazonPayMasterInput!) { deleteAmazonPayMaster(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Box-truck driver pay (Ivan Cartage biweekly shipments) ──────────────────────

export interface BoxTruckTrip {
  id:            string
  driverId:      string
  periodStart:   string
  loadId?:       string | null   // source Load.id when pulled from the calendar
  date?:         string | null   // YYYY-MM-DD shipment/delivery date
  aljexPro?:     string | null   // Aljex PRO # (Load.aljexId)
  proNumber?:    string | null   // PU / TMS #
  customer?:     string | null
  salesRep?:     string | null
  loadDesc?:     string | null
  customerRate?: number | null
  carrierCost?:  number | null
  grossProfit:   number
  status?:       string | null
  notes?:        string | null
  sortOrder?:    number | null
  createdAt:     string
  updatedAt:     string
}

const BOX_TRUCK_FIELDS_BASE = `id driverId periodStart proNumber customer salesRep loadDesc customerRate carrierCost grossProfit status notes createdAt updatedAt`
// These ship in the same migration as the model; fall back if the backend predates them.
const BOX_TRUCK_FIELDS_EXT = `sortOrder loadId date aljexPro`
let boxTruckHasExt = true
const boxTruckFields = () => (boxTruckHasExt ? `${BOX_TRUCK_FIELDS_BASE} ${BOX_TRUCK_FIELDS_EXT}` : BOX_TRUCK_FIELDS_BASE)
const isMissingBtExt = (err: unknown) => /sortOrder|loadId|aljexPro|\bdate\b/i.test(JSON.stringify(err ?? ''))
const stripBtExt = <T extends object>(o: T): Record<string, unknown> => {
  const { sortOrder: _s, loadId: _l, date: _d, aljexPro: _a, ...rest } = o as Record<string, unknown>
  return rest
}

export async function listBoxTruckTrips(): Promise<BoxTruckTrip[]> {
  try {
    const result = await client.graphql({
      query: `query ListBoxTruckTrips { listBoxTruckTrips(limit: 10000) { items { ${boxTruckFields()} } } }`,
    }) as { data: { listBoxTruckTrips: { items: BoxTruckTrip[] } } }
    return result.data.listBoxTruckTrips.items ?? []
  } catch (err) {
    if (boxTruckHasExt && isMissingBtExt(err)) {
      console.warn('[apiClient] BoxTruckTrip extended fields not deployed yet — querying without them')
      boxTruckHasExt = false
      return listBoxTruckTrips()
    }
    throw err
  }
}

export async function createBoxTruckTrip(input: Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>): Promise<BoxTruckTrip> {
  const safeInput = boxTruckHasExt ? input : stripBtExt(input)
  const result = await client.graphql({
    query: `mutation CreateBoxTruckTrip($input: CreateBoxTruckTripInput!) { createBoxTruckTrip(input: $input) { ${boxTruckFields()} } }`,
    variables: { input: safeInput },
  }) as { data: { createBoxTruckTrip: BoxTruckTrip } }
  return result.data.createBoxTruckTrip
}

export async function updateBoxTruckTrip(id: string, patch: Partial<Omit<BoxTruckTrip, 'id' | 'createdAt' | 'updatedAt'>>): Promise<BoxTruckTrip> {
  const safePatch = boxTruckHasExt ? patch : stripBtExt(patch)
  const result = await client.graphql({
    query: `mutation UpdateBoxTruckTrip($input: UpdateBoxTruckTripInput!) { updateBoxTruckTrip(input: $input) { ${boxTruckFields()} } }`,
    variables: { input: { id, ...safePatch } },
  }) as { data: { updateBoxTruckTrip: BoxTruckTrip } }
  return result.data.updateBoxTruckTrip
}

export async function deleteBoxTruckTrip(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteBoxTruckTrip($input: DeleteBoxTruckTripInput!) { deleteBoxTruckTrip(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

/** Calendar-dated expense revisions, persisted intact in the existing JSON field. */
export type FixedExpense = FixedExpenseInput

export interface DriverPaySetting {
  id:                    string
  driverId:              string
  payGroup?:             'AMAZON' | 'LOCAL' | 'BOX_TRUCK' | 'OWNER_OPERATOR' | null
  payPercent:            number
  expensesBeforePercent: boolean
  email?:                string | null
  fuelCardNumber?:       string | null
  /** Dated card windows — see FuelCardWindow in src/lib/driverFuel.ts. */
  fuelCardHistory?:      import('./driverFuel').FuelCardWindow[] | null
  fixedExpenses?:        FixedExpense[] | null
  /** Pinned past rate windows — see PayRateOverride in src/lib/driverPay.ts. */
  rateHistory?:          import('./driverPay').PayRateOverride[] | null
  active?:               boolean | null
  notes?:                string | null
  createdAt:             string
  updatedAt:             string
}

const PAY_SETTING_FIELDS = `id driverId payGroup payPercent expensesBeforePercent email fuelCardNumber fuelCardHistory fixedExpenses rateHistory active notes createdAt updatedAt`

function normalizePaySetting(raw: DriverPaySetting & { fixedExpenses?: unknown; rateHistory?: unknown; fuelCardHistory?: unknown }): DriverPaySetting {
  const v = unwrapJson(raw.fixedExpenses)
  const h = unwrapJson(raw.rateHistory)
  const c = unwrapJson(raw.fuelCardHistory)
  return {
    ...raw,
    fixedExpenses: Array.isArray(v) ? v as FixedExpense[] : [],
    rateHistory: Array.isArray(h) ? h as DriverPaySetting['rateHistory'] : [],
    fuelCardHistory: Array.isArray(c) ? c as DriverPaySetting['fuelCardHistory'] : [],
  }
}

export async function listDriverPaySettings(): Promise<DriverPaySetting[]> {
  const result = await client.graphql({
    query: `query ListDriverPaySettings { listDriverPaySettings(limit: 1000) { items { ${PAY_SETTING_FIELDS} } } }`,
  }) as { data: { listDriverPaySettings: { items: DriverPaySetting[] } } }
  return (result.data.listDriverPaySettings.items ?? []).map(normalizePaySetting)
}

function serializePaySetting<T extends { fixedExpenses?: unknown; rateHistory?: unknown; fuelCardHistory?: unknown }>(input: T): T {
  let out: T = input
  if (out.fixedExpenses != null) out = { ...out, fixedExpenses: JSON.stringify(out.fixedExpenses) }
  if (out.rateHistory != null) out = { ...out, rateHistory: JSON.stringify(out.rateHistory) }
  if (out.fuelCardHistory != null) out = { ...out, fuelCardHistory: JSON.stringify(out.fuelCardHistory) }
  return out
}

export async function createDriverPaySetting(input: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt'>): Promise<DriverPaySetting> {
  const result = await client.graphql({
    query: `mutation CreateDriverPaySetting($input: CreateDriverPaySettingInput!) { createDriverPaySetting(input: $input) { ${PAY_SETTING_FIELDS} } }`,
    variables: { input: serializePaySetting(input) },
  }) as { data: { createDriverPaySetting: DriverPaySetting } }
  return normalizePaySetting(result.data.createDriverPaySetting)
}

export async function updateDriverPaySetting(
  id: string,
  patch: Partial<Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt'>>,
  expectedUpdatedAt: string,
): Promise<DriverPaySetting> {
  if (!expectedUpdatedAt) throw new Error('Reload driver pay settings before saving changes.')
  try {
    const result = await client.graphql({
      query: `mutation UpdateDriverPaySetting($input: UpdateDriverPaySettingInput!, $condition: ModelDriverPaySettingConditionInput) { updateDriverPaySetting(input: $input, condition: $condition) { ${PAY_SETTING_FIELDS} } }`,
      variables: { input: serializePaySetting({ id, ...patch }), condition: { updatedAt: { eq: expectedUpdatedAt } } },
    }) as { data: { updateDriverPaySetting: DriverPaySetting } }
    return normalizePaySetting(result.data.updateDriverPaySetting)
  } catch (err) {
    const errors = (err as { errors?: { errorType?: string }[] })?.errors
    if (errors?.some((error) => error.errorType?.includes('ConditionalCheckFailed'))) {
      throw new Error('These pay settings changed since you opened them. Reload before saving to preserve expense history.', { cause: err })
    }
    throw err
  }
}

export async function deleteDriverPaySetting(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteDriverPaySetting($input: DeleteDriverPaySettingInput!) { deleteDriverPaySetting(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

export interface DriverPayDeduction {
  id:          string
  driverId:    string
  periodStart: string
  label:       string
  amount:      number
  date?:       string | null
  createdAt:   string
  updatedAt:   string
}

const PAY_DEDUCTION_FIELDS = `id driverId periodStart label amount date createdAt updatedAt`

export async function listDriverPayDeductions(): Promise<DriverPayDeduction[]> {
  const result = await client.graphql({
    query: `query ListDriverPayDeductions { listDriverPayDeductions(limit: 10000) { items { ${PAY_DEDUCTION_FIELDS} } } }`,
  }) as { data: { listDriverPayDeductions: { items: DriverPayDeduction[] } } }
  return result.data.listDriverPayDeductions.items ?? []
}

export async function createDriverPayDeduction(input: Omit<DriverPayDeduction, 'id' | 'createdAt' | 'updatedAt'>): Promise<DriverPayDeduction> {
  const result = await client.graphql({
    query: `mutation CreateDriverPayDeduction($input: CreateDriverPayDeductionInput!) { createDriverPayDeduction(input: $input) { ${PAY_DEDUCTION_FIELDS} } }`,
    variables: { input },
  }) as { data: { createDriverPayDeduction: DriverPayDeduction } }
  return result.data.createDriverPayDeduction
}

export async function deleteDriverPayDeduction(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteDriverPayDeduction($input: DeleteDriverPayDeductionInput!) { deleteDriverPayDeduction(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Driver pay credits (extra pay added to a check, e.g. detention / bonus) ─────
// Reason codes live in src/lib/payCredits.ts — stored as a plain string here.

export interface DriverPayCredit {
  id:          string
  driverId:    string
  periodStart: string
  /** null/'CREDIT' = added to the check; 'DEBIT' = subtracted at 100% after the net. */
  kind?:       'CREDIT' | 'DEBIT' | null
  reasonCode:  string
  label?:      string | null
  amount:      number          // dollars ADDED to the check (positive)
  miles?:      number | null   // optional mileage basis for per-mile charges
  costPerMile?: number | null  // optional mileage rate for per-mile charges
  date?:       string | null
  loadRef?:    string | null
  createdBy?:  string | null
  notes?:      string | null
  createdAt:   string
  updatedAt:   string
}

export type DriverPayCreditInput = Omit<DriverPayCredit, 'id' | 'createdAt' | 'updatedAt'>

const PAY_CREDIT_FIELDS = `id driverId periodStart kind reasonCode label amount miles costPerMile date loadRef createdBy notes createdAt updatedAt`

// The model ships with this feature; until the backend migration lands the API has no
// such type. Degrade to "no credits" rather than breaking the whole pay page.
let payCreditsAvailable = true
const isMissingCreditModel = (err: unknown) => /DriverPayCredit/i.test(JSON.stringify(err ?? ''))

/** True once a call has proven the backend doesn't have the credit model deployed. */
export const payCreditsDeployed = () => payCreditsAvailable

export async function listDriverPayCredits(): Promise<DriverPayCredit[]> {
  if (!payCreditsAvailable) return []
  try {
    const result = await client.graphql({
      query: `query ListDriverPayCredits { listDriverPayCredits(limit: 10000) { items { ${PAY_CREDIT_FIELDS} } } }`,
    }) as { data: { listDriverPayCredits: { items: DriverPayCredit[] } } }
    return result.data.listDriverPayCredits.items ?? []
  } catch (err) {
    if (isMissingCreditModel(err)) {
      console.warn('[apiClient] DriverPayCredit not deployed yet — treating credits as empty')
      payCreditsAvailable = false
      return []
    }
    throw err
  }
}

export async function createDriverPayCredit(input: DriverPayCreditInput): Promise<DriverPayCredit> {
  const result = await client.graphql({
    query: `mutation CreateDriverPayCredit($input: CreateDriverPayCreditInput!) { createDriverPayCredit(input: $input) { ${PAY_CREDIT_FIELDS} } }`,
    variables: { input },
  }) as { data: { createDriverPayCredit: DriverPayCredit } }
  return result.data.createDriverPayCredit
}

export async function updateDriverPayCredit(id: string, patch: Partial<DriverPayCreditInput>): Promise<DriverPayCredit> {
  const result = await client.graphql({
    query: `mutation UpdateDriverPayCredit($input: UpdateDriverPayCreditInput!) { updateDriverPayCredit(input: $input) { ${PAY_CREDIT_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateDriverPayCredit: DriverPayCredit } }
  return result.data.updateDriverPayCredit
}

export async function deleteDriverPayCredit(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteDriverPayCredit($input: DeleteDriverPayCreditInput!) { deleteDriverPayCredit(input: $input) { id } }`,
    variables: { input: { id } },
  })
}


/**
 * Tell #appts-ivan about an appointment.
 *
 * Returns the Slack message ts on a 'needed' post so the caller can persist it as the
 * stop's apptThreadTs and later reply in that thread. Returns null on any failure:
 * fire-and-forget, because a Slack outage must never block saving a load.
 */
export async function notifyApptNeeded(args: {
  stopKind: 'pickup' | 'delivery'
  kind?: 'needed' | 'updated' | 'move' | 'moved' | 'book'
  threadTs?: string | null
  apptLabel?: string | null
  aljexId?: string | null
  pickupNumber?: string | null
  customer?: string | null
  location?: string | null
  apptDate?: string | null
  actorName?: string | null
}): Promise<string | null> {
  try {
    const res = await client.graphql({
      query: `mutation NotifyApptNeeded(
        $stopKind: String!, $kind: String, $threadTs: String, $apptLabel: String,
        $aljexId: String, $pickupNumber: String,
        $customer: String, $location: String, $apptDate: String, $actorName: String
      ) {
        notifyApptNeeded(
          stopKind: $stopKind, kind: $kind, threadTs: $threadTs, apptLabel: $apptLabel,
          aljexId: $aljexId, pickupNumber: $pickupNumber,
          customer: $customer, location: $location, apptDate: $apptDate, actorName: $actorName
        )
      }`,
      variables: args,
    }) as { data?: { notifyApptNeeded?: unknown } }
    const payload = unwrapJson(res.data?.notifyApptNeeded) as { ok?: boolean; ts?: string } | null
    return payload?.ok && payload.ts ? payload.ts : null
  } catch (err) {
    console.error('[notifyApptNeeded] failed', err)
    return null
  }
}



// ── Time clock ────────────────────────────────────────────────────────────────

const TIME_CLOCK_FIELDS = `
  id driverId workDate kind clockInAt clockOutAt minutes note source
  correctedBy correctedAt originalMinutes truckId clockInOdometer clockOutOdometer createdAt updatedAt
`

/**
 * Every time clock row in a date range, for the staff hours page.
 *
 * Filtered client-side like the other small datasets here: the whole table is one row per
 * punch for a handful of employee drivers, so a server-side index would cost more to
 * maintain than it saves.
 */
export async function listTimeClockEntries(range?: {
  from?: string
  to?: string
  driverId?: string
}): Promise<TimeClockEntry[]> {
  const result = await client.graphql({
    query: `query ListTimeClockEntries { listTimeClockEntries(limit: 10000) { items { ${TIME_CLOCK_FIELDS} } } }`,
  }) as { data: { listTimeClockEntries: { items: TimeClockEntry[] } } }
  let items = result.data.listTimeClockEntries.items ?? []
  if (range?.from)     items = items.filter((e) => e.workDate >= range.from!)
  if (range?.to)       items = items.filter((e) => e.workDate <= range.to!)
  if (range?.driverId) items = items.filter((e) => e.driverId === range.driverId)
  return items
}

/**
 * Correct one row, on the record.
 *
 * `correctedBy` and `originalMinutes` are written here rather than left to the caller, so a
 * correction cannot be made anonymously or lose what the figure used to be — which is the
 * only thing that makes a disagreement about a paycheck settleable by looking.
 */
export async function correctTimeClockEntry(
  entry: TimeClockEntry,
  patch: { minutes?: number; note?: string; kind?: TimeClockEntry['kind'] },
  staffEmail: string,
): Promise<TimeClockEntry> {
  const result = await client.graphql({
    query: `mutation UpdateTimeClockEntry($input: UpdateTimeClockEntryInput!) { updateTimeClockEntry(input: $input) { ${TIME_CLOCK_FIELDS} } }`,
    variables: {
      input: {
        id: entry.id,
        ...patch,
        correctedBy: staffEmail,
        correctedAt: new Date().toISOString(),
        // Kept from the FIRST correction, so it is the driver's original figure and not
        // whatever the previous correction happened to set.
        originalMinutes: entry.originalMinutes ?? entry.minutes ?? 0,
      },
    },
  }) as { data: { updateTimeClockEntry: TimeClockEntry } }
  return result.data.updateTimeClockEntry
}

/** Staff adding a row a driver never recorded — a forgotten shift, a holiday, PTO. */
export async function createTimeClockEntry(
  input: Omit<TimeClockEntry, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<TimeClockEntry> {
  const result = await client.graphql({
    query: `mutation CreateTimeClockEntry($input: CreateTimeClockEntryInput!) { createTimeClockEntry(input: $input) { ${TIME_CLOCK_FIELDS} } }`,
    variables: { input },
  }) as { data: { createTimeClockEntry: TimeClockEntry } }
  return result.data.createTimeClockEntry
}

export async function deleteTimeClockEntry(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteTimeClockEntry($input: DeleteTimeClockEntryInput!) { deleteTimeClockEntry(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Dispatch (Twilio texts + calls with drivers) ─────────────────────────────

const DISPATCH_CONVERSATION_FIELDS = `
  id phone driverId driverName displayName status lastMessageAt lastPreview lastDirection lastKind lastSentBy lastStatusAt lastStatusText
  unreadCount assignedTo assignedBackup lastReadAt lastReadBy slackChannelId slackChannelName createdAt updatedAt
`
const DISPATCH_MESSAGE_FIELDS = `
  id conversationId phone direction kind body media twilioSid status errorCode errorMessage sentBy at
  callDurationSec recordingKey transcript via slackTs createdAt updatedAt
`

export async function listDispatchConversations(): Promise<DispatchConversation[]> {
  return listAll<DispatchConversation>('listDispatchConversations', DISPATCH_CONVERSATION_FIELDS, 1000)
}

/** The thread for one conversation, oldest first. */
export async function listDispatchMessages(conversationId: string): Promise<DispatchMessage[]> {
  const rows: DispatchMessage[] = []
  let nextToken: string | null = null
  do {
    const r = await client.graphql({
      query: `query DispatchThread($conversationId: String!, $nextToken: String) {
        listDispatchMessageByConversationIdAndAt(conversationId: $conversationId, sortDirection: ASC, limit: 500, nextToken: $nextToken) {
          items { ${DISPATCH_MESSAGE_FIELDS} } nextToken
        }
      }`,
      variables: { conversationId, nextToken },
    }) as { data: { listDispatchMessageByConversationIdAndAt: { items: (DispatchMessage | null)[]; nextToken?: string | null } } }
    const page = r.data.listDispatchMessageByConversationIdAndAt
    for (const item of page.items) if (item) rows.push(unwrapJsonFields(item, ['media']))
    nextToken = page.nextToken ?? null
  } while (nextToken)
  return rows
}

/** Every message across every conversation, for the cost report. */
export async function listAllDispatchMessages(): Promise<DispatchMessage[]> {
  const rows = await listAll<DispatchMessage>('listDispatchMessages', DISPATCH_MESSAGE_FIELDS, 1000)
  return rows.map((r) => unwrapJsonFields(r, ['media']))
}

export type DispatchAction =
  | 'send' | 'sendIntro' | 'start' | 'markRead' | 'assign' | 'link' | 'archive' | 'reopen' | 'delete' | 'note' | 'mediaUrl' | 'slackUrl' | 'createSlackChannel'
  | 'status' | 'getSettings' | 'saveSettings' | 'listStaff' | 'slackInvite'

export async function dispatchAction<T = Record<string, unknown>>(action: DispatchAction, input: object = {}): Promise<T> {
  try {
    const result = await client.graphql({
      query: `mutation ManageDispatch($action: String!, $input: AWSJSON) { manageDispatch(action: $action, input: $input) }`,
      variables: { action, input: JSON.stringify(input) },
    }) as { data: { manageDispatch: unknown } }
    const value = unwrapJson(result.data.manageDispatch) as T & { message?: { media?: unknown }; settings?: { forwardTo?: unknown; slackInviteEmails?: unknown } }
    if (value && typeof value === 'object' && value.message) value.message = unwrapJsonFields(value.message, ['media'])
    if (value && typeof value === 'object' && value.settings) value.settings = unwrapJsonFields(value.settings, ['forwardTo', 'slackInviteEmails'])
    return value
  } catch (err) {
    throw new Error(graphqlErrorText(err) || 'Dispatch request failed. Refresh and try again.', { cause: err })
  }
}

/** Stage a picture the office is about to text. Returns the S3 key the send action takes. */
export async function uploadDispatchMedia(file: File): Promise<string> {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const key = `dispatch-media/out/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  await uploadData({ path: key, data: file, options: { contentType: file.type || 'application/octet-stream' } }).result
  return key
}

// ── AR: invoicing & payments (tmsFinanceActions, Step F) ─────────────────────
//
// Money is posted by exactly one Lambda, the way the shipment layer is: every write is
// an action on `tmsFinanceActions`, and the reads come straight off the Invoice and
// ArPayment indexes. Both models arrive with step F's deploy — until it lands AppSync
// has no such query at all, so the reads degrade to "no invoices" rather than failing
// the page, the same bargain the document models strike above.

export type {
  InvoiceRecord, InvoiceLine, InvoiceStatus, InvoiceBillTo, InvoiceBatchEmailMode, RemitTo,
  ArPaymentRecord, ArPaymentKind, ArPaymentMethod, PaymentApplication, CreditApplication,
  ArSettings,
} from '@/types/tms'

const INVOICE_FIELDS = `
  id number orderId shipmentId shipmentNumber customerId customerName billToId billTo
  divisionKey status invoiceDate issuedAt issuedBy dueAt termsDays invoiceMonth
  lines references subtotalCents totalCents paidCents writtenOffCents balanceCents
  arOpen paidAt remitTo factored factoringItemId
  pdfKey pdfSizeBytes pdfVersion attachDocumentIds
  sentAt sentTo sentCount markedSentAt markedSentBy lastNoticeId
  voidedAt voidedBy voidReason note
  createdBy updatedBy version createdAt updatedAt
`
const INVOICE_JSON_FIELDS: (keyof InvoiceRecord)[] = ['billTo', 'lines', 'references', 'remitTo']

const AR_PAYMENT_FIELDS = `
  id customerId kind receivedAt method reference
  amountCents appliedCents unappliedCents applications creditApplications
  invoiceId reversesPaymentId reversedByPaymentId note
  createdBy createdAt updatedAt
`
const AR_PAYMENT_JSON_FIELDS: (keyof ArPaymentRecord)[] = ['applications', 'creditApplications']

/**
 * Parse the `a.json()` columns of one AR row, the way `parseFactoringJson` does for the
 * factoring queue: AppSync hands them back as JSON *strings* (sometimes double-encoded,
 * because the Lambda stringifies into the column), so nothing can read a property off
 * `invoice.lines` until they are unwrapped.
 *
 * A column that is absent or will not parse comes back `null` rather than throwing or
 * leaking the raw string: one malformed line snapshot must not blank the whole AR page,
 * and a caller reading `lines ?? []` then sees an empty invoice instead of a crash.
 */
export function parseArJson<T extends object>(row: T, fields: readonly (keyof T)[]): T {
  const out = { ...row }
  for (const field of fields) {
    const value: unknown = out[field]
    if (value == null) {
      out[field] = null as T[typeof field]
      continue
    }
    if (typeof value !== 'string') continue
    const parsed = unwrapJson(value)
    if (typeof parsed === 'string') {
      console.warn('[ar] could not parse', String(field), 'on', (row as { id?: string }).id)
      out[field] = null as T[typeof field]
      continue
    }
    out[field] = parsed as T[typeof field]
  }
  return out
}

// Invoice, ArPayment and the Order arStatus index all arrive with step F's deploy, and
// until then the error names the *query*, not a field, so the field-level self-heal
// cannot see it. Degrade to an empty book rather than throwing on every AR read.
let arModelsAvailable = true
const isMissingArModel = (err: unknown) =>
  /Cannot query field ['"](listInvoice|getInvoice|listArPayment|listOrderByArStatus)|Unknown type ['"](Invoice|ArPayment|ArStatus)/i
    .test(safeStringify(err))

/** False once a read proved the backend predates the AR models. */
export const arModelsDeployed = () => arModelsAvailable

function forgetArModels(err: unknown): void {
  if (!isMissingArModel(err)) throw err
  console.warn('[apiClient] backend has no AR models yet — reading no invoices until deploy')
  arModelsAvailable = false
}

/**
 * Every AR write. Same contract as `shipmentAction`: the Lambda's own refusal ("order
 * is not UNBILLED", "payment exceeds the balance") is rethrown as the Error message, so
 * the toast shows the real reason instead of `[object Object]`.
 */
export async function financeAction<T>(action: string, input: unknown): Promise<T> {
  let r: { data: { tmsFinanceActions: unknown } }
  try {
    r = await client.graphql({
      query: `mutation TmsFinanceActions($action: String!, $input: AWSJSON!) { tmsFinanceActions(action: $action, input: $input) }`,
      variables: { action, input: JSON.stringify(input) },
    }) as { data: { tmsFinanceActions: unknown } }
  } catch (err) {
    throw new Error(graphqlErrorText(err) || `${action} failed`, { cause: err })
  }
  const v = unwrapJson(r.data.tmsFinanceActions)
  if (v == null) throw new Error(`${action} returned no result`)
  return v as T
}

// ── AR reads ─────────────────────────────────────────────────────────────────

export async function getInvoice(id: string): Promise<InvoiceRecord | null> {
  if (!arModelsAvailable) return null
  try {
    const r = await client.graphql({
      query: `query GetInvoice($id: ID!) { getInvoice(id: $id) { ${INVOICE_FIELDS} } }`,
      variables: { id },
    }) as { data: { getInvoice: InvoiceRecord | null } }
    return r.data.getInvoice ? parseArJson(r.data.getInvoice, INVOICE_JSON_FIELDS) : null
  } catch (err) {
    forgetArModels(err)
    return null
  }
}

/** One customer's bills, newest issued first — the order the customer AR tab renders. */
export async function listInvoicesByCustomer(customerId: string): Promise<InvoiceRecord[]> {
  if (!arModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<InvoiceRecord>({
      name: 'listInvoiceByCustomerIdAndIssuedAt',
      decls: '$customerId: String!',
      args: 'customerId: $customerId',
      variables: { customerId },
      fields: INVOICE_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((inv) => parseArJson(inv, INVOICE_JSON_FIELDS))
  } catch (err) {
    forgetArModels(err)
    return []
  }
}

/**
 * The open book: every invoice still carrying a balance, oldest due date first.
 *
 * `arOpen` is the sparse marker 'OPEN' — carried only while ISSUED or PARTIAL — so this
 * reads exactly the money outstanding however many invoices have ever been issued, and
 * the aging report is this one query.
 */
export async function listOpenInvoices(): Promise<InvoiceRecord[]> {
  if (!arModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<InvoiceRecord>({
      name: 'listInvoiceByArOpenAndDueAt',
      decls: '$arOpen: String!',
      args: 'arOpen: $arOpen',
      variables: { arOpen: 'OPEN' },
      fields: INVOICE_FIELDS,
      limit: 500,
      sortDirection: 'ASC',
    })
    return rows.map((inv) => parseArJson(inv, INVOICE_JSON_FIELDS))
  } catch (err) {
    forgetArModels(err)
    return []
  }
}

/** Everything issued in one 'YYYY-MM', newest first — the Paid/history tab's window. */
export async function listInvoicesByMonth(month: string): Promise<InvoiceRecord[]> {
  if (!arModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<InvoiceRecord>({
      name: 'listInvoiceByInvoiceMonthAndIssuedAt',
      decls: '$invoiceMonth: String!',
      args: 'invoiceMonth: $invoiceMonth',
      variables: { invoiceMonth: month },
      fields: INVOICE_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((inv) => parseArJson(inv, INVOICE_JSON_FIELDS))
  } catch (err) {
    forgetArModels(err)
    return []
  }
}

/** One customer's cash rows — receipts, credits, write-offs, reversals — newest first. */
export async function listArPaymentsByCustomer(customerId: string): Promise<ArPaymentRecord[]> {
  if (!arModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<ArPaymentRecord>({
      name: 'listArPaymentByCustomerIdAndReceivedAt',
      decls: '$customerId: String!',
      args: 'customerId: $customerId',
      variables: { customerId },
      fields: AR_PAYMENT_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((p) => parseArJson(p, AR_PAYMENT_JSON_FIELDS))
  } catch (err) {
    forgetArModels(err)
    return []
  }
}

/**
 * One rung of the AR ladder, oldest change first — the worklist tabs.
 *
 * The index key is the `ArStatus` enum, so the variable must be declared as one; the
 * index is sparse on `arStatusChangedAt`, so an order nobody has moved is not a row.
 */
export async function listOrdersByArStatus(status: ArStatus): Promise<OrderRecord[]> {
  if (!arModelsAvailable) return []
  try {
    const rows = await readOrders((fields) => listAllByIndex<OrderRecord>(
      // Amplify names an inline model enum `<Model><Field>`, not `<Field>`: the
      // deployed schema calls this one OrderArStatus, and a wrong name is a hard
      // validation error rather than an empty list.
      'listOrderByArStatusAndArStatusChangedAt', { arStatus: status }, fields, 1000, { arStatus: 'OrderArStatus!' },
    ))
    return rows.map((o) => unwrapJsonFields(o, ORDER_JSON_FIELDS))
  } catch (err) {
    forgetArModels(err)
    return []
  }
}

/** Presigned GET for one invoice PDF under `invoices/*`. */
export async function getInvoicePdfUrl(key: string): Promise<string> {
  const result = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

// ── AR writes (tmsFinanceActions) ────────────────────────────────────────────

/** What `PREVIEW_INVOICE` shows before anybody commits a number. It writes nothing. */
export interface InvoicePreview {
  readiness: { ready: boolean; reasons: string[] }
  gate: DocGateResult
  /** The invoice as it would be issued — never persisted. */
  snapshot: InvoiceRecord
  recipients: { to: string[]; cc: string[] }
  attachments: { id: string; type: string; name: string; sizeBytes: number }[]
}

export async function previewInvoice(input: {
  orderId: string
  invoiceDate?: string
  billToId?: string
}): Promise<InvoicePreview> {
  return financeAction<InvoicePreview>('PREVIEW_INVOICE', input)
}

export async function generateInvoice(input: {
  orderId: string
  invoiceDate?: string
  dueAt?: string
  billToId?: string
  attachDocumentIds?: string[]
  note?: string
}): Promise<{ invoice: InvoiceRecord; gate: DocGateResult }> {
  return financeAction<{ invoice: InvoiceRecord; gate: DocGateResult }>('GENERATE_INVOICE', input)
}

/** One row per order: the invoice it issued, or the reason it refused. Nothing throws. */
export async function batchGenerateInvoices(input: {
  orderIds: string[]
  invoiceDate?: string
}): Promise<{ results: { orderId: string; invoiceId?: string; number?: string; totalCents?: number; error?: string }[] }> {
  return financeAction('BATCH_GENERATE', input)
}

export async function renderInvoicePdf(input: { invoiceId: string }): Promise<{ invoice: InvoiceRecord }> {
  return financeAction<{ invoice: InvoiceRecord }>('RENDER_INVOICE_PDF', input)
}

/**
 * What one invoice e-mail did — or did not do.
 *
 * SES is denied outside production, so `emailStatus` comes back NOT_SENT with the
 * reason in `emailError` and the signed `downloads` to hand over by other means. The
 * UI must say exactly that; a notice row is written either way.
 */
export interface InvoiceEmailResult {
  notice: ShipmentNoticeRecord
  emailStatus: 'SENT' | 'NOT_SENT' | 'COPY'
  emailError: string | null
  subject: string
  body: string
  to: string[]
  cc: string[]
  downloads: { name: string; url: string }[]
}

export async function emailInvoice(input: {
  invoiceId: string
  to?: string[]
  cc?: string[]
  message?: string
  via?: 'EMAIL' | 'COPY'
}): Promise<InvoiceEmailResult> {
  return financeAction<InvoiceEmailResult>('EMAIL_INVOICE', input)
}

export async function batchEmailInvoices(input: {
  invoiceIds: string[]
}): Promise<{ results: { invoiceId: string; emailStatus?: string; emailError?: string | null; error?: string }[] }> {
  return financeAction('BATCH_EMAIL', input)
}

/** "I sent this myself" — the note is required, because it is the only record of how. */
export async function markInvoiceSent(input: { invoiceId: string; note: string }): Promise<{ invoice: InvoiceRecord }> {
  return financeAction<{ invoice: InvoiceRecord }>('MARK_SENT', input)
}

export async function voidInvoice(input: { invoiceId: string; reason: string }): Promise<{ invoice: InvoiceRecord }> {
  return financeAction<{ invoice: InvoiceRecord }>('VOID_INVOICE', input)
}

/**
 * What a posted row leaves behind: the ArPayment itself and every invoice it moved.
 *
 * `duplicate` is true when the `clientRequestId` had already posted — a double click or
 * a retried request returns the original row rather than taking the money twice.
 */
export interface PostedRow {
  payment: ArPaymentRecord
  invoices: InvoiceRecord[]
  duplicate: boolean
}

export async function recordPayment(input: {
  customerId: string
  receivedAt: string
  method: ArPaymentMethod
  reference?: string
  amountCents: number
  applications: PaymentApplication[]
  creditApplications: CreditApplication[]
  note?: string
  clientRequestId: string
}): Promise<PostedRow> {
  return financeAction<PostedRow>('RECORD_PAYMENT', input)
}

export async function createCredit(input: {
  customerId: string
  memoDate: string
  reference?: string
  amountCents: number
  note: string
  clientRequestId: string
}): Promise<PostedRow> {
  return financeAction<PostedRow>('CREATE_CREDIT', input)
}

export async function writeOffInvoice(input: {
  invoiceId: string
  amountCents: number
  reason: string
  clientRequestId: string
}): Promise<PostedRow> {
  return financeAction<PostedRow>('WRITE_OFF', input)
}

/** Nothing deletes a posted row; a mistake gets a REVERSAL that restores the balances. */
export async function reversePayment(input: { paymentId: string; reason: string }): Promise<PostedRow> {
  return financeAction<PostedRow>('REVERSE_PAYMENT', input)
}

/** What the factoring queue row would carry, and whether anything blocks writing it. */
export async function previewFactor(input: { invoiceId: string }): Promise<{
  ready: boolean
  refusal: string | null
  proNumber?: string
  fields?: Record<string, string>
  existing?: { id: string; status: string } | null
}> {
  return financeAction('PREVIEW_FACTOR', input)
}

/**
 * Raise the OTR queue row for an issued invoice. This writes the row and prefills its
 * typed fields; submitting it to OTR stays a separate human act on `/factoring`.
 * `reused` is true when the invoice already had a row — it is never written twice.
 */
export async function sendToFactor(input: { invoiceId: string }): Promise<{
  factoringItem: FactoringItem
  invoice: InvoiceRecord
  reused: boolean
}> {
  const result = await financeAction<{ factoringItem: FactoringItem; invoice: InvoiceRecord; reused: boolean }>('SEND_TO_FACTOR', input)
  return { ...result, factoringItem: parseFactoringJson(result.factoringItem) }
}

export async function saveArSettings(input: Partial<ArSettings>): Promise<{ settings: TmsSettings }> {
  return financeAction<{ settings: TmsSettings }>('SAVE_AR_SETTINGS', input)
}

// ── AP: carrier bills & payments (tmsFinanceActions, Step G) ─────────────────
//
// The AP twin of the AR section above, and deliberately its shape: every write is an
// action on `tmsFinanceActions`, and the reads come straight off the CarrierBill,
// ApPayment and LoadCarrier indexes. Both models arrive with step G's deploy — until it
// lands AppSync has no such query at all, so the reads degrade to "no bills" rather than
// failing the page, the same bargain AR strikes above.

export type {
  CarrierBillRecord, CarrierBillLine, CarrierBillStatus, ApPayeeKind, ApRemitTo,
  ApPaymentRecord, ApPaymentKind, ApPaymentMethod, ApPaymentApplication, ApSettings,
} from '@/types/tms'

const CARRIER_BILL_FIELDS = `
  id loadCarrierId loadId shipmentId shipmentNumber loadNumber
  carrierId carrierName carrierMc payeeKind paymentMethodId remitTo divisionKey
  status billNumber billDate billMonth recordedAt recordedBy recordedEarly
  dueAt termsDays quickPay quickPayDays quickPayFeeBps
  lines grossCents quickPayFeeCents netCents billedCents varianceCents
  paidCents creditedCents balanceCents apOpen documentId
  approvedAt approvedBy approvalWarnings docsOverrideAt docsOverrideBy docsOverrideNote
  paidAt voidedAt voidedBy voidReason note
  createdBy updatedBy version createdAt updatedAt
`
const CARRIER_BILL_JSON_FIELDS: (keyof CarrierBillRecord)[] = ['remitTo', 'lines']

const AP_PAYMENT_FIELDS = `
  id carrierId payeeKind kind paidAt method reference
  amountCents appliedCents unappliedCents applications creditApplications remitTo
  loadCarrierId reversesPaymentId reversedByPaymentId
  pdfKey pdfVersion remittanceSentAt remittanceSentTo remittanceCount
  markedSentAt markedSentBy markedSentNote lastNoticeId note
  createdBy createdAt updatedAt
`
const AP_PAYMENT_JSON_FIELDS: (keyof ApPaymentRecord)[] = ['applications', 'creditApplications', 'remitTo']

// CarrierBill, ApPayment and the LoadCarrier apOpen index all arrive with step G's
// deploy, and until then the error names the *query*, not a field, so the field-level
// self-heal cannot see it. Degrade to an empty book rather than throwing on every AP read.
let apModelsAvailable = true
const isMissingApModel = (err: unknown) =>
  /Cannot query field ['"](listCarrierBill|getCarrierBill|listApPayment|listLoadCarrierByApOpen)|Unknown type ['"](CarrierBill|ApPayment|LoadCarrierApStatus)/i
    .test(safeStringify(err))

/** False once a read proved the backend predates the AP models. */
export const apModelsDeployed = () => apModelsAvailable

function forgetApModels(err: unknown): void {
  if (!isMissingApModel(err)) throw err
  console.warn('[apiClient] backend has no AP models yet — reading no carrier bills until deploy')
  apModelsAvailable = false
}

// ── AP reads ─────────────────────────────────────────────────────────────────
// `parseArJson` is the AR parser by name only: the AWSJSON columns on a bill and on an
// AP payment arrive double-encoded in exactly the same way, and one malformed line
// snapshot must blank that column rather than the whole AP board.

export async function getCarrierBill(id: string): Promise<CarrierBillRecord | null> {
  if (!apModelsAvailable) return null
  try {
    const r = await client.graphql({
      query: `query GetCarrierBill($id: ID!) { getCarrierBill(id: $id) { ${CARRIER_BILL_FIELDS} } }`,
      variables: { id },
    }) as { data: { getCarrierBill: CarrierBillRecord | null } }
    return r.data.getCarrierBill ? parseArJson(r.data.getCarrierBill, CARRIER_BILL_JSON_FIELDS) : null
  } catch (err) {
    forgetApModels(err)
    return null
  }
}

/** One carrier's bills, newest recorded first — the order the carrier AP tab renders. */
export async function listBillsByCarrier(carrierId: string): Promise<CarrierBillRecord[]> {
  if (!apModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<CarrierBillRecord>({
      name: 'listCarrierBillByCarrierIdAndRecordedAt',
      decls: '$carrierId: String!',
      args: 'carrierId: $carrierId',
      variables: { carrierId },
      fields: CARRIER_BILL_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((bill) => parseArJson(bill, CARRIER_BILL_JSON_FIELDS))
  } catch (err) {
    forgetApModels(err)
    return []
  }
}

/**
 * Everything we still owe a carrier, oldest due date first — the pay run's working set.
 *
 * `apOpen` is the sparse marker 'OPEN', carried only while IN_REVIEW, TO_BE_PAID or
 * PARTIAL, so this reads exactly the money outstanding however many bills have ever been
 * recorded, and the AP aging is this one query.
 */
export async function listOpenBills(): Promise<CarrierBillRecord[]> {
  if (!apModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<CarrierBillRecord>({
      name: 'listCarrierBillByApOpenAndDueAt',
      decls: '$apOpen: String!',
      args: 'apOpen: $apOpen',
      variables: { apOpen: 'OPEN' },
      fields: CARRIER_BILL_FIELDS,
      limit: 500,
      sortDirection: 'ASC',
    })
    return rows.map((bill) => parseArJson(bill, CARRIER_BILL_JSON_FIELDS))
  } catch (err) {
    forgetApModels(err)
    return []
  }
}

/** Everything recorded in one 'YYYY-MM', newest first — the paid/history tab's window. */
export async function listBillsByMonth(month: string): Promise<CarrierBillRecord[]> {
  if (!apModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<CarrierBillRecord>({
      name: 'listCarrierBillByBillMonthAndRecordedAt',
      decls: '$billMonth: String!',
      args: 'billMonth: $billMonth',
      variables: { billMonth: month },
      fields: CARRIER_BILL_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((bill) => parseArJson(bill, CARRIER_BILL_JSON_FIELDS))
  } catch (err) {
    forgetApModels(err)
    return []
  }
}

/** One carrier's money rows — payments, credits and reversals — newest paid first. */
export async function listApPaymentsByCarrier(carrierId: string): Promise<ApPaymentRecord[]> {
  if (!apModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<ApPaymentRecord>({
      name: 'listApPaymentByCarrierIdAndPaidAt',
      decls: '$carrierId: String!',
      args: 'carrierId: $carrierId',
      variables: { carrierId },
      fields: AP_PAYMENT_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((p) => parseArJson(p, AP_PAYMENT_JSON_FIELDS))
  } catch (err) {
    forgetApModels(err)
    return []
  }
}

/**
 * Every carrier assignment still owing money, oldest change first — the AP worklist.
 *
 * `apOpen` is sparse: a leg nobody has to pay (own fleet, a bounced booking, one already
 * paid) is not a row, so the whole ladder is one query. `apStatus` narrows it to a single
 * rung for a tab; it is not the index key, so it goes through a filter — and Amplify names
 * an inline model enum `<Model><Field>`, so the deployed schema calls that argument's type
 * LoadCarrierApStatus. A wrong name is a hard validation error, not an empty list.
 */
export async function listOpenApAssignments(apStatus?: ApStatus): Promise<LoadCarrierRecord[]> {
  if (!apModelsAvailable) return []
  try {
    return await readLoadCarriers((fields) => listTrackingIndex<LoadCarrierRecord>({
      name: 'listLoadCarrierByApOpenAndApStatusChangedAt',
      decls: apStatus ? '$apOpen: String!, $apStatus: LoadCarrierApStatus' : '$apOpen: String!',
      args: apStatus ? 'apOpen: $apOpen, filter: { apStatus: { eq: $apStatus } }' : 'apOpen: $apOpen',
      variables: apStatus ? { apOpen: 'OPEN', apStatus } : { apOpen: 'OPEN' },
      fields,
      limit: 1000,
      sortDirection: 'ASC',
    }))
  } catch (err) {
    forgetApModels(err)
    return []
  }
}

/** Presigned GET for one remittance advice PDF under `remittances/*`. */
export async function getRemittancePdfUrl(key: string): Promise<string> {
  const result = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return result.url.toString()
}

// ── AP writes (tmsFinanceActions) ────────────────────────────────────────────

/** What `PREVIEW_BILL` shows before anybody records a bill. It writes nothing. */
export interface BillPreview {
  readiness: { ready: boolean; reasons: string[] }
  /** The carrier-scope paperwork gate, evaluated live rather than off the cache. */
  gate: DocGateResult
  /** The bill as it would be recorded — never persisted. */
  snapshot: CarrierBillRecord
  payee: { kind: ApPayeeKind; paymentMethodId: string | null; remitTo: ApRemitTo | null }
  /** This assignment's carrier-side documents, so the dialog can name the invoice. */
  documents: { id: string; type: string; name: string; sizeBytes: number }[]
}

export async function previewBill(input: { loadCarrierId: string }): Promise<BillPreview> {
  return financeAction<BillPreview>('PREVIEW_BILL', input)
}

/**
 * Every bill write answers with the row it wrote, so a caller swaps the record it is
 * showing rather than re-reading it. `RECORD_BILL` adds the live paperwork gate, because
 * the review stage is where somebody has to see what is still missing.
 */
export async function recordBill(input: {
  loadCarrierId: string
  expectedUpdatedAt?: string
  billNumber?: string
  billDate?: string
  billedCents?: number
  dueAt?: string
  documentId?: string
  note?: string
  /** Record and approve in one press — the server still runs every approval block. */
  approve?: boolean
}): Promise<{ bill: CarrierBillRecord; gate: DocGateResult }> {
  return financeAction<{ bill: CarrierBillRecord; gate: DocGateResult }>('RECORD_BILL', input)
}

/**
 * Move a reviewed bill to TO_BE_PAID.
 *
 * `acknowledgeWarnings` is the warning keys the approver ticked — the record of what
 * they were told and signed off on; the blocks are not acknowledgeable at all.
 * `docsOverrideNote` is required to approve past missing carrier paperwork, and is the
 * only record of why.
 */
export async function approveBill(input: {
  billId: string
  acknowledgeWarnings?: string[]
  docsOverrideNote?: string
}): Promise<{ bill: CarrierBillRecord }> {
  return financeAction<{ bill: CarrierBillRecord }>('APPROVE_BILL', input)
}

export async function unapproveBill(input: { billId: string; reason: string }): Promise<{ bill: CarrierBillRecord }> {
  return financeAction<{ bill: CarrierBillRecord }>('UNAPPROVE_BILL', input)
}

export async function voidBill(input: { billId: string; reason: string }): Promise<{ bill: CarrierBillRecord }> {
  return financeAction<{ bill: CarrierBillRecord }>('VOID_BILL', input)
}

/**
 * What a posted AP row leaves behind: the ApPayment itself and every bill it moved.
 *
 * `duplicate` is true when the `clientRequestId` had already posted — a double click or a
 * retried request returns the original row rather than paying the carrier twice.
 */
export interface ApPostedRow {
  payment: ApPaymentRecord
  bills: CarrierBillRecord[]
  duplicate: boolean
}

export async function recordApPayment(input: {
  carrierId: string
  paidAt: string
  method: ApPaymentMethod
  reference?: string
  amountCents: number
  applications: ApPaymentApplication[]
  creditApplications: CreditApplication[]
  note?: string
  clientRequestId: string
}): Promise<ApPostedRow> {
  return financeAction<ApPostedRow>('RECORD_AP_PAYMENT', input)
}

/** Money the carrier owes us back — a TONU adjustment, a claim — held against them. */
export async function createApCredit(input: {
  carrierId: string
  memoDate: string
  reference?: string
  amountCents: number
  reason: string
  loadCarrierId?: string
  clientRequestId: string
}): Promise<ApPostedRow> {
  return financeAction<ApPostedRow>('CREATE_AP_CREDIT', input)
}

/** Nothing deletes a posted row; a mistake gets a REVERSAL that restores the balances. */
export async function reverseApPayment(input: { paymentId: string; reason: string }): Promise<ApPostedRow> {
  return financeAction<ApPostedRow>('REVERSE_AP_PAYMENT', input)
}

/**
 * What one remittance e-mail did — or did not do.
 *
 * SES is denied outside production, so `emailStatus` comes back NOT_SENT with the reason
 * in `emailError` and the signed `downloads` to hand over by other means. The UI must say
 * exactly that; a notice row is written either way.
 */
export interface RemittanceEmailResult {
  payment: ApPaymentRecord
  notice: ShipmentNoticeRecord
  emailStatus: 'SENT' | 'NOT_SENT' | 'COPY'
  emailError: string | null
  subject: string
  body: string
  to: string[]
  cc: string[]
  downloads: { name: string; url: string }[]
}

export async function sendRemittance(input: {
  paymentId: string
  to?: string[]
  cc?: string[]
  message?: string
  via?: 'EMAIL' | 'COPY'
}): Promise<RemittanceEmailResult> {
  return financeAction<RemittanceEmailResult>('SEND_REMITTANCE', input)
}

export async function renderRemittancePdf(input: { paymentId: string }): Promise<{ payment: ApPaymentRecord }> {
  return financeAction<{ payment: ApPaymentRecord }>('RENDER_REMITTANCE_PDF', input)
}

/** "I sent this myself" — the note is required, because it is the only record of how. */
export async function markRemittanceSent(input: { paymentId: string; note: string }): Promise<{ payment: ApPaymentRecord }> {
  return financeAction<{ payment: ApPaymentRecord }>('MARK_REMITTANCE_SENT', input)
}

export async function saveApSettings(input: Partial<ApSettings>): Promise<{ settings: TmsSettings }> {
  return financeAction<{ settings: TmsSettings }>('SAVE_AP_SETTINGS', input)
}

/**
 * Edit the carrier side of a shipment's charges — the AP twin of the customer-side save,
 * and a shipment write rather than a finance one: it moves LoadCharge rows and the cached
 * cost. Refused once the assignment's charges are finalized, which recording a bill does.
 */
export async function updateCarrierCharges(input: {
  loadCarrierId: string
  expectedVersion: number
  charges: LoadChargeInput[]
}): Promise<ShipmentBundle> {
  return shipmentAction<ShipmentBundle>('UPDATE_CARRIER_CHARGES', input)
}

// ── Quotes, carrier offers & lane history (Step H) ───────────────────────────
//
// Sell-side quotes and buy-side carrier offers are one model with two sides, and every
// write is an action on `tmsShipmentActions` — the same Lambda that owns conversion and
// booking, so a quote becoming a shipment and an offer booking a carrier stay inside one
// transaction. The reads come straight off the Quote and LaneRateSample indexes.
//
// Both models arrive with step H's deploy; until it lands AppSync has no such query at
// all, so the reads degrade to "no quotes" rather than failing the page — the bargain
// the AR and AP models strike above.

export type {
  QuoteRecord, QuoteSide, QuoteStatus, QuoteEvent, QuoteLostReason, QuoteResponseKind,
  QuoteSettings, QuotePublicView, LaneRateSampleRecord, LaneStats, LaneStatsFilters,
} from '@/types/tms'

const QUOTE_FIELDS = `
  id side status groupId quoteDate quoteMonth
  customerId customerName contactName contactEmail customerRepId
  carrierId carrierName carrierMc carrierEmail
  shipmentId shipmentNumber orderId loadId loadNumber divisionKey
  mode rateType equipmentType equipmentLengthFt stops laneKey laneKey3
  pickupAppt deliveryAppt commodity weightLbs miles references lines
  amountCents customerRateCents targetBuyCents topSpendCents marginBps
  bookNowRateCents counterCents counterBy rounds expiresAt
  linkToken linkVersion requestCount
  sentAt sentTo sendCount lastSendStatus
  respondedAt response responderName responderEmail responderIp acceptedVia
  lostReason lostNote wonAt closedAt duplicatedFromId pricingWarnings quoteOpen
  customerMessage internalNotes events
  createdBy updatedBy version createdAt updatedAt
`
// `pricingWarnings` is a String list, not a json column: it needs no unwrapping.
const QUOTE_JSON_FIELDS: (keyof QuoteRecord)[] = ['stops', 'references', 'lines', 'events']

// LaneRateSample has no `a.json()` columns at all — every field is a scalar — so there
// is no JSON list beside this one.
const LANE_SAMPLE_FIELDS = `
  id laneKey laneKey3 date loadId shipmentId shipmentNumber orderId
  customerId customerName carrierId carrierName assignmentKind divisionKey
  mode rateType equipmentType miles
  customerRateCents revenueCents carrierRateCents costCents profitCents marginBps
  loadStatus excluded source sampledAt version createdAt updatedAt
`

// Quote and LaneRateSample both arrive with step H's deploy, and until then the error
// names the *query*, not a field, so the field-level self-heal cannot see it. Degrade to
// an empty board rather than throwing on every quote read.
//
// Both wordings are matched because AppSync and graphql-js disagree: AppSync answers a
// query it has never heard of with `Validation error of type FieldUndefined: Field
// 'getQuote' in type 'Query' is undefined`, graphql-js with `Cannot query field
// "getQuote"`. Either way the name is quoted, and the quote may have been escaped by
// the `JSON.stringify` inside `safeStringify` — hence the backslash in the class. The
// delimiters are what keep "Not Authorized to access getQuote" out: a permission
// refusal is a real error and must still reach the caller.
let quoteModelsAvailable = true
const isMissingQuoteModel = (err: unknown) =>
  /[\\'"](get|list)(Quote|LaneRateSample)\w*[\\'"]|Unknown type [\\'"]+(Quote|LaneRateSample)/i
    .test(safeStringify(err))

/** False once a read proved the backend predates the quote models. */
export const quoteModelsDeployed = () => quoteModelsAvailable

function forgetQuoteModels(err: unknown): void {
  if (!isMissingQuoteModel(err)) throw err
  console.warn('[apiClient] backend has no quote models yet — reading no quotes until deploy')
  quoteModelsAvailable = false
}

// ── Quote reads ──────────────────────────────────────────────────────────────

/** One quote by its number — the id *is* the number, so the detail page is a GetItem. */
export async function getQuote(id: string): Promise<QuoteRecord | null> {
  if (!quoteModelsAvailable) return null
  try {
    const r = await client.graphql({
      query: `query GetQuote($id: ID!) { getQuote(id: $id) { ${QUOTE_FIELDS} } }`,
      variables: { id },
    }) as { data: { getQuote: QuoteRecord | null } }
    return r.data.getQuote ? parseArJson(r.data.getQuote, QUOTE_JSON_FIELDS) : null
  } catch (err) {
    forgetQuoteModels(err)
    return null
  }
}

/** One customer's quotes, newest first — the customer profile's Quotes tab. */
export async function listQuotesByCustomer(customerId: string): Promise<QuoteRecord[]> {
  if (!quoteModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<QuoteRecord>({
      name: 'listQuoteByCustomerIdAndQuoteDate',
      decls: '$customerId: String!',
      args: 'customerId: $customerId',
      variables: { customerId },
      fields: QUOTE_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((q) => parseArJson(q, QUOTE_JSON_FIELDS))
  } catch (err) {
    forgetQuoteModels(err)
    return []
  }
}

/**
 * Every offer ever made on one leg, newest first — open and closed both, because the
 * card shows the round that booked beside the ones that did not.
 */
export async function listOffersByLoad(loadId: string): Promise<QuoteRecord[]> {
  if (!quoteModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<QuoteRecord>({
      name: 'listQuoteByLoadIdAndQuoteDate',
      decls: '$loadId: String!',
      args: 'loadId: $loadId',
      variables: { loadId },
      fields: QUOTE_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((q) => parseArJson(q, QUOTE_JSON_FIELDS))
  } catch (err) {
    forgetQuoteModels(err)
    return []
  }
}

/**
 * The whole open board — both sides — soonest to expire first.
 *
 * `quoteOpen` is the sparse marker 'OPEN', carried from DRAFT through RECEIVED_COUNTER
 * and REMOVEd the moment a quote closes, so this reads exactly what is still live
 * however many quotes have ever been priced. The sweep and the badge are this one query.
 */
export async function listOpenQuotes(): Promise<QuoteRecord[]> {
  if (!quoteModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<QuoteRecord>({
      name: 'listQuoteByQuoteOpenAndExpiresAt',
      decls: '$quoteOpen: String!',
      args: 'quoteOpen: $quoteOpen',
      variables: { quoteOpen: 'OPEN' },
      fields: QUOTE_FIELDS,
      limit: 500,
      sortDirection: 'ASC',
    })
    return rows.map((q) => parseArJson(q, QUOTE_JSON_FIELDS))
  } catch (err) {
    forgetQuoteModels(err)
    return []
  }
}

/** Everything quoted in one 'YYYY-MM', newest first — the Won / Lost tab's window. */
export async function listQuotesByMonth(month: string): Promise<QuoteRecord[]> {
  if (!quoteModelsAvailable) return []
  try {
    const rows = await listTrackingIndex<QuoteRecord>({
      name: 'listQuoteByQuoteMonthAndQuoteDate',
      decls: '$quoteMonth: String!',
      args: 'quoteMonth: $quoteMonth',
      variables: { quoteMonth: month },
      fields: QUOTE_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
    return rows.map((q) => parseArJson(q, QUOTE_JSON_FIELDS))
  } catch (err) {
    forgetQuoteModels(err)
    return []
  }
}

/**
 * One lane's delivered history, newest first. `fromDate` is a 'YYYY-MM-DD' floor on the
 * sort key, so a 90-day window is 90 days of rows off the wire rather than the lane's
 * whole life filtered in the browser.
 */
export async function listLaneSamples(laneKey: string, fromDate?: string): Promise<LaneRateSampleRecord[]> {
  if (!quoteModelsAvailable || !laneKey) return []
  try {
    return await listTrackingIndex<LaneRateSampleRecord>({
      name: 'listLaneRateSampleByLaneKeyAndDate',
      decls: fromDate ? '$laneKey: String!, $from: String!' : '$laneKey: String!',
      args: fromDate ? 'laneKey: $laneKey, date: { ge: $from }' : 'laneKey: $laneKey',
      variables: fromDate ? { laneKey, from: fromDate } : { laneKey },
      fields: LANE_SAMPLE_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
  } catch (err) {
    forgetQuoteModels(err)
    return []
  }
}

/** The ZIP3 neighbourhood's history — what the panel falls back to on a cold lane. */
export async function listLaneSamplesByZip3(laneKey3: string, fromDate?: string): Promise<LaneRateSampleRecord[]> {
  if (!quoteModelsAvailable || !laneKey3) return []
  try {
    return await listTrackingIndex<LaneRateSampleRecord>({
      name: 'listLaneRateSampleByLaneKey3AndDate',
      decls: fromDate ? '$laneKey3: String!, $from: String!' : '$laneKey3: String!',
      args: fromDate ? 'laneKey3: $laneKey3, date: { ge: $from }' : 'laneKey3: $laneKey3',
      variables: fromDate ? { laneKey3, from: fromDate } : { laneKey3 },
      fields: LANE_SAMPLE_FIELDS,
      limit: 500,
      sortDirection: 'DESC',
    })
  } catch (err) {
    forgetQuoteModels(err)
    return []
  }
}

// ── Quote writes (tmsShipmentActions) ────────────────────────────────────────
//
// Every one answers with the quote row it wrote, so a caller swaps the record it is
// showing rather than re-reading it. `expectedVersion` is the CAS token: the row as the
// caller last saw it, refused server-side when somebody else has moved it since.

/** What a send-shaped action did — or did not do. */
export interface QuoteSendResult {
  quote: QuoteRecord
  /** The public link, present even when SES refused: on dev it is the only delivery. */
  link: string | null
  sent: boolean
  subject: string
  body: string
}

export interface SaveQuoteInput {
  /** Absent on create: the number is minted server-side from the settings counter. */
  quoteId?: string
  expectedVersion?: number
  side?: QuoteSide
  /** An inbound request nobody has priced yet starts REQUESTED rather than DRAFT. */
  intake?: boolean
  customerId?: string | null
  customerName?: string | null
  contactName?: string | null
  contactEmail?: string | null
  customerRepId?: string | null
  divisionKey?: string | null
  stops?: Stop[]
  pickupAppt?: string | null
  deliveryAppt?: string | null
  mode?: ShipmentMode | null
  rateType?: RateType | null
  equipmentType?: string | null
  equipmentLengthFt?: number | null
  commodity?: string | null
  weightLbs?: number | null
  miles?: number | null
  references?: OrderReference[]
  lines?: LoadChargeInput[]
  targetBuyCents?: number | null
  topSpendCents?: number | null
  customerMessage?: string | null
  internalNotes?: string | null
}

/** The saved row and what pricing made of it — the totals plus every warning raised. */
export async function saveQuote(input: SaveQuoteInput): Promise<{ quote: QuoteRecord; pricing: QuotePricingResult }> {
  return shipmentAction<{ quote: QuoteRecord; pricing: QuotePricingResult }>('SAVE_QUOTE', input)
}

export interface SendQuoteInput {
  quoteId: string
  expectedVersion?: number
  /** Omitted: the server addresses the quote's own contact. */
  to?: string[]
  cc?: string[]
  message?: string
  /** COPY mints the link and writes the thread without asking SES to send anything. */
  via?: 'EMAIL' | 'COPY'
  /** The `key` of every pricing warning the sender ticked off. Blocks cannot be ticked. */
  acknowledgeWarnings?: string[]
}
export async function sendQuote(input: SendQuoteInput): Promise<QuoteSendResult> {
  return shipmentAction<QuoteSendResult>('SEND_QUOTE', input)
}

export interface CounterQuoteInput {
  quoteId: string
  expectedVersion?: number
  /** Either the re-priced lines, or one number for `absorbCounter` to spread over them. */
  lines?: LoadChargeInput[]
  amountCents?: number
  message?: string
  to?: string[]
  cc?: string[]
  via?: 'EMAIL' | 'COPY'
  acknowledgeWarnings?: string[]
}
export async function counterQuote(input: CounterQuoteInput): Promise<QuoteSendResult> {
  return shipmentAction<QuoteSendResult>('COUNTER_QUOTE', input)
}

/** Take their number as ours: the lines absorb the counter and the quote becomes ours to convert. */
export async function acceptCounter(input: { quoteId: string; expectedVersion?: number }): Promise<{ quote: QuoteRecord }> {
  return shipmentAction<{ quote: QuoteRecord }>('ACCEPT_COUNTER', input)
}

export async function markQuoteLost(input: {
  quoteId: string
  expectedVersion?: number
  reason: QuoteLostReason
  note?: string
}): Promise<{ quote: QuoteRecord }> {
  return shipmentAction<{ quote: QuoteRecord }>('MARK_QUOTE_LOST', input)
}

/** Back onto the board at QUOTED — without a link, which a lost round has already spent. */
export async function restoreQuote(input: { quoteId: string; expectedVersion?: number }): Promise<{ quote: QuoteRecord }> {
  return shipmentAction<{ quote: QuoteRecord }>('RESTORE_QUOTE', input)
}

export async function cancelQuote(input: {
  quoteId: string
  expectedVersion?: number
  reason?: string
}): Promise<{ quote: QuoteRecord }> {
  return shipmentAction<{ quote: QuoteRecord }>('CANCEL_QUOTE', input)
}

/** The buy side's "no truck": the carrier is out of this round, the load is not. */
export async function passQuote(input: {
  quoteId: string
  expectedVersion?: number
  note?: string
}): Promise<{ quote: QuoteRecord }> {
  return shipmentAction<{ quote: QuoteRecord }>('PASS_QUOTE', input)
}

/**
 * Close every open quote past its expiry. Idempotent and conditioned server-side, so the
 * board may fire it on every mount without racing another desk doing the same.
 */
export async function sweepExpiredQuotes(): Promise<{ expired: number }> {
  return shipmentAction<{ expired: number }>('SWEEP_EXPIRED_QUOTES', {})
}

/**
 * Copy one quote into `count` drafts — the multi-truck ask, priced once.
 *
 * `exposure` is what those drafts would add to the customer's open book against their
 * credit limit: a warning on the dialog, and a block at conversion, never here.
 */
export interface DuplicateQuotesResult {
  quotes: QuoteRecord[]
  exposure: { projectedCents: number; creditLimitCents: number | null; overLimit: boolean }
}
export async function duplicateQuotes(input: {
  quoteId: string
  count: number
  /** One pickup appointment per copy, when the trucks are not all the same day. */
  pickupAppts?: (string | null)[]
}): Promise<DuplicateQuotesResult> {
  return shipmentAction<DuplicateQuotesResult>('DUPLICATE_QUOTE', input)
}

/** The won quote and the shipment it just became, in one transaction. */
export async function convertQuote(input: {
  quoteId: string
  expectedVersion?: number
  acceptedVia?: QuoteAcceptedVia
  divisionKey?: string | null
  customerRepId?: string | null
}): Promise<{ quote: QuoteRecord; bundle: ShipmentBundle }> {
  return shipmentAction<{ quote: QuoteRecord; bundle: ShipmentBundle }>('CONVERT_QUOTE', input)
}

/** The only way back out of WON: the shipment is undone and its quote is open again. */
export async function revertToQuote(input: {
  /** The shipment being undone, or the quote it came from — either names the pair. */
  shipmentId?: string
  quoteId?: string
  reason: string
}): Promise<{ quote: QuoteRecord }> {
  return shipmentAction<{ quote: QuoteRecord }>('REVERT_TO_QUOTE', input)
}

// ── Carrier offers (buy side) ────────────────────────────────────────────────

/** One REQUESTED offer per carrier, and what each send did. */
export interface RequestOffersResult {
  offers: QuoteRecord[]
  sends: { quoteId: string; link: string | null; sent: boolean; subject: string; body: string; to: string[] }[]
}
export async function requestOffers(input: {
  shipmentId?: string
  loadId: string
  carrierIds: string[]
  message?: string
  /** The number a carrier may accept outright on the link, when settings allow it. */
  bookNowRateCents?: number | null
  via?: 'EMAIL' | 'COPY'
  /** Overrides `offerExpiryHours`; still capped at the first pickup appointment. */
  expiryHours?: number
}): Promise<RequestOffersResult> {
  return shipmentAction<RequestOffersResult>('REQUEST_OFFERS', input)
}

/** A number that came in by phone: the offer row a carrier never clicked a link to make. */
export async function logOffer(input: {
  shipmentId?: string
  loadId: string
  carrierId: string
  amountCents: number
  note?: string
  contactName?: string | null
  carrierEmail?: string | null
}): Promise<{ quote: QuoteRecord }> {
  return shipmentAction<{ quote: QuoteRecord }>('LOG_OFFER', input)
}

export async function counterOffer(input: {
  quoteId: string
  expectedVersion?: number
  amountCents: number
  message?: string
  via?: 'EMAIL' | 'COPY'
}): Promise<QuoteSendResult> {
  return shipmentAction<QuoteSendResult>('COUNTER_OFFER', input)
}

export async function rejectOffer(input: {
  quoteId: string
  expectedVersion?: number
  reason?: QuoteLostReason
  note?: string
}): Promise<{ quote: QuoteRecord }> {
  return shipmentAction<{ quote: QuoteRecord }>('REJECT_OFFER', input)
}

/**
 * Book the carrier at their number. Everything `BOOK_CARRIER` demands is demanded here
 * too — the same gate, the same refusals verbatim — and the offer's group closes in the
 * booking transaction, so answering an offer can never leave a load double-covered.
 */
export type AcceptOfferInput = Omit<BookCarrierInput, 'carrierId' | 'carrierRateCents'> & {
  quoteId: string
  expectedVersion?: number
  /** Omitted: the carrier is booked at the offer's own `amountCents`. */
  carrierRateCents?: number
}
export async function acceptOffer(input: AcceptOfferInput): Promise<{ quote: QuoteRecord; bundle: ShipmentBundle }> {
  return shipmentAction<{ quote: QuoteRecord; bundle: ShipmentBundle }>('ACCEPT_OFFER', input)
}

/** ADMIN only. Templates must carry `{link}` and the number format `{n}`; the server checks. */
export async function saveQuoteSettings(input: Partial<QuoteSettings> & { expectedUpdatedAt?: string }): Promise<{ settings: TmsSettings }> {
  return shipmentAction<{ settings: TmsSettings }>('SAVE_QUOTE_SETTINGS', input)
}
