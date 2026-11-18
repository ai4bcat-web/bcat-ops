// Read-only window reads of the AR / AP cash ledgers for Financial operations.
// Own `gql` (the cashCheckInClient precedent) — not apiClient. Neither ArPayment nor
// ApPayment has an all-rows time index, so this is a filtered scan; a filter applies AFTER
// each scan page, so every page is read until `nextToken` runs out (a single page would
// silently miss rows). Failures throw: the page names them, it never paints an empty ledger.
import { generateClient } from 'aws-amplify/data'
import type { ApPaymentLine, ArPaymentLine } from './financeOps'

const client = generateClient()

type GqlOptions = Parameters<typeof client.graphql>[0]

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const result = (await client.graphql({ query, variables } as unknown as GqlOptions)) as unknown as { data: T }
  return result.data
}

const AR_FIELDS = 'id customerId kind receivedAt method reference amountCents appliedCents unappliedCents reversedByPaymentId'
const AP_FIELDS =
  'id carrierId kind paidAt method reference amountCents appliedCents unappliedCents reversedByPaymentId pdfKey remittanceSentAt archivedAt'

/** Payments are stored at noon UTC on the typed day; the bounds cover whole days. */
const bounds = (from: string, to: string) => [`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`]

async function scan<T>(
  operation: string,
  fields: string,
  field: 'receivedAt' | 'paidAt',
  from: string,
  to: string,
): Promise<T[]> {
  const out: T[] = []
  let nextToken: string | null = null
  do {
    const page: Record<string, { items: T[]; nextToken?: string | null }> = await gql(
      `query ($filter: Model${operation === 'listArPayments' ? 'Ar' : 'Ap'}PaymentFilterInput, $nextToken: String) {
        ${operation}(filter: $filter, limit: 1000, nextToken: $nextToken) {
          items { ${fields} }
          nextToken
        }
      }`,
      { filter: { [field]: { between: bounds(from, to) } }, nextToken },
    )
    const result = page[operation]
    out.push(...(result.items ?? []))
    nextToken = result.nextToken ?? null
  } while (nextToken)
  return out
}

/** Every AR cash row received in `[from, to]` (`YYYY-MM-DD`, inclusive). */
export function listArPaymentsInWindow(from: string, to: string): Promise<ArPaymentLine[]> {
  return scan<ArPaymentLine>('listArPayments', AR_FIELDS, 'receivedAt', from, to)
}

/**
 * Every AP cash row paid in `[from, to]` (`YYYY-MM-DD`, inclusive). Payments made outside BCAT Ops (archived, Ryne
 * 2026-11-18) are not cash this system moved, so they are left out.
 */
export async function listApPaymentsInWindow(from: string, to: string): Promise<ApPaymentLine[]> {
  const rows = await scan<ApPaymentLine & { archivedAt?: string | null }>('listApPayments', AP_FIELDS, 'paidAt', from, to)
  return rows.filter((row) => !row.archivedAt)
}

/** One Aljex CRED/DEBT memo kept as history (`LegacyAljexRow`); `fields` is the raw AWSJSON. */
export interface AljexMemoLine {
  id: string
  pro: string
  kind: string
  fields: unknown
}

/**
 * Every Aljex credit/debit memo row (≈400 of ≈5.4k legacy rows). No index by kind, so a filtered
 * scan read to the last page, like the ledgers above.
 */
export async function listAljexMemoRows(): Promise<AljexMemoLine[]> {
  const out: AljexMemoLine[] = []
  let nextToken: string | null = null
  do {
    const page: { listLegacyAljexRows: { items: AljexMemoLine[]; nextToken?: string | null } } = await gql(
      `query ($filter: ModelLegacyAljexRowFilterInput, $nextToken: String) {
        listLegacyAljexRows(filter: $filter, limit: 1000, nextToken: $nextToken) {
          items { id pro kind fields }
          nextToken
        }
      }`,
      { filter: { or: [{ kind: { eq: 'MEMO_CRED' } }, { kind: { eq: 'MEMO_DEBT' } }] }, nextToken },
    )
    out.push(...(page.listLegacyAljexRows.items ?? []))
    nextToken = page.listLegacyAljexRows.nextToken ?? null
  } while (nextToken)
  return out
}
