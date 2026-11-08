// Data access for the Users overview (S4 §3.2). Its own `gql`, the complianceClient pattern:
// apiClient.ts is already large and none of this is shared.
import { generateClient } from 'aws-amplify/data'
import { cachedList, invalidateLists } from '@/lib/listCache'
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

interface AuditIndexPage {
  listAuditLogByEntityTypeAndEntityId: { items: SignupAuditEntry[]; nextToken?: string | null }
}

const AUDIT_FIELDS = 'id entityType entityId action user changes createdAt'
const AUDIT_INDEX_QUERY = 'listAuditLogByEntityTypeAndEntityId'
const SIGNUP_CACHE_KEY = 'audit:signup'
const SIGNUP_CACHE_MS = 10 * 60_000

/** The data stack predates the AuditLog (entityType, entityId) index: only the full scan can answer. */
export class SignupAuditNeedsScanError extends Error {
  constructor() {
    super('Sign-up refusals need the full audit scan (the AuditLog index is not deployed yet).')
    this.name = 'SignupAuditNeedsScanError'
  }
}

/** `null` = not probed yet; flipped to false by the first "Cannot query field" answer. */
let auditIndexAvailable: boolean | null = null

/** Whether the next `listDriverSignupAudit()` is a cheap index read (true/unknown) or refused (false). */
export function signupAuditNeedsScan(): boolean {
  return auditIndexAvailable === false
}

function missingIndexError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : JSON.stringify(err ?? '')
  const errors = (err as { errors?: Array<{ message?: string }> } | null)?.errors
  const joined = text + (errors ? errors.map((e) => e.message ?? '').join(' ') : '')
  return joined.includes(AUDIT_INDEX_QUERY)
}

async function listSignupAuditByIndex(): Promise<SignupAuditEntry[]> {
  const entries: SignupAuditEntry[] = []
  let nextToken: string | null | undefined
  do {
    const data: AuditIndexPage = await gql<AuditIndexPage>(
      `query ($entityType: String!, $nextToken: String) {
        ${AUDIT_INDEX_QUERY}(entityType: $entityType, limit: 1000, nextToken: $nextToken) {
          items { ${AUDIT_FIELDS} }
          nextToken
        }
      }`,
      { entityType: SIGNUP_ENTITY_TYPE, nextToken },
    )
    entries.push(...(data[AUDIT_INDEX_QUERY].items ?? []))
    nextToken = data[AUDIT_INDEX_QUERY].nextToken
  } while (nextToken)
  return entries
}

/**
 * Every DRIVER_SIGNUP audit row. A filter applies AFTER each scan page, so one page of the
 * table can come back empty while later pages hold rows — page to exhaustion. This is the
 * 12 s read on a 38k-row table; it runs only when the user asks for it (no index deployed).
 */
export async function listDriverSignupAuditScan(): Promise<SignupAuditEntry[]> {
  return cachedList(SIGNUP_CACHE_KEY, async () => {
    const entries: SignupAuditEntry[] = []
    let nextToken: string | null | undefined
    do {
      const data: AuditPage = await gql<AuditPage>(
        `query ($filter: ModelAuditLogFilterInput, $nextToken: String) {
          listAuditLogs(filter: $filter, limit: 1000, nextToken: $nextToken) {
            items { ${AUDIT_FIELDS} }
            nextToken
          }
        }`,
        { filter: { entityType: { eq: SIGNUP_ENTITY_TYPE } }, nextToken },
      )
      entries.push(...(data.listAuditLogs.items ?? []))
      nextToken = data.listAuditLogs.nextToken
    } while (nextToken)
    return entries
  }, { ttlMs: SIGNUP_CACHE_MS })
}

/**
 * Every DRIVER_SIGNUP audit row through the `AuditLog (entityType, entityId)` index (one page,
 * ~0.4 s). Rejects with `SignupAuditNeedsScanError` when the backend has no such index, so the
 * caller can offer the explicit scan instead of running it on mount.
 */
export async function listDriverSignupAudit(): Promise<SignupAuditEntry[]> {
  if (auditIndexAvailable === false) throw new SignupAuditNeedsScanError()
  try {
    const rows = await cachedList(SIGNUP_CACHE_KEY, listSignupAuditByIndex, { ttlMs: SIGNUP_CACHE_MS })
    auditIndexAvailable = true
    return rows
  } catch (err: unknown) {
    if (!missingIndexError(err)) throw err
    auditIndexAvailable = false
    throw new SignupAuditNeedsScanError()
  }
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
  invalidateLists(SIGNUP_CACHE_KEY)
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
