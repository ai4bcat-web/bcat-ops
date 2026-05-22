import { generateClient } from 'aws-amplify/data'
import { uploadData, getUrl, remove } from 'aws-amplify/storage'
import type { Load, Driver, AuditLogEntry, EntityType, AuditAction } from '@/types'

// Untyped client — our own types from src/types handle type safety
const client = generateClient()

// ── GraphQL fragments ─────────────────────────────────────────────────────────

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

const DRIVER_FIELDS = `
  id name phone active type colorKey notes photoKey assignedTruckId
  createdAt updatedAt
`

const AUDIT_FIELDS = `
  id entityType entityId action user changes createdAt
`

// ── Loads ─────────────────────────────────────────────────────────────────────

export async function listLoads(): Promise<Load[]> {
  const result = await client.graphql({
    query: `query ListLoads { listLoads(limit: 10000) { items { ${LOAD_FIELDS} } } }`,
  }) as { data: { listLoads: { items: (Load & { rateConfirmKey?: string })[] } } }
  const items = result.data.listLoads.items ?? []
  return Promise.all(items.map(resolveRateConfirmUrl))
}

export async function createLoad(
  input: Omit<Load, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Load> {
  const { rateConfirmUrl: _skip, ...rest } = input as Load & { rateConfirmUrl?: string }
  const result = await client.graphql({
    query: `mutation CreateLoad($input: CreateLoadInput!) { createLoad(input: $input) { ${LOAD_FIELDS} } }`,
    variables: { input: rest },
  }) as { data: { createLoad: Load } }
  return result.data.createLoad
}

export async function updateLoad(
  id: string,
  patch: Partial<Omit<Load, 'id' | 'createdAt'>>
): Promise<Load> {
  const { rateConfirmUrl: _skip, ...rest } = patch as typeof patch & { rateConfirmUrl?: string }
  const result = await client.graphql({
    query: `mutation UpdateLoad($input: UpdateLoadInput!) { updateLoad(input: $input) { ${LOAD_FIELDS} } }`,
    variables: { input: { id, ...rest } },
  }) as { data: { updateLoad: Load } }
  return resolveRateConfirmUrl(result.data.updateLoad)
}

export async function deleteLoad(id: string): Promise<void> {
  await client.graphql({
    query: `mutation DeleteLoad($input: DeleteLoadInput!) { deleteLoad(input: $input) { id } }`,
    variables: { input: { id } },
  })
}

// ── Drivers ───────────────────────────────────────────────────────────────────

export async function listDrivers(): Promise<Driver[]> {
  const result = await client.graphql({
    query: `query ListDrivers { listDrivers(limit: 1000) { items { ${DRIVER_FIELDS} } } }`,
  }) as { data: { listDrivers: { items: Driver[] } } }
  const items = result.data.listDrivers.items ?? []
  return Promise.all(items.map(resolveDriverPhotoUrl))
}

export async function createDriver(
  input: Omit<Driver, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Driver> {
  const result = await client.graphql({
    query: `mutation CreateDriver($input: CreateDriverInput!) { createDriver(input: $input) { ${DRIVER_FIELDS} } }`,
    variables: { input },
  }) as { data: { createDriver: Driver } }
  return result.data.createDriver
}

export async function updateDriver(
  id: string,
  patch: Partial<Omit<Driver, 'id' | 'createdAt'>>
): Promise<Driver> {
  const { photoUrl: _skip, ...rest } = patch as typeof patch & { photoUrl?: string }
  const result = await client.graphql({
    query: `mutation UpdateDriver($input: UpdateDriverInput!) { updateDriver(input: $input) { ${DRIVER_FIELDS} } }`,
    variables: { input: { id, ...rest } },
  }) as { data: { updateDriver: Driver } }
  return resolveDriverPhotoUrl(result.data.updateDriver)
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
 * One-time cleanup: finds and deletes duplicate FuelTransaction records.
 * Keeps the oldest record (smallest createdAt) for each dedup key.
 * Dedup key: transactionDate|cardNumber|invoiceNumber|fuelType|amount
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
    const key = `${tx.transactionDate}|${tx.cardNumber}|${tx.invoiceNumber ?? ''}|${tx.fuelType}|${tx.amount}`
    if (seen.has(key)) {
      toDelete.push(tx.id)
    } else {
      seen.set(key, tx)
    }
  }

  console.log(`[cleanupDuplicates] ${all.length} total, ${toDelete.length} duplicates to remove`)
  for (const id of toDelete) {
    await deleteFuelTransaction(id)
    console.log(`[cleanupDuplicates] deleted ${id}`)
  }

  return { removed: toDelete.length, kept: seen.size }
}

/** Check for existing transactions matching the dedup key to skip duplicates */
export async function checkFuelTxExists(
  transactionDate: string,
  cardNumber: string,
  invoiceNumber: string,
  fuelType: string,
): Promise<boolean> {
  const result = await client.graphql({
    query: `query ListFuelTransactions($filter: ModelFuelTransactionFilterInput) {
      listFuelTransactions(filter: $filter, limit: 1) { items { id } }
    }`,
    variables: {
      filter: {
        transactionDate: { eq: transactionDate },
        cardNumber:      { eq: cardNumber },
        invoiceNumber:   { eq: invoiceNumber },
        fuelType:        { eq: fuelType },
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

// ── User management ───────────────────────────────────────────────────────────

export interface CognitoUser {
  username: string
  email: string
  status: string
  enabled: boolean
  createdAt: string
}

export async function listCognitoUsers(): Promise<CognitoUser[]> {
  const result = await client.graphql({
    query: `query ManageUsers($action: String!) { manageUsers(action: $action) }`,
    variables: { action: 'list' },
  }) as { data: { manageUsers: unknown } }
  const raw = result.data.manageUsers
  // AppSync AWSJSON may already be parsed or still a string — handle both
  if (Array.isArray(raw)) return raw as CognitoUser[]
  if (typeof raw === 'string') return JSON.parse(raw) as CognitoUser[]
  // null means the Lambda didn't return a value — surface as error instead of silently showing 0 users
  throw new Error(`manageUsers returned null — Lambda may not be deployed or USER_POOL_ID may be misconfigured. Raw response: ${JSON.stringify(raw)}`)
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
  const raw = result.data.manageUsers
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === 'string') return JSON.parse(raw) as string[]
  return []
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

async function resolveRateConfirmUrl(
  load: Load & { rateConfirmKey?: string }
): Promise<Load> {
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
  ownershipType?:      'COMPANY' | 'OWNER_OPERATOR'
  motiveVehicleId?:    number | null
  motiveVehicleNumber?: string | null
  createdAt:           string
  updatedAt:           string
}

const TRUCK_CONFIG_FIELDS = `truckId unitNumber ownershipType motiveVehicleId motiveVehicleNumber createdAt updatedAt`

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

export async function listTruckMileages(truckId?: string): Promise<TruckMileage[]> {
  if (truckId) {
    const result = await client.graphql({
      query: `query ListByTruck($truckId: String!) {
        listTruckMileageByTruckIdAndPeriodStart(truckId: $truckId, limit: 500) {
          items { ${TRUCK_MILEAGE_FIELDS} }
        }
      }`,
      variables: { truckId },
    }) as { data: { listTruckMileageByTruckIdAndPeriodStart: { items: TruckMileage[] } } }
    return result.data.listTruckMileageByTruckIdAndPeriodStart.items ?? []
  }
  const result = await client.graphql({
    query: `query ListTruckMileages { listTruckMileages(limit: 5000) { items { ${TRUCK_MILEAGE_FIELDS} } } }`,
  }) as { data: { listTruckMileages: { items: TruckMileage[] } } }
  return result.data.listTruckMileages.items ?? []
}
