/**
 * Step U — Intake actions. An `IntakeLoad` is a tender e-mail's partially built load;
 * these three actions are the only writers of it after `workflow-agent` stages it:
 *
 *  - `INTAKE_SAVE_DRAFT`     — a reviewer's edits and confirmations (OPEN rows only).
 *  - `INTAKE_DISMISS`        — "this is not a load", with a reason.
 *  - `INTAKE_MOVE_TO_ACTIVE` — validate, create the shipment through the router's own
 *    `createShipment`, finish it, mark the row MOVED.
 *
 * Move is built to be resumable. The shipment (and its permanent PRO) is created once:
 * its id is written onto the row (still PROMOTING) the moment `createShipment` returns,
 * and a retry that finds a `shipmentId` skips straight to finishing that shipment. A
 * failure before that point puts the row back to OPEN; a failed validation writes nothing.
 *
 * The router owns authorization, clients and the shipment bodies; this module is handed
 * them through `IntakeDeps` and re-implements none of them.
 */
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb'

import {
  IDX_LOADS_BY_SHIPMENT,
  IDX_ORDERS_BY_SHIPMENT,
  buildSearchKey,
  isConflict,
  numberOrNull,
  updateItemTx,
  type Row,
} from '../_shared/shipmentStore'
import { assertRecord, assertString, optionalInteger, optionalString, type Caller } from '../_shared/actionInputs'

import {
  INTAKE_NOT_READY_PREFIX,
  canMarkReviewed,
  canMoveToActive,
  correctedKeys,
  intakeMissing,
  intakeRequired,
  patchIntakeFields,
  toCreateShipmentInput,
} from '../../../src/lib/intakeLoad'
import { requiresApptProofs } from '../../../src/lib/apptQueue'
import type { IntakeFields, IntakeLoadRecord, IntakeMeta } from '../../../src/types/intake'

export const INTAKE_ACTIONS = ['INTAKE_SAVE_DRAFT', 'INTAKE_MARK_REVIEWED', 'INTAKE_MOVE_TO_ACTIVE', 'INTAKE_DISMISS', 'INTAKE_LINK_SHIPMENT', 'INTAKE_ATTACH_FILES'] as const
export type IntakeAction = (typeof INTAKE_ACTIONS)[number]

/** A PROMOTING row with no shipment older than this was abandoned (Lambda timeout is shorter). */
export const PROMOTING_STALE_MS = 2 * 60 * 1000

export const INTAKE_CONFLICT_MESSAGE = 'This intake load changed while you were editing — reload it'

export interface IntakeDeps {
  tables: { intakeLoad: string; shipment: string; order: string; load: string }
  getById(table: string, id: string): Promise<Row | null>
  queryIndex(table: string, indexName: string, keyName: string, keyValue: string): Promise<Row[]>
  transact(items: TransactWriteItem[], label: string): Promise<void>
  getSettings(): Promise<Row | null>
  /** The raw customer row (any status) or null. */
  getCustomer(id: string): Promise<Row | null>
  /** True when `code` is an active top-level ownership division. */
  isDivisionActive(code: string): Promise<boolean>
  writeAudit(entityType: string, entityId: string, action: string, caller: Caller, changes: Row): Promise<void>
  /** Copy the intake e-mail's files onto the shipment as its customer rate confirmation documents. Never throws. */
  attachFiles?(shipmentId: string, intakeId: string, attachments: { key: string; name: string; contentType: string; size: number }[], caller: Caller): Promise<number>
  actions: {
    createShipment(input: Row, caller: Caller): Promise<Row>
    setRevTag(input: Row, caller: Caller): Promise<Row>
    setSalesRep(input: Row, caller: Caller): Promise<Row>
    /** Books a roster driver on a load as Ivan Cartage (ASSIGN_ASSET). Optional: only used when the draft names a driver. */
    assignAsset?(input: Row, caller: Caller): Promise<Row>
  }
  now(): string
}

// ── Row <-> record ───────────────────────────────────────────────────────────

function jsonOf<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return (parsed ?? fallback) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function intakeRecordOf(row: Row): IntakeLoadRecord {
  return {
    id: String(row.id),
    status: row.status as IntakeLoadRecord['status'],
    divisionCode: strOrNull(row.divisionCode),
    toAddress: strOrNull(row.toAddress),
    toAddresses: jsonOf<string[]>(row.toAddresses, []),
    runId: String(row.runId ?? ''),
    sourceKey: strOrNull(row.sourceKey),
    subject: String(row.subject ?? ''),
    fromEmail: String(row.fromEmail ?? ''),
    fromName: String(row.fromName ?? ''),
    receivedAt: String(row.receivedAt ?? ''),
    bodyText: String(row.bodyText ?? ''),
    attachments: jsonOf(row.attachments, []),
    parseState: row.parseState as IntakeLoadRecord['parseState'],
    parseNote: strOrNull(row.parseNote),
    format: strOrNull(row.format),
    fields: jsonOf(row.fields, {} as IntakeFields),
    autoFields: jsonOf(row.autoFields, {} as IntakeLoadRecord['autoFields']),
    meta: jsonOf(row.meta, {} as IntakeMeta),
    confirmed: jsonOf<string[]>(row.confirmed, []),
    missingFields: jsonOf<string[]>(row.missingFields, []),
    shipmentId: strOrNull(row.shipmentId),
    shipmentNumber: strOrNull(row.shipmentNumber),
    reviewedBy: strOrNull(row.reviewedBy),
    reviewedAt: strOrNull(row.reviewedAt),
    lastEditedBy: strOrNull(row.lastEditedBy),
    lastEditedAt: strOrNull(row.lastEditedAt),
    dismissedBy: strOrNull(row.dismissedBy),
    dismissedAt: strOrNull(row.dismissedAt),
    dismissReason: strOrNull(row.dismissReason),
    createdBy: String(row.createdBy ?? ''),
    updatedBy: String(row.updatedBy ?? ''),
    version: numberOrNull(row.version) ?? 1,
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
  }
}

async function loadRow(deps: IntakeDeps, intakeId: string): Promise<Row> {
  const row = await deps.getById(deps.tables.intakeLoad, intakeId)
  if (!row) throw new Error(`Intake load not found: ${intakeId}`)
  return row
}

function assertExpectedVersion(row: Row, input: Row): number {
  const expected = optionalInteger(input.expectedVersion, { min: 0, label: 'expectedVersion' })
  if (expected == null) throw new Error('expectedVersion is required')
  if ((numberOrNull(row.version) ?? 1) !== expected) throw new Error(INTAKE_CONFLICT_MESSAGE)
  return expected
}

/** One transaction against the intake table; any CAS loss reads as the reviewer's conflict. */
async function writeIntake(
  deps: IntakeDeps,
  row: Row,
  patch: Row,
  extra: TransactWriteItem[] = [],
  cas: boolean = true,
): Promise<Row> {
  const now = deps.now()
  const next: Row = {
    ...patch,
    updatedAt: now,
    version: (numberOrNull(row.version) ?? 1) + 1,
  }
  try {
    await deps.transact(
      [
        updateItemTx(deps.tables.intakeLoad, String(row.id), next, cas ? String(row.updatedAt ?? '') : null),
        ...extra,
      ],
      'intake load',
    )
  } catch (err) {
    if (isConflict(err)) throw Object.assign(new Error(INTAKE_CONFLICT_MESSAGE), { cause: err })
    throw err
  }
  return { ...row, ...next }
}

async function validationContext(deps: IntakeDeps, fields: IntakeFields) {
  const [settings, customer, divisionActive] = await Promise.all([
    deps.getSettings(),
    fields.customerId ? deps.getCustomer(fields.customerId) : Promise.resolve(null),
    fields.divisionCode ? deps.isDivisionActive(fields.divisionCode) : Promise.resolve(false),
  ])
  const customerActive =
    customer != null &&
    !customer.mergedIntoId &&
    (customer.status == null ? customer.active !== false : customer.status === 'ACTIVE')
  return { settings, customer, customerActive, divisionActive }
}

// ── INTAKE_SAVE_DRAFT ────────────────────────────────────────────────────────

export async function intakeSaveDraft(deps: IntakeDeps, input: Row, caller: Caller): Promise<Row> {
  const intakeId = assertString(input.intakeId, 'intakeId')
  const row = await loadRow(deps, intakeId)
  assertExpectedVersion(row, input)
  if (row.status !== 'OPEN') throw new Error('Only an open intake load can be edited')

  const patch = assertRecord(input.fields ?? {}, 'fields') as Partial<IntakeFields>
  const confirmIn = assertRecord(input.confirm ?? {}, 'confirm')
  const keys = (v: unknown, label: string): string[] => {
    if (v == null) return []
    if (!Array.isArray(v) || v.some((k) => typeof k !== 'string')) throw new Error(`${label} must be a list of field keys`)
    return v as string[]
  }
  const record = intakeRecordOf(row)
  const patched = patchIntakeFields(record, patch, {
    add: keys(confirmIn.add, 'confirm.add'),
    remove: keys(confirmIn.remove, 'confirm.remove'),
  })

  // A reviewer may re-route to another active division or to Unrouted (null), never to a dead one.
  const nextDivision = patched.fields.divisionCode ?? null
  if (nextDivision && nextDivision !== record.fields.divisionCode && !(await deps.isDivisionActive(nextDivision))) {
    throw new Error(`Unknown or archived division: ${nextDivision}`)
  }

  const [settings, customer] = await Promise.all([
    deps.getSettings(),
    patched.fields.customerId ? deps.getCustomer(patched.fields.customerId) : Promise.resolve(null),
  ])
  const missingFields = intakeMissing(patched.fields, intakeRequired(settings, customer).gated, customer as { billToParties?: unknown } | null)
  const changed =
    JSON.stringify(patched.fields) !== JSON.stringify(record.fields) ||
    JSON.stringify([...patched.confirmed].sort()) !== JSON.stringify([...record.confirmed].sort())
  const now = deps.now()
  const saved = await writeIntake(deps, row, {
    fields: JSON.stringify(patched.fields),
    meta: JSON.stringify(patched.meta),
    confirmed: patched.confirmed,
    missingFields,
    divisionCode: nextDivision,
    lastEditedBy: caller.email,
    lastEditedAt: now,
    updatedBy: caller.email,
    // An edit invalidates the review, otherwise a reviewer could be bypassed by editing afterwards.
    ...(changed ? { reviewedBy: null, reviewedAt: null } : {}),
  })
  await deps.writeAudit('INTAKE_LOAD', intakeId, 'INTAKE_SAVE_DRAFT', caller, {
    edited: correctedKeys(record.fields, patched.fields),
    missingFields,
    ...(changed && row.reviewedAt ? { reviewCleared: true } : {}),
  })
  return intakeRecordOf(saved) as unknown as Row
}

// ── INTAKE_DISMISS ───────────────────────────────────────────────────────────

export async function intakeDismiss(deps: IntakeDeps, input: Row, caller: Caller): Promise<Row> {
  const intakeId = assertString(input.intakeId, 'intakeId')
  const reason = assertString(input.reason, 'reason')
  if (reason.length > 500) throw new Error('reason must be 500 characters or fewer')
  const row = await loadRow(deps, intakeId)
  assertExpectedVersion(row, input)
  if (row.status !== 'OPEN') throw new Error('Only an open intake load can be dismissed')
  const now = deps.now()
  const saved = await writeIntake(deps, row, {
    status: 'DISMISSED',
    dismissedBy: caller.email,
    dismissedAt: now,
    dismissReason: reason,
    updatedBy: caller.email,
  })
  await deps.writeAudit('INTAKE_LOAD', intakeId, 'INTAKE_DISMISS', caller, { reason, runId: row.runId ?? null })
  return intakeRecordOf(saved) as unknown as Row
}

/** The e-mail's stored attachments (the rate confirmation PDF), in the shape the shipment's Documents take. */
export function attachmentFilesOf(row: Row): { key: string; name: string; contentType: string; size: number }[] {
  return jsonOf<{ key?: string; name?: string; contentType?: string; size?: number }[]>(row.attachments, [])
    .filter((f): f is { key: string; name: string; contentType: string; size: number } => typeof f?.key === 'string' && typeof f?.name === 'string' && typeof f?.contentType === 'string')
}

/**
 * File the intake e-mail's attachments on a shipment that is tied to that row (built from it by any route, or built before the PDF
 * reached the row). Idempotent: each file has a fixed document id, so a second call replaces rather than duplicates.
 */
export async function intakeAttachFiles(deps: IntakeDeps, input: Row, caller: Caller): Promise<Row> {
  const intakeId = assertString(input.intakeId, 'intakeId')
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const row = await loadRow(deps, intakeId)
  if (row.shipmentId !== shipmentId) throw new Error('This intake load is not the one this shipment was built from')
  const files = attachmentFilesOf(row)
  const attached = deps.attachFiles && files.length ? await deps.attachFiles(shipmentId, intakeId, files, caller) : 0
  if (attached) await deps.writeAudit('SHIPMENT', shipmentId, 'INTAKE_ATTACH_FILES', caller, { intakeId, documentsAttached: attached })
  return { attached, available: files.length } as unknown as Row
}

// ── INTAKE_LINK_SHIPMENT ─────────────────────────────────────────────────────

/**
 * The Aljex create form built the shipment from an intake load's pre-fill: tie the two together
 * and mark the row MOVED (the same end state as INTAKE_MOVE_TO_ACTIVE). Idempotent for the same
 * shipment; refuses a row already moved to a different one. No version token: the form never
 * edits the row, and the shipment exists either way.
 */
export async function intakeLinkShipment(deps: IntakeDeps, input: Row, caller: Caller): Promise<Row> {
  const intakeId = assertString(input.intakeId, 'intakeId')
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const row = await loadRow(deps, intakeId)
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (row.shipmentId && row.shipmentId !== shipmentId) throw new Error('This intake load already became another shipment')
  if (row.status === 'MOVED' && row.shipmentId === shipmentId) return intakeRecordOf(row) as unknown as Row
  if (row.status !== 'OPEN' && row.status !== 'PROMOTING') throw new Error('Only an open intake load can be linked to a shipment')
  const shipmentNumber = String(shipment.number ?? '')
  const saved = await writeIntake(deps, row, { shipmentId, shipmentNumber, status: 'MOVED', updatedBy: caller.email }, [], false)
  // The e-mail the load came in on (rate con / tender) lands in the shipment's Documents, so nobody re-uploads it by hand.
  const files = attachmentFilesOf(row)
  const attached = deps.attachFiles && files.length ? await deps.attachFiles(shipmentId, intakeId, files, caller) : 0
  const changes: Row = { linkedBy: caller.email, runId: row.runId ?? null, via: 'CREATE_FORM', ...(attached ? { documentsAttached: attached } : {}) }
  await deps.writeAudit('INTAKE_LOAD', intakeId, 'INTAKE_LINK_SHIPMENT', caller, { ...changes, shipmentId })
  await deps.writeAudit('SHIPMENT', shipmentId, 'INTAKE_LINK_SHIPMENT', caller, { ...changes, intakeId })
  return intakeRecordOf(saved) as unknown as Row
}

// ── INTAKE_MARK_REVIEWED ─────────────────────────────────────────────────────

/** The explicit reviewer act the move gate checks. An incomplete load cannot be reviewed. */
export async function intakeMarkReviewed(deps: IntakeDeps, input: Row, caller: Caller): Promise<Row> {
  const intakeId = assertString(input.intakeId, 'intakeId')
  const row = await loadRow(deps, intakeId)
  assertExpectedVersion(row, input)
  if (row.status !== 'OPEN') throw new Error('Only an open intake load can be marked reviewed')
  if (row.reviewedAt && row.reviewedBy) return intakeRecordOf(row) as unknown as Row

  const record = intakeRecordOf(row)
  const ctx = await validationContext(deps, record.fields)
  const verdict = canMarkReviewed(record, ctx)
  if (!verdict.ok) {
    const parts = [
      ...verdict.missing,
      ...verdict.problems,
      ...verdict.unconfirmed.map((k) => `confirm ${k}`),
    ]
    throw new Error(`Cannot mark reviewed — still needs: ${parts.join(', ')}`)
  }
  const reviewedAt = deps.now()
  const saved = await writeIntake(deps, row, {
    reviewedBy: caller.email,
    reviewedAt,
    updatedBy: caller.email,
  })
  await deps.writeAudit('INTAKE_LOAD', intakeId, 'INTAKE_MARK_REVIEWED', caller, {
    reviewedBy: caller.email,
    reviewedAt,
  })
  return intakeRecordOf(saved) as unknown as Row
}

// ── INTAKE_MOVE_TO_ACTIVE ────────────────────────────────────────────────────

function referencesFrom(fields: IntakeFields, existing: Row[]): Row[] {
  const mine: Array<[string, string, string | null]> = [
    // The PO is the catalog's own code, upper-case: the release gate and the invoice readiness compare
    // reference codes exactly, so a lower-case 'po' reads as "Missing reference: Purchase order" forever.
    ['PO', 'PO #', fields.reference],
    ['pickup', 'Pickup #', fields.pickupNumber],
    ['delivery', 'Delivery #', fields.deliveryNumber],
  ]
  const codes = new Set(mine.map(([code]) => code.toLowerCase()))
  const kept = existing.filter((r) => !codes.has(String(r.code ?? '').toLowerCase()))
  const added = mine
    .filter(([, , value]) => value != null && value !== '')
    .map(([code, label, value]) => ({ code, label, value, level: 'ORDER', stopId: null, visibility: 'INTERNAL' }))
  return [...kept, ...added]
}

/** Step 6 — idempotent: running it twice against the same shipment converges. */
async function finishShipment(
  deps: IntakeDeps,
  row: Row,
  fields: IntakeFields,
  shipmentId: string,
  caller: Caller,
): Promise<{ driverError: string | null }> {
  const shipment0 = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment0) throw new Error(`Shipment not found: ${shipmentId}`)
  const orders = await deps.queryIndex(deps.tables.order, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const order = orders[0]
  if (!order) throw new Error(`Shipment ${shipmentId} has no order`)
  const references = referencesFrom(fields, Array.isArray(order.references) ? (order.references as Row[]) : [])
  const now = deps.now()
  await deps.transact(
    [
      updateItemTx(
        deps.tables.order,
        String(order.id),
        {
          references,
          ...(fields.billToId ? { billToId: fields.billToId } : {}),
          updatedBy: caller.email,
          updatedAt: now,
          version: (numberOrNull(order.version) ?? 1) + 1,
        },
        null,
      ),
    ],
    'intake order',
  )

  // The reviewer's explicit division beats the rules: a hand tag.
  if (fields.divisionCode && !(shipment0.revTagSource === 'HAND' && shipment0.revDivision === fields.divisionCode)) {
    await deps.actions.setRevTag({ shipmentId, divisionCode: fields.divisionCode }, caller)
  }
  if (fields.salesRepId && shipment0.salesRepId !== fields.salesRepId) {
    await deps.actions.setSalesRep({ shipmentId, repId: fields.salesRepId }, caller)
  }

  // Fresh read: the two actions above moved the shipment's updatedAt.
  const shipment = (await deps.getById(deps.tables.shipment, shipmentId)) ?? shipment0
  const loads = await deps.queryIndex(deps.tables.load, IDX_LOADS_BY_SHIPMENT, 'shipmentId', shipmentId)
  const freshOrder = (await deps.getById(deps.tables.order, String(order.id))) ?? { ...order, references }
  await deps.transact(
    [
      updateItemTx(
        deps.tables.shipment,
        shipmentId,
        {
          intakeLoadId: String(row.id),
          intakeReviewedBy: strOrNull(row.reviewedBy) ?? caller.email,
          intakeReviewedAt: strOrNull(row.reviewedAt) ?? deps.now(),
          searchKey: buildSearchKey(shipment, [freshOrder], loads),
          updatedBy: caller.email,
          updatedAt: deps.now(),
          version: (numberOrNull(shipment.version) ?? 1) + 1,
        },
        String(shipment.updatedAt ?? ''),
      ),
    ],
    'intake shipment',
  )

  // The reviewer picked an own-fleet driver: book them on the load now. A refusal (inactive driver, a leg already covered) never undoes
  // the move; it comes back as `driverError` for the page to show, and assigning again later is one click on the shipment.
  let driverError: string | null = null
  if (fields.driverId && deps.actions.assignAsset && loads[0]) {
    try {
      await deps.actions.assignAsset({ loadId: String(loads[0].id), driverId: fields.driverId }, caller)
    } catch (err) {
      driverError = err instanceof Error ? err.message : String(err)
      console.error('[tms-shipment-actions] intake driver not assigned', shipmentId, driverError)
    }
  }
  return { driverError }
}

export async function intakeMoveToActive(deps: IntakeDeps, input: Row, caller: Caller): Promise<Row> {
  const intakeId = assertString(input.intakeId, 'intakeId')
  let row = await loadRow(deps, intakeId)
  const resumeShipmentId = row.status === 'PROMOTING' ? optionalString(row.shipmentId, 120) : null

  let shipmentId: string
  let shipmentNumber: string
  if (resumeShipmentId) {
    // Resume at step 6: the shipment exists, nothing is validated or created again.
    shipmentId = resumeShipmentId
    shipmentNumber = optionalString(row.shipmentNumber, 120) ?? ''
  } else {
    if (row.status === 'PROMOTING') {
      // Another call may be mid-flight. Only an abandoned attempt can be retaken.
      const age = Date.parse(deps.now()) - Date.parse(String(row.updatedAt ?? ''))
      if (!(age > PROMOTING_STALE_MS)) throw new Error('This intake load is already being moved — try again in a moment')
    } else {
      assertExpectedVersion(row, input)
      if (row.status !== 'OPEN') throw new Error(`This intake load is ${String(row.status).toLowerCase()}, not open`)
    }

    const record = intakeRecordOf(row)
    const ctx = await validationContext(deps, record.fields)
    const verdict = canMoveToActive(record, ctx)
    if (!verdict.ok) {
      const parts = [
        ...verdict.missing,
        ...verdict.problems,
        ...verdict.unconfirmed.map((k) => `confirm ${k}`),
      ]
      throw new Error(`${INTAKE_NOT_READY_PREFIX} — still needs: ${parts.join(', ')}`)
    }

    // Step 3 — claim the row. Nothing has been created yet, so a loss here is a plain conflict.
    row = await writeIntake(deps, row, { status: 'PROMOTING', updatedBy: caller.email })

    try {
      const customerName = optionalString(ctx.customer?.name, 200) ?? record.fields.customerName
      const createInput = toCreateShipmentInput(record.fields, {
        requiresApptProofs: requiresApptProofs({
          customer: customerName,
          customerApptWorkflow: (ctx.customer?.apptWorkflow as 'NONE' | 'BATORY' | null | undefined) ?? null,
        }),
        runId: record.runId,
      })
      const bundle = await deps.actions.createShipment(createInput, caller)
      const shipment = assertRecord(bundle.shipment, 'created shipment')
      shipmentId = String(shipment.id)
      shipmentNumber = String(shipment.number ?? '')
    } catch (err) {
      // Before step 5 the shipment, if any, was voided by createShipment's own rollback.
      await writeIntake(deps, row, { status: 'OPEN', updatedBy: caller.email }).catch((restoreErr) =>
        console.error('[tms-shipment-actions] intake restore failed:', String(restoreErr)),
      )
      throw err
    }

    // Step 5 — record the shipment at once. Unconditional: this call holds the PROMOTING claim,
    // and losing this write would orphan a PRO a retry then duplicates.
    row = await writeIntake(deps, row, { shipmentId, shipmentNumber, updatedBy: caller.email }, [], false)
  }

  const record = intakeRecordOf(row)
  const { driverError } = await finishShipment(deps, row, record.fields, shipmentId, caller)
  // The e-mail's rate confirmation PDF goes onto the shipment with it (any intake that comes over from the load inboxes). A failure to
  // copy a file never undoes the move: the shipment's Documents offers "Add the e-mail's rate confirmation" to retry.
  const moveFiles = attachmentFilesOf(row)
  if (deps.attachFiles && moveFiles.length) {
    await deps.attachFiles(shipmentId, intakeId, moveFiles, caller).catch((err: unknown) => console.error('[tms-shipment-actions] intake files not attached on move:', String(err)))
  }

  // Step 7. reviewedBy/reviewedAt keep the reviewer's values; the mover goes in the audit payload.
  const moved = await writeIntake(deps, row, {
    status: 'MOVED',
    updatedBy: caller.email,
  })
  const changes: Row = {
    reviewedBy: record.reviewedBy,
    reviewedAt: record.reviewedAt,
    movedBy: caller.email,
    runId: record.runId,
    confirmed: record.confirmed,
    corrected: correctedKeys(record.autoFields, record.fields),
    divisionCode: record.fields.divisionCode,
  }
  await deps.writeAudit('SHIPMENT', shipmentId, 'INTAKE_MOVE_TO_ACTIVE', caller, changes)
  await deps.writeAudit('INTAKE_LOAD', intakeId, 'INTAKE_MOVE_TO_ACTIVE', caller, { ...changes, shipmentId })

  return { intake: intakeRecordOf(moved), shipmentId, shipmentNumber, ...(driverError ? { driverError } : {}) } as unknown as Row
}

export function runIntakeAction(deps: IntakeDeps, action: IntakeAction, input: Row, caller: Caller): Promise<Row> {
  switch (action) {
    case 'INTAKE_SAVE_DRAFT':
      return intakeSaveDraft(deps, input, caller)
    case 'INTAKE_MARK_REVIEWED':
      return intakeMarkReviewed(deps, input, caller)
    case 'INTAKE_MOVE_TO_ACTIVE':
      return intakeMoveToActive(deps, input, caller)
    case 'INTAKE_DISMISS':
      return intakeDismiss(deps, input, caller)
    case 'INTAKE_LINK_SHIPMENT':
      return intakeLinkShipment(deps, input, caller)
    case 'INTAKE_ATTACH_FILES':
      return intakeAttachFiles(deps, input, caller)
  }
}

// ── Queue hygiene ────────────────────────────────────────────────────────────

const refKey = (v: unknown): string => String(v ?? '').trim().toLowerCase()

/**
 * Ryne 2026-11-10: a shipment built from an intake row must always clear that row from the queue, even when the create form's own link
 * call never landed. Any OPEN row whose reference, pickup or delivery number is one of this shipment's order references is linked to it
 * (the same INTAKE_LINK_SHIPMENT path, so the files are filed and both audit rows are written). Returns how many rows it cleared. Never throws.
 */
export async function reconcileOpenIntake(deps: IntakeDeps, shipmentId: string, caller: Caller): Promise<number> {
  try {
    const orders = await deps.queryIndex(deps.tables.order, IDX_ORDERS_BY_SHIPMENT, 'shipmentId', shipmentId)
    const refs = new Set(orders.flatMap((o) => (Array.isArray(o.references) ? (o.references as Row[]) : []).map((r) => refKey(r.value))).filter(Boolean))
    if (refs.size === 0) return 0
    const open = await deps.queryIndex(deps.tables.intakeLoad, 'intakeLoadsByStatusAndReceivedAt', 'status', 'OPEN')
    let cleared = 0
    for (const row of open) {
      const f = jsonOf<Partial<IntakeFields>>(row.fields, {})
      const keys = [f.reference, f.pickupNumber, f.deliveryNumber].map(refKey).filter(Boolean)
      if (!keys.some((k) => refs.has(k))) continue
      try {
        await intakeLinkShipment(deps, { intakeId: String(row.id), shipmentId }, caller)
        cleared += 1
      } catch (err) {
        console.error('[intake] reconcile link failed', row.id, err instanceof Error ? err.message : String(err))
      }
    }
    return cleared
  } catch (err) {
    console.error('[intake] reconcile failed', shipmentId, err instanceof Error ? err.message : String(err))
    return 0
  }
}
