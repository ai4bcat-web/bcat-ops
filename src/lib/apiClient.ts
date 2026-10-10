import { generateClient } from 'aws-amplify/data'
import { uploadData, getUrl, remove } from 'aws-amplify/storage'
import type { Load, Driver, AuditLogEntry, EntityType, AuditAction, FactoringItem, FactoringItemStatus, TimeClockEntry } from '@/types'
import type { RateConExtract } from '@/lib/otrInvoice'
import type { Equipment, MaintenanceTask, MaintenanceInvoice } from '@/types/equipment'
import { fuelDedupKey } from '@/lib/driverFuel'
import { fileContentType } from '@/lib/disputeFiles'
import type { FixedExpenseInput } from './driverPay'
import type { DispatchConversation, DispatchMessage } from './dispatch'
import type { VendorPayable, VendorApAttachment, VendorPayableDetails, VendorPayment } from '@/types/vendorAp'
import type { CustomerRecord, LocationRecord, Division, TmsSettings, GeocodeResult, AutocompleteSuggestion, LocationMergePreview, LocationMergeJob } from '@/types/tms'
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
const loadFields = () => {
  let f = LOAD_FIELDS
  if (loadsHaveHot) f += ' hot unscheduled'
  if (loadsHaveStops) f += ' stops'
  if (loadsHaveSortOrder) f += ' sortOrder'
  if (loadsHaveCustomerId) f += ' customerId'
  if (loadsHaveEldReview) f += ' eldLogsReviewedAt eldLogsReviewedBy eldLogsNote'
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
  driversHaveDispatcher ? 'dispatcherPrimary dispatcherBackup' : '',
].filter(Boolean).join(' ')

const isMotiveFieldUndefined = (err: unknown) => /motiveDriverId/.test(JSON.stringify(err ?? ''))
const isDispatcherFieldUndefined = (err: unknown) => /dispatcher(Primary|Backup)/.test(JSON.stringify(err ?? ''))

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
function undefinedLoadFields(err: unknown): { hot: boolean; stops: boolean; sortOrder: boolean; customerId: boolean; eldReview: boolean } {
  const errs = (err as { errors?: { message?: string }[] })?.errors
  const msg = Array.isArray(errs) ? errs.map((e) => e?.message ?? '').join(' ') : ''
  return {
    hot: /'(hot|unscheduled)'/i.test(msg),
    stops: /'stops'/i.test(msg),
    sortOrder: /'sortOrder'/i.test(msg),
    customerId: /'customerId'/i.test(msg),
    eldReview: /'(eldLogsReviewedAt|eldLogsReviewedBy|eldLogsNote)'/i.test(msg),
  }
}

export async function listLoads(): Promise<Load[]> {
  const run = async () => client.graphql({
    query: `query ListLoads { listLoads(limit: 10000) { items { ${loadFields()} } } }`,
  }) as Promise<{ data: { listLoads: { items: (Load & { rateConfirmKey?: string })[] } } }>

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
  const { dispatcherPrimary: _dp, dispatcherBackup: _db, ...withoutDispatcher } = all

  // The SELECTION matters as much as the input. Building it from `driversHaveTrailer`
  // meant a stale flag returned a driver with fleetGroup/assignedTrailerId missing —
  // the write succeeded and the response then overwrote local state without them, so a
  // saved value instantly read as unsaved. Ask for them on the optimistic attempt.
  const run = async (input: Record<string, unknown>, withNewFields: boolean) => {
    const fields = withNewFields
      ? `${DRIVER_BASE_FIELDS} ${driversHaveCompliance ? 'onboardingStatus complianceStatus' : ''} assignedTrailerId fleetGroup motiveDriverId dispatcherPrimary dispatcherBackup`
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
  const items: FactoringItem[] = []
  let nextToken: string | null = null
  do {
    const result = await client.graphql({
      query: `query ListFactoringItems($nextToken: String) { listFactoringItems(limit: 1000, nextToken: $nextToken) { items { ${FACTORING_ITEM_FIELDS} } nextToken } }`,
      variables: { nextToken },
    }) as { data: { listFactoringItems: { items: (FactoringItem | null)[]; nextToken?: string | null } } }
    const page = result.data.listFactoringItems
    for (const item of page.items ?? []) {
      if (item) items.push(parseFactoringJson(item))
    }
    nextToken = page.nextToken ?? null
  } while (nextToken)
  return items
}

/** Staff may update status; email intake owns creation. */
export async function updateFactoringItem(
  id: string,
  patch: { status: FactoringItemStatus },
): Promise<FactoringItem> {
  const result = await client.graphql({
    query: `mutation UpdateFactoringItem($input: UpdateFactoringItemInput!) { updateFactoringItem(input: $input) { ${FACTORING_ITEM_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateFactoringItem: FactoringItem } }
  return parseFactoringJson(result.data.updateFactoringItem)
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
  const result = await client.graphql({
    query: `mutation UpdateFactoringItem($input: UpdateFactoringItemInput!) { updateFactoringItem(input: $input) { ${FACTORING_ITEM_FIELDS} } }`,
    variables: { input: { id, otrManualFields: JSON.stringify(cleaned) } },
  }) as { data: { updateFactoringItem: FactoringItem } }
  return parseFactoringJson(result.data.updateFactoringItem)
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
  amount invoiceDate description fromEmail attachments receivedAt
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

const CUSTOMER_FIELDS = `
  id name contactName contactEmail contactPhone notes
  mcNumber dotNumber factored billingEmail billingContactName billingPhone billingAddress
  paymentTermsDays creditLimitCents creditHoldFlag requiredDocsForInvoice
  defaultDivisionKey defaultSalesRepId aliases normalizedName active apptWorkflow mergedIntoId
  createdAt updatedAt
`
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
const TMS_SETTINGS_FIELDS = `id marginFloorBps defaultPaymentTermsDays accessorialCodes loadStatusRules invoiceNumberFormat autoClearPastAppts createdAt updatedAt`
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
  const rows = (await listAll<CustomerRecord>('listCustomers', CUSTOMER_FIELDS, 1000))
    .map((c) => rememberCustomerPolicy(unwrapJsonFields(c, ['billingAddress'])))
  return opts?.includeArchived ? rows : rows.filter(isActiveDirectoryRecord)
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

export async function listLocations(opts?: { includeArchived?: boolean }): Promise<LocationRecord[]> {
  const rows = (await listAll<LocationRecord>('listLocations', LOCATION_FIELDS, 1000)).map((l) => unwrapJsonFields(l, ['contacts']))
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
  const r = await client.graphql({
    query: `query GetTmsSettings { getTmsSettings(id: "default") { ${TMS_SETTINGS_FIELDS} } }`,
  }) as { data: { getTmsSettings: TmsSettings | null } }
  return r.data.getTmsSettings ? unwrapJsonFields(r.data.getTmsSettings, ['accessorialCodes', 'loadStatusRules']) : null
}
export async function saveTmsSettings(patch: Partial<Omit<TmsSettings, 'id' | 'createdAt' | 'updatedAt'>>, expectedUpdatedAt?: string): Promise<TmsSettings> {
  return directoryAction<TmsSettings>('SAVE_SETTINGS', { id: 'default', expectedUpdatedAt, ...patch })
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
  active: boolean
  notes?: string | null
  createdAt: string
  updatedAt: string
}

const EXPENSE_TYPE_FIELDS = `id name category defaultEntryMethod active notes createdAt updatedAt`
const ALLOCATION_FIELDS   = `id expenseTypeId allocationMethod truckIds notes createdAt updatedAt`
const EXPENSE_REC_FIELDS  = `id expenseTypeId allocationId amount periodMonth transactionDate entryMethod directTruckId notes source createdAt updatedAt`
const RECURRING_FIELDS    = `id expenseTypeId allocationId monthlyAmount startMonth endMonth active notes createdAt updatedAt`

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
function normalizeLoadStops<T extends { stops?: unknown }>(load: T): T {
  if (load.stops == null) return load
  const v = unwrapJson(load.stops)
  return { ...load, stops: Array.isArray(v) ? v : undefined }
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
  eldSource eldSerialNumber motiveVehicleNumber fleetGroup lastPmDate lastPmMileage notes
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
  correctedBy correctedAt originalMinutes createdAt updatedAt
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
  id phone driverId driverName displayName status lastMessageAt lastPreview lastDirection lastKind lastSentBy
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

export type DispatchAction =
  | 'send' | 'start' | 'markRead' | 'assign' | 'link' | 'archive' | 'reopen' | 'note' | 'mediaUrl' | 'slackUrl' | 'createSlackChannel'
  | 'status' | 'getSettings' | 'saveSettings'

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
