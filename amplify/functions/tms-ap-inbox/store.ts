/**
 * Step AG — every DynamoDB call `tms-ap-inbox` makes, behind `ApInboxStore`. The two bill write
 * paths (`updateCarrierBill`, `updateVendorPayable`) run every patch through the D8 allow-list
 * (`pickAllowed`), so no code above this file can write a column outside it.
 *
 * Config / state live on the `TmsSettings` singleton as `apInbox` / `apInboxState` and are only
 * ever touched with `UpdateItem SET <attr>` (never `updatedAt`, never the other settings).
 */
import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { blacklistFromSettings } from '../../../src/lib/spot/prefilter'
import { BILL_WRITABLE_COLUMNS, VENDOR_WRITABLE_COLUMNS, pickAllowed } from '../../../src/lib/apInbox/applyPlan'
import { AP_INBOX_ACTOR, resolveApInboxConfig } from '../../../src/lib/apInbox/constants'
import type {
  ApInboxItemRecord,
  ApInboxState,
  Ledger,
  LedgerAssignment,
  LedgerBill,
  LedgerCarrier,
  LedgerVendorPayable,
} from '../../../src/lib/apInbox/types'
import type { ApInboxStore } from './contract'
import {
  LEDGER_MAX,
  buildLedger,
  jsonOf,
  toLedgerAssignment,
  toLedgerBill,
  toLedgerCarrier,
  toLedgerVendor,
  type Row,
} from './ledger'

export const IS_DEV_STACK = process.env.BCAT_DEV_STACK === 'true'
export const IDX_ITEMS_BY_STATUS = 'apInboxItemsByStatusAndReceivedAt'
export const IDX_BILLS_BY_AP_OPEN = 'carrierBillsByApOpenAndDueAt'
export const IDX_LC_BY_AP_OPEN = 'loadCarriersByApOpenAndApStatusChangedAt'

const SETTINGS_ID = 'default'
const t = (name: string): string => process.env[name] ?? ''
const nowIso = (): string => new Date().toISOString()

export function blankState(): ApInboxState {
  return { connection: { status: 'NOT_CONNECTED', googleEmail: null, connectedAt: null, scopes: [], lastError: null }, cursor: null, retry: [], runs: [] }
}

function isConditionalFailure(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException')
}

const JSON_ITEM_FIELDS = ['extraction', 'match', 'target', 'applied', 'attachments'] as const

/** A stored row → the record the pipeline and the client see (`a.json()` values parsed). */
function itemFrom(row: Row): ApInboxItemRecord {
  const out: Row = { ...row }
  for (const key of JSON_ITEM_FIELDS) out[key] = jsonOf(row[key])
  return out as unknown as ApInboxItemRecord
}

/** Drops null/undefined (a NULL on an index key is refused; elsewhere an absent attribute reads as null). */
function compact(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null))
}

export function createDynamoStore(): ApInboxStore & { db: DynamoDBDocumentClient } {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })

  async function get(table: string, id: string): Promise<Row | null> {
    if (!table) return null
    const got = await db.send(new GetCommand({ TableName: table, Key: { id } }))
    return (got.Item as Row | undefined) ?? null
  }

  async function scanAll(table: string, filter?: { expr: string; names: Record<string, string>; values: Row }): Promise<Row[]> {
    const out: Row[] = []
    let key: Record<string, unknown> | undefined
    do {
      const page = await db.send(new ScanCommand({
        TableName: table,
        ExclusiveStartKey: key,
        ...(filter ? { FilterExpression: filter.expr, ExpressionAttributeNames: filter.names, ExpressionAttributeValues: filter.values } : {}),
      }))
      out.push(...((page.Items ?? []) as Row[]))
      key = page.LastEvaluatedKey
    } while (key)
    return out
  }

  async function queryAll(table: string, index: string, field: string, value: string): Promise<Row[]> {
    const out: Row[] = []
    let key: Record<string, unknown> | undefined
    do {
      const page = await db.send(new QueryCommand({
        TableName: table,
        IndexName: index,
        KeyConditionExpression: '#f = :v',
        ExpressionAttributeNames: { '#f': field },
        ExpressionAttributeValues: { ':v': value },
        ExclusiveStartKey: key,
      }))
      out.push(...((page.Items ?? []) as Row[]))
      key = page.LastEvaluatedKey
    } while (key)
    return out
  }

  async function batchGet(table: string, ids: string[]): Promise<Record<string, Row>> {
    const out: Record<string, Row> = {}
    const unique = [...new Set(ids.filter(Boolean))]
    for (let i = 0; i < unique.length; i += 100) {
      let keys: Record<string, unknown>[] | undefined = unique.slice(i, i + 100).map((id) => ({ id }))
      for (let attempt = 0; keys?.length && attempt < 4; attempt += 1) {
        const res: BatchGetCommandOutput = await db.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }))
        for (const row of (res.Responses?.[table] ?? []) as Row[]) out[String(row.id)] = row
        keys = res.UnprocessedKeys?.[table]?.Keys
      }
    }
    return out
  }

  /** `SET a = :a, ...` / `REMOVE ...` for a patch; '' or null on `removeWhenBlank` keys removes. */
  function setExpr(patch: Row, removeKeys: ReadonlySet<string>, names: Record<string, string>, values: Row, prefix: string) {
    const sets: string[] = []
    const removes: string[] = []
    let n = 0
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      const nk = `#${prefix}${n}`
      names[nk] = key
      if (value === null || (value === '' && removeKeys.has(key))) removes.push(nk)
      else {
        const vk = `:${prefix}${n}`
        values[vk] = value
        sets.push(`${nk} = ${vk}`)
      }
      n += 1
    }
    return { sets, removes }
  }

  const SETTINGS = (): string => t('TMS_SETTINGS_TABLE_NAME')

  /** Make sure `apInboxState` exists so nested SETs work. */
  async function ensureState(): Promise<void> {
    try {
      await db.send(new UpdateCommand({
        TableName: SETTINGS(),
        Key: { id: SETTINGS_ID },
        UpdateExpression: 'SET apInboxState = :s',
        ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(apInboxState)',
        ExpressionAttributeValues: { ':s': blankState() },
      }))
    } catch (err) {
      if (!isConditionalFailure(err)) throw err
    }
  }

  async function patchBill(
    id: string,
    set: Row,
    extra: Row,
    removeExtra: string[],
    cond: { expr: string; values: Row },
  ): Promise<boolean> {
    const names: Record<string, string> = { '#version': 'version', '#updatedAt': 'updatedAt', '#updatedBy': 'updatedBy' }
    if (cond.expr.includes('#status')) names['#status'] = 'status'
    const values: Row = { ...cond.values, ':now': nowIso(), ':actor': AP_INBOX_ACTOR }
    const { sets, removes } = setExpr(pickAllowed(set, BILL_WRITABLE_COLUMNS), new Set(['billNumber']), names, values, 'c')
    const e = setExpr(extra, new Set(), names, values, 'e')
    for (const key of removeExtra) {
      names[`#r_${key}`] = key
      removes.push(`#r_${key}`)
    }
    const allSets = ['#version = #version + :one', '#updatedAt = :now', '#updatedBy = :actor', ...sets, ...e.sets]
    values[':one'] = 1
    try {
      await db.send(new UpdateCommand({
        TableName: t('CARRIER_BILL_TABLE_NAME'),
        Key: { id },
        UpdateExpression: `SET ${allSets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: `attribute_exists(id) AND ${cond.expr}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }))
      return true
    } catch (err) {
      if (isConditionalFailure(err)) return false
      throw err
    }
  }

  async function loadBillRow(id: string): Promise<{ row: Row; load: Row | null } | null> {
    const row = await get(t('CARRIER_BILL_TABLE_NAME'), id)
    if (!row) return null
    return { row, load: await get(t('LOAD_TABLE_NAME'), String(row.loadId ?? '')) }
  }

  return {
    db,

    // ── config + state ──
    async getConfig() {
      const row = await get(SETTINGS(), SETTINGS_ID)
      return resolveApInboxConfig(jsonOf(row?.apInbox))
    },
    async putConfig(config, expectedVersion) {
      try {
        await db.send(new UpdateCommand({
          TableName: SETTINGS(),
          Key: { id: SETTINGS_ID },
          UpdateExpression: 'SET apInbox = :c',
          ConditionExpression: 'attribute_exists(id) AND ((attribute_not_exists(apInbox) AND :ev = :one) OR apInbox.#v = :ev)',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':c': { ...config, version: expectedVersion + 1 }, ':ev': expectedVersion, ':one': 1 },
        }))
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },
    async getState() {
      const row = await get(SETTINGS(), SETTINGS_ID)
      const stored = jsonOf<Partial<ApInboxState>>(row?.apInboxState) ?? {}
      return { ...blankState(), ...stored }
    },
    async patchState(patch) {
      await ensureState()
      const names: Record<string, string> = {}
      const values: Row = {}
      const { sets, removes } = setExpr(
        Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v])),
        new Set(),
        names,
        values,
        's',
      )
      // The keys live under `apInboxState`: rewrite each `#sN` to a nested path.
      const nested = (parts: string[]) => parts.map((p) => p.replace(/^(#s\d+)/, 'apInboxState.$1'))
      const expr = [sets.length ? `SET ${nested(sets).join(', ')}` : '', removes.length ? `REMOVE ${nested(removes).join(', ')}` : ''].filter(Boolean).join(' ')
      if (!expr) return
      await db.send(new UpdateCommand({
        TableName: SETTINGS(),
        Key: { id: SETTINGS_ID },
        UpdateExpression: expr,
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
      }))
    },
    async claimRun(now, staleBefore) {
      await ensureState()
      try {
        await db.send(new UpdateCommand({
          TableName: SETTINGS(),
          Key: { id: SETTINGS_ID },
          UpdateExpression: 'SET apInboxState.runningAt = :now',
          ConditionExpression: 'attribute_exists(apInboxState) AND (attribute_not_exists(apInboxState.runningAt) OR apInboxState.runningAt < :stale)',
          ExpressionAttributeValues: { ':now': now.toISOString(), ':stale': staleBefore.toISOString() },
        }))
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },
    async releaseRun() {
      try {
        await db.send(new UpdateCommand({
          TableName: SETTINGS(),
          Key: { id: SETTINGS_ID },
          UpdateExpression: 'REMOVE apInboxState.runningAt',
          ConditionExpression: 'attribute_exists(apInboxState)',
        }))
      } catch (err) {
        if (!isConditionalFailure(err)) throw err
      }
    },

    // ── items ──
    async putItemIfAbsent(item) {
      const now = nowIso()
      try {
        await db.send(new PutCommand({
          TableName: t('AP_INBOX_ITEM_TABLE_NAME'),
          Item: { ...compact(item as unknown as Row), createdAt: now, updatedAt: now, __typename: 'ApInboxItem' },
          ConditionExpression: 'attribute_not_exists(id)',
        }))
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },
    async getItem(id) {
      const row = await get(t('AP_INBOX_ITEM_TABLE_NAME'), id)
      return row ? itemFrom(row) : null
    },
    async updateItem(id, patch, o) {
      const names: Record<string, string> = { '#version': 'version', '#updatedAt': 'updatedAt' }
      const values: Row = { ':ev': o.expectedVersion, ':nv': o.expectedVersion + 1, ':now': nowIso() }
      const { sets, removes } = setExpr(patch as Row, new Set(), names, values, 'p')
      let cond = 'attribute_exists(id) AND #version = :ev'
      if (o.statusIn?.length) {
        names['#status'] = 'status'
        cond += ` AND #status IN (${o.statusIn.map((s, i) => { values[`:st${i}`] = s; return `:st${i}` }).join(', ')})`
      }
      try {
        const out = await db.send(new UpdateCommand({
          TableName: t('AP_INBOX_ITEM_TABLE_NAME'),
          Key: { id },
          UpdateExpression: `SET #version = :nv, #updatedAt = :now${sets.length ? `, ${sets.join(', ')}` : ''}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
          ConditionExpression: cond,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }))
        return itemFrom(out.Attributes as Row)
      } catch (err) {
        if (isConditionalFailure(err)) return null
        throw err
      }
    },
    async listByStatus(status, o) {
      const out: Row[] = []
      let key: Record<string, unknown> | undefined
      do {
        const page = await db.send(new QueryCommand({
          TableName: t('AP_INBOX_ITEM_TABLE_NAME'),
          IndexName: IDX_ITEMS_BY_STATUS,
          KeyConditionExpression: o?.sinceIso ? '#s = :s AND receivedAt >= :since' : '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status, ...(o?.sinceIso ? { ':since': o.sinceIso } : {}) },
          ScanIndexForward: false,
          ExclusiveStartKey: key,
        }))
        out.push(...((page.Items ?? []) as Row[]))
        key = page.LastEvaluatedKey
      } while (key && (o?.limit === undefined || out.length < o.limit))
      return (o?.limit === undefined ? out : out.slice(0, o.limit)).map(itemFrom)
    },

    // ── the AP world ──
    async loadLedger(): Promise<Ledger> {
      const [bills, assignments, vendors] = await Promise.all([
        queryAll(t('CARRIER_BILL_TABLE_NAME'), IDX_BILLS_BY_AP_OPEN, 'apOpen', 'OPEN'),
        queryAll(t('LOAD_CARRIER_TABLE_NAME'), IDX_LC_BY_AP_OPEN, 'apOpen', 'OPEN'),
        scanAll(t('VENDOR_PAYABLE_TABLE_NAME'), { expr: '#s = :s', names: { '#s': 'status' }, values: { ':s': 'NEED_TO_PAY' } }),
      ])
      const awaiting = assignments.filter((a) => a.apStatus === 'AWAITING_INVOICE')
      if (bills.length + awaiting.length + vendors.length > LEDGER_MAX) {
        return buildLedger({ bills, assignments: awaiting, vendors, loads: {}, shipments: {}, carriers: {}, enrichmentSkipped: true })
      }
      const [loads, shipments, carriers] = await Promise.all([
        batchGet(t('LOAD_TABLE_NAME'), [...bills, ...awaiting].map((r) => String(r.loadId ?? ''))),
        batchGet(t('SHIPMENT_TABLE_NAME'), awaiting.map((r) => String(r.shipmentId ?? ''))),
        batchGet(t('CARRIER_TABLE_NAME'), [...bills, ...awaiting].map((r) => String(r.carrierId ?? ''))),
      ])
      return buildLedger({ bills, assignments: awaiting, vendors, loads, shipments, carriers })
    },
    async getBill(id): Promise<LedgerBill | null> {
      const found = await loadBillRow(id)
      return found ? toLedgerBill(found.row, found.load) : null
    },
    async getAssignment(loadCarrierId): Promise<LedgerAssignment | null> {
      const row = await get(t('LOAD_CARRIER_TABLE_NAME'), loadCarrierId)
      if (!row) return null
      const [load, shipment] = await Promise.all([
        get(t('LOAD_TABLE_NAME'), String(row.loadId ?? '')),
        get(t('SHIPMENT_TABLE_NAME'), String(row.shipmentId ?? '')),
      ])
      return toLedgerAssignment(row, load, shipment)
    },
    async getVendorPayable(id): Promise<LedgerVendorPayable | null> {
      const row = await get(t('VENDOR_PAYABLE_TABLE_NAME'), id)
      return row ? toLedgerVendor(row) : null
    },
    async getCarrier(id): Promise<LedgerCarrier | null> {
      const row = await get(t('CARRIER_TABLE_NAME'), id)
      return row ? toLedgerCarrier(row) : null
    },
    async updateCarrierBill(id, set, o) {
      const ok = await patchBill(
        id,
        set,
        { apInboxItemId: o.audit.itemId, apInboxSourceUrl: o.audit.sourceUrl, apInboxAppliedAt: o.audit.at },
        [],
        {
          expr: '#version = :ev AND #status = :es AND paidCents = :zero AND creditedCents = :zero',
          values: { ':ev': o.expectedVersion, ':es': o.expectedStatus, ':zero': 0 },
        },
      )
      return ok ? { version: o.expectedVersion + 1 } : null
    },
    async revertCarrierBill(id, set, o) {
      const ok = await patchBill(id, set, {}, ['apInboxItemId', 'apInboxSourceUrl', 'apInboxAppliedAt'], {
        expr: '#version = :ev',
        values: { ':ev': o.expectedVersion },
      })
      return ok ? { version: o.expectedVersion + 1 } : null
    },
    async updateVendorPayable(id, set, audit) {
      const names: Record<string, string> = { '#status': 'status' }
      const values: Row = { ':need': 'NEED_TO_PAY' }
      const { sets } = setExpr(
        { ...pickAllowed(set, VENDOR_WRITABLE_COLUMNS), apInboxItemId: audit.itemId, apInboxSourceUrl: audit.sourceUrl, apInboxAppliedAt: audit.at },
        new Set(),
        names,
        values,
        'v',
      )
      try {
        await db.send(new UpdateCommand({
          TableName: t('VENDOR_PAYABLE_TABLE_NAME'),
          Key: { id },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(id) AND #status = :need',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }))
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },
    async createVendorPayable(input, audit) {
      const now = nowIso()
      try {
        await db.send(new PutCommand({
          TableName: t('VENDOR_PAYABLE_TABLE_NAME'),
          Item: compact({
            id: input.id,
            status: 'NEED_TO_PAY',
            source: 'EMAIL',
            sourceMessageId: input.sourceMessageId,
            subject: input.subject,
            vendor: input.vendor,
            invoiceNumber: input.invoiceNumber,
            invoiceDate: input.invoiceDate,
            dueDate: input.dueDate,
            amount: input.amount,
            description: input.description,
            fromEmail: input.fromEmail,
            attachments: input.attachments,
            receivedAt: input.receivedAt,
            apInboxItemId: audit.itemId,
            apInboxSourceUrl: audit.sourceUrl,
            apInboxAppliedAt: audit.at,
            createdAt: now,
            updatedAt: now,
            __typename: 'VendorPayable',
          }),
          ConditionExpression: 'attribute_not_exists(id)',
        }))
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },
    async appendVendorAttachments(id, files) {
      const table = t('VENDOR_PAYABLE_TABLE_NAME')
      const row = await get(table, id)
      if (!row) return
      const have = jsonOf<{ key: string }[]>(row.attachments) ?? []
      const keys = new Set(have.map((f) => f.key))
      const next = [...have, ...files.filter((f) => !keys.has(f.key))]
      if (next.length === have.length) return
      await db.send(new UpdateCommand({
        TableName: table,
        Key: { id },
        UpdateExpression: 'SET attachments = :a',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':a': next },
      }))
    },
    async putShipmentDocument(doc) {
      const id = randomUUID()
      const now = nowIso()
      await db.send(new PutCommand({
        TableName: t('SHIPMENT_DOCUMENT_TABLE_NAME'),
        Item: {
          id,
          shipmentId: doc.shipmentId,
          type: doc.type,
          name: doc.name,
          s3Key: doc.s3Key,
          contentType: doc.contentType,
          sizeBytes: doc.size,
          source: 'UPLOAD',
          sourceRef: doc.sourceRef,
          audience: 'INTERNAL',
          status: 'ACTIVE',
          reviewStatus: 'PENDING',
          version: 1,
          uploadedBy: AP_INBOX_ACTOR,
          uploadedAt: now,
          createdBy: AP_INBOX_ACTOR,
          createdAt: now,
          updatedAt: now,
          __typename: 'ShipmentDocument',
        },
      }))
      return { id }
    },
    async writeAudit(entry) {
      const table = t('AUDIT_LOG_TABLE_NAME')
      if (!table) return
      const now = nowIso()
      try {
        await db.send(new PutCommand({
          TableName: table,
          Item: {
            id: randomUUID(),
            entityType: entry.entityType,
            entityId: entry.entityId,
            action: entry.action,
            user: entry.actor,
            changes: JSON.stringify(entry.changes),
            createdAt: now,
            updatedAt: now,
            __typename: 'AuditLog',
          },
        }))
      } catch (err) {
        console.warn('[tms-ap-inbox] audit write failed:', String(err).slice(0, 200))
      }
    },

    // ── settings the pipeline reads ──
    async getAiAgents() {
      const row = await get(SETTINGS(), SETTINGS_ID)
      return jsonOf(row?.aiAgents)
    },
    async getBlacklist() {
      const settings: unknown[] = []
      for (const provider of ['GMAIL', 'OUTLOOK']) {
        const row = await get(t('INTEGRATION_TABLE_NAME'), provider)
        if (row) settings.push(jsonOf<unknown>(row.settings))
      }
      return blacklistFromSettings(settings)
    },
  }
}
