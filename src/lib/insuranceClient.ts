// Data-access layer for fleet insurance (InsurancePeriod + InsuranceLineItem).
// Mirrors the raw-graphql `gql` pattern used in complianceClient.ts. Hooks in
// src/hooks/ call this; components never talk to the client directly.
import { generateClient } from 'aws-amplify/data'

const client = generateClient()

type GraphQLResult<T> = { data: T }
type GqlOptions = Parameters<typeof client.graphql>[0]

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const result = (await client.graphql({ query, variables } as unknown as GqlOptions)) as GraphQLResult<T>
  return result.data
}

export type InsuranceKind = 'TRUCK' | 'TRAILER' | 'WORKMANS_COMP'

export interface InsurancePeriod {
  id: string
  label: string
  startDate?: string | null
  endDate?: string | null
  isCurrent?: boolean | null
  notes?: string | null
  createdAt: string
  updatedAt: string
}

export interface InsuranceLineItem {
  id: string
  periodId: string
  kind: InsuranceKind
  equipmentId?: string | null
  unitNumber?: string | null
  annualCents: number
  notes?: string | null
  createdAt: string
  updatedAt: string
}

const PERIOD_FIELDS = `id label startDate endDate isCurrent notes createdAt updatedAt`
const ITEM_FIELDS = `id periodId kind equipmentId unitNumber annualCents notes createdAt updatedAt`

// ── Periods ─────────────────────────────────────────────────────────────────────

export async function listInsurancePeriods(): Promise<InsurancePeriod[]> {
  const data = await gql<{ listInsurancePeriods: { items: InsurancePeriod[] } }>(
    `query { listInsurancePeriods(limit: 1000) { items { ${PERIOD_FIELDS} } } }`,
  )
  return data.listInsurancePeriods.items ?? []
}

export async function createInsurancePeriod(input: {
  label: string
  startDate?: string | null
  endDate?: string | null
  isCurrent?: boolean
  notes?: string | null
}): Promise<InsurancePeriod> {
  const data = await gql<{ createInsurancePeriod: InsurancePeriod }>(
    `mutation ($input: CreateInsurancePeriodInput!) { createInsurancePeriod(input: $input) { ${PERIOD_FIELDS} } }`,
    { input },
  )
  return data.createInsurancePeriod
}

export async function updateInsurancePeriod(
  id: string,
  patch: Partial<Pick<InsurancePeriod, 'label' | 'startDate' | 'endDate' | 'isCurrent' | 'notes'>>,
): Promise<void> {
  await gql(
    `mutation ($input: UpdateInsurancePeriodInput!) { updateInsurancePeriod(input: $input) { id } }`,
    { input: { id, ...patch } },
  )
}

export async function deleteInsurancePeriod(id: string): Promise<void> {
  await gql(`mutation ($input: DeleteInsurancePeriodInput!) { deleteInsurancePeriod(input: $input) { id } }`, {
    input: { id },
  })
}

/** Mark exactly one period current — clears the flag on every other period. */
export async function setCurrentPeriod(id: string, periods: InsurancePeriod[]): Promise<void> {
  await Promise.all(
    periods.map((p) =>
      p.isCurrent === (p.id === id) ? Promise.resolve() : updateInsurancePeriod(p.id, { isCurrent: p.id === id }),
    ),
  )
}

// ── Line items ────────────────────────────────────────────────────────────────

export async function listInsuranceLineItems(): Promise<InsuranceLineItem[]> {
  const data = await gql<{ listInsuranceLineItems: { items: InsuranceLineItem[] } }>(
    `query { listInsuranceLineItems(limit: 5000) { items { ${ITEM_FIELDS} } } }`,
  )
  return data.listInsuranceLineItems.items ?? []
}

export async function createInsuranceLineItem(input: {
  periodId: string
  kind: InsuranceKind
  equipmentId?: string | null
  unitNumber?: string | null
  annualCents: number
  notes?: string | null
}): Promise<InsuranceLineItem> {
  const data = await gql<{ createInsuranceLineItem: InsuranceLineItem }>(
    `mutation ($input: CreateInsuranceLineItemInput!) { createInsuranceLineItem(input: $input) { ${ITEM_FIELDS} } }`,
    { input },
  )
  return data.createInsuranceLineItem
}

export async function updateInsuranceLineItem(
  id: string,
  patch: Partial<Pick<InsuranceLineItem, 'annualCents' | 'notes' | 'unitNumber'>>,
): Promise<void> {
  await gql(
    `mutation ($input: UpdateInsuranceLineItemInput!) { updateInsuranceLineItem(input: $input) { id } }`,
    { input: { id, ...patch } },
  )
}

export async function deleteInsuranceLineItem(id: string): Promise<void> {
  await gql(`mutation ($input: DeleteInsuranceLineItemInput!) { deleteInsuranceLineItem(input: $input) { id } }`, {
    input: { id },
  })
}

// ── Current-period helpers (used by the truck profile ↔ Insurance two-way sync) ──

/** The current period (isCurrent flag, else the newest). Creates one if none exist. */
export async function ensureCurrentPeriod(): Promise<InsurancePeriod> {
  const periods = await listInsurancePeriods()
  const cur = periods.find((p) => p.isCurrent) ?? periods[0]
  if (cur) return cur
  return createInsurancePeriod({ label: `${new Date().getFullYear()} Policy Year`, isCurrent: true })
}

/** A truck/trailer's annual premium (cents) in the current period, 0 if unset. */
export async function getUnitPremiumCents(equipmentId: string): Promise<number> {
  const periods = await listInsurancePeriods()
  const cur = periods.find((p) => p.isCurrent) ?? periods[0]
  if (!cur) return 0
  const items = await listInsuranceLineItems()
  const it = items.find((i) => i.periodId === cur.id && i.equipmentId === equipmentId && (i.kind === 'TRUCK' || i.kind === 'TRAILER'))
  return it?.annualCents ?? 0
}

/** Upsert a truck/trailer's annual premium (cents) in the current period. */
export async function setUnitPremiumCurrentPeriod(
  kind: 'TRUCK' | 'TRAILER', equipmentId: string, unitNumber: string, annualCents: number,
): Promise<void> {
  const cur = await ensureCurrentPeriod()
  const items = await listInsuranceLineItems()
  const existing = items.find((i) => i.periodId === cur.id && i.kind === kind && i.equipmentId === equipmentId)
  if (existing) await updateInsuranceLineItem(existing.id, { annualCents, unitNumber })
  else await createInsuranceLineItem({ periodId: cur.id, kind, equipmentId, unitNumber, annualCents })
}

/**
 * One-time import of legacy per-truck insurance (annual $ pairs derived from the old
 * "Insurance" RecurringExpense) into the current period. Skips trucks that already have a
 * TRUCK line item so it never clobbers a value entered on the Insurance page.
 */
export async function importLegacyTruckPremiums(
  pairs: { equipmentId: string; unitNumber: string; annualCents: number }[],
): Promise<number> {
  const withValue = pairs.filter((p) => p.annualCents > 0)
  if (withValue.length === 0) return 0
  const cur = await ensureCurrentPeriod()
  const items = await listInsuranceLineItems()
  const have = new Set(items.filter((i) => i.periodId === cur.id && i.kind === 'TRUCK' && i.equipmentId).map((i) => i.equipmentId))
  const toImport = withValue.filter((p) => !have.has(p.equipmentId))
  await Promise.all(toImport.map((p) =>
    createInsuranceLineItem({ periodId: cur.id, kind: 'TRUCK', equipmentId: p.equipmentId, unitNumber: p.unitNumber, annualCents: p.annualCents }),
  ))
  return toImport.length
}

/**
 * Copy every line item from one period into another (used by "Start a new period from
 * last year"). The caller supplies the fresh target period id; amounts carry over so the
 * user only edits what changed.
 */
export async function cloneLineItems(fromPeriodId: string, toPeriodId: string, items: InsuranceLineItem[]): Promise<void> {
  const source = items.filter((i) => i.periodId === fromPeriodId)
  await Promise.all(
    source.map((i) =>
      createInsuranceLineItem({
        periodId: toPeriodId,
        kind: i.kind,
        equipmentId: i.equipmentId ?? null,
        unitNumber: i.unitNumber ?? null,
        annualCents: i.annualCents,
        notes: i.notes ?? null,
      }),
    ),
  )
}
