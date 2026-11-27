/**
 * Square's webhook signature, and the little of an event the receipt needs.
 *
 * Square signs each delivery with the SUBSCRIPTION's signature key: the `x-square-hmacsha256-signature` header is the base64
 * HMAC-SHA256 of (the exact notification URL registered in Square + the raw request body). There is no timestamp in it, so a
 * replay is refused by the event id receipt (and an event is only a hint to re-read Square, never an instruction).
 *
 * Imports are `node:crypto` only: the public tracking Lambda bundles this file by path.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SQUARE_SIGNATURE_HEADER = 'x-square-hmacsha256-signature'

export type SquareSignatureCheck = { ok: true } | { ok: false; reason: 'NO_KEY' | 'NO_URL' | 'MALFORMED' | 'BAD_SIGNATURE' }

export function verifySquareSignature(input: {
  header: string | null | undefined
  rawBody: string
  notificationUrl: string | null | undefined
  signatureKey: string | null | undefined
}): SquareSignatureCheck {
  const key = typeof input.signatureKey === 'string' ? input.signatureKey : ''
  if (!key) return { ok: false, reason: 'NO_KEY' }
  const url = typeof input.notificationUrl === 'string' ? input.notificationUrl.trim() : ''
  if (!url) return { ok: false, reason: 'NO_URL' }
  const header = typeof input.header === 'string' ? input.header.trim() : ''
  if (!header || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) return { ok: false, reason: 'MALFORMED' }
  const expected = createHmac('sha256', key).update(url + input.rawBody).digest()
  const given = Buffer.from(header, 'base64')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'BAD_SIGNATURE' }
  return { ok: true }
}

/** The signature Square would send, for tests and for a dry check of a configured key. */
export function signSquareBody(signatureKey: string, notificationUrl: string, rawBody: string): string {
  return createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest('base64')
}

export interface SquareEventInfo {
  eventId: string | null
  type: string | null
  invoiceId: string | null
  invoiceNumber: string | null
}

/** What a receipt records of a delivery: its id, its type and, for an invoice event, which invoice. Never a customer detail. */
export function squareEventInfo(rawBody: string): SquareEventInfo {
  try {
    const parsed = JSON.parse(rawBody) as { event_id?: unknown; type?: unknown; data?: { object?: { invoice?: { id?: unknown; invoice_number?: unknown } } } }
    const invoice = parsed.data?.object?.invoice
    return {
      eventId: typeof parsed.event_id === 'string' ? parsed.event_id : null,
      type: typeof parsed.type === 'string' ? parsed.type : null,
      invoiceId: typeof invoice?.id === 'string' ? invoice.id : null,
      invoiceNumber: typeof invoice?.invoice_number === 'string' ? invoice.invoice_number : null,
    }
  } catch {
    return { eventId: null, type: null, invoiceId: null, invoiceNumber: null }
  }
}
