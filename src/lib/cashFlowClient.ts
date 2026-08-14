// Data-access layer for the standalone Cash Flow page (CashFlowInputs + CashFlowWeekLog).
// Mirrors the raw-graphql `gql` pattern used in insuranceClient.ts. Hooks in src/hooks/
// call this; components never talk to the client directly.
//
// STANDALONE: these two tables belong to the Cash Flow page alone. Nothing here touches
// loads, invoices, expenses or any other BCAT Ops model.
import { generateClient } from 'aws-amplify/data'
import type { CashFlowInputs } from './cashFlow'

const client = generateClient()

type GraphQLResult<T> = { data: T }
type GqlOptions = Parameters<typeof client.graphql>[0]

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const result = (await client.graphql({ query, variables } as unknown as GqlOptions)) as GraphQLResult<T>
  return result.data
}

/**
 * True when the failure is "this model isn't in the deployed schema yet" rather than a
 * real error. The Cash Flow tables ship with a backend deploy; until that lands the page
 * should say so plainly instead of throwing a wall of GraphQL at the user.
 */
export function isSchemaMissingError(err: unknown): boolean {
  const s = typeof err === 'string' ? err : JSON.stringify(err ?? '')
  return /Cannot query field|Unknown type|ValidationException/i.test(s)
}

export interface CashFlowInputsRecord extends CashFlowInputs {
  id: string
  isCurrent: boolean
  notes?: string | null
  createdAt: string
  updatedAt: string
}

export interface CashFlowWeekRow {
  id: string
  weekOf: string
  totalCashCents: number
  ar30Cents: number
  ar120Cents: number
  totalPayablesCents: number
  projectedLowCents: number
  projectedEndingCents: number
  /** Months of runway that week. null = not burning — distinct from 0. */
  runwayMonths?: number | null
  notes?: string | null
  createdAt: string
  updatedAt: string
}

const INPUT_FIELDS = `
  id weekOf isCurrent
  cashBcatCents cashIvanCents
  ar30Cents ar120Cents ar120CollectionRate
  apBcatAgingCents apBcatExpectedCents apBcatAmexCents apIvanCcCents apIvanMiscCents
  recurringRevenueCents recurringExpensesCents payablesSpreadMonths minCashThresholdCents
  notes createdAt updatedAt
`

const LOG_FIELDS = `
  id weekOf totalCashCents ar30Cents ar120Cents totalPayablesCents
  projectedLowCents projectedEndingCents runwayMonths notes createdAt updatedAt
`

/* ── Inputs ─────────────────────────────────────────────────────────────────── */

export async function listCashFlowInputs(): Promise<CashFlowInputsRecord[]> {
  const data = await gql<{ listCashFlowInputs: { items: CashFlowInputsRecord[] } }>(
    `query { listCashFlowInputs(limit: 200) { items { ${INPUT_FIELDS} } } }`,
  )
  return data.listCashFlowInputs.items ?? []
}

/** The row the page edits — the flagged current one, else the most recently updated. */
export async function getCurrentCashFlowInputs(): Promise<CashFlowInputsRecord | null> {
  const items = await listCashFlowInputs()
  if (items.length === 0) return null
  return (
    items.find((i) => i.isCurrent) ??
    [...items].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
  )
}

type InputPayload = Omit<CashFlowInputsRecord, 'id' | 'createdAt' | 'updatedAt' | 'isCurrent'>

export async function createCashFlowInputs(input: InputPayload): Promise<CashFlowInputsRecord> {
  const data = await gql<{ createCashFlowInputs: CashFlowInputsRecord }>(
    `mutation Create($input: CreateCashFlowInputsInput!) {
       createCashFlowInputs(input: $input) { ${INPUT_FIELDS} }
     }`,
    { input: { ...input, isCurrent: true } },
  )
  return data.createCashFlowInputs
}

export async function updateCashFlowInputs(id: string, patch: Partial<InputPayload>): Promise<CashFlowInputsRecord> {
  const data = await gql<{ updateCashFlowInputs: CashFlowInputsRecord }>(
    `mutation Update($input: UpdateCashFlowInputsInput!) {
       updateCashFlowInputs(input: $input) { ${INPUT_FIELDS} }
     }`,
    { input: { id, ...patch } },
  )
  return data.updateCashFlowInputs
}

/* ── Weekly log ─────────────────────────────────────────────────────────────── */

export async function listCashFlowWeeks(): Promise<CashFlowWeekRow[]> {
  const data = await gql<{ listCashFlowWeekLogs: { items: CashFlowWeekRow[] } }>(
    `query { listCashFlowWeekLogs(limit: 500) { items { ${LOG_FIELDS} } } }`,
  )
  // Oldest → newest so the trend chart reads left-to-right in time.
  return (data.listCashFlowWeekLogs.items ?? []).sort((a, b) => a.weekOf.localeCompare(b.weekOf))
}

export async function createCashFlowWeek(
  row: Omit<CashFlowWeekRow, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<CashFlowWeekRow> {
  const data = await gql<{ createCashFlowWeekLog: CashFlowWeekRow }>(
    `mutation Create($input: CreateCashFlowWeekLogInput!) {
       createCashFlowWeekLog(input: $input) { ${LOG_FIELDS} }
     }`,
    { input: row },
  )
  return data.createCashFlowWeekLog
}

export async function deleteCashFlowWeek(id: string): Promise<void> {
  await gql(
    `mutation Delete($input: DeleteCashFlowWeekLogInput!) {
       deleteCashFlowWeekLog(input: $input) { id }
     }`,
    { input: { id } },
  )
}
