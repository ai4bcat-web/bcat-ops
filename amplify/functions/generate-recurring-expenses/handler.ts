/**
 * generate-recurring-expenses Lambda
 *
 * Invocation modes:
 *   EventBridge cron (1st of month): generates ExpenseRecords for current month
 *   { backfillStart: "2026-01", backfillEnd: "2026-05" }: generates for each month in range
 *   { action: "seed" }: idempotently creates base ExpenseType / Allocation / RecurringExpense records
 *
 * Idempotent: uses deterministic IDs + attribute_not_exists(id) condition.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { createHash } from 'crypto'

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const EXPENSE_TYPE_TABLE   = process.env.EXPENSE_TYPE_TABLE_NAME!
const ALLOCATION_TABLE     = process.env.ALLOCATION_TABLE_NAME!
const RECURRING_TABLE      = process.env.RECURRING_TABLE_NAME!
const EXPENSE_RECORD_TABLE = process.env.EXPENSE_RECORD_TABLE_NAME!

// ── Stable seed IDs ───────────────────────────────────────────────────────────

const SEED_TYPE_DIESEL     = 'bcat-seed-type-diesel-fuel'
const SEED_TYPE_INSURANCE  = 'bcat-seed-type-liability-insurance'
const SEED_ALLOC_INSURANCE = 'bcat-seed-alloc-insurance-all-trucks'
const SEED_RECURRING_INS   = 'bcat-seed-recurring-liability-insurance'

// Active trucks with fuel cards (009, 299, 530, 685, 780)
const ALL_TRUCK_IDS = [
  'eq-mnmpi9jxwd12',
  'eq-mnevxuyoxpd8',
  'eq-mnevuhxgs5jf',
  'eq-mnevvq8q6tcx',
  'eq-mnevwst30vwt',
]

// ── Month helpers ─────────────────────────────────────────────────────────────

function currentMonth(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthsInRange(start: string, end: string): string[] {
  const months: string[] = []
  let [y, m] = start.split('-').map(Number)
  const [ey, em] = end.split('-').map(Number)
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return months
}

// ── Conditional put helper (idempotent) ───────────────────────────────────────

async function putIfNotExists(table: string, item: Record<string, unknown>): Promise<'created' | 'exists'> {
  try {
    await dynamo.send(new PutCommand({
      TableName: table,
      ConditionExpression: 'attribute_not_exists(id)',
      Item: item,
    }))
    return 'created'
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'exists'
    throw err
  }
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function seedExpenseData() {
  const now   = new Date().toISOString()
  const month = currentMonth()

  const ops = [
    putIfNotExists(EXPENSE_TYPE_TABLE, {
      __typename: 'ExpenseType',
      id: SEED_TYPE_DIESEL,
      name: 'Diesel Fuel',
      category: 'FUEL',
      defaultEntryMethod: 'AUTO_INGESTED',
      active: true,
      createdAt: now, updatedAt: now,
    }),
    putIfNotExists(EXPENSE_TYPE_TABLE, {
      __typename: 'ExpenseType',
      id: SEED_TYPE_INSURANCE,
      name: 'Liability Insurance',
      category: 'INSURANCE',
      defaultEntryMethod: 'FIXED',
      active: true,
      createdAt: now, updatedAt: now,
    }),
    putIfNotExists(ALLOCATION_TABLE, {
      __typename: 'TruckExpenseAllocation',
      id: SEED_ALLOC_INSURANCE,
      expenseTypeId: SEED_TYPE_INSURANCE,
      allocationMethod: 'SPLIT_EVEN',
      truckIds: ALL_TRUCK_IDS,
      notes: 'Liability insurance — split evenly across all 5 active trucks',
      createdAt: now, updatedAt: now,
    }),
    putIfNotExists(RECURRING_TABLE, {
      __typename: 'RecurringExpense',
      id: SEED_RECURRING_INS,
      expenseTypeId: SEED_TYPE_INSURANCE,
      allocationId: SEED_ALLOC_INSURANCE,
      monthlyAmount: 1000,    // placeholder — edit in console to actual premium
      startMonth: month,
      endMonth: null,
      active: true,
      notes: 'Monthly liability insurance. Update monthlyAmount to actual premium.',
      createdAt: now, updatedAt: now,
    }),
  ]

  const results = await Promise.allSettled(ops)
  let seeded = 0, skipped = 0
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value === 'created') seeded++
      else skipped++
    }
  }
  console.log(`[seed] seeded=${seeded} skipped=${skipped}`)
  return { seeded, skipped }
}

// ── Recurring generation ──────────────────────────────────────────────────────

interface RecurringExpenseRow {
  id:            string
  expenseTypeId: string
  allocationId:  string
  monthlyAmount: number
  startMonth:    string
  endMonth?:     string | null
  active:        boolean
}

async function loadActiveRecurring(): Promise<RecurringExpenseRow[]> {
  const rows: RecurringExpenseRow[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const res = await dynamo.send(new ScanCommand({
      TableName: RECURRING_TABLE,
      FilterExpression: '#a = :t',
      ExpressionAttributeNames: { '#a': 'active' },
      ExpressionAttributeValues: { ':t': true },
      ExclusiveStartKey: lastKey,
    }))
    for (const item of res.Items ?? []) {
      rows.push(item as RecurringExpenseRow)
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastKey)

  return rows
}

async function generateForMonths(months: string[]) {
  /*
   * Nothing is written. The expense engine (src/lib/expenseAllocation.ts,
   * expandRecurringToRecords) projects every active template into its months on read,
   * day-prorated by the template's effective dates - so a stored copy of the same month
   * would be counted twice. This ran every month since June and failed every time on a
   * null index key, which is the only reason it never double-counted. Templates are the
   * record; the sweep stays as a count for the log.
   */
  const recurring = await loadActiveRecurring()
  const skipped = recurring.length * months.length
  console.log(`[recurring] ${recurring.length} active templates; projected on read, nothing generated (skipped=${skipped})`)
  return { created: 0, skipped, errors: 0 }
}

// ── Handler ───────────────────────────────────────────────────────────────────

interface LambdaEvent {
  action?:        'seed'
  backfillStart?: string   // "2026-01"
  backfillEnd?:   string   // "2026-05"
}

export const handler = async (event: LambdaEvent = {}) => {
  console.log('[generate-recurring-expenses] invoked', JSON.stringify(event))

  if (event.action === 'seed') {
    const result = await seedExpenseData()
    return { ok: true, ...result }
  }

  const months = (event.backfillStart && event.backfillEnd)
    ? monthsInRange(event.backfillStart, event.backfillEnd)
    : [currentMonth()]

  console.log('[recurring] target months:', months)
  const result = await generateForMonths(months)
  return { ok: true, ...result }
}
