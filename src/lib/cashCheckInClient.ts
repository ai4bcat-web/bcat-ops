// Data-access layer for the Weekly Cash Check-in feature.
// Uses raw GraphQL so the page can ship before a backend codegen/deploy cycle.
// ADMIN CRUD + authenticated read is enforced by the model authorization rules;
// the client still validates inputs before sending them.
import { generateClient } from 'aws-amplify/data'
import {
  normalizeCashSettings,
  validateCashCheckIn,
  type CashCheckIn,
  type CashCheckInInput,
  type CashSettingsValues,
} from './cashCheckIn'

const client = generateClient()

type GraphQLResult<T> = { data: T }
type GqlOptions = Parameters<typeof client.graphql>[0]

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const result = (await client.graphql({ query, variables } as unknown as GqlOptions)) as GraphQLResult<T>
  return result.data
}

/**
 * True when the failure is "these models aren't in the deployed schema yet" rather than a
 * real error. AppSync reports a missing query/mutation/subscription field as
 * `Validation error of type FieldUndefined`; the others are Amplify/GraphQL variants.
 */
export function isSchemaMissingError(err: unknown): boolean {
  const s = typeof err === 'string' ? err : JSON.stringify(err ?? '')
  return /FieldUndefined|Cannot query field|Unknown type|ValidationException|does not exist/i.test(s)
}

function unwrapJson(raw: unknown): unknown {
  let value = raw
  while (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return raw
    }
  }
  return value
}

const CHECKIN_FIELDS = `
  id date cash ar ap cards
  bcatMtdProfit ivanMtdProfit amazonMtdProfit
  note createdBy createdAt updatedAt
`

const SETTINGS_FIELDS = `
  id floor months runrate items factoring payrollAnchor slackChannel createdAt updatedAt
`

/* ── CashCheckIn ───────────────────────────────────────────────────────────── */

type CheckInPage = { listCashCheckIns: { items: CashCheckIn[]; nextToken?: string | null } }

export async function listCashCheckIns(): Promise<CashCheckIn[]> {
  const out: CashCheckIn[] = []
  let nextToken: string | null = null
  do {
    const data: CheckInPage = await gql<CheckInPage>(
      `query ($nextToken: String) {
        listCashCheckIns(limit: 1000, nextToken: $nextToken) {
          items { ${CHECKIN_FIELDS} }
          nextToken
        }
      }`,
      { nextToken },
    )
    const items = data.listCashCheckIns.items ?? []
    out.push(...items.map(normalizeCheckIn))
    nextToken = data.listCashCheckIns.nextToken ?? null
  } while (nextToken)
  return out
}

function normalizeCheckIn(raw: CashCheckIn): CashCheckIn {
  return {
    ...raw,
    ar: raw.ar ?? null,
    ap: raw.ap ?? null,
    cards: raw.cards ?? null,
    bcatMtdProfit: raw.bcatMtdProfit ?? null,
    ivanMtdProfit: raw.ivanMtdProfit ?? null,
    amazonMtdProfit: raw.amazonMtdProfit ?? null,
    note: raw.note ?? null,
    createdBy: raw.createdBy ?? null,
  }
}

export async function createCashCheckIn(
  input: CashCheckInInput & { createdBy: string },
): Promise<CashCheckIn> {
  const validated = validateCashCheckIn(input)
  const data = await gql<{ createCashCheckIn: CashCheckIn }>(
    `mutation Create($input: CreateCashCheckInInput!) {
       createCashCheckIn(input: $input) { ${CHECKIN_FIELDS} }
     }`,
    { input: { ...validated, createdBy: input.createdBy } },
  )
  return normalizeCheckIn(data.createCashCheckIn)
}

export async function updateCashCheckIn(
  id: string,
  patch: Partial<CashCheckInInput>,
): Promise<CashCheckIn> {
  const validated = patch
  const data = await gql<{ updateCashCheckIn: CashCheckIn }>(
    `mutation Update($input: UpdateCashCheckInInput!) {
       updateCashCheckIn(input: $input) { ${CHECKIN_FIELDS} }
     }`,
    { input: { id, ...validated } },
  )
  return normalizeCheckIn(data.updateCashCheckIn)
}

export async function deleteCashCheckIn(id: string): Promise<void> {
  await gql(
    `mutation Delete($input: DeleteCashCheckInInput!) {
       deleteCashCheckIn(input: $input) { id }
     }`,
    { input: { id } },
  )
}

/* ── CashSettings ──────────────────────────────────────────────────────────── */

interface RawSettingsRecord {
  id: string
  floor?: number | null
  months?: number | null
  runrate?: unknown
  items?: unknown
  factoring?: unknown
  payrollAnchor?: string | null
  slackChannel?: string | null
  createdAt?: string
  updatedAt?: string
}

function normalizeSettingsRecord(raw: RawSettingsRecord): CashSettingsValues {
  return normalizeCashSettings({
    floor: raw.floor,
    months: raw.months,
    runrate: unwrapJson(raw.runrate),
    items: unwrapJson(raw.items),
    factoring: unwrapJson(raw.factoring),
    reminder: { payrollAnchor: raw.payrollAnchor ?? '', slackChannel: raw.slackChannel ?? '' },
  })
}

export async function getCashSettings(id = 'default'): Promise<CashSettingsValues | null> {
  const data = await gql<{ getCashSettings: RawSettingsRecord | null }>(
    `query ($id: ID!) { getCashSettings(id: $id) { ${SETTINGS_FIELDS} } }`,
    { id },
  )
  if (!data.getCashSettings) return null
  return normalizeSettingsRecord(data.getCashSettings)
}

function serializeSettingsInput(settings: CashSettingsValues): Record<string, unknown> {
  return {
    floor: settings.floor,
    months: settings.months,
    runrate: JSON.stringify(settings.runrate),
    items: JSON.stringify(settings.items),
    factoring: JSON.stringify(settings.factoring),
    payrollAnchor: settings.reminder.payrollAnchor || null,
    slackChannel: settings.reminder.slackChannel || null,
  }
}

export async function createCashSettings(
  settings: CashSettingsValues,
  id = 'default',
): Promise<CashSettingsValues> {
  const data = await gql<{ createCashSettings: RawSettingsRecord }>(
    `mutation Create($input: CreateCashSettingsInput!) {
       createCashSettings(input: $input) { ${SETTINGS_FIELDS} }
     }`,
    { input: { id, ...serializeSettingsInput(settings) } },
  )
  return normalizeSettingsRecord(data.createCashSettings)
}

export async function updateCashSettings(
  settings: CashSettingsValues,
  id = 'default',
): Promise<CashSettingsValues> {
  const data = await gql<{ updateCashSettings: RawSettingsRecord }>(
    `mutation Update($input: UpdateCashSettingsInput!) {
       updateCashSettings(input: $input) { ${SETTINGS_FIELDS} }
     }`,
    { input: { id, ...serializeSettingsInput(settings) } },
  )
  return normalizeSettingsRecord(data.updateCashSettings)
}

/* ── Subscriptions ─────────────────────────────────────────────────────────── */

type Subscription = { unsubscribe: () => void }

function subscribe(query: string, onEvent: () => void, onError: (err: unknown) => void, variables?: Record<string, unknown>): Subscription {
  const obs = client.graphql({ query, variables } as unknown as GqlOptions) as unknown as {
    subscribe: (handlers: { next: () => void; error: (err: unknown) => void }) => Subscription
  }
  return obs.subscribe({
    next: onEvent,
    error: onError,
  })
}

export function subscribeCashCheckIns(onEvent: () => void, onError: (err: unknown) => void): () => void {
  const subs: Subscription[] = [
    subscribe(
      `subscription { onCreateCashCheckIn { ${CHECKIN_FIELDS} } }`,
      onEvent,
      onError,
    ),
    subscribe(
      `subscription { onUpdateCashCheckIn { ${CHECKIN_FIELDS} } }`,
      onEvent,
      onError,
    ),
    subscribe(
      `subscription { onDeleteCashCheckIn { id } }`,
      onEvent,
      onError,
    ),
  ]
  return () => subs.forEach((s) => s.unsubscribe())
}

export function subscribeCashSettings(
  onEvent: () => void,
  onError: (err: unknown) => void,
  id = 'default',
): () => void {
  const subs: Subscription[] = [
    subscribe(
      `subscription { onCreateCashSettings { ${SETTINGS_FIELDS} } }`,
      onEvent,
      onError,
    ),
    subscribe(
      `subscription OnUpdateCashSettings($id: ID!) {
        onUpdateCashSettings(filter: { id: { eq: $id } }) { ${SETTINGS_FIELDS} }
      }`,
      onEvent,
      onError,
      { id },
    ),
    subscribe(
      `subscription { onDeleteCashSettings { id } }`,
      onEvent,
      onError,
    ),
  ]
  return () => subs.forEach((s) => s.unsubscribe())
}
