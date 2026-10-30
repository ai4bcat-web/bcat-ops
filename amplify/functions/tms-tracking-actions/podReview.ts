/**
 * POD request and review (Step P9).
 *
 * Delivery triggers a request in the thread and by SMS. A reviewed POD is accepted,
 * rejected with a reason, or rejected twice and flagged for a human. Ready-to-invoice
 * is always delegated to the injected release gate, never bypassed here.
 */
import { assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { IDX_DOCUMENTS_BY_SHIPMENT, type Row, updateItemTx } from '../_shared/shipmentStore'
import { sendShipmentMessage, type ThreadDeps } from './thread'

export interface PodReviewDeps extends ThreadDeps {
  /** Run the app-side POD legibility / page-count / signature reviewer. */
  checkPod(input: { s3Key: string; contentType: string; stops: Row[] }): Promise<PodCheckResult>
  /** Delegate the release-to-accounting gate to the step-F owner. */
  readyForBilling(shipmentId: string, caller: Caller): Promise<Row>
}

export interface PodCheckResult {
  pages: { verdict: 'PASS' | 'FAIL' | 'UNCLEAR'; markers: string; statedTotal: number | null; received: number; notes: string }
  legibility: { verdict: 'PASS' | 'FAIL' | 'UNCLEAR'; notes: string }
  signed: 'PASS' | 'FAIL' | 'UNCLEAR'
  summary: string
}

function parseStops(load: Row | null): Row[] {
  if (!load) return []
  const raw = load.stops ?? '[]'
  try {
    return Array.isArray(raw) ? (raw as Row[]) : (JSON.parse(String(raw)) as Row[])
  } catch {
    return []
  }
}

export async function requestPod(deps: PodReviewDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (shipment.status !== 'DELIVERED') {
    throw new Error('POD cannot be requested until the shipment is delivered')
  }

  const reason = optionalString(input.reason, 500)
  const loads = await deps.queryIndex(deps.tables.load, 'loadsByShipmentId', 'shipmentId', shipmentId)
  const carriers = await deps.queryIndex(
    deps.tables.loadCarrier,
    'loadCarriersByShipmentId',
    'shipmentId',
    shipmentId,
  )

  const messages: Row[] = []
  const shipmentNumber = String(shipment.number ?? shipmentId)
  const now = deps.now()

  for (const load of loads) {
    const carrier = loadCarrierForLoadSync(load, carriers)
    if (!carrier || carrier.kind !== 'CARRIER' || carrier.status !== 'ACTIVE') continue

    const loadNumber = String(load.loadNumber ?? load.id)
    const bodyBase = `Please upload the signed POD for load ${shipmentNumber}${loadNumber ? ` (${loadNumber})` : ''}. Reply with photos or use your upload link.`
    const body = reason ? `Last POD was rejected: ${reason}. ${bodyBase}` : bodyBase

    if (carrier.dispatcherEmail) {
      messages.push(
        await sendShipmentMessage(
          deps,
          {
            shipmentId,
            loadId: load.id,
            loadCarrierId: carrier.id,
            channel: 'EMAIL',
            kind: 'POD_REQUEST',
            party: 'DISPATCHER',
            to: carrier.dispatcherEmail,
            subject: `Load ${shipmentNumber} — POD needed`,
            body,
          },
          caller,
        ),
      )
    }
    if (carrier.driverPhone) {
      messages.push(
        await sendShipmentMessage(
          deps,
          {
            shipmentId,
            loadId: load.id,
            loadCarrierId: carrier.id,
            channel: 'SMS',
            kind: 'POD_REQUEST',
            party: 'DRIVER',
            to: carrier.driverPhone,
            body,
            label: carrier,
          },
          caller,
        ),
      )
    }

    await deps.transact([
      updateItemTx(
        deps.tables.loadCarrier,
        String(carrier.id),
        {
          podRequestedAt: now,
          updatedAt: now,
          updatedBy: caller.email,
        },
        String(carrier.updatedAt ?? ''),
      ),
    ])
  }

  return { shipmentId, requestedAt: now, messages }
}

function loadCarrierForLoadSync(load: Row, carriers: Row[]): Row | null {
  const activeId = optionalString(load.activeLoadCarrierId, 100)
  if (activeId) {
    const found = carriers.find((c) => c.id === activeId)
    if (found) return found
  }
  return carriers.find((c) => c.loadId === load.id && c.status === 'ACTIVE') ?? null
}

function passFromResult(result: PodCheckResult, document: Row): { pass: boolean; reason: string } {
  if (result.legibility.verdict === 'FAIL' || result.legibility.verdict === 'UNCLEAR') {
    return { pass: false, reason: result.legibility.notes || 'POD is not legible' }
  }
  if (result.signed === 'FAIL' || result.signed === 'UNCLEAR') {
    return { pass: false, reason: 'Signature or date is missing' }
  }
  const stated = result.pages.statedTotal
  if (typeof stated === 'number' && stated > 0) {
    const received = typeof result.pages.received === 'number' ? result.pages.received : Number(document.pages ?? 0)
    if (received < stated) {
      return { pass: false, reason: `Missing pages: received ${received}, expected ${stated}` }
    }
  }
  if (result.pages.verdict === 'FAIL' || result.pages.verdict === 'UNCLEAR') {
    return { pass: false, reason: result.pages.notes || 'Page count could not be verified' }
  }
  return { pass: true, reason: '' }
}

async function previousRejects(deps: PodReviewDeps, shipmentId: string, excludeId: string): Promise<Row[]> {
  const docs = await deps.queryIndex(
    deps.tables.document,
    IDX_DOCUMENTS_BY_SHIPMENT,
    'shipmentId',
    shipmentId,
  )
  return docs.filter(
    (d) =>
      d.id !== excludeId &&
      d.type === 'POD' &&
      (d.status === 'ACTIVE' || d.status === 'PENDING') &&
      d.reviewStatus === 'REJECTED',
  )
}

export async function reviewShipmentPod(deps: PodReviewDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const documentId = assertString(input.documentId, 'documentId')

  const doc = await deps.getById(deps.tables.document, documentId)
  if (!doc) throw new Error(`Document not found: ${documentId}`)
  if (doc.type !== 'POD') throw new Error('Only POD documents can be reviewed here')
  if (doc.status !== 'ACTIVE' && doc.status !== 'PENDING') {
    throw new Error('Document is not active and cannot be reviewed')
  }

  const load = doc.loadId ? await deps.getById(deps.tables.load, String(doc.loadId)) : null
  const result = await deps.checkPod({
    s3Key: String(doc.s3Key ?? ''),
    contentType: String(doc.contentType ?? 'application/pdf'),
    stops: parseStops(load),
  })

  const { pass, reason } = passFromResult(result, doc)
  const now = deps.now()

  if (pass) {
    await deps.transact([
      updateItemTx(
        deps.tables.document,
        documentId,
        {
          reviewStatus: 'ACCEPTED',
          reviewNote: null,
          reviewedAt: now,
          reviewedBy: caller.email,
          updatedAt: now,
          updatedBy: caller.email,
        },
        String(doc.updatedAt ?? ''),
        { remove: ['reviewNote'] },
      ),
    ])
    const billing = await deps.readyForBilling(shipmentId, caller)
    return { documentId, status: 'ACCEPTED', readyForBillingCalled: true, billing }
  }

  // Reject and possibly re-request.
  await deps.transact([
    updateItemTx(
      deps.tables.document,
      documentId,
      {
        reviewStatus: 'REJECTED',
        reviewNote: reason,
        reviewedAt: now,
        reviewedBy: caller.email,
        updatedAt: now,
        updatedBy: caller.email,
      },
      String(doc.updatedAt ?? ''),
    ),
  ])

  const rejects = await previousRejects(deps, shipmentId, documentId)
  if (rejects.length >= 1) {
    await deps.transact([
      updateItemTx(
        deps.tables.shipment,
        shipmentId,
        {
          podFlaggedAt: now,
          podFlagReason: reason,
          updatedAt: now,
          updatedBy: caller.email,
        },
        String((await deps.getById(deps.tables.shipment, shipmentId))?.updatedAt ?? ''),
      ),
    ])
    return { documentId, status: 'REJECTED', reason, reRequested: false, flagged: true }
  }

  const request = await requestPod(deps, { shipmentId, reason }, caller)
  return { documentId, status: 'REJECTED', reason, reRequested: true, flagged: false, request }
}
