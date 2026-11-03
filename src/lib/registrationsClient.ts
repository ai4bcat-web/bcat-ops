// Data access for the Users overview (S4 §3.2). Its own `gql`, the complianceClient pattern:
// apiClient.ts is already large and none of this is shared.
import { generateClient } from 'aws-amplify/data'
import {
  SIGNUP_DISMISSED,
  SIGNUP_ENTITY_TYPE,
  type DriverPoolLogin,
  type SignupAuditEntry,
} from '@/lib/registrations'

const client = generateClient()

type GqlOptions = Parameters<typeof client.graphql>[0]

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const result = (await client.graphql({ query, variables } as unknown as GqlOptions)) as { data: T }
  return result.data
}

interface AuditPage {
  listAuditLogs: { items: SignupAuditEntry[]; nextToken?: string | null }
}

/**
 * Every DRIVER_SIGNUP audit row. A filter applies AFTER each scan page, so one page of the
 * table can come back empty while later pages hold rows — page to exhaustion.
 */
export async function listDriverSignupAudit(): Promise<SignupAuditEntry[]> {
  const entries: SignupAuditEntry[] = []
  let nextToken: string | null | undefined
  do {
    const data: AuditPage = await gql<AuditPage>(
      `query ($filter: ModelAuditLogFilterInput, $nextToken: String) {
        listAuditLogs(filter: $filter, limit: 1000, nextToken: $nextToken) {
          items { id entityType entityId action user changes createdAt }
          nextToken
        }
      }`,
      { filter: { entityType: { eq: SIGNUP_ENTITY_TYPE } }, nextToken },
    )
    entries.push(...(data.listAuditLogs.items ?? []))
    nextToken = data.listAuditLogs.nextToken
  } while (nextToken)
  return entries
}

/** Dismiss = a newer audit row for the same e-mail (the log is append-only for staff). */
export async function dismissDriverSignup(email: string, by: string): Promise<void> {
  const now = new Date().toISOString()
  await gql(
    `mutation ($input: CreateAuditLogInput!) { createAuditLog(input: $input) { id } }`,
    {
      input: {
        entityType: SIGNUP_ENTITY_TYPE,
        entityId: email.toLowerCase().trim(),
        action: SIGNUP_DISMISSED,
        user: by,
        changes: JSON.stringify({ at: now }),
      },
    },
  )
}

export interface DriverPoolResult {
  users: DriverPoolLogin[]
  /** Present when the Lambda could not read the pool (older / partial deploy). */
  reason?: string
}

/** `manageUsers` action `listDriverPool`: owner/ADMIN only, whitelisted fields only. */
export async function listDriverPoolUsers(): Promise<DriverPoolResult> {
  const data = await gql<{ manageUsers: unknown }>(
    `query ManageUsers($action: String!) { manageUsers(action: $action) }`,
    { action: 'listDriverPool' },
  )
  let value = data.manageUsers
  if (typeof value === 'string') value = JSON.parse(value) as unknown
  if (value && typeof value === 'object' && Array.isArray((value as DriverPoolResult).users)) {
    return value as DriverPoolResult
  }
  throw new Error('manageUsers returned an unexpected shape for listDriverPool')
}
