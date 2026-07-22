import { generateClient } from 'aws-amplify/data'
import { uploadData, getUrl, remove } from 'aws-amplify/storage'
import type { Load, Driver, AuditLogEntry, EntityType, AuditAction } from '@/types'
import type { Equipment, MaintenanceTask, MaintenanceInvoice } from '@/types/equipment'
import { fuelDedupKey } from '@/lib/driverFuel'

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

// `hot`/`unscheduled` and `stops` are newer fields added in later backend deploys. Each
// is gated by a flag and appended only while the backend supports it; if the API predates
// a field, listLoads detects the FieldUndefined error, clears that flag, and retries (so a
// frontend shipping before the backend deploy keeps working). Self-heals post-deploy.
let loadsHaveHot = true
let loadsHaveStops = true
let loadsHaveSortOrder = true
const loadFields = () => {
  let f = LOAD_FIELDS
  if (loadsHaveHot) f += ' hot unscheduled'
  if (loadsHaveStops) f += ' stops'
  if (loadsHaveSortOrder) f += ' sortOrder'
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
const driverFields = () =>
  driversHaveCompliance ? `${DRIVER_BASE_FIELDS} onboardingStatus complianceStatus` : DRIVER_BASE_FIELDS

function isComplianceFieldUndefined(err: unknown): boolean {
  const errs = (err as { errors?: { message?: string }[] })?.errors
  return Array.isArray(errs) && errs.some((e) => /'(onboardingStatus|complianceStatus)'/.test(e?.message ?? ''))
}

const AUDIT_FIELDS = `
  id entityType entityId action user changes createdAt
`

// ── Loads ─────────────────────────────────────────────────────────────────────

// Which newer fields the backend is rejecting (not deployed yet). Used to clear the
// corresponding flag and retry. Handles `hot`/`unscheduled` and `stops` together.
function undefinedLoadFields(err: unknown): { hot: boolean; stops: boolean; sortOrder: boolean } {
  const errs = (err as { errors?: { message?: string }[] })?.errors
  const msg = Array.isArray(errs) ? errs.map((e) => e?.message ?? '').join(' ') : ''
  return {
    hot: /'(hot|unscheduled)'/i.test(msg),
    stops: /'stops'/i.test(msg),
    sortOrder: /'sortOrder'/i.test(msg),
  }
}

export async function listLoads(): Promise<Load[]> {
  const run = async () => client.graphql({
    query: `query ListLoads { listLoads(limit: 10000) { items { ${loadFields()} } } }`,
  }) as Promise<{ data: { listLoads: { items: (Load & { rateConfirmKey?: string })[] } } }>

  let result
  // Retry up to twice so a single query missing BOTH hot/unscheduled and stops recovers.
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
      if (!changed) throw err
    }
  }
  const items = result.data.listLoads.items ?? []
  return Promise.all(items.map(resolveRateConfirmUrl))
}

// `stops` is an a.json() (AWSJSON) field. Through this client it must be written as a
// JSON STRING (same as createAuditLog's `changes`); reads undo the encoding via unwrapJson.
// Also drop `stops` from the input if the backend doesn't have the field yet (pre-deploy).
function serializeLoadInput<T extends { stops?: unknown; sortOrder?: unknown }>(input: T): T {
  let out: T = input
  if (!loadsHaveSortOrder && 'sortOrder' in (out as object)) {
    const { sortOrder: _drop, ...rest } = out as T & { sortOrder?: unknown }
    out = rest as T
  }
  if (!loadsHaveStops) {
    const { stops: _drop, ...rest } = out as T & { stops?: unknown }
    return rest as T
  }
  if (out.stops == null) return out
  return { ...out, stops: JSON.stringify(out.stops) }
}

export async function createLoad(
  input: Omit<Load, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Load> {
  const { rateConfirmUrl: _skip, ...rest } = input as Load & { rateConfirmUrl?: string }
  const result = await client.graphql({
    query: `mutation CreateLoad($input: CreateLoadInput!) { createLoad(input: $input) { ${loadFields()} } }`,
    variables: { input: serializeLoadInput(rest) },
  }) as { data: { createLoad: Load } }
  return normalizeLoadStops(result.data.createLoad)
}

export async function updateLoad(
  id: string,
  patch: Partial<Omit<Load, 'id' | 'createdAt'>>
): Promise<Load> {
  const { rateConfirmUrl: _skip, ...rest } = patch as typeof patch & { rateConfirmUrl?: string }
  const result = await client.graphql({
    query: `mutation UpdateLoad($input: UpdateLoadInput!) { updateLoad(input: $input) { ${loadFields()} } }`,
    variables: { input: serializeLoadInput({ id, ...rest }) },
  }) as { data: { updateLoad: Load } }
  return resolveRateConfirmUrl(result.data.updateLoad)
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
      (d) => { if (d.onCreateLoad) cb(normalizeLoadStops(d.onCreateLoad)) },
    )
  }
  if (callbacks.onUpdate) {
    const cb = callbacks.onUpdate
    wire<{ onUpdateLoad: Load }>(
      `subscription OnUpdateLoad { onUpdateLoad { ${loadFields()} } }`,
      (d) => { if (d.onUpdateLoad) cb(normalizeLoadStops(d.onUpdateLoad)) },
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
  try {
    const result = await run()
    const items = result.data.listDrivers.items ?? []
    return Promise.all(items.map(resolveDriverPhotoUrl))
  } catch (err: unknown) {
    // Backend doesn't have the compliance fields yet (pre-deploy) — drop them and retry.
    if (driversHaveCompliance && isComplianceFieldUndefined(err)) {
      console.warn("[apiClient] backend has no onboardingStatus/complianceStatus yet — querying drivers without them until deploy")
      driversHaveCompliance = false
      const result = await run()
      return Promise.all((result.data.listDrivers.items ?? []).map(resolveDriverPhotoUrl))
    }
    // Stale records (e.g. legacy lowercase driverType before the enum migration) make
    // AppSync return partial errors with valid data alongside. Surface what we can
    // rather than blanking the roster — invalid enum fields come back null (Unclassified).
    const partial = (err as { data?: { listDrivers?: { items?: Driver[] } } }).data
    if (partial?.listDrivers?.items) {
      console.warn('[listDrivers] partial errors (stale records?) — showing valid items', err)
      return Promise.all(partial.listDrivers.items.filter(Boolean).map(resolveDriverPhotoUrl))
    }
    throw err
  }
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
  const { photoUrl: _skip, ...rest } = patch as typeof patch & { photoUrl?: string }
  try {
    const result = await client.graphql({
      query: `mutation UpdateDriver($input: UpdateDriverInput!) { updateDriver(input: $input) { ${driverFields()} } }`,
      variables: { input: { id, ...rest } },
    }) as { data: { updateDriver: Driver } }
    return resolveDriverPhotoUrl(result.data.updateDriver)
  } catch (err: unknown) {
    const partial = driverFromPartial(err, 'updateDriver')
    if (partial) return resolveDriverPhotoUrl(partial)
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

// ── Vehicle quote email (Best Care Auto Transport) ─────────────────────────────

/**
 * Send the branded HTML vehicle-transport quote. `html` is built on the frontend
 * (src/lib/quoteEmail.ts) so the preview and the sent email match. The Lambda sends
 * from ruben@bcatcorp.com and always BCCs cars@bcatcorp.com.
 */
export async function sendVehicleQuoteEmail(args: {
  to: string
  subject: string
  html: string
  replyTo?: string
}): Promise<{ sent: boolean; to?: string; bcc?: string; error?: string }> {
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
  return (data ?? { sent: false, error: 'no-response' }) as { sent: boolean; to?: string; bcc?: string; error?: string }
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

import type { AmazonDispute } from '@/types/dispute'

const DISPUTE_FIELDS = `
  id driverName tripNumber shipmentDate payPeriod amountPaid amountRequested
  description photoUrl status resolvedAmount submittedAt source externalId notes
  createdAt updatedAt
`

export async function listAmazonDisputes(): Promise<AmazonDispute[]> {
  const result = await client.graphql({
    query: `query ListAmazonDisputes { listAmazonDisputes(limit: 5000) { items { ${DISPUTE_FIELDS} } } }`,
  }) as { data: { listAmazonDisputes: { items: AmazonDispute[] } } }
  return result.data.listAmazonDisputes.items ?? []
}

export async function createAmazonDispute(
  input: Omit<AmazonDispute, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<AmazonDispute> {
  const result = await client.graphql({
    query: `mutation CreateAmazonDispute($input: CreateAmazonDisputeInput!) { createAmazonDispute(input: $input) { ${DISPUTE_FIELDS} } }`,
    variables: { input },
  }) as { data: { createAmazonDispute: AmazonDispute } }
  return result.data.createAmazonDispute
}

export async function updateAmazonDispute(
  id: string,
  patch: Partial<Omit<AmazonDispute, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<AmazonDispute> {
  const result = await client.graphql({
    query: `mutation UpdateAmazonDispute($input: UpdateAmazonDisputeInput!) { updateAmazonDispute(input: $input) { ${DISPUTE_FIELDS} } }`,
    variables: { input: { id, ...patch } },
  }) as { data: { updateAmazonDispute: AmazonDispute } }
  return result.data.updateAmazonDispute
}

export async function deleteAmazonDispute(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteAmazonDispute($input: DeleteAmazonDisputeInput!) { deleteAmazonDispute(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── S3 rate confirmations ─────────────────────────────────────────────────────

export async function uploadRateConfirm(loadId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const key = `rate-confirms/${loadId}/rate-confirm.${ext}`
  await uploadData({ path: key, data: file, options: { contentType: file.type } }).result
  return key
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
  const safe = (fileName || 'master.csv').replace(/[^\w.\-]+/g, '_')
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
  eldSource eldSerialNumber fleetGroup lastPmDate lastPmMileage notes
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
  id equipmentId date vendor description amount invoiceNumber paymentMethod paymentDate assignee source createdAt updatedAt
`

export async function listMaintenanceInvoices(): Promise<MaintenanceInvoice[]> {
  const result = await client.graphql({
    query: `query ListMaintenanceInvoices { listMaintenanceInvoices(limit: 5000) { items { ${MAINT_INVOICE_FIELDS} } } }`,
  }) as { data: { listMaintenanceInvoices: { items: MaintenanceInvoice[] } } }
  return result.data.listMaintenanceInvoices.items ?? []
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
  source:      string
  syncedAt:    string
  createdAt:   string
  updatedAt:   string
}

const TRUCK_MILEAGE_FIELDS = `truckId unitNumber periodStart periodType miles source syncedAt createdAt updatedAt`

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

export interface FixedExpense { label: string; amount: number }

export interface DriverPaySetting {
  id:                    string
  driverId:              string
  payGroup?:             'AMAZON' | 'LOCAL' | 'BOX_TRUCK' | null
  payPercent:            number
  expensesBeforePercent: boolean
  email?:                string | null
  fuelCardNumber?:       string | null
  fixedExpenses?:        FixedExpense[] | null
  active?:               boolean | null
  notes?:                string | null
  createdAt:             string
  updatedAt:             string
}

const PAY_SETTING_FIELDS = `id driverId payGroup payPercent expensesBeforePercent email fuelCardNumber fixedExpenses active notes createdAt updatedAt`

function normalizePaySetting(raw: DriverPaySetting & { fixedExpenses?: unknown }): DriverPaySetting {
  const v = unwrapJson(raw.fixedExpenses)
  return { ...raw, fixedExpenses: Array.isArray(v) ? v as FixedExpense[] : [] }
}

export async function listDriverPaySettings(): Promise<DriverPaySetting[]> {
  const result = await client.graphql({
    query: `query ListDriverPaySettings { listDriverPaySettings(limit: 1000) { items { ${PAY_SETTING_FIELDS} } } }`,
  }) as { data: { listDriverPaySettings: { items: DriverPaySetting[] } } }
  return (result.data.listDriverPaySettings.items ?? []).map(normalizePaySetting)
}

function serializePaySetting<T extends { fixedExpenses?: unknown }>(input: T): T {
  if (input.fixedExpenses == null) return input
  return { ...input, fixedExpenses: JSON.stringify(input.fixedExpenses) }
}

export async function createDriverPaySetting(input: Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt'>): Promise<DriverPaySetting> {
  const result = await client.graphql({
    query: `mutation CreateDriverPaySetting($input: CreateDriverPaySettingInput!) { createDriverPaySetting(input: $input) { ${PAY_SETTING_FIELDS} } }`,
    variables: { input: serializePaySetting(input) },
  }) as { data: { createDriverPaySetting: DriverPaySetting } }
  return normalizePaySetting(result.data.createDriverPaySetting)
}

export async function updateDriverPaySetting(id: string, patch: Partial<Omit<DriverPaySetting, 'id' | 'createdAt' | 'updatedAt'>>): Promise<DriverPaySetting> {
  const result = await client.graphql({
    query: `mutation UpdateDriverPaySetting($input: UpdateDriverPaySettingInput!) { updateDriverPaySetting(input: $input) { ${PAY_SETTING_FIELDS} } }`,
    variables: { input: serializePaySetting({ id, ...patch }) },
  }) as { data: { updateDriverPaySetting: DriverPaySetting } }
  return normalizePaySetting(result.data.updateDriverPaySetting)
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
