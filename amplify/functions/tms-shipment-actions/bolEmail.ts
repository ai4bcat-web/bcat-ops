/**
 * EMAIL_BOL — the pure half. Input validation, the refusals about which stored
 * document may leave the building, and the subject/body text. The handler owns the
 * I/O (S3 read, SES, the ShipmentMessage row, the audit row).
 *
 * A BOL e-mail goes only to the addresses the rep picked (each one validated, so a
 * CR/LF can never reach a header), copied to the tracking mailbox and the sender by
 * `composeRateConCc`, and never carries money: a rated copy is stored for the
 * customer only and is refused here.
 */
import { isEmailAddress } from '../../../src/lib/emailAddress'
import { MAX_GENERATED_BYTES } from '../../../src/lib/shipmentDocuments'
import { assertArrayOf, assertEnum, assertString, optionalString } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'

export const EMAIL_BOL_PARTIES = ['CARRIER', 'DISPATCHER', 'DRIVER', 'CUSTOMER'] as const
export type EmailBolParty = (typeof EMAIL_BOL_PARTIES)[number]

/** Recipients per field; the same ceiling the rate confirmation uses. */
export const MAX_BOL_RECIPIENTS = 20
const MAX_BOL_MESSAGE = 2000

export interface EmailBolInput {
  shipmentId: string
  documentId: string
  to: string[]
  cc: string[]
  message: string | null
  party: EmailBolParty
}

function assertAddress(value: unknown, label: string): string {
  const v = assertString(value, label)
  if (!isEmailAddress(v)) throw new Error(`${label} must be an email address`)
  return v
}

export function parseEmailBolInput(input: Row): EmailBolInput {
  const to = assertArrayOf(input.to, 'to', (v, i) => assertAddress(v, `to[${i}]`), MAX_BOL_RECIPIENTS)
  if (to.length === 0) throw new Error('A bill of lading e-mail needs at least one recipient')
  const cc = input.cc == null
    ? []
    : assertArrayOf(input.cc, 'cc', (v, i) => assertAddress(v, `cc[${i}]`), MAX_BOL_RECIPIENTS)
  const message = optionalString(input.message, MAX_BOL_MESSAGE)
  return {
    shipmentId: assertString(input.shipmentId, 'shipmentId'),
    documentId: assertString(input.documentId, 'documentId'),
    to,
    cc,
    message,
    party: assertEnum(input.party, EMAIL_BOL_PARTIES, 'party'),
  }
}

/** Which stored rows may be mailed: this shipment's own ACTIVE, plain (audience ALL) BOL. */
export function assertBolEmailable(doc: Row | null, shipmentId: string): Row {
  if (!doc || doc.shipmentId !== shipmentId) throw new Error('That bill of lading is not on this shipment')
  if (doc.type !== 'BOL') throw new Error('Only a bill of lading can be e-mailed from here')
  if (doc.status !== 'ACTIVE') throw new Error('Only the current version of a bill of lading can be e-mailed')
  if (doc.audience === 'CUSTOMER') {
    throw new Error('A BOL with rates is a customer copy: send it from Documents → E-mail')
  }
  if (doc.audience !== 'ALL') throw new Error('That bill of lading is not marked for sharing')
  if (typeof doc.sizeBytes === 'number' && doc.sizeBytes > MAX_GENERATED_BYTES) {
    throw new Error('That bill of lading is too large to send')
  }
  return doc
}

/** "Delivery 2" for a per-stop BOL on a load with several deliveries; null otherwise. */
export function deliveryLabel(stops: readonly { id?: unknown; type?: unknown }[], stopId: unknown): string | null {
  if (typeof stopId !== 'string' || !stopId) return null
  const deliveries = stops.filter((s) => s.type === 'delivery')
  const index = deliveries.findIndex((s) => s.id === stopId)
  return index < 0 ? null : `Delivery ${index + 1}`
}

/** Header-safe single line. */
export function bolEmailSubject(pro: string, delivery: string | null, ref: string): string {
  const clean = pro.replace(/[\r\n]+/g, ' ').trim()
  return `Bill of lading ${clean}${delivery ? ` — ${delivery}` : ''} ${ref}`
}

export function bolEmailBody(message: string | null, firstName: string): string {
  const note = message ? `${message.replace(/\r?\n/g, '\r\n')}\r\n\r\n` : ''
  return `${note}BOL attached.\r\n\r\n— ${firstName}, BCAT Tracking`
}
