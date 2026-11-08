/**
 * Step AI — the dashboards' RAW DynamoDB reads. Nothing here is visible-filtered and nothing
 * here is reachable from the executors: `dashboardActions.ts` wraps `samples/shipments/...`
 * in `makeVisibleReader` (src/lib/dashboards/visibleReader.ts) before any widget runs.
 *
 * Only indexed Queries for the big tables (never a Scan of Shipment/Invoice/Quote/LaneRateSample);
 * Scans are for the small ones (Customer ~700 rows, UserProfile, OwnershipDivision).
 * Index names are Amplify's defaults, as used by tms-dashboard-rollup/store.ts.
 */
import type { InvoiceRow, QuoteRow, SampleRow, ShipmentRow } from '../../../src/lib/dashboards/execute'
import type { RawSource } from '../../../src/lib/dashboards/visibleReader'
import type { VisCustomer } from '../../../src/lib/dataVisibility'
import type { Team } from '../../../src/types/tms'
import { batchGet, pages } from '../_shared/ddbReads'
import { readJson, scanAll, type Db, type Row } from '../_shared/crmStore'
import { GetCommand } from '@aws-sdk/lib-dynamodb'

export interface CustomerNameRow extends VisCustomer {
  name?: string | null
  aliases?: string[] | null
}
export interface StaffRow {
  id: string
  name: string
  email: string
}
export interface DivisionRow {
  code: string
  name: string
  brand: string | null
  parentId: string | null
}

/** Everything the actions read: the raw facts plus the small directories. */
export interface DashSource extends RawSource {
  customers(): Promise<CustomerNameRow[]>
  teams(): Promise<Team[]>
  /** ACTIVE users. */
  staff(): Promise<StaffRow[]>
  divisions(): Promise<DivisionRow[]>
}

export const IDX_SAMPLES_BY_MONTH = 'laneRateSamplesBySampleMonthAndDate'
export const IDX_SHIPMENTS_BY_MONTH = 'shipmentsByPickupMonthAndPickupAppt'
export const IDX_INVOICES_OPEN = 'invoicesByArOpenAndDueAt'
export const IDX_QUOTES_BY_MONTH = 'quotesByQuoteMonthAndQuoteDate'

const SAMPLE_FIELDS = [
  'shipmentId', 'date', 'excluded', 'revenueCents', 'costCents', 'profitCents', 'customerId', 'customerName',
  'carrierName', 'revDivision', 'revSubdivision', 'salesRepId', 'customerRepId', 'mode',
]
const SHIPMENT_FIELDS = [
  'id', 'number', 'status', 'pickupAppt', 'customerId', 'customerName', 'revDivision', 'revSubdivision', 'salesRepId', 'mode',
]
const INVOICE_FIELDS = ['id', 'number', 'customerId', 'customerName', 'invoiceDate', 'dueAt', 'balanceCents', 'shipmentId']
const INVOICE_SHIPMENT_FIELDS = ['id', 'revDivision', 'revSubdivision', 'salesRepId']
const QUOTE_FIELDS = ['id', 'side', 'status', 'quoteDate', 'customerId', 'customerName', 'customerRepId', 'mode', 'amountCents']

const names = (fields: string[], extra: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(fields.map((f) => [`#${f}`, f])),
  ...extra,
})
const projection = (fields: string[]): string => fields.map((f) => `#${f}`).join(', ')

/** Small TTL memo of RAW pages (never of anything viewer-filtered). */
const MEMO_TTL_MS = 30_000
const MEMO_MAX = 8
const memo = new Map<string, { at: number; value: Promise<unknown> }>()

function memoized<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = memo.get(key)
  if (hit && now - hit.at < MEMO_TTL_MS) return hit.value as Promise<T>
  const value = load()
  value.catch(() => memo.delete(key))
  memo.set(key, { at: now, value })
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string)
  return value
}

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

export function dbSource(db: Db): DashSource {
  return {
    customers: () =>
      memoized(`c:${env('CUSTOMER_TABLE_NAME')}`, () =>
        scanAll<CustomerNameRow>(db, {
          TableName: env('CUSTOMER_TABLE_NAME'),
          ProjectionExpression: '#id, #name, #aliases, #owners, #rep, #team',
          ExpressionAttributeNames: {
            '#id': 'id', '#name': 'name', '#aliases': 'aliases', '#owners': 'accountOwnerIds',
            '#rep': 'defaultSalesRepId', '#team': 'teamKey',
          },
        }),
      ),

    async teams() {
      const out = await db.send(new GetCommand({ TableName: env('TMS_SETTINGS_TABLE_NAME'), Key: { id: 'default' } }))
      const teams = readJson<Team[]>(out.Item?.teams)
      return Array.isArray(teams) ? teams : []
    },

    async staff() {
      const rows = await scanAll<Row>(db, {
        TableName: env('USER_PROFILE_TABLE_NAME'),
        ProjectionExpression: '#id, #email, #name, #status',
        ExpressionAttributeNames: { '#id': 'id', '#email': 'email', '#name': 'name', '#status': 'status' },
      })
      return rows
        .filter((r) => r.status === 'ACTIVE' && typeof r.id === 'string')
        .map((r) => ({ id: String(r.id), email: String(r.email ?? ''), name: String(r.name ?? '') || String(r.email ?? r.id) }))
    },

    async divisions() {
      const rows = await scanAll<Row>(db, {
        TableName: env('OWNERSHIP_DIVISION_TABLE_NAME'),
        ProjectionExpression: '#code, #name, #brand, #parent, #active',
        ExpressionAttributeNames: { '#code': 'code', '#name': 'name', '#brand': 'brand', '#parent': 'parentId', '#active': 'active' },
      })
      return rows
        .filter((r) => r.active !== false && typeof r.code === 'string')
        .map((r) => ({
          code: String(r.code),
          name: String(r.name ?? r.code),
          brand: typeof r.brand === 'string' && r.brand ? r.brand : null,
          parentId: typeof r.parentId === 'string' && r.parentId ? r.parentId : null,
        }))
    },

    samples: (month) =>
      memoized(`s:${month}`, async () =>
        (await pages(db, {
          TableName: env('LANE_RATE_SAMPLE_TABLE_NAME'),
          IndexName: IDX_SAMPLES_BY_MONTH,
          KeyConditionExpression: '#m = :m',
          ProjectionExpression: projection(SAMPLE_FIELDS),
          ExpressionAttributeNames: names(SAMPLE_FIELDS, { '#m': 'sampleMonth' }),
          ExpressionAttributeValues: { ':m': month },
        })) as unknown as SampleRow[],
      ),

    shipments: (month) =>
      memoized(`h:${month}`, async () =>
        (await pages(db, {
          TableName: env('SHIPMENT_TABLE_NAME'),
          IndexName: IDX_SHIPMENTS_BY_MONTH,
          KeyConditionExpression: '#pm = :m',
          // Voided and soft-deleted shipments are never counted (a stored explicit NULL counts as not set).
          FilterExpression:
            '(attribute_not_exists(#voidedAt) OR attribute_type(#voidedAt, :nul)) AND (attribute_not_exists(#deletedAt) OR attribute_type(#deletedAt, :nul))',
          ProjectionExpression: projection(SHIPMENT_FIELDS),
          ExpressionAttributeNames: names(SHIPMENT_FIELDS, { '#pm': 'pickupMonth', '#voidedAt': 'voidedAt', '#deletedAt': 'deletedAt' }),
          ExpressionAttributeValues: { ':m': month, ':nul': 'NULL' },
        })) as unknown as ShipmentRow[],
      ),

    async openInvoices() {
      const invoices = await pages(db, {
        TableName: env('INVOICE_TABLE_NAME'),
        IndexName: IDX_INVOICES_OPEN,
        KeyConditionExpression: '#o = :open',
        ProjectionExpression: projection(INVOICE_FIELDS),
        ExpressionAttributeNames: names(INVOICE_FIELDS, { '#o': 'arOpen' }),
        ExpressionAttributeValues: { ':open': 'OPEN' },
      })
      const shipments = await batchGet(
        db,
        env('SHIPMENT_TABLE_NAME'),
        invoices.map((i) => String(i.shipmentId ?? '')),
        INVOICE_SHIPMENT_FIELDS,
      )
      const byId = new Map(shipments.map((s) => [String(s.id), s]))
      return invoices.map((i) => {
        const s = byId.get(String(i.shipmentId ?? ''))
        return {
          ...i,
          revDivision: s?.revDivision ?? null,
          revSubdivision: s?.revSubdivision ?? null,
          salesRepId: s?.salesRepId ?? null,
        }
      }) as unknown as InvoiceRow[]
    },

    quotes: (month) =>
      memoized(`q:${month}`, async () =>
        (await pages(db, {
          TableName: env('QUOTE_TABLE_NAME'),
          IndexName: IDX_QUOTES_BY_MONTH,
          KeyConditionExpression: '#qm = :m',
          ProjectionExpression: projection(QUOTE_FIELDS),
          ExpressionAttributeNames: names(QUOTE_FIELDS, { '#qm': 'quoteMonth' }),
          ExpressionAttributeValues: { ':m': month },
        })) as unknown as QuoteRow[],
      ),
  }
}
