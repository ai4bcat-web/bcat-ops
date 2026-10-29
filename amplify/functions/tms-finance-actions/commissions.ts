/*
 * Commissions (Step I) — the only writer of the `Commission` ledger.
 *
 * It lives inside tmsFinanceActions because this is where the money is frozen:
 * `GENERATE_INVOICE` stamps `LoadFinancials.frozenAt` in its own transaction and
 * `recordPayment` settles the order. A commission computed before the freeze is a
 * commission on a number that can still change.
 *
 * The arithmetic is not here — it is `src/lib/commission.ts`, pure and tested, so
 * the number the Commissions page previews is the number this file writes. What
 * is here is the reading, the authorization and the transactions:
 *
 *  - `runCommissions` reconciles one invoice (or a whole month) against what the
 *    plan says today: missing rows are written, unapproved rows are rewritten,
 *    approved rows are left alone and their difference is booked as its own row.
 *    Running it again over the same facts writes nothing.
 *  - `commissionVoidWrites` hands `VOID_INVOICE` the items it must include in its
 *    own transaction, so an invoice and its commissions can never disagree.
 *  - Nothing here moves money out of the business: a PAID pay period records that
 *    payroll happened elsewhere, the way `MARK_SENT` records a posted invoice.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { assertString, optionalInteger, optionalString, type Caller } from '../_shared/actionInputs'
import type {
  CommissionPaySchedule,
  CommissionPlan,
  CommissionRecord,
  CommissionStatus,
  CommissionTrigger,
  TmsSettings,
  UserProfileRecord,
} from '../../../src/types/tms'
import {
  appendEvent,
  commissionState,
  computeCommissions,
  netCentsOf,
  payPeriodId as payPeriodIdFor,
  payPeriodTotals,
  periodWindow,
  reconcileCommissions,
  reverseFor,
  validateCommissionPlans,
  validatePaySchedule,
  type ComputeContext,
  type DesiredCommission,
} from '../../../src/lib/commission'
import {
  ADMIN_GROUP,
  COMMISSION_PAY_PERIOD_TABLE_NAME,
  COMMISSION_TABLE_NAME,
  CUSTOMER_TABLE_NAME,
  IDX_CARRIERS_BY_SHIPMENT,
  IDX_COMMISSIONS_BY_INVOICE,
  IDX_COMMISSIONS_BY_MONTH,
  IDX_COMMISSIONS_BY_PAY_PERIOD,
  IDX_LOADS_BY_SHIPMENT,
  INVOICE_TABLE_NAME,
  LOAD_CARRIER_TABLE_NAME,
  LOAD_FINANCIALS_TABLE_NAME,
  LOAD_TABLE_NAME,
  ORDER_TABLE_NAME,
  SETTINGS_ID,
  SETTINGS_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  USER_PROFILE_TABLE_NAME,
  getById,
  getSettings,
  nowIso,
  numberOrNull,
  putTx,
  queryIndex,
  transact,
  putPdf,
  signedDownload,
  updateTx,
  writeAudit,
  type Row,
} from './store'

/** DynamoDB takes 100 items in a transaction; a run is chunked well under it. */
const MAX_COMMISSION_BATCH = 90

const MANAGER_GROUP = 'role-MANAGER'
const COMMISSIONS_PAGE_GROUP = 'page-commissions'

// ── reading ─────────────────────────────────────────────────────────────────

export async function getCommission(id: string): Promise<CommissionRecord> {
  const row = await getById(COMMISSION_TABLE_NAME, id)
  if (!row) throw new Error(`Commission not found: ${id}`)
  return row as unknown as CommissionRecord
}

export async function commissionsForInvoice(invoiceId: string): Promise<CommissionRecord[]> {
  if (!COMMISSION_TABLE_NAME || !invoiceId) return []
  const rows = await queryIndex(COMMISSION_TABLE_NAME, IDX_COMMISSIONS_BY_INVOICE, 'invoiceId', invoiceId)
  return rows as unknown as CommissionRecord[]
}

async function commissionsForMonth(month: string): Promise<CommissionRecord[]> {
  const rows = await queryIndex(COMMISSION_TABLE_NAME, IDX_COMMISSIONS_BY_MONTH, 'commissionMonth', month)
  return rows as unknown as CommissionRecord[]
}

async function commissionsForPeriod(periodId: string): Promise<CommissionRecord[]> {
  const rows = await queryIndex(COMMISSION_TABLE_NAME, IDX_COMMISSIONS_BY_PAY_PERIOD, 'payPeriodId', periodId)
  return rows as unknown as CommissionRecord[]
}

/**
 * The staff rows the roles on this order could possibly name.
 *
 * Read by id rather than scanned: every rep field already holds the Cognito
 * username, which is this table's key, so a handful of GetItems answers it and
 * the Lambda never needs Scan on the staff directory.
 */
async function readProfiles(ids: (string | null | undefined)[]): Promise<Record<string, UserProfileRecord>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))]
  if (wanted.length === 0 || !USER_PROFILE_TABLE_NAME) return {}
  const rows = await Promise.all(wanted.map((id) => getById(USER_PROFILE_TABLE_NAME, id)))
  const out: Record<string, UserProfileRecord> = {}
  for (let i = 0; i < wanted.length; i += 1) {
    const row = rows[i]
    if (row) out[wanted[i]] = row as unknown as UserProfileRecord
  }
  return out
}

interface CommissionContext {
  order: Row
  shipment: Row | null
  invoice: Row
  customer: Row | null
  loads: Row[]
  assignments: Row[]
  financials: Row[]
  profiles: Record<string, UserProfileRecord>
  settings: TmsSettings
}

/** Every row one invoice's commissions need, read once. */
async function readCommissionContext(invoiceId: string): Promise<CommissionContext | null> {
  const invoice = await getById(INVOICE_TABLE_NAME, invoiceId)
  if (!invoice) return null
  const orderId = typeof invoice.orderId === 'string' ? invoice.orderId : ''
  if (!orderId) return null
  const order = await getById(ORDER_TABLE_NAME, orderId)
  if (!order) return null

  const shipmentId = typeof order.shipmentId === 'string' ? order.shipmentId : ''
  const customerId = typeof order.customerId === 'string' ? order.customerId : ''
  const [shipment, customer, loadRows, assignmentRows, settings] = await Promise.all([
    shipmentId ? getById(SHIPMENT_TABLE_NAME, shipmentId) : Promise.resolve(null),
    customerId ? getById(CUSTOMER_TABLE_NAME, customerId) : Promise.resolve(null),
    shipmentId ? queryIndex(LOAD_TABLE_NAME, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId) : Promise.resolve([]),
    shipmentId ? queryIndex(LOAD_CARRIER_TABLE_NAME, IDX_CARRIERS_BY_SHIPMENT, 'shipmentId', shipmentId) : Promise.resolve([]),
    getSettings(),
  ])

  // A consolidated shipment carries several orders; only this order's loads pay
  // this order's commission. A load with no `orderId` belongs to the only order
  // there is, which is the shape every pre-consolidation shipment has.
  const loads = loadRows.filter((load) => load.orderId === orderId || !load.orderId)
  const loadIds = loads.map((load) => String(load.id))
  // `LoadFinancials` is keyed by its load's id, so the money comes back by GetItem.
  const financials = (await Promise.all(loadIds.map((id) => getById(LOAD_FINANCIALS_TABLE_NAME, id)))).filter(
    (row): row is Row => row != null,
  )
  const assignments = assignmentRows.filter((row) => loadIds.includes(String(row.loadId)))

  const profiles = await readProfiles([
    order.createdBy as string,
    order.customerRepId as string,
    ...(Array.isArray(customer?.accountOwnerIds) ? (customer.accountOwnerIds as string[]) : []),
    customer?.operatedById as string,
    ...loads.map((load) => load.carrierRepId as string),
    ...assignments.map((row) => row.carrierRepId as string),
  ])
  // The MANAGER role pays the account owner's manager, so their row is needed too.
  const managerIds = Object.values(profiles)
    .map((profile) => profile.managerId)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  const managers = await readProfiles(managerIds)

  return {
    order,
    shipment,
    invoice,
    customer,
    loads,
    assignments,
    financials,
    profiles: { ...profiles, ...managers },
    settings: settings as unknown as TmsSettings,
  }
}

function triggerAtFor(context: CommissionContext, trigger: CommissionTrigger): string {
  if (trigger === 'INVOICE_PAID') {
    const paid = context.order.paidAt ?? context.invoice.paidAt
    if (typeof paid === 'string' && paid) return paid
  }
  const invoiced = context.order.invoicedAt ?? context.invoice.invoiceDate
  return typeof invoiced === 'string' && invoiced ? invoiced : nowIso()
}

function buildComputeContext(context: CommissionContext, caller: string, now: string): ComputeContext {
  const settings = context.settings
  const trigger: CommissionTrigger = settings.commissionTrigger === 'INVOICE_PAID' ? 'INVOICE_PAID' : 'GENERATE_INVOICE'
  return {
    order: {
      id: String(context.order.id),
      shipmentId: (context.order.shipmentId as string) ?? null,
      customerId: (context.order.customerId as string) ?? null,
      customerName: (context.order.customerName as string) ?? null,
      customerRepId: (context.order.customerRepId as string) ?? null,
      createdBy: (context.order.createdBy as string) ?? null,
      invoicedAt: (context.order.invoicedAt as string) ?? null,
      divisionKey: (context.loads.find((load) => load.divisionKey)?.divisionKey as string) ?? null,
    },
    invoice: {
      id: String(context.invoice.id),
      number: (context.invoice.number as string) ?? null,
      invoiceDate: (context.invoice.invoiceDate as string) ?? null,
      totalCents: numberOrNull(context.invoice.totalCents),
      writtenOffCents: numberOrNull(context.invoice.writtenOffCents),
    },
    customer: context.customer
      ? {
          accountOwnerIds: (context.customer.accountOwnerIds as string[]) ?? null,
          operatedById: (context.customer.operatedById as string) ?? null,
          gpSplitBps: numberOrNull(context.customer.gpSplitBps),
          teamKey: (context.customer.teamKey as string) ?? null,
        }
      : null,
    shipment: context.shipment
      ? {
          number: (context.shipment.number as string) ?? null,
          divisionKey: (context.shipment.divisionKey as string) ?? null,
        }
      : null,
    loads: context.loads.map((load) => ({
      id: String(load.id),
      carrierRepId: (load.carrierRepId as string) ?? null,
      divisionKey: (load.divisionKey as string) ?? null,
    })),
    assignments: context.assignments.map((row) => ({
      kind: (row.kind as string) ?? null,
      status: (row.status as string) ?? null,
      chargesFinalizedAt: (row.chargesFinalizedAt as string) ?? null,
      carrierRepId: (row.carrierRepId as string) ?? null,
      carrierId: (row.carrierId as string) ?? null,
      carrierName: (row.carrierName as string) ?? null,
    })),
    financials: context.financials.map((row) => ({
      costCents: numberOrNull(row.costCents),
      revenueCents: numberOrNull(row.revenueCents),
    })),
    profiles: context.profiles,
    plans: (settings.commissionPlans as CommissionPlan[] | null) ?? null,
    trigger,
    triggerAt: triggerAtFor(context, trigger),
    caller,
    nowIso: now,
  }
}

// ── authorization ───────────────────────────────────────────────────────────

/**
 * Who may act on a commission row. The page group is the door; the ladder inside
 * is `commissionState`, which the page reads from the same lib so the button a
 * rep can see is the button the Lambda will honour.
 */
export function commissionCallerOf(caller: Caller, settings: TmsSettings): {
  id: string | null
  email: string
  isAdmin: boolean
  isManager: boolean
  mayApprove: boolean
} {
  const groups = caller.groups ?? []
  const isAdmin = caller.isAdmin === true || groups.includes(ADMIN_GROUP)
  const isManager = groups.includes(MANAGER_GROUP)
  return {
    // The username: what a rep picked from a profile is stored as.
    id: caller.sub ?? null,
    email: caller.email,
    isAdmin,
    isManager,
    mayApprove: isAdmin || (isManager && settings.commissionApprovalAdminOnly !== true),
  }
}

function assertCommissionsOn(settings: TmsSettings): void {
  if (settings.commissionsEnabled !== true) {
    throw new Error('Commissions are turned off. Switch them on in Settings → Commissions first.')
  }
}

function assertMayPay(caller: Caller, settings: TmsSettings): void {
  const actor = commissionCallerOf(caller, settings)
  if (actor.isAdmin) return
  if (settings.commissionPayAdminOnly === false && actor.isManager) return
  throw new Error('Forbidden: pay periods require owner or ADMIN')
}

// ── RUN_COMMISSIONS ─────────────────────────────────────────────────────────

interface RunReport {
  invoiceId: string
  puts: number
  updates: number
  adjustments: number
  cancels: number
  reversals: number
  untouched: number
  skipped?: string
}

/**
 * Reconcile one invoice's commissions with what the plan says today.
 *
 * The writes are chunked rather than wrapped in one transaction: a run can touch
 * more rows than DynamoDB takes, the rows are independent of each other, and
 * every one of them is keyed deterministically — so a half-finished run is
 * finished by running it again, which is the same operation.
 */
async function runForInvoice(
  invoiceId: string,
  caller: Caller,
  source: CommissionRecord['source'],
): Promise<RunReport> {
  const empty: RunReport = { invoiceId, puts: 0, updates: 0, adjustments: 0, cancels: 0, reversals: 0, untouched: 0 }
  const context = await readCommissionContext(invoiceId)
  if (!context) return { ...empty, skipped: 'NO_INVOICE' }
  if (context.invoice.status === 'VOID') return { ...empty, skipped: 'VOID_INVOICE' }

  const settings = context.settings
  if (settings.commissionsEnabled !== true) return { ...empty, skipped: 'COMMISSIONS_OFF' }

  // INVOICE_PAID means exactly that: nothing is earned until the order settles.
  if (settings.commissionTrigger === 'INVOICE_PAID' && !context.order.paidAt && !context.invoice.paidAt) {
    return { ...empty, skipped: 'NOT_PAID_YET' }
  }

  const now = nowIso()
  const desired = computeCommissions(buildComputeContext(context, caller.email, now))
  const existing = await commissionsForInvoice(invoiceId)
  const plan = reconcileCommissions(existing, desired, { nowIso: now, caller: caller.email, source })

  const writes: TransactWriteItem[] = []
  for (const put of plan.puts) writes.push(putTx(COMMISSION_TABLE_NAME, rowFor(put, now)))
  for (const update of plan.updates) {
    writes.push(
      updateTx(COMMISSION_TABLE_NAME, update.existing.id, { ...update.patch, updatedAt: now }, {
        // The row may not move under us between the read and the write.
        condition: 'attribute_exists(id) AND version = :expectedVersion',
        extraValues: { ':expectedVersion': { N: String(update.existing.version ?? 1) } },
      }),
    )
  }
  for (const adjustment of plan.adjustments) {
    writes.push(putTx(COMMISSION_TABLE_NAME, { ...(adjustment as unknown as Row), __typename: 'Commission', createdAt: now, updatedAt: now }))
  }
  for (const reversal of plan.reversals) {
    writes.push(putTx(COMMISSION_TABLE_NAME, { ...(reversal as unknown as Row), __typename: 'Commission', createdAt: now, updatedAt: now }))
  }
  for (const cancel of plan.cancels) {
    writes.push(
      updateTx(
        COMMISSION_TABLE_NAME,
        cancel.existing.id,
        {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelReason: cancel.reason,
          netCents: 0,
          updatedAt: now,
          updatedBy: caller.email,
          version: (cancel.existing.version ?? 1) + 1,
        },
        {
          condition: 'attribute_exists(id) AND version = :expectedVersion',
          extraValues: { ':expectedVersion': { N: String(cancel.existing.version ?? 1) } },
        },
      ),
    )
  }

  for (let i = 0; i < writes.length; i += MAX_COMMISSION_BATCH) {
    await transact(writes.slice(i, i + MAX_COMMISSION_BATCH), 'commissions')
  }

  if (writes.length > 0) {
    await writeAudit('Commission', invoiceId, 'RUN_COMMISSIONS', caller, {
      puts: plan.puts.length,
      updates: plan.updates.length,
      adjustments: plan.adjustments.length,
      cancels: plan.cancels.length,
      reversals: plan.reversals.length,
    })
  }

  return {
    invoiceId,
    puts: plan.puts.length,
    updates: plan.updates.length,
    adjustments: plan.adjustments.length,
    cancels: plan.cancels.length,
    reversals: plan.reversals.length,
    untouched: plan.untouched.length,
  }
}

function rowFor(desired: DesiredCommission, now: string): Row {
  return { ...(desired.row as unknown as Row), __typename: 'Commission', createdAt: now, updatedAt: now }
}

export async function runCommissions(input: Row, caller: Caller): Promise<Row> {
  const settings = await getSettings()
  assertCommissionsOn(settings as unknown as TmsSettings)
  const invoiceId = optionalString(input.invoiceId, 200)
  const month = optionalString(input.month, 7)
  if (!invoiceId && !month) throw new Error('RUN_COMMISSIONS needs an invoiceId or a month')

  if (invoiceId) {
    const report = await runForInvoice(invoiceId, caller, 'RERUN')
    return { reports: [report] } as unknown as Row
  }

  // A month: every invoice the ledger already knows about, plus nothing else —
  // a month with no commission rows has never been run, and the invoice ids
  // come from the rows themselves.
  const rows = await commissionsForMonth(String(month))
  const invoiceIds = [...new Set(rows.map((row) => row.invoiceId).filter(Boolean))]
  const reports: RunReport[] = []
  for (const id of invoiceIds) reports.push(await runForInvoice(id, caller, 'RERUN'))
  return { reports } as unknown as Row
}

/**
 * The hook every money move calls after its own transaction has committed.
 *
 * Best-effort on purpose, exactly like the invoice PDF: a commission that failed
 * to recompute is fixed by the next run or by the page's Recompute button, and
 * is never a reason to fail the payment or the bill that actually moved money.
 */
export async function runCommissionsAfter(
  invoiceId: string | null | undefined,
  caller: Caller,
  source: CommissionRecord['source'],
): Promise<void> {
  if (!invoiceId || !COMMISSION_TABLE_NAME) return
  try {
    await runForInvoice(invoiceId, caller, source)
  } catch (err) {
    console.error('[tms-finance-actions] commission run failed for', invoiceId, String(err))
  }
}

/** The same hook keyed by order, for the paths that hold an order and not an invoice. */
export async function runCommissionsForOrder(
  orderId: string | null | undefined,
  caller: Caller,
  source: CommissionRecord['source'],
): Promise<void> {
  if (!orderId || !COMMISSION_TABLE_NAME) return
  try {
    const order = await getById(ORDER_TABLE_NAME, orderId)
    const invoiceId = typeof order?.invoiceId === 'string' ? order.invoiceId : null
    if (invoiceId) await runForInvoice(invoiceId, caller, source)
  } catch (err) {
    console.error('[tms-finance-actions] commission run failed for order', orderId, String(err))
  }
}

/** What `VOID_INVOICE` adds to its own transaction, so the two can never disagree. */
export async function commissionVoidWrites(
  invoiceId: string,
  caller: Caller,
  now: string,
): Promise<TransactWriteItem[]> {
  if (!COMMISSION_TABLE_NAME) return []
  const rows = await commissionsForInvoice(invoiceId)
  if (rows.length === 0) return []
  const { cancels, reversals } = reverseFor(rows, { nowIso: now, caller: caller.email, reason: 'INVOICE_VOIDED' })
  const writes: TransactWriteItem[] = []
  for (const cancel of cancels) {
    writes.push(
      // The status is part of the condition: if somebody approves this row
      // between the read above and the transaction below, the void aborts and is
      // retried against fresh rows rather than quietly rewriting a liability
      // that should have been reversed.
      withStatusName(
        updateTx(
          COMMISSION_TABLE_NAME,
          cancel.existing.id,
          {
            status: 'CANCELLED',
            cancelledAt: now,
            cancelReason: cancel.reason,
            netCents: 0,
            updatedAt: now,
            updatedBy: caller.email,
            version: (cancel.existing.version ?? 1) + 1,
          },
          {
            condition: 'attribute_exists(id) AND version = :expectedVersion AND #status = :expectedStatus',
            extraValues: {
              ':expectedVersion': { N: String(cancel.existing.version ?? 1) },
              ':expectedStatus': { S: String(cancel.existing.status ?? 'UN_APPROVED') },
            },
          },
        ),
      ),
    )
  }
  for (const reversal of reversals) {
    writes.push(putTx(COMMISSION_TABLE_NAME, { ...(reversal as unknown as Row), __typename: 'Commission', createdAt: now, updatedAt: now }))
  }
  return writes
}

// ── PREVIEW_COMMISSIONS ─────────────────────────────────────────────────────

/** What this order would pay, computed and thrown away. Nothing is written. */
export async function previewCommissions(input: Row): Promise<Row> {
  const orderId = assertString(input.orderId, 'orderId')
  const order = await getById(ORDER_TABLE_NAME, orderId)
  if (!order) throw new Error(`Order not found: ${orderId}`)
  const invoiceId = typeof order.invoiceId === 'string' ? order.invoiceId : ''
  if (!invoiceId) {
    return {
      rows: [],
      note: 'This order has not been invoiced yet, so there is no frozen money to pay a commission on.',
    } as unknown as Row
  }
  const context = await readCommissionContext(invoiceId)
  if (!context) return { rows: [], note: 'The invoice behind this order could not be read.' } as unknown as Row
  const desired = computeCommissions(buildComputeContext(context, 'preview', nowIso()))
  const existing = await commissionsForInvoice(invoiceId)
  return {
    rows: desired.map((d) => d.row),
    existing,
    enabled: context.settings.commissionsEnabled === true,
  } as unknown as Row
}

// ── the approval ladder ─────────────────────────────────────────────────────

/** The `#status` name every ladder write needs — `status` is a DynamoDB reserved word. */
function withStatusName(item: TransactWriteItem): TransactWriteItem {
  if (item.Update) {
    item.Update.ExpressionAttributeNames = { ...(item.Update.ExpressionAttributeNames ?? {}), '#status': 'status' }
  }
  return item
}

async function ladderWrite(
  row: CommissionRecord,
  patch: Row,
  caller: Caller,
  action: string,
  now: string,
): Promise<Row> {
  const item = withStatusName(
    updateTx(
      COMMISSION_TABLE_NAME,
      row.id,
      { ...patch, updatedAt: now, updatedBy: caller.email, version: (row.version ?? 1) + 1 },
      {
        condition: 'attribute_exists(id) AND version = :expectedVersion AND #status = :expectedStatus',
        extraValues: {
          ':expectedVersion': { N: String(row.version ?? 1) },
          ':expectedStatus': { S: String(row.status ?? 'UN_APPROVED') },
        },
      },
    ),
  )
  await transact([item], action.toLowerCase())
  await writeAudit('Commission', row.id, action, caller, patch)
  return { commission: await getById(COMMISSION_TABLE_NAME, row.id) } as unknown as Row
}

export async function approveCommission(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  const row = await getCommission(assertString(input.commissionId, 'commissionId'))
  const actor = commissionCallerOf(caller, settings)
  if (!commissionState(row, actor).canApprove) {
    throw new Error(`Forbidden: ${row.status ?? 'this row'} cannot be approved by you`)
  }
  const now = nowIso()
  // A manager's approval is the first rung; an admin's closes it outright, since
  // there is nobody above them to ask.
  const status: CommissionStatus = actor.isAdmin ? 'FULLY_APPROVED' : 'MANAGER_APPROVED'
  return ladderWrite(
    row,
    {
      status,
      approvedAt: now,
      approvedBy: caller.email,
      netCents: netCentsOf(row),
      events: appendEvent(row.events, { at: now, by: caller.email, action: 'APPROVED', amountCents: netCentsOf(row) }),
    },
    caller,
    'APPROVE_COMMISSION',
    now,
  )
}

export async function counterCommission(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  const row = await getCommission(assertString(input.commissionId, 'commissionId'))
  const actor = commissionCallerOf(caller, settings)
  const state = commissionState(row, actor)
  if (!state.canCounter) throw new Error('Forbidden: you cannot counter this row')
  const amountCents = optionalInteger(input.amountCents, { min: -100_000_000, max: 100_000_000, label: 'amountCents' })
  if (amountCents == null) throw new Error('A counter needs an amount')
  const note = optionalString(input.note, 2000)
  const now = nowIso()
  // Whoever countered decides which side has to answer next.
  const status: CommissionStatus = state.isOwnRow ? 'REP_COUNTERED' : 'MANAGER_COUNTERED'
  return ladderWrite(
    row,
    {
      status,
      counterCents: amountCents,
      counterBy: caller.email,
      counterNote: note,
      events: appendEvent(row.events, { at: now, by: caller.email, action: 'COUNTERED', note, amountCents }),
    },
    caller,
    'COUNTER_COMMISSION',
    now,
  )
}

export async function acceptCommissionCounter(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  const row = await getCommission(assertString(input.commissionId, 'commissionId'))
  const actor = commissionCallerOf(caller, settings)
  if (!commissionState(row, actor).canAcceptCounter) {
    throw new Error('Forbidden: the other side has to answer this counter')
  }
  const now = nowIso()
  const agreed = row.counterCents != null ? Math.trunc(row.counterCents) : netCentsOf(row)
  return ladderWrite(
    row,
    {
      status: 'FULLY_APPROVED',
      approvedAt: now,
      approvedBy: caller.email,
      netCents: agreed,
      events: appendEvent(row.events, { at: now, by: caller.email, action: 'COUNTER_ACCEPTED', amountCents: agreed }),
    },
    caller,
    'ACCEPT_COMMISSION_COUNTER',
    now,
  )
}

export async function overrideCommission(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  const row = await getCommission(assertString(input.commissionId, 'commissionId'))
  const actor = commissionCallerOf(caller, settings)
  if (!commissionState(row, actor).canOverride) throw new Error('Forbidden: you cannot override this row')
  const amountCents = optionalInteger(input.amountCents, { min: -100_000_000, max: 100_000_000, label: 'amountCents' })
  if (amountCents == null) throw new Error('An override needs an amount')
  const note = optionalString(input.note, 2000)
  if (!note) throw new Error('An override needs a note saying why')
  const now = nowIso()
  // The computed number is kept: `amountCents` is what the plan says, and the
  // override rides beside it so the arithmetic stays visible.
  return ladderWrite(
    row,
    {
      overrideCents: amountCents,
      overrideBy: caller.email,
      overrideNote: note,
      netCents: amountCents,
      source: 'OVERRIDE',
      events: appendEvent(row.events, { at: now, by: caller.email, action: 'OVERRIDDEN', note, amountCents }),
    },
    caller,
    'OVERRIDE_COMMISSION',
    now,
  )
}

export async function cancelCommission(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  const row = await getCommission(assertString(input.commissionId, 'commissionId'))
  const actor = commissionCallerOf(caller, settings)
  if (!commissionState(row, actor).canCancel) throw new Error('Forbidden: you cannot cancel this row')
  const reason = optionalString(input.reason, 2000)
  if (!reason) throw new Error('Cancelling a commission needs a reason')
  const now = nowIso()
  return ladderWrite(
    row,
    {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelReason: reason,
      netCents: 0,
      events: appendEvent(row.events, { at: now, by: caller.email, action: 'CANCELLED', note: reason }),
    },
    caller,
    'CANCEL_COMMISSION',
    now,
  )
}

// ── pay periods ─────────────────────────────────────────────────────────────

function scheduleOf(settings: TmsSettings): CommissionPaySchedule {
  return (settings.commissionPaySchedule as CommissionPaySchedule | null) ?? {
    frequency: 'SEMI_MONTHLY',
    payDay: null,
    daysUntilPay: 7,
    anchorDate: null,
  }
}

export async function openPayPeriod(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  assertCommissionsOn(settings)
  assertMayPay(caller, settings)
  const asOf = optionalString(input.periodStart, 10) ?? nowIso().slice(0, 10)
  const window = periodWindow(scheduleOf(settings), asOf)
  const id = payPeriodIdFor(window.periodStart)
  const existing = await getById(COMMISSION_PAY_PERIOD_TABLE_NAME, id)
  if (existing) return { payPeriod: existing } as unknown as Row

  const now = nowIso()
  await transact(
    [
      putTx(COMMISSION_PAY_PERIOD_TABLE_NAME, {
        id,
        __typename: 'CommissionPayPeriod',
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        payDate: window.payDate,
        status: 'OPEN',
        commissionCount: 0,
        totalCents: 0,
        byRep: [],
        createdBy: caller.email,
        updatedBy: caller.email,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    'pay period',
  )
  await writeAudit('CommissionPayPeriod', id, 'OPEN_PAY_PERIOD', caller, { ...window })
  return { payPeriod: await getById(COMMISSION_PAY_PERIOD_TABLE_NAME, id) } as unknown as Row
}

async function readPeriod(id: string): Promise<Row> {
  const row = await getById(COMMISSION_PAY_PERIOD_TABLE_NAME, id)
  if (!row) throw new Error(`Pay period not found: ${id}`)
  return row
}

/** The `n` 'YYYY-MM' keys before the month `day` falls in, newest first. */
function priorMonths(day: string, n: number): string[] {
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7))
  const out: string[] = []
  for (let i = 1; i <= n; i += 1) {
    out.push(new Date(Date.UTC(year, month - 1 - i, 1)).toISOString().slice(0, 7))
  }
  return out
}

/**
 * Stamp every fully-approved row whose trigger falls inside the window onto the
 * period. Rows are claimed one batch at a time, each conditioned on still being
 * FULLY_APPROVED and still unclaimed, so two submits cannot pay a row twice.
 */
export async function submitPayPeriod(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  assertCommissionsOn(settings)
  assertMayPay(caller, settings)
  const id = assertString(input.payPeriodId, 'payPeriodId')
  const period = await readPeriod(id)
  if (period.status !== 'OPEN') throw new Error(`This pay period is ${String(period.status)}, not open`)

  const periodStart = String(period.periodStart)
  const periodEnd = String(period.periodEnd)
  /*
   * The period's own months, plus the three before them: an adjustment written
   * against a closed period carries the month it was computed in, and a reversal
   * of a stale row can be older still. Three months is the sweep's bound — far
   * enough back for a late carrier bill, short enough that a submit stays cheap.
   */
  const months = [...new Set([periodStart.slice(0, 7), periodEnd.slice(0, 7), ...priorMonths(periodStart, 3)])]
  const candidates: CommissionRecord[] = []
  for (const month of months) candidates.push(...(await commissionsForMonth(month)))

  /*
   * Everything approved and unclaimed whose trigger is on or before the period
   * ends — not only what falls inside its window. An adjustment or a reversal
   * computed after an earlier period was paid lands in the current one and is
   * netted off there; without the sweep it would sit FULLY_APPROVED forever and
   * a rep would keep an overpayment.
   *
   * A row this period already stamped is re-counted (not re-written) so a retry
   * after a half-finished submit totals the period over everything it holds.
   */
  const claimed = candidates.filter(
    (row) =>
      row.status === 'FULLY_APPROVED' &&
      (!row.payPeriodId || row.payPeriodId === id) &&
      row.triggerAt.slice(0, 10) <= periodEnd,
  )

  const now = nowIso()
  const writes = claimed
    .filter((row) => !row.payPeriodId)
    .map((row) =>
      withStatusName(
        updateTx(
          COMMISSION_TABLE_NAME,
          row.id,
          { payPeriodId: id, updatedAt: now, updatedBy: caller.email, version: (row.version ?? 1) + 1 },
          {
            condition: `#status = :approved AND ${'(attribute_not_exists(payPeriodId) OR attribute_type(payPeriodId, :nullType))'}`,
            extraValues: { ':approved': { S: 'FULLY_APPROVED' }, ':nullType': { S: 'NULL' } },
          },
        ),
      ),
    )
  for (let i = 0; i < writes.length; i += MAX_COMMISSION_BATCH) {
    await transact(writes.slice(i, i + MAX_COMMISSION_BATCH), 'pay period rows')
  }

  const totals = payPeriodTotals(claimed)
  await transact(
    [
      updateTx(
        COMMISSION_PAY_PERIOD_TABLE_NAME,
        id,
        {
          status: 'PENDING_APPROVAL',
          commissionCount: totals.commissionCount,
          totalCents: totals.totalCents,
          byRep: totals.byRep,
          submittedAt: now,
          submittedBy: caller.email,
          updatedAt: now,
          updatedBy: caller.email,
          version: (numberOrNull(period.version) ?? 1) + 1,
        },
        {
          condition: 'attribute_exists(id) AND version = :expectedVersion',
          extraValues: { ':expectedVersion': { N: String(numberOrNull(period.version) ?? 1) } },
        },
      ),
    ],
    'pay period submit',
  )
  await writeAudit('CommissionPayPeriod', id, 'SUBMIT_PAY_PERIOD', caller, { ...totals })
  return { payPeriod: await readPeriod(id), claimed: claimed.length } as unknown as Row
}

export async function approvePayPeriod(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  assertMayPay(caller, settings)
  const id = assertString(input.payPeriodId, 'payPeriodId')
  const period = await readPeriod(id)
  if (period.status !== 'PENDING_APPROVAL') {
    throw new Error(`This pay period is ${String(period.status)} — only a submitted period can be approved`)
  }
  const now = nowIso()
  await transact(
    [
      updateTx(
        COMMISSION_PAY_PERIOD_TABLE_NAME,
        id,
        {
          status: 'APPROVED',
          approvedAt: now,
          approvedBy: caller.email,
          updatedAt: now,
          updatedBy: caller.email,
          version: (numberOrNull(period.version) ?? 1) + 1,
        },
        {
          condition: 'attribute_exists(id) AND version = :expectedVersion',
          extraValues: { ':expectedVersion': { N: String(numberOrNull(period.version) ?? 1) } },
        },
      ),
    ],
    'pay period approval',
  )
  await writeAudit('CommissionPayPeriod', id, 'APPROVE_PAY_PERIOD', caller, { approvedAt: now })
  return { payPeriod: await readPeriod(id) } as unknown as Row
}

/**
 * Record that the period was paid. No money leaves this stack — there is no bank
 * path here and there never was: a PAID period is the note that payroll ran,
 * carrying the reference somebody can look up.
 */
export async function payPayPeriod(input: Row, caller: Caller): Promise<Row> {
  const settings = (await getSettings()) as unknown as TmsSettings
  assertMayPay(caller, settings)
  const id = assertString(input.payPeriodId, 'payPeriodId')
  const reference = optionalString(input.reference, 200)
  if (!reference) throw new Error('Paying a period needs the payroll reference it was paid under')
  const period = await readPeriod(id)
  if (period.status !== 'APPROVED') {
    throw new Error(`This pay period is ${String(period.status)} — only an approved period can be paid`)
  }
  const paidAt = optionalString(input.paidAt, 40) ?? nowIso()
  const now = nowIso()

  const rows = await commissionsForPeriod(id)
  const payable = rows.filter((row) => row.status === 'FULLY_APPROVED')
  const writes = payable.map((row) =>
    withStatusName(
      updateTx(
        COMMISSION_TABLE_NAME,
        row.id,
        {
          status: 'PAID',
          paidAt,
          paymentRef: reference,
          updatedAt: now,
          updatedBy: caller.email,
          version: (row.version ?? 1) + 1,
          events: appendEvent(row.events, { at: now, by: caller.email, action: 'PAID', note: reference }),
        },
        {
          // Every row is conditioned: a row that moved since the period was
          // approved aborts its batch rather than being paid on stale numbers.
          condition: '#status = :approved AND payPeriodId = :period',
          extraValues: { ':approved': { S: 'FULLY_APPROVED' }, ':period': { S: id } },
        },
      ),
    ),
  )
  for (let i = 0; i < writes.length; i += MAX_COMMISSION_BATCH) {
    await transact(writes.slice(i, i + MAX_COMMISSION_BATCH), 'pay period payment')
  }

  await transact(
    [
      updateTx(
        COMMISSION_PAY_PERIOD_TABLE_NAME,
        id,
        {
          status: 'PAID',
          paidAt,
          paidBy: caller.email,
          paymentRef: reference,
          updatedAt: now,
          updatedBy: caller.email,
          version: (numberOrNull(period.version) ?? 1) + 1,
        },
        {
          condition: 'attribute_exists(id) AND version = :expectedVersion',
          extraValues: { ':expectedVersion': { N: String(numberOrNull(period.version) ?? 1) } },
        },
      ),
    ],
    'pay period paid',
  )
  await writeAudit('CommissionPayPeriod', id, 'PAY_PAY_PERIOD', caller, { paidAt, reference, rows: payable.length })
  return { payPeriod: await readPeriod(id), paid: payable.length } as unknown as Row
}

// ── SAVE_COMMISSION_SETTINGS ────────────────────────────────────────────────

/**
 * The commissions half of the settings singleton. Validated here so a plan that
 * the engine could not act on is refused in words, at save time, instead of
 * quietly producing a wrong number on the next invoice.
 */
export async function saveCommissionSettings(input: Row, caller: Caller): Promise<Row> {
  const patch: Row = {}
  if ('commissionsEnabled' in input) patch.commissionsEnabled = input.commissionsEnabled === true
  if ('commissionTrigger' in input) {
    const trigger = optionalString(input.commissionTrigger, 40)
    if (trigger && trigger !== 'GENERATE_INVOICE' && trigger !== 'INVOICE_PAID') {
      throw new Error('commissionTrigger must be GENERATE_INVOICE or INVOICE_PAID')
    }
    patch.commissionTrigger = trigger
  }
  if ('commissionPlans' in input) patch.commissionPlans = validateCommissionPlans(input.commissionPlans)
  if ('commissionPaySchedule' in input) patch.commissionPaySchedule = validatePaySchedule(input.commissionPaySchedule)
  if ('commissionApprovalAdminOnly' in input) patch.commissionApprovalAdminOnly = input.commissionApprovalAdminOnly === true
  if ('commissionPayAdminOnly' in input) patch.commissionPayAdminOnly = input.commissionPayAdminOnly === true
  if (Object.keys(patch).length === 0) throw new Error('Nothing to save')

  const now = nowIso()
  // The settings singleton is created by the directory router; patched here,
  // seeding `__typename` the way every counter write on this row already does so
  // a row written before the directory ever saved it still reads back as one.
  await transact(
    [
      updateTx(SETTINGS_TABLE_NAME, SETTINGS_ID, {
        ...patch,
        __typename: 'TmsSettings',
        updatedAt: now,
        updatedBy: caller.email,
      }),
    ],
    'commission settings',
  )
  await writeAudit('TmsSettings', SETTINGS_ID, 'SAVE_COMMISSION_SETTINGS', caller, patch)
  return { settings: await getById(SETTINGS_TABLE_NAME, SETTINGS_ID) } as unknown as Row
}

// ── RENDER_COMMISSION_STATEMENT ─────────────────────────────────────────────

/**
 * One rep's statement for one period: what they earned, on which shipments, and
 * what the period paid. Rendered on demand and stored beside the invoices, so a
 * rep who asks "what was this?" gets the same answer the ledger holds.
 */
export async function renderCommissionStatement(input: Row, caller: Caller): Promise<Row> {
  const payPeriodId = assertString(input.payPeriodId, 'payPeriodId')
  const repId = assertString(input.repId, 'repId')
  const period = await readPeriod(payPeriodId)
  const rows = (await commissionsForPeriod(payPeriodId)).filter(
    (row) => row.repId.toLowerCase() === repId.toLowerCase() && row.status !== 'CANCELLED',
  )
  if (rows.length === 0) throw new Error('That rep has nothing on this pay period')

  const bytes = await buildStatementPdf({
    repId,
    repName: rows[0].repName ?? repId,
    periodStart: String(period.periodStart),
    periodEnd: String(period.periodEnd),
    payDate: String(period.payDate),
    status: String(period.status ?? 'OPEN'),
    rows,
  })
  const key = commissionStatementKey(repId, payPeriodId)
  await putPdf(key, bytes)

  const byRep = Array.isArray(period.byRep) ? (period.byRep as Record<string, unknown>[]) : []
  const updatedByRep = byRep.map((entry) =>
    String(entry.repId ?? '').toLowerCase() === repId.toLowerCase() ? { ...entry, statementKey: key } : entry,
  )
  const now = nowIso()
  await transact(
    [
      updateTx(COMMISSION_PAY_PERIOD_TABLE_NAME, payPeriodId, {
        byRep: updatedByRep,
        updatedAt: now,
        updatedBy: caller.email,
      }),
    ],
    'commission statement',
  )
  return { key, url: await signedDownload(key), payPeriodId, repId } as unknown as Row
}

/** `commissions/{repId}/{periodId}.pdf` — the row and its bytes name each other. */
function commissionStatementKey(repId: string, payPeriodId: string): string {
  const safeRep = repId.replace(/[^A-Za-z0-9._@-]/g, '_')
  const safePeriod = payPeriodId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `commissions/${safeRep}/${safePeriod}.pdf`
}

interface StatementInput {
  repId: string
  repName: string
  periodStart: string
  periodEnd: string
  payDate: string
  status: string
  rows: CommissionRecord[]
}

async function buildStatementPdf(input: StatementInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const body = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  let page = pdf.addPage([612, 792])
  const ink = rgb(0.1, 0.12, 0.15)
  const muted = rgb(0.42, 0.45, 0.5)
  let y = 742

  const write = (text: string, x: number, size: number, font = body, color = ink) => {
    page.drawText(text.replace(/[^\x20-\x7E]/g, '?'), { x, y, size, font, color })
  }

  write('Commission statement', 48, 18, bold)
  y -= 22
  write(`${input.repName} (${input.repId})`, 48, 11, body, muted)
  y -= 14
  write(`Period ${input.periodStart} to ${input.periodEnd} · pay date ${input.payDate} · ${input.status}`, 48, 10, body, muted)
  y -= 26

  write('Shipment', 48, 9, bold)
  write('Customer', 140, 9, bold)
  write('Role', 300, 9, bold)
  write('Basis', 410, 9, bold)
  write('Amount', 500, 9, bold)
  y -= 4
  page.drawLine({ start: { x: 48, y }, end: { x: 564, y }, thickness: 0.6, color: muted })
  y -= 14

  let total = 0
  for (const row of input.rows) {
    if (y < 80) {
      page = pdf.addPage([612, 792])
      y = 742
    }
    const amount = row.netCents != null ? row.netCents : netCentsOf(row)
    total += amount
    write(row.shipmentNumber ?? row.orderId.slice(0, 12), 48, 9)
    write((row.customerName ?? '').slice(0, 26), 140, 9)
    write(`${row.roleName}${row.kind && row.kind !== 'EARNED' ? ` (${row.kind})` : ''}`, 300, 8)
    write(dollars(row.basisCents), 410, 9)
    write(dollars(amount), 500, 9)
    y -= 14
  }

  y -= 6
  page.drawLine({ start: { x: 48, y }, end: { x: 564, y }, thickness: 0.6, color: muted })
  y -= 16
  write(`${input.rows.length} commission${input.rows.length === 1 ? '' : 's'}`, 48, 10, bold)
  write(dollars(total), 500, 10, bold)
  y -= 28
  write('This statement records what the ledger owes. Payment is made through payroll.', 48, 8, body, muted)

  return pdf.save()
}

function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

export { COMMISSIONS_PAGE_GROUP }
