/**
 * workflow-agent — the AppSync action router (`tmsWorkflowActions`).
 *
 * Thirteen actions. Four read, eight move a run, one runs the sweep. None of
 * them issues a Delete: a run is DISMISSED or RESOLVED, and the row it points
 * at is the audit trail for what a model was shown and what it proposed.
 *
 * `LINK_RUN` is the only place a run becomes APPLIED, and it does not create
 * anything — the Shipment or Quote already exists, created by a person through
 * `CREATE_SHIPMENT` / `SAVE_QUOTE` under their own identity. This action just
 * records which run they applied, after checking the target is real and live.
 */
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { applyLink, dismiss, resolveException, retryable } from '../../../src/lib/workflows/runState'
import { AGENT_KEYS, isAgent } from '../../../src/lib/workflows/agents'
import { sampleRun } from './inbox'
import { rerunWithParty, retryRun, sweepStalled, backfillAp } from './run'
import {
  QUOTE_TABLE_NAME,
  SHIPMENT_TABLE_NAME,
  USER_POOL_ID,
  conflictError,
  getById,
  getRun,
  nowIso,
  queryByAgent,
  queryByShipment,
  queryExceptions,
  updateRun,
  writeAudit,
  type Row,
  type RunRow,
} from './store'

const cognito = new CognitoIdentityProviderClient({})

const OWNER_EMAIL = 'ryne@bcatcorp.com'
const ADMIN_GROUP = 'ADMIN'
const TMS_PAGE_GROUP = 'page-tms'
const MAX_LIMIT = 200
const MAX_FEEDBACK = 20

/** Actions nobody but the owner or an ADMIN may fire: they spend money or sweep. */
const ADMIN_ONLY_ACTIONS: Record<string, true> = { RUN_SAMPLE: true, BACKFILL_AP: true, SWEEP_STALLED: true }

export interface Caller {
  email: string
  sub?: string
  groups: string[]
  isAdmin: boolean
}

export interface AppSyncIdentity {
  sub?: string
  username?: string
  claims?: Record<string, unknown>
}

function claimString(claims: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = claims?.[key]
  return typeof value === 'string' ? value : undefined
}

async function getCallerEmail(identity: AppSyncIdentity): Promise<string> {
  const candidates = [claimString(identity.claims, 'email'), identity.username]
  const found = candidates.find((value): value is string => typeof value === 'string' && value.includes('@'))
  if (found) return found.toLowerCase().trim()
  const lookup = identity.username ?? identity.sub
  if (!lookup) return ''
  try {
    const me = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: String(lookup) }))
    return (me.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '').toLowerCase().trim()
  } catch (err) {
    console.warn('[workflow-agent] could not resolve caller email:', String(err))
    return ''
  }
}

function getGroups(identity: AppSyncIdentity): string[] {
  const raw = identity.claims?.['cognito:groups']
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string')
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export async function authorize(action: string, identity?: AppSyncIdentity | null): Promise<Caller> {
  if (!identity) throw new Error('Unauthorized: missing identity')
  const email = await getCallerEmail(identity)
  if (!email) throw new Error('Unauthorized: could not resolve caller email')
  const groups = getGroups(identity)
  const isAdmin = email === OWNER_EMAIL || groups.includes(ADMIN_GROUP)
  if (ADMIN_ONLY_ACTIONS[action] && !isAdmin) {
    throw new Error(`Forbidden: ${action} requires owner or ADMIN`)
  }
  if (!isAdmin && !groups.includes(TMS_PAGE_GROUP)) {
    throw new Error(`Forbidden: ${action} requires owner, ADMIN, or ${TMS_PAGE_GROUP}`)
  }
  return { email, sub: identity.sub, groups, isAdmin }
}

// ── Input helpers ────────────────────────────────────────────────────────────

function inputOf(raw: unknown): Row {
  if (raw == null) return {}
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be an object')
  return parsed as Row
}

function requireString(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${name} is required`)
  if (trimmed.length > maxLength) throw new Error(`${name} too long`)
  return trimmed
}

function optionalString(value: unknown, maxLength = 2000): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

function limitOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? MAX_LIMIT)
  if (!Number.isFinite(n) || n <= 0) return MAX_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function requireVersion(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error('expectedVersion is required')
  return n
}

async function loadRun(id: string, expectedVersion: number): Promise<RunRow> {
  const row = await getRun(id)
  if (!row) throw new Error(`Run not found: ${id}`)
  const current = typeof row.version === 'number' ? row.version : 0
  if (current !== expectedVersion) throw conflictError('run', null)
  return row as unknown as RunRow
}

/**
 * The run row, written back. Only the fields a human action moves — the
 * pipeline owns everything else, and a half-row patch cannot clobber a step it
 * never read.
 */
async function saveRunPatch(run: RunRow, patch: Row, expectedVersion: number): Promise<Row> {
  return updateRun(run.id, { ...patch, updatedAt: nowIso() }, expectedVersion)
}

function humanFields(run: RunRow): Row {
  return {
    status: run.status,
    outcome: run.outcome ?? null,
    exceptionOpen: run.exceptionOpen ?? null,
    appliedAt: run.appliedAt ?? null,
    appliedBy: run.appliedBy ?? null,
    dismissedAt: run.dismissedAt ?? null,
    dismissedBy: run.dismissedBy ?? null,
    dismissReason: run.dismissReason ?? null,
    resolvedAt: run.resolvedAt ?? null,
    resolvedBy: run.resolvedBy ?? null,
    shipmentId: run.shipmentId ?? null,
    quoteId: run.quoteId ?? null,
  }
}

// ── The router ───────────────────────────────────────────────────────────────

export async function dispatch(action: string, rawInput: unknown, identity?: AppSyncIdentity | null): Promise<unknown> {
  const caller = await authorize(action, identity)
  const input = inputOf(rawInput)

  switch (action) {
    case 'LIST_RUNS': {
      const limit = limitOf(input.limit)
      const agent = typeof input.agent === 'string' ? input.agent : null
      if (agent) {
        if (!isAgent(agent)) throw new Error(`Unknown agent: ${agent}`)
        return queryByAgent(agent, limit)
      }
      // No agent named: the AI Agents tab's default view. One query per agent,
      // merged newest-first, because the index is partitioned on agent.
      const pages = await Promise.all(AGENT_KEYS.map((key) => queryByAgent(key, limit)))
      return pages
        .flat()
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        .slice(0, limit)
    }

    case 'GET_RUN':
      return getRun(requireString(input.id, 'id'))

    case 'LIST_RUNS_FOR_SHIPMENT':
      return queryByShipment(requireString(input.shipmentId, 'shipmentId'), limitOf(input.limit))

    case 'LIST_EXCEPTIONS':
      return queryExceptions(limitOf(input.limit))

    case 'RETRY_RUN': {
      const id = requireString(input.id, 'id')
      const expectedVersion = requireVersion(input.expectedVersion)
      const run = await loadRun(id, expectedVersion)
      if (!retryable(run)) throw new Error('That run cannot be retried')
      const after = await retryRun(id, expectedVersion, caller)
      await writeAudit('WorkflowRun', id, action, caller, { attempts: after.attempts, outcome: after.outcome ?? null })
      return after
    }

    case 'LINK_RUN': {
      const id = requireString(input.id, 'id')
      const expectedVersion = requireVersion(input.expectedVersion)
      const shipmentId = optionalString(input.shipmentId, 120)
      const quoteId = optionalString(input.quoteId, 120)
      if (!shipmentId && !quoteId) throw new Error('shipmentId or quoteId is required')
      const run = await loadRun(id, expectedVersion)
      // Only a proposal can be applied. An APPLIED or DISMISSED run is settled,
      // and a FAILED one has nothing to apply.
      if (run.outcome !== 'PROPOSED') throw new Error('Only a proposed run can be linked')

      const target = shipmentId
        ? await getById(SHIPMENT_TABLE_NAME, shipmentId)
        : await getById(QUOTE_TABLE_NAME, String(quoteId))
      if (!target) throw new Error(shipmentId ? `Shipment not found: ${shipmentId}` : `Quote not found: ${quoteId}`)
      if (target.voidedAt) throw new Error('That record has been voided')
      // One piece of freight, one run. A second run claiming a Shipment or Quote a
      // first run already owns would leave two traces each saying it created it.
      if (typeof target.workflowRunId === 'string' && target.workflowRunId && target.workflowRunId !== id) {
        throw new Error('That record is already linked to another run')
      }

      Object.assign(run, applyLink(run, { shipmentId: shipmentId ?? undefined, quoteId: quoteId ?? undefined }, caller.email, nowIso()))
      const saved = await saveRunPatch(run, { ...humanFields(run), updatedBy: caller.email }, expectedVersion)
      await writeAudit('WorkflowRun', id, action, caller, { shipmentId, quoteId })
      return saved
    }

    case 'SET_RUN_PARTY': {
      const id = requireString(input.id, 'id')
      const expectedVersion = requireVersion(input.expectedVersion)
      const partyKind = requireString(input.partyKind, 'partyKind', 20)
      if (partyKind !== 'CUSTOMER' && partyKind !== 'CARRIER') throw new Error('partyKind must be CUSTOMER or CARRIER')
      const partyId = requireString(input.partyId, 'partyId', 120)
      const after = await rerunWithParty(id, { partyKind, partyId }, expectedVersion, caller)
      await writeAudit('WorkflowRun', id, action, caller, { partyKind, partyId })
      return after
    }

    case 'DISMISS_RUN': {
      const id = requireString(input.id, 'id')
      const expectedVersion = requireVersion(input.expectedVersion)
      const reason = requireString(input.reason, 'reason', 500)
      const run = await loadRun(id, expectedVersion)
      Object.assign(run, dismiss(run, reason, caller.email, nowIso()))
      const saved = await saveRunPatch(run, { ...humanFields(run), updatedBy: caller.email }, expectedVersion)
      await writeAudit('WorkflowRun', id, action, caller, { reason })
      return saved
    }

    case 'RESOLVE_EXCEPTION': {
      const id = requireString(input.id, 'id')
      const row = await getRun(id)
      if (!row) throw new Error(`Run not found: ${id}`)
      const run = row as unknown as RunRow
      const reason = optionalString(input.reason, 500)
      Object.assign(run, resolveException(run, caller.email, nowIso()))
      const saved = await updateRun(id, {
        exceptionOpen: null,
        resolvedAt: run.resolvedAt ?? nowIso(),
        resolvedBy: caller.email,
        updatedAt: nowIso(),
        updatedBy: caller.email,
      })
      await writeAudit('WorkflowRun', id, action, caller, { reason })
      return saved
    }

    case 'SAVE_FEEDBACK': {
      const id = requireString(input.id, 'id')
      const rating = requireString(input.rating, 'rating', 10)
      if (rating !== 'UP' && rating !== 'DOWN') throw new Error('rating must be UP or DOWN')
      const text = optionalString(input.text, 1000)
      const row = await getRun(id)
      if (!row) throw new Error(`Run not found: ${id}`)
      const existing = Array.isArray(row.feedback) ? row.feedback : []
      // Newest kept, oldest dropped: twenty is plenty to see a pattern in.
      const feedback = [...existing, { at: nowIso(), by: caller.email, rating, text }].slice(-MAX_FEEDBACK)
      const saved = await updateRun(id, { feedback, updatedAt: nowIso(), updatedBy: caller.email })
      await writeAudit('WorkflowRun', id, action, caller, { rating })
      return saved
    }

    case 'RUN_SAMPLE': {
      const agent = requireString(input.agent, 'agent', 20)
      if (!isAgent(agent)) throw new Error(`Unknown agent: ${agent}`)
      const subject = requireString(input.subject, 'subject', 500)
      const body = requireString(input.body, 'body', 50_000)
      const fromEmail = requireString(input.fromEmail, 'fromEmail', 320)
      // A real run against a sample message, so Try it exercises the same
      // pipeline the inbox does — including the caps and the blacklist.
      const messageId = `sample:${caller.email}:${Date.now()}`
      const run = await sampleRun({ agent, subject, body, fromEmail, messageId })
      await writeAudit('WorkflowRun', run.id, action, caller, { agent, subject })
      return run
    }

    case 'BACKFILL_AP': {
      const result = await backfillAp()
      await writeAudit('WorkflowRun', 'backfill', action, caller, { count: Object.keys(result.results).length })
      return result
    }

    case 'SWEEP_STALLED': {
      const result = await sweepStalled()
      await writeAudit('WorkflowRun', 'sweep', action, caller, result)
      return result
    }

    default:
      throw new Error(`Unknown action: ${action}`)
  }
}
