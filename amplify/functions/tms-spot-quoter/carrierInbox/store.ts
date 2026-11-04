/**
 * Step AL — the carrier inbox's own state, on the SpotSettings row id='carrier-sales'
 * (`carrierInbox` = config, CAS on its `version`; `carrierInboxState` = machine state,
 * written only by `UpdateItem SET` on document paths so a poll, an OAuth finish and a
 * settings save never overwrite each other). Nothing secret is stored in either attribute.
 *
 * The spot role has no write on Quote/Shipment/ShipmentMessage; this module only touches
 * SpotSettings, plus the shared AuditLog helper on `SpotStore`.
 */
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  CARRIER_INBOX_SETTINGS_ID,
  type CarrierInboxMailboxState,
  type CarrierInboxRunDigest,
  type CarrierInboxState,
  type ResolvedCarrierInboxConfig,
} from '../../../../src/lib/carrierInbox/types'
import { ConflictError, isConditionalFailure, jsonOf } from '../store'

export const RUN_DIGESTS_KEPT = 14

export function emptyMailboxState(): CarrierInboxMailboxState {
  return {
    status: 'NOT_CONNECTED', googleEmail: null, connectedAt: null, scopes: [], historyId: null,
    lastPollAt: null, lastPollOk: null, lastError: null, held: 0, runningAt: null,
    pendingStateHash: null, pendingStateExp: null, lastStats: null,
  }
}

export function emptyState(): CarrierInboxState {
  return {
    mailboxes: {}, modelCallsDay: null, modelCallsToday: 0,
    voice: { lastCallAt: null, calls24h: 0, lastError: null, urlSeenAt: null, url: null },
    runs: [],
  }
}

/** The stored attribute with every default filled in (a half-written row never breaks a reader). */
export function normalizeState(raw: unknown): CarrierInboxState {
  const base = emptyState()
  const s = jsonOf<Partial<CarrierInboxState>>(raw)
  if (!s || typeof s !== 'object') return base
  const mailboxes: Record<string, CarrierInboxMailboxState> = {}
  for (const [id, m] of Object.entries(s.mailboxes ?? {})) mailboxes[id] = { ...emptyMailboxState(), ...(m ?? {}) }
  return {
    mailboxes,
    modelCallsDay: typeof s.modelCallsDay === 'string' ? s.modelCallsDay : null,
    modelCallsToday: typeof s.modelCallsToday === 'number' ? s.modelCallsToday : 0,
    voice: { ...base.voice, ...(s.voice ?? {}) },
    runs: Array.isArray(s.runs) ? s.runs.slice(0, RUN_DIGESTS_KEPT) : [],
  }
}

export interface CarrierInboxStore {
  /** The raw `carrierInbox` attribute (null when the row does not exist yet). */
  getConfigRaw(): Promise<unknown | null>
  /** Writes `config` with `version = expectedVersion + 1`; ConflictError when the stored version moved. */
  putConfig(config: ResolvedCarrierInboxConfig, expectedVersion: number): Promise<ResolvedCarrierInboxConfig>
  getState(): Promise<CarrierInboxState>
  /** SET the given fields of one mailbox's state (the entry is created when absent). */
  patchMailboxState(mailboxId: string, patch: Partial<CarrierInboxMailboxState>): Promise<void>
  /** Poll lock: false when another run started after `staleBefore`. */
  claimMailbox(mailboxId: string, startedAt: string, staleBefore: string): Promise<boolean>
  removeMailboxState(mailboxId: string): Promise<void>
  /** Adds `n` model calls to the day's counter (a new day restarts it). */
  bumpModelCalls(day: string, n: number): Promise<void>
  patchVoice(patch: Partial<CarrierInboxState['voice']>): Promise<void>
  /** Newest first, capped at RUN_DIGESTS_KEPT. */
  pushRunDigest(digest: CarrierInboxRunDigest): Promise<void>
}

export function createCarrierInboxStore(db: DynamoDBDocumentClient, table: () => string = () => process.env.SPOT_SETTINGS_TABLE_NAME ?? ''): CarrierInboxStore {
  const key = { id: CARRIER_INBOX_SETTINGS_ID }

  async function row(): Promise<Record<string, unknown> | null> {
    const got = await db.send(new GetCommand({ TableName: table(), Key: key }))
    return (got.Item as Record<string, unknown> | undefined) ?? null
  }

  /** Make sure the row and `carrierInboxState.mailboxes` exist so document-path SETs are valid. */
  async function ensureState(): Promise<void> {
    const now = new Date().toISOString()
    await db.send(new UpdateCommand({
      TableName: table(),
      Key: key,
      UpdateExpression: 'SET carrierInboxState = if_not_exists(carrierInboxState, :s), createdAt = if_not_exists(createdAt, :now), updatedAt = :now, #tn = if_not_exists(#tn, :tn)',
      ExpressionAttributeNames: { '#tn': '__typename' },
      ExpressionAttributeValues: { ':s': emptyState(), ':now': now, ':tn': 'SpotSettings' },
    }))
  }

  async function ensureMailbox(id: string): Promise<void> {
    await ensureState()
    await db.send(new UpdateCommand({
      TableName: table(),
      Key: key,
      UpdateExpression: 'SET carrierInboxState.mailboxes.#m = if_not_exists(carrierInboxState.mailboxes.#m, :init)',
      ExpressionAttributeNames: { '#m': id },
      ExpressionAttributeValues: { ':init': emptyMailboxState() },
    }))
  }

  function sets(prefix: string, patch: Record<string, unknown>, names: Record<string, string>, values: Record<string, unknown>): string[] {
    const out: string[] = []
    let n = Object.keys(names).length
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      n += 1
      names[`#f${n}`] = k
      values[`:v${n}`] = v
      out.push(`${prefix}.#f${n} = :v${n}`)
    }
    return out
  }

  return {
    async getConfigRaw() {
      return jsonOf<unknown>((await row())?.carrierInbox)
    },

    async putConfig(config, expectedVersion) {
      const next = { ...config, version: expectedVersion + 1 }
      const now = new Date().toISOString()
      try {
        await db.send(new UpdateCommand({
          TableName: table(),
          Key: key,
          UpdateExpression: 'SET carrierInbox = :c, createdAt = if_not_exists(createdAt, :now), updatedAt = :now, #tn = if_not_exists(#tn, :tn)',
          ConditionExpression: expectedVersion === 0
            ? 'attribute_not_exists(carrierInbox)'
            : 'carrierInbox.#version = :ev',
          ExpressionAttributeNames: { '#tn': '__typename', ...(expectedVersion === 0 ? {} : { '#version': 'version' }) },
          ExpressionAttributeValues: {
            ':c': next, ':now': now, ':tn': 'SpotSettings',
            ...(expectedVersion === 0 ? {} : { ':ev': expectedVersion }),
          },
        }))
      } catch (err) {
        if (isConditionalFailure(err)) throw new ConflictError('Carrier Sales settings changed since you opened them; reload and try again')
        throw err
      }
      return next
    },

    async getState() {
      return normalizeState((await row())?.carrierInboxState)
    },

    async patchMailboxState(mailboxId, patch) {
      await ensureMailbox(mailboxId)
      const names: Record<string, string> = { '#m': mailboxId }
      const values: Record<string, unknown> = {}
      const parts = sets('carrierInboxState.mailboxes.#m', patch as Record<string, unknown>, names, values)
      if (!parts.length) return
      await db.send(new UpdateCommand({
        TableName: table(), Key: key,
        UpdateExpression: `SET ${parts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }))
    },

    async claimMailbox(mailboxId, startedAt, staleBefore) {
      await ensureMailbox(mailboxId)
      try {
        await db.send(new UpdateCommand({
          TableName: table(), Key: key,
          UpdateExpression: 'SET carrierInboxState.mailboxes.#m.runningAt = :s',
          ConditionExpression: 'attribute_not_exists(carrierInboxState.mailboxes.#m.runningAt) OR carrierInboxState.mailboxes.#m.runningAt = :null OR carrierInboxState.mailboxes.#m.runningAt < :stale',
          ExpressionAttributeNames: { '#m': mailboxId },
          ExpressionAttributeValues: { ':s': startedAt, ':stale': staleBefore, ':null': null },
        }))
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },

    async removeMailboxState(mailboxId) {
      await ensureState()
      await db.send(new UpdateCommand({
        TableName: table(), Key: key,
        UpdateExpression: 'REMOVE carrierInboxState.mailboxes.#m',
        ExpressionAttributeNames: { '#m': mailboxId },
      }))
    },

    async bumpModelCalls(day, n) {
      if (n <= 0) return
      await ensureState()
      try {
        await db.send(new UpdateCommand({
          TableName: table(), Key: key,
          UpdateExpression: 'SET carrierInboxState.modelCallsToday = carrierInboxState.modelCallsToday + :n',
          ConditionExpression: 'carrierInboxState.modelCallsDay = :d',
          ExpressionAttributeValues: { ':n': n, ':d': day },
        }))
      } catch (err) {
        if (!isConditionalFailure(err)) throw err
        await db.send(new UpdateCommand({
          TableName: table(), Key: key,
          UpdateExpression: 'SET carrierInboxState.modelCallsDay = :d, carrierInboxState.modelCallsToday = :n',
          ExpressionAttributeValues: { ':n': n, ':d': day },
        }))
      }
    },

    async patchVoice(patch) {
      await ensureState()
      const names: Record<string, string> = {}
      const values: Record<string, unknown> = {}
      const parts = sets('carrierInboxState.voice', patch as Record<string, unknown>, names, values)
      if (!parts.length) return
      await db.send(new UpdateCommand({
        TableName: table(), Key: key,
        UpdateExpression: `SET ${parts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }))
    },

    async pushRunDigest(digest) {
      const state = normalizeState((await row())?.carrierInboxState)
      await ensureState()
      await db.send(new UpdateCommand({
        TableName: table(), Key: key,
        UpdateExpression: 'SET carrierInboxState.runs = :r',
        ExpressionAttributeValues: { ':r': [digest, ...state.runs].slice(0, RUN_DIGESTS_KEPT) },
      }))
    },
  }
}
